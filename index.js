/**
 * ============================================================
 * dsh-plugin-sysops —— Host Half（宿主半边）index.js
 * ============================================================
 *
 * 这一半只做四件事，全部是"装配"，不含业务判定：
 *   1. 把四个 service（collect / alerts / clean / search）、五个 store
 *      （prefs / rules / alert_hit / clean_plan / clean_log）与 lib/api.js 门面
 *      接到宿主 ctx 上；
 *   2. 按需探测宿主能力（storageDomain / timer / webServer），缺哪项就怎么降级；
 *   3. 经 `webserver/index-inject` 把配置与能力表推给浏览器半边；
 *   4. 注册 `/sysops` 前缀路由，并在生命周期结束时按序收口（先断采集与子进程，后关存储句柄）。
 *
 * 为什么宿主半边【零 @deepseek-ai/* import】（全局约束 1）：
 *   本插件以 link: 方式挂在 profile 下。一旦 import dsh 内部包，Node 会从插件自己的
 *   node_modules 解析出「第二份」模块实例，模块私有状态不共享，引发极难查的故障。
 *   所以连 domain spec（lib/prefs/spec.js、lib/records/spec.js）都是自造的等价对象，
 *   全链路零 instanceof，这么写是安全的（见 docs/host-capabilities.md）。
 *
 * 为什么 inject = []（零硬 inject）：
 *   Cordis 的 Context 是代理，读未 inject 的服务直接抛 `cannot get property without inject`。
 *   把 webServer / storageDomain / timer 写进 inject 会让"宿主缺任一服务"直接卡死插件加载。
 *   本插件选择按需注入 + 逐项探测 + 如实降级：缺存储配置转只读、缺定时器退 setInterval、
 *   缺 webServer 连侧边栏入口都不注册（点开空白页比看不到入口更糟）。
 *
 * 对系统的读写边界（红线，spec §1.1）：
 *   · 采集只读：L0 走 node:os / fs.statfsSync，L1a 只 spawn `typeperf`，L1b 只 spawn
 *     `powershell` 读进程榜 —— 绝不 spawn 安装器、不代装软件、不写注册表（探测只读）、
 *     不结束任何进程、不做开机自启（notifications / autostart 宿主不提供，见 lib/caps.js）。
 *   · 删除只删"用户在两段式清单里显式勾选的项"，且"能不能删"由 lib/clean/guard.js 单点裁决，
 *     本文件不复制判定、不放宽、也不绕过它直接操作路径（路径永不采信前端）。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import {
  createApiHandler, ROUTE_PREFIX, GLOBAL_KEY,
} from './lib/api.js';
import { createCaps } from './lib/caps.js';
import { COLLECT_CADENCE, SOURCE_KEYS } from './lib/prefs/spec.js';
import { createPrefStore } from './lib/prefs/store.js';
import { createRuleStore } from './lib/prefs/rules-store.js';
import { createAlertHitStore } from './lib/alerts/store.js';
import { createAlertService } from './lib/alerts/service.js';
import { createPlanStore } from './lib/clean/plan-store.js';
import { createLogStore } from './lib/clean/log-store.js';
import { createCleanService } from './lib/clean/service.js';
import { createScanner } from './lib/clean/scanner.js';
import { createExecutor } from './lib/clean/executor.js';
import { createQuarantine } from './lib/clean/quarantine.js';
import { createSearchService } from './lib/search/service.js';
import { createProbe, ADVICE } from './lib/search/probe.js';
import { searchEverything } from './lib/search/everything-http.js';
import { searchEs } from './lib/search/es-exe.js';
import { walkSearch } from './lib/search/walk.js';
import { createCollectService } from './lib/collect/service.js';
import { createSupervisor } from './lib/collect/supervisor.js';
import { createL0 } from './lib/collect/l0-node.js';
import { createL1a } from './lib/collect/l1a-typeperf.js';
import { createL1b } from './lib/collect/l1b-powershell.js';
import { BRANCH_IDS } from './lib/clean/guard.js';

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'sysops';

/** 零硬 inject：webServer / storageDomain / timer 全部按需注入，缺了也不阻塞加载。 */
export const inject = [];

/**
 * 默认配置。全是公开通用值，不含任何个人数据或本机私有路径。
 * `panelOrder:12` 排在股票插件（10）下方；采集默认 l0/l1a 常开、l1b/l2 关（成本结论）。
 */
