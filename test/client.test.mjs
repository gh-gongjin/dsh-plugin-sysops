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

/* ⑤段：清理页 —— 两段式的界面侧 */
CLEAN = CLIENT.__test.clean;
globalThis.__SYSOPS__ = clientPayload();

const IDLE = { phase: 'idle', dir: '', walked: 0, hit: 0, bytes: 0, stopped: false, truncated: false, skipped: [], planId: null, error: '' };
const SCAN = { phase: 'scanning', dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp', walked: 118_400, hit: 6, bytes: 2.4e9, stopped: false, truncated: false, skipped: [{ dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\locked', code: 'EPERM', why: '拒绝访问' }], planId: null, error: '' };
const ITEM = (over = {}) => ({ id: 'temp-user-aG9tZQ', ruleId: 'temp-user', ruleName: '用户临时目录', kind: '缓存',
  path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log', size: 656 * 2 ** 20, count: 14, atime: 1, mtime: 1,
  riskLevel: 'low', riskWhy: '', ...over });
const PLAN = (items) => ({ planId: 'plan-1', at: 1_700_000_000_000, beforeFree: 70.4e9, afterFree: null, modeDefault: 'delete-file',
  rulesUsed: [{ id: 'temp-user', n: '用户临时目录', kind: '缓存' }], items, totals: { n: items.length, bytes: items.reduce((a, i) => a + i.size, 0) } });

check('pg2-1 未扫描时的空态：说清扫描是只读的、删除只发生在勾选之后', () => {
  const out = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: { dirs: 0, files: 0, bytes: 0, oldest: null }, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('尚未扫描'));
  assert.ok(out.has('扫描是只读的'));
  assert.ok(!out.has('路径 / 内容'), '未扫描不该出现清单表');
});

check('pg2-2 扫描中：当前目录 / 已遍历 / 已发现 + 大小 / 进度条 / 停止按钮', () => {
  const c = CLEAN.scanCells(SCAN);
  assert.equal(c.walked, '118,400');
  assert.equal(c.found, 6);
  assert.match(c.size, /GB/);
  assert.ok(Number(c.pct) >= 0 && Number(c.pct) <= 100);
  const out = walk(CLEAN.CleanPage({ clean: SCAN, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('停止扫描'));
  assert.ok(out.has('中断后已发现的部分仍可继续查看'));
});

check('pg2-3 清单表头五列逐字，且第一列是复选框占位', () => {
  assert.deepEqual(CLEAN.PLAN_COLS, ['路径 / 内容', '大小', '命中规则', '最后访问', '风险']);
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  for (const col of CLEAN.PLAN_COLS) assert.ok(out.has(col), `缺表头 ${col}`);
});

check('pg2-4 被 guard 拒绝的项：复选框禁用 + 「已拒绝」+ 原因，且不进可选集合', () => {
  const items = [ITEM(), ITEM({ id: 'x1', path: 'C:\\Windows\\Temp', ruleName: '系统临时目录', guardDenied: { code: 'b-system-dir', why: '命中不可移除黑名单：C:\\Windows\\*' } })];
  const rows = CLEAN.planRows(PLAN(items), new Set(['temp-user-aG9tZQ', 'x1']));
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].riskPill, '已拒绝');
  assert.match(rows[1].why, /不可移除黑名单/);
  const t = CLEAN.selTotals(PLAN(items), new Set(['temp-user-aG9tZQ', 'x1']));
  assert.equal(t.n, 1, '勾了也没用：被拒项不计入可选集合');
});

check('pg2-5 标风险的项可以被勾选，但「全选可清理项」跳过它并说明跳了几项', () => {
  const items = [ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })];
  const t = CLEAN.selTotals(PLAN(items), CLEAN.selectAllIds(PLAN(items)));
  assert.equal(t.n, 1, '默认全选 = 低风险且未被拒的 1 项');
  assert.equal(t.risky, 1);
  assert.equal(t.rejected, 1);
});

check('pg2-6 未勾选时两个动作按钮都禁用，并给出原因而不是静默变灰', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  const del = out.buttons.find((b) => b.text.includes('清理选中'));
  const quar = out.buttons.find((b) => b.text.includes('隔离到暂存目录'));
  assert.equal(del.disabled, true);
  assert.equal(quar.disabled, true);
  assert.ok(out.has('勾选至少一项'));
});

check('pg2-7 已选统计：项数 + 预计释放 + 「删除不可恢复，回收站不参与」', () => {
  const plan = PLAN([ITEM(), ITEM({ id: 'b', size: 1.24 * 2 ** 30 })]);
  const t = CLEAN.selTotals(plan, new Set(['temp-user-aG9tZQ', 'b']));
  assert.equal(t.n, 2);
  assert.match(t.bytesText, /GB/);
  assert.ok(t.bytes > 1.8e9 && t.bytes < 1.9e9, String(t.bytes));
});

check('pg2-8 请求体结构上不含路径：applyBody 只出三键（与宿主 rt-6 同一条红线的界面侧）', () => {
  const b = CLEAN.applyBody('plan-1', ['a', 'b'], 'delete-file');
  assert.deepEqual(Object.keys(b).sort(), ['itemIds', 'mode', 'planId']);
  assert.ok(!/path/i.test(JSON.stringify(b)));
});

check('pg2-9 暂存目录显示 prefs 的实配值，不照抄原型的演示路径', () => {
  // 夹具必须是**展开后的绝对路径**：Task 14 的 `prefq-1` 让 prefs schema 直接拒掉未展开的 `%LOCALAPPDATA%\q`，
  // 所以库里永远不可能出现 `%` 形 —— 拿它当 prefs 值是假夹具（界面无条件渲染 prefs 实配值）。
  const txt = CLEAN.quarantineText({ clean: { quarantineDir: 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine', keepDays: 7 } });
  assert.ok(txt.includes('dsh-plugin-sysops\\quarantine'), txt);
  assert.ok(!txt.includes('.dsh-quarantine'), '原型里那串是演示值：' + txt);
  assert.match(txt, /保留 7 天|7 天/);
  assert.match(txt, /插件不会自动删/);
});

check('pg2-10 留痕：三档计数逐条可见，可展开看冻结快照与前后容量', () => {
  const logs = [{ logId: 'CLN-2609-0003', planId: 'plan-9', startedAt: 1, finishedAt: 2, mode: 'delete-file', itemIds: ['a'],
    ok: 5, skipped: 1, failed: 0, rejected: 2, bytesFreed: 3.12e9, beforeFree: 70.4e9, afterFree: 73.5e9, error: '' }];
  const r = CLEAN.logRow(logs[0]);
  assert.match(r.line, /成功 5 · 跳过 1 · 失败 0/);
  assert.equal(r.modePill, '永久删除');
  assert.match(r.snapshot, /70\.4 GB → 73\.5 GB/);
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs, unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('清理留痕'));
  assert.ok(out.has('追加式，只读'));
});

check('pg2-11 上次执行未确认完成要在清单顶部提示，并指向留痕（spec §4.3）', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [],
    unfinished: [{ logId: 'CLN-2609-0004', startedAt: 1, mode: 'delete-file', done: 3, total: 6 }], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('上次执行未确认完成'));
  assert.ok(out.has('CLN-2609-0004'));
});

check('pg2-12 执行完清单即失效：盖执行时间戳并要重新扫描（改勾选必须先重扫的代价）', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: null }, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(),
    err: null, lastSummary: { planId: 'plan-1', ok: 2, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.9e9, at: 1_700_000_090_000 } }));
  assert.ok(out.has('清单已失效'));
  assert.ok(out.has('重新扫描'));
});

check('pg2-13 写接口错误就地落 notice：501 与 403 两种原因文案不同，都不弹浮层', () => {
  const e1 = { source: 'clean/apply', status: 501, code: 'PREFS_UNAVAILABLE', message: '没有 storageDomain' };
  const o1 = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: { storageDomain: false }, link: 'sse', sel: new Set(), err: e1 }));
  assert.ok(o1.has('配置只读'));
  assert.ok(o1.classHas('so-notice-red'));
  const e2 = { source: 'rules/add', status: 403, code: 'SYSOPS_RULE_GUARD_DENY', message: '回收站一律不参与' };
  const o2 = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: e2 }));
  assert.ok(o2.has('回收站一律不参与'));
  assert.ok(!/position:fixed/.test(JSON.stringify(o2.classes)), '不许出现浮层');
});

check('pg2-14 扫描被截断/有目录未纳入清单时必须说明（spec §7 如实降级，C-I-3 如实口径）', () => {
  const c = CLEAN.scanCells({ ...SCAN, truncated: true, skipped: [{ dir: 'D:\\locked', code: 'EPERM', why: '拒绝访问' }], stopped: true });
  assert.match(c.phase, /已停止/);
  assert.match(c.note, /条目数达上限/);
  // C-I-3：guard 红线拒绝与 EPERM 读不动同进一个 skipped 计数（lib/clean/scanner.js:154、:169-172），
  // 界面无从分辨，就不许把两者单说成「读不动」——那是把安全设计说成权限故障。
  assert.ok(c.note.includes('1 个目录未纳入清单（读不动或命中红线被拒）'), c.note);
});

// —— C-I-2 / C-m-3：宿主真形状的「渲染证人」（评审现证：删掉 :964、:978-979、:975、:512 四处渲染仍全绿）
//    以下每条都走 walk 断渲染产物，不再只测纯函数返回值。
const cleanProps = (over = {}) => ({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null, ...over });
const walkClean = (over) => walk(CLEAN.CleanPage(cleanProps(over)));

check('pg2-15 扫描卡把宿主对象形态的如实降级渲染出来（skipped {count,note} 透传 + 停止相位）', () => {
  const out = walkClean({ clean: { ...SCAN, stopped: true, truncated: true, skipped: { count: 2, sample: [{ dir: 'D:\\locked' }], truncated: true, note: '跳过项明细已截断，只留前 20 条' } } });
  assert.ok(out.has('本次扫描如实降级'), out.texts.join('|'));
  assert.ok(out.has('跳过项明细已截断'), '宿主 normalizeCleanState 的 note 必须原样透传到卡面');
  assert.ok(out.has('已停止'), '停止相位要标在扫描卡头');
});

check('pg2-16 清单卡：被停止的扫描要标出「已停止（部分清单）」并说明这份清单的降级', () => {
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1', stopped: true, truncated: true, skipped: { count: 1, sample: [], truncated: false, note: '' } }, plan: PLAN([ITEM()]) });
  assert.ok(out.has('这份清单如实降级'), out.texts.join('|'));
  assert.ok(out.has('扫描是被停止的'), '停止原因要在清单卡里补一句');
  assert.ok(out.has('已停止（部分清单）'), 'scanCells 的停止相位要渲染进清单卡头，不许只活在纯函数里');
});

check('pg2-17 宿主真形状 phase=ready 要被认作「扫描完成」并渲染清单卡（service.js:83）', () => {
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([ITEM()]) });
  assert.ok(out.has('待清理清单'), out.texts.join('|'));
  assert.ok(out.has('扫描完成'), 'phase 读数要出现在卡头');
});

