/**
 * test/client.test.mjs —— 浏览器半边（client.js）的加载骨架与页面用例。
 *
 * 口径说明（对齐 Task 20/21 简报的 ③④ 段）：简报把 ③④ 段写进 `test/plugin.test.mjs`，
 * 但本批与 Task 19（同一文件追加 ② 段）并行派发，控制器明令禁动 plugin.test.mjs，
 * 于是 ③④ 段整体落在本文件 —— **用例 id、名称、断言与条数逐字照简报**，只是换了宿主文件；
 * 统计/exit 也在本文件末尾（与简报「挪到文件末尾」同形）。控制器合并时可原样搬回。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStubReact } from './render-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 去注释（口径逐字照 dsh-plugin-stock-analysis/test/plugin.test.mjs:48）：`:` 或 `\` 后面的 `//` 是 URL/路径，不是注释。 */
const stripComments = (s) => s.replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

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

/* ③段：浏览器半边加载骨架 */
// 四个页签的视图助手容器。ESM 顶层是严格模式，④~⑦段直接 `MON = …` 会抛
// ReferenceError，所以在本段（第一个被追加进来的段）就把四个名字声明好。
let MON = null, CLEAN = null, SRCH = null, SET = null;
let loadedClient = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { loadedClient = def; } } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild() {} },
};
await import('../client.js');

check('cf-1 经 ModuleLoader 注册且 id 是包名', () => {
  assert(loadedClient, '未调用 window.__ModuleLoader__.load');
  assert.equal(loadedClient.id, 'dsh-plugin-sysops');
});

const ReactStub = makeStubReact();
const CLIENT = loadedClient.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('意外的 require: ' + name);
});

check('cf-2 导出形状：apply / inject(slots) / 两个组件 / __test', () => {
  assert.equal(typeof CLIENT.apply, 'function');
  assert.deepEqual(CLIENT.inject, ['slots']);
  assert.equal(typeof CLIENT.SysopsPanelIcon, 'function');
  assert.equal(typeof CLIENT.SysopsPage, 'function');
  assert.equal(typeof CLIENT.__test.consumeSse, 'function');
});

function clientCtx() {
  const reg = [];
  return {
    effects: [],
    slots: {
      inject: (name, cb) => { reg.push({ phase: 'inject', name }); return cb(); },
      register: (opts, comp) => { reg.push({ phase: 'register', opts, comp }); return () => {}; },
    },
    effect(f, id) { this.effects.push(id); const d = f(); return typeof d === 'function' ? d : () => {}; },
    reg,
  };
}

check('cf-3 没有宿主载荷（缺 webServer）→ 一个 slot 都不注册', () => {
  delete globalThis.__SYSOPS__;
  const c = clientCtx();
  CLIENT.apply(c);
  assert.equal(c.reg.filter((r) => r.phase === 'register').length, 0, JSON.stringify(c.reg));
});

check('cf-4 有载荷：侧边栏 id 与主面板 key 一致、order 跟随宿主', () => {
  globalThis.__SYSOPS__ = { panelId: 'sysops', label: '系统运维', panelOrder: 12, routePrefix: '/sysops', api: '/sysops/api', capabilities: { storageDomain: true, timer: true, webServer: true }, cadences: ['1s', '5s', 'paused'], sourceKeys: ['l0', 'l1a', 'l1b', 'l2'], redlines: [], searchAdvice: [], defaults: {} };
  const c = clientCtx();
  CLIENT.apply(c);
  const nav = c.reg.find((r) => r.opts?.name === 'sidebar.panellist');
  const page = c.reg.find((r) => r.opts?.name === 'main');
  assert.ok(nav && page, '缺注册');
  assert.equal(nav.opts.id, page.opts.key);
  assert.equal(nav.opts.id, 'sysops');
  assert.equal(nav.opts.order, 12, 'order 必须吃注入载荷而不是写死');
  assert.equal(nav.opts.label(), '系统运维');
  assert.deepEqual(c.reg.filter((r) => r.phase === 'inject').map((r) => r.name), ['sidebar.panellist', 'main']);
});

check('cf-5 样式随 ctx.effect 挂载并可回收；颜色全走宿主 token 的 var()', () => {
  const c = clientCtx();
  CLIENT.apply(c);
  assert.ok(c.effects.some((id) => /sysops/.test(String(id))), JSON.stringify(c.effects));
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /--dsw-alias-bg-base/);
  assert.match(code, /--dsw-alias-label-primary/);
});

check('cf-6 四页签 label 与已确认原型逐字一致', () => {
  const tabs = CLIENT.__test.nav.map((t) => t.t);
  assert.deepEqual(tabs, ['资源监控', 'C 盘清理', '文件搜索', '设置']);
});

await checkAsync('cf-7 consumeSse：跨 chunk 的半帧不炸、注释帧跳过、坏 JSON 只跳过该帧', async () => {
  const frames = [];
  const enc = new TextEncoder();
  const body = {
    async getReader() {
      const parts = ['event: metrics\ndata: {"a":1}\n', '\nevent: : ping\n\n', ': ok\n\n', 'event: bad\ndata: {oops\n\n', 'event: metrics\ndata: {"b":2}\n\n'];
      let i = 0;
      return { async read() { return i < parts.length ? { done: false, value: enc.encode(parts[i++]) } : { done: true }; } };
    },
  };
  await CLIENT.__test.consumeSse({ body }, (ev, d) => frames.push([ev, d]));
  assert.deepEqual(frames.filter((f) => f[0] === 'metrics').map((f) => f[0] + ':' + JSON.stringify(f[1])), ['metrics:{"a":1}', 'metrics:{"b":2}']);
  assert.equal(frames.length, 2, '注释帧与坏帧不该产出：' + JSON.stringify(frames));
});

await checkAsync('cf-8 api()：GET 走查询串、POST 走 JSON，路径一律以 routePrefix 开头', async () => {
  const seen = [];
  globalThis.fetch = async (u, init = {}) => { seen.push([u, init.method ?? 'GET']); return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }), headers: { get: () => 'application/json' } }; };
  await CLIENT.__test.api('snapshot');
  await CLIENT.__test.api('clean/apply', { method: 'POST', body: { planId: 'p' } });
  assert.equal(seen[0][0], '/sysops/api/snapshot');
  assert.equal(seen[1][1], 'POST');
  assert.ok(seen.every(([u]) => u.startsWith('/sysops/api/')), JSON.stringify(seen));
});

await checkAsync('cf-9 请求失败必须变成可见状态：api() 抛错时返回 error 对象而不是静默', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 501, json: async () => ({ ok: false, error: { code: 'PREFS_UNAVAILABLE', message: '没有 storageDomain' } }) });
  const r = await CLIENT.__test.api('prefs');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PREFS_UNAVAILABLE');
});

check('cf-10 禁止 EventSource（宿主前缀要 POST/带控制帧，且它不便断线重连补历史）', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /new EventSource/);
});

check('cf-11 交互全自研：源码里不出现 confirm( / alert( / <select', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /\bconfirm\s*\(|\balert\s*\(/);
  assert.doesNotMatch(code, /['"]select['"]/);
  assert.doesNotMatch(code, /<select/i);
});

check('cf-12 无顶部浮层：CSS 与组件里都没有 toast/notice-bar 类实现（spec §4.7 就地落卡）', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /toast|Toast|notice-bar|noticeBar|position:fixed[^]*top:\s*\d/, '出现浮层实现');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