export const DEFAULT_CONFIG = {
  panelId: 'sysops',
  panelOrder: 12,
  label: '系统运维',
  cadence: '1s',
  keepMinutes: 30,
  sources: { l0: true, l1a: true, l1b: false },
  procIntervalSec: 3,
  procMaxRows: 400,
  quarantineDir: '',
  keepDays: 7,
  after: 'log',
  searchPort: 3417,
  esPath: '',
  walkDirs: [],
};

/** 把值钳进 [min,max] 整数；非有限数回落到 dflt。 */
function clampInt(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 逐键钳制用户配置（profile 的 cordis.patch.yml 可覆盖）。
 * 只认已知键并给每个键一个健壮性回落，脏值绝不带进运行时。
 */
export function resolveConfig(raw = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };

  // cadence：不在 COLLECT_CADENCE 内（含写错 / 写成界面用的 '暂停'）一律回落 '1s'。
  if (!COLLECT_CADENCE.includes(cfg.cadence)) cfg.cadence = DEFAULT_CONFIG.cadence;

  // keepMinutes：环的窗口与上限都靠它，钳到 5~120。
  cfg.keepMinutes = clampInt(cfg.keepMinutes, DEFAULT_CONFIG.keepMinutes, 5, 120);

  // procIntervalSec：L1b 常驻循环周期，实测代价决定下限 2、上限 60。
  cfg.procIntervalSec = clampInt(cfg.procIntervalSec, DEFAULT_CONFIG.procIntervalSec, 2, 60);
  // procMaxRows：进程榜行数上限，非有限数回落 400（界面上限，别把内存打爆）。
  cfg.procMaxRows = clampInt(cfg.procMaxRows, DEFAULT_CONFIG.procMaxRows, 1, 5000);

  // panelOrder：非有限数回落 12（保证落在内置「插件」项下方）。
  cfg.panelOrder = Number.isFinite(Number(cfg.panelOrder)) ? Math.trunc(Number(cfg.panelOrder)) : DEFAULT_CONFIG.panelOrder;

  // sources：源分层是封闭集合，只认 SOURCE_KEYS 四键，脏键丢弃而不是照收。
  const src = cfg.sources && typeof cfg.sources === 'object' ? cfg.sources : {};
  cfg.sources = SOURCE_KEYS.reduce((acc, k) => {
    acc[k] = k in src ? Boolean(src[k]) : Boolean(DEFAULT_CONFIG.sources[k]);
    return acc;
  }, {});

  // searchPort / keepDays / 其它字符串键：端口钳 1~65535，字符串键原样带过（schema 在写库时再校验）。
  cfg.searchPort = clampInt(cfg.searchPort, DEFAULT_CONFIG.searchPort, 1, 65535);
  cfg.keepDays = clampInt(cfg.keepDays, DEFAULT_CONFIG.keepDays, 7, 365);
  if (typeof cfg.esPath !== 'string') cfg.esPath = DEFAULT_CONFIG.esPath;
  if (typeof cfg.quarantineDir !== 'string') cfg.quarantineDir = DEFAULT_CONFIG.quarantineDir;
  if (!Array.isArray(cfg.walkDirs)) cfg.walkDirs = [];

  return cfg;
}

/**
 * 把"扁平的 DEFAULT_CONFIG"与"库里读出的 prefs 记录（嵌套形）"合并成运行时视图。
 *
 * 各 service 的 getPrefs 是同步调用，而 prefStore.readAll() 是异步 —— 所以视图在 apply 里
 * 维护成一份同步可读的对象，写偏好后立刻重读刷新它。默认值先从 DEFAULT_CONFIG 落成 prefs 形状，
 * 再按组浅合并库里存的值（库里 null 表示从未写入，用默认）。
 */
