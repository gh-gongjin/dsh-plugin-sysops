/**
 * lib/search/probe.js —— Everything 三级探测（Task 16）
 *
 * 三级：①installed（是否装过）→ ②channel（HTTP :3417 / es.exe 两条查询通路）→ ③e2e（真查询一次，返回结构可解析才算通）。
 * 探测全程只读：existsSync / HTTP GET / execFile es.exe 查询，不写注册表、不结束进程、不代装软件（全局约束第 7 条）。
 * 卡在哪一级就在 checks 的 detail 里说清楚，界面按 detail 直显；advice 逐级取舍，与原型 guideCard 文案一致。
 */

export const PROBE_LEVELS = ['installed', 'channel', 'e2e'];
export const DEFAULT_EVERYTHING_PORT = 3417;
export const CACHE_TTL_MS = 30_000;

/** 端到端探针词：必定搜不到的文件名，验证的是「返回结构可解析」而不是「有结果」 */
const E2E_PROBE_WORD = 'sysops-probe-';

/** 常见安装路径（只读取证；spec 原型还有注册表键，红线约束下本模块只做文件存在性检查） */
const EVERYTHING_EXE_PATH = 'C:\\Program Files\\Everything\\Everything.exe';

/** 安装指引三条，逐字对齐原型 guideCard（winget / 官网 / 勾选 HTTP 服务器） */
export const ADVICE = [
  '安装（由你自己执行，本插件不会替你装程序）：winget install voidtools.Everything',
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

export function createProbe({ fsMod, requestFn, execFileMod, getPrefs, now, ttlMs = CACHE_TTL_MS, httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS, esTimeoutMs = DEFAULT_ES_TIMEOUT_MS }) {
  let cached = null;

  function prefsSearch() {
    const p = getPrefs();
    return (p && p.search) || {};
  }

  /** HTTP 通路：GET /fq/?search=a&count=1，只有 200 算通；detail 按状态码分开说（403 = 没勾 HTTP 服务器） */
  async function probeHttp(port) {
    const url = `http://127.0.0.1:${port}/fq/?search=${encodeURIComponent('a')}&count=1`;
    try {
      const res = await withTimeout(requestFn(url, { method: 'GET', timeoutMs: httpTimeoutMs }), httpTimeoutMs, 'HTTP 探测');
      if (res.status === 200) return { ok: true, detail: 'HTTP 200：Everything 的查询服务可达' };
      if (res.status === 403) return { ok: false, detail: 'HTTP 403，需在 Everything 里勾选 工具 → 选项 → HTTP 服务器' };
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
      const url = `http://127.0.0.1:${port}/fq/?search=${encodeURIComponent(E2E_PROBE_WORD)}&count=1`;
      try {
        const res = await withTimeout(requestFn(url, { method: 'GET', timeoutMs: httpTimeoutMs }), httpTimeoutMs, '端到端试查询');
        if (res.status !== 200) return false;
        try { const parsed = JSON.parse(res.body); return !!parsed && typeof parsed === 'object'; } catch { return false; }
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

      // 第一级 installed：常见安装路径存在，或 es.exe 命中（pb-5）
      let exeFound = false;
      try { exeFound = !!fsMod.existsSync(EVERYTHING_EXE_PATH); } catch (error) {
        // existsSync 理论上不抛；真抛了也当作未找到，原因并入 http/es 之外的兜底 detail，不静默吞掉
        exeFound = false;
        exeCheckError = error;
      }

      // 第二级 channel：两路并行、各自超时
      const [httpRes, esRes] = await Promise.all([probeHttp(port), probeEs(bin)]);

      // 选路：装了 Everything.exe 时 HTTP 优先；未装但 es.exe 可用则 es 优先（pb-5「只有 es.exe 可用 → via=es」），
      // 两条兜底顺序保证「exe 不在位但 :3417 应答」（可能是装在别处）仍能用 http。
      const via = (exeFound && httpRes.ok) ? 'http' : (esRes.ok ? 'es' : (httpRes.ok ? 'http' : null));
      const installed = exeFound || esRes.ok;
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
              ? (exeFound ? `已在常见路径找到 Everything.exe${esRes.ok ? '，es.exe 亦可用' : ''}` : '未在常见路径找到，但 PATH/配置里的 es.exe 可用')
              : `未在常见安装路径找到 Everything.exe，es.exe 也不可用（未探到已安装）${exeCheckError ? `；安装路径检查本身异常：${exeCheckError.message || String(exeCheckError)}` : ''}`,
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
