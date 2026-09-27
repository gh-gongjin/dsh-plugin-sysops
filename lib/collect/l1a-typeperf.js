/**
 * L1a —— 网络吞吐。常驻 `typeperf` 流式输出，逐行解析 PDH-CSV 4.0。
 *
 * 两个实测坑（计划期修正 #1 / #2）：
 *  - `-sc 0` 在无控制台管道里出一个样本就退出，所以**定窗续采**（每窗 30 个样本），
 *    由 supervisor 的 rolling 语义接下一窗；本机实测暖身 ≈330ms / 窗（2 样本窗 2337–2373ms），
 *    摊薄到 30 样本窗后 <1%。
 *  - 输出是 OEM 代码页（中文机器名为 GBK 字节），`TextDecoder('gbk')` 在本机 Node 24 可用；
 *    机器名前缀反正用不上，直接靠正则只取 `Network Interface(<实例>)\<计数器>`。
 *
 * 多实例（物理网卡 + isatap + loopback）按指标**求和**：界面要的是"本机下行多少"。
 */

export const COUNTER_ARGS = ['\\Network Interface(*)\\Bytes Received/sec', '\\Network Interface(*)\\Bytes Sent/sec'];
export const WINDOW_SAMPLES = 30;
export const INTERVAL_SEC = 1;
const METRIC_BY_COUNTER = { 'bytes received/sec': 'netDown', 'bytes sent/sec': 'netUp' };
const HEADER_PATH_RE = /Network Interface\(([^)]*)\)\\([^"]+?)"?$/i;

let gbk = null;
try { gbk = new TextDecoder('gbk'); } catch { gbk = null; }   // 本机 Node 24 可用；留兜底给无 ICU 的环境

export function decodePd(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'latin1');
  if (gbk) {
    const s = gbk.decode(b);
    // TextDecoder 默认 fatal:false —— **不会抛**，非法字节出 U+FFFD。
    // 所以回落条件只能是"解出了替换符"（tp-8 用 [0x81] 钉住）；原实现的 try/catch 是死代码。
    // latin1 逐字节映射，永不丢字节，数字与 ASCII 结构都还在。
    if (!s.includes('\uFFFD')) return s;
  }
  return b.toString('latin1');
}

/**
 * 手写扫描：引号内的逗号不是分隔符，`""` 与 `\"` 都当转义引号（tp-1）。
 * 不用正则拆 —— PDH-CSV 的字段里全是反斜杠与方括号，正则边界反而难钉。
 */
export function splitCsv(line) {
  const cells = [];
  let cur = '';
  let quoted = false;      // 当前是否在引号段内
  let escapeSlash = false; // 上一字符是 `\` 且处于引号段内（`\"` 转义用）
  let started = false;     // 本行是否已开始进入字段（区分"行尾空字段"与"未开始"）
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (!started) started = true;
    if (escapeSlash) {
      escapeSlash = false;
      cur += ch === '"' ? '"' : '\\' + ch; // `\"` → `"`；`\x` 保留原样（反斜杠是路径分隔符）
      continue;
    }
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }   // `""` → `"`
        else { quoted = false; }
      } else if (ch === '\\') {
        escapeSlash = true;
      } else {
        cur += ch;
      }
    } else if (ch === '"' && cur === '') {
      quoted = true;                                      // 字段起始引号
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;                                          // 未加引号字段按原样收
    }
  }
  if (started) cells.push(cur);
  return cells;
}

export function parseHeader(text) {
  if (!text.startsWith('"')) return null;
  const cells = splitCsv(text);
  if (!/^\(PDH-CSV/.test(cells[0] ?? '')) return null;
  const counters = [];
  for (let i = 1; i < cells.length; i += 1) {
    const m = HEADER_PATH_RE.exec(cells[i]);
    if (!m) continue;
    const metric = METRIC_BY_COUNTER[m[2].trim().toLowerCase()];
    counters.push({ index: i, instance: m[1], counter: m[2].trim(), metric: metric ?? null });
  }
  return counters.length ? { counters } : null;
}

/** MM/DD/YYYY HH:mm:ss.fff → 本地时区毫秒时间戳；形状不对返回 NaN。 */
export function parsePdTime(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(String(s).trim());
  if (!m) return NaN;
  const ms = Number(m[7]) * (m[7].length === 2 ? 10 : m[7].length === 1 ? 100 : 1);
  return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime();
}

export function parseSampleLine(line, counters) {
  if (!line.startsWith('"')) return null;
  // 不完整的行整行丢弃（tp-7）。typeperf 每个值都带引号，所以"行尾没有引号"= 半行；
  // 列数下限按**表头最大列号**算，不是 `counters.length` —— 预检原实现只看
  // `Number.isFinite(每列)`，实测把 `"…","2097152.0000` 这种半行当成了有效样本、
  // 悄悄吐出一个只有下行没有上行的"半口吞吐"。
  const need = counters.reduce((m, c) => Math.max(m, c.index + 1), 0);
  const cells = splitCsv(line);
  if (!line.endsWith('"') || cells.length < need) return null;
  const t = parsePdTime(cells[0] ?? '');
  if (!Number.isFinite(t)) return null;
  const sums = {};
  let seen = 0;
  for (const c of counters) {
    if (!c.metric) continue;
    const n = Number(cells[c.index]);
    if (!Number.isFinite(n)) continue;   // *_no data（非数值）→ 跳过该列。速率不会有负数，不设 n<0 分支
    sums[c.metric] = (sums[c.metric] ?? 0) + n;
    seen += 1;
  }
  return seen ? { t, values: sums } : null;        // 一列可用都没有 → 整行 null（不补 0）
}

export function createL1a({ sup, onPoint, intervalSec = INTERVAL_SEC, windowSamples = WINDOW_SAMPLES }) {
  let headers = null;
  return {
    enable() {
      sup.start('l1a', {
        label: '网络吞吐（typeperf 常驻）',
        cmd: 'typeperf',
        args: [...COUNTER_ARGS, '-sc', String(windowSamples), '-si', String(intervalSec)],
        intervalMs: intervalSec * 1000,
        rolling: true,
        minWindowMs: windowSamples * intervalSec * 1000 * 0.5,
        onData: (raw) => {
          // Task 5 交付契约：`raw` 是**一整行的 Buffer**（`\r\n` 已去），解码归消费方。
          // 每行只解一次；GBK 对纯 ASCII 是恒等的，所以不必先判断有没有高位字节。
          const line = decodePd(raw);
          headers = parseHeader(line) ?? headers;
          if (!headers) return;
          const s = parseSampleLine(line, headers.counters);
          if (!s) return;
          for (const [metric, v] of Object.entries(s.values)) onPoint({ metric, t: s.t, v });
        },
      });
    },
    disable() { return sup.stop('l1a'); },
    state: () => sup.state('l1a'),
  };
}
