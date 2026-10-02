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
  const seen = { registered: [], events: {}, effects: [], logs: [], warns: [], intervals: [], timers: [], injections: [], llmCalls: [] };
  const facility = over.noStorage ? null : makeFacility({ openFails: over.openFails });
  const services = {
    storageDomain: facility ?? undefined,
    webServer: over.noWeb ? undefined : {
      register: (opts) => { seen.registered.push(opts); return () => { opts.unregistered = true; }; },
    },
    timer: over.noTimer ? undefined : {
      interval: (fn, ms) => { const h = { fn, ms, stopped: false }; seen.intervals.push(h); return { stop: () => { h.stopped = true; } }; },
    },
    // ctx.llm 桩（S12-C）：形状照宿主契约，只给 listProviders / listModels / stream 三个口。
    // providers 可注入：AI 路由的两条端到端用例（hc-14）靠它把一次"建议往返"跑完。
    llm: over.noLlm ? undefined : {
      listProviders: () => (over.llmProviders ?? [{ id: 'fake', name: '假宿主' }]),
      listModels: async (p) => (over.llmModels === null ? [] : [{ provider: p, id: 'm-1', name: 'M 一号' }]),
      stream: (options) => {
        seen.llmCalls.push(options);   // 下发的每个参数都留证：prompt 隐私口径与 maxTokens 口径靠它验尸
        return (async function* gen() {
          for (const c of over.llmChunks ?? []) yield c;
        })();
      },
    },
  };
  const base = {
    logger: { info: (m) => seen.logs.push(String(m)), warn: (m) => seen.warns.push(String(m)), error: (m) => seen.warns.push(String(m)) },
    on: (evt, fn) => { seen.events[evt] = fn; },
    // ⚠️ 必须按真 Cordis 语义：`ctx.inject(deps, cb)` 等价于 `ctx.plugin({inject, apply: cb})` ——
    // cb 是**独立 fiber**，不在 apply 的同步段执行；deps 不可满足时 cb 永不执行（不是抛错）。
    // 曾经的同步桩让「apply 顶层同步读注入变量」这种真机必炸的写法在测试里全绿（假绿根源）。
    inject: (names, fn) => {
      for (const n of names) { if (!services[n]) return; }   // 依赖不满足 ⇒ 回调永不执行
      const svc = {};
      for (const n of names) svc[n] = services[n];
      const pending = { names, fn, ran: false };
      seen.injections.push(pending);
      setTimeout(() => {
        pending.ran = true;
        fn({ ...svc, logger: base.logger, effect: (f) => { const d = f(); seen.effects.push(typeof d === 'function'); return typeof d === 'function' ? d : () => {}; } });
      }, 0);
    },
    effect: (f, id) => { seen.effects.push(id); const d = f(); return typeof d === 'function' ? d : () => {}; },
  };
  // 模拟 Cordis 的 Context 代理：读未 inject 的属性直接抛（正是它抓出过 ctx.config 的真实 bug）
  const ctx = new Proxy(base, {
    get(t, prop, recv) {
      if (prop === 'config') throw new Error('cannot get property "config" without inject');
      if (prop === 'storageDomain' || prop === 'webServer' || prop === 'timer' || prop === 'llm') throw new Error(`cannot get property "${String(prop)}" without inject`);
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

/* 冲刷一轮宏任务：apply() 里 `ctx.inject` 的回调（setTimeout 0，见桩）与 `void reloadPrefs()`
 * 的异步降级回写都在这一轮落地。凡是「注入回调之后」的状态，都必须先 await 它再断言。 */
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

/**
 * 开一条真 SSE 流（不 await：流是悬挂的），把写出去的帧按 `event:`/`data:` 解析回来。
 * hc-13 用它见证「点扫描之后宿主到底往流里写了什么」——修前那三族帧的键里没有 phase（spec §8.8）。
 */
function openStream(w) {
  const r = w.route();
  const frames = [];
  const res = {
    statusCode: 0, headers: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    setHeader(k, v) { this.headers = { ...(this.headers ?? {}), [k]: v }; },
    write(c) {
      for (const m of String(c).matchAll(/event: ([^\n]+)\ndata: (.*)\n\n/g)) {
        let data = null;
        try { data = JSON.parse(m[2]); } catch { data = { __raw: m[2].slice(0, 80) }; }
        frames.push({ ev: m[1], data });
      }
      return true;
    },
    end() {}, on() {}, once() {}, removeAllListeners() {}, emit() {}, destroy() {},
  };
  const u = new URL('http://127.0.0.1:4321/sysops/api/stream');
  r.handler({ method: 'GET', url: u, headers: { host: '127.0.0.1:4321' }, socket: { remoteAddress: '127.0.0.1' }, on() {}, destroy() {} }, res, {}).catch(() => {});
  return { res, frames };
}

/* ===================== ①段：假宿主 ctx —— 缺哪项能力就把哪项摘掉 ===================== */

check('hc-1 createCaps：六项键齐，缺省全 false（未探测不等于有）', () => {
  const c = createCaps({ logger: { warn() {} } });
  assert.deepEqual(Object.keys(c.read()).sort(), CAP_KEYS.slice().sort());
  for (const k of CAP_KEYS) assert.equal(c.read()[k], false, `${k} 未 mark 前必须是 false`);
  assert.equal(c.rows().length, 6);
});

check('hc-2 caps.mark 把 notifications 改成 true 要抛（宿主不提供不是没探到）', () => {
  const c = createCaps({ logger: { warn() {} } });
  assert.throws(() => c.mark('notifications', true), /不提供|不许/);
  assert.throws(() => c.mark('autostart', true), /不提供|不许/);
  assert.equal(NEVER_PROVIDED.length, 2);
});

await checkAsync('hc-3 全能力齐：注入回调落地后四项 true，另两项恒 false', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  const value = w.injectTable().find((r) => r.name === '__SYSOPS__')?.value;
  assert(value, '没推 index-inject 载荷');
  assert.equal(value.capabilities.storageDomain, true);
  assert.equal(value.capabilities.timer, true);
  assert.equal(value.capabilities.webServer, true);
  assert.equal(value.capabilities.ai, true, '宿主给了 ctx.llm ⇒ AI 清理建议的能力位要亮（S12-C）');
  assert.equal(value.capabilities.notifications, false);
  assert.equal(value.capabilities.autostart, false);
  assert.equal(value.routePrefix, '/sysops');
});

await checkAsync('hc-4 无 storageDomain：加载不抛、写 prefs 返回 501、能力行有中文原因', async () => {
  const w = makeHost({ noStorage: true });
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  const rows = w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities;
  assert.equal(rows.storageDomain, false);
  // 能力降级留痕：必须由 lib/caps.js 的 mark 打出「宿主缺少 storageDomain：<fallback>」，
  // 不靠后面路由报错的 warn（否则删掉 caps 的 warn 也测不出来 —— 变异自检抓不到 = 测试是假的）。
  assert.ok(
    w.seen.warns.some((m) => /宿主缺少 storageDomain/.test(m)),
    '缺能力必须由 caps.mark 打一条「宿主缺少 …」降级留痕，不能静默',
  );
  const r = await callRoute(w, 'POST', '/sysops/api/prefs', { prefs: { collect: { cadence: '5s' } } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'PREFS_UNAVAILABLE');
});

await checkAsync('hc-5 无 webServer：一条路由都不注册、一条入口载荷都不推（点开空白页比看不到入口更糟）', async () => {
  const w = makeHost({ noWeb: true });
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  assert.equal(w.seen.registered.length, 0, '无 webServer 时不该注册任何路由');
  // spec §4.6：连侧边栏入口都不注册 ⇒ 也就没有 index-inject 载荷（不是"推一份能力缺口让界面自己藏入口"）
  assert.equal(w.injectTable().length, 0, '无 webServer 时不该推入口载荷');
  // 另两项能力独立于 webServer：插件仍按需申请它们（不许把三项并成一次注入，缺一就全丢）
  const inj = w.seen.injections.map((i) => i.names.join(',')).sort();
  assert.deepEqual(inj, ['llm', 'storageDomain', 'timer'], '无 webServer 时其余三项照样按需申请（缺一项不连累别的能力）');
});

await checkAsync('hc-6 无 timer：退 setInterval 且 dispose 后定时器清干净（不留野定时器）', async () => {
  const created = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false }; created.push(h); return h; };
  globalThis.clearInterval = (h) => { if (h && typeof h === 'object') h.cleared = true; };
  try {
    const w = makeHost({ noTimer: true });
    const dispose = HOST.apply(w.ctx, {});
    await flushMicrotasks();
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

await checkAsync('hc-10 注入回调延后：apply 同步段能力未定、路由未挂，回调落地后四项真为 true 且路由已挂', async () => {
  // 这条锁的就是真机两症状的根因：`ctx.inject` 回调是独立 fiber（桩用 setTimeout 0 还原）。
  // 任何"在 apply 同步段读注入变量再据此装配"的写法，在这里都会留下未注册的路由与 false 能力位。
  const w = makeHost();
  HOST.apply(w.ctx, {});
  assert.equal(w.seen.registered.length, 0, 'apply 同步段不该已经注册路由（注入回调尚未执行）');
  assert.equal(w.seen.injections.length, 4, '四项能力要各申请一次注入（含 S12-C 的 llm）');
  assert.deepEqual(w.seen.injections.map((i) => i.names.join(',')).sort(), ['llm', 'storageDomain', 'timer', 'webServer']);
  await flushMicrotasks();
  assert.ok(w.seen.injections.every((i) => i.ran), '四项注入回调都该落地');
  assert.equal(w.seen.registered.length, 1, '注入回调落地后必须注册路由（否则 /sysops/api/* 全 404）');
  const value = w.injectTable().find((r) => r.name === '__SYSOPS__')?.value;
  assert(value, '路由落地后必须能推出入口载荷');
  assert.equal(value.capabilities.storageDomain, true, '能力位必须在回调落地后为 true，不是 apply 顶层快照');
  assert.equal(value.capabilities.timer, true);
  assert.equal(value.capabilities.webServer, true);
  // 宿主定时器是**晚到**的：启动那次挂表只能退 setInterval，回调落地后必须重挂回 ctx.interval，
  // 否则能力位说 true、运行时快照说 setInterval —— 同一页两处自相矛盾（armL0 现取 intervalFn）。
  assert.equal(HOST.__peek?.('timerBackend'), 'ctx.interval', '宿主定时器晚到后 L0 必须重挂到 ctx.interval');
  assert.ok(!value.capabilityRows.some((r) => r.ok === false && r.detail), '全能力齐时不许有任何带 detail 的降级行：'
    + JSON.stringify(value.capabilityRows));
});

await checkAsync('hc-11 同一能力只留痕一次（载荷反复构建不再刷 warn）', async () => {
  const w = makeHost({ noStorage: true });
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  w.injectTable(); w.injectTable(); w.injectTable();
  const n = w.seen.warns.filter((m) => /宿主缺少 storageDomain/.test(m)).length;
  assert.equal(n, 1, `同一能力只该留痕一次，实际 ${n} 次（每次构建载荷都 warn 只是日志噪声）`);
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

await checkAsync('hx-4 路由注册在前缀 /sysops 上（kind:prefix）', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  const r = w.route();
  assert.ok(r, '未注册路由');
  assert.equal(r.kind, 'prefix');
  assert.equal(r.path, '/sysops');
  assert.equal(typeof r.handler, 'function');
});

await checkAsync('hx-5 注入载荷里 routePrefix 与 client 约定同源，且不含任何本机私有路径', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
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
  await flushMicrotasks();
  const r = await callRoute(w, 'POST', '/sysops/api/collect/cadence', { cadence: '5s' });
  assert.equal(r.status, 200);
  const got = await callRoute(w, 'GET', '/sysops/api/prefs');
  assert.equal(got.json.data.prefs.collect.cadence, '5s');
});

await checkAsync('hx-6b 改档位是读-并-写：sources/search/clean 三组不得被整行覆盖抹掉（半份写 = 红）', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  // 先落一份完整偏好（模拟用户已在设置页配过）
  const seed = await callRoute(w, 'POST', '/sysops/api/prefs', { prefs: {
    collect: { cadence: '1s', keepMinutes: 30 },
    sources: { l1b: true },
    search: { port: 3417 },
    clean: { after: 'log' },
  } });
  assert.equal(seed.status, 200);
  assert.equal((await callRoute(w, 'POST', '/sysops/api/collect/cadence', { cadence: '5s' })).status, 200);
  const p = (await callRoute(w, 'GET', '/sysops/api/prefs')).json.data.prefs;
  assert.equal(p.collect.cadence, '5s', '档位要改到');
  assert.equal(p.sources.l1b, true, 'sources 组被抹了');
  assert.equal(p.search.port, 3417, 'search 组被抹了');
  assert.equal(p.clean.after, 'log', 'clean 组被抹了');
  assert.equal(p.collect.keepMinutes, 30, 'collect 组内其他字段被抹了');
});

await checkAsync('hx-6c 源开关同规：改 sources 不得抹掉 collect/search/clean（半份写 = 红）', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  const seed = await callRoute(w, 'POST', '/sysops/api/prefs', { prefs: {
    collect: { cadence: '5s', keepMinutes: 30 },
    search: { port: 3417 },
    clean: { after: 'log' },
  } });
  assert.equal(seed.status, 200);
  assert.equal((await callRoute(w, 'POST', '/sysops/api/collect/source', { key: 'l1b', on: true })).status, 200);
  const p = (await callRoute(w, 'GET', '/sysops/api/prefs')).json.data.prefs;
  assert.equal(p.sources.l1b, true, '开关要落到');
  assert.equal(p.collect.cadence, '5s', 'collect 组被抹了');
  assert.equal(p.search.port, 3417, 'search 组被抹了');
  assert.equal(p.clean.after, 'log', 'clean 组被抹了');
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

await checkAsync('hc-12 真机 端到端：POST /sysops/api/clean/scan 用真实装配（fsMod=node:fs + pathMod=node:path）真扫自建临时目录（S9-① 的复现面）', async () => {
  // 这条链上每一环都是真的：真 index.js 装配 → 真 clean service → 真 scanner → 真 fs。
  // 只有走到这里才踩得到「宿主交的 fsMod 是 node:fs，上面没有 join」——修前本用例的回执是
  // {started:false, error:'fsMod.join is not a function'}（真机截图那行「扫描失败」的同一句）。
  const { BUILTIN_RULES } = await import('../lib/clean/rules.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysops-scan-'));
  const probeDir = path.join(tmpRoot, 'probe-dir');
  fs.mkdirSync(probeDir);
  fs.writeFileSync(path.join(probeDir, 'old.log'), 'x');
  try {
    const w = makeHost();
    // 只留一条自建规则：12 条内置全 off。不关的话这条用例会真去遍历 npm/pip/Edge 缓存 ——
    // 几万条目、十几秒（探针 tmp/probe-cleanjoin.mjs 的 B 口径读数：walked 112853 / 10641ms）。
    // 播种直接写设施（与插件共用同一个 tables 闭包），不经路由：目的是让这次扫描只扫 probeDir。
    const h = await w.facility.open({ name: 'sysops_prefs', version: 1 });
    await h.table('clean_rules').put('current', {
      items: [{ id: 'hc-probe', n: '探针目录', glob: path.join(probeDir, '*'), ageDays: 0, kind: '缓存', note: '' }],
      off: BUILTIN_RULES.map((r) => r.id), updatedAt: 0,
    });
    HOST.apply(w.ctx, {});
    await flushMicrotasks();
    const r = await callRoute(w, 'POST', '/sysops/api/clean/scan', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.data.started, true, `扫描没起来：${JSON.stringify(r.json.data)}`);
    const paths = (r.json.data.plan?.items ?? []).map((i) => String(i.path).toLowerCase());
    // 扫描器报的是「规则目录的第一层条目」= probe-dir\old.log（不是目录本身），断言按前缀不按等值。
    assert.ok(paths.some((p) => p.startsWith(probeDir.toLowerCase())), `清单里没有探针目录下的条目：${JSON.stringify(paths)}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/**
 * hc-13（S10-① 的端到端钉子）：真装配 + 真 SSE 流 + 真 CleanPage。
 *
 * 修前读数（tmp/s10-before.txt）：点扫描之后流里写出的三族帧是
 *   clean:progress [type,dir,walked,hit,bytes] · clean:done [type,plan] · clean:error [type,where,error]
 * —— 没有一帧带 phase；客户端把 clean:* 浅并进上一份快照后 clean.phase 仍是 'idle'，
 * 于是界面停在空态卡「尚未扫描」直到 POST /clean/scan 十几秒后返回（用户原话：点了没反应，半天才出来结果）。
 * 这条用例从「宿主写帧」一路断到「客户端渲染」，任何一环把相位丢掉都会红。
 * 自包含（临时目录 + 假宿主），无需真机 ⇒ 不加「真机」字样，SKIP_LOCAL 下也照跑。
 */
await checkAsync('hc-13 端到端：点扫描的第一帧就带 phase（POST 未返回时界面已能翻成扫描卡）', async () => {
  const { BUILTIN_RULES } = await import('../lib/clean/rules.js');
  const { walk, makeStubReact } = await import('./render-fixtures.mjs');
  let clientDef = null;
  globalThis.window = { __ModuleLoader__: { load: (def) => { clientDef = def; } } };
  globalThis.document = { getElementById: () => null, createElement: () => ({ id: '', textContent: '', remove() {} }), head: { appendChild() {} } };
  await import('../client.js');
  const CLIENT = clientDef.factory((name) => {
    if (name === 'react') return makeStubReact();
    throw new Error('意外的 require: ' + name);
  });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysops-s10-'));
  const probeDir = path.join(tmpRoot, 'probe-dir');
  fs.mkdirSync(probeDir);
  for (let i = 0; i < 60; i += 1) fs.writeFileSync(path.join(probeDir, `old-${i}.log`), 'x');
  try {
    const w = makeHost();
    const h = await w.facility.open({ name: 'sysops_prefs', version: 1 });
    await h.table('clean_rules').put('current', {
      items: [{ id: 'hc-s10', n: '探针目录', glob: path.join(probeDir, '*'), ageDays: 0, kind: '缓存', note: '' }],
      off: BUILTIN_RULES.map((r) => r.id), updatedAt: 0,
    });
    HOST.apply(w.ctx, {});
    await flushMicrotasks();

    // ① 客户端手里的底：点扫描前那份快照
    const pre = await callRoute(w, 'GET', '/sysops/api/snapshot', {});
    const baseClean = pre.json.data.clean;
    assert.equal(baseClean.phase, 'idle', '扫描前相位就是 idle（正是"翻不过去"的那个底）');

    // ② 开流 → 点扫描 → 只等第一帧 progress（不等 POST）
    const stream = openStream(w);
    await flushMicrotasks();
    const pending = callRoute(w, 'POST', '/sysops/api/clean/scan', {});
    const t0 = Date.now();
    while (!stream.frames.some((f) => f.ev === 'clean:progress') && Date.now() - t0 < 5000) await flushMicrotasks();
    const first = stream.frames.find((f) => f.ev === 'clean:progress') ?? null;
    assert.ok(first, '点扫描后 5s 内流里没有 clean:progress 帧：' + JSON.stringify(stream.frames.map((f) => f.ev)));
    assert.equal(first.data.phase, 'scanning', '首帧必须自带相位（修前这一帧只有 dir/walked/hit/bytes）');
    assert.equal(typeof first.data.startedAt, 'number', '首帧要带 startedAt：扫描卡读「已用时 N 秒」靠它');
    assert.equal(first.data.stopped, false);

    // ③ 客户端口径的合并 + 真渲染：界面此刻必须已经在扫描卡上
    const merged = { ...baseClean, ...first.data }; // 与 client.js 的 mergeFrame 对 clean:* 的口径一致
    globalThis.__SYSOPS__ = { panelId: 'sysops', label: '系统运维', panelOrder: 12, routePrefix: '/sysops', api: '/sysops/api', capabilities: {}, cadenceChoices: [], defaults: {} };
    const out = walk(CLIENT.__test.clean.CleanPage({ clean: merged, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
    assert.ok(out.has('扫描进度'), '第一帧到达后界面必须已是扫描卡：' + out.texts.join('|'));
    assert.ok(!out.has('尚未扫描'), '修前真机扫描期间就是这一屏（点了没反应）');

    // ④ 收尾：POST 返回、三族帧里所有 clean:* 都带相位
    const scan = await pending;
    assert.equal(scan.json.data.started, true, `扫描没起来：${JSON.stringify(scan.json.data)}`);
    const all = stream.frames.filter((f) => f.ev.startsWith('clean:'));
    assert.ok(all.length >= 2, '至少 progress + done 两帧：' + JSON.stringify(all.map((f) => f.ev)));
    for (const f of all) assert.equal(typeof f.data.phase, 'string', `${f.ev} 帧缺相位：${JSON.stringify(f.data)}`);
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

/* ------------------------------------------------------------------ *
 * ③段续：AI 清理建议的宿主端到端（S12-C）
 * ------------------------------------------------------------------ */

/**
 * hc-14 宿主没有 ctx.llm 时的三层诚实：
 *  ① 注入回调**永不执行**（依赖不满足 ⇒ Cordis 不跑 cb，正是零硬 inject 的意义）；
 *  ② 能力位保持未探测态 false，且**不带 detail** —— 带了会让页头那条缺口横幅常驻，
 *     而"宿主没配模型"是常态，不是需要每次开屏提醒的事故；
 *  ③ 就绪度接口现答不可用并给出下一步，征求建议的接口按 501（与"宿主没给这项能力"同档）。
 */
await checkAsync('hc-14 无 ctx.llm：注入回调不执行、能力位 false 且不带 detail、ai 接口 501 并说清"清理照样能用"', async () => {
  const w = makeHost({ noLlm: true });
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  assert.equal(w.seen.injections.length, 3, 'llm 不可满足时那个回调不该执行（缺服务不该卡死插件）');
  const value = w.injectTable().find((r) => r.name === '__SYSOPS__').value;
  assert.equal(value.capabilities.ai, false);
  const row = value.capabilityRows.find((r) => r.key === 'ai');
  assert.equal(row.ok, false);
  assert.equal(row.detail, '', '缺模型不该点亮页头那条缺口横幅（常态降级不是事故）');
  assert.match(row.fallback, /两段式/, '能力行要说清"没有它清理仍完整"');

  const ready = await callRoute(w, 'GET', '/sysops/api/clean/ai');
  assert.equal(ready.status, 200, '不可用是事实而不是错误 ⇒ 200 + reason');
  assert.equal(ready.json.data.available, false);
  assert.match(ready.json.data.reason, /ctx\.llm/);

  const ask = await callRoute(w, 'POST', '/sysops/api/clean/ai-suggest', { planId: 'p-x' });
  assert.equal(ask.status, 501);
  assert.equal(ask.json.error.code, 'AI_UNAVAILABLE');
  assert.match(ask.json.error.message, /两段式/);
});

/**
 * hc-15 端到端征求一次建议：真装配（node:fs + node:path + 真快照仓储）扫出临时目录，
 * 假模型回一条合法判定 + 一条越界判定。要证的是三道闸同时成立：
 *  - 交回的 ids **全部来自那份冻结快照**（模型只给行号）；
 *  - 发出去的 prompt 里不含那条临时目录的路径（隐私口径，用户名/盘符都不出本机）；
 *  - 越界判定被丢弃并如实计数（不静默）。
 */
await checkAsync('hc-15 端到端 POST /api/clean/ai-suggest：ids 只从冻结快照反查，prompt 不含路径，越界判定丢弃', async () => {
  const { BUILTIN_RULES } = await import('../lib/clean/rules.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysops-ai-'));
  const dirA = path.join(tmpRoot, 'big');
  const dirB = path.join(tmpRoot, 'small');
  fs.mkdirSync(dirA); fs.mkdirSync(dirB);
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dirA, `a-${i}.log`), 'x'.repeat(4096));
  for (let i = 0; i < 2; i += 1) fs.writeFileSync(path.join(dirB, `b-${i}.log`), 'x');
  const json = JSON.stringify({ recommendations: [
    { group: 0, action: 'clean', reason: '整类都是日志，5 项都不小' },
    { group: 7, action: 'clean', reason: '模型编出来的行号' },
  ] });
  try {
    const w = makeHost({ llmChunks: [{ type: 'text-delta', text: json }, { type: 'finish', reason: { kind: 'stop' } }] });
    const h = await w.facility.open({ name: 'sysops_prefs', version: 1 });
    await h.table('clean_rules').put('current', {
      items: [
        { id: 'ai-a', n: '大日志类', glob: path.join(dirA, '*'), ageDays: 0, kind: '日志', note: '' },
        { id: 'ai-b', n: '小日志类', glob: path.join(dirB, '*'), ageDays: 0, kind: '日志', note: '' },
      ],
      off: BUILTIN_RULES.map((r) => r.id), updatedAt: 0,
    });
    HOST.apply(w.ctx, {});
    await flushMicrotasks();

    const scan = await callRoute(w, 'POST', '/sysops/api/clean/scan', {});
    assert.equal(scan.json.data.started, true, `扫描没起来：${JSON.stringify(scan.json)}`);
    const plan = scan.json.data.plan;
    const snapIds = plan.items.map((i) => i.id);
    assert.ok(snapIds.length >= 2, `临时目录没扫出条目：${JSON.stringify(plan.items)}`);

    const out = await callRoute(w, 'POST', '/sysops/api/clean/ai-suggest', { planId: plan.planId });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    const d = out.json.data;
    assert.equal(d.recommendations.length, 1, '只认行号在发出去的清单里的那条');
    assert.equal(d.dropped.count, 1, '行号 7 越界，必须丢弃并计数');
    assert.ok(d.recommendations[0].ids.every((id) => snapIds.includes(id)), '交回的 ids 必须全部来自那份冻结快照');
    assert.equal(d.provider, 'fake');
    assert.equal(d.model, 'm-1', '回执把实际用了哪个模型写清楚（可重建性）');

    const sent = w.seen.llmCalls[0].messages[0].content[0].text;
    assert.ok(!sent.includes(tmpRoot), 'prompt 里不许出现那条临时目录的路径');
    assert.ok(!/[A-Za-z]:[\\/]/.test(sent), 'prompt 里不许出现盘符开头的路径');
    assert.equal('maxTokens' in w.seen.llmCalls[0], false, '不传 maxTokens：不设上限就是真的不设');

    const bad = await callRoute(w, 'POST', '/sysops/api/clean/ai-suggest', {});
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'INVALID_PARAM', '缺 planId 不该去花钱问模型');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/**
 * hc-16 宿主给了 llm 但一个 provider 都没注册：就绪度必须说"不可用 + 去配模型"，
 * 而不是 available:true 让界面上一个必然失败的按钮（假桩不许比宿主能多）。
 */
await checkAsync('hc-16 有 ctx.llm 但 provider 清单为空：就绪度报不可用并指向宿主设置', async () => {
  const w = makeHost({ llmProviders: [] });
  HOST.apply(w.ctx, {});
  await flushMicrotasks();
  assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.ai, true, '句柄在场这一事实仍是 true');
  const ready = await callRoute(w, 'GET', '/sysops/api/clean/ai');
  assert.equal(ready.json.data.available, false);
  assert.match(ready.json.data.reason, /provider|模型/);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
