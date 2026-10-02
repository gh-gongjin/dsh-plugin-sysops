/**
 * lib/search/probe.js —— Everything 三级探测（Task 16）
 *
 * 三级：①installed（是否装过）→ ②channel（HTTP :3417 / es.exe 两条查询通路）→ ③e2e（真查询一次，返回的 results 真是数组才算通）。
 * ① 的三条证据：常见路径有 Everything.exe / es.exe 可用 / 查询服务在应答（S11-③ 加的最后一条 —— 正在运行就是装过的直接证据）。
 * 探测全程只读：existsSync / HTTP GET / execFile es.exe 查询，不写注册表、不结束进程、也不在这里夹带安装
 * （S12-⑤ 的「一键安装」是 lib/search/installer.js 的独立动作，要用户在引导卡上显式确认才起，
 *  本文件的任何一条探测路径都不会顺手装东西）。
 * 卡在哪一级就在 checks 的 detail 里说清楚，界面按 detail 直显；advice 逐级取舍，与原型 guideCard 文案一致。
 */

export const PROBE_LEVELS = ['installed', 'channel', 'e2e'];
export const DEFAULT_EVERYTHING_PORT = 3417;
export const CACHE_TTL_MS = 30_000;

/** 端到端探针词：必定搜不到的文件名，验证的是「返回结构可解析」而不是「有结果」 */
const E2E_PROBE_WORD = 'sysops-probe-';

/**
 * 常见安装路径的**基址候选**（只读取证）：基址全部来自环境变量，不把某块盘符焊进代码
 * （S11-③ 的教训：原实现只查 `C:\Program Files\Everything\Everything.exe`，
 *  本机装在 D: 就永远「未探到已安装」—— 换个装机位置就得改源码，这不是修复而是拟合）。
 * 装在这些基址之外（便携版 / 非常规盘）的情况由「HTTP 服务在应答」那一条兜住，见 probe() 内注释。
 */
