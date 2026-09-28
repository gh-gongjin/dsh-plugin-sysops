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

/* ④段：监控页 —— 纯函数级视图助手 + 组件渲染遍历 */
const { walk, render, clientPayload } = await import('./render-fixtures.mjs');
MON = CLIENT.__test.monitor;
globalThis.__SYSOPS__ = clientPayload();

/** 快照夹具：形状与 Task 18 的 snapshotOf() 逐键一致，不许多造字段。 */
function SNAP(over = {}) {
  return {
    cadence: '1s', keepMinutes: 30, timerBackend: 'ctx.interval',
    series: {
      cpu: [{ t: 1, v: 20 }, { t: 2, v: 42 }, { t: 3, v: 91 }],
      mem: [{ t: 1, v: 70 }, { t: 2, v: 79 }],
      diskFreePct: [{ t: 1, v: 33.5 }],
      netDown: [{ t: 1, v: 12_500_000 }],
      netUp: [{ t: 1, v: 2_400_000 }],
    },
    latest: { cpu: 42.3, mem: 71.5, diskFreeGb: 71.9, diskTotalGb: 214.7, netDown: 12_500_000, netUp: 2_400_000, t: 3 },
    sources: [
      { key: 'l0', label: '实时曲线', state: 'on', detail: '1s · 主进程内', restarts: 0, pid: null, stderrTail: '' },
      { key: 'l1a', label: '网速采集', state: 'on', detail: 'typeperf 运行中', restarts: 0, pid: 19304, stderrTail: '' },
      { key: 'l1b', label: '进程榜', state: 'off', detail: '已关闭', restarts: 0, pid: null, stderrTail: '' },
      { key: 'l2', label: '按需扫描', state: 'on', detail: '请求驱动', restarts: 0, pid: null, stderrTail: '' },
    ],
    proc: { rows: [], state: 'off', note: '' },
    dropped: { stale: 0, bad: 0 },
    alerts: { unread: 0, rules: [], hits: [] },
    clean: { state: { phase: 'idle' }, plan: null },
    ...over,
  };
}
const RULE = (id, n, dep, st, over = {}) => ({ rule: { id, n, dep, ...over }, st });

check('pg1-1 四指标行序与名称逐字固定，网速按 字节/秒 ÷ 1e6 出 MB/s', () => {
  const rows = MON.mtrRows(SNAP());
  assert.deepEqual(rows.map((r) => r.n), ['CPU 使用率', '内存', 'C 盘可用', '网络吞吐']);
  assert.equal(rows[3].v, '12.5');
  assert.equal(rows[3].u, 'MB/s');
  assert.match(rows[3].c, /上行 2\.4 MB\/s/);
});

check('pg1-2 禁止照抄原型的 /8：12 500 000 字节/秒 必须是 12.5 MB/s 而不是 1.6', () => {
  assert.equal(MON.mtrRows(SNAP()).find((r) => r.n === '网络吞吐').v, '12.5', '原型曲线的 /8 是 bit 口径演示值');
  assert.equal(CLIENT.__test.fmtRate(12_500_000), '12.5 MB/s');
});

check('pg1-3 内存/CPU 分档：>70 warn、>85 crit；边界值 85 不算 crit', () => {
  const r = MON.mtrRows(SNAP({ latest: { cpu: 85, mem: 71.5, diskFreeGb: 71.9, diskTotalGb: 214.7, netDown: 0, netUp: 0, t: 3 } }));
  assert.equal(r[0].cls, 'warn', '85 是"≥"阈值，进度条该 warn 而不是 crit');
  const r2 = MON.mtrRows(SNAP({ latest: { cpu: 85.6, mem: 96, diskFreeGb: 71.9, diskTotalGb: 214.7, netDown: 0, netUp: 0, t: 3 } }));
  assert.equal(r2[0].cls, 'crit');
  assert.equal(r2[1].cls, 'crit');
});

check('pg1-4 C 盘行的 pct 是"已用"而不是"可用"，且 total 缺失时不硬算', () => {
  const d = MON.mtrRows(SNAP()).find((r) => r.n === 'C 盘可用');
  assert.equal(d.pct, 66.5, '214.7 总 / 71.9 可用 → 已用 66.5%');
  assert.match(d.c, /已用 66\.5%/);
  const d2 = MON.mtrRows(SNAP({ latest: { cpu: 1, mem: 1, diskFreeGb: 71.9, diskTotalGb: 0, netDown: 0, netUp: 0, t: 3 } })).find((r) => r.n === 'C 盘可用');
  assert.equal(d2.pct, null, '总容量缺失时进度条宁可不画');
});

check('pg1-5 采集源条四类状态文案各不相同（spec §4.2 四分清）', () => {
  const cell = (state, extra = {}) => MON.srcCells(SNAP({ sources: [{ key: 'l1a', label: '网速采集', state, detail: '', restarts: 0, pid: null, stderrTail: '', ...extra }] }), 'sse')[0];
  assert.equal(cell('off').pill, '未开启');
  assert.match(cell('crashed').pill, /进程已退出/);
  assert.equal(cell('unavailable').pill, '权限不足/计数器缺失');
  assert.equal(cell('on').pill, '运行中');
});

check('pg1-6 exited-max 行必须带退避次数与 stderr 尾巴，并且不再自动重启', () => {
  const c = MON.srcCells(SNAP({ sources: [{ key: 'l1a', label: '网速采集', state: 'exited-max', detail: '', restarts: 5, pid: null, stderrTail: 'ERROR: 无法访问' }] }), 'sse')[0];
  assert.match(c.pill, /已退出 5 次/);
  assert.match(c.detail, /ERROR: 无法访问/);
  assert.equal(c.retryOnly, true, '5 次封顶后只留「重试」按钮');
});

