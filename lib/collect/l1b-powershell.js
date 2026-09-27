/**
 * L1b —— 进程榜。常驻 PowerShell 循环，每轮输出一行 JSON。
 *
 * 实测（派单前预检复跑，见台账 Ruling-37；计划期修正 #3 的旧数字已过期）：
 *  - 首行 1792–2246ms（三次连跑），不是 1192ms；
 *  - `Start-Sleep 3` + 单轮干活 1.6–1.9s ⇒ **实际周期 4.6–4.9s**，所以心跳基准不能按 3s 算；
 *  - 391–392 进程 / 行 21017–21018 字节（不是 385 / 17.7KB）；
 *  - `taskkill /PID /T /F` 收得掉；stdout 在加 UTF-8 前置后是 UTF-8（不加是 GBK，实测 `b9a8bdf8`），stderr 恒是 GBK。
 * 默认**不开**、由页面可见性驱动（spec §1.2 的结论）。
 */
import os from 'node:os';

export const INTERVAL_SEC = 3;
export const MAX_ROWS = 400;

/**
 * 语句之间**必须用 `;` 分隔**。旧版用 `.join(' ')` 把语句拼成一行，真机读数：
 * `exit=1`、stdout 0 字节、stderr（GBK）"表达式或语句中包含意外的标记"$cores=[Environment]::ProcessorCount""
 * —— 整条采集链路一个字节都不出，而单元测试全绿（测试只正则匹配脚本字符串，不断言 PowerShell 语义）。
 */
export function buildLoopScript({ intervalSec = INTERVAL_SEC, maxRows = MAX_ROWS, withCpu = true } = {}) {
  // Perf 表提供每进程 CPU 占用（Win32_Process 没有这一列）；关掉时走 withCpu=false 的降级形态。
  // 注意 `IDProcess=0` 在 Win32_PerfFormattedData_PerfProc_Process 里有**两个**实例
  // （`_Total` 与 `Idle`），哈希表后写覆盖先写 ⇒ pid 0 那一行的 cpu 是聚合值（实测 1442–1560，
  // 均摊后 90–102%），**不可信**。采集层只如实带出、不过滤，怎么摆它是界面/告警侧（Task 9 / Task 21）的决定。
  const cpuMap = withCpu
    ? '$cpu=@{};Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|ForEach-Object{if($null -ne $_.IDProcess){$cpu[[uint32]$_.IDProcess]=$_.PercentProcessorTime}};'
    : '$cpu=@{};';
  return '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
    + 'while($true){'
    + cpuMap
    + `$rows=@(Get-CimInstance Win32_Process|Select-Object -First ${maxRows}|ForEach-Object{[pscustomobject]@{id=$_.ProcessId;n=$_.Name;ws=$_.WorkingSetSize;cpu=if($cpu.ContainsKey([uint32]$_.ProcessId)){$cpu[[uint32]$_.ProcessId]}else{$null}}});`
    // 先算 $rows 再单独组装输出：`$?` 是布尔不是那行 JSON，`$rows=@(...), @{...}|ConvertTo-Json` 是把两个对象塞数组过管道
    + '@{t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();rows=$rows}|ConvertTo-Json -Compress | Write-Output;'
    + `Start-Sleep -Seconds ${intervalSec}}`;
}

export function parseProcLine(text, { procCount = 1, maxRows = Infinity } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null; // PowerShell 的告警与进度文本走这里；调用方负责记一条时间线（spec §4.7）
  }
  if (!obj || !Array.isArray(obj.rows) || !Number.isFinite(Number(obj.t))) return null;
  const cores = Number.isFinite(procCount) && procCount > 0 ? procCount : 1;
  let truncated = 0;
  const rows = obj.rows.slice(0, maxRows).map((r) => {
    // 判缺列必须显式认 `null`：真机第一轮 391 行里就有 2 行是 `"cpu":null`（新进程还没进 Perf 表），
    // 而 `Number(null) === 0` —— 不认掉就会把"没测到"折成 0%，Task 9 的 evaluateProc 吃的正是这个键。
    const cell = r?.cpu;
    const raw = cell === null || cell === undefined || cell === '' ? NaN : Number(cell);
    return {
      pid: Number(r?.id) || 0,
      name: typeof r?.n === 'string' ? r.n : '',
      ws: Number(r?.ws) || 0,
      // PercentProcessorTime 是"所有核合计"口径（可 >100），按核数均摊成单核百分比；缺列为 null 而不是 0
      cpuPct: Number.isFinite(raw) ? raw / cores : null,
    };
  });
  if (obj.rows.length > maxRows) truncated = obj.rows.length - maxRows;
  return truncated ? { t: Number(obj.t), rows, truncated } : { t: Number(obj.t), rows };
}

/** powershell 的 stdout 解码入口。**不要复用 `decodePd`**（那个是给 typeperf 的 GBK 用的）。 */
export function decodeOut(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return b.toString('utf8');
}

export function createL1b({ sup, onRows, intervalSec = INTERVAL_SEC, maxRows = MAX_ROWS }) {
  let last = null;
  return {
    enable() {
      sup.start('l1b', {
        label: '进程榜（PowerShell 常驻）',
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', buildLoopScript({ intervalSec, maxRows, withCpu: true })],
        // 心跳基准按**实际周期**算，不是 sleep 秒数：实测 `Start-Sleep 3` + 单轮干活 1.6–1.9s ⇒ 4.6–4.9s 一行。
        // 监督者的判定是 `3 × intervalMs` 无数据 ⇒ stalled，取 5000 ⇒ 15s，余量 3 倍多。
        intervalMs: (intervalSec + 2) * 1000,
        onData: (raw) => {
          // Task 5 交付契约：`raw` 是 Buffer 完整行。直接把它交给 parseProcLine 会命中
          // `typeof text !== 'string'` ⇒ **每一行**都判成"非 JSON"，进程榜永远空且不报错。
          const line = decodeOut(raw);
          const parsed = parseProcLine(line, { procCount: os.cpus().length, maxRows });
          if (!parsed) { onRows?.(null, line); return; }
          last = parsed;
          onRows?.(parsed, line);
        },
      });
    },
    disable: () => sup.stop('l1b'),
    state: () => sup.state('l1b'),
    latest: () => last,
  };
}