check('pg2-18 清单卡要渲染「全选已跳过 N 项标风险的」说明（原型逐字）', () => {
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' })]) });
  assert.ok(out.has('全选已跳过 1 项标风险的（应用正在运行）'), out.texts.join('|'));
});

check('pg2-19 unfinished 没有 done/total 时回落 itemIds 计数（宿主真形状，log-store.js:122-127）', () => {
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([ITEM()]), unfinished: [{ logId: 'CLN-U1', startedAt: 1, mode: 'delete-file', itemIds: ['a', 'b', 'c'] }] });
  assert.ok(out.has('上次执行未确认完成'), out.texts.join('|'));
  assert.ok(out.has('涉及 3 项（完成数未知）'), '无 done/total 就用 itemIds 说涉及项数，不假报进度');
});

check('pg2-20 空态卡要把 st.error 如实渲染出来（扫描失败不静默）', () => {
  const out = walkClean({ clean: { ...IDLE, phase: 'error', error: '遍历炸了' } });
  assert.ok(out.has('扫描失败：遍历炸了'), out.texts.join('|'));
});

check('pg2-21 暂存目录二级回落：prefs 没配时用宿主展开好的 defaults.quarantineDir', () => {
  // clientPayload 的 defaults.quarantineDir 与真机 index.js:415 同形（宿主展开后的绝对路径）。
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([ITEM()]), prefs: {} });
  assert.ok(out.has('dsh-plugin-sysops'), '二级回落要把宿主展开的目录显示出来：' + out.texts.filter((t) => t.includes('隔离')).join('|'));
  assert.ok(out.has('同盘移动到'), out.texts.join('|'));
});

check('pg2-22 暂存目录第三级如实口径：内置暂存根目录照常隔离，不引导「必须先去设置页」（C-I-1）', () => {
  globalThis.__SYSOPS__ = clientPayload({ defaults: {} }); // 真机首装形状：index.js:415 未配置时是空/缺失
  try {
    const txt = CLEAN.quarantineText({ clean: { keepDays: 14 } });
    assert.ok(txt.includes('内置暂存根目录'), txt);
    assert.ok(txt.includes('保留 14 天后由你手动清空'), txt);
    assert.ok(txt.includes('插件不会自动删'), txt);
    assert.ok(!txt.includes('设置页'), '执行链会用内置根目录照常隔离（lib/clean/service.js:50-53），不该引导用户去配置：' + txt);
    assert.ok(!txt.includes('undefined'), txt);
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
});

check('pg2-23 未写完成档的留痕行显示「计数未确认」而不是全 0（C-m-2）', () => {
  const r = CLEAN.logRow({ logId: 'CLN-9', planId: 'plan-9', startedAt: 1, mode: 'delete-file', itemIds: ['a'] });
  assert.ok(r.line.includes('计数未确认'), r.line);
  assert.ok(!r.line.includes('成功 0'), 'start 行没有四档计数（log-store.js:122-127），"未知"不许说成"全 0"：' + r.line);
});

check('pg2-24 扫描分母拿不到时进度条走不定量，不画实心 0%（C-m-5）', () => {
  const c = CLEAN.scanCells({ ...SCAN, skipped: [] }, 0);
  assert.equal(c.pct, null, '已启用规则数拿不到时 pct 交 null，由卡面走不定量样式');
  const out = walkClean({ clean: { ...SCAN, skipped: [] }, rules: [] });
  assert.ok(out.has('进度未知'), out.texts.join('|'));
  assert.ok(out.classHas('is-indeterminate'), '不定量样式类要挂上');
  assert.ok(!out.has('0%'), '宿主任何接口都不发分母（lib/api.js 的规则列表只回 {items, off}），不许画实心 0');
});

check('pg2-25 404 与 503 两种整批拒的界面文案分开，都就地落 notice 不弹浮层（批 C concern-1 收口）', () => {
  // 评审 m1：夹具 message 原先自带「已被裁剪」，而 cleanErrNotice 又把 message 回显进同一句 notice，
  // 断言被回显满足（M15 改措辞仍 86/86）。改喂不含机制词的宿主原话形，让「已被裁剪」只能由界面自己的句子给出。
  const e404 = { source: 'clean/apply', status: 404, code: 'SYSOPS_RECORDS_NOT_FOUND', message: 'plan snapshot not found' };
  const o404 = walkClean({ clean: IDLE, err: e404 });
  assert.ok(o404.has('已被裁剪'), '404 要说清是清单快照被裁剪掉了（这句必须由界面自己供词，不吃回显）：' + o404.texts.join('|'));
  assert.ok(o404.has('请重新扫描'), o404.texts.join('|'));
  assert.ok(!o404.has('接口异常'), '不许落到通用兜底句');
  const e503 = { source: 'clean/apply', status: 503, code: 'SYSOPS_QUARANTINE_UNAVAILABLE', message: '暂存目录不可用（配置错误或建不出来），整批停止，未删除任何文件' };
  const o503 = walkClean({ clean: IDLE, err: e503 });
  assert.ok(o503.has('暂存目录不可用或记录域已关闭'), '503 要说清是外部依赖故障：' + o503.texts.join('|'));
  assert.ok(!o503.has('接口异常'), o503.texts.join('|'));
  assert.ok(o404.has('未删除任何文件') && o503.has('未删除任何文件'), '两种都要如实说"什么都没删"');
});

check('pg2-26 清理页只读闸门与设置页同一判定：caps 缺 storageDomain 键也落只读（批 F I-6，评审 M22 清理侧）', () => {
  // 缺键 fail-open 是评审 I-4 坐实的三页分叉之一；统一后（client.js 的 capsReadOnly）缺键=只读。
  // 把清理页闸门改回 `=== false` 时本用例必红：有勾选、缺键却出现可用写按钮，且只读说明消失。
  const plan = PLAN([ITEM()]);
  const out = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(plan.items.map((i) => i.id)) });
  const del = out.buttons.find((b) => b.text.includes('清理选中'));
  const quar = out.buttons.find((b) => b.text.includes('隔离到暂存目录'));
  assert.ok(plan.items.length > 0, '夹具本身必须有可勾项，否则禁用是勾选闸门而非只读闸门满足的');
  assert.equal(del.disabled, true, '有勾选项但能力缺键时不得出现可用写按钮（fail-closed）');
  assert.equal(quar.disabled, true, '隔离按钮同闸门');
  assert.ok(out.has('配置只读：宿主未提供 storageDomain，两个写按钮已禁用'), '禁用必须伴随可见原因：' + out.texts.join('|'));
});

/* ⑥段：搜索页 —— 通路自检与诚实降级
 *    简报把本段写在 test/plugin.test.mjs，控制器明令页面用例落本文件（口径：用例 id、名称、断言照简报）。
 *    夹具 PROBE/RES 的字段逐一对齐真机出口：lib/search/probe.js:144（ProbeResult）与
 *    lib/search/service.js:122（Result）—— 简报草稿里的 `checks:[installed/channel/e2e]` 三行与
 *    `res.total` 在真机形状里不存在，按现物改成本文件下面的四行 checks 与无 total 的 Result。 */
SRCH = CLIENT.__test.search;
globalThis.__SYSOPS__ = clientPayload();

/** 真机 ProbeResult 形状（probe.js:144-165）：checks 四条 = installed / http / es / walk，界面按三级归并显示。 */
const PROBE = (over = {}) => ({
  at: 1, installed: false, http: false, es: false, e2e: false, ready: false, via: null, degraded: true, level: null,
  checks: [
    { key: 'installed', label: '① 已安装 Everything', ok: false, detail: '未在常见安装路径找到 Everything.exe，es.exe 也不可用（未探到已安装）' },
    { key: 'http', label: '② HTTP 查询通路（:3417）', ok: false, detail: 'HTTP 探测超时（1500ms）' },
    { key: 'es', label: '② es.exe 查询通路', ok: false, detail: '未找到 es.exe（不在 PATH，可在设置页指定路径）' },
    { key: 'walk', label: '③ 本地遍历兜底', ok: false, detail: '未选目录：到设置页 → 搜索通路 里添加要覆盖的目录，兜底遍历不可用' },
  ],
  // 诱饵：advice() 只准读注入载荷的 searchAdvice（pg3-3 钉死），读 probe.advice 就会红
  advice: ['WINGET 诱饵：不要从 probe.advice 取文案'],
  ...over });
/** 真机 Result 形状（service.js:122-130）：`error` 是宿主原话字符串，不是 code；没有 total 字段。 */
const RES = (over = {}) => ({ rows: [], source: 'walk', sourceLabel: '本地遍历', truncated: false, stale: false, note: '', error: null, took: 7300, limit: 200, ...over });
/** 宿主真机原话（everything-http.js:53 / :46）—— 界面 403 与超时的指引靠回显这两句，不在 client 再抄一份。 */
const E403 = 'Everything 的 HTTP 服务未开启：在 Everything 里勾选 工具 → 选项 → HTTP 服务器（默认端口 3417）';
const ETO = '请求超时（timeout，4000ms 到点已取消）';
const READY = { installed: true, http: true, e2e: true, ready: true, via: 'http', degraded: false, level: 'e2e' };
const PAGE = (over = {}) => walk(SRCH.SearchPage({ probe: PROBE(), res: null, mode: 'walk', limit: 200, q: '', dirs: [], err: null,
  onSearch() {}, onMode() {}, onLimit() {}, onReprobe() {}, onAddDir() {}, onDelDir() {}, ...over }));

check('pg3-1 自检三行标题逐字，且卡在哪一级就标在哪一级', () => {
  assert.deepEqual(SRCH.PROBE_ROWS, ['① 已安装 Everything', '② 有查询通路', '③ 端到端可用']);
  const c = SRCH.probeCells(PROBE());
  assert.deepEqual(c.map((x) => x.title), SRCH.PROBE_ROWS);
  assert.equal(c[0].mark, '!');
  assert.equal(c[2].mark, '·', '前两级没过时第三级是"未执行"而不是失败');
  assert.equal(c[2].pill, '未执行');
});

check('pg3-2 三级全绿才收引导卡', () => {
  const off = PAGE({});
  assert.ok(off.has('如何拿到全盘秒级搜索'));
  const on = PAGE({ probe: PROBE(READY) });
  assert.ok(!on.has('如何拿到全盘秒级搜索'), '通路就绪后引导卡该收起来');
});

