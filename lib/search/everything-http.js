/**
 * lib/search/everything-http.js —— Everything HTTP 适配器（Task 17，通路 ①）
 *
 * 走 Everything 自带 HTTP 服务器的 JSON 查询（默认端口 3417，需在 Everything 里勾选 工具 → 选项 → HTTP 服务器）。
 *
 * S11-③ 真机修正（2026-09-29 实测，读数存 `tmp/s11-everything.txt`）：本适配器原先按 spec/原型写、
 * 未在本机验证，两处与真机不符，合起来就是用户看到的「文件搜索有问题」：
 *  1. `GET /fq/?search=…` 在这台 Everything 上回 **404**（`/index.html` `/ex/` `/ve/` `/json/` `/search` `/export` 同样 404）。
 *     能用的是**根路径 + json=1**：`/?search=…&count=…&offset=…&json=1&path_column=1&size_column=1&date_modified_column=1`
 *     → 200 `application/json`。
 *  2. 真实体形状是 `{ totalResults, results: [{ type, name, path, size, date_modified }] }`：
 *     · `name` 只有文件名、`path` 是它的**父目录**（不是全路径）⇒ 展示与「打开所在目录」都得自己拼回去；
 *     · `size` 是**十进制字符串**（文件夹是 "" 或干脆没这个键），`date_modified` 是 **Windows FILETIME 字符串**
 *       （1601-01-01 起的 100ns 刻度）⇒ 原来的 `Number.isFinite(r.size)` 一律判 false，
 *       每一行都记成 null，表格看着就是「搜到了但什么都没有」。
 */

/** 拼查询 URL：search 走 URL 编码，count 带返回上限，offset 分页偏移，三个列开关换来 name/path/size/日期四列 */
export function buildUrl({ q, limit, port, offset = 0 }) {
  return `http://127.0.0.1:${port}/?search=${encodeURIComponent(q)}&count=${limit}&offset=${offset}`
    + `&json=1&path_column=1&size_column=1&date_modified_column=1&sort=path&ascending=1`;
}

/** FILETIME（1601 起）到 unix 毫秒的差值 */
const FILETIME_TO_UNIX_MS = 11_644_473_600_000;

/**
 * 修改时间归一为 unix 毫秒。两条口径都收，靠量级区分而不是靠版本猜：
 * FILETIME（本机实测的 `132963745525044623`）比任何 unix 秒值大十个数量级，除完 10000 再减差值才落在 1970 之后；
 * 减完仍是负数就按 unix 秒（早期 `/fq/` 的口径）试一次，再不合理就交 null。
 * FILETIME 的整数超出 2^53，`Number()` 的相对误差折成毫秒不足万分之一秒，对「按天排序」无影响。
 */
export function toMtimeMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const asFiletime = Math.round(n / 10000) - FILETIME_TO_UNIX_MS;
  if (asFiletime > 0) return asFiletime;
  const asUnixSec = n * 1000;
  return asUnixSec > 0 && asUnixSec < 4102444800000 ? asUnixSec : null;
}

/** 字节数：Everything 交的是十进制字符串（文件夹为 ""）；缺字段/空串一律 null，不把「未知」当「0 B」 */
export function toSize(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/** `path` 是父目录、`name` 是文件名：拼回全路径交给 normalize() 去再拆 dir/name */
function joinFull(parent, name) {
  if (typeof parent !== 'string' || parent === '') return typeof name === 'string' ? name : null;
  if (typeof name !== 'string' || name === '') return parent;
  return /[\\/]$/.test(parent) ? parent + name : `${parent}\\${name}`;
}

/** 缺字段一律记 null，不许把「未知」当「没有」（0 B / 0 时间都是断言） */
export function parseEverythingJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 空数组交给调用方记「返回无法解析」的错误，这里不静默谎称成功
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) return [];
  const total = Number.isFinite(parsed.totalResults) ? parsed.totalResults
    : (Number.isFinite(parsed.total) ? parsed.total : null);
  return parsed.results.map((r) => ({
    name: (r && typeof r.name === 'string') ? r.name : null,
    path: joinFull(r && r.path, r && r.name),
    size: toSize(r && r.size),
    mtime: toMtimeMs(r && r.date_modified),
    total,
  }));
}

/**
 * 查询一次：任何非 200 / 网络错 / 超时都收敛为 { rows: [], error }，不向上抛。
 * 403 单独成错并给出可执行指引（spec §4.4）。
 */
export async function searchEverything({ q, limit, port, requestFn, timeoutMs = 4000, offset = 0 }) {
  const url = buildUrl({ q, limit, port, offset });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await requestFn(url, { method: 'GET', signal: ctrl.signal, timeoutMs });
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort|timeout|超时/i.test(String(error.code ?? '') + String(error.message ?? '')));
    if (aborted) return { rows: [], error: `请求超时（timeout，${timeoutMs}ms 到点已取消）` };
    return { rows: [], error: `HTTP 请求失败：${error && error.message ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200) {
    if (res.status === 403) {
      return { rows: [], status: 403, error: 'Everything 的 HTTP 服务未开启：在 Everything 里勾选 工具 → 选项 → HTTP 服务器（默认端口 3417）' };
    }
    return { rows: [], status: res.status, error: `Everything HTTP 返回 ${res.status}，未取到结果` };
  }
  const parsed = parseEverythingJson(res.body);
  let bodyOk = false;
  try {
    const p = JSON.parse(res.body);
    bodyOk = !!p && Array.isArray(p.results);
  } catch { bodyOk = false; }
  if (!bodyOk) return { rows: [], status: 200, error: 'Everything 返回无法解析（不是 HTTP 服务器的 JSON 结构，需带 json=1）' };
  return { rows: parsed, status: 200 };
}