function mergePrefs(cfg, stored) {
  const base = {
    collect: { cadence: cfg.cadence, keepMinutes: cfg.keepMinutes },
    sources: { l0: cfg.sources.l0, l1a: cfg.sources.l1a, l1b: cfg.sources.l1b, l2: Boolean(cfg.sources.l2) },
    alerts: {},
    search: { port: cfg.searchPort, esPath: cfg.esPath, walkDirs: cfg.walkDirs },
    clean: { quarantineDir: cfg.quarantineDir || undefined, keepDays: cfg.keepDays, after: cfg.after },
  };
  if (!stored || typeof stored !== 'object') return base;
  return {
    collect: { ...base.collect, ...(stored.collect ?? {}) },
    sources: { ...base.sources, ...(stored.sources ?? {}) },
    alerts: { ...(stored.alerts ?? {}) },
    search: { ...base.search, ...(stored.search ?? {}) },
    clean: { ...base.clean, ...(stored.clean ?? {}) },
  };
}

/** 设置页红线 notice 的四条来源（BRANCH_IDS 子集）；文案与 guard 的裁决一一对应。 */
const REDLINE_IDS = ['b-system-dir', 'b-recycle-bin', 'b-program-files', 'b-registry'];
const REDLINE_TEXT = {
  'b-system-dir': '系统目录（Windows / System32 等）只读，永不清理或删除',
  'b-recycle-bin': '回收站不碰：既不清空、也不还原，删除项一律走用户显式勾选',
  'b-program-files': 'Program Files / Program Files (x86) 受保护，只读不删',
  'b-registry': '注册表只读探测，绝不写入、绝不代装软件',
};

/** 模块级最近一次装配的运行时快照，仅测试可观测性用（见 __peek）。 */
let lastRuntime = null;

/**
 * 测试钩子：读取装配后的运行时诊断（当前只有 timerBackend，取自 collect.snapshot()）。
 * 生产路径不依赖它；hc-6 用它真实证明"无宿主定时器时退到了 setInterval"而不是占位断言。
 */
export function __peek(key) {
  const rt = lastRuntime;
  if (!rt || !key) return undefined;
  if (key === 'timerBackend') {
    try { return rt.collect.snapshot().timerBackend; } catch { return undefined; }
  }
  return undefined;
}

/**
 * 浏览器侧 HTTP 门面：Everything 的 :3417 查询。返回 `{status, body}`，
 * 非 2xx 不抛（probe.js 按 status 分支给出「403 未勾选 HTTP 服务器」这类中文文案）。
 */
