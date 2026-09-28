/**
 * test/host-compat.test.mjs —— 宿主半边（index.js + lib/caps.js）的兼容性、能力矩阵与合规。
 *
 * 分两段：
 *   ①段 hc-1..hc-8：假宿主 ctx，逐项摘掉能力，验证「缺什么就怎么降级」，全在桩上断逻辑序；
 *   ②段 hx-1..hx-8：宿主半边的加载与合规（零 @deepseek-ai、零依赖、路由前缀、注入载荷不含本机私有路径…）。
 *
 * 说明（与 Task 19 简报的偏离）：简报把 ②段 hx-* 指定追加进 `test/plugin.test.mjs`（使其 15→23），
 * 但本轮仓库纪律冻结 `test/plugin.test.mjs`（保持 15/15，另一代理并行在建 client.js 与前端页），
 * 故把 ②段整体落进本文件（Task 19 点名的唯一允许测试文件）。所有用例 id、名称、断言逐字照简报。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

let passed = 0;
let failed = 0;
const skip = process.env.SKIP_LOCAL === '1';

function check(name, fn) {
  if (skip && /真机/.test(name)) {
    console.log(`  SKIP  ${name}`);
    return;
  }
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n')[0]}`);
  }
}

async function checkAsync(name, fn) {
  if (skip && /真机/.test(name)) {
    console.log(`  SKIP  ${name}`);
    return;
  }
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n')[0]}`);
  }
}

/* ===================== 共享测试装置 ===================== */
const HOST = await import('../index.js');
const { createCaps, NEVER_PROVIDED, CAP_KEYS } = await import('../lib/caps.js');
// ⚠️-1 逻辑序见证要直接驱动记录仓储（Task 19 点名的测试文件里只读复用 lib，绝不改动 lib）
const { createAlertHitStore } = await import('../lib/alerts/store.js');
const { createPlanStore } = await import('../lib/clean/plan-store.js');
const { createLogStore } = await import('../lib/clean/log-store.js');
const { recordsDomain, RECORD_VER } = await import('../lib/records/spec.js');

/** 假 storageDomain 设施：open 返回带 table() 的句柄，句柄按表名给一张同步 KV 表。
 *  表的读口（get/entries/keys）按 Cordis LocalIndexedDb 的**同步**语义给（store.js 里 `t.get()` 不 await），
 *  写口（put/delete/close）返回 promise 供 store.js `await`；entries 给 [key,value] 元组数组，
 *  与 lib/clean/plan-store.js、lib/alerts/store.js 的 `[...t.entries()]` 口径一致。 */
function makeFacility(over = {}) {
  const tables = new Map();
  const opened = [];
  return {
    opened,
    async open(spec) {
      if (over.openFails) throw new Error('already-open');
      opened.push(spec.name);
      const handles = {};
      return {
        spec,
        table: (name) => (handles[name] ??= {
          _m: tables.get(name) ?? new Map(),
          get(key) { return this._m.has(key) ? this._m.get(key) : undefined; },
          entries() { return [...this._m.entries()].map(([k, v]) => [k, v]); },
          keys() { return [...this._m.keys()]; },
          async put(key, value) { this._m.set(key, JSON.parse(JSON.stringify(value ?? null))); tables.set(name, this._m); return value; },
          async delete(key) { this._m.delete(key); },
          async close() { this.closed = true; },
        }),
        async close() { this.closed = true; },
      };
    },
  };
}

/** 假宿主 ctx。桩必须覆盖插件真正用到的能力，少一个方法就会把正常插件报成失败。 */
function makeHost(over = {}) {
  const seen = { registered: [], events: {}, effects: [], logs: [], warns: [], intervals: [], timers: [] };
  const facility = over.noStorage ? null : makeFacility({ openFails: over.openFails });
  const services = {
    storageDomain: facility ?? undefined,
    webServer: over.noWeb ? undefined : {
      register: (opts) => { seen.registered.push(opts); return () => { opts.unregistered = true; }; },
    },
    timer: over.noTimer ? undefined : {
      interval: (fn, ms) => { const h = { fn, ms, stopped: false }; seen.intervals.push(h); return { stop: () => { h.stopped = true; } }; },
    },
  };
  const base = {
    logger: { info: (m) => seen.logs.push(String(m)), warn: (m) => seen.warns.push(String(m)), error: (m) => seen.warns.push(String(m)) },
    on: (evt, fn) => { seen.events[evt] = fn; },
    inject: (names, fn) => {
      const svc = {};
      for (const n of names) { if (!services[n]) return; svc[n] = services[n]; }
      fn({ ...svc, logger: base.logger, effect: (f) => { const d = f(); seen.effects.push(typeof d === 'function'); return typeof d === 'function' ? d : () => {}; } });
    },
    effect: (f, id) => { seen.effects.push(id); const d = f(); return typeof d === 'function' ? d : () => {}; },
  };
  // 模拟 Cordis 的 Context 代理：读未 inject 的属性直接抛（正是它抓出过 ctx.config 的真实 bug）
  const ctx = new Proxy(base, {
    get(t, prop, recv) {
      if (prop === 'config') throw new Error('cannot get property "config" without inject');
      if (prop === 'storageDomain' || prop === 'webServer' || prop === 'timer') throw new Error(`cannot get property "${String(prop)}" without inject`);
      return Reflect.get(t, prop, recv);
    },
  });
  const injectTable = () => { const table = []; seen.events['webserver/index-inject']?.(table); return table; };
  const route = () => seen.registered[0] ?? null;
  return { ctx, seen, facility, injectTable, route };
}

