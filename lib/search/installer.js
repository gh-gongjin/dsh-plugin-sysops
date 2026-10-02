/**
 * lib/search/installer.js —— Everything 一键安装（S12-⑤，用户批注「自检卡加 Everything 一键安装按钮」）
 *
 * 已批口径：**一键安装走 winget，且探不到 winget 就不亮按钮**。本模块就是那条「探没探到」的唯一真相：
 * 界面那颗按钮亮不亮、为什么不亮，全吃 `ready()` 的回读，客户端不自己判 PATH、也不自己拼命令行。
 *
 * 四道闸（顺序不能反）：
 *  1. **参数永不采信前端**：`start()` 不收任何来自请求体的字段。要装的包 id、源、命令行全部是本文件
 *     的常量（同 lib/api.js 对 apply「路径永不采信前端」的口径 —— 能改系统的那只手只认宿主自己写死的形状）。
 *  2. **非 shell**：只经注入的 `execFileMod`（index.js 的 execFile 门面）跑，命令行不是拼出来的字符串。
 *  3. **先探再起**：`detect()` 没探到 winget 就直接拒（`SEARCH_INSTALL_UNAVAILABLE`），
 *     界面上「亮不起来」与「点了被拒」是同一句原因，不出现「按钮能点、点了没反应」。
 *  4. **一次只跑一装**：`phase==='running'` 期间的第二次点击拒成 `SEARCH_INSTALL_BUSY`
 *     —— winget 自己有锁，但把「已经在装了」说成一句就地字，比让用户对着一个卡住的安装器猜强。
 *
 * 与红线的关系（这一条是**写入**系统的唯一入口，所以写清楚）：
 * 全局约束里「不代装软件」的原意是**探测段不许夹带安装**（probe.js 全程只读：existsSync / GET / 查询）。
 * 安装是用户在自检卡上显式点「确认安装」才发生的**独立动作**，不藏在任何只读流程里；
 * 它只装这一个公开 id、不静默升级别的包、不写注册表（winget 的 MSI 由它自己记账）、不结束任何进程。
 * UAC 提权窗口由 winget 自己弹 —— 插件不代点同意，也不冒充管理员。
 */

/** 唯一的包 id：不是参数、不可被前端改写。 */
export const EVERYTHING_PKG_ID = 'voidtools.Everything';
/** 只认 winget 官方源，不 --source 第三方。 */
export const WINGET_SOURCE = 'winget';
/** 交给 winget 的参数表（execFile 用，非 shell）。两个 accept 是必需的：否则它会停在协议确认上等输入，
 *  而插件这一侧没有控制台可以点。 */
export const WINGET_ARGS = Object.freeze([
  'install', '--id', EVERYTHING_PKG_ID, '--exact', '--source', WINGET_SOURCE,
  '--accept-package-agreements', '--accept-source-agreements',
]);
/** 探测 winget 的时限：`winget --version` 正常在几百毫秒内回来。 */
export const WINGET_VERSION_TIMEOUT_MS = 5000;
/** winget 可能在安装中途弹 UAC，10 分钟是给"人要点一下同意"留的余量，到点由 execFile 自己收尸。 */
export const WINGET_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** 探测结论的有效期：App Installer 是系统组件，一个会话内不会出现第二次；但拒装之后允许再探。 */
export const WINGET_DETECT_TTL_MS = 120_000;
/** 终态回显的输出尾巴行数与长度：够看出「0x80070005 拒绝访问」，又不把进度条刷屏搬进帧里。 */
const OUT_TAIL_LINES = 12;
const OUT_TAIL_MAX = 2000;

/** 本模块的两种拒法（其余异常按宿主通用 500 走）。 */
export const INSTALL_ERROR = {
  UNAVAILABLE: 'SEARCH_INSTALL_UNAVAILABLE',
  BUSY: 'SEARCH_INSTALL_BUSY',
};