check('pg3-3 指引三条只从注入载荷的 searchAdvice 取（文案单源，不在 client 再抄一份）', () => {
  const A = ['A1 winget install voidtools.Everything', 'A2 https://www.voidtools.com/downloads/', 'A3 工具 → 选项 → HTTP 服务器'];
  globalThis.__SYSOPS__ = clientPayload({ searchAdvice: A });
  try {
    assert.deepEqual(SRCH.advice(), A);
    // I-4 渲染证人：三条指引逐行进引导卡（M2 变异「advice 改读自建常量 / probe.advice」必须在这里红）
    const on = PAGE({});
    for (const line of A) assert.ok(on.has(line), '注入的指引行该逐条渲染：' + line + '；实际：' + on.texts.join('|'));
    assert.ok(!on.has('WINGET 诱饵：不要从 probe.advice 取文案'), 'probe.advice 里的诱饵不许上屏');
    const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
    assert.ok(!code.includes('voidtools.com'), 'client.js 里不该出现第二份安装指引文案');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
  // 载荷没给（默认 searchAdvice: []）⇒ 宁缺毋滥：引导卡在，但不许冒出任何自编的 winget/voidtools 文案
  const off = PAGE({});
  assert.ok(off.has('如何拿到全盘秒级搜索'), '未就绪仍要出引导卡');
  assert.ok(!off.texts.some((t) => /winget|voidtools/i.test(t)),
    '载荷缺省时不许渲染任何安装指引行（不编第二份）：' + off.texts.join('|'));
});

check('pg3-4 明说不代装：引导卡里有"由你自己执行"与三条边界（不装程序 / 不改注册表 / 不开服务）', () => {
  const out = PAGE({});
  assert.ok(out.has('由你自己执行'));
  assert.ok(out.has('不会替你装程序'));
  assert.ok(out.has('不会改注册表'));
  assert.ok(out.has('不会替你打开 HTTP 服务'));
});

check('pg3-5 通路未就绪：默认模式落 walk，全盘索引按钮标不可选并给原因', () => {
  assert.equal(SRCH.modeOf(PROBE(), 'everything'), 'walk');
  assert.equal(SRCH.modeOf(PROBE({ installed: true, es: true, e2e: true, ready: true, via: 'es', degraded: false }), 'everything'), 'everything');
  const out = PAGE({});
  const b = out.buttons.find((x) => x.text.includes('全盘索引'));
  assert.equal(b.disabled, true);
  assert.ok(out.has('通路未就绪'));
});

check('pg3-6 walk 模式必须写明覆盖范围与实测代价（14.5 万条目 / 7.3s）', () => {
  const out = PAGE({ mode: 'walk', dirs: ['C:\\Users\\gongj\\Documents', 'F:\\dsh-plugins'] });
  assert.ok(out.has('仅覆盖下面已选目录'));
  assert.ok(out.has('14.5 万'));
  assert.ok(out.has('7.3s'));
  assert.ok(out.has('C:\\Users\\gongj\\Documents'), '目录 chips 要渲染出来');
});

check('pg3-7 结果头三个字段：范围说明、来源 pill、命中数与上限', () => {
  const h = SRCH.resultHead(RES({ source: 'walk', sourceLabel: '本地遍历', rows: new Array(3).fill({}), limit: 200 }));
  assert.equal(h.sourcePill, '本地遍历');
  assert.match(h.hitText, /命中 3 项/);
  assert.match(h.hitText, /上限 200/);
  assert.match(h.sub, /限定目录/);
  const h2 = SRCH.resultHead(RES({ source: 'everything', sourceLabel: 'Everything HTTP', rows: new Array(5).fill({}), limit: 50, truncated: true }));
  assert.equal(h2.sourcePill, 'Everything HTTP');
  assert.match(h2.hitText, /已截断/);
  // M8：陈旧标记必须落在结果头 hitText 上（变异「去掉 stale 拼接」此断言即红）
  const h3 = SRCH.resultHead(RES({ source: 'walk', sourceLabel: '本地遍历', rows: new Array(2).fill({}), limit: 200, stale: true }));
  assert.match(h3.hitText, /· 陈旧/, 'stale:true 时命中数后必须标「· 陈旧」：' + h3.hitText);
  const h4 = SRCH.resultHead(RES({ source: 'walk', sourceLabel: '本地遍历', rows: new Array(2).fill({}), limit: 200 }));
  assert.ok(!/陈旧/.test(h4.hitText), '没标 stale 的结果不许挂陈旧：' + h4.hitText);
});

check('pg3-8 每条结果自带来源 pill，缺字段显示 — 而不是 0', () => {
  const rows = SRCH.rowCells(RES({ source: 'es', sourceLabel: 'es.exe', rows: [
    { name: 'client.js', dir: 'F:\\dsh-plugins\\dsh-plugin-stock-analysis', size: 214 * 1024, mtime: 1_700_000_000_000, source: 'es', path: 'F:\\a' },
    { name: 'x.txt', dir: 'F:\\', size: null, mtime: null, source: 'es', path: 'F:\\b' },
  ] }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.sourcePill), ['es.exe', 'es.exe']);
  assert.equal(rows[1].sizeText, '—', '未知大小不许显示成 0 B');
  assert.equal(rows[1].mtimeText, '—');
  // M6：name/dir 缺失同样落 '—'，不许空串/undefined 上屏
  const bare = SRCH.rowCells(RES({ rows: [{ size: null, mtime: null, source: 'walk', path: 'F:\\c' }] }));
  assert.equal(bare[0].name, '—', '缺 name 的行要显示 —：' + JSON.stringify(bare[0]));
  assert.equal(bare[0].dir, '—', '缺 dir 的行要显示 —：' + JSON.stringify(bare[0]));
});

check('pg3-9 降级四类文案各不相同：未就绪 / 403 / 超时保留陈旧 / 空结果', () => {
  const e403 = PAGE({ res: RES({ error: E403, rows: [], stale: true }) });
  assert.ok(e403.has('工具 → 选项 → HTTP 服务器'), '403 要给可执行指引（spec §4.4）');
  assert.ok(e403.has('HTTP 服务未开启'), '403 文案要认得出是 403：' + e403.texts.join('|'));
  assert.ok(!e403.has('到点已取消'), '403 态不许混进超时文案：' + e403.texts.join('|'));
  const stale = PAGE({ res: RES({ stale: true, error: ETO, rows: [{}] }) });
  assert.ok(stale.has('陈旧'), '超时后留下的上次结果必须标陈旧：' + stale.texts.join('|'));
  assert.ok(stale.has('超时') && stale.has('到点已取消'), '超时要说清已取消（宿主原话回显）：' + stale.texts.join('|'));
  assert.ok(!stale.has('HTTP 服务未开启'), '超时态不该出现 403 的指引：' + stale.texts.join('|'));
  const notReady = PAGE({ res: RES({ rows: [], note: '降级为本地遍历（Everything 通路未就绪）：未在常见安装路径找到 Everything.exe，es.exe 也不可用（未探到已安装）' }), q: 'a' });
  assert.ok(notReady.has('通路未就绪') && notReady.has('降级为本地遍历'), '未就绪态要说成「整条通路没有、已降级」：' + notReady.texts.join('|'));
  assert.ok(!notReady.has('到点已取消') && !notReady.has('HTTP 服务未开启'), '未就绪不许套 403/超时的话：' + notReady.texts.join('|'));
  const empty = PAGE({ res: RES({ rows: [], error: null }), q: 'zzz' });
  assert.ok(empty.has('空格 = 同时满足'), '空结果要教分词规则');
  assert.ok(!empty.has('陈旧'), '空结果不是失败，不许挂陈旧条：' + empty.texts.join('|'));
  const ready = PAGE({ probe: PROBE(READY), res: null });
  assert.ok(ready.has('输入关键字'), '就绪态该是搜索框而不是引导');
});

check('pg3-10 上限三档 50/200/1000，切档只改 limit 不自动重发', () => {
  assert.deepEqual(SRCH.LIMITS, [50, 200, 1000]);
  let fired = 0;
  const out = walk(SRCH.SearchPage({ probe: PROBE(), res: RES({ rows: [{}] }), mode: 'walk', limit: 200, q: 'a', dirs: [], err: null,
    onSearch() { fired += 1; }, onMode() {}, onLimit() {}, onReprobe() {}, onAddDir() {}, onDelDir() {} }));
  assert.equal(out.buttons.filter((b) => /^\d+$/.test(b.text)).length, 3);
  assert.equal(fired, 0, '渲染阶段不许触发请求');
});

check('pg3-11 空查询不发请求（searchQuery 返回 null），带查询时三键齐', () => {
  assert.equal(SRCH.searchQuery({ q: '   ', mode: 'walk', limit: 200 }), null);
  assert.deepEqual(SRCH.searchQuery({ q: 'report .pdf', mode: 'walk', limit: 50 }), { q: 'report .pdf', mode: 'walk', limit: 50 });
});

check('pg3-12 「打开位置」只定位不执行：说明文案在场，且没有"打开文件/运行"字样', () => {
  const out = PAGE({ res: RES({ rows: [{ name: 'a.txt', dir: 'F:\\', size: 1, mtime: 1, source: 'walk', path: 'F:\\a.txt' }] }) });
  assert.ok(out.has('不替你打开文件'));
  assert.ok(out.has('不执行任何程序'));
  assert.ok(!out.has('运行'));
});

check('pg3-13 I-6 只读闸门（搜索页）：caps 无 storageDomain ⇒ chips 只读 + 增删入口消失，恢复载荷后入口回来', () => {
  globalThis.__SYSOPS__ = clientPayload({ capabilities: {} });
  try {
    const out = PAGE({ dirs: ['F:\\dsh-plugins'] });
    assert.ok(out.has('配置只读：宿主未提供 storageDomain，覆盖范围不可改'),
      '缺 storageDomain 必须落到可见原因：' + out.texts.join('|'));
    assert.ok(!out.buttons.some((b) => b.text.includes('添加目录')), '只读态不许有「添加目录」按钮');
    assert.ok(!out.buttons.some((b) => b.text === '×'), '只读态不许有目录移除按钮');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
  const back = PAGE({ dirs: ['F:\\dsh-plugins'] });
  assert.ok(back.buttons.some((b) => b.text.includes('添加目录')), '载荷恢复后「＋ 添加目录」必须回来（闸门翻转双向可证）');
  assert.ok(!back.has('配置只读：宿主未提供 storageDomain，覆盖范围不可改'));
});
/* ⑧段：共享连接层（批 D + Ruling-98 接线）—— 带真实 useEffect/useState 的活体桩
 *    评审现证：useStream 层此前零覆盖，D-I-1 的假降级、D-I-2 的静默覆盖写、D-I-3 的连接悬挂
 *    都长在 effect 里，纯 props 的 walk 抓不到 ⇒ 本段用活体桩真挂载、真跑 effect、真收集 cleanup。 */

globalThis.__SYSOPS__ = clientPayload(); // 自足引导：本段不依赖前段 finally 的还原

/**
 * 活体桩 React：useState/useRef 按 hook 调用顺序落槽位、setter 真改槽位；
 * useEffect 真执行并按 deps 比较重跑；__unmount 挨个执行未跑的 cleanup（真机卸载语义）。
 * 页签与状态的推进一律走「真点击 + 重渲染」，不靠预置槽位序号 —— 避免与 hook 顺序强耦合。
 */
function makeLiveReact() {
  const slots = [];
  const effs = [];
  let cursor = 0;
  const R = {
    __root: null,
    createElement(type, props, ...children) {
      const p = props ? { ...props } : {};
      if (children.length) p.children = children.length === 1 ? children[0] : children;
      return { type, props: p, children };
    },
    useState(init) {
      const i = cursor; cursor += 1;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }];
    },
    useRef(v) {
      const i = cursor; cursor += 1;
      if (!(i in slots)) slots[i] = { current: v === undefined ? null : v };
      return slots[i];
    },
    useEffect(fn, deps) {
      const i = cursor; cursor += 1;
      const prev = effs[i];
      const changed = !prev || !Array.isArray(prev.deps) || !Array.isArray(deps)
        || deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k]);
      if (changed) {
        if (prev && typeof prev.cleanup === 'function') { prev.cleanup(); prev.cleanup = null; }
        const cleanup = fn();
        effs[i] = { deps: Array.isArray(deps) ? deps.slice() : null, cleanup: typeof cleanup === 'function' ? cleanup : null };
      }
    },
    /** 挂载或重渲染：cursor 归零重走组件树；deps 变了的 effect 会真执行。返回 walk 结果。 */
    __render(Comp) { cursor = 0; R.__root = Comp(); return walk(R.__root); },
    /** 卸载：执行全部未跑的 effect cleanup。 */
    __unmount() { for (const e of effs) { if (e && typeof e.cleanup === 'function') { e.cleanup(); e.cleanup = null; } } },
  };
  return R;
}