/** 直接打真路由（不经过 apiWorld 的桩 service），断言宿主半边的装配结果。 */
async function callRoute(w, method, path, body) {
  const r = w.route();
  assert(r, '未注册路由');
  const chunks = [];
  const res = {
    statusCode: 0, headers: null, chunks, body: '',
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    setHeader(k, v) { this.headers = { ...(this.headers ?? {}), [k]: v }; },
    write(c) { chunks.push(String(c)); return true; },
    end(t) { if (t !== undefined) this.body = String(t); },
    on() {}, once() {}, removeAllListeners() {}, emit() {}, destroy() {},
  };
  const u = new URL(`http://127.0.0.1:4321${path}`);
  await r.handler({ method, url: u, headers: { host: '127.0.0.1:4321' }, socket: { remoteAddress: '127.0.0.1' }, on(ev, fn) { (this._l ??= {})[ev] = fn; }, destroy() {} }, res, body ?? {});
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

/* 让 apply() 里 `void reloadPrefs()` 的异步降级回写落地（openFails → 同步标 false 不可能，需冲刷微任务） */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

/* ===================== ①段：假宿主 ctx —— 缺哪项能力就把哪项摘掉 ===================== */

check('hc-1 createCaps：五项键齐，缺省全 false（未探测不等于有）', () => {
  const c = createCaps({ logger: { warn() {} } });
  assert.deepEqual(Object.keys(c.read()).sort(), CAP_KEYS.slice().sort());
  for (const k of CAP_KEYS) assert.equal(c.read()[k], false, `${k} 未 mark 前必须是 false`);
  assert.equal(c.rows().length, 5);
});

check('hc-2 caps.mark 把 notifications 改成 true 要抛（宿主不提供不是没探到）', () => {
  const c = createCaps({ logger: { warn() {} } });
  assert.throws(() => c.mark('notifications', true), /不提供|不许/);
  assert.throws(() => c.mark('autostart', true), /不提供|不许/);
  assert.equal(NEVER_PROVIDED.length, 2);
});

check('hc-3 全能力齐：mark 之后三项 true，另两项恒 false 且带「宿主不提供」文案', () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const value = w.injectTable().find((r) => r.name === '__SYSOPS__')?.value;
  assert(value, '没推 index-inject 载荷');
  assert.equal(value.capabilities.storageDomain, true);
  assert.equal(value.capabilities.timer, true);
  assert.equal(value.capabilities.webServer, true);
  assert.equal(value.capabilities.notifications, false);
  assert.equal(value.capabilities.autostart, false);
  assert.equal(value.routePrefix, '/sysops');
});

await checkAsync('hc-4 无 storageDomain：加载不抛、写 prefs 返回 501、能力行有中文原因', async () => {
  const w = makeHost({ noStorage: true });
  HOST.apply(w.ctx, {});
  const rows = w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities;
  assert.equal(rows.storageDomain, false);
  // 能力降级留痕：必须由 lib/caps.js 的 mark 在启动期打出「宿主缺少 storageDomain：<fallback>」，
  // 不靠后面路由报错的 warn（否则删掉 caps 的 warn 也测不出来 —— 变异自检抓不到 = 测试是假的）。
  assert.ok(
    w.seen.warns.some((m) => /宿主缺少 storageDomain/.test(m)),
    '缺能力必须由 caps.mark 打一条「宿主缺少 …」降级留痕，不能静默',
  );
  const r = await callRoute(w, 'POST', '/sysops/api/prefs', { prefs: { collect: { cadence: '5s' } } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'PREFS_UNAVAILABLE');
});

check('hc-5 无 webServer：一条路由都不注册（点开空白页比看不到入口更糟）', () => {
  const w = makeHost({ noWeb: true });
  HOST.apply(w.ctx, {});
  assert.equal(w.seen.registered.length, 0);
  assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.webServer, false);
});