/** 一装一次的记录形状（idle 时 state() 返回 phase:'idle'，界面据此不显示进度）。 */
export const INSTALL_PHASES = ['idle', 'running', 'done', 'failed'];

/** 把 winget 的输出收成看得懂的几行：它喜欢用 \r 推进度条，整段搬进帧会把界面撑爆。 */
export function tailOutput(text, maxLines = OUT_TAIL_LINES, maxChars = OUT_TAIL_MAX) {
  const raw = String(text ?? '').replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!raw.length) return '';
  const joined = raw.slice(-maxLines).join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/** 从 `winget --version` 的输出里挑版本号（v1.x.y 或 1.x.y）；挑不出也不当成「没有 winget」。 */
export function wingetVersion(text) {
  const m = String(text ?? '').match(/v?\d+\.\d+(?:\.\d+)?/);
  return m ? m[0] : '';
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createInstaller({
  execFileMod,
  probe,
  logger,
  now,
  bin = 'winget',
  versionTimeoutMs = WINGET_VERSION_TIMEOUT_MS,
  installTimeoutMs = WINGET_INSTALL_TIMEOUT_MS,
  detectTtlMs = WINGET_DETECT_TTL_MS,
} = {}) {
  if (typeof execFileMod !== 'function') throw new Error('installer 需要 execFileMod（非 shell 执行门面）');

  /** winget 在不在位的结论（null = 还没探过） */
  let detected = null;
  /** 当前/最近一装（null = 本进程没起过安装） */
  let job = null;
  const listeners = new Set();

  function emit(payload) {
    const frame = { type: 'search:install', ...payload };
    for (const cb of listeners) {
      try { cb(frame); } catch (e) { logger?.warn?.(`[sysops] search:install 帧订阅者抛错：${e?.message ?? e}`); }
    }
  }

  function snapshot() {
    if (!job) return { phase: 'idle', job: null };
    return { phase: job.phase, job: { ...job } };
  }

  /**
   * 探 winget 是否可用（只读，不装任何东西）。
   * 结论带 `detail` 原文：界面亮不亮按钮之外，还要能回答「为什么不亮」。
   */
  async function detect(force = false) {
    if (!force && detected && now() - detected.at < detectTtlMs) return { ...detected };
    let next;
    try {
      const out = await execFileMod(bin, ['--version'], { timeout: versionTimeoutMs, windowsHide: true });
      const text = out && typeof out.stdout === 'string' ? out.stdout : '';
      const ver = wingetVersion(text);
      next = {
        at: now(),
        can: true,
        version: ver,
        detail: ver ? `winget ${ver} 在位（${bin}）` : `winget 有应答但没报版本号（${bin}）`,
      };
    } catch (error) {
      const enoent = error && error.code === 'ENOENT';
      const timed = error && (error.name === 'TimeoutError' || /timeout|ETIMEDOUT|超时/i.test(String(error.message ?? error.code)));
      next = {
        at: now(),
        can: false,
        version: '',
        detail: enoent
          ? `PATH 里没有 ${bin}：这台机器没有 App Installer（或它不在服务进程的 PATH 里），只能照下面的说明手动装`
          : (timed
            ? `${bin} --version 在 ${versionTimeoutMs}ms 内没回来：这台机器的 winget 现在不能用，请手动安装`
            : `${bin} --version 失败：${error && error.message ? error.message : String(error)}`),
      };
    }
    detected = next;
    return { ...next };
  }

  /** 界面进搜索页时问一次：能不能装 + 会跑哪一条命令（命令只在宿主这一处拼，界面只回显）。 */
  async function ready() {
    const d = await detect();
    return {
      can: d.can,
      detail: d.detail,
      version: d.version,
      bin,
      packageId: EVERYTHING_PKG_ID,
      command: [bin, ...WINGET_ARGS].join(' '),
      at: d.at,
      running: job ? job.phase === 'running' : false,
    };
  }

  /**
   * 起一装。**不读请求体**：能改的只有「起不起」，改不了装什么。
   * 返回的是刚建立的 job 快照；进度与终态经 `search:install` 帧推出。
   */
  async function start() {
    const d = await detect();
    if (!d.can) {
      detected = null; // 下一次再问就重新探：拒绝的原因（PATH）可能已经被修好
      throw fail(INSTALL_ERROR.UNAVAILABLE, `${d.detail}。所以这次没有启动安装：请照自检卡下面的说明手动安装 Everything。`);
    }
    if (job && job.phase === 'running') {
      throw fail(INSTALL_ERROR.BUSY, `已经有一装在进行中（${new Date(job.startedAt).toISOString()} 起，已跑 ${Math.max(0, Math.round((now() - job.startedAt) / 1000))} 秒）：请等它结束，或先关掉弹出的 winget 窗口。`);
    }
    const at = now();
    job = {
      phase: 'running',
      startedAt: at,
      finishedAt: null,
      exitCode: null,
      message: '',
      outTail: '',
      bin,
      packageId: EVERYTHING_PKG_ID,
      command: [bin, ...WINGET_ARGS].join(' '),
    };
    logger?.info?.(`[sysops] 按用户确认启动 Everything 安装：${job.command}`);
    emit(snapshot());

    let p;
    try {
      p = execFileMod(bin, WINGET_ARGS, { timeout: installTimeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      return settle('failed', { exitCode: null, message: `启动 ${bin} 时就抛了：${error && error.message ? error.message : String(error)}`, at });
    }

    Promise.resolve(p).then(
      (out) => settle('done', {
        exitCode: 0,
        message: `${bin} 正常退出（退出码 0）`,
        outTail: tailOutput((out && (out.stdout || out.stderr)) || ''),
        at,
      }),
      (error) => {
        const code = error && (typeof error.code === 'number' ? error.code : null);
        const timed = error && /timeout|ETIMEDOUT|timed out/i.test(String(error.message ?? '') + String(error.code ?? ''));
        settle('failed', {
          exitCode: code,
          message: error && error.code === 'ENOENT'
            ? `${bin} 在刚才那一瞬不见了（PATH 变了？）：${error.message}`
            : (timed ? `${bin} 跑到 ${installTimeoutMs}ms 上限被取消：安装没有完成` : `${bin} 以非 0 退出（${code === null ? '无退出码' : code}）`),
          outTail: tailOutput([(error && error.stdout) || '', (error && error.stderr) || ''].filter(Boolean).join('\n')),
          at,
        });
      },
    );
    return snapshot();
  }

  /** 落终态：顺手作废探针缓存 —— 装成功了要翻绿，装失败了也得让「重新检测」拿真结果。 */
  function settle(phase, { exitCode, message, outTail = '', at }) {
    if (!job || job.startedAt !== at || job.phase !== 'running') return snapshot(); // 被更新的一装取代，旧回调不改口
    job = { ...job, phase, exitCode, message, outTail, finishedAt: now() };
    if (phase === 'failed') detected = null; // 拒一次之后允许重探（PATH 可能被用户改好了）
    logger?.[phase === 'done' ? 'info' : 'warn']?.(`[sysops] Everything 安装${phase === 'done' ? '完成' : '失败'}：${message}${outTail ? `\n${outTail}` : ''}`);
    try { probe?.invalidate?.(); } catch (e) { logger?.warn?.(`[sysops] 安装结束后作废探针缓存失败：${e?.message ?? e}`); }
    emit(snapshot());
    return snapshot();
  }

  /** 最近一装（没有就是 idle）；界面进本页时补读一次，SSE 断了也不至于看不见已经跑完的安装。 */
  function state() {
    return snapshot();
  }

  function onEvent(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** 只给测试留的观测口：装配是否把缓存清干净、有没有留下 running 的假 job。 */
  function __peek() {
    return { detected, job, listeners: listeners.size };
  }

  return { ready, detect, start, state, onEvent, __peek, PHASES: INSTALL_PHASES };
}
