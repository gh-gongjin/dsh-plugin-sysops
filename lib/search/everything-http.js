/**
 * lib/search/everything-http.js —— Everything HTTP 适配器（Task 17，通路 ①）
 *
 * 走 Everything 自带的 /fq/ JSON 接口（默认端口 3417，需在 Everything 里勾选 工具 → 选项 → HTTP 服务器）。
 * 注意：本机未安装 Everything（计划期实测修正 #4）——本适配器契约按 spec/原型编写，**未在本机验证**，
 * 真机用例走 SKIP_LOCAL；requestFn 由调用方注入（生产用 fetch + AbortSignal），单测用桩。
 */

/** 拼 /fq/ 查询 URL：search 走 URL 编码，count 带返回上限，offset 分页偏移，按路径排序 */
export function buildUrl({ q, limit, port, offset = 0 }) {
  return `http://127.0.0.1:${port}/fq/?search=${encodeURIComponent(q)}&count=${limit}&offset=${offset}&sort=path&ascending=1`;
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
  return parsed.results.map((r) => ({
    name: (r && typeof r.name === 'string') ? r.name : null,
    path: (r && typeof r.path === 'string') ? r.path : null,
    size: (r && Number.isFinite(r.size)) ? r.size : null,
    mtime: (r && Number.isFinite(r.date_modified)) ? r.date_modified : null,
    total: Number.isFinite(parsed.total) ? parsed.total : null,
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
  if (!bodyOk) return { rows: [], status: 200, error: 'Everything 返回无法解析（不是 /fq/ 的 JSON 结构）' };
  return { rows: parsed, status: 200 };
}