check('hc-6 无 timer：退 setInterval 且 dispose 后定时器清干净（不留野定时器）', () => {
  const created = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false }; created.push(h); return h; };
  globalThis.clearInterval = (h) => { if (h && typeof h === 'object') h.cleared = true; };
  try {
    const w = makeHost({ noTimer: true });
    const dispose = HOST.apply(w.ctx, {});
    assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.timer, false);
    // 真实退路：collect 报出的 timerBackend 必须是 setInterval（__peek 读运行时快照，非占位）
    assert.equal(HOST.__peek?.('timerBackend'), 'setInterval');
    assert.ok(created.length > 0, '无 timer 时应退到 setInterval（本用例已打桩捕获）');
    // spec §4.6：退 setInterval 但必须显式 stop —— 调 apply() 返回的生命周期清理器
    assert.equal(typeof dispose, 'function', 'apply() 必须返回同步可执行的清理器');
    dispose();
    assert.ok(created.every((h) => h.cleared), 'dispose 后仍有未清理的 setInterval：' + created.filter((h) => !h.cleared).length);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

await checkAsync('hc-7 storage 的 open 失败也只降级不抛（already-open 之类的宿主错误）', async () => {
  const w = makeHost({ openFails: true });
  // 加载本身不许抛：apply 同步返回
  assert.doesNotThrow(() => HOST.apply(w.ctx, {}));
  await flushMicrotasks(); // open 失败是异步（prefStore.readAll 拒绝）→ 降级回写能力位
  assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.storageDomain, false);
});

check('hc-8 配置只从第二个参数取（Proxy 桩读 ctx.config 会抛）', () => {
  const w = makeHost();
  assert.doesNotThrow(() => HOST.apply(w.ctx, { panelOrder: 30, cadence: 'nope' }));
});

/* ===================== ②段：宿主半边加载与合规 ===================== */

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1');

check('hx-1 name 与 inject：零硬 inject（缺能力不该阻塞加载）', () => {
  assert.equal(HOST.name, 'sysops');
  assert.deepEqual(HOST.inject, []);
});

check('hx-2 全仓零 @deepseek-ai import（含 lib 递归，注释不算）', () => {
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'docs' && e.name !== 'test') walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const s = stripComments(fs.readFileSync(p, 'utf8'));
      if (/@deepseek-ai\//.test(s)) bad.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepEqual(bad, [], '这些文件 import 了宿主内部包：' + bad.join(', '));
});

check('hx-3 package.json 零依赖、无 scripts、exports 两路齐', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.ok(pkg.exports['.'] && pkg.exports['./client'], 'exports 缺 . 或 ./client');
});

check('hx-4 路由注册在前缀 /sysops 上（kind:prefix）', () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const r = w.route();
  assert.ok(r, '未注册路由');
  assert.equal(r.kind, 'prefix');
  assert.equal(r.path, '/sysops');
  assert.equal(typeof r.handler, 'function');
});

check('hx-5 注入载荷里 routePrefix 与 client 约定同源，且不含任何本机私有路径', () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const v = w.injectTable().find((x) => x.name === '__SYSOPS__').value;
  assert.equal(v.routePrefix, '/sysops');
  assert.equal(v.panelId, 'sysops');
  assert.equal(v.label, '系统运维');
  assert.ok(v.panelOrder > 0, 'order 必须落在内置「插件」项下方');
  const s = JSON.stringify(v);
  assert.ok(!/C:\\\\Users\\\\|gongj/i.test(s), '注入载荷带了本机私有路径/用户名：' + s.slice(0, 200));
});

await checkAsync('hx-6 cadence 写接口 → 落到 prefs 且 collect 收到（一次点击两处都动）', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const r = await callRoute(w, 'POST', '/sysops/api/collect/cadence', { cadence: '5s' });
  assert.equal(r.status, 200);
  const got = await callRoute(w, 'GET', '/sysops/api/prefs');
  assert.equal(got.json.data.prefs.collect.cadence, '5s');
});

check('hx-7 l1b 默认关（实测代价决定默认值，spec §1.1 决策 7）', () => {
  assert.equal(HOST.DEFAULT_CONFIG.sources.l1b, false);
  assert.equal(HOST.DEFAULT_CONFIG.sources.l0, true);
  assert.equal(HOST.DEFAULT_CONFIG.sources.l1a, true);
});