export function everythingExeCandidates(env = process.env) {
  const e = env && typeof env === 'object' ? env : {};
  const raw = [e.ProgramFiles, e.ProgramW6432, e['ProgramFiles(x86)']];
  // env 一个都没给（精简过的服务环境）才退到系统盘默认基址；给了 D 盘就查 D 盘，不再夹带 C 盘。
  const bases = raw.some((b) => typeof b === 'string' && b.trim() !== '') ? raw : ['C:\\Program Files'];
  const seen = new Set();
  const out = [];
  for (const b of bases) {
    if (typeof b !== 'string' || b.trim() === '') continue;
    const p = `${b.replace(/[\\/]+$/, '')}\\Everything\\Everything.exe`;
    if (seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

/**
 * 安装指引三条，逐字对齐原型 guideCard（winget / 官网 / 勾选 HTTP 服务器）。
 * 第 0 条 S12-⑤ 改了口径：本机探得到 winget 时界面有「一键安装 Everything」那颗按钮（lib/search/installer.js），
 * 但这一条**仍然把命令原文写给用户** —— 探不到 winget 时按钮不亮，这句就是唯一出路；
 * 顺序不许动（probe() 里 `advice = [ADVICE[2]]` 按第三行取「装了但通路没开」那一档）。
 */
export const ADVICE = [
  '一键安装：点亮上面的那颗「一键安装 Everything」（本插件代跑 winget）；要自己执行也行：winget install voidtools.Everything',
  '或从官网下载安装包：https://www.voidtools.com/downloads/',
  '装好后在 Everything 里勾选 工具 → 选项 → HTTP 服务器（默认端口 3417），或把官方的 es.exe 放进 PATH，然后点上方「重新检测」。',
];

/** 单路探测的默认超时：HTTP 1500ms、es.exe 3000ms */
const DEFAULT_HTTP_TIMEOUT_MS = 1500;
const DEFAULT_ES_TIMEOUT_MS = 3000;

/** 给注入的异步探针加截止时间；注入函数不认超时也保证不悬挂 */
function withTimeout(promise, ms, tag) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${tag} 超时 ${ms}ms`), { name: 'TimeoutError' })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createProbe({ fsMod, requestFn, execFileMod, getPrefs, now, env = process.env, ttlMs = CACHE_TTL_MS, httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS, esTimeoutMs = DEFAULT_ES_TIMEOUT_MS }) {
  let cached = null;

  function prefsSearch() {
    const p = getPrefs();
    return (p && p.search) || {};
  }

  /** JSON 查询的公共参数：三个列开关决定 name/path/size/日期能不能拿到（缺列就真的是空值） */
  const JSON_COLS = 'json=1&path_column=1&size_column=1&date_modified_column=1';

  /** HTTP 通路：GET 根路径 + json=1，只有 200 且能解析出 results 才算通；detail 按状态码分开说 */
  async function probeHttp(port) {
    const url = `http://127.0.0.1:${port}/?search=${encodeURIComponent('a')}&count=1&${JSON_COLS}`;
    try {
      const res = await withTimeout(requestFn(url, { method: 'GET', timeoutMs: httpTimeoutMs }), httpTimeoutMs, 'HTTP 探测');
      if (res.status === 200) return { ok: true, detail: 'HTTP 200：Everything 的查询服务可达' };
      if (res.status === 403) return { ok: false, detail: 'HTTP 403，需在 Everything 里勾选 工具 → 选项 → HTTP 服务器' };
      // 404 单独成文案：这一档在真机上出现过（原实现打的是 /fq/，本机 Everything 只认根路径 + json=1），
      // 「服务应答异常」把「端口上根本没有 Everything」和「URL 打错了」混成一句，用户无从下手。
      if (res.status === 404) return { ok: false, detail: `HTTP 404：端口 ${port} 有应答，但不是 Everything 的查询接口（检查端口是否被别的服务占用）` };
      return { ok: false, detail: `HTTP ${res.status}：服务应答异常` };
    } catch (error) {
      // fetch 拒连时 ECONNREFUSED 挂在 error.cause（undici），execFile/HTTP 库则挂 error.code；两处都认
      const refused = error && (error.code === 'ECONNREFUSED'
        || /ECONNREFUSED/.test(String(error.message))
        || /ECONNREFUSED/.test(String((error.cause && (error.cause.code || error.cause.message)) || '')));
      if (refused) return { ok: false, detail: '连接被拒（Everything 未运行或未开 HTTP）' };
      if (error && error.name === 'TimeoutError') return { ok: false, detail: `HTTP 探测超时（${httpTimeoutMs}ms）` };
      return { ok: false, detail: `HTTP 探测失败：${error && error.message ? error.message : String(error)}` };
    }
  }

  /** es 通路：execFile（非 shell）跑 `es.exe -max-count 1 a`，成功且有可解析输出算通 */
  async function probeEs(bin) {
    try {
      const out = await withTimeout(execFileMod(bin, ['-max-count', '1', 'a'], { timeout: esTimeoutMs, windowsHide: true }), esTimeoutMs, 'es.exe 探测');
      const text = out && typeof out.stdout === 'string' ? out.stdout : '';
      if (!text) return { ok: false, detail: 'es.exe 有应答但输出为空，无法确认返回结构' };
      return { ok: true, detail: `es.exe 可用（${bin}），输出可按行解析` };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: false, detail: '未找到 es.exe（不在 PATH，可在设置页指定路径）' };
      if (error && error.name === 'TimeoutError') return { ok: false, detail: `es.exe 探测超时（${esTimeoutMs}ms）` };
      return { ok: false, detail: `es.exe 探测失败：${error && error.message ? error.message : String(error)}` };
    }
  }

  /** 端到端：拿必定不存在的探针词真查一次，返回结构可解析才算通（空结果也算通） */
  async function probeE2E(via, port, bin) {
    if (via === 'http') {
      const url = `http://127.0.0.1:${port}/?search=${encodeURIComponent(E2E_PROBE_WORD)}&count=1&${JSON_COLS}`;
      try {
        const res = await withTimeout(requestFn(url, { method: 'GET', timeoutMs: httpTimeoutMs }), httpTimeoutMs, '端到端试查询');
        if (res.status !== 200) return false;
        // 验的是「我们真吃得下这个返回」：results 必须是数组，否则搜索页拿到的就是空表 + 一句谎
        try { const parsed = JSON.parse(res.body); return !!parsed && Array.isArray(parsed.results); } catch { return false; }
      } catch { return false; }
    }
    if (via === 'es') {
      try {
        const out = await withTimeout(execFileMod(bin, ['-max-count', '1', E2E_PROBE_WORD], { timeout: esTimeoutMs, windowsHide: true }), esTimeoutMs, '端到端试查询');
        return !!(out && typeof out.stdout === 'string');
      } catch { return false; }
    }
    return false;
  }

  async function probe(force) {
    if (!force && cached && now() - cached.at < ttlMs) return cached;
    let result;
    try {
      const s = prefsSearch();
      const port = s.port ?? DEFAULT_EVERYTHING_PORT;
      const bin = (s.esPath && String(s.esPath).trim()) || 'es.exe';
      const walkDirs = Array.isArray(s.walkDirs) ? s.walkDirs : [];
      let exeCheckError = null;

      // 第一级 installed：常见安装路径存在（多候选，见 everythingExeCandidates），或 es.exe 命中（pb-5）
      let exeFoundAt = null;
      for (const cand of everythingExeCandidates(env)) {
        try {
          if (fsMod.existsSync(cand)) { exeFoundAt = cand; break; }
        } catch (error) {
          // existsSync 理论上不抛；真抛了也当作未找到，原因并入 http/es 之外的兜底 detail，不静默吞掉
          exeCheckError = error;
        }
      }
      const exeFound = exeFoundAt !== null;

      // 第二级 channel：两路并行、各自超时
      const [httpRes, esRes] = await Promise.all([probeHttp(port), probeEs(bin)]);

      // 选路：装了 Everything.exe 时 HTTP 优先；未装但 es.exe 可用则 es 优先（pb-5「只有 es.exe 可用 → via=es」），
      // 两条兜底顺序保证「exe 不在位但 :3417 应答」（可能是装在别处）仍能用 http。
      const via = (exeFound && httpRes.ok) ? 'http' : (esRes.ok ? 'es' : (httpRes.ok ? 'http' : null));
      // S11-③：查询服务在应答就是「Everything 正在运行」的直接证据。装在哪块盘、有没有走 Program Files
      // 都不影响这个结论；把它排除在 installed 之外，就会出现「搜索明明能用，自检却说没装」。
      const installed = exeFound || esRes.ok || httpRes.ok;
      const channel = via !== null;

      // 第三级 e2e：只有 channel 通了才跑
      const e2e = channel ? await probeE2E(via, port, bin) : false;
      const ready = installed && channel && e2e;
      // level = 走到的最远一级；channel 通了但 e2e 失败标 'channel'（pb 用例只验 installed/e2e/null 三档）
      const level = ready ? 'e2e' : (installed && channel ? 'channel' : (installed ? 'installed' : null));

      let advice;
      if (!installed) advice = [...ADVICE];
      else if (!channel) advice = [ADVICE[2]];
      else if (!e2e) advice = ['查询接口能连上但返回无法解析，试试重启 Everything。'];
      else advice = [];

      const walkDetail = walkDirs.length > 0
        ? `已选 ${walkDirs.length} 个限定目录作为遍历兜底`
        : '未选目录：到设置页 → 搜索通路 里添加要覆盖的目录，兜底遍历不可用';

      result = {
        at: now(),
        installed,
        http: httpRes.ok,
        es: esRes.ok,
        e2e,
        ready,
        via,
        degraded: !ready,
        level,
        checks: [
          {
            key: 'installed',
            label: '① 已安装 Everything',
            ok: installed,
            detail: installed
              ? (exeFound
                  ? `已在常见路径找到 Everything.exe（${exeFoundAt}）${esRes.ok ? '，es.exe 亦可用' : ''}`
                  : (httpRes.ok
                      ? `未在常见路径找到 Everything.exe，但 :${port} 的查询服务在应答 ⇒ Everything 正在运行（装在别的盘或便携版不影响结论）`
                      : '未在常见路径找到，但 PATH/配置里的 es.exe 可用'))
              : `未在常见安装路径找到 Everything.exe，es.exe 与 :${port} 的查询服务也都没应答（未探到已安装）${exeCheckError ? `；安装路径检查本身异常：${exeCheckError.message || String(exeCheckError)}` : ''}`,
          },
          { key: 'http', label: `② HTTP 查询通路（:${port}）`, ok: httpRes.ok, detail: httpRes.detail },
          { key: 'es', label: '② es.exe 查询通路', ok: esRes.ok, detail: esRes.detail },
          { key: 'walk', label: '③ 本地遍历兜底', ok: walkDirs.length > 0, detail: walkDetail },
        ],
        advice,
      };
    } catch (error) {
      // 最后一道闸：任何未预期异常都不许冒到调用方，落成「探测失败」这一等第的输出
      result = {
        at: now(),
        installed: false,
        http: false,
        es: false,
        e2e: false,
        ready: false,
        via: null,
        degraded: true,
        level: null,
        checks: [
          { key: 'installed', label: '① 已安装 Everything', ok: false, detail: `探测内部异常：${error && error.message ? error.message : String(error)}` },
          { key: 'http', label: '② HTTP 查询通路', ok: false, detail: '因内部异常未完成探测' },
          { key: 'es', label: '② es.exe 查询通路', ok: false, detail: '因内部异常未完成探测' },
          { key: 'walk', label: '③ 本地遍历兜底', ok: false, detail: '因内部异常未完成目录覆盖确认' },
        ],
        advice: [...ADVICE],
      };
    }
    cached = result;
    return result;
  }

  /** 界面「重新检测」：绕开缓存，下次 probe() 必发真探测 */
  function invalidate() {
    cached = null;
  }

  /** 最近一次探测结果（未探过返回 null，调用方决定要不要先 probe） */
  function last() {
    return cached;
  }

  return { probe, invalidate, last };
}
