/**
 * L1b —— 进程榜。常驻 PowerShell 循环，每轮输出一行 JSON。
 *
 * 实测（三组读数的并集：派单前预检 Ruling-37、实现者一轮、评审一轮；计划期修正 #3 的旧数字已过期）：
 *  - 首行 1777–2246ms（热态连跑），**冷启动单点量到过 3774ms** ⇒ 降级判定按稳态周期，不按单次首行；
 *  - `Start-Sleep 3` + 单轮干活 1.6–1.9s ⇒ **实际周期 4.37–4.91s**，所以心跳基准不能按 3s 算；
 *  - 369–392 进程 / 行 19968–21842 字节、无 BOM（四组读数的并集：预检 / 实现者 / 复审 / 控制器；不是旧记录的 385 / 17.7KB，也别把区间端点当常量用）；
 *  - `taskkill /PID /T /F` 收得掉；stdout 在加 UTF-8 前置后是 UTF-8（不加是 GBK，实测 `b9a8bdf8`），stderr 恒是 GBK。
 * 默认**不开**、由页面可见性驱动（spec §1.2 的结论）。
 */
import os from 'node:os';   // createL1b 里算均摊核数要用（收口那条说的就是它）

export const INTERVAL_SEC = 3;
export const MAX_ROWS = 400;

/**
 * 语句之间**必须用 `;` 分隔**。旧版用 `.join(' ')` 把语句拼成一行，真机读数：
 * `exit=1`、stdout 0 字节、stderr（GBK）"表达式或语句中包含意外的标记"$cores=[Environment]::ProcessorCount""
 * —— 整条采集链路一个字节都不出，而单元测试全绿（测试只正则匹配脚本字符串，不断言 PowerShell 语义）。
 */
export function buildLoopScript({ intervalSec = INTERVAL_SEC, withCpu = true } = {}) {
  // Perf 表提供每进程 CPU 占用（Win32_Process 没有这一列）；关掉时走 withCpu=false 的降级形态
  const cpuMap = withCpu
    ? '$cpu=@{};Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|ForEach-Object{if($null -ne $_.IDProcess){$cpu[[uint32]$_.IDProcess]=$_.PercentProcessorTime}};'
    : '$cpu=@{};';
  return '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
    + 'while($true){'
    + cpuMap
    // 评审 M-1：这里**不加** `Select-Object -First N`。CIM 不排序，脚本里预裁得到的是"任意 N 个"，
    // 而且解析层的 truncated 会恒为 0（源已被裁平）⇒ 进程数 >400 的机器上内存最大的那批无声消失。
    // 条数上限与截断计数都归 parseProcLine。
    + `$rows=@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{id=$_.ProcessId;n=$_.Name;ws=$_.WorkingSetSize;cpu=if($cpu.ContainsKey([uint32]$_.ProcessId)){$cpu[[uint32]$_.ProcessId]}else{$null}}});`
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
  const mapped = obj.rows.map((r) => {
    // 判缺列必须显式认 `null`：真机第一轮 391 行里就有 2 行是 `"cpu":null`（新进程还没进 Perf 表），
    // 而 `Number(null) === 0` —— 不认掉就会把"没测到"折成 0%，Task 9 的 evaluateProc 吃的正是这个键。
    const cell = r?.cpu;
    const raw = cell === null || cell === undefined || cell === '' ? NaN : Number(cell);
    const idRaw = r?.id;
    const idCell = idRaw === null || idRaw === undefined || idRaw === '' ? NaN : Number(idRaw);
    return {
      // 评审 M-2：取不到就是 null。`|| 0` 会把畸形 pid 折成 0，而真机恒有 pid 0 的 System Idle Process
      // （它的 cpuPct 还是 `_Total`/`Idle` 覆盖出来的聚合值）—— 撞在主键上界面就会把缺 pid 的行当 Idle 摆。
      // 复审 Imp-2：判形要**和 cpu 那一列同料**，不能只 `Number(r?.id)` —— `Number(null)` 与 `Number('')` 都是 0，
      // 于是 `"id":null` 的行恰好折进上面那个真 pid 0，正是这条修法要防的事。
      pid: Number.isFinite(idCell) ? idCell : null,
      name: typeof r?.n === 'string' ? r.n : '',
      ws: Number(r?.ws) || 0,
      // PercentProcessorTime 是"所有核合计"口径（可 >100），按核数均摊成单核百分比；缺列为 null 而不是 0
      cpuPct: Number.isFinite(raw) ? raw / cores : null,
    };
  });
  // 评审 M-1：只有**真的超上限**时才排序（按 ws 降序保留最大的一批）。不超上限就不动顺序 ——
  // ps-3 断言的是"原样带出"，界面（Task 21）自己排；这里排序只是为了别让截断丢掉榜尾。
  const overLimit = mapped.length > maxRows;
  const rows = overLimit ? [...mapped].sort((a, b) => b.ws - a.ws).slice(0, maxRows) : mapped;
  return overLimit ? { t: Number(obj.t), rows, truncated: mapped.length - maxRows } : { t: Number(obj.t), rows };
}

/** powershell 的 stdout 解码入口。**不要复用 `decodePd`**（那个是给 typeperf 的 GBK 用的）。 */
export function decodeOut(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return b.toString('utf8');
}

export function createL1b({ sup, onRows, intervalSec = INTERVAL_SEC, maxRows = MAX_ROWS }) {
  // 评审 M-3：装配漏传 onRows 时，下面那两处 `onRows?.()` 会变成 no-op —— 整条进程榜采到了、
  // 解出来了、也存进 latest() 了，但一个订阅者都收不到，且没有任何报错。构造入口就抛。
  if (typeof onRows !== 'function') throw new Error('createL1b 必须传 onRows(parsed, line)，否则进程榜数据全丢且无声');
  let last = null;
  return {
    enable() {
      last = null; // 评审 Important-1：新一轮开始前的旧值不算"当前"
      sup.start('l1b', {
        label: '进程榜（PowerShell 常驻）',
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', buildLoopScript({ intervalSec, withCpu: true })],
        // 心跳基准按**实际周期**算，不是 sleep 秒数：实测 `Start-Sleep 3` + 单轮干活 1.6–1.9s ⇒ 4.37–4.91s 一行。
        // 监督者的判定是 `3 × intervalMs` 无数据 ⇒ stalled，取 5000 ⇒ 15s，余量 3 倍多。
        intervalMs: (intervalSec + 2) * 1000,
        onData: (raw) => {
          // Task 5 交付契约：`raw` 是 Buffer 完整行。直接把它交给 parseProcLine 会命中
          // `typeof text !== 'string'` ⇒ **每一行**都判成"非 JSON"，进程榜永远空且不报错。
          const line = decodeOut(raw);
          const parsed = parseProcLine(line, { procCount: os.cpus().length, maxRows });
          if (!parsed) { onRows(null, line); return; }
          last = parsed;
          onRows(parsed, line);
        },
      });
    },
    disable() {
      last = null; // 评审 Important-1：源已停，界面拿上一轮残值画"实时进程榜"是最坏的一种静默
      return sup.stop('l1b');
    },
    state: () => sup.state('l1b'),
    latest: () => last,
  };
}