check('pg1-7 数据异常计数在曲线上可见（脏点丢弃不画点，但要报数）', () => {
  const out = walk(MON.MonitorPage({ snap: SNAP({ dropped: { stale: 2, bad: 7 } }), link: 'sse' }));
  assert.ok(out.texts.some((t) => /丢弃 7 个异常点/.test(t)), JSON.stringify(out.texts.filter((t) => /丢弃/.test(t))));
  assert.ok(out.texts.some((t) => /乱序 2/.test(t)));
});

check('pg1-8 阈值线只画在有阈值的卡上：CPU 85、C 盘 32 GB，网速卡没有', () => {
  assert.equal(MON.curveSpec(SNAP(), 'cpu').threshold, 85);
  assert.equal(MON.curveSpec(SNAP(), 'diskFreePct').thresholdGb, 32);
  assert.equal(MON.curveSpec(SNAP(), 'netDown').threshold, null);
});

check('pg1-9 进程榜关闭时把实测代价与默认关的理由写在空态里', () => {
  const out = walk(MON.MonitorPage({ snap: SNAP(), link: 'sse' }));
  assert.ok(out.has('640ms'));
  assert.ok(out.has('13%'));
  assert.ok(out.has('现在开启'));
  assert.ok(!out.has('Chrome.exe'), '未开启就不该渲染榜单行');
});

check('pg1-10 进程榜开启：表头四列 + 按 cpuPct 排序 + 「不结束进程」的理由卡', () => {
  const rows = [
    { pid: 7412, name: 'idea64.exe', ws: 4.1e9, cpuPct: 11.2 },
    { pid: 11384, name: 'Chrome.exe', ws: 2.4e9, cpuPct: 92.4 },
  ];
  const out = walk(MON.MonitorPage({ snap: SNAP({ proc: { rows, state: 'on', note: '上限 400 行 · 已截断' } }), link: 'sse' }));
  assert.ok(out.has('PID') && out.has('CPU%') && out.has('内存') && out.has('来源'));
  assert.ok(out.texts.indexOf('Chrome.exe') < out.texts.indexOf('idea64.exe'), '必须按 CPU 降序');
  assert.ok(out.has('本插件不提供「结束进程」'), out.texts.join('|'));
  assert.ok(out.has('已截断'));
});

check('pg1-11 规则置灰吃宿主的 st 三态，页面绝不自己比 source.state', () => {
  const snap = SNAP({ alerts: { unread: 0, rules: [RULE('r4', '下行持续 > 20 MB/s 满 1 分钟', 'l1a', { dim: true, on: false, st: '依赖的采集已关闭' }), RULE('r5', '单进程 CPU > 60%', 'l1b', { dim: false, on: false, st: '已暂停' }), RULE('r1', 'CPU ≥ 85% 连续 3 次', 'l0', { dim: false, on: true, st: '监控中' })], hits: [] } });
  const out = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(out.has('依赖的采集已关闭') && out.has('已暂停') && out.has('监控中'));
  assert.equal(out.classHas('so-rule-dim'), true);
  const src = CLIENT.__test.monitor.srcCells(snap, 'sse');
  assert.equal(src.find((c) => c.key === 'l1a').state, 'on', '置灰只跟随 st，不跟随本行 state 的直觉');
});

check('pg1-12 触发时间线两类行（hit 带数值、op 带操作），且标出 200 条上限', () => {
  const snap = SNAP({ alerts: { unread: 2, rules: [], hits: [
    { hitId: 'h-1', t: 1_700_000_000_000, kind: 'hit', ruleName: 'CPU ≥ 85% 连续 3 次', metric: 'cpu', value: 92.4, note: '连续 3 次' },
    { hitId: 'h-2', t: 1_700_000_000_000, kind: 'op', text: '你将实时曲线采样档位切为 5s' },
  ] } });
  const out = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(out.has('92.4'));
  assert.ok(out.has('CPU ≥ 85% 连续 3 次'));
  assert.ok(out.has('你将实时曲线采样档位切为 5s'));
  assert.ok(out.has('本机保留最近 200 条'));
});

check('pg1-13 侧边栏蓝点只由未读数驱动：0 不画，>0 画', () => {
  const zero = walk(CLIENT.SysopsPanelIcon({ size: 20, active: false, unread: 0 }));
  const three = walk(CLIENT.SysopsPanelIcon({ size: 20, active: false, unread: 3 }));
  assert.equal(zero.classes.filter((c) => /unread/.test(c)).length, 0);
  assert.equal(three.classes.filter((c) => /unread/.test(c)).length, 1);
});

check('pg1-14 推送降级必须在采集源条上如实标出来（sse / reconnecting / polling 三态）', () => {
  const t = (link) => walk(MON.MonitorPage({ snap: SNAP(), link })).texts.join('|');
  assert.ok(!/降级/.test(t('sse')));
  assert.match(t('reconnecting'), /重连中/);
  assert.match(t('polling'), /降级：轮询 2s/);
});

check('pg1-15 数据红线：client.js 源码里不出现原型的演示数字与"系统通知"开关', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  for (const lit of ['71.9', '214.7', '11.4', '22:41', 'Chrome.exe', '84.1 万']) {
    assert.ok(!code.includes(lit), `源码里出现了写死的演示值 ${lit}`);
  }
  assert.doesNotMatch(code, /系统通知/, '宿主不提供系统通知 → UI 上不留开关（spec §1.1 决策 8）');
});

check('pg1-16 快照缺失（首个 snapshot 帧未到）时渲染骨架而不是崩溃', () => {
  const out = walk(MON.MonitorPage({ snap: null, link: 'sse' }));
  assert.ok(out.has('等待首帧数据'), out.texts.join('|'));
  assert.ok(!out.has('NaN'));
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