/** fetch 桩：按路由表应答并记录每次调用（含 init.signal）；未登记的路由回可见错误而不是静默。 */
function stubFetch(routes) {
  const log = [];
  globalThis.fetch = async (u, init = {}) => {
    const url = String(u);
    const method = init.method ?? 'GET';
    log.push({ url, method, body: init.body, signal: init.signal ?? null });
    const hit = routes.find((r) => (r.method ?? 'GET') === method && url.split('?')[0] === r.url);
    if (!hit) return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'TEST_NO_ROUTE', message: '测试桩没这条路由：' + method + ' ' + url } }) };
    return hit.reply({ url, init });
  };
  return log;
}

/** SSE 响应体：逐帧吐出后挂住不返回 done —— 模拟真机长连接，直到 abort 或服务端关流。 */
function sseRes(frames) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i < frames.length) return { done: false, value: enc.encode(frames[i++]) };
          return new Promise(() => {});
        },
      }),
    },
  };
}

const jsonRes = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

/** 真机快照形状的最小足量版（两张页都渲染得动即可，字段不多造）。 */
const CN_SNAP = {
  cadence: '1s', keepMinutes: 30, series: {}, latest: {}, sources: [],
  proc: { rows: [], state: 'off', note: '' }, dropped: {}, alerts: { unread: 0, rules: [], hits: [] }, clean: {},
};

/** 在 vnode 树里按按钮文字取真 onClick（walk 的 buttons 只带"有没有"，这里要函数本身）。 */
function findClick(node, text) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findClick(n, text); if (r) return r; } return null; }
  if (typeof node.type === 'function') return findClick(node.type(node.props || {}), text);
  if (node.type === 'button') {
    const t = (node.children || []).filter((c) => typeof c === 'string').join('');
    if (t.includes(text)) { const fn = (node.props || {}).onClick; return typeof fn === 'function' ? fn : null; }
  }
  const kids = Array.isArray(node.children) ? node.children : [(node.props || {}).children];
  for (const k of kids) { const r = findClick(k, text); if (r) return r; }
  return null;
}

/** 起一份独立模块实例（绑一份独立活体桩），返回 render/点击/cleanup 的驱动器。 */
function cnWorld(routes) {
  const log = stubFetch(routes);
  const live = makeLiveReact();
  const C = loadedClient.factory((name) => {
    if (name === 'react') return live;
    throw new Error('意外的 require: ' + name);
  });
  return { log, live, C, render: () => live.__render(C.SysopsPage), click: (t) => findClick(live.__root, t) };
}
const cnTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** 真链路等待：退避链要跑 1s/2s/4s 三轮，只能轮询到期望出现为止（给硬超时，不死等）。 */
async function cnWait(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await cnTick(50);
  }
}