async function httpRequest(url, { timeoutMs } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
    const body = await r.text();
    return { status: r.status, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 子进程门面：execFile（非 shell）跑 es.exe，返回 `{stdout}`，失败按原 error 冒（probe/es 侧认 code）。 */
function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 插件入口。
 * @param ctx 宿主 Context（代理对象，未 inject 的属性读了会抛）。
 * @param config profile 为本插件写的 config —— 配置只能从**第二个参数**拿，读 ctx.config 会抛。
 * @returns 生命周期清理器（同步执行）：Cordis 卸载时调，测试也可直接调以取证收口顺序。
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);

  /* ---- 1. 按需注入宿主服务（读属性会抛，必须走 inject）---- */
  let storageFacility;
  let intervalFn = null;
  let webServer;
  ctx.inject(['storageDomain'], (s) => { storageFacility = s.storageDomain; });
  ctx.inject(['timer'], (t) => { if (t.timer && typeof t.timer.interval === 'function') intervalFn = (fn, ms) => t.timer.interval(fn, ms); });
  ctx.inject(['webServer'], (w) => { webServer = w.webServer; });

  /* ---- 2. 能力探测：present 时同步标，缺时标 false 并留中文降级原因 ---- */
  // ⚠️-1 硬约束：getFacility 必须始终返回**同一个** storageFacility 实例。
  // lib/kv-records-base.js 的登记表按 WeakMap<facility, ...> 记账、refs 归零才真关域，
  // lib/alerts/store.js 记的也是当初 acquire 的那个 held。宿主每次重取都会让 refs 记账作废 ——
  // 所以下面所有仓储都用同一个 `() => storageFacility`，且 apply 内绝不重新读 ctx 属性、绝不重取。
  const getFacility = () => storageFacility;
  const caps = createCaps({ logger: ctx.logger });
  caps.mark('storageDomain', Boolean(storageFacility), storageFacility ? '' : '宿主未提供 ctx.storageDomain');
  caps.mark('timer', Boolean(intervalFn));
  caps.mark('webServer', Boolean(webServer));
  // notifications / autostart 宿主不提供：保持缺省 false，绝不 mark(true)（见 lib/caps.js NEVER_PROVIDED）。

  /* ---- 3. 偏好视图（同步读）：启动读一次，写后立即重读 ---- */
  const prefStore = createPrefStore({ getFacility, logger: ctx.logger, now: () => Date.now() });
  let view = mergePrefs(resolved, null);

  async function reloadPrefs() {
    try {
      const all = await prefStore.readAll();
      view = mergePrefs(resolved, all?.prefs ?? null);
    } catch (e) {
      // 有设施但域 open 失败（already-open 之类）：只降级、不抛；能力位改回 false 并留痕。
      view = mergePrefs(resolved, null);
      if (storageFacility) {
        ctx.logger?.warn?.(`[sysops] 存储域不可用（${e?.code ?? ''} ${e?.message ?? e}），偏好转只读`);
        caps.mark('storageDomain', false, '存储域 open 失败，配置转只读');
      }
    }
  }
  const getPrefs = () => view;

  /* ---- 4. prefs 收口：写库 → 重读视图 → 把变化推给运行时（落库单点，无回写环）---- */
  async function syncRuntime() {
    try {
      collect.setCadence(view.collect.cadence, { persist: false });
    } catch (e) {
      ctx.logger?.warn?.(`[sysops] 同步采集档位失败：${e?.message ?? e}`);
    }
    for (const k of SOURCE_KEYS) {
      try {
        await collect.setSource(k, Boolean(view.sources[k]), { persist: false });
      } catch (e) {
        ctx.logger?.warn?.(`[sysops] 同步采集源开关 ${k} 失败：${e?.message ?? e}`);
      }
    }
  }
  const prefsFacade = {
    get available() { return prefStore.available; },
    readAll: () => prefStore.readAll(),
    async writeMany(patch) {
      const out = await prefStore.writeMany(patch);
      await reloadPrefs();
      await syncRuntime();
      return out;
    },
    close: () => prefStore.close(),
  };

  /* ---- 5. 五个 store + 规则仓储（ruleStore 要吃裸 prefStore 的 read/write，不能给它收口面）---- */
  const hitStore = createAlertHitStore({ getFacility, logger: ctx.logger });
  const planStore = createPlanStore({ getFacility, logger: ctx.logger, now: () => Date.now() });
  const logStore = createLogStore({ getFacility, logger: ctx.logger, now: () => Date.now() });
  const ruleStore = createRuleStore({ prefStore, logger: ctx.logger });

  /* ---- 6. collect 服务（能力退路：无 intervalFn 时自研 setInterval，dispose 显式清）---- */
  const collect = createCollectService({
    getPrefs,
    logger: ctx.logger,
    now: () => Date.now(),
    getIntervalFn: () => intervalFn,
    makeSupervisor: ({ logger, now }) => createSupervisor({ logger, now }),
    makeL0: ({ osMod, now }) => createL0({ osMod, now }),
    makeL1a: ({ sup, onPoint, logger }) => createL1a({ sup, onPoint, logger }),
    makeL1b: ({ sup, onRows }) => createL1b({ sup, onRows, intervalSec: resolved.procIntervalSec, maxRows: resolved.procMaxRows }),
  });

  /* ---- 7. alerts / search / probe ---- */
  const alerts = createAlertService({ collect, hitStore, getRulePrefs: getPrefs, logger: ctx.logger, now: () => Date.now() });
  const probe = createProbe({ fsMod: fs, requestFn: httpRequest, execFileMod: execFileAsync, getPrefs, now: () => Date.now() });
  const search = createSearchService({
    probe,
    getPrefs,
    adapters: {
      everything: (a) => searchEverything({ ...a, requestFn: httpRequest }),
      es: (a) => searchEs({ ...a, execFileMod: execFileAsync }),
      walk: (a) => walkSearch({ ...a, fsMod: fs, pathMod: path, now: () => Date.now() }),
    },
    logger: ctx.logger,
    now: () => Date.now(),
  });

  /* ---- 8. clean 服务（暂存红线由本服务每次现造，扫描/执行用真实工厂）---- */
  const clean = createCleanService({
    ruleStore,
    makeScanner: (opts) => createScanner(opts),
    makeExecutor: (opts) => createExecutor(opts),
    makeQuarantine: (opts) => createQuarantine(opts),
    planStore,
    logStore,
    getPrefs,
    fsMod: fs,
    osMod: os,
    pathMod: path,
    logger: ctx.logger,
    now: () => Date.now(),
  });

  /* ---- 9. api 门面：collectForApi 保证界面点档位/开关时"service + 落库"两处都动（spec §3.2）---- */
  const collectForApi = {
    ...collect,
    setCadence: async (v) => { collect.setCadence(v); await prefsFacade.writeMany({ prefs: { collect: { cadence: v } } }); },
    setSource: async (k, on) => { await collect.setSource(k, on); await prefsFacade.writeMany({ prefs: { sources: { [k]: on } } }); },
  };
  const apiHandler = createApiHandler({
    collect: collectForApi,
    alerts,
    clean,
    search,
    probe,
    prefStore: prefsFacade,
    ruleStore,
    caps,
    logger: ctx.logger,
    now: () => Date.now(),
  });

  /* ---- 10. 生命周期收口（顺序有讲究）---- */
  function teardown() {
    // 先断推流与常驻子进程，再关存储句柄（关晚了写会撞 CLOSED）。
    try { collect.dispose(); } catch (e) { ctx.logger?.warn?.(`[sysops] 关闭采集服务失败：${e?.message ?? e}`); }
    try { alerts.dispose(); } catch (e) { ctx.logger?.warn?.(`[sysops] 关闭告警服务失败：${e?.message ?? e}`); }
    try { clean.dispose(); } catch (e) { ctx.logger?.warn?.(`[sysops] 关闭清理服务失败：${e?.message ?? e}`); }
    try { apiHandler.dispose?.(); } catch (e) { ctx.logger?.warn?.(`[sysops] 释放接口订阅失败：${e?.message ?? e}`); }
    // 关闭存储句柄：每个 close 都留痕，绝不静默（全局约束 4）。
    for (const s of [prefStore, ruleStore, hitStore, planStore, logStore]) {
      Promise.resolve(s.close?.()).catch((e) => ctx.logger?.warn?.(`[sysops] 关闭存储句柄失败：${e?.message ?? e}`));
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'sysops:lifecycle');
  lastRuntime = { collect, teardown };

  /* ---- 11. 挂上 L0 采集节拍 + 订阅告警 + 启动预读偏好（异步，不阻塞 apply 返回）---- */
  // 这里**不**调 collect.start()（它会立即 l1a.enable() 去 spawn typeperf/powershell 常驻子进程）。
  // 启动期只把 L0 定时器按初始档位挂上（setCadence→armL0），子进程由可见性驱动的 setSource / SSE 首连再拉起。
  // 这样 apply() 在无宿主子进程生命周期管理时也不会派生孤儿采集进程；timerBackend 退路仍如实可观测。
  collect.setCadence(resolved.cadence);
  alerts.start();
  void reloadPrefs();

  /* ---- 12. 只有探到 webServer 才注册路由与推送入口载荷 ---- */
  if (caps.webServer) {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const disposer = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: apiHandler });
        return typeof disposer === 'function' ? disposer : () => {};
      }, 'sysops:route');
    } else {
      webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: apiHandler });
    }
  }

  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: GLOBAL_KEY,
      value: {
        panelId: resolved.panelId,
        label: resolved.label,
        panelOrder: resolved.panelOrder,
        routePrefix: ROUTE_PREFIX,
        api: `${ROUTE_PREFIX}/api`,
        capabilities: caps.read(),
        capabilityRows: caps.rows(),
        cadences: COLLECT_CADENCE,
        sourceKeys: SOURCE_KEYS,
        defaults: {
          procIntervalSec: resolved.procIntervalSec,
          procMaxRows: resolved.procMaxRows,
          keepMinutes: resolved.keepMinutes,
          searchPort: resolved.searchPort,
          // 用户没设过时给空串（prefs schema 拒绝未展开的 %...%，且注入载荷不得含本机私有路径）：
          // 真实暂存根目录由 clean 服务在运行时展开 %LOCALAPPDATA%，界面据此显示"使用内置暂存目录"。
          quarantineDir: view.clean?.quarantineDir ?? resolved.quarantineDir ?? '',
        },
        redlines: REDLINE_IDS.filter((id) => BRANCH_IDS.includes(id)).map((id) => ({ id, text: REDLINE_TEXT[id] })),
        searchAdvice: ADVICE,
        builtAt: Date.now(),
      },
    });
  });

  return teardown;
}