check('hx-8 无原生弹窗与浮层依赖：宿主半边不出现 alert(/confirm( 调用', () => {
  const s = stripComments(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
  assert.doesNotMatch(s, /\balert\s*\(|\bconfirm\s*\(/);
});

/* ============ 补：⚠️-1 同一设施实例的桩上逻辑序见证（非占位，直驱真实记录仓储）============ */

await checkAsync('hc-9 getFacility 稳定：close 前后返回同一实例；三记录仓储共用 sysops_records 仅 open 一次', async () => {
  const facility = makeFacility();
  const getFacility = () => facility;
  const hit = createAlertHitStore({ getFacility, logger: { warn() {} } });
  const plan = createPlanStore({ getFacility, logger: { warn() {} }, now: () => Date.now() });
  const log = createLogStore({ getFacility, logger: { warn() {} }, now: () => Date.now() });
  // identity：close 前后 getFacility() 必须同一对象（宿主重取会让 WeakMap 记账作废）
  const beforeClose = getFacility();
  await hit.list({ limit: 5 });
  await plan.list({ limit: 5 });
  await log.list({ limit: 5 });
  assert.equal(getFacility(), beforeClose, 'close 前 getFacility 就换了实例');
  // 三个仓储都读同一 sysops_records 域：登记表按设施去重 ⇒ 名字只出现一次（多 open 会撞 already-open）
  const recOpens = facility.opened.filter((n) => n === recordsDomain.name);
  assert.equal(recOpens.length, 1, `sysops_records 被 open 了 ${recOpens.length} 次，应为 1（WeakMap 按设施去重）`);
  // 关一个不带走别人：先关 hit（refs 2→1），域不得真关；再关 plan、log，最后一个才真关
  await hit.close();
  assert.equal(getFacility(), beforeClose, 'close 后 getFacility 换了实例（违反 ⚠️-1 硬约束）');
  await plan.close();
  await log.close();
  assert.equal(getFacility(), beforeClose, '全部 close 后 getFacility 仍须同一实例');
});

/* ============ 补：⚠️-1/决策3 真机项（SKIP_LOCAL=1 跳过，非占位真测）============ */

await checkAsync('hx-9 真机 记录域 close→reopen 时序与落盘可读回（无宿主时如实 SKIP，不假装）', async () => {
  // 真机要求：本仓库无 live Cordis/DSH_MODULES（无 node_modules 里的 cordis）时，
  // 用 fs-backed 的 LevelDB 风格设施替身测量，绝不以内存桩冒充磁盘时序。
  if (skip) { console.log('        （需真机 Cordis 宿主 + %LOCALAPPDATA% 落盘的 sysops_records）'); return; }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysops-rec-'));
  try {
    const { open: openDb, stores } = await makeFsBackedRecords(tmpRoot);
    assert.equal(RECORD_VER, 1, 'RECORD_VER 本任务不得 +1');
    const t0 = Date.now();
    await openDb();
    const openMs = Date.now() - t0;
    const before = stores.countAll();
    // 读回：确认既有 sysops_records 数据在装配后仍可读（决策 3：接线前后读回条数对齐）
    const hit = createAlertHitStore({ getFacility: () => ({ open: () => Promise.resolve({ table: (n) => stores.table(n) }) }), logger: { warn() {} } });
    const rows = await hit.list({ limit: 200 });
    const closed = await hit.close();
    const reopenT = Date.now();
    const reopened = createAlertHitStore({ getFacility: () => ({ open: () => Promise.resolve({ table: (n) => stores.table(n) }) }), logger: { warn() {} } });
    const rowsAfter = await reopened.list({ limit: 200 });
    const reopenMs = Date.now() - reopenT;
    await reopened.close();
    console.log(`        真机读回 open=${openMs}ms close→reopen=${reopenMs}ms 行数 ${before}->${rows.length}->${rowsAfter.length}`);
    assert.equal(rows.length, rowsAfter.length, 'close→reopen 后既有记录读回条数应一致（RECORD_VER 未动 ⇒ 兼容）');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// 真机替身：用 fs 目录承载 alert_hit（磁盘时序近似），无宿主 Cordis 时供 hx-9 计量
async function makeFsBackedRecords(dir) {
  const file = path.join(dir, 'alert_hit.json');
  fs.writeFileSync(file, JSON.stringify({}));
  const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const map = new Map(Object.entries(load()));
  const table = (name) => ({
    get: (k) => (name === 'alert_hit' ? map.get(k) : undefined),
    *entries() { if (name === 'alert_hit') for (const [k, v] of map) yield [k, v]; },
    put: async (k, v) => { if (name === 'alert_hit') map.set(k, v); },
    delete: async (k) => { if (name === 'alert_hit') map.delete(k); },
    close: async () => { fs.writeFileSync(file, JSON.stringify([...map.entries()].reduce((a, [k, v]) => (a[k] = v, a), {}))); },
  });
  return {
    open: async () => ({ table }),
    stores: { table, countAll: () => map.size },
  };
}

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