await checkAsync('cn-1 SSE 健康时 collect:refresh 补快照只换快照不改 link（D-I-1 假降级钉桩）', async () => {
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`, 'event: collect:refresh\ndata: {}\n\n']) },
    { url: '/sysops/api/snapshot', reply: () => jsonRes({ ok: true, data: CN_SNAP }) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: { unread: 0 } }) },
  ]);
  w.render();
  await cnTick();
  const out = w.render();
  assert.ok(w.log.some((e) => e.method === 'GET' && e.url === '/sysops/api/snapshot'),
    '重采完成帧必须补一次快照：' + JSON.stringify(w.log.map((e) => e.method + ' ' + e.url)));
  assert.ok(!out.has('降级'), 'SSE 健康时补快照不许把通道打成「降级：轮询 2s」（假降级）：' + out.texts.join('|'));
  assert.ok(!out.has('重连中'), out.texts.join('|'));
});

await checkAsync('cn-2 卸载必须 abort SSE 流请求：读循环与连接不悬挂（D-I-3）', async () => {
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  await cnTick();
  const streamCall = w.log.find((e) => e.url === '/sysops/api/stream');
  assert.ok(streamCall, '没发起流请求');
  assert.ok(streamCall.signal, 'fetch /stream 必须带 AbortController 的 signal');
  w.live.__unmount();
  assert.equal(streamCall.signal.aborted, true, '卸载后必须 abort，否则读循环悬挂到服务端关流为止');
});

await checkAsync('cn-3 prefs 读失败：可见报错且不发起覆盖写（D-I-2，半份 merged 不许整域写回）', async () => {
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: false, error: { code: 'PREFS_READ_FAILED', message: '读偏好失败' } }, 500) },
    { url: '/sysops/api/prefs', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  await cnTick();
  w.render(); // 快照帧落进槽位后重渲染，「新建规则」输入框才在场
  const save = w.click('保存规则');
  assert.ok(save, '没找到「保存规则」按钮');
  save();
  await cnTick();
  assert.ok(w.log.some((e) => e.method === 'GET' && e.url === '/sysops/api/prefs'), '写回前必须先读全量');
  assert.ok(!w.log.some((e) => e.method === 'POST' && e.url === '/sysops/api/prefs'),
    '读失败还整域写回会抹掉同域其它配置（lib/prefs/store.js:191），必须阻断');
  const out = w.render();
  assert.ok(out.has('接口异常'), '读失败必须可见（约束 4）：' + out.texts.join('|'));
});

await checkAsync('cn-4 快照只给 planId 字符串时按 GET /api/clean/plan 补清单并渲染（Ruling-98 接线）', async () => {
  const PLAN_ENTITY = {
    planId: 'plan-9', at: 1_700_000_000_000, modeDefault: 'delete-file', beforeFree: 70.4e9, afterFree: null,
    items: [{ id: 'a1', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\a.log', size: 4096, ruleName: '用户临时目录', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' }],
    totals: { n: 1, bytes: 4096 },
  };
  const snapWithPlanId = { ...CN_SNAP, clean: { phase: 'ready', planId: 'plan-9', plan: 'plan-9' } };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(snapWithPlanId)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/clean/logs', reply: () => jsonRes({ ok: true, data: [] }) },
    { url: '/sysops/api/clean/unfinished', reply: () => jsonRes({ ok: true, data: [] }) },
    { url: '/sysops/api/quarantine', reply: () => jsonRes({ ok: true, data: { dirs: 0, files: 0, bytes: 0, oldest: null } }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: true, data: { items: [], off: [] } }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: {} } }) },
    { url: '/sysops/api/clean/plan', reply: () => jsonRes({ ok: true, data: PLAN_ENTITY }) },
  ]);
  w.render();
  await cnTick();
  const goClean = w.click('C 盘清理');
  assert.ok(goClean, '没找到页签按钮');
  goClean();
  w.render(); // tab 变 → 现读辅助数据；snap 变 → 认 clean.plan 的 effect 重跑
  await cnTick();
  const getPlan = w.log.find((e) => e.method === 'GET' && e.url.split('?')[0] === '/sysops/api/clean/plan');
  assert.ok(getPlan, '快照只给 planId 字符串时必须补一次 GET /api/clean/plan：' + JSON.stringify(w.log.map((e) => e.method + ' ' + e.url)));
  assert.ok(/planId=plan-9/.test(getPlan.url), getPlan.url);
  const out = w.render();
  assert.ok(out.has('待清理清单'), '补拉到的实体要渲染成清单卡：' + out.texts.join('|'));
  assert.ok(out.has('a.log'), out.texts.join('|'));
});

await checkAsync('cn-5 SSE 连续握手失败真降级：通道落「降级：轮询 2s」且轮询在取数（NEW-1 覆盖缺口）', async () => {
  const w = cnWorld([
    // 每一轮都回非 2xx：streamLoop 走 `!res.ok → throw` 这一路，跑完整的 1s/2s/4s 退避链
    { url: '/sysops/api/stream', reply: () => ({ ok: false, status: 503, json: async () => ({ ok: false, error: { code: 'STREAM_DOWN', message: '服务端不让连' } }) }) },
    { url: '/sysops/api/snapshot', reply: () => jsonRes({ ok: true, data: CN_SNAP }) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  const downgraded = await cnWait(() => w.render().has('降级：轮询 2s'));
  assert.ok(downgraded, '连续失败三轮后必须换成轮询并在通道指示上如实写明：' + w.render().texts.join('|'));
  const out = w.render();
  assert.ok(!out.has('重连中'), '已落轮询就不该再挂着「重连中」（两个态必须互斥）：' + out.texts.join('|'));
  const streamTries = w.log.filter((e) => e.url === '/sysops/api/stream').length;
  assert.ok(streamTries >= 3, '降级前该真跑满三轮握手：' + streamTries);
  const polls = w.log.filter((e) => e.method === 'GET' && e.url === '/sysops/api/snapshot').length;
  assert.ok(polls >= 1, '降级后轮询必须真在取数，否则只是换个文案：' + JSON.stringify(w.log.map((e) => e.method + ' ' + e.url)));
  w.live.__unmount();
});

await checkAsync('cn-6 GET /clean/plan 回 404：补拉失败要就地留痕且不出清单卡（D-I-5 / NEW-2）', async () => {
  const snapWithPlanId = { ...CN_SNAP, clean: { phase: 'ready', planId: 'plan-x', plan: 'plan-x' } };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(snapWithPlanId)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/clean/logs', reply: () => jsonRes({ ok: true, data: [] }) },
    { url: '/sysops/api/clean/unfinished', reply: () => jsonRes({ ok: true, data: [] }) },
    { url: '/sysops/api/quarantine', reply: () => jsonRes({ ok: true, data: { dirs: 0, files: 0, bytes: 0, oldest: null } }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: true, data: { items: [], off: [] } }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: {} } }) },
    { url: '/sysops/api/clean/plan', reply: () => jsonRes({ ok: false, error: { code: 'SYSOPS_RECORDS_NOT_FOUND', message: 'plan snapshot not found' } }, 404) },
  ]);
  w.render();
  await cnTick();
  w.click('C 盘清理')();
  w.render();
  await cnTick();
  const out = w.render();
  // 评审 m1：原先两条 `||` 允许被回显的 message 满足（自证）。夹具已改成不含机制词的原话形，
  // 断言收成单断——「清单快照不存在…已被裁剪」这句只能由 cleanErrNotice 的 404 专分支自己供词。
  assert.ok(out.has('清单快照不存在'), '补拉失败要走 404 专分支留痕，不许落通用兜底（约束 4）：' + out.texts.join('|'));
  assert.ok(out.has('已被裁剪'), '裁剪措辞须由界面句子给出（改「已被覆盖」本条必红）：' + out.texts.join('|'));
  assert.ok(!out.has('接口异常'), '404 有专分支，不许落通用句：' + out.texts.join('|'));
  // 清单卡的判据用**整节点相等**：空态提示里那句「生成待清理清单。」也含这个串，includes 会误报
  assert.ok(!out.texts.includes('待清理清单'), '没补到实体就不该出现清单卡（半份数据不占位）：' + out.texts.join('|'));
  w.live.__unmount();
});

await checkAsync('cn-7 GET /clean/plan 回 ok 但没有 items 数组：同样留痕，不静默返回（D-I-5 另一形态）', async () => {
  const snapWithPlanId = { ...CN_SNAP, clean: { phase: 'ready', planId: 'plan-y', plan: 'plan-y' } };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(snapWithPlanId)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/clean/logs', reply: () => jsonRes({ ok: true, data: [] }) },
    { url: '/sysops/api/clean/unfinished', reply: () => jsonRes({ ok: true, data: [] }) },
    { url: '/sysops/api/quarantine', reply: () => jsonRes({ ok: true, data: { dirs: 0, files: 0, bytes: 0, oldest: null } }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: true, data: { items: [], off: [] } }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: {} } }) },
    // 半份应答：ok:true 但 data 里根本没有 items —— 不分支就会静默返回（界面少一张卡却无人报错）
    { url: '/sysops/api/clean/plan', reply: () => jsonRes({ ok: true, data: { plan: 'plan-y' } }) },
  ]);
  w.render();
  await cnTick();
  w.click('C 盘清理')();
  w.render();
  await cnTick();
  const out = w.render();
  assert.ok(out.has('接口异常'), 'ok 但没 items 的半份应答也要可见：' + out.texts.join('|'));
  assert.ok(out.has('plan-y'), '报错要说清是哪个清单没数据：' + out.texts.join('|'));
  assert.ok(!out.texts.includes('待清理清单'), 'ok 但没 items 的半份应答同样不许立起清单卡：' + out.texts.join('|'));
  w.live.__unmount();
});

/**
 * 接线证人用的三个驱动器（Task 23/24 的容器侧）：
 * 桩 React 没有 DOM，所以「用户在输入框里打字」用给 input vnode 的 ref 挂现值来等价表达
 * —— client.js 读的正是 `ref.current.value`，挂上去就是真机那条路径，不是给测试开的后门。
 * 按钮定位要区分「包含」与「全等」：页签「文件搜索」也含「搜索」二字，includes 会点错。
 */
/**
 * 接线证人用的驱动器（Task 23/24 的容器侧）。桩 React 没有 DOM，所以「用户在输入框里打字」
 * 用给 input vnode 的 ref 挂现值来等价表达 —— client.js 读的正是 `ref.current.value`，
 * 挂上去走的就是真机那条路径，不是给测试开的后门。
 * 关键约束：**挂值与取 onClick 必须同一次遍历** —— 活体桩的 hook 槽位按 cursor 顺序落，
 * 跨两次遍历拿到的 ref 对象与按钮闭包里的 ref 会落到不同槽位，值就写不进去（现证：分两次走时 sentRule.n 是空串）。
 * 按钮定位要区分「包含」与「全等」：页签「文件搜索」也含「搜索」二字，includes 会点错。
 */
function kids(n) {
  if (typeof n.type === 'function') return [n.type(n.props || {})];
  const list = Array.isArray(n.children) && n.children.length ? n.children : [(n.props || {}).children];
  return list;
}
function fillAndClick(root, needle, value, btnText) {
  const res = { boxDone: false, click: null };
  const go = (n) => {
    if (res.click || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const k of n) go(k); return; }
    const p = n.props || {};
    if (n.type === 'input' && !res.boxDone && String(p.placeholder || '').includes(needle)) {
      if (!p.ref) p.ref = { current: null };
      p.ref.current = { value };
      res.boxDone = true;
    }
    if (n.type === 'button' && (n.children || []).filter((c) => typeof c === 'string').join('') === btnText
      && typeof p.onClick === 'function') { res.click = p.onClick; return; }
    go(kids(n));
  };
  go(root);
  return res;
}
function findClickExact(root, text) {
  const out = [];
  const go = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(go); return; }
    if (n.type === 'button') {
      const t = (n.children || []).filter((c) => typeof c === 'string').join('');
      if (t === text && typeof n.props.onClick === 'function') out.push(n.props.onClick);
    }
    go(kids(n));
  };
  go(root);
  return out.length === 1 ? out[0] : null;
}
await checkAsync('cn-8 搜索页接线：进页现读探针与 prefs，点「搜索」发的是输入框现值而不是上一条 q', async () => {
  const PROBE_DOWN = { at: 1, installed: false, http: false, es: false, e2e: false, ready: false, via: null, degraded: true, level: null,
    checks: [
      { key: 'installed', label: '① 已安装 Everything', ok: false, detail: '未在常见安装路径找到 Everything.exe，es.exe 也不可用（未探到已安装）' },
      { key: 'http', label: '② HTTP 查询通路（:3417）', ok: false, detail: 'HTTP 探测超时（1500ms）' },
      { key: 'es', label: '② es.exe 查询通路', ok: false, detail: '未找到 es.exe（不在 PATH，可在设置页指定路径）' },
      { key: 'walk', label: '③ 本地遍历兜底', ok: true, detail: '可遍历已选目录（非全盘索引）' },
    ] };
  const PROBE_UP = { ...PROBE_DOWN, installed: true, http: true, e2e: true, ready: true, via: 'http', degraded: false, level: 'e2e' };
  const RES_WALK = { rows: [{ name: 'report.pdf', dir: 'F:\\dsh-plugins', size: 2048, mtime: 1_700_000_000_000, source: 'walk', path: 'F:\\dsh-plugins\\report.pdf' }],
    source: 'walk', sourceLabel: '本地遍历', truncated: false, stale: false, note: '', error: null, took: 7300, limit: 50 };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/search/probe', reply: () => jsonRes({ ok: true, data: PROBE_DOWN }) },
    { url: '/sysops/api/search/reprobe', method: 'POST', reply: () => jsonRes({ ok: true, data: PROBE_UP }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: { search: { mode: 'walk', limit: 50, walkDirs: ['F:\\dsh-plugins'] } } } }) },
    { url: '/sysops/api/search', reply: () => jsonRes({ ok: true, data: RES_WALK }) },
  ]);
  w.render();
  await cnTick();
  w.render();
  const tabBtn = w.click('文件搜索');
  assert.ok(tabBtn, '没找到「文件搜索」页签');
  tabBtn();
  w.render();
  await cnTick();
  const out = w.render();
  const calls = () => JSON.stringify(w.log.map((e) => e.method + ' ' + e.url));
  assert.ok(w.log.some((e) => e.method === 'GET' && e.url === '/sysops/api/search/probe'), '进搜索页必须现读探针：' + calls());
  assert.ok(w.log.some((e) => e.method === 'GET' && e.url === '/sysops/api/prefs'), '覆盖范围与通路参数在 prefs 里，必须现读：' + calls());
  assert.ok(out.has('① 已安装 Everything'), '自检三行要渲染出来：' + out.texts.join('|'));
  assert.ok(out.has('如何拿到全盘秒级搜索'), '未就绪时引导卡在场：' + out.texts.join('|'));
  assert.ok(out.has('F:\\dsh-plugins'), 'prefs 的 walkDirs 要画成覆盖范围 chips：' + out.texts.join('|'));
  w.render();
  const t1 = fillAndClick(w.live.__root, '输入关键字', 'report .pdf', '搜索');
  assert.ok(t1.boxDone, '搜索输入框没挂 ref，容器拿不到现值');
  assert.ok(t1.click, '没找到「搜索」按钮（或它不唯一）');
  t1.click();
  await cnTick();
  const q = w.log.find((e) => e.method === 'GET' && e.url.split('?')[0] === '/sysops/api/search');
  assert.ok(q, '点「搜索」必须发 GET /api/search：' + calls());
  assert.ok(/[?&]q=report%20\.pdf/.test(q.url), '发的必须是输入框现值，不是 props.q（上一条查询）：' + q.url);
  assert.ok(/[&]mode=walk/.test(q.url) && /[&]limit=50/.test(q.url), 'mode/limit 取进页读回的 prefs.search：' + q.url);
  const out2 = w.render();
  assert.ok(out2.has('report.pdf'), '结果行要落地：' + out2.texts.join('|'));
  assert.ok(out2.has('本地遍历'), '每条结果带来源 pill（宿主 sourceLabel 原样）：' + out2.texts.join('|'));
  const reprobe = findClickExact(w.live.__root, '重新检测');
  assert.ok(reprobe, '没找到「重新检测」按钮');
  reprobe();
  await cnTick();
  assert.ok(w.log.some((e) => e.method === 'POST' && e.url === '/sysops/api/search/reprobe'), '重新检测必须 POST reprobe：' + calls());
  const out3 = w.render();
  assert.ok(!out3.has('如何拿到全盘秒级搜索'), '探针真的换成就绪后引导卡该收起（不是文案没刷新）：' + out3.texts.join('|'));
  w.live.__unmount();
});

/**
 * 批 F 接线证人（C-1 / I-1 / I-2）用的两个取 props 驱动器：
 * 开关与输入框都不在 walk 的收集范围里（walk 只收按钮），这里从 vnode 树直接拿 props。
 * 与 fillAndClick 同一套遍历语义：函数组件按当前 props 展开，标题/占位符做定位锚。
 */
function collectProps(root, tag, pred) {
  const out = [];
  const go = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const k of n) go(k); return; }
    if (n.type === tag && pred(n.props || {})) out.push(n.props);
    for (const k of kids(n)) go(k);
  };
  go(root);
  return out;
}
const findSwitchByTitle = (root, title) =>
  collectProps(root, 'button', (p) => String(p.className || '').includes('so-switch') && p.title === title)[0] || null;
const findInputByPlaceholder = (root, needle) =>
  collectProps(root, 'input', (p) => String(p.placeholder || '').includes(needle))[0] || null;

/** lib/prefs/store.js 里一条真形状历史全量记录（prefsRecord 整行：五组 + updatedAt）。 */
const CN_FULL = () => ({
  collect: { cadence: '5s', keepMinutes: 30 },
  sources: { l0: true, l1a: true, l1b: false, l2: true },
  clean: { quarantineDir: 'F:\\sysops-quarantine', keepDays: 7, after: 'log' },
  search: { mode: 'everything', port: 3417, walkDirs: [], limit: 200 },
  alerts: {},
  updatedAt: 1700000000000,
});
/** 设置页接线世界的公共路由：prefs 走可变服务端记录（POST 后服务端现值真的被改掉），rules 默认空。 */
function cnSettingsWorld(ruleRows) {
  const server = { rec: CN_FULL() };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: true, data: ruleRows || { items: [], off: [] } }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: server.rec } }) },
    { url: '/sysops/api/prefs', method: 'POST', reply: ({ init }) => {
        server.rec = JSON.parse(String(init.body)).prefs;
        return jsonRes({ ok: true, data: { prefs: JSON.parse(JSON.stringify(server.rec)) } });
      } },
  ]);
  w.server = server;
  w.entries = () => w.log.map((e) => e.method + ' ' + e.url.split('?')[0]);
  w.enterSettings = async () => {
    w.render(); await cnTick(); w.render();
    const tab = findClickExact(w.live.__root, '设置') || w.click('设置');
    assert.ok(tab, '没找到「设置」页签');
    tab(); w.render(); await cnTick(); w.render();
  };
  return w;
}

await checkAsync('cn-9 设置页写路径是读-并-写（C-1/Ruling-105）：写 sources 一个键，其余四组逐字幸存，且读是现读', async () => {
  const FULL = CN_FULL();
  const w = cnSettingsWorld();
  await w.enterSettings();
  const sw = findSwitchByTitle(w.live.__root, '切换 进程榜采集');
  assert.ok(sw, 'L1b 源开关不在场');
  const getsBefore = w.entries().filter((s) => s === 'GET /sysops/api/prefs').length;
  sw.onClick();
  await cnWait(() => w.entries().includes('POST /sysops/api/prefs'));
  const posts = w.entries().filter((s) => s === 'POST /sysops/api/prefs').length;
  assert.equal(posts, 1, '一次开关只该发一次写');
  const postIdx = w.entries().lastIndexOf('POST /sysops/api/prefs');
  const lastGetIdx = w.entries().lastIndexOf('GET /sysops/api/prefs');
  assert.ok(lastGetIdx < postIdx, 'POST 前必须有一次「现读」GET（不许拿缓存 setPrefs 当读的那一份）：' + JSON.stringify(w.entries()));
  assert.ok(w.entries().filter((s) => s === 'GET /sysops/api/prefs').length >= getsBefore + 1,
    '写的「读」腿必须是点击后新发的 GET：' + JSON.stringify(w.entries()));
  const body = JSON.parse(String(w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/prefs')[0].body));
  assert.ok(body && body.prefs && typeof body.prefs === 'object', 'POST 体应为 {prefs: 完整记录}');
  // 整行写回：没动的四组必须逐字幸存（写Many 是整行覆盖，差量直写会把它们抹掉——评审 tmp/prefs_roundtrip 实证的形状）
  assert.deepEqual(body.prefs.collect, FULL.collect, 'collect 组被差量写抹掉了');
  assert.deepEqual(body.prefs.clean, FULL.clean, 'clean 组被差量写抹掉了');
  assert.deepEqual(body.prefs.search, FULL.search, 'search 组被差量写抹掉了');
  assert.deepEqual(body.prefs.alerts, FULL.alerts, 'alerts 组被差量写抹掉了');
  // 本次动的 sources 组：只翻 l1b，其余三键保持现值
  assert.equal(body.prefs.sources.l1b, true, '要写的键没写进去');
  assert.equal(body.prefs.sources.l0, FULL.sources.l0);
  assert.equal(body.prefs.sources.l1a, FULL.sources.l1a);
  assert.equal(body.prefs.sources.l2, FULL.sources.l2);
  // 写成功后界面吃服务端回的全量：L1b 开关真实落到开位
  w.render();
  const sw2 = findSwitchByTitle(w.live.__root, '切换 进程榜采集');
  assert.equal(sw2['aria-checked'], 'true', '写成功后开关没按回的全量刷新');
  w.live.__unmount();
});

await checkAsync('cn-9b 设置页写前的现读失败：阻断整行写并把原因可见（C-1 读失败短路）', async () => {
  let gets = 0;
  const w = cnSettingsWorld();
  const origRoutes = w.log;
  // 把 prefs 的 GET 应答改写成「首次（进页）成功、第二次（写前现读）500」
  void origRoutes;
  globalThis.fetch = (async (u, init = {}) => {
    const url = String(u); const method = init.method ?? 'GET';
    w.log.push({ url, method, body: init.body, signal: init.signal ?? null });
    if (url.split('?')[0] === '/sysops/api/prefs' && method === 'GET') {
      gets += 1;
      if (gets === 1) return { ok: true, status: 200, json: async () => ({ ok: true, data: { prefs: CN_FULL() } }) };
      return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'PREFS_READ_FAILED', message: '现读失败，已挡住整行写' } }) };
    }
    if (url.split('?')[0] === '/sysops/api/prefs' && method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true, data: { prefs: CN_FULL() } }) };
    if (url.split('?')[0] === '/sysops/api/rules') return { ok: true, status: 200, json: async () => ({ ok: true, data: { items: [], off: [] } }) };
    if (url.split('?')[0] === '/sysops/api/alerts/read') return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    if (url.split('?')[0] === '/sysops/api/stream') return sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]);
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'TEST_NO_ROUTE', message: '没这条路由：' + url } }) };
  });
  await w.enterSettings();
  const sw = findSwitchByTitle(w.live.__root, '切换 进程榜采集');
  assert.ok(sw, 'L1b 源开关不在场');
  sw.onClick();
  await cnTick(80);
  assert.ok(w.entries().filter((s) => s === 'GET /sysops/api/prefs').length >= 2, '点击后要有现读：' + JSON.stringify(w.entries()));
  assert.equal(w.entries().filter((s) => s === 'POST /sysops/api/prefs').length, 0,
    '现读失败还整域写回会抹掉同域其它配置（lib/prefs/store.js:191），必须阻断');
  const out = w.render();
  assert.ok(out.has('现读失败，已挡住整行写'), '读失败必须可见（约束 4）：' + out.texts.join('|'));
  w.live.__unmount();
});

await checkAsync('cn-10 内置/本机 pill 吃宿主行的 builtin 标记（I-1/Ruling-106）：没标记就不画，不回落「本机」', async () => {
  const RULES_ROW = {
    items: [
      { id: 'u-pnpm', n: 'pnpm 未引用包', kind: '缓存', ageDays: 30, rel: 'pnpm-store/**', builtin: false },
      // 老宿主形状：行上没有 builtin 键 —— 诚实降级是不画 pill，而不是自判或回落成「本机」骗人
      { id: 'legacy-no-mark', n: '历史规则无标记', kind: '日志', ageDays: 5, rel: 'logs/**' },
    ],
    builtin: [
      { id: 'temp-user', n: '用户临时目录', kind: '缓存', ageDays: 3, rel: 'AppData/Local/Temp', builtin: true, enabled: true },
      { id: 'packages-cache', n: 'UWP 包缓存', kind: '缓存', ageDays: 60, rel: 'AppData/Local/Packages', builtin: true, enabled: false },
    ],
    off: ['packages-cache'],
    updatedAt: 11,
  };
  const w = cnSettingsWorld(RULES_ROW);
  await w.enterSettings();
  const out = w.render();
  assert.ok(out.has('用户临时目录') && out.has('pnpm 未引用包') && out.has('历史规则无标记'),
    '宿主给的行（内置+本机）都要在场：' + out.texts.join('|'));
  assert.equal(out.texts.filter((t) => t === '内置').length, 2, '「内置」pill 数量必须等于宿主标了 builtin:true 的行数');
  assert.equal(out.texts.filter((t) => t === '本机').length, 1, '「本机」只画宿主标了 builtin:false 的那一条——无标记行不许被推断成「本机」');
  assert.ok(!out.has('u-pnpm') && !out.has('legacy-no-mark'), 'id 不上界面，界面只吃宿主给的名称');
  // N-F1 证人②：本夹具含一行没带 builtin 标记（legacy-no-mark）⇒ 本机条数句不许猜数字，必须落「未确认」
  // （合并数组是 4 行；若把内置/无标记一起算进「本机规则 N 条」就是谎报，这里既不能是 4 也不能是任何具体数字）
  assert.ok(out.has('本机规则计数未确认'), '宿主没给 builtin 标记时本机条数句必须落「未确认」口径：' + out.texts.join('|'));
  assert.ok(!/本机规则 \d+ 条/.test(out.texts.join('|')), '未确认态下界面不许出现「本机规则 <数字> 条」：' + out.texts.join('|'));
  w.live.__unmount();
});

await checkAsync('cn-11 搜索通路保存链路端到端（I-2）：点「保存设置」→ 现读 → 合并 → POST → 整页重载；非法端口零写入', async () => {
  const FULL = CN_FULL();
  const w = cnSettingsWorld();
  await w.enterSettings();
  // ① 端口保存：输入框现值走 POST，未动的组逐字幸存
  const t1 = fillAndClick(w.live.__root, '3417', '3419', '保存设置');
  assert.ok(t1.boxDone, '端口输入框没挂 ref，容器拿不到现值');
  assert.ok(t1.click, '没找到「保存设置」按钮（或它不唯一）');
  t1.click();
  assert.ok(await cnWait(() => w.entries().includes('POST /sysops/api/prefs')), '点保存后没发 POST：' + JSON.stringify(w.entries()));
  let posts = w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/prefs');
  assert.equal(posts.length, 1);
  let body = JSON.parse(String(posts[0].body));
  assert.equal(body.prefs.search.port, 3419, '端口没按输入框现值写入');
  assert.deepEqual(body.prefs.search, { mode: FULL.search.mode, port: 3419, walkDirs: FULL.search.walkDirs, limit: FULL.search.limit },
    'search 组内没上报的键必须保持服务端现值');
  assert.deepEqual(body.prefs.collect, FULL.collect); assert.deepEqual(body.prefs.clean, FULL.clean);
  assert.deepEqual(body.prefs.sources, FULL.sources); assert.deepEqual(body.prefs.alerts, FULL.alerts);
  // ② 保存成功后整页重载：POST 之后又现读了 prefs 与 rules
  assert.ok(await cnWait(() => { const e = w.entries(); const pi = e.lastIndexOf('POST /sysops/api/prefs'); return e.slice(pi + 1).includes('GET /sysops/api/prefs') && e.slice(pi + 1).includes('GET /sysops/api/rules'); }),
    '保存成功后必须整页重载（不是只改本地槽位）：' + JSON.stringify(w.entries()));
  w.render();
  const inp1 = findInputByPlaceholder(w.live.__root, '3417');
  assert.equal(String(inp1.defaultValue), '3419', '重载后端口输入框要显示服务端新现值');
  // ③ esPath 保存：只动 esPath，端口用服务端现值（本轮没上报 port）
  const t2 = fillAndClick(w.live.__root, '留空 = 用 PATH', 'F:\\tools\\es.exe', '保存设置');
  assert.ok(t2.boxDone && t2.click, 'es.exe 输入框或保存按钮不在场');
  t2.click();
  assert.ok(await cnWait(() => w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/prefs').length >= 2), 'esPath 保存没发 POST');
  posts = w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/prefs');
  body = JSON.parse(String(posts[1].body));
  assert.equal(body.prefs.search.esPath, 'F:\\tools\\es.exe', 'esPath 没进合并后的整行');
  assert.equal(body.prefs.search.port, 3419, '第二轮保存把上一轮写入的端口抹掉了');
  // ④ 非法端口：可见纠错、零写入（不动服务端也不清别的组）
  const t3 = fillAndClick(w.live.__root, '3417', '0', '保存设置');
  assert.ok(t3.click, '没找到「保存设置」按钮');
  t3.click();
  await cnTick(80);
  assert.equal(w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/prefs').length, 2,
    '非法端口不许发任何写（校验在容器层拦下）');
  const out4 = w.render();
  assert.ok(out4.has('1-65535'), '非法端口必须就地可见纠错文案：' + out4.texts.join('|'));
  w.live.__unmount();
});

await checkAsync('cn-11b 无 storageDomain：搜索通路两输入框与保存按钮都禁用且原因可见（I-2 只读闸门）', async () => {
  globalThis.__SYSOPS__ = clientPayload({ capabilities: { storageDomain: false, timer: true, webServer: true, notifications: false, autostart: false } });
  try {
    const w = cnSettingsWorld();
    await w.enterSettings();
    const p = findInputByPlaceholder(w.live.__root, '3417');
    assert.equal(p.disabled, true, '只读时端口输入框必须禁用（灰显读）');
    const e = findInputByPlaceholder(w.live.__root, '留空 = 用 PATH');
    assert.equal(e.disabled, true, '只读时 es.exe 路径输入框必须禁用');
    const out = w.render();
    const saveBtn = out.buttons.find((b) => b.text === '保存设置');
    assert.ok(saveBtn, '没找到「保存设置」按钮');
    assert.equal(saveBtn.disabled, true, '只读时保存按钮必须禁用');
    assert.ok(out.has('不可用') || out.has('禁用') || out.has('只读') || out.has('storageDomain') || out.has('持久化'),
      '禁用必须伴随可见原因：' + out.texts.join('|'));
    assert.equal(w.entries().filter((s) => s === 'POST /sysops/api/prefs').length, 0);
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
});

await checkAsync('cn-12 写失败分支留痕（I-5）：POST 500 后错误可见、开关不乐观翻转、saving 不放纵按钮永久禁用', async () => {
  const w = cnSettingsWorld();
  // 覆写 fetch：prefs GET 永远成功；prefs POST 永远 500（服务端记录保持不动 = 失败无痕不写）
  globalThis.fetch = (async (u, init = {}) => {
    const url = String(u); const method = init.method ?? 'GET';
    w.log.push({ url, method, body: init.body, signal: init.signal ?? null });
    const route = url.split('?')[0];
    if (route === '/sysops/api/prefs' && method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, data: { prefs: CN_FULL() } }) };
    if (route === '/sysops/api/prefs' && method === 'POST') return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'PREFS_WRITE_FAILED', message: '磁盘忙，写偏好被拒' } }) };
    if (route === '/sysops/api/rules') return { ok: true, status: 200, json: async () => ({ ok: true, data: { items: [], off: [] } }) };
    if (route === '/sysops/api/alerts/read') return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
    if (route === '/sysops/api/stream') return sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]);
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'TEST_NO_ROUTE', message: '没这条路由：' + url } }) };
  });
  await w.enterSettings();
  const sw = findSwitchByTitle(w.live.__root, '切换 进程榜采集');
  assert.ok(sw, 'L1b 源开关不在场');
  assert.equal(sw['aria-checked'], 'false', '起点：L1b 默认关');
  sw.onClick();
  assert.ok(await cnWait(() => w.entries().includes('POST /sysops/api/prefs')), '点开关后没发写：' + JSON.stringify(w.entries()));
  await cnTick(80);
  const out = w.render();
  // ① 失败要留痕：宿主原话就地可见（约束 4：写失败不许静默）
  assert.ok(out.has('磁盘忙，写偏好被拒'), '写失败必须把宿主原因显示出来：' + out.texts.join('|'));
  // ② 不许乐观翻转：写没成，开关必须还停在 false 位（界面读的是服务端回的全量）
  const sw2 = findSwitchByTitle(w.live.__root, '切换 进程榜采集');
  assert.equal(sw2['aria-checked'], 'false', 'POST 失败后开关不许自己翻成 true：' + JSON.stringify(out.texts.slice(0, 5)));
  // ③ saving 态不许失步：失败后 setSetSaving(false) 必须到位，否则「保存设置」永久禁用（why=保存中…）
  const saveBtn = out.buttons.find((b) => b.text === '保存设置');
  assert.ok(saveBtn, '没找到「保存设置」按钮');
  assert.equal(saveBtn.disabled, false, '写失败后保存按钮不许卡在禁用（saving 未复位）');
  assert.ok(!out.has('保存中…'), '失败路径之后不许残留「保存中…」：' + out.texts.join('|'));
  // ④ 服务端记录真的没动（500 的写不进仓储）
  assert.equal(w.server.rec.sources.l1b, false, '失败的 POST 不该改到服务端现值');
  w.live.__unmount();
});

await checkAsync('cn-13 设置页「本机规则 N 条」只数宿主标为非内置的行，内置不进计数、读不到不落数字（复评 N-F1）', async () => {
  const marked = (id, b) => ({ id, n: id + '规则', kind: '缓存', ageDays: 1, rel: id + '/**', builtin: b, enabled: true });
  const BUILTIN_12 = Array.from({ length: 12 }, (_, i) => marked('b' + i, true));
  const enter = async (w) => {
    w.render(); await cnTick(); w.render();
    const tab = findClickExact(w.live.__root, '设置') || w.click('设置');
    assert.ok(tab, '没找到「设置」页签');
    tab(); w.render(); await cnTick(); return w.render();
  };
  // ① 真机形状：12 条内置 + 2 条本机（都带 builtin 标记）⇒ 界面读数须是「本机规则 2 条」，内置那 12 行不进这个数
  const w1 = cnSettingsWorld({ builtin: BUILTIN_12, items: [marked('u1', false), marked('u2', false)], off: [] });
  const out1 = await enter(w1);
  assert.ok(out1.has('本机规则 2 条'), '两条本机规则的读数必须是「本机规则 2 条」：' + out1.texts.join('|'));
  assert.ok(!out1.has('本机规则 14 条') && !out1.has('本机规则 4 条'), '内置行不许被算进本机条数（14/4 都是谎报）：' + out1.texts.join('|'));
  assert.equal(out1.texts.filter((t) => t === '内置').length, 12, '12 条内置 pill 与「本机规则 2 条」并存才自洽');
  w1.live.__unmount();
  // ③ 本机规则全部清空（items: []，内置仍在）⇒ 落「本机规则已全部清空」而不是把内置念成「本机规则 12 条」
  const w2 = cnSettingsWorld({ builtin: BUILTIN_12, items: [], off: [] });
  const out2 = await enter(w2);
  assert.ok(out2.has('本机规则已全部清空'), '本机清空态必须落「已全部清空」：' + out2.texts.join('|'));
  assert.ok(!out2.has('本机规则 12 条'), '已清空时不许把 12 条内置念成「本机规则 12 条」：' + out2.texts.join('|'));
  w2.live.__unmount();
  // null 规则接口整体读不到 ⇒ 未确认/未写入态如实措辞，绝不落一个具体数字
  const w3 = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: false, error: { code: 'RULES_READ_FAILED', message: '规则读不到' } }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: CN_FULL() } }) },
  ]);
  const out3 = await enter(w3);
  assert.ok(out3.has('本机尚未写入清理规则'), '读不到时落「本机尚未写入清理规则」的未确认态：' + out3.texts.join('|'));
  assert.ok(!/本机规则 \d+ 条/.test(out3.texts.join('|')), '读不到态下界面不许出现「本机规则 <数字> 条」：' + out3.texts.join('|'));
  w3.live.__unmount();
});

/* ⑦段：设置页 —— 开关、规则、能力表与只读闸门
 *    简报把本段写在 test/plugin.test.mjs（追加 ⑦段），控制器明令页面用例落本文件（口径：用例 id、名称、断言照简报）。
 *    夹具 PREFS 逐键照 Task 3 prefsRecord（含 Task 12 的 clean 组）：sources 与 collect 同级；
 *    quarantineDir 只会是展开后的绝对路径（schema 拒 %...%），esPath 经 normalize 后是 undefined 而非 ''。 */
SET = CLIENT.__test.settings;
globalThis.__SYSOPS__ = clientPayload();

const PREFS = (over = {}) => ({ collect: { cadence: '1s', keepMinutes: 30 },
  sources: { l0: true, l1a: true, l1b: false, l2: true },
  clean: { quarantineDir: 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine', keepDays: 7, after: 'log' },
  search: { mode: 'everything', port: 3417, esPath: undefined, walkDirs: [], limit: 200 },
  alerts: {}, ...over });
const CAPS_OK = { storageDomain: true, timer: true, webServer: true, notifications: false, autostart: false };
const CAP_ROWS = [
  { key: 'storageDomain', label: 'storageDomain（持久化）', ok: true, detail: '', fallback: '' },
  { key: 'timer', label: 'timer（ctx.interval）', ok: true, detail: '', fallback: '' },
  { key: 'webServer', label: 'webServer（路由 + index-inject）', ok: true, detail: '', fallback: '' },
  { key: 'notifications', label: '系统通知（托盘）', ok: false, detail: '', fallback: '宿主不提供' },
  { key: 'autostart', label: '开机自启常驻', ok: false, detail: '', fallback: '宿主不提供' },
];
const SPAGE = (over = {}) => walk(SET.SettingsPage({ prefs: PREFS(), rules: [], caps: CAPS_OK, capRows: CAP_ROWS, snap: null, err: null, saving: false,
  onPatch() {}, onRuleAdd() {}, onRuleToggle() {}, onRuleRemove() {}, onSave() {}, ...over }));

check('pg4-1 四源行齐（L0/L1a/L1b/L2），每行带层级 pill 与代价说明', () => {
  const rows = SET.SOURCE_ROWS(PREFS(), null);
  assert.deepEqual(rows.map((r) => r.key), ['l0', 'l1a', 'l1b', 'l2']);
  assert.ok(rows[0].tier.includes('L0') && rows[1].tier.includes('L1a') && rows[2].tier.includes('L1b') && rows[3].tier.includes('L2'));
  assert.ok(rows[0].desc.includes('不起任何子进程'));
  assert.ok(rows[1].desc.includes('暖身') && rows[1].desc.includes('219ms'));
  assert.ok(rows[2].desc.includes('640ms'));
});

check('pg4-2 L0 没有开关（档位由监控页控），L1b 默认关', () => {
  const rows = SET.SOURCE_ROWS(PREFS(), null);
  assert.equal(rows[0].switch, null, 'L0 的开关是档位 seg，不在这里重复一个入口');
  assert.equal(rows[2].switch.on, false, '实测代价决定默认关（spec §1.1 决策 7）');
  assert.equal(rows[1].switch.on, true);
});

check('pg4-3 关掉某一源 → 依赖它的规则在设置页也标不可用（与监控页同一个 st）', () => {
  const snap = { alerts: { rules: [{ rule: { id: 'r4', n: '下行持续 > 20 MB/s 满 1 分钟', dep: 'l1a' }, st: { dim: true, on: false, st: '依赖的采集已关闭' } }] } };
  const out = SPAGE({ snap });
  assert.ok(out.has('依赖的采集已关闭'));
  assert.ok(out.has('关掉某一源，依赖它的告警规则会就地标为不可用'));
});

check('pg4-4 规则行 pill 分内置/本机，guard 拒绝项标「已被 guard 拒绝」且开关禁用', () => {
  const rules = [
    { id: 'temp-user', n: 'AI 助手临时目录 scoped_dir*', glob: '%TEMP%\\scoped_dir*', ageDays: 0, kind: '临时目录', builtin: true, enabled: true },
    { id: 'u-pnpm', n: 'pnpm 未引用包', glob: '%LocalAppData%\\pnpm-store\\**', ageDays: 30, kind: '缓存', builtin: false, enabled: true },
    { id: 'u-bin', n: '回收站', glob: 'C:\\$Recycle.Bin\\*', ageDays: 1, kind: '缓存', builtin: false, enabled: false, guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } },
    // Ruling-106：宿主没给 builtin 的行（老接口形状）—— pill 必须是空串（不画），不许自判、更不许回落成「本机」
    { id: 'legacy-no-mark', n: '历史规则无标记', glob: '%LOCALAPPDATA%\\x\\*', ageDays: 2, kind: '日志', enabled: true },
  ];
  const cells = SET.ruleCells(rules);
  assert.deepEqual(cells.map((c) => c.pill), ['内置', '本机', '本机', '']);
  assert.equal(cells[2].blocked, true);
  assert.ok(cells[2].denyWhy.includes('回收站一律不参与'));
  const out = SPAGE({ rules });
  assert.ok(out.has('已被 guard 拒绝'));
  assert.ok(out.classHas('so-rule-dim'));
  assert.equal(out.texts.filter((t) => t === '本机').length, 2, '无标记行不许画「本机」pill');
});

check('pg4-5 黑名单 notice 逐字吃注入载荷的 redlines（单源，不抄第二份）', () => {
  globalThis.__SYSOPS__ = clientPayload({ redlines: ['不碰回收站（2026-09-13 曾因按普通目录处理导致属主与 ACL 被改坏）', '不碰 C:\\Windows\\*', '不碰 Program Files', '不动注册表'] });
  try {
    const out = SPAGE({});
    for (const line of globalThis.__SYSOPS__.redlines) assert.ok(out.has(line.slice(0, 8)), `缺红线 ${line}`);
    assert.ok(out.has('不可移除的黑名单'));
    const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
    assert.ok(!code.includes('takeown'), 'client.js 不该自带第二份红线文案（含事故日期那种长句）');
    // Minor：占位符不许带本机用户名（此前 pnpm 占位符写死 C:\Users\gongj\…）
    assert.ok(!code.includes('gongj'), 'client.js 源码里不该出现任何个人用户名（占位符须用 %LocalAppData% 这类通用形）');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
});

check('pg4-6 新增规则的拒绝文案就地落，不弹浮层', () => {
  const out = SPAGE({ err: { source: 'rules/add', status: 403, code: 'SYSOPS_RULE_GUARD_DENY', message: '已拒绝写入：该 glob 命中红线（系统目录 / 回收站）。guard 在校验阶段就拦下，不会进入规则库。' } });
  assert.ok(out.has('已拒绝写入'));
  assert.ok(out.classHas('so-notice-red'));
  assert.ok(out.buttons.filter((b) => b.text.includes('保存并启用')).length === 1, '新增按钮只有一个');
});

check('pg4-7 暂存目录渲染 prefs 实配值 + 到期提醒不自动删 + after 两档', () => {
  const out = SPAGE({});
  assert.ok(out.has('C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine'), '显示 prefs 的实配值（prefs 里只会是展开后的绝对路径，`prefq-1` 已拒未展开形）');
  assert.ok(!out.has('%LOCALAPPDATA%'), '界面不得把 `%...%` 当可配置值展示：prefs schema 里它不可能存在');
  assert.ok(out.has('到期提醒，不自动删'));
  assert.ok(out.has('什么都不做') && out.has('写一条留痕并刷新曲线'));
});

check('pg4-8 搜索通路两字段 + 降级说明（不静默换源）', () => {
  const out = SPAGE({});
  assert.ok(out.has('HTTP 端口'));
  assert.ok(out.has('es.exe 路径'));
  assert.ok(out.has('不静默换源'));
  assert.ok(out.has('拿旧结果冒充') === false || out.has('不拿旧结果冒充'));
});

check('pg4-9 能力表五行齐，「宿主不提供」的两行没有开关', () => {
  const cells = SET.capCells(CAP_ROWS);
  assert.equal(cells.length, 5);
  assert.deepEqual(cells.map((c) => c.hasSwitch), [false, false, false, false, false], '能力表只报事实，给开关就是假开关');
  assert.ok(cells[3].value === '宿主不提供' && cells[4].value === '宿主不提供');
  assert.ok(cells[0].value === '提供');
});

check('pg4-10 timer 降级那行必须把"退到 setInterval 且必须显式 stop"说出来', () => {
  const rows = CAP_ROWS.map((r) => (r.key === 'timer' ? { ...r, ok: false, detail: '宿主无 ctx.interval，已退到 setInterval', fallback: '已降级' } : r));
  const cells = SET.capCells(rows);
  assert.match(cells[1].value, /已降级/);
  assert.match(cells[1].detail, /setInterval/);
});

check('pg4-11 无 storageDomain：保存按钮禁用 + 原因，且 501 的 code 翻成中文而不是抛', () => {
  const s = SET.SAVE_DISABLED(PREFS(), { ...CAPS_OK, storageDomain: false }, null);
  assert.equal(s.disabled, true);
  assert.match(s.why, /配置只读|未提供 storageDomain/);
  const out = SPAGE({ caps: { ...CAPS_OK, storageDomain: false }, err: { source: 'prefs', status: 501, code: 'PREFS_UNAVAILABLE', message: '没有 storageDomain' } });
  const b = out.buttons.find((x) => x.text.includes('保存设置'));
  assert.equal(b.disabled, true);
  assert.ok(out.has('501') || out.has('只读'));
});

check('pg4-12 保存只发差量：patchBody 包一层 prefs，不整包回传', () => {
  assert.deepEqual(SET.patchBody({ collect: { cadence: '5s' } }), { prefs: { collect: { cadence: '5s' } } });
  assert.ok(!('clean' in JSON.parse(JSON.stringify(SET.patchBody({ collect: { cadence: '5s' } }))).prefs));
});

check('pg4-13 规则三态区分 null（从未写入）与 []（用户清空）', () => {
  assert.match(SET.ruleStateText(null), /尚未配置|未写入/);
  assert.match(SET.ruleStateText([]), /已全部清空/);
});

check('pg4-14 能力表渲染证人：五行逐行消费 capRows，「宿主不提供」与「已降级」都得上屏，缺载荷走空态（N1）', () => {
  const out = SPAGE({});
  for (const row of CAP_ROWS) assert.ok(out.has(row.label), '能力行 label 没上屏：' + row.label + '；实际：' + out.texts.join('|'));
  assert.equal(out.texts.filter((t) => t === '提供').length, 3, 'ok:true 三行该画「提供」pill');
  assert.equal(out.texts.filter((t) => t === '宿主不提供').length, 2, 'NEVER_PROVIDED 两行该画「宿主不提供」灰 pill');
  // 非 never-provided 的 ok:false ⇒ 琥珀 pill 显示 fallback 原文，detail 逐字上屏
  const deg = SPAGE({ capRows: [{ key: 'timer', label: 'timer（ctx.interval）', ok: false, detail: '宿主无 ctx.interval，已退到 setInterval', fallback: '已降级' }] });
  assert.ok(deg.has('已降级'), '降级态必须可见：' + deg.texts.join('|'));
  assert.ok(deg.has('宿主无 ctx.interval，已退到 setInterval'), 'detail 必须逐字渲染');
  // 载荷没给 ⇒ 诚实空态，不许自编五行
  const none = SPAGE({ capRows: [] });
  assert.ok(none.has('宿主未下发能力表。'), 'capRows 缺省该落空态而不是假数据');
  assert.ok(!none.has('storageDomain（持久化）'), '空载荷不许残留默认行');
});

check('pg4-15 数据采集四行渲染证人：四个源名上屏、L0 无开关只有档位说明、全页开关恰 3 个（N2/M5）', () => {
  const out = SPAGE({});
  for (const name of ['实时曲线（CPU / 内存 / 磁盘）', '网速采集', '进程榜采集', '按需扫描 / 搜索']) {
    assert.ok(out.has(name), '源行名称没上屏：' + name + '；实际：' + out.texts.join('|'));
  }
  assert.equal(out.texts.filter((t) => t === '档位由监控页控制').length, 1, 'L0 不重复开关，只留这一句说明');
  const sw = out.buttons.filter((b) => String(b.className).includes('so-switch'));
  assert.equal(sw.length, 3, '四源行里恰好 3 个开关（L0 排除）；实际 ' + sw.length + ' 个');
  assert.ok(out.has('关掉某一源，依赖它的告警规则会就地标为不可用'), '卡片副题要在场（与 pg4-3 同一句话单源）');
});

check('pg4-16 I-6 统一闸门（设置页）：capsReadOnly 决策表 + 缺键 fail-closed + 保存禁用伴随可见原因', () => {
  // 三页共用同一个判定函数 —— 决策表先钉死
  assert.equal(SET.capsReadOnly({ storageDomain: true }), false);
  assert.equal(SET.capsReadOnly({ storageDomain: false }), true);
  assert.equal(SET.capsReadOnly({}), true, '缺键必须按只读处理（fail-closed），不许放开写');
  assert.equal(SET.capsReadOnly(null), true);
  assert.equal(SET.capsReadOnly(undefined), true);
  assert.equal(SET.capsReadOnly('nope'), true, '载荷不是对象同样只读');
  const s = SET.SAVE_DISABLED(PREFS(), {}, null);
  assert.equal(s.disabled, true, 'caps 缺 storageDomain 时闸门必须关');
  assert.match(s.why, /配置只读：宿主未提供 storageDomain/);
  // 渲染层：按钮真禁用 + 原因真可见（变异「闸门改回 === false」在 caps:{} 下两断言同时红）
  const out = SPAGE({ caps: {} });
  const b = out.buttons.find((x) => x.text === '保存设置');
  assert.ok(b, '没找到「保存设置」按钮');
  assert.equal(b.disabled, true);
  assert.ok(out.has('配置只读：宿主未提供 storageDomain'), '禁用必须伴随可见原因：' + out.texts.join('|'));
  const ok = SPAGE({ caps: CAPS_OK });
  const b2 = ok.buttons.find((x) => x.text === '保存设置');
  assert.equal(b2.disabled, false, 'storageDomain:true 时闸门必须开（双向可证）');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
