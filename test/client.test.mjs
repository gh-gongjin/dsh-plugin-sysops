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
  // order 故意取 7：兜底默认是 12（client.js 的 PANEL_ORDER），写死或读兜底都会让下面那条断言红。
  globalThis.__SYSOPS__ = { panelId: 'sysops', label: '系统运维', panelOrder: 7, routePrefix: '/sysops', api: '/sysops/api', capabilities: { storageDomain: true, timer: true, webServer: true }, cadences: ['1s', '5s', 'paused'], sourceKeys: ['l0', 'l1a', 'l1b', 'l2'], redlines: [], searchAdvice: [], defaults: {} };
  const c = clientCtx();
  CLIENT.apply(c);
  const nav = c.reg.find((r) => r.opts?.name === 'sidebar.panellist');
  const page = c.reg.find((r) => r.opts?.name === 'main');
  assert.ok(nav && page, '缺注册');
  assert.equal(nav.opts.id, page.opts.key);
  assert.equal(nav.opts.id, 'sysops');
  assert.equal(nav.opts.order, 7, 'order 必须吃注入载荷而不是写死（7 ≠ 兜底 12，两者同值就分不出真假）');
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

check('cf-6 五页签 label 与已确认原型逐字一致（S15-②：监控记录独立成第 2 页）', () => {
  const tabs = CLIENT.__test.nav.map((t) => t.t);
  assert.deepEqual(tabs, ['资源监控', '监控记录', 'C 盘清理', '文件搜索', '设置']);
  // 一份真相的另一半：原型的页签条必须同序同字，否则「与原型逐字一致」这句只覆盖了四页
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  const protoTabs = [...proto.matchAll(/<button class="tab[^"]*" data-tab="([a-z]+)">([^<]+)<\/button>/g)]
    .map((m) => ({ k: m[1], t: m[2] }));
  assert.deepEqual(protoTabs.map((t) => t.t), tabs, '原型页签文字与 client 页签文字逐字比对');
  assert.deepEqual(protoTabs.map((t) => t.k), CLIENT.__test.nav.map((t) => t.k), '原型页签 key 与 client 页签 key 同序');
});

/* cf-6c（S16-③）：页签改名「触发记录 → 监控记录」是一次跨半边文案改动，钉三件事：
   ① **只改 label 不改 key** —— `alerts` 是宿主路由 / SSE 事件名 / 存储域的键，跟着界面文案一起改
      就把一次改名扩散成跨半边的重命名（改名不该动数据）；
   ② 旧名在**可见文案**里清零（client.js 去注释后、原型、宿主 rules/service 源码里都不许再出现），
      钉去注释后的源码：S13 记过的坑 —— 「源码里出现过这几个字」不等于「那条语句还在」，
      注释里的历史提法不该被当成残留，也不该被当成在场。
   ③ 落点四处（宿主规则 note + 设置页三处）必须跟着改口，否则设置页还在往一个不存在的页签名指路。 */
check('cf-6c 页签改名只动 label 不动 key，旧名在可见文案里清零（S16-③）', () => {
  const nav = CLIENT.__test.nav;
  assert.deepEqual(nav.map((n) => n.k), ['monitor', 'alerts', 'clean', 'search', 'settings'], '内部键一个都不许跟着界面改名');
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.ok(!/触发记录/.test(code), 'client.js 可见文案里不许留旧页签名');
  const proto = stripComments(fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, ''));
  assert.ok(!/触发记录/.test(proto), '原型（spec 那一半）必须同改，否则 spec 与实现分叉');
  for (const f of ['lib/alerts/rules.js', 'lib/alerts/service.js']) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    assert.ok(!/触发记录/.test(src), f + ' 交出去给用户看的句子必须说新页签：' + f);
  }
  assert.match(code, /h\('h2', null, '监控记录'\)/, '卡头跟着页签名走');
});

/* cf-6b（S15-⑥）：原型的页签路由只许有一份清单。截图核对抓到「点第 2 个页签弹回资源监控」——
   面板与按钮都加了，hash 白名单还是四个 key 的旧数组；未知 hash 走初始 activate 时更会把五个
   面板全隐藏成白屏。钉法：清单从按钮派生、两处入口都过校验、每个 key 有对应面板。 */
check('cf-6b 原型页签路由单点：清单由 tabs 按钮派生，hash 入口都过校验，无第二份手写数组', () => {
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.equal((proto.match(/var TABS = Array\.prototype\.map\.call\(el\('tabs'\)\.children/g) || []).length, 1,
    '页签清单只有一处，且是从 tabs 按钮现取（不是再抄一份数组）');
  assert.match(proto, /function goTab\(hash\) \{ var t = \(hash \|\| '#monitor'\)\.replace\('#', ''\); return TABS\.indexOf\(t\) >= 0 \? t : 'monitor'; \}/,
    '校验只认派生清单里的 key，认不得就回监控页');
  assert.equal((proto.match(/activate\(goTab\(location\.hash\)\)/g) || []).length, 2,
    'hashchange 与初始定位两处入口都过 goTab —— 少一处就是未知 hash 白屏');
  assert.match(proto, /TABS\.forEach\(function \(k\) \{/, 'activate 关面板也吃同一份清单');
  // 手写清单的复发口：任何形如「'monitor', 'xxx'…」的四/五元数组字面量都不该再出现在路由里
  assert.equal((proto.match(/'monitor',\s*'/g) || []).length, 0, '原型里不许再出现手写的页签 key 数组');
  for (const m of proto.matchAll(/<button class="tab[^"]*" data-tab="([a-z]+)">/g)) {
    assert.ok(proto.includes(`id="panel-${m[1]}"`), `页签 ${m[1]} 没有对应的 #panel-${m[1]}，切过去就是空白`);
    assert.ok(new RegExp(`\\n\\s+${m[1]}: `, '').test(proto), `页签 ${m[1]} 缺页头文案/按钮区（subs 或 mainActions）`);
  }
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

/**
 * cf-11（S19-① 改过口径）：交互控件仍然全自研，唯一的原生例外是清理页那颗分类下拉 ——
 * 用户点名「使用下拉选择」，所以这里既不许退回「一颗 select 都不许有」（那条会挡住用户要的东西），
 * 也不许放开成「随便用原生控件」（弹层满天飞正是这条规则当初立起来的原因）。
 * 钉法：全文件 `h('select'` 恰好一次，且那一颗挂的就是 .so-cat-select（类名与 CSS 单点同出处）。
 */
check('cf-11 交互全自研，唯一原生例外是分类下拉：不出现 confirm( / alert(，select 只许一颗', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /\bconfirm\s*\(|\balert\s*\(/);
  assert.doesNotMatch(code, /<select/i);
  assert.equal(code.split("h('select'").length - 1, 1, '原生 select 只许分类下拉那一颗：多一颗就是往「无浮层」的口径里掺水');
  assert.match(code, /h\('select', \{[\s\S]{0,120}className: 'so-cat-select'/, '那颗 select 必须就是分类下拉，别拿它给别的字段开原生弹层');
});

check('cf-12 无顶部浮层：CSS 与组件里都没有 toast/notice-bar 类实现（spec §4.7 就地落卡）', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /toast|Toast|notice-bar|noticeBar|position:fixed[^]*top:\s*\d/, '出现浮层实现');
});

/**
 * cf-13：DOM 属性名必须用 React 驼峰形，连字符名字只允许 aria-* / data-*（React 保留这两族原样）。
 * 为什么单开一条源码级用例：**桩 React 不校验属性名**，`stroke-width` 这种写法在 98 条桩用例里全绿，
 * 直到 25-C 的离线预览页用真 React(dev) 渲染才逐条报 `Invalid DOM property`（SysopsPanelIcon 报 3 条）。
 * 桩测不出、预览页又不入库 ⇒ 把这条不变量钉在源码上，防止再退化。
 */
check('cf-13 DOM 属性名用 React 驼峰：源码里连字符键只允许 aria-* / data-*', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  const bad = (code.match(/'[a-z][a-z0-9]*-[a-z0-9-]*':/g) || []).filter((k) => !/^'(aria|data)-/.test(k));
  assert.deepEqual(bad, [], '真 React 会对这些连字符属性名报 Invalid DOM property：' + JSON.stringify(bad));
});

/**
 * cf-14：清单/搜索表在窄视口必须「表格撑住 + 外层横向滚动」，不能把路径列压扁折行。
 *
 * 为什么单开一条源码级用例：桩 React 没有布局，99 条桩用例量不出宽度。
 * 25-C 用真布局预览量到过反例：620 档表格被压到容器宽 467px、路径列只剩 103px 折成 4 行、
 * `.so-tblwrap` 的 scrollWidth 等于 clientWidth（没滚动）；同一视口下原型 499→879 是横向滚动的。
 * 根因是 `.so-path{word-break:break-all}` 让单元格最小内容宽度退化成一个字符。
 * 这里把「机制的两半」一起钉住：外层可滚 + 表格内路径不折。任一半被删，行为就退化。
 */
check('cf-14 表格窄视口横向滚动：.so-tblwrap 可滚 + .so-tbl 内路径列不折行', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /\.so-tblwrap\{[^}]*overflow-x:\s*(auto|scroll)/,
    '外层容器必须可横向滚动，否则表格只能被压扁');
  assert.match(code, /\.so-tbl\s+\.so-path\{[^}]*white-space:\s*nowrap/,
    '表格上下文里的路径列必须禁止折行，否则最小内容宽度退化、表格被压扁到容器宽度');
});

/* cf-15（S16-①）：虚线样式。真机批注「虚线样式不好看」指的是悬停引导线 ——
   它和阈值线都画成 `3 3` 虚线，一个"现在是哪一点"、一个"越过没有"，两种意思同一个长相，
   看着就是一团杂线。修法让它们靠虚实分工：阈值线保持虚线（它是约定俗成的"参考线"长相），
   引导线改实线、只用透明度退到背景里。这里把「分工」钉住：引导线不许再有 dasharray，
   阈值线的 dasharray 一处也不能少 —— 反向退化（两条都实线）同样算不合格。 */
check('cf-15 悬停引导线实线、阈值线虚线：两条线的虚实分工（S16-①）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.match(css, /^\.so-tip-line\{stroke-width:1;opacity:\.28\}$/m,
    'client 引导线：实线 + 透明度退到背景，不带 dasharray');
  assert.match(proto, /^\.tip-line\{stroke-width:1;opacity:\.28\}$/m, '原型同规');
  assert.doesNotMatch(css, /so-tip-line[^\n]*dasharray/i,
    '引导线一旦回到虚线，就和阈值线撞成同一种线了');
  assert.match(css, /key: 'th',[^\n]*strokeDasharray: '3 3'/, '阈值线仍是 3 3 虚线（改的只有引导线）');
  assert.match(proto, /<line x1="0" y1="' \+ ty \+ '"[^\n]*stroke-dasharray="3 3"/, '原型阈值线同上');
  // 引导线的实线要靠 non-scaling-stroke 才不被 viewBox 拉伸成 1.54px 的粗线
  assert.match(css, /className: 'so-tip-line', vectorEffect: 'non-scaling-stroke'/, '引导线仍带 non-scaling-stroke');
  assert.match(proto, /<line class="tip-line"[^\n]*vector-effect="non-scaling-stroke"/, '原型引导线同上');
});

/* ④段：监控页 —— 纯函数级视图助手 + 组件渲染遍历 */
const { walk, render, clientPayload } = await import('./render-fixtures.mjs');
MON = CLIENT.__test.monitor;
globalThis.__SYSOPS__ = clientPayload();

/**
 * 在渲染树里按 className 找**第一个**节点，返回节点本身（不是 walk 的扁平结果）。
 * walk() 只给摊平的 texts/classes，验「A 包着 B」这种嵌套形状必须拿原始树，
 * 所以这里给一个能递归进子树的查找器；用法：先在外层找 wrap，再在 wrap 里找 inner。
 */
function findClassIn(node, cls) {
  if (!node || typeof node !== 'object') return null;
  const classes = Array.isArray(node) ? [] : String((node.props && node.props.className) || '').split(' ').filter(Boolean);
  if (classes.includes(cls)) return node;
  const kids = Array.isArray(node) ? node : (node.children || []);
  for (const k of kids) {
    const found = findClassIn(k, cls);
    if (found) return found;
  }
  return null;
}

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
    // `enabled` 是宿主源行的开关意图（lib/collect/service.js 的 switches），设置页那颗开关读它
    // 而不是读浏览器自己存的 prefs 原行（S18-①）。l2 那一行宿主根本不出（非常驻源），
    // 这里留着它只喂源条的用例，不许给它补一个宿主没有的 `enabled`。
    sources: [
      { key: 'l0', label: '实时曲线', state: 'on', enabled: true, detail: '1s · 主进程内', restarts: 0, pid: null, stderrTail: '' },
      { key: 'l1a', label: '网速采集', state: 'on', enabled: true, detail: 'typeperf 运行中', restarts: 0, pid: 19304, stderrTail: '' },
      { key: 'l1b', label: '进程榜', state: 'off', enabled: false, detail: '已关闭', restarts: 0, pid: null, stderrTail: '' },
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

check('pg1-1 四指标行序与名称逐字固定，网速单位跟着量级自适应（S16-②）', () => {
  const rows = MON.mtrRows(SNAP());
  assert.deepEqual(rows.map((r) => r.n), ['CPU 使用率', '内存', 'C 盘可用', '网络吞吐']);
  assert.equal(rows[3].v, '12.5');
  assert.equal(rows[3].u, 'MB/s');
  assert.match(rows[3].c, /上行 2\.40 MB\/s/);
});

check('pg1-2 禁止照抄原型的 /8：12 500 000 字节/秒 必须是 12.5 MB/s 而不是 1.6', () => {
  assert.equal(MON.mtrRows(SNAP()).find((r) => r.n === '网络吞吐').v, '12.5', '原型曲线的 /8 是 bit 口径演示值');
  assert.equal(CLIENT.__test.fmtRate(12_500_000), '12.5 MB/s');
});

/* pg1-2b（S16-②）：真机症状复现。latest.netDown 实测 7030 B/s（tmp/s16-net.txt），
   旧口径固定 /1e6 + toFixed(1) ⇒ 恒等于 "0.0 MB/s"，采集在动而界面读成不动。
   两条都要钉：换算本身自适应（rateParts / fmtRate），**以及卡面不许把单位写死**
   —— 上一版是 `fmtRate(v).split(' ')[0]` + `u: 'MB/s'`，就算换算修好了，卡面仍会把 KB/s 标成 MB/s。 */
check('pg1-2b KB/s 量级不许再被折成 0.0：数值与单位同源，卡面不硬写 MB/s（S16-②）', () => {
  const T = CLIENT.__test;
  assert.deepEqual(T.rateParts(7030.7423), { n: '7.03', u: 'KB/s' });
  assert.deepEqual(T.rateParts(0), { n: '0', u: 'B/s' });
  assert.deepEqual(T.rateParts(999), { n: '999', u: 'B/s' });
  assert.deepEqual(T.rateParts(1_000), { n: '1.00', u: 'KB/s' });
  assert.deepEqual(T.rateParts(1_050_000_000), { n: '1.05', u: 'GB/s' });
  assert.deepEqual(T.rateParts(null), { n: '—', u: '' }, '读不到就只出破折号，不许配一个单位');
  assert.equal(T.fmtRate(7030.7423), '7.03 KB/s');
  assert.equal(T.fmtRate(null), '—');
  const net = MON.mtrRows(SNAP({ latest: { cpu: 1, mem: 1, diskFreeGb: 71.9, diskTotalGb: 200, netDown: 7030.7423, netUp: 13648.549217, t: 3 } }))[3];
  assert.deepEqual([net.v, net.u], ['7.03', 'KB/s'], '卡面大数字与单位：' + JSON.stringify(net));
  assert.equal(net.c, '下行 · 上行 13.6 KB/s');
  // 源码锁（去掉注释后比）：卡面这一行不许再出现写死的 'MB/s' 单位，也不许 split 掉换算给的单位。
  // 网络行在源码里折了两行（v/u 一行、c 一行），锁必须吃掉整行对象，只锁第一行等于没锁住 c 那半。
  const mtrSrc = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  const netRowM = /\{\s*key: 'net',[\s\S]*?cls: '' \}/.exec(mtrSrc);
  assert.ok(netRowM, '没找到 mtrRows 的网络行，源码锁失效');
  const netRow = netRowM[0];
  assert.doesNotMatch(netRow, /'MB\/s'/, '单位必须来自 rateParts，不许硬写：' + netRow);
  assert.doesNotMatch(netRow, /\.split\(/, '不许 split 掉换算交出的单位：' + netRow);
  assert.match(netRow, /fmtRate\(num\(l\.netUp\)\)/, '「上行」那半也必须走同一个换算，不许另一套口径：' + netRow);
  // 换算只许有一处：卡面大数字之外还有三个显示口（曲线卡副标题、悬停气泡、命中正文），
  // 每一口都曾有各自的一行 /1e6 或 /8 —— 留一处私有算式就是留一个 0.0 MB/s 的复发口。
  assert.doesNotMatch(mtrSrc, /\/\s*1e6|\/\s*1_000_000|\/\s*1024\s*\*\s*1024/,
    'client.js 里不许再有私有的字节→MB 算式，一律走 rateParts/fmtRate');
  assert.equal((mtrSrc.match(/(?<!function )fmtRate\(/g) || []).length, 5,
    '网速显示五个调用（卡面副标题 / 曲线卡副标题 / 悬停气泡的下行与上行 / 命中正文）都得到店，少一个就是那一处还在自己算：' + (mtrSrc.match(/(?<!function )fmtRate\(/g) || []).length);
  // 原型同规：它是指认实现的图纸，图纸上留着 `(v / 8)` 那种一行式换算，下一轮照抄就又错一遍。
  const protoSrc = stripComments(fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(protoSrc, /\/\s*1e6|\/\s*1_000_000|\/ 8\)\.toFixed/,
    '原型半边不许再有一行式字节→MB 换算，一律走 ratePartsB');
  assert.equal((protoSrc.match(/var u = \['KB\/s', 'MB\/s', 'GB\/s'\]/g) || []).length, 1,
    '原型单位阶梯只许一份（两份就会漂出不同口径）');
  // 换算的「一份真相」两边各一份、逐字同式：档位进制与位数规则都在这儿钉住。
  assert.match(protoSrc, /do \{ x \/= 1000; i \+= 1; \} while \(x >= 1000 && i < u\.length - 1\);/,
    '原型速率档位必须走十进制（与 client 的 rateParts 同口径，容量才是 1024）');
  assert.match(protoSrc, /return \{ n: x >= 100 \? x\.toFixed\(0\) : x\.toFixed\(x >= 10 \? 1 : 2\), u: u\[i\] \};/,
    '原型位数规则与 client 同源：≥100 出整数、≥10 一位、其余两位');
  assert.equal(mtrSrc.includes('do { x /= 1000; i += 1; } while (x >= 1000 && i < u.length - 1);'), true,
    'client 侧同一条阶梯（上面钉的是原型，这一句钉的是实现自己，防止只改图纸）');
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

/** 把 SNAP 的 l1b 源行改成某个状态（宿主推 `sources` 帧时就是整行换掉，形状一致）。 */
const SNAP_L1B = (state, over) => SNAP({
  sources: SNAP().sources.map((r) => (r.key === 'l1b' ? { ...r, state, ...over } : r)),
});

const PROC_ROWS = [
  { pid: 7412, name: 'idea64.exe', ws: 4.1e9, cpuPct: 11.2 },
  { pid: 11384, name: 'Chrome.exe', ws: 2.4e9, cpuPct: 92.4 },
];

check('pg1-10 进程榜开启：表头四列 + 按 cpuPct 排序 + 「不结束进程」的理由卡', () => {
  const snap = SNAP_L1B('on', { pid: 35620 });
  snap.proc = { rows: PROC_ROWS, note: '上限 400 行 · 已截断' };
  const out = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(out.has('PID') && out.has('CPU%') && out.has('内存') && out.has('来源'));
  assert.ok(out.texts.indexOf('Chrome.exe') < out.texts.indexOf('idea64.exe'), '必须按 CPU 降序');
  assert.ok(out.has('本插件不提供「结束进程」'), out.texts.join('|'));
  assert.ok(out.has('已截断'));
});

check('pg1-10b 进程榜状态只认 sources 的 l1b 行：proc.state 冻在 off 也要出榜（S17-① 那条批注）', () => {
  // 真机形状：宿主的 proc 帧**从不带 state**（lib/collect/service.js 三处 emit 只有 rows/note/t），
  // 而快照首帧的 proc.state 是开榜**之前**算的 off。旧卡片拿它当分支 ⇒ 400 行在手仍写「未开启」。
  const out = walk(MON.MonitorPage({
    snap: Object.assign(SNAP_L1B('on', { pid: 35620 }), { proc: { rows: PROC_ROWS, state: 'off', note: '' } }),
    link: 'sse',
  }));
  assert.ok(out.has('Chrome.exe'), 'sources 说 on 就必须出榜：' + out.texts.join('|'));
  assert.ok(!out.has('进程榜采集未开启'), '卡片不许再读那个冻住的 proc.state');
});

check('pg1-10c sources 说 off 而 proc.state 说 on：不许画榜（状态只有一份，读错源就是假陈述）', () => {
  const out = walk(MON.MonitorPage({
    snap: Object.assign(SNAP_L1B('off'), { proc: { rows: PROC_ROWS, state: 'on', note: '' } }),
    link: 'sse',
  }));
  assert.ok(!out.has('Chrome.exe'), '源已停还画榜 = 拿残值冒充实时（宿主 clearProc 的同一条理由）');
  assert.ok(out.has('进程榜采集未开启'), out.texts.join('|'));
});

check('pg1-10d 进程榜空态五分支各说一句真话（S17-①：首轮实测 4.3s，这段不许说「未开启」）', () => {
  const t = (snap) => walk(MON.MonitorPage({ snap, link: 'sse' })).texts.join('|');
  const off = t(SNAP_L1B('off'));
  assert.ok(off.includes('进程榜采集未开启') && off.includes('现在开启'), off);
  const starting = t(SNAP_L1B('starting'));
  assert.ok(starting.includes('正在起第一轮') && starting.includes('4.3'), starting);
  assert.ok(!starting.includes('未开启') && !starting.includes('现在开启'), '启动中再给一颗开启按钮 = 用户以为没点上：' + starting);
  const noRows = t(SNAP_L1B('on'));
  assert.ok(noRows.includes('已开启，还没出第一轮数据'), noRows);
  assert.ok(!noRows.includes('未开启'), '「已开启等数据」与「未开启」是两件事：' + noRows);
  const stalledSnap = SNAP_L1B('stalled');
  const stalledOut = walk(MON.MonitorPage({ snap: stalledSnap, link: 'sse' }));
  const stalled = stalledOut.texts.join('|');
  assert.ok(stalled.includes('进程榜已停') && stalled.includes('重试'), stalled);
  assert.ok(stalledOut.buttons.some((b) => b.text === '重试'),
    '卡片那句「用上方「进程榜」的「重试」」指的就是这颗按钮；源条没有它，这句话就是假承诺（S17-① 截图核对抓到）');
  const unknown = t(SNAP({ sources: SNAP().sources.filter((r) => r.key !== 'l1b') }));
  assert.ok(unknown.includes('状态未确认') && !unknown.includes('未开启'), '没有源行就说没拿到，不替宿主编一个 off：' + unknown);
});

check('pg1-10e 空态也要露 note；「展开进程榜会自动开启」这句假话两边源码清零（S17-①）', () => {
  const out = walk(MON.MonitorPage({
    snap: Object.assign(SNAP_L1B('stalled'), { proc: { rows: [], note: '非 JSON 行（PowerShell 告警或进度）：Get-CimInstance : 拒绝访问' } }),
    link: 'sse',
  }));
  assert.ok(out.has('拒绝访问'), 'note 只在表格分支渲染 = 把唯一线索扔了：' + out.texts.join('|'));
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  const proto = stripComments(fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(src, /本页展开进程榜时会自动开启/, '没有任何「展开即自动开启」的逻辑，这句是假承诺');
  assert.doesNotMatch(proto, /本页展开进程榜时会自动开启/, '原型同规');
  // 源码锁：卡片分支只许读 sources 的 l1b 行，不许再读 proc.state
  assert.doesNotMatch(src, /proc\.state/, 'proc.state 是增量帧里不存在的字段，读它就是 S17-① 的根因');
  assert.equal((src.match(/sourceRow\(snap, 'l1b'\)/g) || []).length, 1, 'l1b 源行只取一处，两处各取会各自演化');
  // 源条的重试集合：stalled 必须在内（卡片指向它），且两边同形
  assert.match(src, /c\.state === 'crashed' \|\| c\.state === 'stalled'/, '采集源条的重试条件被改窄 ⇒ 卡片那句指路的「重试」落空');
  assert.match(proto, /s\.state === 'stalled' \|\| s\.state === 'crashed' \|\| s\.state === 'exited-max'/, '原型源条的停摆重试入口（S17-② 两边同形）');
  assert.match(proto, /data-proc-retry/, '原型重试按钮的落点标记');
  // 原型空态单点：文案只由 procEmpty 出，页面里不许再抄第二份（S15 的「两份清单各自演化」同一类）
  assert.equal((proto.match(/进程榜采集未开启/g) || []).length, 1, '原型未开启那句只许出现一次（在 procEmpty 里）');
  assert.equal((src.match(/进程榜采集未开启/g) || []).length, 1, 'client 同规');
});

check('pg1-10f mergeFrame 的 proc 帧不再凭空造 state 键（S17-① 的另一半：冻住的值就是从这儿来的）', () => {
  const base = { proc: { rows: [], state: 'off', note: '' } };
  const next = CLIENT.__test.mergeFrame(base, 'proc', { rows: PROC_ROWS, note: '', t: 123 });
  assert.equal(next.proc.rows.length, 2);
  assert.equal('state' in next.proc, false, '帧里没有的字段不许自己补一个 —— 补了就没人知道它是旧的');
  assert.equal(base.proc.rows.length, 0, '合并不许就地改旧快照');
  // 只带 note 的帧（宿主的「非 JSON 行」告警就是这么发的）不许把上一轮的榜清空
  const keep = CLIENT.__test.mergeFrame({ proc: { rows: PROC_ROWS, note: '' } }, 'proc', { note: '非 JSON 行 3 条', t: 124 });
  assert.equal(keep.proc.rows.length, 2, '缺 rows 要沿用旧榜，不是清空 —— 清空等于让一次告警把画面抹了');
  assert.equal(keep.proc.note, '非 JSON 行 3 条');
});

/**
 * pg1-10g（S17-②）：原型那半边的进程榜状态机接线。
 * 用户看的是原型这版画面 —— 实现修好了、图纸仍写「点了就立刻有榜」，下一轮照图纸改实现就把症状搬回来。
 * 钉四件事：① 开启必须先渲染 starting 再等定时器换榜；② 定时器不许抢回已被关掉的那一轮；
 * ③ 初始一屏与重试入口都走同一个 procEmpty/setProc；④ 五句文案两边逐字同口径。
 */
check('pg1-10g 原型进程榜状态机接线：starting 先行、守卫不抢、重试有入口、五句两边同口径（S17-②）', () => {
  const proto = stripComments(fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  const one = (re, why) => assert.equal((proto.match(re) || []).length, 1, why + ' :: ' + re);
  one(/el\('procBody'\)\.innerHTML = procEmpty\('starting'\);/g, '开启后必须先画「正在起第一轮」');
  one(/el\('procBody'\)\.innerHTML = procEmpty\('off'\);/g, '关闭那一支画「未开启」');
  one(/el\('procBody'\)\.innerHTML = procEmpty\(srcs\.l1b\.state\);/g, '初始一屏也走 procEmpty，不留第二份文案');
  const iStart = proto.indexOf("procEmpty('starting')");
  const iTable = proto.indexOf("el('procBody').innerHTML = procTable();");
  assert.ok(iStart > -1 && iTable > iStart, 'starting 必须排在换榜之前（同一函数里的先后就是画面先后）');
  one(/if \(srcs\.l1b\.state !== 'starting'\) return;/g, '迟到定时器不许把已关掉的那一轮抢回来');
  one(/closest\('\[data-proc-retry\]'\)\) setProc\(true\);/g, '源条「重试」的入口接线');
  one(/closest\('\[data-proc-on\]'\)\) setProc\(true\);/g, '空态「现在开启」的入口接线');
  // 五句文案：两边各一份、逐字同口径（首轮秒数两边各自是常量，比到数字前为止）
  const PHRASES = [
    '进程榜状态未确认：宿主没给 l1b 这一源行。',
    '进程榜采集未开启。',
    '进程榜正在起第一轮：常驻 PowerShell 冷启动，实测约 ',
    '进程榜已开启，还没出第一轮数据（',
    '进程榜已停：',
  ];
  for (const p of PHRASES) {
    assert.ok(src.includes(p), 'client 缺这一句：' + p);
    assert.ok(proto.includes(p), '原型缺这一句：' + p);
  }
});

/* S18-③（真机批注「按 CPU 使用率降序排列，支持点击 cpu 和内存进行排序」）：排序先当纯函数验，
   再接到表头上验。排序态本身归容器，所以这里显式传 procSort，页面只负责按它画。 */
check('pg1-10h 排序助手是纯函数：默认 CPU 降序、读不到的行永远沉底、同值按 PID 定序（S18-③）', () => {
  const M = CLIENT.__test.monitor;
  assert.deepEqual(M.PROC_SORT_COLS, [{ k: 'cpuPct', t: 'CPU%' }, { k: 'ws', t: '内存' }],
    '两列的键就是宿主行的字段名，文案与表体那两列逐字一致');
  assert.deepEqual(M.procSortNext({ k: 'cpuPct', d: 'desc' }, 'ws'), { k: 'ws', d: 'desc' }, '点另一列 = 换列并回降序');
  assert.deepEqual(M.procSortNext({ k: 'ws', d: 'asc' }, 'ws'), { k: 'ws', d: 'desc' }, '点已选中的那一列 = 只翻方向');
  assert.deepEqual(M.procSortNext(undefined, 'cpuPct'), { k: 'cpuPct', d: 'desc' }, '没有态也给默认口径');
  const rows = [
    { pid: 3, name: 'c.exe', ws: 100, cpuPct: 5 },
    { pid: 1, name: 'a.exe', ws: 300, cpuPct: 5 },
    { pid: 2, name: 'b.exe', ws: 200, cpuPct: null },
  ];
  const pids = (sort) => M.procSortedRows(rows, sort).map((r) => r.pid);
  assert.deepEqual(pids({ k: 'cpuPct', d: 'desc' }), [1, 3, 2], '同值按 PID 定住（否则每帧 SSE 重画就换一次位置），cpuPct 为 null 的沉底');
  assert.deepEqual(pids({ k: 'cpuPct', d: 'asc' }), [1, 3, 2], '升序也不许把「—」顶到第一行：像 0 也像最高，两种假读数');
  assert.deepEqual(pids({ k: 'ws', d: 'desc' }), [1, 2, 3], '换列就按那一列排，ws 有值的那行不参与沉底');
  assert.deepEqual(pids({ k: 'ws', d: 'asc' }), [3, 2, 1]);
  assert.deepEqual(pids(undefined), [1, 3, 2], '缺排序态 = CPU 降序，与容器初值同口径');
  assert.deepEqual(pids({ k: 'bogus', d: 'asc' }), [1, 3, 2], '未知列回落 cpuPct，不拿 rows.bogus 的 undefined 去比');
  assert.deepEqual(rows.map((r) => r.pid), [3, 1, 2], '排序不许就地改宿主给的数组');
  assert.deepEqual(M.procSortedRows(undefined, null), [], '没有行给空表，不炸');
});

check('pg1-10i 进程榜卡内滚动 + 表头点击排序（S18-③）：限高/吸顶/aria-sort/点的是列键，原型同口径', () => {
  const snap = SNAP_L1B('on');
  snap.proc = { rows: PROC_ROWS, note: '' };
  const hits = [];
  const vnode = MON.MonitorPage({ snap, link: 'sse', procSort: { k: 'ws', d: 'desc' }, onProcSort: (k) => hits.push(k) });
  const out = walk(vnode);
  assert.ok(out.classes.includes('so-tblwrap so-tblwrap-proc'),
    '进程榜要挂自己的限高容器（独立滚动层，S16 教训）：' + out.classes.join('|'));
  assert.ok(out.texts.indexOf('idea64.exe') < out.texts.indexOf('Chrome.exe'),
    '按 ws 降序时榜要跟着换列重排：' + out.texts.join('|'));
  const ths = byClass(vnode, 'th', 'so-r so-th-sort');
  assert.equal(ths.length, 2, '只有 CPU% 与内存两列可点，进程/PID/来源不动');
  assert.equal(ths[0].props['aria-sort'], 'none', '未选中的列报 none，不许冒充降序');
  assert.equal(ths[1].props['aria-sort'], 'descending', 'aria-sort 挂在 th（ARIA 的位置），当前列要报方向');
  const clickCpu = findClick(vnode, 'CPU%');
  assert.equal(typeof clickCpu, 'function', '表头按钮必须真接 onClick');
  clickCpu();
  assert.deepEqual(hits, ['cpuPct'], '点击发出的是列键，裁决在容器');
  const dflt = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(dflt.texts.indexOf('Chrome.exe') < dflt.texts.indexOf('idea64.exe'), '不传排序态也按 CPU 降序（与容器初值同口径）');

  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /\.so-tblwrap-proc\{[^}]*max-height:[^;}]+;[^}]*overflow:\s*auto/,
    '限高 + 自己滚：用户批注「不要整页滚动，只在框内滚动」');
  assert.match(code, /\.so-tblwrap-proc\s+\.so-tbl\s+thead\s+th\{[^}]*position:\s*sticky/,
    '限高之后表头必须吸顶，否则滚到中段不知道哪列是什么');
  assert.ok(code.includes('点 CPU% / 内存 表头可换排序'), '卡头要说得出这个入口，否则没人知道表头能点');

  const protoRaw = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  const proto = stripComments(protoRaw).replace(/<!--[\s\S]*?-->/g, '');
  assert.match(proto, /\.tbl-wrap-proc\{[^}]*max-height:[^;}]+;[^}]*overflow:\s*auto/, '原型同口径限高');
  assert.match(proto, /\.tbl-wrap-proc\s+\.tbl\s+thead\s+th\{[^}]*position:\s*sticky/, '原型同口径吸顶');
  assert.ok(protoRaw.includes('class="tbl-wrap tbl-wrap-proc"'), '原型榜的容器挂同一类');
  assert.ok(protoRaw.includes('data-sort-col') && protoRaw.includes('aria-sort'), '原型排序入口也在表头');
  assert.doesNotMatch(protoRaw, /id="procSort"|data-sort="(cpu|mem)"/, '旧的「按 CPU / 按内存」seg 必须删净：两套入口就是两套真相');
  assert.ok(protoRaw.includes('点 CPU% / 内存 表头可换排序'), '卡头那句话两边逐字同口径');
  /* 原型的排序判定是图纸的承重件（S18-③「两边同改」）。图纸不像 client 能被 require 出来跑，
     所以这里把四条判据按字面钉住：改口就得同时改这一处，否则红。位置也一起钉 —— 
     aria-sort 挂在 th 还是挂在 button 上，字符串一眼就能分辨。 */
  assert.ok(protoRaw.includes('<th class="r th-sort" aria-sort="'), '原型的 aria-sort 同样挂在 th（挂在 button 上读屏不认）');
  assert.ok(protoRaw.includes(`'<button type="button" data-sort-col="' + k + '"'`),
    '表头发出的属性名逐字钉住：代理监听认的是 [data-sort-col]（prototype/index.html:1280），改一边就断线。旧 seg 的键名也叫 data-sort，所以那条 doesNotMatch 挡不住把属性名换回去');
  assert.ok(protoRaw.includes("var procSort = { k: 'cpu', d: 'desc' };"), '原型默认排序 = CPU 降序，与容器初值同口径');
  assert.ok(protoRaw.includes("if (cur.k !== key) return { k: key, d: 'desc' };"), '原型点另一列 = 换列回降序');
  assert.ok(protoRaw.includes("return { k: key, d: cur.d === 'desc' ? 'asc' : 'desc' };"), '原型点已选中的那一列 = 只翻方向');
  assert.ok(protoRaw.includes("var dir = procSort.d === 'asc' ? 1 : -1;"), '原型的方向系数只认这一处');
});

check('pg1-11 规则置灰吃宿主的 st 三态，页面绝不自己比 source.state', () => {
  const snap = SNAP({ alerts: { unread: 0, rules: [RULE('r4', '下行持续 > 20 MB/s 满 1 分钟', 'l1a', { dim: true, on: false, st: '依赖的采集已关闭' }), RULE('r5', '单进程 CPU > 60%', 'l1b', { dim: false, on: false, st: '已暂停' }), RULE('r1', 'CPU ≥ 85% 连续 3 次', 'l0', { dim: false, on: true, st: '监控中' })], hits: [] } });
  // S5（真机反馈「配置不该长在监控页」）：规则列表 + 新建表单整块搬到设置页 —— 三态只在设置页渲染
  const out = walk(CLIENT.__test.settings.SettingsPage({ prefs: {}, rules: [], snap, err: null, saving: false }));
  assert.ok(out.has('依赖的采集已关闭') && out.has('已暂停') && out.has('监控中'));
  assert.equal(out.classHas('so-rule-dim'), true);
  const mon = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(!mon.has('依赖的采集已关闭') && !mon.has('已暂停') && !mon.has('监控中'),
    '阈值告警的配置（含只读状态行）一律不许再出现在监控页：' + mon.texts.join('|'));
  const src = CLIENT.__test.monitor.srcCells(snap, 'sse');
  assert.equal(src.find((c) => c.key === 'l1a').state, 'on', '置灰只跟随 st，不跟随本行 state 的直觉');
});

check('pg1-11b 监控页既无告警配置也无监控记录：配置在设置页，时间线在监控记录页（S15-②）', () => {
  const snap = SNAP({ alerts: { unread: 0, rules: [RULE('r1', 'CPU ≥ 85% 连续 3 次', 'l0', { dim: false, on: true, st: '监控中' })], hits: [] } });
  const mon = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(!mon.buttons.some((b) => b.text.includes('保存规则')), '「保存规则」按钮不该在监控页');
  assert.ok(!mon.has('阈值 / 持续') && !mon.has('提示落点'), '新建表单字段不该在监控页');
  assert.ok(!mon.has('监控记录'), '监控记录整块搬去第 2 页签：监控页底部不许留半张时间线');
  assert.ok(!mon.has('本机保留最近 200 条'), '200 条上限那句话跟着时间线一起走');
  const al = walk(MON.AlertsPage({ snap, err: null }));
  assert.ok(al.has('监控记录') && al.has('规则在设置页配置'), '监控记录页承接时间线并指路设置页');
});

check('pg1-12 触发时间线两类行（hit 带数值、op 带操作），且标出 200 条上限', () => {
  const snap = SNAP({ alerts: { unread: 2, rules: [], hits: [
    { hitId: 'h-1', t: 1_700_000_000_000, kind: 'hit', ruleName: 'CPU ≥ 85% 连续 3 次', metric: 'cpu', value: 92.4, note: '连续 3 次' },
    { hitId: 'h-2', t: 1_700_000_000_000, kind: 'op', text: '你将实时曲线采样档位切为 5s' },
  ] } });
  const out = walk(MON.AlertsPage({ snap, err: null }));
  assert.ok(out.has('92.4'));
  assert.ok(out.has('CPU ≥ 85% 连续 3 次'));
  assert.ok(out.has('你将实时曲线采样档位切为 5s'));
  assert.ok(out.has('本机保留最近 200 条'));
});

/**
 * pg1-12b（S15-②用户裁定的第三项）：记录时刻**绝对 + 相对并列**。
 * 只要相对时间就答不出「哪天炸的」，只要绝对时间就得自己算多久以前 —— 两列同屏，
 * 且两列都由同一个 `t` 派生（hitStamp 与 fmtAge 吃同一个数），不许一处用 t 一处用别处。
 */
check('pg1-12b 时间线每行 = 绝对时刻 + 相对时间两列，同源派生', () => {
  const t0 = 1_700_000_000_000;
  const snap = SNAP({ alerts: { unread: 1, rules: [], hits: [
    { hitId: 'h-1', t: t0, kind: 'hit', ruleName: 'C 盘可用 < 15%', metric: 'diskFreePct', value: 12.1, note: '冷却 24 小时' },
  ] } });
  const out = walk(MON.AlertsPage({ snap, err: null }));
  assert.ok(out.has(MON.hitStamp(t0)), '绝对时刻列上屏：' + MON.hitStamp(t0));
  assert.ok(out.classHas('so-tl-ago'), '相对时间是独立一列（灰字），不是拼在正文里');
  assert.equal(MON.hitStamp(t0).length, 11, 'MM-DD HH:MM 定长 11 字，缺时间戳时是「—」');
  assert.equal(MON.hitStamp(null), '—', '没有 t 就说没有，不编一个时刻');
  // 两边同改：原型那行的两列也必须一个吃 hitStamp、一个吃 hitAgo，且都吃同一个 h.t。
  // 用户看的是原型这版画面，原型若只剩相对时间，下一轮照它重做就会把「哪天炸的」丢掉。
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.equal((proto.match(/hitStamp\(h\.t\)/g) || []).length, 1, '原型行首的绝对时刻列只能有一处，且不许被换成 hitAgo');
  assert.match(proto, /class="tt num">' \+ hitStamp\(h\.t\)/, '绝对时刻是行首那列（tt num）');
  assert.match(proto, /class="ago">' \+ hitAgo\(h\.t\)/, '相对时间是它后面独立那个灰字 span');
});

/**
 * pg1-12c（S15-②的就地筛选）：全部 / 最近 24 小时 / 最近 7 天。
 * 口径两条：① 筛选只筛显示不动数据；② 开了窗口后**没带时间戳的记录进不了窗口**，
 * 差额必须在 `X / Y 条` 读数里看得见（诚实降级，不静默丢行）。
 */
check('pg1-12c 监控记录三档就地筛选：窗口只筛显示，无时间戳的行差额摆在读数上', () => {
  // 用真钟当基准：AlertsPage 内部就是 Date.now()，写一个未来时刻的假 now 会让「三天前」落进未来而通过 24h 窗口。
  const now = Date.now();
  const hits = [
    { hitId: 'a', t: now - 60_000, kind: 'op', text: '一分钟前' },
    { hitId: 'b', t: now - 3 * 86_400_000, kind: 'op', text: '三天前' },
    { hitId: 'c', kind: 'op', text: '没有时刻' },
  ];
  assert.equal(MON.hitsInRange(hits, '', now).length, 3, '「全部」一档不改行数');
  assert.equal(MON.hitsInRange(hits, '24h', now).length, 1, '24h 只剩一分钟前那条');
  assert.equal(MON.hitsInRange(hits, '7d', now).length, 2, '7d 收进三天前那条，仍不收没时刻那条');
  assert.equal(MON.ALERT_RANGES.map((r) => r.t).join('/'), '全部/最近 24 小时/最近 7 天');
  const snap = SNAP({ alerts: { unread: 0, rules: [], hits } });
  const out = walk(MON.AlertsPage({ snap, err: null, range: '24h', onRange: () => {} }));
  assert.ok(out.has('1 / 3 条'), '窗口态页头报「筛后 / 全部」，差额看得见：' + out.texts.join('|'));
  assert.ok(out.has('一分钟前') && !out.has('三天前'), '窗口外的行不画，但数据没被动过');
  const all = walk(MON.AlertsPage({ snap, err: null, range: '', onRange: () => {} }));
  assert.ok(all.has('3 条') && all.has('三天前'), '切回全部就是全量读数');
  const none = walk(MON.AlertsPage({ snap: SNAP({ alerts: { unread: 0, rules: [], hits: [{ hitId: 'b', t: now - 3 * 86_400_000, kind: 'op', text: '三天前' }] } }), err: null, range: '24h' }));
  assert.ok(none.has('最近 24 小时内没有监控记录'), '窗口内没记录要说窗口，不许说成本机没记录：' + none.texts.join('|'));
  assert.ok(none.has('全部 1 条还在本机记录里'), '退路（切回全部）要写在那句话里');
  assert.ok(!none.has('本机还没有监控记录'), '窗口空 ≠ 本机没记录过，两种空态文案必须分开');
});

/* pg1-12d（S16-④）：监控记录只在卡内滚动，不顶整页。真机 29 条把页面撑到两屏，
   页签与卡头被顶出视野（用户原话与 S10-② 清单表同一句：「只在当前框内滚动，不要整页滚动」）。
   钉三层：① 渲染树里滚动容器**包着**时间线（不是把 overflow 加在 .so-tl 自己身上 ——
   那条竖线 ::before 是绝对定位，容器自己 overflow 会把竖线钉死在可视框上，滚两行就与圆点脱节）；
   ② CSS 三条都在（max-height / overflow / overscroll-behavior）；③ 原型同规（.tl-wrap 包 .tl）。 */
check('pg1-12d 监控记录列表包在卡内滚动层里，竖线不跟着滚，原型同规（S16-④）', () => {
  const now = Date.now();
  const hits = Array.from({ length: 29 }, (_, i) => ({ hitId: 'h' + i, t: now - i * 3_600_000, kind: 'op', text: '第 ' + i + ' 条' }));
  const tree = MON.AlertsPage({ snap: SNAP({ alerts: { unread: 0, rules: [], hits } }), err: null, range: '', onRange: () => {} });
  const wrap = findClassIn(tree, 'so-tlwrap');
  assert.ok(wrap, '渲染树里没有 .so-tlwrap：列表又变成常驻全高了');
  const inner = findClassIn(wrap, 'so-tl');
  assert.ok(inner, '.so-tlwrap 里面必须包着 .so-tl（滚动层与竖线层不能合成一个元素）');
  assert.equal(wrap.props.className, 'so-tlwrap', '滚动层自己不许再挂 .so-tl 的类');
  assert.equal(walk(tree).texts.filter((t) => /^第 \d+ 条$/.test(t)).length, 29, '限高不许少画行：29 条全在 DOM 里');
  const css = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.match(css, /^\.so-tlwrap\{max-height:clamp\(240px,52vh,480px\);overflow:auto;overscroll-behavior:contain\}$/m,
    '限高口径照 .so-tblwrap-plan / .logpanel，三条一条不能少');
  assert.match(css, /^\.so-tl\{position:relative;padding-left:16px\}$/m, '竖线那一层自己不许带 overflow');
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.match(proto, /^\.tl-wrap\{max-height:clamp\(240px,52vh,480px\);overflow:auto;overscroll-behavior:contain\}$/m, '原型同规');
  assert.match(proto, /<div class="tl-wrap"><div class="tl" id="tl"><\/div><\/div>/, '原型的嵌套形状与 client 一致');
});

/* pg1-12e（S16-⑤）：记录正文只出显示位数。真机截图里一屏 `90.53895642516085%` 是采集原值直出。
   改显示不改数据：落盘值仍是原值（记录要能对上当时规则的阈值），这里只钉「念出来」的那一句。 */
check('pg1-12e 命中正文的数值出显示位数，网络类命中走自适应单位（S16-⑤）', () => {
  assert.equal(MON.hitText({ kind: 'hit', ruleName: '内存占用率 ≥ 90%', metric: 'mem', value: 90.53895642516085, note: '冷却 15 分钟' }),
    '内存占用率 ≥ 90%：90.5%（冷却 15 分钟）');
  assert.equal(MON.hitText({ kind: 'hit', ruleName: 'CPU ≥ 85% 连续 3 次', metric: 'cpu', value: 85.65563873460516, note: '冷却 10 分钟' }),
    'CPU ≥ 85% 连续 3 次：85.7%（冷却 10 分钟）');
  assert.equal(MON.hitText({ kind: 'hit', ruleName: '下行 ≥ 5 MB/s', metric: 'netDown', value: 7030.7423, note: '' }),
    '下行 ≥ 5 MB/s：7.03 KB/s', '网络命中必须带自适应单位，不许念成 7030%');
  assert.equal(MON.hitText({ kind: 'hit', ruleName: 'x', metric: 'cpu', value: null, note: '' }), 'x：', '读不出数值就留空，不编一个 0');
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

check('pg1-17 相对时间四分档（fmtAge）：刚刚 / 分钟前 / 小时前 / 天前，缺值与负值出「—」', () => {
  const f = CLIENT.__test.fmtAge;
  assert.equal(f(0), '刚刚');
  assert.equal(f(59_999), '刚刚', '60s 以下一律「刚刚」');
  assert.equal(f(60_000), '1 分钟前', '整 60s 进「分钟前」档，边界不许落到上一档');
  assert.equal(f(3_599_999), '59 分钟前');
  assert.equal(f(3_600_000), '1 小时前');
  assert.equal(f(86_399_999), '23 小时前');
  assert.equal(f(86_400_000), '1 天前');
  assert.equal(f(-1), '—', '负值是没有数据，不是「刚刚」');
  assert.equal(f(null), '—');
  assert.equal(f(undefined), '—');
});

/**
 * pg1-18 / pg1-19（简报 F4 的证人）：落盘降级必须看得见（spec §7）。
 * ① `lib/alerts/service.js:41/:48` 推 `type: 'alert-store'` 帧，旧 mergeFrame 落到末尾
 *    `return base` 静默吞掉；② 快照/`GET /api/alerts` 都带 hitsError / errorCode（lib/api.js:290/:393-400），
 *    旧监控记录卡只有「有记录 / 空态」两支 ⇒ 库不可用时显示「本机还没有监控记录」，与真的没触发过不可分辨。
 */
check('pg1-18 mergeFrame 消费 alert-store 帧：落进 alerts.hitsError，不再被末尾 return base 吞掉', () => {
  const T = CLIENT.__test;
  const s = T.mergeFrame({ alerts: { unread: 0, rules: [], hits: [] } }, 'alert-store', { error: 'storageDomain 不可用，监控记录未落盘' });
  assert.equal(s.alerts.hitsError, 'storageDomain 不可用，监控记录未落盘');
  assert.deepEqual(s.alerts.hits, [], '既有 hits 不得被降级帧清空');
  const s2 = T.mergeFrame({ alerts: {} }, 'alert-store', {});
  assert.ok(s2.alerts.hitsError, '帧里没带 error 也要给出可读文案，不许 undefined');
});

check('pg1-19 库不可用时监控记录卡显示降级文案、且不再显示"本机还没有监控记录"（spec §7）', () => {
  const out = walk(MON.AlertsPage({ snap: SNAP({ alerts: { unread: 0, rules: [], hits: [], hitsError: 'storageDomain 不可用', errorCode: 'SYSOPS_HITS_UNAVAILABLE' } }), err: null }));
  assert.ok(out.has('监控记录落盘不可用'), '降级必须看得见：' + out.texts.join('|'));
  assert.ok(!out.has('本机还没有监控记录'), '库不可用时不得冒充"没有触发过"');
  // 反向：无降级时仍是原来的空态，别把正常路径也改坏
  const ok = walk(MON.AlertsPage({ snap: SNAP({ alerts: { unread: 0, rules: [], hits: [] } }), err: null }));
  assert.ok(ok.has('本机还没有监控记录'), '无降级时保留原空态');
  assert.ok(!ok.has('监控记录落盘不可用'), '无降级时不许挂降级文案');
});

/**
 * pg1-20 / pg1-21（2026-09-28 真机第三症状的证人）：曲线在动、数字却冻住。
 * `GET /api/stream` 只在连上时推**一帧** snapshot（lib/api.js:335），之后每 tick 只推
 * `metrics` 增量点（spec §3.1 表：只推增量点）。而 KPI 四格与曲线卡的四个大数字都读
 * `snap.latest`（client.js:401 / :1162-1166）⇒ 旧 mergeFrame 只把点并进 series、不动 latest，
 * 数字就永久停在首帧。合并 latest 是"局部合并"的应有之义，不新增帧类型、不改服务端契约。
 */
check('pg1-20 mergeFrame 消费 metrics 帧：latest 数值随增量点更新，且不就地改旧快照', () => {
  const T = CLIENT.__test;
  const base = {
    cadence: '1s', keepMinutes: 30,
    latest: { cpu: 8, mem: 86.4, diskFreeGb: 72.3, diskTotalGb: 200, netDown: null, netUp: null, t: 1000 },
    series: { cpu: [], mem: [], diskFreePct: [], netDown: [], netUp: [] },
  };
  const cpu = T.mergeFrame(base, 'metrics', { key: 'cpu', point: { t: 2000, v: 37 } });
  assert.equal(cpu.latest.cpu, 37, 'CPU 当前值必须跟着增量点走');
  assert.equal(cpu.latest.mem, 86.4, '同一帧不许牵连别的指标');
  assert.equal(cpu.latest.diskFreeGb, 72.3, '同一帧不许牵连磁盘格');
  assert.equal(cpu.series.cpu.length, 1, '增量点照旧并进曲线（既有行为不许改坏）');
  assert.equal(base.latest.cpu, 8, '不许就地改旧快照对象：React 靠引用变化重渲染');

  assert.equal(T.mergeFrame(base, 'metrics', { key: 'mem', point: { t: 2000, v: 90.2 } }).latest.mem, 90.2);
  assert.equal(T.mergeFrame(base, 'metrics', { key: 'netDown', point: { t: 2000, v: 12_500_000 } }).latest.netDown, 12_500_000);
  assert.equal(T.mergeFrame(base, 'metrics', { key: 'netUp', point: { t: 2000, v: 320_000 } }).latest.netUp, 320_000);
  // 只合 latest 里真有同名字段的指标：未知 key 不许往 latest 里塞新键（否则 latest 会慢慢长成一张杂表）
  assert.equal(T.mergeFrame(base, 'metrics', { key: 'nope', point: { t: 2000, v: 5 } }).latest.nope, undefined);
});

check('pg1-21 diskFreePct 增量点换算回 GB 写进 latest.diskFreeGb；总容量未知就不硬算', () => {
  const T = CLIENT.__test;
  // 采集侧 diskFreePct 的 v 是**空闲百分比**（lib/collect/service.js:169），latest 的口径是 GB
  // ⇒ 换算需要总量；分母缺失时保持原值，不编一个数（与 pg1-4「快照没有的数字不显示」同口径）。
  const base = { latest: { diskTotalGb: 200, diskFreeGb: 1, t: 0 }, series: { diskFreePct: [] } };
  const got = T.mergeFrame(base, 'metrics', { key: 'diskFreePct', point: { t: 2000, v: 36.15 } });
  assert.equal(Number(got.latest.diskFreeGb.toFixed(2)), 72.3, '200 GB × 36.15% 空闲 = 72.3 GB');
  const noTotal = T.mergeFrame({ latest: { diskTotalGb: null, diskFreeGb: null }, series: {} }, 'metrics', { key: 'diskFreePct', point: { t: 2000, v: 36 } });
  assert.equal(noTotal.latest.diskFreeGb, null, '总容量未知时不硬算，保持 null');
});

check('pg1-22 根容器自带滚动：宿主 centerCol 是 overflow:hidden，.so-root 必须自己兜底', () => {
  // 宿主 dsh-client-ui-layout 的 AppFrame.module.css：`.pI_x6G_centerCol{...overflow:hidden}`，
  // 插件内容超高会被直接裁掉（同仓 dsh-plugin-stock-analysis/client.js:264-266 的 `.sa-root`
  // 就是为这件事加的兜底）。CSS 无单测通道，只能钉住这条规则的存在与两个属性。
  const code = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const m = code.match(/\.so-root\s*\{[\s\S]*?\}/);
  assert.ok(m, 'client.js 里找不到 .so-root 规则块');
  assert.match(m[0], /max-height:\s*100vh/, '.so-root 缺高度上限，超高内容会被宿主裁掉');
  assert.match(m[0], /overflow-y:\s*auto/, '.so-root 缺纵向滚动，页面无法滚动');
});

/* S7（真机反馈「鼠标移上去怎么变黑色了」→ 第一版修完变成「常年黑块、文字看不见」）—— 源码级不变式。
   根因不止一条属性：`.so-root button{…}` 特异性 (0,1,1) 高于所有 `.so-*` 控件类 (0,1,0)，
   它写下的**任何**属性都会把控件类的常态值整块吃掉，只剩 :hover 一档（(0,2,0)）还生效。
   第一版只从 reset 里删了 background，`color:inherit` 仍留在 (0,1,1)，于是 `.so-btn-primary`
   的 `color:var(--so-bg)` 继续被压掉 → 深色底叠继承来的深色字 = 纯黑块。
   正确修法是把 reset 整条降到 `:where(.so-root) button`（:where 贡献 0 特异性 ⇒ (0,0,1)），
   让控件类在 background / color / font-size / border / padding 上全属性胜出。CSS 无单测通道，
   这里钉住的就是「reset 自身必须零类特异性」+「每个被压过的控件类都得自带那一项」。 */
check('pg1-27 裸 button 清零必须用 :where() 归零特异性，不许压过任何控件类', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /:where\(\s*\.so-root\s*\)\s+button\s*\{/,
    'client.js 里找不到 :where(.so-root) button 清零规则，特异性没归零');
  assert.ok(!/\.so-root\s+button\s*\{/.test(code),
    '不许再出现裸 .so-root button{…}：(0,1,1) 会压掉一切控件类的 (0,1,0) 常态值，只剩 hover 生效');
  const m = code.match(/:where\(\s*\.so-root\s*\)\s+button\s*\{[\s\S]*?\}/);
  for (const prop of ['background', 'border', 'padding']) {
    assert.ok(!new RegExp('[{;]\\s*' + prop + '\\s*:').test(m[0]),
      '清零规则不许写 ' + prop + '，底/边/内距一律归各控件类');
  }
  assert.match(m[0], /font:\s*inherit/, '字体继承要保留');
  assert.match(m[0], /cursor:\s*pointer/, '指针要保留');
  // 被 (0,1,1) 压过、现在必须由控件类自己提供的项：逐条钉住
  const primary = code.match(/\.so-btn-primary\s*\{[^}]*\}/);
  assert.ok(primary && /[{;]\s*background:/.test(primary[0]) && /[{;]\s*color:/.test(primary[0]),
    '.so-btn-primary 必须自带 background 与 color 两项 —— 少了 color 就是「深底 + 继承来的深色字 = 黑块」');
  assert.match(primary[0], /color:\s*var\(--so-bg\)/, 'primary 的字色是 --so-bg，与深色底 --so-t1 不同才算可读');
  assert.match(code, /\.so-btn\s*\{[^}]*background:[^}]*color:/, '.so-btn 必须自带背景与字色');
  assert.match(code, /\.so-btn-sm\s*\{[^}]*font-size:/, '.so-btn-sm 的字号必须自己声明，否则被 font:inherit 吃掉');
  const chk = code.match(/\.so-check\s*\{[^}]*\}/);
  assert.ok(chk && /[{;]\s*border:/.test(chk[0]), '.so-check 必须自己带常态边框');
  assert.match(chk[0], /color:\s*var\(--so-bg\)/, '.so-check 的勾号字色要自己声明');
  assert.match(chk[0], /font-size:/, '.so-check 的字号要自己声明');
  assert.match(code, /\.so-tab\s*\{[^}]*color:/, '.so-tab 的字色要自己声明');
  const sw = code.match(/\.so-switch\s*\{[\s\S]*?\}/);
  assert.ok(sw && /[{;]\s*border:\s*none/.test(sw[0]), '.so-switch 收窄 reset 后必须自己清掉 UA 边框');
});

/* S8-①（真机反馈「这两个边框高度不一样」+ 箭头指向 CPU / 内存两张曲线卡的顶角）—— 源码级不变式。
   根因是间距方案本身：`.so-card + .so-card{margin-top:14px}` 把相邻兄弟那条 14px 漏进了
   `.so-charts` 网格（同排第 2/4 张卡被 margin 压下 14px，又被 align-items:stretch 压矮 14px），
   同时卡前面不是卡时（曲线网格、提示行）又给不出间距 —— 实测 .so-charts 底 783 = 下一张卡顶 783。
   改挂 `.so-tabpanel > * + .so-card` 后网格子级不在选择器里；间距归回「网格 gap + 面板直接子级」两处。
   CSS 无单测通道，这里钉死规则形态与两条禁线。 */
check('pg1-28 卡间距只由 .so-tabpanel 的直接子级决定，不许再用相邻兄弟选择器', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  const m = code.match(/\.so-tabpanel\s*>\s*\*\s*\+\s*\.so-card\s*\{[^}]*\}/);
  assert.ok(m, 'client.js 里找不到 .so-tabpanel>*+.so-card 间距规则');
  assert.match(m[0], /margin-top:\s*14px/, '间距值必须仍是 14px（与 .so-charts 的 gap 同值）');
  assert.ok(!/\.so-card\s*\+\s*\.so-card/.test(code),
    '不许退回 .so-card+.so-card：(0,1,0) 会把 14px 漏进 .so-charts 的网格子级，同排第 2/4 张卡被压下压矮 14px');
  // 网格自己管间距（gap:14px），子级一律不许带纵向 margin —— 加回任何一条都会重现同款错位。
  const gridChildRules = code.match(/^[^{}\n]*\.so-(?:grid|charts)\s*>\s*\*[^{]*\{[^}]*\}/gm) || [];
  assert.ok(gridChildRules.length >= 1, '连网格子级规则都找不到，这条检查就废了：' + gridChildRules.length);
  for (const rule of gridChildRules) {
    assert.ok(!/[;{]\s*margin(-top)?\s*:/.test(rule), '网格子级不许带 margin，间距归 gap：' + rule);
  }
  // 原型是 spec：同一个毛病（.card + .card + .charts 的 .card 子级）必须同步改
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.match(proto, /\.tab-panel\s*>\s*\*\s*\+\s*\.card\s*\{/, '原型 index.html 的卡间距规则没同步改');
  assert.ok(!/^\s*\.card\s*\+\s*\.card\s*\{/m.test(proto), '原型还留着 .card + .card 间距规则');
});

/* S6（真机反馈「鼠标移到曲线上要能显示对应数值」）—— 悬停读数的纯函数层。
   读数画在卡内 SVG 里而不是浮层提示条（§4 禁令），所以「读到的点」必须与「画出的点」
   共用一个来源与一套坐标映射：下面这几条就是那条同源约束与各口径边界。 */
check('pg1-23 seriesVals 与 sparkPoints 同源：脏点不画也不读，坐标映射只此一处', () => {
  const pts = [{ t: 1, v: 10 }, { t: 2, v: null }, { t: 3, v: 30 }, { t: 4, v: 'x' }];
  assert.deepEqual(MON.seriesVals(pts).map((p) => p.v), [10, 30], '无效 v 的点必须整点剔除（不补 0、不插值）');
  const a = MON.pointXY(0, 2, 10, 100);
  const b = MON.pointXY(1, 2, 30, 100);
  assert.equal(MON.sparkPoints(pts, 100), [a, b].map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '),
    'sparkPoints 必须逐点走 pointXY，否则读数圆点会飘到线外');
  assert.equal(MON.sparkPoints([], 100), null, '无有效点给 null，由卡面出空态');
  assert.equal(MON.sparkPoints(pts, null), null, '量程未知不画线（不是画一条贴底的线）');
});

check('pg1-24 hoverIndexAt：屏幕横坐标按比例反解成最近采样点，拿不到 rect 就不猜', () => {
  const rect = { left: 0, width: 340 };            // 1:1 映射（viewBox 宽就是 340）
  assert.equal(MON.hoverIndexAt(3, rect, 5), 0, '左内边距处应是首点');
  assert.equal(MON.hoverIndexAt(337, rect, 5), 4, '右内边距处应是末点');
  assert.equal(MON.hoverIndexAt(170, rect, 5), 2, '正中应是中间点');
  assert.equal(MON.hoverIndexAt(999999, rect, 5), 4, '超出右边界钳到末点');
  assert.equal(MON.hoverIndexAt(-999, rect, 5), 0, '超出左边界钳到首点');
  assert.equal(MON.hoverIndexAt(170, rect, 1), 0, '单点恒为 0');
  assert.equal(MON.hoverIndexAt(170, null, 5), null, 'rect 拿不到就返回 null，不猜一个下标');
  assert.equal(MON.hoverIndexAt(170, { left: 0, width: 0 }, 5), null, '零宽不反解');
  assert.equal(MON.hoverIndexAt(NaN, rect, 5), null, '非法坐标不反解');
});

check('pg1-25 tipText 口径跟卡走：C 盘按总容量折回 GB，网络卡给上下行两值，都带 HH:MM:SS', () => {
  const t = (h, m, s) => new Date(2026, 0, 2, h, m, s).getTime();
  assert.equal(MON.tipText({ k: 'cpu', point: { t: t(9, 5, 7), v: 42.35 } }), '42.4% · 09:05:07');
  // 50/100×214.7 = 107.35 在 IEEE754 里是 107.34999…，toFixed(1) 取到 107.3
  assert.equal(MON.tipText({ k: 'diskFreePct', point: { t: t(0, 0, 0), v: 50 }, totalGb: 214.7 }), '107.3 GB（50.0%） · 00:00:00');
  assert.equal(MON.tipText({ k: 'diskFreePct', point: { v: 50 } }), '50.0%', '总容量未知只说百分比，不硬算 GB、也不编时刻');
  assert.equal(MON.tipText({ k: 'netDown', point: { t: t(9, 5, 7), v: 12_500_000 }, point2: { v: 2_400_000 } }),
    '↓ 12.5 MB/s ↑ 2.40 MB/s · 09:05:07');
  // S16-②：真机量级（7 KB/s / 13 KB/s）在气泡里也必须带单位，不能再读成 0.0
  assert.equal(MON.tipText({ k: 'netDown', point: { t: t(9, 5, 7), v: 7030.7423 }, point2: { v: 13648.549217 } }),
    '↓ 7.03 KB/s ↑ 13.6 KB/s · 09:05:07');
  assert.equal(MON.tipText({ k: 'netDown', point: { v: 12_500_000 } }), '↓ 12.5 MB/s', '上行缺值就只出下行');
  assert.equal(MON.tipText({ k: 'cpu', point: { v: null } }), '', '点没数值就读不出，不给半截文案');
});

check('pg1-26 clockOf / tipLayout：缺时间戳不编时刻，读数横按百分比、纵按 px 落位', () => {
  assert.equal(MON.clockOf(undefined), '');
  assert.equal(MON.clockOf(null), '');
  assert.equal(MON.clockOf('x'), '');
  assert.equal(MON.clockOf(new Date(2026, 0, 2, 7, 8, 9).getTime()), '07:08:09');
  // S15-①：圆环与气泡是卡内 HTML，svg 的横向拉伸对它们无效 ⇒ 落位只能是「横百分比 + 纵 px」。
  // 这条钉的是换算本身：x 除以 viewBox 宽（340），y 就是 viewBox 里的 px（纵向 1:1）。
  assert.deepEqual(MON.tipLayout(0, 0), { leftPct: 0, topPx: 0, start: true, leftCss: 'calc(0% + 8px)', transform: 'translateX(0)' });
  assert.deepEqual(MON.tipLayout(170, 46.04), { leftPct: 50, topPx: 46, start: false, leftCss: 'calc(50% - 8px)', transform: 'translateX(-100%)' }, '中点算右半边：气泡右边贴该点往左长');
  assert.deepEqual(MON.tipLayout(337, 89), { leftPct: 99.1, topPx: 89, start: false, leftCss: 'calc(99.1% - 8px)', transform: 'translateX(-100%)' }, '最右一点用右边缘锚定，不靠固定夹边');
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  // 无头实测（S15 收口）：网络卡气泡 186.9px 宽、C 盘卡 162.4px 宽，「居中 + 46px 夹边」在贴边的点上
  // 把气泡裁到卡外（左端 -32.5px / 右端 -20.2px）。半边朝向与气泡宽度无关，所以两种宽度都越不了界。
  assert.ok(!/clamp\(46px/.test(src), '不许退回「居中 + 固定夹边」：夹边值小于半个气泡宽就会被卡裁掉');
  assert.match(src, /const start = leftPct < 50;[\s\S]{0,200}transform: start \? 'translateX\(0\)' : 'translateX\(-100%\)'/, '朝向由 tipLayout 一处决定（渲染点只消费）');
  assert.match(src, /className: 'so-tip-ring'[\s\S]{0,200}borderColor: spec\.color/, '圆环描边吃本卡曲线颜色，四张卡一眼分得出读的是哪条');
});

/**
 * pg1-29（S15-① 的两边同改证人）：原型的悬停读数与 client 同形。
 * 用户批的是画面，画面只在这两处存在过 —— 只改 client 等于把 spec 留在旧答案上，
 * 下一轮照原型重做就会把「字发胖、点变椭圆」搬回真机。这里钉的是形状与换算，不是像素。
 */
check('pg1-29 原型悬停读数同形：卡内定位父级 + 同一条换算 + 非拉伸描边，两边都在', () => {
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  // 定位父级：圆环与气泡是卡内 HTML，父级必须 relative（两边同一形状的根）
  assert.match(code, /^\.so-curve\{position:relative\}[ \t]*$/m, 'client 的卡内读数层是定位父级');
  assert.match(proto, /^\.curve\{position:relative\}[ \t]*$/m, '原型同处同形');
  // 不吃拉伸：svg 里所有描边走 non-scaling-stroke（曲线/阈值线/引导线）
  assert.equal((proto.match(/vector-effect="non-scaling-stroke"/g) || []).length, 4, '原型四条描边各带一次 non-scaling-stroke（曲线、次曲线、阈值线、引导线）');
  assert.equal((code.match(/vectorEffect: 'non-scaling-stroke'/g) || []).length, 4, 'client 同处四次');
  // 同一条换算：横百分比 + 纵 px，两边同一个式子
  assert.match(code, /Math\.round\(\(x \/ CHART_W\) \* 1000\) \/ 10/, 'client 的换算');
  assert.match(proto, /Math\.round\(\(x \/ CW\) \* 1000\) \/ 10/, '原型换算同式（CW 就是 340）');
  // 半边朝向（S15 收口时的无头实测：网络卡气泡 186.9px 宽、C 盘卡 162.4px，居中 + 固定夹边在贴边的点上裁掉 32.5px）
  assert.match(code, /const start = leftPct < 50;[\s\S]{0,220}transform: start \? 'translateX\(0\)' : 'translateX\(-100%\)'/, 'client 的朝向判定');
  assert.match(proto, /var start = leftPct < 50;/, '原型同一条判定（leftPct 同式，半边同法）');
  assert.match(proto, /box\.style\.left = 'calc\(' \+ leftPct \+ '% ' \+ \(start \? '\+ 8px\)' : '- 8px\)'\);/, '原型同一条 calc，只换拼接写法');
  assert.match(proto, /box\.style\.transform = start \? 'translateX\(0\)' : 'translateX\(-100%\)';/, '原型朝向与 client 同值');
  assert.ok(!/\.so-tip-box\{[^}]*transform:/.test(code), 'client 气泡类里不写 transform —— 朝向只由 tipLayout 给，两处各写一份会互相压');
  assert.ok(!/^\.tip-box\{[^}]*transform:/m.test(proto), '原型同处也不写');
  // 读数两段：数值 + 灰字时刻，两边都拆成两段而不是拼成一行
  assert.match(code, /h\('b', null, parts\.v\), parts\.t \? h\('span', \{ className: 'so-tip-t' \}, parts\.t\) : null\)/);
  assert.match(proto, /'<b>' \+ esc\(c\.fmt\(c, i\)\) \+ '<\/b><span class="t">' \+ esc\(tipTime\(c, i\)\) \+ '<\/span>'/);
  // 事件在位 + 三件套随卡生成：原型是手写 DOM，悬停只切显隐，不每次重建节点
  assert.match(proto, /addEventListener\('mousemove'/);
  assert.match(proto, /addEventListener\('mouseleave'/);
  for (const pre of ['<line class="tip-line"', '<span class="tip-ring" style="display:none"></span>', '<span class="tip-box" style="display:none"></span>']) {
    assert.ok(proto.includes(pre), '三件套在渲染时就挂好（默认隐藏）：' + pre);
  }
  assert.match(proto, /\.style\.display = '';/, '悬停时只把 display 打开');
  assert.match(proto, /\.style\.display = 'none';/, '移开时关掉，而不是把节点摘掉');
  // 收起要三件一起收：只收两件的话，移开鼠标后画面上还赖着一条竖引导线（整份文件的 loose 断言抓不到，就在收口函数里数次数）
  const hide = proto.match(/function hideCurveTip\(svg\) \{[\s\S]*?\n  \}/);
  assert.ok(hide, '原型找不到 hideCurveTip —— 移开鼠标就没有收口');
  assert.equal((hide[0].match(/\.style\.display = 'none';/g) || []).length, 3,
    'hideCurveTip 里引导线 / 圆环 / 气泡三件各置一次 none：' + hide[0].replace(/\s+/g, ' '));
  // 气泡与圆环的排版本体（真机批「丑」的另一半是排版，不是坐标）：一行不折 + 圆角 + 真圆
  for (const [src, sel] of [[code, '\\.so-tip-box'], [proto, '\\.tip-box']]) {
    for (const prop of ['white-space:nowrap', 'border-radius:8px']) {
      assert.match(src, new RegExp('^' + sel + '\\{[^}]*' + prop + '[^}]*\\}$', 'm'), sel + ' 少了 ' + prop);
    }
  }
  for (const [src, sel] of [[code, '\\.so-tip-ring'], [proto, '\\.tip-ring']]) {
    assert.match(src, new RegExp('^' + sel + '\\{[^}]*border-radius:50%[^}]*\\}$', 'm'), sel + ' 必须是真圆（1:1 画在 HTML 里）');
  }
  for (const [src, sel] of [[code, '\\.so-tip-box b'], [proto, '\\.tip-box b']]) {
    assert.match(src, new RegExp('^' + sel + '\\{[^}]*tabular-nums[^}]*\\}$', 'm'), sel + ' 数值要等宽，读数跳动时不许抖');
  }
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

// 清理页渲染夹具（pg2-* 全段共用；②段之后的 C-I-2/C-m-3 渲染证人也吃同一份）
const cleanProps = (over = {}) => ({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null, ...over });
const walkClean = (over) => walk(CLEAN.CleanPage(cleanProps(over)));
/* 表头全选框（S10-③）：在 walk 出来的按钮里按 title 认领 —— 行内框的 title 是「勾选此项/取消勾选/guard 拒绝…」，
   只有表头那颗说「取消全选」或「全选可执行的 N 项…」。 */
const headerBox = (out) => out.buttons.find((b) => /^(取消全选|全选可执行的)/.test(b.title)) ?? null;

check('pg2-1 未扫描时的空态：说清扫描是只读的、删除只发生在勾选之后', () => {
  const out = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: { dirs: 0, files: 0, bytes: 0, oldest: null }, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('尚未扫描'));
  assert.ok(out.has('扫描是只读的'));
  assert.ok(!out.has('路径 / 内容'), '未扫描不该出现清单表');
});

/* S8-②（真机反馈「右上角哪里有开始扫描」：空态文案指着右上角，按钮却长在卡里居中）——
   修法照原型口径：扫描入口唯一挂在页头，本页四个分支都不再自带扫描按钮。
   卡里再放一个同名按钮等于两个入口两套状态（空态那个还在「开始扫描 / 重新扫描」之间切换），
   文案说的「右上角」必须真有落点 —— 页头那颗由 SysopsPage 渲染，见 cn-14 的真点击接线。 */
check('pg2-27 扫描入口唯一在页头：清理页四个分支都不再自带扫描按钮', () => {
  const base = { logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null };
  const states = [
    { name: '空态', props: { clean: IDLE, plan: null, lastSummary: null } },
    { name: '扫描中', props: { clean: SCAN, plan: null, lastSummary: null } },
    { name: '有清单', props: { clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), lastSummary: null } },
    { name: '执行完', props: { clean: { ...IDLE, phase: 'done', planId: null }, plan: null,
        lastSummary: { planId: 'plan-1', ok: 2, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.9e9, at: 1_700_000_090_000 } } },
  ];
  for (const s of states) {
    const out = walk(CLEAN.CleanPage({ ...base, ...s.props }));
    const btn = out.buttons.find((b) => /开始扫描|重新扫描/.test(b.text));
    assert.ok(!btn, `${s.name}分支里还留着扫描按钮（${btn && btn.text}）：卡里与页头两个入口会各说各的话`);
  }
  // 文案与落点对齐：空态照旧说「右上角」，执行完指路右上角；扫描卡里的「停止扫描」不受影响
  const empty = walk(CLEAN.CleanPage({ ...base, clean: IDLE, plan: null }));
  assert.ok(empty.has('点击右上角') && empty.has('「开始扫描」'), '空态文案要指页头：' + empty.texts.join('|'));
  const done = walk(CLEAN.CleanPage({ ...base, clean: { ...IDLE, phase: 'done', planId: null }, lastSummary: { planId: 'plan-1', at: 1 } }));
  assert.ok(done.has('入口在右上角'), '清单失效后要告诉用户重扫入口在哪：' + done.texts.join('|'));
  const scanning = walk(CLEAN.CleanPage({ ...base, clean: SCAN, plan: null }));
  assert.ok(scanning.btn('停止扫描'), '扫描中的「停止扫描」仍留在卡里（页头那颗此刻是禁用态）');
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

check('pg2-3 清单表头五列逐字，且第一列是全选框（S10-③ 的可见落点）', () => {
  assert.deepEqual(CLEAN.PLAN_COLS, ['路径 / 内容', '大小', '命中规则', '最后访问', '风险']);
  const out = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]) });
  for (const col of CLEAN.PLAN_COLS) assert.ok(out.has(col), `缺表头 ${col}`);
  const hb = headerBox(out);
  assert.ok(hb, '表头第一列缺全选框：' + JSON.stringify(out.buttons.map((b) => b.title)));
  assert.equal(hb.role, 'checkbox');
  assert.equal(hb.onClick, true, '全选框要真接线（桩只验到 onClick 存在，容器口径见 pg2-29 的纯函数三态）');
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

check('pg2-5 表头全选的目标集合 = 未拒项（含标风险项）：S10-③ 新口径', () => {
  // 真机读数（用户截图）：507 项里 504 项带 mid 标 —— 旧口径（低风险才选）全选等于什么都选不上。
  // 新口径「有风险」只是提示：执行侧对被锁文件是跳过而不是强删（lib/clean/executor.js），
  // 所以它们在目标集合里，被 guard 拒的项仍不在（pg2-4 的同一道线）。
  const items = [ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })];
  const plan = PLAN(items);
  const ids = CLEAN.selectAllIds(plan);
  assert.deepEqual(ids, ['temp-user-aG9tZQ', 'r1'], '目标集合 = 未拒项（含 mid），不含被拒项');
  const t = CLEAN.selTotals(plan, ids);
  assert.equal(t.n, 2, '全选把标风险的项也算进来（旧口径在这里只选到 1 项）');
  assert.equal(t.cleanable, 1, '卡头「可清理」只数非 mid 的未拒项');
  assert.equal(t.risky, 1);
  assert.equal(t.riskySelected, 1, '选了 mid 项就要在页脚提示「会被跳过、不会被强删」');
  assert.equal(t.rejected, 1);
  const out = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(ids) });
  assert.ok(out.has('含 1 项有风险：被应用锁住的文件会被跳过，不会被强删'), out.texts.join('|'));
});

check('pg2-6 未勾选时两个动作按钮都禁用，并给出原因而不是静默变灰', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: { storageDomain: true }, link: 'sse', sel: new Set(), err: null }));
  const del = out.buttons.find((b) => b.text.includes('清理选中'));
  const quar = out.buttons.find((b) => b.text.includes('隔离到暂存目录'));
  assert.equal(del.disabled, true);
  assert.equal(quar.disabled, true);
  // S20（真机批注「这些不要了」）：操作条上那句「勾选至少一项」删了，原因改由两颗按钮的 title 承担 ——
  // 判据跟着搬到 title 上，否则这条用例就成了「为一句已经不存在的话而存在」的假证人。
  assert.match(del.title, /勾选至少一项/, '禁用要就地给原因，不能只变灰：' + del.title);
  assert.match(quar.title, /勾选至少一项/, quar.title);
});

check('pg2-7 已选统计：项数 + 预计释放（字节走 fmtBytes 与 capText 同一口径）', () => {
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
  // S12-A 起前后两端与概览条/监控页同口径（1024 进制标 GB）：70.4e9 字节 = 65.6 GB 而不是 70.4 GB。
  // 原来这里除 1e9、监控页除 2^30，同一个数两处差 7%，用户会读成「释放量对不上」。
  assert.match(r.snapshot, /65\.6 GB → 68\.5 GB/);
  assert.equal(CLEAN.logRow({ beforeFree: 0, afterFree: null, bytesFreed: 0 }).snapshot,
    '系统盘可用容量 未读到 → — · 释放 0 B', 'beforeFree 的 0 是服务端读失败的形状，不许显示成 0.0 GB');
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs, unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null, logsOpen: true }));
  assert.ok(out.has('清理留痕'));
  assert.ok(out.has('追加式，只读'));
});

check('pg2-11 上次执行未确认完成要在清单顶部提示，并指向留痕（spec §4.3）', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [],
    unfinished: [{ logId: 'CLN-2609-0004', startedAt: 1, mode: 'delete-file', done: 3, total: 6 }], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('上次执行未确认完成'));
  assert.ok(out.has('CLN-2609-0004'));
  // S12-①：留痕已经从页面底部搬进页头面板，这句指路必须跟着改口径 ——
  // 再写「对照下方「清理留痕」」就是把用户指向一张已经不存在的卡。
  assert.ok(out.has('请点页头的「清理留痕」展开记录核对磁盘现状'), out.texts.join('|'));
  assert.equal(out.texts.some((t) => t.includes('下方「清理留痕」')), false, '底部那张卡已经没有了，指路不许还指着它');
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
//    以下每条都走 walk 断渲染产物，不再只测纯函数返回值。（cleanProps/walkClean/headerBox 定义在夹具区）

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

check('pg2-18 清单卡头报三类计数（可清理/有风险/已拒绝），旧的「全选已跳过」文案随按钮一起删掉', () => {
  const plan = PLAN([ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })]);
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan });
  assert.ok(out.has('共 3 项 · 可清理 1 · 有风险 1 · 已拒绝 1'), out.texts.join('|'));
  assert.ok(!out.has('全选已跳过'), '「全选可清理项」按钮已按批注删除（S10-③「不要了」），它的说明文案不许留在卡头');
  assert.ok(!out.has('全选可清理项') && !out.has('清空选择'), '两个按钮的文案都不许再出现');
});

check('pg2-28 表头全选框三态：none / some / all（只剩被拒项被勾也仍是 none）', () => {
  const items = [ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })];
  const plan = PLAN(items);
  assert.equal(CLEAN.selectAllState(plan, new Set()), 'none');
  assert.equal(CLEAN.selectAllState(plan, new Set(['temp-user-aG9tZQ'])), 'some');
  assert.equal(CLEAN.selectAllState(plan, new Set(['temp-user-aG9tZQ', 'r1'])), 'all');
  assert.equal(CLEAN.selectAllState(plan, new Set(['x1'])), 'none', '只勾到被拒项不算选中：目标集合里没有它');
  assert.equal(CLEAN.selectAllState(PLAN([]), new Set()), 'none', '空清单回 none（按钮同时禁用）');
  // 渲染侧：三态长在 aria-checked 上，半选写 'mixed'（真 React 的 aria 口径）
  const heads = [
    { sel: new Set(), aria: 'false', glyph: '' },
    { sel: new Set(['temp-user-aG9tZQ']), aria: 'mixed', glyph: '−' },
    { sel: new Set(['temp-user-aG9tZQ', 'r1']), aria: 'all', glyph: '✓' },
  ];
  for (const c of heads) {
    const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan, sel: c.sel });
    const hb = headerBox(out);
    assert.ok(hb, `sel=${c.sel.size} 时表头全选框不见了`);
    assert.equal(hb.ariaChecked, c.aria === 'all' ? 'true' : c.aria, `sel=${c.sel.size}`);
    assert.equal(hb.text, c.glyph, `sel=${c.sel.size} 的勾形：` + JSON.stringify(hb.text));
    assert.equal(hb.disabled, false);
  }
  const empty = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([]) });
  const hbE = headerBox(empty);
  assert.equal(hbE.disabled, true, '没有可执行项时全选框必须禁用（点它只会清空手勾的项）');
});

check('pg2-29 表头全选框的 title 说明目标集合与风险项数（S10-③/④：一键清理可达）', () => {
  const plan = PLAN([ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })]);
  const off = headerBox(walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan }));
  assert.equal(off.title, '全选可执行的 2 项（含 1 项有风险：被应用锁住的文件会被跳过）', off.title);
  const on = headerBox(walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan, sel: new Set(['temp-user-aG9tZQ', 'r1']) }));
  assert.equal(on.title, '取消全选');
  const pure = headerBox(walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([ITEM()]) }));
  assert.equal(pure.title, '全选可执行的 1 项', '没有 mid 项时 title 不带风险括号');
});

check('pg2-30 扫描卡读「已用时 N 秒」：宿主 startedAt 到手才算，缺了退回覆盖度百分比', () => {
  const c = CLEAN.scanCells({ ...SCAN, startedAt: Date.now() - 5000 });
  assert.ok(c.elapsed >= 4 && c.elapsed <= 6, String(c.elapsed));
  assert.equal(CLEAN.scanCells(SCAN).elapsed, null, 'startedAt 缺失时不许编秒数（旧宿主帧没这个键）');
  assert.equal(CLEAN.scanCells({ ...SCAN, phase: 'ready', startedAt: 1 }).elapsed, null, '非扫描相位不算耗时');
  const out = walkClean({ clean: { ...SCAN, startedAt: Date.now() - 5000 } });
  assert.ok(out.texts.some((t) => /^已用时 [4-6] 秒$/.test(t)), out.texts.join('|'));
  assert.ok(!out.has('进度未知'), '有 startedAt 时走「已用时」，不再落回「进度未知」');
});

check('pg2-31 风险列三态 + 解释句只出现一次（S10-④ 去重）', () => {
  const items = [ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行，锁住的文件会被跳过' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })];
  const rows = CLEAN.planRows(PLAN(items), new Set());
  assert.equal(rows[0].riskPill, '可清理');
  assert.equal(rows[0].riskCls, 'so-pill-down');
  assert.equal(rows[0].why, '', '可清理项不该带解释句');
  assert.equal(rows[1].riskPill, '有风险');
  assert.equal(rows[1].riskCls, 'so-pill-amber');
  assert.equal(rows[1].why, '微信正在运行，锁住的文件会被跳过');
  assert.equal(rows[2].riskPill, '已拒绝');
  assert.equal(rows[2].riskCls, 'so-pill-red');
  assert.equal(rows[2].why, '回收站一律不参与');
  // 渲染侧去重：同一句 why 在整页只出现一次（真机截图上每行重复了两遍）
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN(items) });
  const dup = out.texts.filter((t) => t.includes('微信正在运行')).length;
  assert.equal(dup, 1, `mid 项的解释句出现了 ${dup} 次，应为 1（pill 只放短标签）`);
  assert.equal(out.texts.filter((t) => t === '有风险').length, 1);
  assert.equal(out.texts.filter((t) => t === '可清理').length, 1);
  assert.equal(out.texts.filter((t) => t === '已拒绝').length, 1);
  assert.ok(!out.texts.some((t) => /^有风险：|微信正在运行/.test(t) && t.length > 20), '解释句不许塞进 pill：' + out.texts.join('|'));
});

check('pg2-33 扫描帧合并后界面立刻翻转（S10-① 客户端一侧：帧带 phase 才翻得动）', () => {
  const T = CLIENT.__test;
  const snap = { clean: { ...IDLE } };
  const flipped = T.mergeFrame(snap, 'clean:progress', { type: 'clean:progress', phase: 'scanning', stopped: false, startedAt: Date.now() - 3000, dir: 'D:\\x', walked: 1200, hit: 3, bytes: 1024 });
  assert.equal(flipped.clean.phase, 'scanning', '帧里的相位必须并进快照的 clean 槽（clean:* 是浅并口径）');
  const out = walkClean({ clean: flipped.clean });
  assert.ok(out.has('扫描进度'), out.texts.join('|'));
  assert.ok(!out.has('尚未扫描'), '合并后不该还停在空态卡（修前真机扫描期间就是这一屏：点了没反应）');
  // 反例钉子：修前的帧不带相位，浅并后 phase 仍是 idle —— 同样这一帧，界面纹丝不动。
  const stale = T.mergeFrame(snap, 'clean:progress', { type: 'clean:progress', dir: 'D:\\x', walked: 1200, hit: 3, bytes: 1024 });
  assert.equal(stale.clean.phase, 'idle', '缺相位的帧合并后仍旧相位');
  assert.ok(walkClean({ clean: stale.clean }).has('尚未扫描'), '这正是修前那一屏：帧到了，卡没换');
});

check('pg2-32 清单表在卡内滚动（S10-②）：容器限高 + 表头吸顶，两半缺一不可', () => {
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: PLAN([ITEM()]) });
  assert.ok(out.classHas('so-tblwrap-plan'), '清单表的容器要挂专属类，否则限高会误伤搜索/进程表');
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /\.so-tblwrap-plan\{[^}]*max-height:[^;}]+;[^}]*overflow:\s*auto/,
    '清单容器必须限高 + 自己滚（用户批注：滚动只在这个框内，不要整个屏滚动）');
  assert.match(code, /\.so-tblwrap-plan\s+\.so-tbl\s+thead\s+th\{[^}]*position:\s*sticky/,
    '限高之后表头必须吸顶，否则滚到中段就不知道哪列是什么');
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

/* S11-②（真机反馈「可以安全清理得排在最前面，按等级顺序排列」+ 图内红框批注「增加一键清理按钮，
   可安全清理，清理过程要有动画展」）。真机那份 517 项清单里 513 项标 mid、只有 3 项可放心勾，
   而它三项沉在几百行下面 —— 排序、安全集、逐条进度这三件事必须各有证人，缺一不可。 */
const lvItems = () => [
  ITEM({ id: 'mid1', riskLevel: 'mid', riskWhy: '微信正在运行，锁住的文件会被跳过', path: 'C:\\Users\\gongj\\AppData\\Roaming\\Tencent\\mid1.dat', count: 120 }),
  ITEM({ id: 'den1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' }, path: 'C:\\$Recycle.Bin\\den1.log' }),
  ITEM({ id: 'low1', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\low1.log', count: 14 }),
  ITEM({ id: 'mid2', riskLevel: 'mid', riskWhy: 'Chrome 正在运行，锁住的文件会被跳过', path: 'C:\\Users\\gongj\\AppData\\Local\\Google\\mid2.log' }),
  ITEM({ id: 'low2', path: 'C:\\Users\\gongj\\AppData\\Local\\pnpm\\low2.log', count: 7 }),
];
const LV = () => PLAN(lvItems());
const RUN = (over = {}) => ({ total: 3, done: 0, ok: 0, skipped: 0, failed: 0, rejected: 0, currentPath: '', results: [], phase: 'running', startedAt: Date.now() - 2000, ...over });

check('pg2-34 清单按等级排序（S11-②）：可清理在最前，同级保持快照原序，快照本体一字不改', () => {
  const plan = LV();
  const rows = CLEAN.planRows(plan, new Set());
  assert.deepEqual(rows.map((r) => r.id), ['low1', 'low2', 'mid1', 'mid2', 'den1'],
    '等级顺序=可清理→有风险→已拒绝；同档内保持快照原序（low1 在 low2 前）');
  assert.deepEqual(rows.map((r) => r.riskPill), ['可清理', '可清理', '有风险', '有风险', '已拒绝']);
  assert.equal(plan.items[0].id, 'mid1', '排序只动显示顺序，冻结快照（执行对象唯一数据源）不许被改写');
  assert.equal(rows.find((r) => r.id === 'low1').count, 14, 'count 要跟着行走：渲染层若还按下标取 items[i]，排完序就串行了');
  // 渲染侧同一口径：屏面上的路径顺序就是等级顺序，用户不用逐屏翻
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan });
  const at = (p) => out.texts.findIndex((t) => t.includes(p));
  assert.ok(at('low1.log') > -1 && at('low1.log') < at('mid1.dat'), `低风险要排在风险项之前：${out.texts.join('|')}`);
  assert.ok(at('mid2') < at('den1'), `有风险要排在已拒绝之前：${out.texts.join('|')}`);
  assert.ok(out.texts.some((t) => t === '共 14 个文件'), '行数文案要挂在这一行自己带上来的 count 上：' + out.texts.join('|'));
});

check('pg2-35 一键安全清理的集合（S11-②）：只收「可清理」，与表头全选（含风险项）是两套口径', () => {
  const plan = LV();
  assert.deepEqual(CLEAN.safeCleanIds(plan), ['low1', 'low2'], '有风险与已拒绝都不进这一键');
  assert.deepEqual(CLEAN.selectAllIds(plan).filter((id) => id === 'mid1'), ['mid1'],
    '表头全选仍含风险项（S10-③ 口径），别把两个集合混成一个');
  const riskyOnly = PLAN([ITEM({ id: 'm', riskLevel: 'mid' }), ITEM({ id: 'd', guardDenied: { code: 'x', why: '红线' } })]);
  assert.deepEqual(CLEAN.safeCleanIds(riskyOnly), [], '没有可清理档时给空集，由卡面把按钮禁用');
  assert.deepEqual(CLEAN.safeCleanIds(null), [], '没有清单不编集合');
});

check('pg2-36 execItem 逐条并帧（S11-② 动画的数据源）：四档各归各、最新在上、超总数不重计', () => {
  let run = RUN({ total: 4 });
  run = CLEAN.execItem(run, { id: 'low1', state: 'ok', path: 'C:\\T\\a' });
  run = CLEAN.execItem(run, { id: 'mid1', state: 'skipped', errnoText: 'EBUSY 正被占用', path: 'C:\\T\\b' });
  run = CLEAN.execItem(run, { id: 'den1', state: 'rejected-snapshot', errnoText: 'b-recycle-bin 回收站一律不参与', path: 'C:\\T\\c' });
  run = CLEAN.execItem(run, { id: 'low2', state: 'failed', errnoText: 'EPERM 拒绝访问', path: 'C:\\T\\d' });
  assert.equal(run.ok, 1);
  assert.equal(run.skipped, 1);
  assert.equal(run.rejected, 1, 'rejected-snapshot / rejected-unknown 都归「拒绝」档（lib/clean/executor.js 真发这两种）');
  assert.equal(run.failed, 1);
  assert.equal(run.done, 4);
  assert.equal(run.currentPath, 'C:\\T\\d', '当前条路径跟着帧走，动画才有「正在删哪一条」');
  assert.deepEqual(run.results.map((r) => r.path), ['C:\\T\\d', 'C:\\T\\c', 'C:\\T\\b', 'C:\\T\\a'], '最新一条排最前');
  // 宿主重放（SSE 断线补拉）多打一帧：进度不许越过交出去的总数
  assert.equal(CLEAN.execItem(run, { id: 'low1', state: 'ok', path: 'C:\\T\\a' }).done, 4,
    'done 已等于 total 时不再累加，否则进度条会算出 120%');
  assert.equal(CLEAN.execItem(run, { id: 'x', state: 'whatever' }), run, '认不出的 state 不计数，页面不猜「大概成功了吧」');
  assert.equal(CLEAN.execItem(null, { state: 'ok' }), null, '没在跑就不建档');
  const closed = RUN({ total: 4, done: 4, phase: 'done' });
  assert.equal(CLEAN.execItem(closed, { state: 'ok' }), closed, '终态之后到的帧忽略，不把好收尾改回在跑');
  let cap = RUN({ total: 20 });
  for (let i = 0; i < 20; i += 1) cap = CLEAN.execItem(cap, { id: 'i' + i, state: 'ok', path: 'C:\\T\\' + i });
  assert.equal(cap.results.length, 8, '结果列表只留最近 8 条，517 项的清单不许把卡撑爆');
});

check('pg2-37 execCells：运行中最多报 99%，收尾才 100%；总数未知走不定量', () => {
  const c0 = CLEAN.execCells(RUN({ total: 4, done: 0 }));
  assert.equal(c0.pct, 0);
  assert.ok(/^第 1 \/ 4 项 · 成功 0 · 跳过 0 · 失败 0 · 拒绝 0$/.test(c0.line), c0.line);
  const cHalf = CLEAN.execCells(RUN({ total: 4, done: 2 }));
  assert.equal(cHalf.pct, 50, '按已处理数算，不是按剩余');
  assert.equal(CLEAN.execCells(RUN({ total: 4, done: 3 })).pct, 75);
  assert.equal(CLEAN.execCells(RUN({ total: 4, done: 4 })).pct, 99, 'phase 还是 running 就不到 100（漏一帧也不许假报完成）');
  assert.match(CLEAN.execCells(RUN({ total: 4, done: 4 })).line, /^第 4 \/ 4 项/, '最后一项不再虚报「第 5 项」');
  assert.equal(CLEAN.execCells(RUN({ total: 4, done: 4, phase: 'done' })).pct, 100);
  assert.equal(CLEAN.execCells(RUN({ total: 0 })).pct, null, '总数未知交 null 给不定量动画，不画实心 0%');
  assert.equal(CLEAN.execCells(null), null);
});

check('pg2-38 卡头「一键安全清理 N 项」（S11-② 红框批注）：N 只数可清理档，三种不可用各有可见原因', () => {
  const rw = { caps: { storageDomain: true } };
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: LV(), ...rw });
  const b = out.btn('一键安全清理');
  assert.ok(b, '卡头必须有这一键：' + out.buttons.map((x) => x.text).join('|'));
  assert.equal(b.text, '一键安全清理 2 项', 'N 取安全集大小（本夹具 2 低 / 2 中 / 1 拒），不是清单总项数');
  assert.equal(b.disabled, false, '有能力、有可清理项、没在跑 ⇒ 可用');
  assert.match(b.title, /只清理标「可清理」的 2 项/, 'title 要说清范围');
  assert.match(b.title, /有风险与已拒绝的都不动/);
  // ①没有可清理档
  const none = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' },
    plan: PLAN([ITEM({ id: 'm', riskLevel: 'mid' })]), ...rw });
  const nb = none.btn('一键安全清理');
  assert.equal(nb.disabled, true, '整份清单都在风险档时不许给一个"点了删不着东西"的按钮');
  assert.match(nb.title, /本次清单没有「可清理」档/, nb.title);
  // ②只读
  const ro = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: LV() });
  assert.equal(ro.btn('一键安全清理').disabled, true, 'caps 缺 storageDomain 也闸住这一键（与两个写按钮同闸门，fail-closed）');
  // ③正在执行
  const busy = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: LV(), exec: RUN({ total: 2 }), ...rw });
  assert.equal(busy.btn('一键安全清理').disabled, true, '执行中禁用，防二次提交');
  assert.equal(busy.btn('清理选中').disabled, true, '执行中下方写按钮同闸');
  assert.match(busy.btn('清理选中').title, /本次清理正在执行/, '禁用要带可见原因（title 直显，与设置页同一口径）');
});

check('pg2-39 就地确认行（S11-②）：不是浮层，确认只交安全集与快照 mode，执行中自动收起', () => {
  const props = { clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: LV(), safeAsk: true, caps: { storageDomain: true } };
  let ran = null, cancelled = 0;
  const root = CLEAN.CleanPage(cleanProps({ ...props,
    onSafeRun: (ids, mode) => { ran = { ids, mode }; },
    onSafeCancel: () => { cancelled += 1; },
  }));
  const out = walk(root);
  assert.ok(out.has('将永久删除 2 项「可清理」'), '确认句要说死数量与不可恢复：' + out.texts.join('|'));
  assert.ok(out.has('回收站不参与，删掉不可恢复'), out.texts.join('|'));
  assert.ok(!out.classes.some((c) => /modal|overlay|popover|dialog/.test(c)),
    'spec §4 禁浮层：确认只能落在卡内（禁线类名一个都不许出现）：' + out.classes.join('|'));
  const ok = findClickExact(root, '确认清理');
  assert.ok(ok, '确认按钮得在场且真挂了 onClick');
  ok();
  assert.deepEqual(ran, { ids: ['low1', 'low2'], mode: 'delete-file' }, '一键只交安全集，风险/拒绝项不进请求');
  const no = findClickExact(CLEAN.CleanPage(cleanProps({ ...props, onSafeCancel: () => { cancelled += 1; } })), '取消');
  assert.ok(no, '「取消」按钮得在场');
  no();
  assert.equal(cancelled, 1);
  // 执行中：确认行收起，不留一个还能点的确认按钮
  const busy = walkClean({ ...props, exec: RUN({ total: 2 }), safeAsk: true });
  assert.ok(!busy.btn('确认清理') && !busy.has('将永久删除'), '已经开始跑了还留着确认按钮 = 能二次提交');
});

check('pg2-40 执行面板落在清单卡内，收尾后在失效卡留得住（S11-② 动画的落点）', () => {
  const run = RUN({ total: 3, done: 1, ok: 1, currentPath: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\low1.log',
    results: [{ id: 'low1', state: 'ok', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\low1.log', why: '' }] });
  const out = walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: LV(), exec: run, caps: { storageDomain: true } });
  assert.ok(out.classHas('so-run') && out.classHas('is-running'), out.classes.join('|'));
  assert.ok(out.has('正在清理'), out.texts.join('|'));
  assert.ok(out.texts.some((t) => /^第 \d \/ 3 项 · 成功 1 · 跳过 0 · 失败 0 · 拒绝 0$/.test(t)), out.texts.join('|'));
  assert.ok(out.has('C:\\Users\\gongj\\AppData\\Local\\Temp\\low1.log'), '当前条路径要上屏，动画才指着在删哪一条');
  assert.ok(out.has('已删'), '逐条结果用 pill 表态：' + out.texts.join('|'));
  assert.ok(out.has('被应用锁住的条目会记为「跳过」'), out.texts.join('|'));
  // 收尾：清单作废后面板不许凭空消失
  const done = walkClean({ clean: { ...IDLE, phase: 'done', planId: null }, plan: null,
    lastSummary: { planId: 'plan-1', ok: 2, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.9e9, at: 1_700_000_090_000 },
    exec: { ...run, done: 3, ok: 3, phase: 'done' } });
  assert.ok(done.has('清单已失效') && done.has('本次清理已收尾'), done.texts.join('|'));
  assert.ok(done.classHas('is-done'), '终态面板留在失效卡上，最后几条要能回看');
  // 空面板不建档
  assert.ok(!walkClean({ clean: { ...IDLE, phase: 'ready', planId: 'plan-1' }, plan: LV() }).classHas('so-run'), '没执行过就不该有进度面板');
});

check('pg2-41 进度动画是真 CSS 而不是只挂类名（S11-②「清理过程要有动画展」源码锁）', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /\.so-run\.is-running \.so-run-dot\{[^}]*animation:\s*so-pulse/, '呼吸点动画规则要在');
  assert.match(code, /@keyframes so-pulse\{/, '缺关键帧，animation 就是死字符串');
  assert.match(code, /\.so-track>i\{[^}]*transition:\s*width/, '进度条宽度要过渡，逐条帧到达时才是走而不是跳');
  assert.match(code, /\.so-run\.is-done \.so-run-dot/, '终态要有静止样式：跑完还一直呼吸就是在骗人说还在删');
  // 面板底就是 --so-soft，槽再取 --so-soft 就看不见（S11 截图核对时发现的：进度条只剩一条黑线）
  assert.match(code, /\.so-run \.so-track\{[^}]*background:var\(--so-bd2\)/, '面板里的进度槽要比面板底色深一档，否则槽等于不存在');
});

/* S12-A（真机批注「扫描了哪些目录 / 流程对齐主流清理工具」）：分类分组、容量口径、概览条与筛选条 */

/** 四档混合的清单夹具：两条规则、一项有风险、一项被 guard 拒。 */
const S12_PLAN = () => PLAN([
  ITEM({ id: 'a', ruleName: '系统临时目录', kind: '缓存', size: 100, riskLevel: 'low' }),
  ITEM({ id: 'b', ruleName: '浏览器缓存', kind: '缓存', size: 900, riskLevel: 'mid', riskWhy: '运行中的浏览器会锁住部分文件' }),
  ITEM({ id: 'c', ruleName: '浏览器缓存', kind: '缓存', size: 50, riskLevel: 'low' }),
  ITEM({ id: 'd', ruleName: '系统临时目录', kind: '日志', size: 10, riskLevel: 'low', guardDenied: { code: 'GUARD_SYSTEM_DIR', why: '系统目录不参与' } }),
]);

check('pg2-42 分类分组读数（S12-A）：按命中规则成组、大小降序，三档计数与「未拒 id」各归各', () => {
  const g = CLEAN.categoryGroups(S12_PLAN(), new Set(['c']));
  assert.deepEqual(g.map((x) => x.key), ['浏览器缓存', '系统临时目录'], '按合计大小降序（用户关心谁占容量）');
  assert.equal(g[0].count, 2);
  assert.equal(g[0].bytes, 950);
  assert.deepEqual(g[0].selectable, ['b', 'c'], '「全选本组」只吃未拒的那批');
  assert.equal(g[0].risky, 1); assert.equal(g[0].cleanable, 1);
  assert.equal(g[0].selected, 1, '已勾数按传进来的 sel 数，分组不自己造勾选态');
  assert.equal(g[0].allSelected, false);
  assert.equal(g[1].rejected, 1, 'guard 拒的项计入本组但绝不进 selectable');
  assert.deepEqual(g[1].selectable, ['a']);
  assert.deepEqual(CLEAN.categoryGroups(S12_PLAN(), new Set(['a'])).find((x) => x.key === '系统临时目录').allSelected, true);
  assert.deepEqual(CLEAN.categoryGroups(null, new Set()), [], '没有清单时不造分组');
});

check('pg2-43 容量口径单点（S12-A）：1024 进制标 GB、beforeFree 的 0 说「未读到」、分档与监控页同阈值', () => {
  assert.equal(CLEAN.capText(70.4e9), '65.6 GB', '与资源管理器/监控页同口径：70.4e9 字节不是 70.4 GB');
  assert.equal(CLEAN.capText(null), '—');
  assert.equal(CLEAN.capOrMissing(0), '未读到', '服务端读失败交的就是 0，显示 0.0 GB 会让人以为清理救不了这个盘');
  assert.equal(CLEAN.capOrMissing(null), '未读到');
  const d = CLEAN.diskOverview({ diskFreeGb: 71.9, diskTotalGb: 214.7 }, { beforeFree: 70.4e9 });
  assert.equal(d.freeText, '71.9 GB');
  assert.equal(d.totalText, '214.7 GB');
  assert.equal(d.usedPct, 66.5);
  assert.equal(d.cls, '', '66.5% 已用不该有色');
  assert.equal(d.beforeText, '65.6 GB');
  assert.equal(d.note, '');
  assert.equal(CLEAN.diskOverview({ diskFreeGb: 21.4, diskTotalGb: 214.7 }, null).cls, 'warn', '90% 已用要黄 —— 与监控页 band(85,92) 同一档');
  // 边界逐档钉死（A3 变异电池证人）：阈值只写在 DISK_BAND 一处，两处读数不许一处黄一处绿。
  assert.equal(CLEAN.diskOverview({ diskFreeGb: 32.2, diskTotalGb: 214.7 }, null).cls, '', '85.0% 已用还是绿的（>85 才黄）');
  assert.equal(CLEAN.diskOverview({ diskFreeGb: 30.0, diskTotalGb: 214.7 }, null).cls, 'warn', '86.0% 已用要黄');
  assert.equal(CLEAN.diskOverview({ diskFreeGb: 15.0, diskTotalGb: 214.7 }, null).cls, 'crit', '93.0% 已用要红');
  for (const gb of [32.2, 30.0, 15.0]) {
    const snapRow = MON.mtrRows({ cadence: 'L1', keepMinutes: 30, latest: { cpu: 1, mem: 1, diskFreeGb: gb, diskTotalGb: 214.7, netDown: 0, netUp: 0, t: 3 }, series: {} })
      .find((r) => r.n === 'C 盘可用');
    assert.equal(snapRow.cls, CLEAN.diskOverview({ diskFreeGb: gb, diskTotalGb: 214.7 }, null).cls,
      `监控页格与概览条在 ${gb} GB 上必须同色（同一份 DISK_BAND）`);
  }
  const bandCode = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.equal((bandCode.match(/band\(usedPct, /g) || []).length, 2, '磁盘分档只有监控页与概览条两个消费点');
  assert.equal((bandCode.match(/band\(usedPct, DISK_BAND\.warn, DISK_BAND\.crit\)/g) || []).length, 2,
    '两处都吃 DISK_BAND，谁都不许自带字面量（S12-A 的「同阈值」口径）');
  const none = CLEAN.diskOverview({}, null);
  assert.equal(none.freeText, '—');
  assert.equal(none.usedPct, null, '快照没到位就不硬算');
  assert.match(none.note, /还没到/);
  assert.equal(CLEAN.diskOverview({ diskFreeGb: 100, diskTotalGb: 0 }, null).totalText, '—', '总量 0 不许除出 Infinity');
});

check('pg2-44 容量概览条落在清理页四个相位（S12-A）：空闲/扫描中/清单/执行完都在，读不到就说读不到', () => {
  const latest = { diskFreeGb: 71.9, diskTotalGb: 214.7 };
  const done = { clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: S12_PLAN(), latest };
  const cases = [
    ['空闲', { clean: IDLE, plan: null, latest }],
    ['扫描中', { clean: SCAN, plan: null, latest }],
    ['有清单', done],
    ['执行完', { clean: { ...IDLE, phase: 'done', planId: null }, plan: null, latest, lastSummary: { planId: 'plan-1', ok: 2, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.9e9, at: 1_700_000_090_000 } }],
  ];
  for (const [name, over] of cases) {
    const out = walkClean(over);
    assert.ok(out.classHas('so-disk'), `${name}相位必须有容量概览条：${out.classes.join('|')}`);
    assert.ok(out.has('系统盘 C: 可用'), `${name}相位要写明是哪块盘：${out.texts.join('|')}`);
    assert.ok(out.has('71.9 GB'), name);
  }
  const withPlan = walkClean(done);
  assert.ok(withPlan.has('本清单可腾出'), '清单在手就要给出「值不值得清」：' + withPlan.texts.join('|'));
  assert.ok(withPlan.has('扫描那一刻可用 65.6 GB'), '前后对比的另一端取自快照 beforeFree：' + withPlan.texts.join('|'));
  const noSnap = walkClean({ clean: IDLE, plan: null, latest: null });
  assert.ok(noSnap.has('容量读数还没到'), '监控快照没到位时如实标注，不画实心条：' + noSnap.texts.join('|'));
});

check('pg2-45 分类下拉只筛显示、不动勾选（S12-A，S19-① 从六颗 chip 收成一枚 select）', () => {
  const plan = S12_PLAN();
  const code = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  const plain = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), latest: { diskFreeGb: 71.9, diskTotalGb: 214.7 } });
  assert.ok(plain.classHas('so-catbar'), '清单态要有分类下拉那一行：' + plain.classes.join('|'));
  assert.equal(plain.classHas('so-cats'), false, '旧的 chip 摘要条必须删净：一行读数和一枚下拉不能同时在场');
  assert.ok(plain.has('全部分类') && plain.has('2 组 · 4 项'), '分组数与总项数并排给出：' + plain.texts.join('|'));
  const pickBtn = plain.buttons.find((b) => b.text.includes('全选本组'));
  assert.ok(pickBtn, '没选具体分类时「全选本组」也要在场（禁用 + 说清为什么，比凭空消失好解释）：' + plain.buttons.map((b) => b.text).join('|'));
  assert.equal(pickBtn.disabled, true, '选「全部分类」时它没有作用对象');
  assert.match(pickBtn.title, /配置只读/, '禁用原因按 capsRO 优先（这颗按钮与两颗写按钮同闸）：' + pickBtn.title);
  // 标签的证人不能是「页面里出现过『分类』两个字」——「全部分类（2 组 · 4 项）」那格自带这两个字，
  // 把标签整颗删掉照样绿。要认就认这一层框和这个独立的文本节点。
  assert.ok(plain.classHas('so-cat-lb'), '下拉前面那个标签要有自己的类名（与原型 .cat-lb 同形）：' + plain.classes.join('|'));
  assert.equal(plain.texts.filter((t) => t === '分类').length, 1, '标签文本得单独成一句：光一枚下拉没人知道它是筛什么的');
  // 「全选本组」这一处喂的必须是本组 selectable，不是本组 ids：下游每个消费 sel 的地方都再过一遍
  // deniedOf，所以画面读不出差别（变异电池 CL-11 就是这么漏网的）—— 但集合里混进被拒项之后，
  // 任何一个新增消费者漏了过滤就中招。在调用点就喂对，比指望下游兜更便宜。
  assert.match(code, /onSelectGroup\(curGroup\.selectable\)/, '「全选本组」必须吃本组可选集合：' + (code.match(/onSelectGroup\([^)]*\)/) || ['未见'])[0]);
  assert.equal(/onSelectGroup\(curGroup\.ids\)/.test(code), false, '喂 ids 就是把 guard 拒掉的项一起塞进勾选集合');
  // 宿主能力齐了才轮到问「为什么这一颗是灰的」：没选具体分类 ⇒ 没有作用对象，要指去表头那颗框
  const capsOk = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), caps: { storageDomain: true }, latest: { diskFreeGb: 71.9, diskTotalGb: 214.7 } });
  assert.match(capsOk.buttons.find((b) => b.text === '全选本组').title, /整份清单的全选用表头那颗框/,
    '禁用必须交代去哪一颗：' + capsOk.buttons.find((b) => b.text === '全选本组').title);
  // 只读闸与「有没有选对分组」是两件事：能力不齐时哪怕选了分组，这颗也不许点（与两颗写按钮同闸）
  const roFiltered = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), catFilter: '浏览器缓存', latest: null });
  assert.equal(roFiltered.buttons.find((b) => b.text.includes('全选本组')).disabled, true,
    'capsRO 优先于「选了分组」：' + roFiltered.buttons.find((b) => b.text.includes('全选本组')).title);
  const capsOkFiltered = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), caps: { storageDomain: true }, catFilter: '浏览器缓存', latest: { diskFreeGb: 71.9, diskTotalGb: 214.7 } });
  assert.equal(capsOkFiltered.buttons.find((b) => b.text.includes('全选本组')).disabled, false,
    '能力齐 + 选了分组 ⇒ 这颗要能点（否则上面那条禁用断言就成了"永远禁用"的假证）');
  assert.equal(plain.buttons.filter((b) => b.role === 'checkbox' && b.ariaChecked === 'true').length, 1, '未筛选时按整份清单的勾选数');

  const filtered = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), catFilter: '浏览器缓存', latest: { diskFreeGb: 71.9, diskTotalGb: 214.7 } });
  assert.equal(filtered.buttons.filter((b) => b.role === 'checkbox').length, 3, '表头框 + 本组两行 = 3 颗，其余两行不再渲染');
  assert.equal(filtered.buttons.filter((b) => b.role === 'checkbox' && b.ariaChecked === 'true').length, 1,
    '筛选不许动勾选：本组露出的两行里还是只有 c 勾着（露出来的勾数变了就是筛选在改选择）');
  assert.ok(filtered.has('正在只看「浏览器缓存」'), '筛选态必须写明在看哪一组：' + filtered.texts.join('|'));
  assert.ok(filtered.has('其余 2 项仍在清单里、勾选状态没变'), '筛选不许被读成"取消勾选"：' + filtered.texts.join('|'));
  assert.ok(filtered.has('已选 1 项'), '已选读数吃的仍是整份清单的勾选集合，不随筛选变小：' + filtered.texts.join('|'));
  // 指路的话必须有被指的东西：S19-② 把操作条搬到表上方之后，这句再指「下方」就是假路标
  assert.ok(filtered.texts.some((t) => t.includes('上方「已选 N 项」与执行按钮')), '筛选态那句指路要朝上：' + filtered.texts.join('|'));
  assert.equal(plain.texts.some((t) => /下方「已选 N 项」/.test(t)), false, '旧朝下的路标不许留在任何一格里');

  // 筛选键对不上当前分组（换过一轮扫描、规则名变了）：既筛不出行也不许说「正在只看」
  const stale = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), catFilter: '上一轮的类名', latest: null });
  assert.equal(stale.texts.some((t) => /正在只看「/.test(t)), false, '拿着对不上号的旧键不许装作还在筛选：' + stale.texts.join('|'));
  assert.equal(stale.buttons.filter((b) => b.role === 'checkbox').length, 5, '对不上号就是没筛选，四行都在（表头框 + 4 行）');
  const staleSel = findSelectProps(CLEAN.CleanPage(cleanProps({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['c']), catFilter: '上一轮的类名', latest: null })), 'so-cat-select');
  assert.equal(staleSel.value, '', '下拉当前那一格也得回到「全部分类」：value 与画面不一致就是控件在说谎');
});

check('pg2-46 默认勾选只由卡头那一行交代，执行收尾要给出前后对比（S12-A，S20 删掉操作条那句复述）', () => {
  const plan = S12_PLAN();
  const latest = { diskFreeGb: 71.9, diskTotalGb: 214.7 };
  const hinted = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['a', 'c']), latest });
  // 「扫完默认勾了哪一批」这份信息全页只说一遍：卡头那行 `共 N 项 · 可清理 x · 有风险 y · 已拒绝 z`。
  // 操作条上那句「已默认勾上 N 项…」是按真机批注删的（同一份数在两处报，改一处漏一处）。
  assert.ok(hinted.has('共 4 项 · 可清理 2 · 有风险 1 · 已拒绝 1'), '卡头那一行要在场，它是默认勾选来路的唯一证人：' + hinted.texts.join('|'));
  assert.equal(hinted.texts.some((t) => /已默认勾上/.test(t)), false, '操作条那句复述不许留在任何一格（含原型半边同改，见 pg2-64）：' + hinted.texts.join('|'));

  const run = { total: 2, done: 2, ok: 2, skipped: 0, failed: 0, rejected: 0, currentPath: '', results: [], phase: 'done', startedAt: 1, summary: { beforeFree: 70.4e9, afterFree: 73.5e9, bytesFreed: 3.12e9 } };
  const ran = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(), latest, exec: run });
  assert.ok(ran.has('系统盘可用容量 65.6 GB → 68.5 GB'), '收尾前后对比（与留痕逐字同口径）：' + ran.texts.join('|'));
  const noSummary = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(), latest,
    exec: { ...run, summary: undefined } });
  assert.ok(!noSummary.has('系统盘可用容量'), 'POST 没回执时不编对比：' + noSummary.texts.slice(0, 8).join('|'));
});

check('pg2-47 容量换算在 client.js 里只有一处（S12-A 源码锁）：留痕与概览条不许各除一次', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  // 除 1e9 的容量口径已经收进 capText（1024 进制）；selTotals 里那个 1e9 是「显示 GB 数 × 1e9」的
  // 数字读数（pg2-7 钉的区间断言吃的就是它），不是文案换算，所以只锁文案那一侧。
  assert.equal(/\/\s*1e9\s*\)?\s*\.\s*toFixed/.test(code), false, '别处再除 1e9 出文案就会与概览条差 7%');
  assert.equal((code.match(/function capText/g) || []).length, 1, 'capText 只能有一份');
  assert.match(code, /snapshot: `系统盘可用容量 \$\{capOrMissing\(lg\.beforeFree\)\} → \$\{capText\(lg\.afterFree\)\}/, '留痕行要走这两个函数，不自己拼数');
});

/* S12-A 问题①「到底扫了哪些目录」：扫描范围读数 + 扫描进度的分母换域 */

/**
 * GET /api/rules 的真机形状（lib/api.js:493-502）：`items` 是本机自建规则、`off` 是被关掉的内置 id、
 * `builtin` 是宿主裁决过的公开字段行。
 * 内置行**只有** id/n/kind/ageDays/note/rel/builtin/enabled —— 真接口的 map 就把 dir/glob 剔掉了，
 * 桩多给一个键就等于给页面留一条能泄本机私有路径的口子（Ruling-106）。
 */
const RULES_ROW = (over = {}) => ({
  items: [{ id: 'u-1', n: '我的下载缓存', kind: '缓存', ageDays: 30, note: '', glob: 'C:\\Users\\gongj\\Downloads\\cache\\*', builtin: false }],
  off: ['packages-cache'],
  updatedAt: 1,
  builtin: [
    { id: 'temp-user', n: '用户临时目录', kind: '缓存', ageDays: 3, note: '系统与应用共用', rel: 'AppData/Local/Temp', builtin: true, enabled: true },
    { id: 'npm-cache', n: 'npm 下载缓存', kind: '缓存', ageDays: 30, note: '清掉后首个 npm i 需重新下载', rel: 'AppData/Local/npm-cache', builtin: true, enabled: true },
    { id: 'packages-cache', n: 'UWP 包缓存', kind: '缓存', ageDays: 60, note: '范围较大，默认关闭', rel: 'AppData/Local/Packages', builtin: true, enabled: false },
  ],
  ...over });

check('pg2-48 scanScope 与宿主 activeRules() 同式（S12-A）：开启的内置 + 自建，停用的那批不计数', () => {
  const s = CLEAN.scanScope(RULES_ROW());
  assert.equal(s.on.length, 2, 'enabled:false 的内置不进待遍历集合');
  assert.deepEqual(s.off.map((o) => o.key), ['packages-cache']);
  assert.equal(s.user.length, 1);
  assert.equal(s.total, 3, '分母 = 开启的内置 + 自建（lib/prefs/rules-store.js:68-71 同式）');
  assert.deepEqual(s.on.map((o) => o.rel), ['AppData/Local/Temp', 'AppData/Local/npm-cache']);
  assert.equal(s.on[0].ageDays, 3);
  assert.equal(s.known, true, '宿主给了内置行 = 读数到位');
  // 老形状与读不到的形状都不能造数
  assert.equal(CLEAN.scanScope([{ id: 'u-1', n: 'x', kind: '缓存' }]).total, 1, '只给数组 = 纯自建规则、没有内置行');
  const none = CLEAN.scanScope(null);
  assert.equal(none.total, 0, '读不到规则就不报数，不猜一个 12');
  assert.deepEqual(none.on, []);
  assert.equal(none.known, false, '一条内置行都没给 ⇒ 这是"没读到"，不是"全停用"');
  // 内置全停用（宿主仍逐条给出 enabled:false）：读数是在的，只是总数为 0
  const allOff = CLEAN.scanScope(RULES_ROW({ builtin: RULES_ROW().builtin.map((b) => ({ ...b, enabled: false })) }));
  assert.equal(allOff.known, true);
  assert.equal(allOff.total, 1, '只剩那 1 条自建');
  assert.equal(allOff.on.length, 0);
  // 桩没给 dir/glob（宿主也不出这两个键），页面若去读它们就是第二份路径口径
  const body = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8').split('function scanScope')[1].split('\n    }')[0];
  assert.equal(/\.dir\b|\.glob\b/.test(body), false, 'scanScope 不许读 dir/glob：展开后含本机私有路径');
});

check('pg2-49 扫描范围卡逐条列出被扫的目录（S12-① 问题①），只出 ~/rel、不出绝对路径 —— 明细在「展开」之后', () => {
  const out = walkClean({ rules: RULES_ROW(), scopeOpen: true });
  assert.ok(out.has('用户临时目录'), out.texts.join('|'));
  assert.ok(out.has('~/AppData/Local/Temp'), 'rel 前挂 ~ 表示相对用户目录：' + out.texts.join('|'));
  assert.ok(out.has('缓存 · 满 3 天'), 'ageDays 要交代候选门槛：' + out.texts.join('|'));
  assert.ok(out.texts.some((t) => t.includes('本次待遍历 3 类目录')), out.texts.join('|'));
  assert.ok(out.has('已停用的内置规则 1 条、不在本次范围：UWP 包缓存'), '关掉的那条要说出来，不然用户以为还在扫');
  // 自建规则只报名字与分类：glob 是用户自己写的本机路径，这张卡不复述
  assert.ok(out.has('我的下载缓存'), out.texts.join('|'));
  assert.equal(out.texts.some((t) => t.includes('C:\\Users\\gongj\\Downloads')), false, '扫描范围卡不许出现本机绝对路径');
  assert.equal(out.texts.some((t) => t.includes('C:\\Users\\gongj\\AppData')), false, '内置规则的 dir 展开形态不上屏');
  // 读不到 GET /api/rules 时（rules 为 null）如实说读不到，不落一个数字
  const noRules = walkClean({ rules: null, scopeOpen: true });
  assert.ok(noRules.texts.some((t) => /规则读数还没拿到/.test(t)), noRules.texts.join('|'));
  assert.equal(noRules.texts.some((t) => /待遍历 \d+ 类目录/.test(t)), false, '读不到就不报数');
  // 另一种空：内置全停用（宿主照样逐条给）⇒ 说「没有启用的规则」，不能说「没读到」
  const allOff = walkClean({ rules: RULES_ROW({ items: [], builtin: RULES_ROW().builtin.map((b) => ({ ...b, enabled: false })) }), scopeOpen: true });
  assert.ok(allOff.texts.some((t) => /本次没有任何启用的规则/.test(t)), allOff.texts.join('|'));
  assert.equal(allOff.texts.some((t) => /规则读数还没拿到/.test(t)), false, '"全停用"与"没读到"是两件事，别混成一句');
});

/* S13（真机截图批注「你这些东西放在这里干什么，占地方又没用，只显示关注的东西」）：
   扫描范围卡默认收成一行摘要，明细就地展开；两句实话（没读到 / 全停用）收起态也要看得见。 */

check('pg2-58 扫描范围默认收成一行摘要（S13）：目录明细与口径说明就地展开，不是浮层', () => {
  const closed = walkClean({ rules: RULES_ROW() });
  assert.equal(closed.classHas('so-scope'), false, '收起态不许还画那张目录网格');
  assert.equal(closed.has('用户临时目录'), false, '明细要真的从渲染树里拿掉，不是留着占位');
  assert.equal(closed.has('「满 N 天」是按最后访问时间'), false, '口径说明也归入明细');
  assert.ok(closed.has('展开明细'), '收起态必须留一颗还能展开的按钮：' + closed.texts.join('|'));
  assert.ok(closed.texts.some((t) => t.includes('本次待遍历 3 类目录')), '摘要行照旧报数（S12-① 那问的答案不能整条丢掉）');
  // 句式逐字定住：原型 index.html 的 scopeSub 与这边必须同形（两边同改是全局约束）
  assert.ok(closed.texts.includes('内置启用 2 条（共 3 条）· 自建 1 条 · 本次待遍历 3 类目录 · 另有 1 条已停用'),
    '摘要句式变了就要连原型一起改：' + closed.texts.filter((t) => /待遍历/.test(t)).join('|'));
  const open = walkClean({ rules: RULES_ROW(), scopeOpen: true });
  assert.ok(open.has('收起明细'), open.texts.join('|'));
  assert.equal(open.has('展开明细'), false, '同一时刻不许两颗同义按钮（一句真相）');
  // 交互只有这一条路：卡头那颗按钮接 onToggleScope（容器侧的真点击见 cn-23）
  const bo = open.buttons.find((x) => x.text === '收起明细');
  assert.ok(bo && bo.ariaExpanded === 'true' && bo.onClick, 'aria-expanded 要跟着翻，读屏才知道状态：' + JSON.stringify(bo));
  const bc = closed.buttons.find((x) => x.text === '展开明细');
  assert.ok(bc && bc.ariaExpanded === 'false' && bc.onClick, '收起态 aria-expanded=false：' + JSON.stringify(bc));
});

check('pg2-59 收起态仍然看得见的两句实话（S13 × 诚实降级）：没读到 / 全停用都不许藏在展开后面', () => {
  const noRules = walkClean({ rules: null });
  assert.ok(noRules.texts.some((t) => /规则读数还没拿到/.test(t)), '读数缺失要当面说：' + noRules.texts.join('|'));
  assert.equal(noRules.has('展开明细'), true, '说明行不替代明细按钮');
  const allOff = walkClean({ rules: RULES_ROW({ items: [], builtin: RULES_ROW().builtin.map((b) => ({ ...b, enabled: false })) }) });
  assert.ok(allOff.texts.some((t) => /本次没有任何启用的规则/.test(t)), allOff.texts.join('|'));
  // 摘要与说明各说各的：一个报数、一个报「数为什么是这样」，同一句不许出现两遍
  for (const out of [noRules, allOff]) {
    assert.equal(out.texts.filter((t) => /规则读数还没拿到|本次没有任何启用的规则/.test(t)).length, 1,
      '一句降级说明只许一处：' + out.texts.join('|'));
  }
  // 健康态（有启用规则）不许把这两句也带上
  const ok = walkClean({ rules: RULES_ROW() });
  assert.equal(ok.texts.some((t) => /规则读数还没拿到|本次没有任何启用的规则/.test(t)), false, ok.texts.join('|'));
  // 页面错误按触发的卡归位（spec §4.7）：rules 读失败落「扫描范围」卡，收起态也必须看得见
  const e = { source: 'rules', status: 500, code: 'RULES_READ_FAILED', message: '读规则失败' };
  const eClosed = walkClean({ rules: RULES_ROW(), err: e });
  const eOpen = walkClean({ rules: RULES_ROW(), err: e, scopeOpen: true });
  for (const out of [eClosed, eOpen]) {
    assert.ok(out.has('接口异常（RULES_READ_FAILED）'), '错误条不能藏在展开后面：' + out.texts.join('|'));
    assert.equal(out.texts.filter((t) => /接口异常（RULES_READ_FAILED）/.test(t)).length, 1,
      '一条错误只落一张卡，收起与展开都不许复述两遍：' + out.texts.join('|'));
  }
  assert.equal(eClosed.has('展开明细'), true, '报错不许顺手把明细按钮收掉');
  // 非 rules 来源的错误仍落当前主卡（空态卡），不跑到范围卡去
  const eMain = walkClean({ rules: RULES_ROW(), err: { source: 'clean/scan', status: 500, code: 'X', message: 'm' } });
  assert.ok(eMain.has('展开明细'), '范围卡此时只是正常收起');
});

check('pg2-60 空态卡压成一行（S13）：不再占半屏，但「去哪儿扫 + 扫描危不危险」两句都在', () => {
  const out = walkClean({});
  assert.ok(out.has('尚未扫描'), out.texts.join('|'));
  assert.ok(out.has('「开始扫描」'), '入口位置要说清楚（页头那颗，见 pg2-27）');
  assert.ok(out.has('扫描是只读的'), '只读承诺不能随版式一起压掉：' + out.texts.join('|'));
  assert.ok(out.texts.some((t) => /删除只发生在你勾选之后/.test(t)), out.texts.join('|'));
  assert.equal(out.classHas('so-empty'), false, '26px 居中的大空白盒子就是这次要压掉的东西');
  // 空态卡里不许长出第二颗扫描按钮（页头那颗是唯一入口）
  assert.equal(out.buttons.filter((b) => b.text.includes('开始扫描')).length, 0);
  // 扫描失败时错误条还在这张卡里，不能因为压薄就没了落点
  const bad = walkClean({ clean: { ...IDLE, phase: 'idle', error: 'EACCES: 权限不足' } });
  assert.ok(bad.has('扫描失败：EACCES: 权限不足'), bad.texts.join('|'));
});

check('pg2-57 原型页同步（S13）：同一颗就地展开按钮、同一句空态话，两边不许各写一份', () => {
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.match(proto, /<div class="card-body" id="scopeBody" hidden>/, '原型的明细块必须默认 hidden（= client.js 的收起默认）');
  assert.match(proto, /id="btnScopeToggle"[^>]*aria-expanded="false"[^>]*>展开明细</, '原型那颗按钮的标签与 aria 态要一致');
  // 这一句要落在**语句位**（顶格/缩进后直接是调用）：注释里留一份 `// setScopeOpen(false);` 不算数
  assert.match(proto, /^[ \t]*setScopeOpen\(false\);[ \t]*$/m, '原型初始化要显式收到收起态，别只靠 HTML 上那一个 hidden');
  const idle = proto.match(/id="cleanIdle"[\s\S]*?class="hint"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(idle, '原型空态那一行找不到了');
  const protoIdle = idle[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  assert.equal(/class="empty"/.test(proto.match(/id="cleanIdle"[\s\S]*?<\/div>/)[0]), false, '原型也不许再套那层 26px 居中大空白');
  const out = walkClean({});
  const i = out.texts.findIndex((t) => t.startsWith('尚未扫描'));
  const clientIdle = out.texts.slice(i, i + 4).join('').replace(/\s+/g, '');
  assert.ok(clientIdle.length > 40, 'client 空态的句子被拆得不是四段了，这条比对要一起改：' + JSON.stringify(out.texts.slice(i, i + 4)));
  assert.equal(clientIdle, protoIdle, '空态那句话两边一字不差：' + clientIdle + ' <> ' + protoIdle);
  // 摘要句式逐段钉住（跟 pg2-58 那句 client 逐字读数是同一套）：原型只改某一段，这条也要红
  assert.match(proto, /'内置启用 ' \+ bi\.length \+ ' 条（共 ' \+ builtinAll\.length \+ ' 条）· 自建 '/,
    '原型摘要第一段与 client.js 脱钩了（两边同改）');
  assert.match(proto, /\+ user\.length \+ ' 条 · 本次待遍历 ' \+ usable\.length \+ ' 类目录'/,
    '原型摘要第二段与 client.js 脱钩了');
  assert.match(proto, /\+ \(off\.length \? ' · 另有 ' \+ off\.length \+ ' 条已停用' : ''\)/,
    '原型摘要「已停用」那一档与 client.js 脱钩了');
});


/* S14（上一轮记下、这一轮用户批「都处理了」的两处）：分类 chip 把类名念两遍 + 清单表数值列折成两行。 */

check('pg2-61 分类读数只念一遍类名（S14）：分组不再拿首项 kind 冒充整组，收进下拉后读数一字不丢', () => {
  const plan = S12_PLAN();
  const latest = { diskFreeGb: 71.9, diskTotalGb: 214.7 };
  const props = (p, sel) => ({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: p, sel: sel || new Set(), latest });
  const g = CLEAN.categoryGroups(plan, new Set());
  assert.equal(g.find((x) => x.key === '系统临时目录').kind, undefined,
    '组上不再挂 kind：同一组里 a 是缓存、d 是日志，首项的 kind 说明不了整组');
  const out = walkClean(props(plan));
  assert.equal(out.texts.some((t) => /^(缓存|日志) · \d+ 项/.test(t)), false,
    'option 的计数段不再以 kind 开头（它从来只有「类名 + 计数」两段）：' + out.texts.join('|'));
  // S19-①：chip 收成 select 的 option 后，「计数 / 合计大小 / 三档计数」整句搬进 option 文案，一条都不许省
  assert.ok(out.texts.some((t) => t.startsWith('浏览器缓存 · 2 项 · ') && t.includes('可清理 1')),
    '分组读数必须完整出现在下拉里：' + out.texts.join('|'));
  assert.ok(out.texts.some((t) => t === '浏览器缓存 · 2 项 · 950 B · 可清理 1 · 有风险 1'),
    '有风险那一档要写在 option 上（组内 mid 项）：' + out.texts.join('|'));
  assert.ok(out.texts.some((t) => t === '系统临时目录 · 2 项 · 110 B · 可清理 1 · 已拒绝 1'),
    '已拒绝那一档也要写在 option 上（guard 拒的 d 项）：' + out.texts.join('|'));
  // 用户报的那一颗：规则名与 kind 同名（崩溃转储）时才会显形出「念两遍」
  const dup = walkClean(props(PLAN([ITEM({ id: 'x', ruleName: '崩溃转储', kind: '崩溃转储', size: 100, riskLevel: 'low' })])));
  const dupOpt = dup.texts.find((t) => t.startsWith('崩溃转储')) || '';
  assert.equal(dupOpt.split('崩溃转储').length - 1, 1, '类名只许念一遍：' + dup.texts.join('|'));
  assert.equal(dupOpt, '崩溃转储 · 1 项 · 100 B · 可清理 1', dup.texts.join('|'));
  // 两边同改：原型 option 的模板形状钉住，谁先加回 kind 谁先红
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.match(proto, /return g\.key \+ ' · ' \+ g\.count \+ ' 项 · ' \+ g\.bytesText \+ ' · 可清理 ' \+ g\.cleanable/,
    '原型 option 只有「类名 + 计数」两段（client 要与它同形）');
  assert.match(proto, /\(g\.risky \? ' · 有风险 ' \+ g\.risky : ''\) \+ \(g\.rejected \? ' · 已拒绝 ' \+ g\.rejected : ''\)/,
    '有风险 / 已拒绝 两档在原型 option 里也要在（chip 收进下拉之后，两边谁都不许少一档）');
});

check('pg2-62 数值列不换行（S14）：client 与原型同一处 CSS 口径，「656 MB」不许折成两行', () => {
  const code = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.match(code, /\.so-tbl \.so-r\{[^}]*white-space:nowrap[^}]*\}/,
    '数值列（大小 / 最后访问 / PID / 修改时间）要单行：路径列 nowrap 撑住最小宽度后，自动布局把富余从数值列抠走');
  assert.match(code, /\.so-tbl \.so-path\{white-space:nowrap\}/,
    '路径列那条 nowrap 是这一处折行的根因，两条形影不能只留一条（撤了它表格会被压扁成一字符宽）');
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.match(proto, /\.tbl \.r\{[^}]*white-space:nowrap[^}]*\}/, '原型同一处要同规（两边同改是全局约束）');
});

check('pg2-63 操作条落在清单表上方且条上只剩「读数 + 两颗按钮」（S19-② + S20「这些不要了」）', () => {
  const plan = S12_PLAN();
  const out = walkClean({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan, sel: new Set(['a']), latest: { diskFreeGb: 71.9, diskTotalGb: 214.7 } });
  const idx = (re) => out.texts.findIndex((t) => re.test(t));
  const iTot = idx(/已选 1 项 · 预计释放/), iTbl = idx(/路径 \/ 内容/);
  assert.ok(iTot >= 0 && iTbl >= 0, '读数与表头两段都要在场：' + out.texts.join('|'));
  assert.ok(iTot < iTbl, '操作条必须在表前面（texts 是文档序）：' + iTot + ' vs ' + iTbl);
  // 三句说明按真机批注删净，删完不许在页面任何角落复活（搬去别处复述也算违规）
  for (const re of [/删除不可恢复，回收站不参与/, /^勾选至少一项$/, /已默认勾上/, /执行方式取自快照 modeDefault/]) {
    assert.equal(out.texts.some((t) => re.test(t)), false, `这句已经不要了，不许出现在画面里：${re}`);
  }
  assert.equal(out.classHas('so-tot-note'), false, '那条另起一行的说明容器随之删净：' + out.classes.join('|'));
  assert.equal(out.buttons.filter((b) => b.text === '清理选中').length, 1, '两颗「清理选中」就是两份执行入口：' + out.buttons.map((b) => b.text).join('|'));
  assert.equal(out.buttons.filter((b) => b.text === '隔离到暂存目录').length, 1, '隔离同理');
  assert.ok(out.classHas('so-tot'), '操作条那层框的类名要与原型 .tot 同形：' + out.classes.join('|'));
});

check('pg2-64 两边同改（S19）：原型的分类下拉与操作条位置同口径，旧 chip 条两边都删净', () => {
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  assert.ok(proto.includes('<select class="cat-select" id="catSel"'), '原型也要有那一枚下拉');
  assert.ok(proto.includes("el('catStrip').addEventListener('change'"), '下拉要真接 change 事件（原型自己也得点得动）');
  assert.equal(proto.includes('class="cats"'), false, '旧 chip 条不许留在原型里');
  assert.equal(proto.includes('data-cat='), false, '旧的 chip 点击代理同样要删净，不然留一条死代码路径');
  const iTot = proto.indexOf('<div class="tot">');
  const iTbl = proto.indexOf('<div class="tbl-wrap tbl-wrap-plan">');
  assert.ok(iTot >= 0 && iTbl >= 0, '原型操作条与清单表都在场');
  assert.ok(iTot < iTbl, '原型操作条也在表上方（markup 顺序 = 画面顺序）');
  assert.equal(proto.split('<div class="tot">').length - 1, 1, '原型里 .tot 只许一处：搬完必须把原来那份删掉');
  assert.ok(proto.includes('上方「已选 N 项」与执行按钮'), '筛选态那句指路两边同口径（都朝上）');
  const code = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  assert.equal(code.split("'清理选中'").length - 1, 1, 'client 也只许一颗「清理选中」');
  assert.equal(code.includes('.so-cats'), false, 'client 侧旧类名一并删净：留着的就是死 CSS');
  /* S20（真机批注「这些不要了」）：操作条那三句说明两边一起删净。画面半边由 pg2-46 / pg2-63 钉，
     这里钉图纸 —— 图纸留着那句话，下一轮就照图纸把它搬回来（原型是 spec 的那条规矩）。
     client 侧要先 stripComments：那一处注释里逐字引用了被删的三句（历史交代），注释不算留在页面上。 */
  const codeNoC = stripComments(code);
  const protoNoC = stripComments(proto.replace(/<!--[\s\S]*?-->/g, ''));
  for (const [f, src] of [['client.js', codeNoC], ['prototype/index.html', protoNoC]]) {
    for (const gone of ['删除不可恢复，回收站不参与', '执行方式取自快照 modeDefault', '已默认勾上', 'so-tot-note', 'autoSelNote', 'totNote']) {
      assert.equal(src.includes(gone), false, `${f}：「${gone}」这一句/这一处已经不要了，一行都不许留`);
    }
  }
  assert.match(codeNoC, /勾选至少一项后才可执行/, '删的是操作条那句复述，两颗写按钮 title 里的禁用原因得留着');
  /* S20 截图核对抓到的分岔：原型 .tot .grow 有 margin-left:auto（按钮贴右），client 那颗 .so-grow
     只挂了内联 display:inline-flex —— CSS 注释写着「两颗写按钮贴右」，规则却根本不存在。
     两边都必须在样式层有这一条，内联样式不算（内联里没有 margin-left:auto，读数就挤在左边）。 */
  assert.match(code, /\.so-tot \.so-grow\{margin-left:auto[^\n]*\}/, 'client：按钮贴右要由 .so-tot .so-grow 这条规则给');
  assert.equal(/className: 'so-grow', style: \{ display: 'inline-flex'/.test(code), false,
    'client：那颗 .so-grow 不许再靠内联样式活着（规则得回到 CSS 里，与原型同处）');
  assert.match(proto, /\.tot \.grow\{margin-left:auto/, '原型：同一条口径的另一半');
  /* 操作条搬上去之后，全页指路的话只能朝上（「每句指路都要有被指的东西」那条规矩）。
     这两句不吃渲染分支（一句要 AI 已采纳、一句要零可清理），走查里够不着，就在源码这一层钉住。 */
  for (const [f, src] of [['client.js', code], ['prototype/index.html', proto]]) {
    assert.ok(src.includes('复核后点上面「清理选中」'), `${f}：AI 采纳后那句要指「上面」`);
    assert.ok(src.includes('请勾选项后用上面的「清理选中」'), `${f}：零可清理那句也要指「上面」`);
    assert.equal(/下面「清理选中」|用下方按钮|点下面的「清理选中」/.test(src), false,
      `${f}：还朝「下面」指路的旧话一句都不许留（操作条已经在表上方了）`);
  }
});

check('pg2-50 扫描进度分母换成「类目录」（S12-A）：第 N / 共 M 上屏，旧宿主不凑百分比', () => {



  const c = CLEAN.scanCells({ ...SCAN, ruleIdx: 3, rulesLen: 10 });
  assert.equal(c.pct, 30, '分子分母同域：ruleIdx/rulesLen，不再是命中数除规则数');
  assert.equal(c.ruleText, '第 3 / 共 10 类目录');
  // 扫到最后一类还没收帧：条子封顶 96%，真完成由 clean:done 定
  assert.equal(CLEAN.scanCells({ ...SCAN, ruleIdx: 10, rulesLen: 10 }).pct, 96);
  const old = CLEAN.scanCells(SCAN);
  assert.equal(old.pct, null, '旧宿主帧没这两个键 ⇒ 不定量，绝不拿 hit/rulesTotal 凑一个假进度');
  assert.equal(old.ruleText, '');
  const out = walkClean({ clean: { ...SCAN, ruleIdx: 3, rulesLen: 10 } });
  assert.ok(out.has('第 3 / 共 10 类目录'), out.texts.join('|'));
  assert.ok(!out.has('进度未知'), '有分母就不该再说进度未知');
  assert.ok(out.has('扫描可随时中断，中断后已发现的部分仍可继续查看。进度条走的是「扫完几类目录 / 共几类」，不是字节进度，真实完成以扫描结束为准。'),
    '卡面的口径说明要跟着换成新分母：' + out.texts.join('|'));
});

/* S12-③ AI 智能清理的纯读数三张表：按钮态、三档 pill、采纳集合。
   界面不许在别处再抄一份动作文案（AI_ACTION_CELL 是唯一出口），真点击接线见 cn-18/cn-19。 */
const AI_REC = (over = {}) => ({ group: 0, ruleId: 'r', ruleName: '浏览器缓存', kind: '缓存', count: 2, bytes: 1.2e7, cleanable: 1, risky: 1, action: 'clean', reason: '可重建', ids: ['b1', 'b2'], ...over });
const AI_RUN = (over = {}) => ({ phase: 'done', planId: 'plan-1', result: { planId: 'plan-1', at: 2, provider: 'p', model: 'm', recommendations: [AI_REC()], note: '' }, error: null, picked: new Set(), adoptedN: 0, ...over });

check('pg2-54 aiButton 决策表（S12-③）：六种「亮不起来」各说一句，就绪度没读到 ≠ 宿主没模型', () => {
  const B = CLEAN.aiButton;
  // ready 用 `'ready' in o` 判存在：`??` 会把显式传的 null（= 还没问到）当成缺省值吃掉，正好漏掉要证的那一态
  const has = (o) => ({ ready: 'ready' in o ? o.ready : { available: true }, run: o.run ?? null, hasPlan: o.hasPlan ?? true, execBusy: o.execBusy ?? false });
  const running = B(has({ run: { phase: 'running', planId: 'plan-1' } }));
  assert.equal(running.disabled, true);
  assert.match(running.label, /正在判定/);
  assert.match(running.why, /不会自动执行任何删除/, '执行中要说清 AI 不动手：' + running.why);
  const noPlan = B(has({ hasPlan: false }));
  assert.equal(noPlan.disabled, true);
  assert.match(noPlan.why, /先扫描生成清单/);
  const notYet = B(has({ ready: null }));
  assert.equal(notYet.disabled, true);
  assert.match(notYet.why, /还没问到宿主模型/, '「没问到」与「宿主没有」是两件事：' + notYet.why);
  const noModel = B(has({ ready: { available: false, reason: '宿主没配模型' } }));
  assert.equal(noModel.disabled, true);
  assert.equal(noModel.why, '宿主没配模型', 'reason 逐字透出，界面不改写');
  const busy = B(has({ execBusy: true }));
  assert.equal(busy.disabled, true);
  assert.match(busy.why, /正在执行/);
  const failed = B(has({ run: { phase: 'error', planId: 'plan-1', error: { code: 'AI_TIMEOUT', message: '超时' } } }));
  assert.equal(failed.disabled, false, '失败之后必须可以再问一次');
  assert.match(failed.label, /重新征求/);
  const done = B(has({ run: AI_RUN() }));
  assert.equal(done.disabled, false);
  assert.equal(done.label, '重新征求 AI 建议');
  assert.match(done.why, /只推荐/, '按钮的 title 就要说清"只推荐"：' + done.why);
  const fresh = B(has({}));
  assert.equal(fresh.label, 'AI 智能清理');
});

check('pg2-55 三档动作只有一张表（S12-③）：clean/review/keep 的文案与配色各异，未知动作不冒充可采纳', () => {
  const CELLS = CLEAN.AI_ACTION_CELL;
  assert.deepEqual(Object.keys(CELLS), ['clean', 'review', 'keep']);
  const labels = Object.values(CELLS).map((c) => c.label);
  assert.equal(new Set(labels).size, 3, '三档三样文案，撞了就没法一眼分开：' + labels.join('|'));
  assert.equal(new Set(Object.values(CELLS).map((c) => c.cls)).size, 3, '三档三张 pill 皮：' + Object.values(CELLS).map((c) => c.cls).join('|'));
  assert.deepEqual(Object.values(CELLS).map((c) => c.pick), [true, false, false], '只有「建议清理」默认勾上');
  const recs = CLEAN.aiRecommendations(AI_RUN({ result: { recommendations: [
    AI_REC({ group: 0, action: 'clean' }), AI_REC({ group: 1, action: 'review' }), AI_REC({ group: 2, action: 'keep' }),
    AI_REC({ group: 3, action: 'rm -rf' }),
  ] } }));
  assert.deepEqual(recs.map((r) => r.cell.label), ['建议清理', '建议先看一眼', '建议保留', 'rm -rf']);
  assert.equal(recs[3].cell.cls, 'so-pill-line', '越界的动作只能灰着如实念出来，不许借任一档的皮');
  assert.equal(CLEAN.aiRecommendations(null).length, 0, '没有回话就是没有建议，不猜');
  assert.equal(CLEAN.aiRecommendations(AI_RUN({ result: { recommendations: 'x' } })).length, 0, '形状不对不当建议用');
});

check('pg2-56 采纳集合 = 勾上那些类的 ids 并集（S12-③）：只认服务端交回的 ids，页面不产 id', () => {
  const run = AI_RUN({ result: { recommendations: [AI_REC({ group: 0, ids: ['b1', 'b2'] }), AI_REC({ group: 1, ids: ['a1'] }), AI_REC({ group: 2, ids: [] })] }, picked: new Set([0, 1]) });
  assert.deepEqual(CLEAN.aiAdoptIds(run), ['b1', 'b2', 'a1']);
  assert.deepEqual(CLEAN.aiAdoptIds({ ...run, picked: [0, 2] }), ['b1', 'b2'], 'picked 也给数组形态（Set 之外不挑）');
  assert.deepEqual(CLEAN.aiAdoptIds({ ...run, picked: new Set() }), [], '一个没勾 ⇒ 空集，不许默认全采纳');
  assert.deepEqual(CLEAN.aiAdoptIds(null), []);
  // 面板侧：未征求 / 收起 ⇒ 不渲染；planId 与在场清单不一致 ⇒ 旧建议整块不贴
  const P = PLAN([ITEM()], 3);
  const base = { clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: P, ai: { available: true, provider: 'p', model: 'm' } };
  assert.equal(walkClean(base).classHas('so-ai'), false, '没征求过不许压一块空面板：' + JSON.stringify(walkClean(base).classes.filter((c) => c.includes('ai'))));
  assert.equal(walkClean({ ...base, aiRun: AI_RUN({ planId: 'plan-1' }) }).classHas('so-ai'), true, '同一份清单 ⇒ 面板在场');
  assert.equal(walkClean({ ...base, aiRun: AI_RUN({ planId: 'plan-old' }) }).classHas('so-ai'), false, '建议贴的是另一份清单 ⇒ 整块不渲染');
  const err = walkClean({ ...base, aiRun: { phase: 'error', planId: 'plan-1', result: null, error: { code: 'AI_TIMEOUT', message: '45 秒没回话' }, picked: new Set() } });
  assert.ok(err.classHas('so-ai') && err.has('征求 AI 建议失败（AI_TIMEOUT）：45 秒没回话'), '失败态就地可见：' + err.texts.join('|'));
  assert.ok(err.btn('再问一次'), '失败态要留一颗重问的按钮');
  const running = walkClean({ ...base, aiRun: { phase: 'running', planId: 'plan-1', result: null, error: null, picked: new Set() } });
  assert.ok(running.has('正在请宿主模型判定') && running.has('它只给建议，删不删还是你点'), '等待态要说清不自动执行：' + running.texts.join('|'));
});

/* S12-①/②：留痕入口搬家 + 页头降噪。三件事都是「哪块信息长在哪」的信息架构决定，
   纯渲染形状在这里钉，真点击接线见 cn-17。 */

const LOG1 = [{ logId: 'CLN-2609-0007', planId: 'plan-1', startedAt: 1, finishedAt: 2, mode: 'delete-file', itemIds: ['a'],
  ok: 1, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.2e9, beforeFree: 70.4e9, afterFree: 71.6e9, error: '' }];
const DONE_PLAN = (over = {}) => cleanProps({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), ...over });

check('pg2-51 留痕改成页头入口 + 就地展开面板（S12-①）：收起态页面里没有它，展开态它是第一张卡', () => {
  const closed = walkClean(DONE_PLAN({ logs: LOG1 }));
  assert.equal(closed.classHas('so-logpanel'), false, '默认收起：不许一进来就占一整屏历史记录');
  assert.equal(closed.has('CLN-2609-0007'), false, '收起态连记录本体都不该在 DOM 里');
  const vnode = CLEAN.CleanPage(DONE_PLAN({ logs: LOG1, logsOpen: true }));
  const kids = (vnode.children || []).filter((k) => k && typeof k === 'object');
  assert.ok(walk(kids[0]).has('清理留痕'), '展开的留痕面板要贴在页面顶部（页头按钮点开的落点）：' + kids.length);
  assert.ok(walk(kids[0]).classHas('so-logpanel'), '面板必须套在限高滚动框里');
  assert.ok(kids[1] && walk(kids[1]).has('扫描范围'), '留痕之后才是扫描范围，其余卡序不动');
  const open = walk(vnode);
  assert.ok(open.has('CLN-2609-0007'), '展开后要能看到留痕本体');
  assert.ok(open.has('收起'), '面板自己也要能收起（入口不能只有一扇门）');
  assert.equal(open.texts.filter((t) => t.includes('清理留痕')).length, 1, '底部那张常驻卡必须删掉，不能两处各一份');
  // 一条记录都没有时也要打得开：空面板 + 一句实话，比按钮消失好解释（诚实降级）
  const empty = walkClean({ logsOpen: true });
  assert.ok(empty.has('还没有清理记录'), empty.texts.join('|'));
});

check('pg2-52 页头降噪（S12-②）：SSE 健康态不再挂「推送通道 SSE」，降级与重连仍如实标注', () => {
  const sse = walkClean(DONE_PLAN());
  assert.equal(sse.has('推送通道 SSE'), false, '健康态不需要每屏自证通道正常');
  assert.equal(sse.has('降级：轮询 2s'), false);
  assert.equal(sse.has('重连中'), false);
  const polling = walkClean(DONE_PLAN({ link: 'polling' }));
  assert.ok(polling.has('降级：轮询 2s'), '降级必须标出来：' + polling.texts.join('|'));
  assert.ok(polling.classHas('so-pill-amber'), '降级用琥珀，不用灰色混进次要信息');
  const rc = walkClean(DONE_PLAN({ link: 'reconnecting' }));
  assert.ok(rc.has('重连中'), rc.texts.join('|'));
});

check('pg2-53 红线提示条挪到清理页最下面（S12-②「放在最下面展示」），且全页只有一句', () => {
  const out = walkClean(DONE_PLAN({ logs: LOG1, logsOpen: true, scopeOpen: true }));
  const idx = (re) => out.texts.findIndex((t) => re.test(t));
  const iRed = idx(/红线由服务端 guard 单点裁决/);
  assert.ok(iRed >= 0, '红线说明不能整条丢掉');
  assert.equal(out.texts.filter((t) => /红线由服务端 guard 单点裁决/.test(t)).length, 1, '一处裁决说明，两处复述就是两份真相');
  assert.ok(iRed > idx(/「满 N 天」是按最后访问时间/), '不能还长在「扫描范围」卡里');
  // 判据原本借的是操作条那句 modeDefault（S20 删掉了），换成清单表头 —— 同样是「清单卡之后」的位置证人
  assert.ok(iRed > idx(/路径 \/ 内容/), '要在清单卡之后，也就是页面最下面');
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
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  globalThis.__SYSOPS__ = clientPayload({ searchAdvice: A });
  try {
    assert.deepEqual(SRCH.advice(), A);
    // I-4 渲染证人：三条指引逐行进引导卡（M2 变异「advice 改读自建常量 / probe.advice」必须在这里红）
    const on = PAGE({});
    for (const line of A) assert.ok(on.has(line), '注入的指引行该逐条渲染：' + line + '；实际：' + on.texts.join('|'));
    assert.ok(!on.has('WINGET 诱饵：不要从 probe.advice 取文案'), 'probe.advice 里的诱饵不许上屏');
    assert.ok(!code.includes('voidtools.com'), 'client.js 里不该出现第二份安装指引文案');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
  // 载荷没给（默认 searchAdvice: []）⇒ 宁缺毋滥：引导卡在，但不许冒出任何自编的命令与下载地址
  // （S12-⑤ 之后"winget"这个词会出现在按钮名与说明里，那是要不要代装的**承诺**，不是抄来的指引；
  //   真正只准有一份的是命令原文 `winget install …` 和官网地址，所以这里按那两样收口。）
  const off = PAGE({});
  assert.ok(off.has('如何拿到全盘秒级搜索'), '未就绪仍要出引导卡');
  assert.ok(!off.texts.some((t) => /voidtools|winget install/i.test(t)),
    '载荷缺省时不许渲染任何安装命令或下载地址（不编第二份）：' + off.texts.join('|'));
  assert.ok(!code.includes('voidtools') && !code.includes('winget install'),
    'client.js 里不许出现第二份安装命令 / 下载地址（命令原文只活在 lib/search/installer.js）');
});

check('pg3-3b 引导卡里「怎么打开 HTTP 服务器」只许宿主说一遍（S12-E 截图核对抓到静态行重述）', () => {
  const A = ['装 Nothing：winget install voidtools.Everything', '或从官网下载：https://www.voidtools.com/downloads/',
    '装好后在 Everything 里勾选 工具 → 选项 → HTTP 服务器（默认端口 3417），或把官方的 es.exe 放进 PATH，然后点上方「重新检测」。'];
  globalThis.__SYSOPS__ = clientPayload({ searchAdvice: A });
  try {
    const on = PAGE({});
    const howto = on.texts.filter((t) => t.includes('勾选'));
    assert.equal(howto.length, 1, '「勾选 HTTP 服务器」这句只许出现一次（多了就是界面抄了宿主的指引）：' + on.texts.join('|'));
    assert.equal(howto[0], A[2], '这句必须是宿主注入的那一条，不是 client 自编的');
    const portLine = on.texts.find((t) => t.includes('本页探测用的是设置页里配的端口'));
    assert.ok(portLine, '端口这行动态补齐要留下：' + on.texts.join('|'));
    assert.ok(!/勾选|工具 → 选项/.test(portLine), 'client 这一行只补端口读数，不许重述指引：' + portLine);
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
});

check('pg3-4 装 Everything 谁出力要说清楚（S12-⑤ 换掉旧的「绝不代装」承诺）：按钮三态 + 就地确认行的边界三条', () => {
  // ① 还没问到 readiness：按钮不亮，但话要说成「还没问到」而不是「这台机器没有」
  const asked = PAGE({});
  assert.ok(asked.has('还没问到本机有没有 winget'), asked.texts.join('|'));
  assert.ok(asked.btn('一键安装 Everything').disabled === true, '没问到之前按钮不许亮');
  // ② 探不到 winget：宿主 detail 原文回显，按钮仍不亮（已批口径「探到才亮」的反面）
  const noW = PAGE({ installReady: { can: false, detail: 'PATH 里没有 winget：这台机器没有 App Installer' } });
  assert.ok(noW.has('PATH 里没有 winget'), '为什么不亮要用宿主原话：' + noW.texts.join('|'));
  assert.ok(noW.btn('一键安装 Everything').disabled === true, '探不到 winget 就不许亮按钮');
  // ③ 探到了：按钮亮，title 回显宿主给的命令原文；没点之前不摊进正文
  const okW = PAGE({ installReady: { can: true, command: 'CMD-FIXTURE --id X' } });
  const b = okW.btn('一键安装 Everything（winget）');
  assert.ok(b && b.disabled === false, 'winget 在位时按钮该亮：' + JSON.stringify(okW.buttons));
  assert.ok(b.title.includes('CMD-FIXTURE'), 'title 要回显宿主给的命令原文：' + b.title);
  assert.ok(!okW.has('CMD-FIXTURE'), '没点按钮之前不许把命令摊进正文（确认行只在点过之后长出来）');
  // ④ 就地确认行（不是弹窗）：命令 + 边界三条 + 取消什么都不发生
  const ask = PAGE({ installReady: { can: true, command: 'CMD-FIXTURE --id X' }, installAsk: true });
  assert.ok(ask.has('CMD-FIXTURE --id X'), '确认行要把将执行的命令原样摆出来');
  assert.ok(ask.has('要你自己同意'), 'UAC 由用户自己点同意这句要写：' + ask.texts.join('|'));
  assert.ok(ask.has('不写注册表'), ask.texts.join('|'));
  assert.ok(ask.has('不替你打开 Everything 的 HTTP 服务器'), ask.texts.join('|'));
  assert.ok(ask.has('则什么都没发生'), '取消 = 什么都没发生，这句得说');
  assert.ok(!ask.has('不会替你装程序'), '旧的「绝不代装」承诺已经不作数了，留着就是撒谎');
  assert.ok(ask.btn('确认安装') && ask.btn('取消'), '确认与取消两颗都在：' + JSON.stringify(ask.buttons.map((x) => x.text)));
  // ⑤ 在途：不许再点第二颗
  const run = PAGE({ installReady: { can: true, command: 'CMD' }, installJob: { phase: 'running', startedAt: 1 } });
  assert.ok(run.btn('安装中…') && run.btn('安装中…').disabled === true, '在途期间按钮不许能再点：' + JSON.stringify(run.buttons.map((x) => x.text)));
  // ⑥ ① 档已经绿：安装入口整块收起（装完了还挂一颗安装按钮就是噪声；说明文字里提到按钮名不算），
  //    但**交代行必须留下** —— 「装完了 ≠ 通路通了」那句正是在按钮收起的那一刻才最需要看。
  const ins = PAGE({ probe: PROBE({ installed: true, ready: false }),
    installJob: { phase: 'done', startedAt: 1, exitCode: 0, message: 'winget 正常退出（退出码 0）' },
    installNote: { tone: 'ok', text: 'winget 报告安装完成。已按结果重新检测：① 已安装已翻绿；② 查询通路还要你勾选 HTTP 服务器' } });
  assert.ok(!ins.btn('一键安装'), '已装就不该再亮安装按钮：' + JSON.stringify(ins.buttons.map((x) => x.text)));
  assert.ok(ins.has('② 查询通路还要你勾选 HTTP 服务器'), '按钮收起了，交代行不许跟着一起消失：' + ins.texts.join('|'));
});

check('pg3-4b 安装终态那一句按重检测的脸色写，四个分支各说各的（S12-E 截图核对抓到的「①说两遍」就在这儿钉住）', () => {
  const done = { phase: 'done', exitCode: 0, message: 'winget 正常退出（退出码 0）', outTail: '已找到 Everything\n已成功安装' };
  // 在途不许提前出交代行
  assert.equal(SRCH.installOutcomeText({ phase: 'running', startedAt: 1 }, null), null);
  // 失败：退出码原话 + 输出尾巴折成一行
  const bad = SRCH.installOutcomeText({ phase: 'failed', message: 'winget 以非 0 退出（5）', outTail: '0x80070005 拒绝访问\n第二行' }, null);
  assert.equal(bad.tone, 'bad');
  assert.ok(bad.text.indexOf('安装没有完成：winget 以非 0 退出（5）') === 0, bad.text);
  assert.ok(bad.text.includes('0x80070005 拒绝访问 / 第二行'), '尾巴折行要看得下去：' + bad.text);
  // 装完了但 ① 没翻绿：这句必须承认"没拿到"，不能替 winget 报成功
  const noGreen = SRCH.installOutcomeText(done, PROBE({ installed: false, ready: false }));
  assert.equal(noGreen.tone, 'bad');
  assert.ok(noGreen.text.includes('还没翻绿'), noGreen.text);
  // ①绿、②还没通路：只说这两件事，且**同一个「①」不许说两遍**（预览截图里就是这么露馅的）
  const needHttp = SRCH.installOutcomeText(done, PROBE({ installed: true, http: false, es: false, e2e: false, ready: false }));
  assert.equal(needHttp.tone, 'ok');
  assert.equal((needHttp.text.match(/①/g) || []).length, 1, '① 只许出现一次：' + needHttp.text);
  assert.ok(needHttp.text.includes('② 查询通路还要你在 Everything 里勾选 HTTP 服务器'), needHttp.text);
  // ①②绿、③没过
  const e2e = SRCH.installOutcomeText(done, PROBE({ installed: true, http: true, es: false, e2e: false, ready: false }));
  assert.ok(e2e.text.includes('③ 端到端还没过'), e2e.text);
  // 全绿
  const all = SRCH.installOutcomeText(done, PROBE({ installed: true, http: true, e2e: true, ready: true }));
  assert.ok(all.text.includes('三级自检全绿'), all.text);
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

check('pg3-14 关键字提示的大小写口径跟随实现（不敏感）：原型 index.html:659 写的「敏感」是错的', () => {
  const out = PAGE({});
  assert.ok(out.has('大小写不敏感'), '界面必须说不敏感（lib/search/walk.js:23 的 matchName 转小写比较）：' + out.texts.join('|'));
  // 子串陷阱：'大小写不敏感' 不含 '大小写敏感'（中间隔一个「不」），所以这条能真咬住照抄原型的写法
  assert.ok(!out.has('大小写敏感'), '同时出现「大小写敏感」就是界面在撒谎');
});

check('pg3-15 probeHint 的端口取注入载荷、不写死 3417（评审 M17 的渲染证人；改回硬编即红）', () => {
  // 载荷故意给 4545：与「原型写死的 3417」和 probeCells 的默认值都不同值，写死或读错源都躲不过。
  const dflt = clientPayload().defaults;
  globalThis.__SYSOPS__ = clientPayload({ defaults: { ...dflt, searchPort: 4545 } });
  try {
    const out = PAGE({ probe: PROBE(READY) });
    assert.ok(out.has('当前通路：Everything HTTP :4545 · 全盘索引'),
      '通路提示行必须用载荷的 4545：' + out.texts.join('|'));
    assert.ok(!out.has('Everything HTTP :3417'), '出现 3417 就是把端口写死了（载荷给的是 4545）');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
});

/* S8-③（真机反馈「搜索这个位置放得太下了，看不到，应该放在最上面」）—— 卡序即规格。
   搜索输入区排第一（进页第一眼就能打字），自检与引导是说明区、降到结果之后。
   只断言顺序不断言文案：文案由 pg3-1/pg3-6 各自钉住，这里钉的是「谁在前」。 */
check('pg3-16 搜索卡排最前：输入区 → 结果 → 自检 → 引导（用户反馈的卡序）', () => {
  const out = PAGE({});
  const iSearch = out.texts.indexOf('返回上限');            // 只在搜索卡里出现
  const iEmpty = out.texts.findIndex((t) => t.includes('还没有查询'));
  const iProbe = out.texts.indexOf('Everything 接入自检');
  const iGuide = out.texts.indexOf('如何拿到全盘秒级搜索');
  for (const [name, i] of [['搜索卡（返回上限）', iSearch], ['结果空态', iEmpty], ['自检卡', iProbe], ['引导卡', iGuide]]) {
    assert.ok(i >= 0, `四种标记必须都在场，否则「顺序」比较的是空集：缺 ${name}` + out.texts.join('|'));
  }
  assert.ok(iSearch < iEmpty, '搜索输入区必须排在结果之前：' + out.texts.join('|'));
  assert.ok(iEmpty < iProbe, '结果区必须排在自检之前（进页第一眼是能干活的地方，不是自检报告）');
  assert.ok(iProbe < iGuide, '引导卡跟在自检卡之后');
  // 就绪时引导卡照旧收起（pg3-2 的另一半：顺序调整不许把收起逻辑碰掉）
  const on = PAGE({ probe: PROBE(READY) });
  assert.ok(!on.has('如何拿到全盘秒级搜索') && on.texts.indexOf('返回上限') < on.texts.indexOf('Everything 接入自检'));
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
      // useRef 槽位的值**一定是对象**：拿到非对象说明这个下标上一轮归别的 hook 用
      // —— 桩 React 的槽位是全树共享下标，换页签时前后两页的 hook 数不同就会撞车
      // （S12-④ 现证：搜索页的 dirRef 撞上监控页 useState(null) 留下的旧槽，拿到 null，
      //  submitDir 一读 dirRef.current 就炸）。真 React 按组件存 hook 链，不会串；
      // 这里撞上就按新 hook 重建，别把别人的旧值当状态复用。
      if (!(i in slots) || slots[i] === null || typeof slots[i] !== 'object') slots[i] = { current: v === undefined ? null : v };
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
    __render(Comp) { cursor = 0; R.__root = expand(Comp()); return walk(R.__root); },
    /** 卸载：执行全部未跑的 effect cleanup。 */
    __unmount() { for (const e of effs) { if (e && typeof e.cleanup === 'function') { e.cleanup(); e.cleanup = null; } } },
  };
  /* 在**本次渲染的 hook 上下文里**把函数组件节点就地展开成元素树。
     为什么必须在这里展开：测试要从 __root 里拿真 handler（例如曲线卡的 onMouseMove），
     若靠二次遍历边找边调组件，组件会再跑一遍 useState/useRef —— 槽位从 cursor 当前位置
     往后重新分配，页面局部 state 的 setter 就绑到了没人读的槽位上（真渲染读的是原下标）。
     展开后 __root 里没有函数节点，之后的查找只读不调，闭包与真渲染逐一对齐。 */
  function expand(n) {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(expand);
    if (typeof n.type === 'function') return expand(n.type(n.props || {}));
    const list = Array.isArray(n.children) && n.children.length ? n.children : [];
    if (list.length) n.children = list.map(expand);
    return n;
  }
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

/**
 * SSE 响应体：逐帧吐出后挂住不返回 done —— 模拟真机长连接，直到 abort 或服务端关流。
 * `push(frame)` 是给「服务端后来才推一帧」那一路用的（真机例：写 prefs 之后
 * `syncRuntime` 落开关 → `refreshSources()` 广播 sources 帧）。静态数组的用例不受影响，
 * 但**不许**再靠"重开一条流"来模拟后续推送 —— 那等于把真机的单条长连接拆成两条。
 */
function sseRes(frames) {
  const enc = new TextEncoder();
  let i = 0;
  let wake = null;
  const res = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          for (;;) {
            if (i < frames.length) return { done: false, value: enc.encode(frames[i++]) };
            await new Promise((r) => { wake = r; });
          }
        },
      }),
    },
    push(frame) {
      frames.push(frame);
      const w = wake; wake = null;
      if (w) w();
      return res;
    },
  };
  return res;
}

const jsonRes = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

/**
 * 快照里的三行源（宿主 sourceRows() 的真实形状：只有 l0/l1a/l1b，**没有 l2** —— l2 是非常驻源，
 * 宿主不出那一行）。`enabled` 是开关意图、`state` 是现在在不在跑，设置页的开关读前者（S18-①）。
 * 默认按 CN_FULL() 的库值出，需要跟着写入结果变的用例（cnSettingsWorld）自己再算一份。
 */
const CN_SRC_ROWS = (rec) => [
  { key: 'l0', label: '本机基础指标', state: 'on', enabled: rec.sources.l0 === true, detail: '档位 5s，窗口 30 分钟', restarts: 0, pid: null, stderrTail: '' },
  { key: 'l1a', label: '网络吞吐', state: rec.sources.l1a === true ? 'on' : 'off', enabled: rec.sources.l1a === true, detail: '', restarts: 0, pid: null, stderrTail: '' },
  // l1b 的 state 与 enabled 天生可以不等（开着但页面不可见 ⇒ enabled:true + state:off），
  // 这里固定报 off 是有意的：设置页那颗开关读 enabled，不读这个 state。
  { key: 'l1b', label: '进程榜', state: 'off', enabled: rec.sources.l1b === true, detail: '未开启', restarts: 0, pid: null, stderrTail: '' },
];

/** 真机快照形状的最小足量版（两张页都渲染得动即可，字段不多造）。 */
const CN_SNAP = {
  cadence: '1s', keepMinutes: 30, series: {}, latest: {},
  sources: CN_SRC_ROWS({ sources: { l0: true, l1a: true, l1b: false, l2: true } }),
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
  w.render();
  // S5：阈值告警的新建表单已搬到设置页 —— 先真点「设置」页签并重渲染，再点「保存规则」。
  // 进设置页本身就会现读 prefs（读失败即落可见 notice），随后的写回必须再读一次并被同一失败短路。
  const goSettings = w.click('设置');
  assert.ok(goSettings, '没找到「设置」页签');
  goSettings();
  await cnTick();
  w.render();
  const save = w.click('保存规则');
  assert.ok(save, '没找到「保存规则」按钮');
  save();
  await cnTick();
  assert.ok(w.log.some((e) => e.method === 'GET' && e.url === '/sysops/api/prefs'), '写回前必须先读全量');
  assert.ok(!w.log.some((e) => e.method === 'POST' && e.url === '/sysops/api/prefs'),
    '读失败还整域写回会抹掉同域其它配置（lib/prefs/store.js:191），必须阻断');
  const out = w.render();
  assert.ok(out.has('读偏好失败'), '设置页要把读失败落成可见 notice：' + out.texts.join('|'));
  const goMon = w.click('资源监控');
  assert.ok(goMon, '没找到「资源监控」页签');
  goMon();
  const mon = w.render();
  assert.ok(mon.has('接口异常'), '读失败必须可见（约束 4）：' + mon.texts.join('|'));
});

/* 按 className 精确认领 vnode（不是文案）：S15-① 的读数三件套没有文字入口，只能按类名找。 */
function byClass(root, tag, cn) {
  const acc = [];
  const go = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const k of n) go(k); return; }
    if (n.type === tag && String((n.props || {}).className || '') === cn) acc.push(n);
    for (const k of kids(n)) go(k);
  };
  go(root);
  return acc;
}

await checkAsync('cn-3b S15-① 悬停读数真接线：竖引导线在 svg 内，圆环与气泡在这张卡的 .so-curve 内，移开即收', async () => {
  const snap = { ...CN_SNAP, series: { cpu: [{ t: 1, v: 20 }, { t: 2, v: 42 }, { t: 3, v: 91 }] },
    latest: { cpu: 42, mem: 71, diskFreeGb: 70, diskTotalGb: 214.7, netDown: 0, netUp: 0, t: 3 } };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  await cnTick();
  w.render();
  const sparks = () => collectProps(w.live.__root, 'svg', (p) => String(p.className || '') === 'so-spark');
  const tips = () => collectProps(w.live.__root, 'line', (p) => String(p.className || '') === 'so-tip-line');
  assert.equal(sparks().length, 4, '四张曲线卡应各有一张 svg：' + sparks().length);
  assert.equal(tips().length, 0, '不悬停时不该有读数（页面自身无态时的渲染结果不变）');
  const curves = () => byClass(w.live.__root, 'div', 'so-curve');
  assert.equal(curves().length, 4, '每张曲线卡有一个卡内读数层 .so-curve（圆环与气泡的定位父级）');
  assert.equal(byClass(curves()[0], 'span', 'so-tip-ring').length, 0, '未悬停不画圆环');
  assert.equal(byClass(curves()[0], 'span', 'so-tip-box').length, 0, '未悬停不画气泡');
  assert.equal(typeof sparks()[0].onMouseMove, 'function', 'CPU 卡的 svg 必须挂 onMouseMove');
  assert.equal(typeof sparks()[0].onMouseLeave, 'function', 'CPU 卡的 svg 必须挂 onMouseLeave');
  // 真机语义：clientX=170 + rect{left:0,width:340} ⇒ 第 2 个点（v=42）
  sparks()[0].onMouseMove({ clientX: 170, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 340 }) } });
  const out = w.render();
  assert.equal(tips().length, 1, '悬停后应有且只有一条引导线');
  assert.ok(sparks()[0].children.some((c) => c && c.props && c.props.className === 'so-tip-line'), '引导线留在 svg 里（要跟着曲线走）');
  const c0 = curves()[0];
  const ring = byClass(c0, 'span', 'so-tip-ring');
  const box = byClass(c0, 'span', 'so-tip-box');
  assert.equal(ring.length, 1, '圆环画在这张卡的 .so-curve 内 —— 画到卡外就成了浮层（§4 禁令）');
  assert.equal(box.length, 1, '气泡同上，卡内 HTML，不吃 svg 的横向拉伸');
  assert.equal(ring[0].props.style.left, '50%', 'x=170 / viewBox 340 ⇒ 横贴 50%');
  const top = parseFloat(ring[0].props.style.top);
  assert.ok(top > 0 && top < 92, '圆环纵坐标落在 92 高的画布内：' + ring[0].props.style.top);
  assert.ok(ring[0].props.style.borderColor, '圆环描边吃本卡曲线颜色');
  assert.match(ring[0].props.style.borderColor, /--so|#/);
  assert.equal(box[0].props.style.left, 'calc(50% - 8px)', '中点算右半边：气泡右边贴该点往左长，留 8px 让开引导线');
  assert.equal(box[0].props.style.transform, 'translateX(-100%)', '朝向写在 style 上（类里不写，见 pg1-29）');
  const bText = box[0].children[0].children[0];
  const tText = box[0].children[1].children[0];
  assert.equal(bText, '42.0%', '气泡正文 = 该点数值（一份真相走 tipParts）');
  assert.match(String(tText), /^\d\d:\d\d:\d\d$/, '时刻单列在灰字里：' + tText);
  assert.ok(out.has('42.0%'), '读数文案要真的上屏：' + out.texts.join('|'));
  // 换到最左边那个点：气泡必须改成朝右长，而不是把一半推出卡外（真机批「难看」的那一种越界）
  sparks()[0].onMouseMove({ clientX: 20, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 340 }) } });
  w.render();
  const boxL = byClass(curves()[0], 'span', 'so-tip-box')[0];
  assert.equal(boxL.props.style.transform, 'translateX(0)', '左半边的点：左边贴该点、朝右长');
  assert.match(boxL.props.style.left, /^calc\(\d+(\.\d)?% \+ 8px\)$/, '左边距是「该点 + 8px」：' + boxL.props.style.left);
  sparks()[0].onMouseLeave();
  w.render();
  assert.equal(tips().length, 0, '移开后引导线必须收掉（不许赖在画面上）');
  assert.equal(byClass(curves()[0], 'span', 'so-tip-ring').length, 0, '移开后圆环收掉');
  assert.equal(byClass(curves()[0], 'span', 'so-tip-box').length, 0, '移开后气泡收掉');
  w.live.__unmount();
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
  // 一条长连接：写 prefs 之后由"宿主"（这里是这个桩）推 sources 帧，界面才换开关位。
  const stream = sseRes([`event: snapshot\ndata: ${JSON.stringify({ ...CN_SNAP, sources: CN_SRC_ROWS(server.rec) })}\n\n`]);
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => stream },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: true, data: ruleRows || { items: [], off: [] } }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: server.rec } }) },
    { url: '/sysops/api/prefs', method: 'POST', reply: ({ init }) => {
        server.rec = JSON.parse(String(init.body)).prefs;
        // 真机这一脚是 index.js 的 syncRuntime()：落开关 → service.refreshSources() → hub 广播。
        stream.push(`event: sources\ndata: ${JSON.stringify({ rows: CN_SRC_ROWS(server.rec) })}\n\n`);
        return jsonRes({ ok: true, data: { prefs: JSON.parse(JSON.stringify(server.rec)) } });
      } },
  ]);
  w.server = server;
  w.stream = stream;
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
  // 写成功后界面吃的是宿主推来的 sources 帧（syncRuntime 落开关 → refreshSources 广播），
  // 不是浏览器自己乐观翻的那一颗。
  const flipped = await cnWait(() => {
    w.render();
    const s = findSwitchByTitle(w.live.__root, '切换 进程榜采集');
    return Boolean(s) && s['aria-checked'] === 'true';
  });
  assert.ok(flipped, '写成功后开关没跟着宿主的 sources 帧刷新');
  w.live.__unmount();
});

await checkAsync('cn-9b 设置页写前的现读失败：阻断整行写并把原因可见（C-1 读失败短路）', async () => {
  let gets = 0;
  const w = cnSettingsWorld();
  // 本用例要把 fetch 换成本地版本：必须 try/finally 收回本世界自己的桩，
  // 否则 override 会漏给后面的用例（后建的 cnWorld 会重设，但同一世界内的 direct api() 调用就会读到脏桩）。
  const worldFetch = globalThis.fetch;
  try {
    // 把 prefs 的 GET 应答改写成「首次（进页）成功、第二次（写前现读）500」
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
  } finally {
    globalThis.fetch = worldFetch;
  }
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

/* S8-②：页头扫描入口的真接线（stub 级只证「卡里没有」，这里证「页头那颗真的在、真的发请求」）。
   三个世界各看一态：空态（唯一入口 + 点击 POST /clean/scan）→ 扫描中（禁用 + 「扫描中…」+ 仍唯一）
   → 有清单（标签切「重新扫描」）。 */
/* 清理页的活体世界（cn-14 与 cn-15 共用一份，不留第二份）：
   五路 GET（logs/unfinished/quarantine/rules/prefs）+ SSE 快照里的 clean 状态 + 可追加的 POST 路由。 */
// rules 走真宿主形状（lib/api.js:493-502）：items 是自建、off 是关掉的内置 id、builtin 是宿主给的公开字段行
// —— 少了 builtin 这一键，桩就比宿主少了能力，扫描范围卡会落到「规则读数还没拿到」那条分支上去。
const CLEAN_ROUTES = {
  logs: [], unf: [], quar: {},
  rules: {
    items: [], off: ['packages-cache'], updatedAt: 1,
    builtin: [
      { id: 'temp-user', n: '用户临时目录', kind: '缓存', ageDays: 3, note: '系统与应用共用', rel: 'AppData/Local/Temp', builtin: true, enabled: true },
      { id: 'npm-cache', n: 'npm 下载缓存', kind: '缓存', ageDays: 30, note: '清掉后首个 npm i 需重新下载', rel: 'AppData/Local/npm-cache', builtin: true, enabled: true },
      { id: 'packages-cache', n: 'UWP 包缓存', kind: '缓存', ageDays: 60, note: '范围较大，默认关闭', rel: 'AppData/Local/Packages', builtin: true, enabled: false },
    ],
  },
  prefs: {},
};
function cleanWorld(cleanSnap, extra = [], latest = {}) {
  return cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify({ ...CN_SNAP, latest: { ...CN_SNAP.latest, ...latest }, clean: cleanSnap })}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/clean/logs', reply: () => jsonRes({ ok: true, data: CLEAN_ROUTES.logs }) },
    { url: '/sysops/api/clean/unfinished', reply: () => jsonRes({ ok: true, data: CLEAN_ROUTES.unf }) },
    { url: '/sysops/api/quarantine', reply: () => jsonRes({ ok: true, data: CLEAN_ROUTES.quar }) },
    { url: '/sysops/api/rules', reply: () => jsonRes({ ok: true, data: CLEAN_ROUTES.rules }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: CLEAN_ROUTES.prefs } }) },
    ...extra,
  ]);
}
async function enterClean(w) {
  w.render(); await cnTick();
  const go = w.click('C 盘清理');
  assert.ok(go, '没找到「C 盘清理」页签');
  go(); w.render(); await cnTick();
  return w.render();
}

await checkAsync('cn-14 页头扫描入口真接线：唯一一颗、扫描中禁用、点击 POST /clean/scan', async () => {
  // ① 空态：全页「开始扫描」恰一颗（页头），且不是卡里那颗
  const w1 = cleanWorld({}, [{ url: '/sysops/api/clean/scan', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) }]);
  const out1 = await enterClean(w1);
  const starts1 = out1.buttons.filter((b) => b.text.includes('开始扫描'));
  assert.equal(starts1.length, 1, '扫描入口必须唯一（页头）：' + JSON.stringify(out1.buttons.map((b) => b.text)));
  const click1 = w1.click('开始扫描');
  assert.ok(click1, '页头「开始扫描」没接上 onClick');
  click1();
  assert.ok(await cnWait(() => w1.log.some((e) => e.method === 'POST' && e.url === '/sysops/api/clean/scan')),
    '点页头按钮必须真发 POST /clean/scan：' + JSON.stringify(w1.log.map((e) => e.method + ' ' + e.url)));
  w1.live.__unmount();

  // ② 扫描中：页头那颗禁用并写「扫描中…」，全页仍只有这一颗（停止扫描是另一回事，在卡里）
  const w2 = cleanWorld({ phase: 'scanning', dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp', walked: 100, hit: 2, bytes: 1e6 });
  const out2 = await enterClean(w2);
  const scanBtn = out2.buttons.find((b) => b.text.includes('扫描中'));
  assert.ok(scanBtn, '扫描中页头按钮要写「扫描中…」：' + JSON.stringify(out2.buttons.map((b) => b.text)));
  assert.equal(scanBtn.disabled, true, '扫描中页头按钮必须禁用（防重复发起）');
  assert.equal(out2.buttons.filter((b) => /开始扫描|重新扫描/.test(b.text)).length, 0, '扫描中不许再出现可点的扫描按钮');
  assert.ok(out2.btn('停止扫描'), '停止扫描仍在卡里，入口没搬家');
  w2.live.__unmount();

  // ③ 有清单：标签切「重新扫描」（重扫入口与快照共存，照原型）
  const PLAN_ENTITY = { planId: 'plan-7', at: 1_700_000_000_000, modeDefault: 'delete-file', beforeFree: 7e10, afterFree: null,
    items: [{ id: 'a1', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\a.log', size: 4096, ruleName: '用户临时目录', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' }],
    totals: { n: 1, bytes: 4096 } };
  const w3 = cleanWorld({ phase: 'ready', planId: 'plan-7' }, [{ url: '/sysops/api/clean/plan', reply: () => jsonRes({ ok: true, data: PLAN_ENTITY }) }]);
  const out3 = await enterClean(w3);
  assert.ok(out3.has('待清理清单'), '得先真出清单卡，标签才轮到「重新扫描」：' + out3.texts.join('|'));
  const again = out3.buttons.filter((b) => b.text.includes('重新扫描'));
  assert.equal(again.length, 1, '有清单时页头应写「重新扫描」且唯一：' + JSON.stringify(out3.buttons.map((b) => b.text)));
  w3.live.__unmount();
});

/** 按 title 认领按钮（S12-A 的分类卡那颗：文字长在子元素里，findClick 的"字符串子节点"口径够不着）。 */
function findClickByTitle(root, re) {
  const out = [];
  const go = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(go); return; }
    if (n.type === 'button' && re.test((n.props || {}).title || '') && typeof n.props.onClick === 'function') out.push(n.props.onClick);
    go(kids(n));
  };
  go(root);
  return out.length === 1 ? out[0] : null;
}

/** 取分类下拉那颗 select 的 props（S19-①）：change 处理器不在 walk 的 buttons 里，得从 vnode 树现取。 */
function findSelectProps(root, cls) {
  let hit = null, n = 0;
  const go = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(go); return; }
    if (x.type === 'select' && String((x.props || {}).className || '').includes(cls)) { n += 1; hit = x.props; }
    go(kids(x));
  };
  go(root);
  return n === 1 ? hit : null;
}

/** 按路径认领某一行的行内勾选（S19 电池要它在别的组里先挖一个洞，才看得出「全选本组」没越界）。 */
function findRowCheck(root, pathRe) {
  const txt = (n, acc) => {
    if (typeof n === 'string' || typeof n === 'number') { acc.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach((v) => txt(v, acc)); return; }
    if (n && typeof n === 'object') txt(kids(n), acc);
  };
  const firstBox = (n) => {
    if (!n || typeof n !== 'object') return null;
    if (Array.isArray(n)) { for (const v of n) { const r = firstBox(v); if (r) return r; } return null; }
    if (n.type === 'button' && (n.props || {}).role === 'checkbox') return n.props;
    return firstBox(kids(n));
  };
  let hit = null, n = 0;
  const go = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(go); return; }
    if (v.type === 'tr') {
      const acc = [];
      txt(kids(v), acc);
      if (pathRe.test(acc.join(' '))) {
        const b = firstBox(kids(v));
        if (b && typeof b.onClick === 'function') { n += 1; hit = b; }
      }
    }
    go(kids(v));
  };
  go(root);
  return n === 1 ? hit : null;
}

/* S12-A 的真接线：扫完默认勾上「可清理」、概览条有数、分类筛选只减行不动勾选。
   这四件事 pg2-42~47 只证了纯函数与渲染形状，这里证的是**点下去真的改状态**。 */
await checkAsync('cn-15 扫描后默认勾选 + 概览条 + 分类筛选真接线（S12-A）：筛选不动勾选，「全选本组」是并集', async () => {
  const items = [
    { id: 'a1', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\a.log', size: 4096, ruleName: '系统临时目录', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' },
    { id: 'a2', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\b.log', size: 8192, ruleName: '系统临时目录', kind: '日志', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' },
    { id: 'b1', path: 'C:\\Users\\gongj\\AppData\\Local\\Edge\\Cache\\x', size: 1e7, ruleName: '浏览器缓存', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'mid', riskWhy: '运行中的浏览器会锁住部分文件' },
    { id: 'b2', path: 'C:\\Users\\gongj\\AppData\\Local\\Edge\\Cache\\y', size: 1e6, ruleName: '浏览器缓存', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '', guardDenied: { code: 'GUARD_SYSTEM_DIR', why: '系统目录不参与' } },
    { id: 'c1', path: 'C:\\Users\\gongj\\AppData\\Local\\npm-cache\\z', size: 2e6, ruleName: 'npm 缓存', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' },
  ];
  const plan = { planId: 'plan-s12', at: 1_700_000_000_000, modeDefault: 'delete-file', beforeFree: 70.4e9, afterFree: null, items, totals: { n: items.length, bytes: 1 } };
  const w = cleanWorld({},
    [{ url: '/sysops/api/clean/scan', method: 'POST', reply: () => jsonRes({ ok: true, data: { plan } }) }],
    { diskFreeGb: 71.9, diskTotalGb: 214.7 });
  const out0 = await enterClean(w);
  assert.ok(out0.classHas('so-disk'), '概览条要在场：' + out0.classes.join('|'));
  assert.ok(out0.has('71.9 GB'), '监控快照里的可用容量要出现在清理页：' + out0.texts.join('|'));

  const go = w.click('开始扫描');
  assert.ok(go, '页头「开始扫描」没接上 onClick');
  go();
  assert.ok(await cnWait(() => {
    const o = w.render();
    return o.has('已选 3 项') && o.buttons.filter((b) => b.role === 'checkbox' && b.ariaChecked === 'true').length === 3;
  }), '点扫描拿到清单后要默认勾上可清理那三项（操作条读数 + 画面里勾着的框一起对上；那句「已默认勾上」的复述按 S20 删了，判据只能数真勾选）：' + JSON.stringify(w.render().texts.slice(0, 10)));
  const out1 = w.render();
  const boxes = out1.buttons.filter((b) => b.role === 'checkbox');
  assert.equal(boxes.length, 6, '表头框 + 五行：' + boxes.length);
  assert.equal(boxes.filter((b) => b.ariaChecked === 'true').length, 3, '默认勾的只能是未拒且非 mid 的三项');
  assert.ok(out1.has('已选 3 项'), '底部操作条的读数与默认勾选一致：' + out1.texts.join('|'));
  assert.ok(out1.has('扫描那一刻可用 65.6 GB'), '概览条另一端取快照 beforeFree：' + out1.texts.join('|'));

  // 先在「系统临时目录」那一组里挖一个洞（取消 a2）：后面那颗「全选本组」越没越界就看它
  const a2 = findRowCheck(w.live.__root, /Temp\\b\.log/);
  assert.ok(a2, 'a2 那行的行内勾选没接上 onClick：' + w.render().buttons.map((b) => b.title).join('|'));
  a2.onClick();
  assert.ok(await cnWait(() => w.render().has('已选 2 项')), '取消一行后操作条要跟着减：' + JSON.stringify(w.render().texts.slice(0, 10)));

  // 选「系统临时目录」这一组 → 只剩两行；勾选读数一位不动（筛选不是取消勾选）
  const sel = findSelectProps(w.live.__root, 'so-cat-select');
  assert.ok(sel && typeof sel.onChange === 'function', '分类下拉没接上 onChange');
  assert.equal(sel.value, '', '默认停在「全部分类」：' + sel.value);
  sel.onChange({ target: { value: '系统临时目录' } });
  assert.ok(await cnWait(() => w.render().has('正在只看「系统临时目录」')), '选完分类要立刻筛表：' + JSON.stringify(w.render().texts.slice(0, 10)));
  const out2 = w.render();
  assert.equal(out2.buttons.filter((b) => b.role === 'checkbox').length, 3, '表头框 + 本组两行：' + out2.buttons.filter((b) => b.role === 'checkbox').length);
  assert.ok(out2.has('其余 3 项仍在清单里、勾选状态没变'), '筛选态要如实交代没显示的那些：' + out2.texts.join('|'));
  assert.ok(out2.has('已选 2 项'), '筛选绝不允许把已选数改小：' + out2.texts.join('|'));
  assert.ok(out2.has('系统临时目录 · 2 项 · 12.0 KB · 可清理 2'), '下拉当前那一格就是选中的组：' + out2.texts.join('|'));

  // 换选「浏览器缓存」→「全选本组」吃的是当前那一格：未拒的只有 b1（b2 被 guard 拒了，不进本组可选集合）→ 并集，不是替换。
  sel.onChange({ target: { value: '浏览器缓存' } });
  assert.ok(await cnWait(() => w.render().has('正在只看「浏览器缓存」')), '换组没筛上：' + JSON.stringify(w.render().texts.slice(0, 10)));
  const groupBtn = findClickByTitle(w.live.__root, /把本组未拒的 1 项加进勾选（已勾 0 项）/);
  assert.ok(groupBtn, '「全选本组」没接上 onClick：' + w.render().buttons.map((b) => b.text).join('|'));
  assert.ok(w.render().has('全选本组 1'), '换组后按钮要跟着当前那一格走：' + w.render().buttons.map((b) => b.text).join('|'));
  groupBtn();
  assert.ok(await cnWait(() => w.render().has('已选 3 项')), '并进勾选：2 → 3（只补本组那 1 项，别组挖的洞不许被顺手填回来）：' + JSON.stringify(w.render().texts.slice(0, 10)));
  const out3 = w.render();
  // 此刻表里只画本组两行（b1/b2），表头框是 mixed 不是 true ⇒ 画面里勾着的应该只有刚并进来的那 1 项。
  // 数到 2 就是「全选本组」越界把 guard 拒掉的 b2 也塞回来了（并集吃的必须是 selectable，不是 ids）。
  const visChecked = out3.buttons.filter((b) => b.role === 'checkbox' && b.ariaChecked === 'true');
  assert.equal(visChecked.length, 1, '筛到本组时画面里勾着的一项都不许多：实到 ' + visChecked.length + ' 个');
  assert.ok(out3.has('含 1 项有风险'), '新勾进来的 b1 是风险档，操作条要说出来：' + out3.texts.join('|'));
  assert.ok(out3.has('本组已全选') && !out3.has('全选本组 1'), '已经全选的那一格要改口成「本组已全选」：' + out3.buttons.map((b) => b.text).join('|'));

  // 选回「全部分类」→ 取消筛选，回到全量
  sel.onChange({ target: { value: '' } });
  assert.ok(await cnWait(() => w.render().buttons.filter((b) => b.role === 'checkbox').length === 6), '取消筛选后回到五行');
  assert.equal(w.render().texts.some((t) => /正在只看「/.test(t)), false, '取消筛选后那句交代也要收起');
  w.live.__unmount();
});

await checkAsync('cn-16 扫描范围卡与进度分母真接线（S12-A 问题①）：内置规则来自 GET /api/rules，帧带 ruleIdx 才定量', async () => {
  // ① 数据路径：loadCleanAux 的 GET /api/rules → CleanPage 的 rules → scanScope → 卡面逐条目录。
  //    S13 后明细默认收起，所以这一段先核摘要报的数，再真点「展开明细」看网格。
  const w1 = cleanWorld({});
  const out1 = await enterClean(w1);
  assert.ok(out1.texts.some((t) => t.includes('本次待遍历 2 类目录')), '分母 = 开启的 2 条内置（packages-cache 已停用）：' + out1.texts.join('|'));
  assert.equal(out1.classHas('so-scope'), false, 'S13：默认收起，目录网格不许一进来就摊开');
  assert.equal(out1.has('用户临时目录'), false, '收起态连规则名都不该在 DOM 里');
  const expand = w1.click('展开明细');
  assert.ok(expand, '卡头「展开明细」没接上 onClick');
  expand();
  const out1b = w1.render();
  assert.ok(out1b.has('用户临时目录'), '内置规则名要上屏：' + out1b.texts.join('|'));
  assert.ok(out1b.has('~/AppData/Local/Temp'), 'rel（相对用户目录）上屏，不拼绝对路径：' + out1b.texts.join('|'));
  assert.equal(out1b.texts.some((t) => /C:\\Users/i.test(t)), false, '范围卡不许出现本机绝对路径');
  assert.equal(out1b.texts.filter((t) => /待遍历 2 类目录/.test(t)).length, 1, '展开后摘要那行不许多出一份：' + out1b.texts.join('|'));
  w1.live.__unmount();

  // ② 帧带 ruleIdx/rulesLen ⇒ 定量条；没带 ⇒ 不定量 + 已用时（旧宿主不凑假百分比）
  const w2 = cleanWorld({ phase: 'scanning', dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp', walked: 100, hit: 2, bytes: 1e6, ruleIdx: 3, rulesLen: 10 });
  const out2 = await enterClean(w2);
  assert.ok(out2.has('第 3 / 共 10 类目录'), out2.texts.join('|'));
  assert.equal(out2.classes.some((c) => c.includes('is-indeterminate')), false, '有分母时进度条走定量样式');
  assert.ok(!out2.has('进度未知'), out2.texts.join('|'));
  w2.live.__unmount();

  const w3 = cleanWorld({ phase: 'scanning', dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp', walked: 100, hit: 2, bytes: 1e6 });
  const out3 = await enterClean(w3);
  assert.ok(out3.classes.some((c) => c.includes('is-indeterminate')), '旧宿主帧 ⇒ 不定量样式，不画实心 0%');
  assert.equal(out3.texts.some((t) => /共 \d+ 类目录/.test(t)), false, '读不到分母就不报「第几类」');
  w3.live.__unmount();
});

/* S12-①：留痕入口长在页头。pg2-51 只证了纯渲染形状，这里证的是**真点下去会开合**，
   并顺带钉住 S12-② 那条页头降噪（健康态的「推送通道 SSE」在活体页面里也不许出现）。 */
await checkAsync('cn-17 页头「清理留痕 1」真接线（S12-①）：点开设、面板里点收起，收起态 DOM 里没有滚动框', async () => {
  const prevLogs = CLEAN_ROUTES.logs;
  CLEAN_ROUTES.logs = [{ logId: 'CLN-2609-0009', planId: 'plan-1', startedAt: 1, finishedAt: 2, mode: 'move-to-quarantine',
    itemIds: ['a'], ok: 1, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.2e9, beforeFree: 70.4e9, afterFree: 71.6e9, error: '' }];
  try {
    const w = cleanWorld({});
    const out0 = await enterClean(w);
    const entry = out0.buttons.find((b) => /清理留痕/.test(b.text));
    assert.ok(entry, '页头必须有留痕入口：' + JSON.stringify(out0.buttons.map((b) => b.text)));
    assert.equal(entry.text, '清理留痕 1', '入口要带上段数，不用点开才知道有没有记录：' + entry.text);
    assert.equal(out0.classHas('so-logpanel'), false, '默认收起：不许一进清理页就压一整屏历史');
    assert.equal(out0.classHas('is-open'), false, '收起态入口不该是按下样式');
    assert.equal(out0.has('推送通道 SSE'), false, 'S12-②：活体页面（link=sse）也不许自报健康通道');
    const open = w.click('清理留痕 1');
    assert.ok(open, '页头入口没接上 onClick');
    open();
    const out1 = w.render();
    assert.ok(out1.classHas('so-logpanel'), '点开设的是页面里的限高滚动面板（就地展开，不是浮层）');
    assert.ok(out1.has('CLN-2609-0009'), '面板要真吃到 GET /clean/logs 的那条记录：' + out1.texts.slice(0, 8).join('|'));
    assert.ok(out1.classHas('is-open'), '展开态入口要给出按下样式，否则看不出刚点了什么');
    assert.equal(out1.texts.filter((t) => t === '清理留痕').length, 1, '整页只许有一张「清理留痕」卡（页头那颗是入口按钮，标题文案是「清理留痕 1」）');
    const close = findClickExact(w.live.__root, '收起');
    assert.ok(close, '面板里的「收起」没接上 onClick');
    close();
    const out2 = w.render();
    assert.equal(out2.classHas('so-logpanel'), false, '收起 = 从渲染树里拿掉，不是留着占位');
    assert.equal(out2.classHas('is-open'), false);
    w.live.__unmount();
  } finally { CLEAN_ROUTES.logs = prevLogs; }
});

/* S12-③：AI 智能清理的真接线（审批口径「只推荐 + 就地确认，不自动执行」）。
   三件事必须钉死：① 征求建议的请求体在结构上只有 planId（前端连 itemIds 都不发，更不发路径）；
   ② 采纳只把 ids 并进勾选集合，全程零 POST /clean/apply；③ 就绪度读不到 / 征求失败都就地可见。
   纯函数形状（三档 pill、越界行丢弃、stale planId）见 pg2-48~51。 */
const AI_ITEMS = [
  { id: 'a1', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\a.log', size: 4096, ruleName: '用户临时目录', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' },
  { id: 'b1', path: 'C:\\Users\\gongj\\AppData\\Local\\Edge\\Cache\\x', size: 1e7, ruleName: '浏览器缓存', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'mid', riskWhy: '运行中的浏览器会锁住部分文件' },
  { id: 'b2', path: 'C:\\Users\\gongj\\AppData\\Local\\Edge\\Cache\\y', size: 2e6, ruleName: '浏览器缓存', kind: '缓存', atime: 1, mtime: 1, riskLevel: 'low', riskWhy: '' },
];
const AI_PLAN = { planId: 'plan-ai', at: 1_700_000_000_000, modeDefault: 'delete-file', beforeFree: 70.4e9, afterFree: null, items: AI_ITEMS, totals: { n: 3, bytes: 1.2e7 } };
const AI_RESULT = {
  planId: 'plan-ai', at: 1_700_000_000_500, provider: 'fake-official', model: 'fake-model',
  params: { provider: 'fake-official', model: 'fake-model', temperature: 0.2 },
  promptHash: 'fnv1a-1234abcd', promptChars: 1234, reasoningChars: 0, finishKind: 'stop',
  groupsSent: 2, groupsTotal: 3, dropped: { count: 1 }, missing: 1,
  note: '按可释放空间只送出 2/3 类；模型漏判 1 类；1 行对不上清单已丢弃。',
  recommendations: [
    { group: 0, ruleId: 'browser-cache', ruleName: '浏览器缓存', kind: '缓存', count: 2, bytes: 1.2e7, cleanable: 1, risky: 1, action: 'clean', reason: '缓存可自动重建，占用最大', ids: ['b1', 'b2'] },
    { group: 1, ruleId: 'temp-user', ruleName: '用户临时目录', kind: '缓存', count: 1, bytes: 4096, cleanable: 1, risky: 0, action: 'review', reason: '可能有进程正持有这些文件', ids: ['a1'] },
  ],
};
/** 一份 AI 就绪的清理页世界：清单走 GET /clean/plan 补拉，就绪度与建议各一路，POST 可覆盖。
 *  快照的 clean 键与宿主同形（lib/api.js 的 `clean: {...state, plan: state.planId}`）：
 *  补拉那条 effect 认的是 `plan` 键，只给 planId 会让世界停在空态。 */
function aiWorld(over = {}) {
  return cleanWorld({ phase: 'ready', planId: 'plan-ai', plan: 'plan-ai' }, [
    { url: '/sysops/api/clean/plan', reply: () => jsonRes({ ok: true, data: over.plan ?? AI_PLAN }) },
    { url: '/sysops/api/clean/ai', reply: () => (over.aiDescribe ? over.aiDescribe() : jsonRes({ ok: true, data: { available: true, provider: 'fake-official', model: 'fake-model', modelName: 'fake-model', source: 'discovered', reason: '' } })) },
    { url: '/sysops/api/clean/ai-suggest', method: 'POST', reply: () => (over.aiSuggest ? over.aiSuggest() : jsonRes({ ok: true, data: over.aiResult ?? AI_RESULT })) },
    ...(over.extra ?? []),
  ]);
}
const aiAskCalls = (w) => w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/clean/ai-suggest');

await checkAsync('cn-18 AI 智能清理真接线（S12-③）：只发 planId、采纳只并进勾选、全程零 clean/apply', async () => {
  const w = aiWorld({ extra: [{ url: '/sysops/api/clean/apply', method: 'POST', reply: () => jsonRes({ ok: true, data: { ok: 0, skipped: 0, failed: 0, rejected: 0 } }) }] });
  const out0 = await enterClean(w);
  assert.ok(w.log.some((e) => e.method === 'GET' && e.url === '/sysops/api/clean/ai'),
    '进清理页必须现读一次宿主模型就绪度（能力快照会在注入回调前构建，不能只信载荷）：' + JSON.stringify(w.log.map((e) => e.method + ' ' + e.url)));
  const ask = out0.btn('AI 智能清理');
  assert.ok(ask, 'DBG TEXTS=' + out0.texts.slice(0, 16).join('|') + ' BTN=' + JSON.stringify(out0.buttons.map((b) => b.text)));
  assert.equal(ask.disabled, false, '就绪度给了 available:true 才许亮：' + ask.title);
  assert.equal(out0.classHas('so-ai'), false, '没征求之前不许压一块空面板');

  const go = w.click('AI 智能清理');
  assert.ok(go, '按钮没接上 onClick');
  go();
  assert.ok(await cnWait(() => aiAskCalls(w).length === 1), '点下去必须真发 POST /clean/ai-suggest');
  assert.deepEqual(Object.keys(JSON.parse(aiAskCalls(w)[0].body)), ['planId'],
    '征求建议的请求体结构上只能有 planId（路径与勾选都不出口）：' + aiAskCalls(w)[0].body);
  assert.ok(await cnWait(() => w.render().classHas('so-ai is-done')), '回话后面板要就地展开成建议态：' + JSON.stringify(w.render().texts.slice(0, 8)));

  const out1 = w.render();
  assert.ok(out1.has('建议清理') && out1.has('建议先看一眼'), '三档动作要各画各的 pill：' + out1.texts.join('|'));
  assert.ok(out1.has('缓存可自动重建，占用最大'), '模型给的理由必须逐字上屏，不许只留个结论：' + out1.texts.join('|'));
  assert.ok(out1.has('本次判定如实交代：' + AI_RESULT.note), '截断/漏判/丢弃要在面板里说出来：' + out1.texts.join('|'));
  assert.ok(out1.has('fnv1a-1234abcd') && out1.has('送出 2/3 类'), '留痕指纹与送出比例要可见');
  assert.ok(out1.has('fake-official / fake-model'), '用的是哪个模型要写清楚（不写死在界面上）：' + out1.texts.join('|'));
  assert.equal(out1.texts.filter((t) => /建议清理|建议先看一眼|建议保留/.test(t)).length, 2, '两行建议两张 pill，不许多出第三份');

  // 采纳：勾上「浏览器缓存」那一类 → 并进阶梯数 → 点「采纳 N 项到勾选」→ 只改勾选集合
  const box = findClickByTitle(w.live.__root, /把这一类的 2 项并进勾选（只是勾选，不是删除）/);
  assert.ok(box, '建议行没有采纳勾选框：' + JSON.stringify(out1.buttons.map((b) => b.title)));
  assert.equal(out1.has('已把 2 项并入勾选'), false, '没点采纳之前不许写成「已并入」');
  box();
  const out2 = w.render();
  const adopt = out2.btn('采纳 2 项到勾选');
  assert.ok(adopt, '勾上建议类之后要有「采纳 2 项到勾选」：' + JSON.stringify(out2.buttons.map((b) => b.text)));
  assert.equal(adopt.disabled, false, adopt.title);
  // walk 的 buttons 只带"有没有 onClick"，真函数要从 vnode 树里取（同 cn-15 的口径）
  const adoptGo = w.click('采纳 2 项到勾选');
  assert.ok(adoptGo, '「采纳 2 项到勾选」没接上 onClick');
  adoptGo();
  const out3 = w.render();
  assert.ok(out3.has('已选 3 项'), '默认勾的 2 项 + 采纳进来的 b1 = 3 项（并集，不是替换）：' + out3.texts.join('|'));
  assert.ok(out3.has('已把 2 项并入勾选'), '采纳之后要当场交代并进多少项：' + out3.texts.join('|'));
  assert.equal(w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/clean/apply').length, 0,
    'AI 这条路上一个删除都不许发生：' + JSON.stringify(w.log.map((e) => e.method + ' ' + e.url)));

  // 收起：面板从渲染树里拿掉（不是留着占位），按钮回到可再问一次
  const dismiss = findClickExact(w.live.__root, '收起建议');
  assert.ok(dismiss, '面板里的「收起建议」没接上 onClick');
  dismiss();
  const out4 = w.render();
  assert.equal(out4.classHas('so-ai'), false, '收起 = 不渲染');
  assert.ok(out4.btn('AI 智能清理'), '收起后按钮仍是那颗');
  w.live.__unmount();
});

await checkAsync('cn-19 AI 就绪度与征求失败的降级读数（S12-③）：三种「问不出结果」分开说，且都不发 apply', async () => {
  // ① 就绪度读不到（桩里回 500）⇒ 按钮禁用 + 原因就地写，不许伪装成「宿主没有模型」
  const w1 = aiWorld({ aiDescribe: () => jsonRes({ ok: false, error: { code: 'PREFS_UNAVAILABLE', message: '存储域没起来' } }, 501) });
  const o1 = await enterClean(w1);
  const b1 = o1.btn('AI 智能清理');
  assert.ok(b1, '缺就绪度时按钮仍要在场（禁用而不是消失）：' + JSON.stringify(o1.buttons.map((x) => x.text)));
  assert.equal(b1.disabled, true, '读不到就绪度不许亮按钮');
  assert.ok(o1.has('读取宿主模型就绪度失败（PREFS_UNAVAILABLE）：存储域没起来'), '原因要就地可见：' + o1.texts.join('|'));
  assert.equal(o1.texts.some((t) => /宿主没有模型/.test(t)), false, '读失败 ≠ 宿主没模型，两者文案必须分开');
  w1.live.__unmount();

  // ② 宿主确实没模型：available:false + reason 逐字上屏
  const w2 = aiWorld({ aiDescribe: () => jsonRes({ ok: true, data: { available: false, provider: null, model: null, reason: '宿主没配模型：AI 清理建议不可用，人工勾选照旧' } }) });
  const o2 = await enterClean(w2);
  assert.equal(o2.btn('AI 智能清理').disabled, true, 'available:false 必须禁用');
  assert.ok(o2.has('宿主没配模型：AI 清理建议不可用，人工勾选照旧'), 'reason 要逐字落屏：' + o2.texts.join('|'));
  assert.equal(o2.classHas('so-capgaps'), false, 'AI 不可用是能力事实，不该刷页头缺口横幅');
  w2.live.__unmount();

  // ③ 征求失败：面板落红色原因 + 「再问一次」，点了真的重发一次；全程零 apply
  let tries = 0;
  const w3 = aiWorld({ aiSuggest: () => { tries += 1; return tries === 1 ? jsonRes({ ok: false, status: 501, error: { code: 'AI_UNAVAILABLE', message: '宿主模型不可用' } }, 501) : jsonRes({ ok: true, data: AI_RESULT }); } });
  await enterClean(w3);
  w3.click('AI 智能清理')();
  assert.ok(await cnWait(() => w3.render().has('征求 AI 建议失败')), '失败要就地落面板：' + JSON.stringify(w3.render().texts.slice(0, 8)));
  const o3 = w3.render();
  assert.ok(o3.has('AI_UNAVAILABLE'), '错误 code 要原样可见（可分支，不翻译掉）：' + o3.texts.join('|'));
  const retry = findClickExact(w3.live.__root, '再问一次');
  assert.ok(retry, '失败态要有「再问一次」');
  retry();
  assert.ok(await cnWait(() => aiAskCalls(w3).length === 2), '「再问一次」必须真重发：' + JSON.stringify(w3.log.map((e) => e.method + ' ' + e.url)));
  assert.ok(await cnWait(() => w3.render().classHas('is-done')), '第二次成功后面板要切回建议态');
  assert.equal(w3.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/clean/apply').length, 0, '失败重试这条路上不许有删除');
  w3.live.__unmount();

  // ④ 建议贴错清单：planId 与在场快照不一致 ⇒ 整块不渲染（旧建议不配贴在新清单上）
  const w4 = aiWorld({ extra: [{ url: '/sysops/api/clean/scan', method: 'POST', reply: () => jsonRes({ ok: true, data: { plan: { ...AI_PLAN, planId: 'plan-new', items: AI_ITEMS } } }) }] });
  await enterClean(w4);
  w4.click('AI 智能清理')();
  assert.ok(await cnWait(() => w4.render().classHas('is-done')), '先拿到一份 plan-ai 的建议');
  w4.click('重新扫描')();
  assert.ok(await cnWait(() => !w4.render().classHas('is-done')), '重扫换了清单 ⇒ 那份旧建议的面板必须同时作废（不许贴在新清单上）');
  const o4 = w4.render();
  assert.equal(aiAskCalls(w4).length, 1, '重扫不许自动再问一次模型（那是花钱的动作）');
  const b4 = o4.btn('AI 智能清理');
  assert.ok(b4, '换清单后按钮仍在：' + JSON.stringify(o4.buttons.map((x) => x.text)));
  assert.equal(b4.text.includes('AI 智能清理'), true, '清单换了 ⇒ 标签回到「AI 智能清理」而不是「重新征求」：' + b4.text);
  w4.live.__unmount();
});

/**
 * S12-④ 搜索页写偏好的活体世界：prefs 走**可变服务端记录**（POST 的整行真的落到服务端），
 * 这样"点一下有没有进库"是看服务端现值，不是看界面自己说了一句什么。
 * 探针固定为就绪 + 库里 mode=walk ⇒ 覆盖范围 chips 一定在场，两条通路都点得动。
 */
const CN_SEARCH_SEED = () => ({
  collect: { cadence: '1s', keepMinutes: 30 },
  sources: { l0: true, l1a: true, l1b: false, l2: true },
  clean: { quarantineDir: 'F:\\sysops-quarantine', keepDays: 7, after: 'log' },
  search: { mode: 'walk', limit: 50, walkDirs: ['F:\\dsh-plugins'] },
  alerts: {},
  updatedAt: 1700000000000,
});
const CN_PROBE_READY = { at: 1, installed: true, http: true, es: false, e2e: true, ready: true, via: 'http', degraded: false, level: 'e2e', checks: [] };
function cnSearchWorld(opts = {}) {
  const o = opts || {};
  const server = { rec: CN_SEARCH_SEED() };
  let hold = null;
  const echo = () => jsonRes({ ok: true, data: { prefs: JSON.parse(JSON.stringify(server.rec)) } });
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
    { url: '/sysops/api/search/probe', reply: () => jsonRes({ ok: true, data: CN_PROBE_READY }) },
    { url: '/sysops/api/prefs', reply: () => jsonRes({ ok: true, data: { prefs: JSON.parse(JSON.stringify(server.rec)) } }) },
    { url: '/sysops/api/prefs', method: 'POST', reply: ({ init }) => {
        const sent = JSON.parse(String(init.body)).prefs;
        // failPost：宿主拒了（schema/存储故障）。用例断言的是"界面不改口"，所以服务端记录一律不动。
        if (o.failPost) return jsonRes({ ok: false, status: 500, error: { code: 'SCHEMA', message: 'search 组没通过 schema' } }, 500);
        if (o.slowPost) return new Promise((resolve) => { hold = () => { server.rec = sent; resolve(echo()); }; });
        server.rec = sent;
        return echo();
      } },
  ]);
  w.server = server;
  w.releasePost = () => { if (hold) { const f = hold; hold = null; f(); } };
  w.entries = () => w.log.map((e) => e.method + ' ' + e.url.split('?')[0]);
  w.posts = () => w.entries().filter((s) => s === 'POST /sysops/api/prefs').length;
  w.postBodies = () => w.log.filter((e) => e.method === 'POST' && e.url === '/sysops/api/prefs').map((e) => JSON.parse(String(e.body)));
  w.enterSearch = async () => {
    w.render(); await cnTick(); w.render();
    const tab = w.click('文件搜索');
    assert.ok(tab, '没找到「文件搜索」页签');
    tab(); w.render(); await cnTick(); w.render();
  };
  /** 点「＋ 添加目录」（挂值与取 onClick 同一次遍历，同 cn-8 的口径）。 */
  w.addDir = (value) => {
    const f = fillAndClick(w.live.__root, '粘贴绝对路径', value, '＋ 添加目录');
    assert.ok(f.click, '没找到「＋ 添加目录」按钮（或在途没解锁）');
    f.click();
  };
  return w;
}

await checkAsync('cn-20 搜索页「＋ 添加目录」真接线（S12-④）：一次点击一次写、chip 立刻长、空输入与重复目录都有话说、回车同规', async () => {
  const w = cnSearchWorld();
  await w.enterSearch();
  let out = w.render();
  assert.ok(out.has('F:\\dsh-plugins'), '进页要把 prefs.search.walkDirs 画成覆盖范围 chips：' + out.texts.join('|'));

  // ① 空（纯空格）输入点按钮：零写入 + 就地原因 —— 点了没反应就是这条的真机形态
  w.addDir('   ');
  await cnTick();
  out = w.render();
  assert.equal(w.posts(), 0, '空输入不许发整行覆盖写：' + JSON.stringify(w.entries()));
  assert.ok(out.has('目录输入是空的'), '空输入要有就地原因：' + out.texts.join('|'));

  // ② 真加一条：一次 POST、服务端 walkDirs 真的长出、chip 跟上、输入框清空
  const NEW = 'D:\\work\\out';
  w.addDir('  ' + NEW + '  ');
  assert.ok(await cnWait(() => w.posts() === 1), '点「＋ 添加目录」必须写 prefs：' + JSON.stringify(w.entries()));
  await cnTick();
  out = w.render();
  const sent = w.postBodies()[0].prefs;
  assert.deepEqual(sent.search.walkDirs, ['F:\\dsh-plugins', NEW], '写的是「现有 + 新增」整份（前后空格已去掉）：' + JSON.stringify(sent.search));
  assert.deepEqual(sent.collect, CN_SEARCH_SEED().collect, '整行覆盖写不许抹掉 collect');
  assert.deepEqual(sent.clean, CN_SEARCH_SEED().clean, '整行覆盖写不许抹掉 clean');
  assert.deepEqual(sent.alerts, CN_SEARCH_SEED().alerts, '整行覆盖写不许抹掉 alerts');
  assert.ok(out.has(NEW), '新目录要立刻画成 chip：' + out.texts.join('|'));
  assert.ok(out.has('已写入覆盖范围'), '写入成功要有就地交代（spec §4：落字，不是浮层）：' + out.texts.join('|'));
  assert.equal(findInputByPlaceholder(w.live.__root, '粘贴绝对路径').ref.current.value, '',
    '写入成功后输入框该清空 —— 字还留在框里就是「以为没提交」的另一半');

  // ③ 再点同一条：不写第二遍，但必须说清为什么没动静
  w.addDir(NEW);
  await cnTick();
  out = w.render();
  assert.equal(w.posts(), 1, '重复目录不许再写一遍整行');
  assert.ok(out.has('第 2 条已经是它了'), '重复要有可见说明：' + out.texts.join('|'));
  assert.equal(w.server.rec.search.walkDirs.length, 2, '服务端记录也不许多出一条');

  // ④ 回车与点按钮同规（两条路都得能提交，且都只在宿主确认后才清空）
  const inp = findInputByPlaceholder(w.live.__root, '粘贴绝对路径');
  inp.ref.current = { value: 'E:\\logs' };
  inp.onKeyDown({ key: 'Enter', preventDefault() {} });
  assert.ok(await cnWait(() => w.posts() === 2), '回车必须与点按钮同规：' + JSON.stringify(w.entries()));
  out = w.render();
  assert.ok(out.has('E:\\logs'), '回车添加的也要立刻成 chip：' + out.texts.join('|'));
  assert.deepEqual(w.server.rec.search.walkDirs, ['F:\\dsh-plugins', NEW, 'E:\\logs']);
  w.live.__unmount();
});

await checkAsync('cn-21 搜索页通路与返回上限真持久化（S12-④）：点一下 = 一次 prefs 写；宿主拒了界面不改口', async () => {
  // 成功路：mode 与 limit 都进库（不持久化就是下次进页弹回默认档）
  const w = cnSearchWorld();
  await w.enterSearch();
  const segAll = findClickExact(w.live.__root, '全盘索引');
  assert.ok(segAll, '探针就绪时「全盘索引」按钮该在场且可点');
  segAll();
  assert.ok(await cnWait(() => w.posts() === 1), '点通路必须写 prefs.search.mode：' + JSON.stringify(w.entries()));
  await cnTick();
  assert.equal(w.server.rec.search.mode, 'everything', '通路没落库：' + JSON.stringify(w.server.rec.search));
  assert.deepEqual(w.server.rec.collect, CN_SEARCH_SEED().collect, '写 mode 不许抹掉别的组');
  let out = w.render();
  assert.ok(out.has('通路已存进偏好'), '通路写入要就地交代：' + out.texts.join('|'));
  const seg200 = findClickExact(w.live.__root, '200');
  assert.ok(seg200, '没找到返回上限的 200 档');
  seg200();
  assert.ok(await cnWait(() => w.posts() === 2), '改上限也要写 prefs.search.limit：' + JSON.stringify(w.entries()));
  await cnTick();
  assert.equal(w.server.rec.search.limit, 200, '上限没落库：' + JSON.stringify(w.server.rec.search));
  assert.ok(w.render().has('返回上限已存进偏好'), '上限写入要就地交代：' + w.render().texts.join('|'));
  w.live.__unmount();

  // 失败路：宿主拒了 ⇒ 界面一格都不改口，且「没写进库」与接口异常都看得见
  const bad = cnSearchWorld({ failPost: true });
  await bad.enterSearch();
  findClickExact(bad.live.__root, '全盘索引')();
  assert.ok(await cnWait(() => bad.posts() === 1), '写失败前请求照样发出去：' + JSON.stringify(bad.entries()));
  await cnTick();
  out = bad.render();
  assert.deepEqual(bad.server.rec, CN_SEARCH_SEED(), '宿主回 500 时服务端记录不该被改动');
  assert.ok(out.has('没写进库'), '失败必须就地承认：' + out.texts.join('|'));
  assert.ok(out.has('接口异常'), '失败同时落接口异常行（带 code 可分支）：' + out.texts.join('|'));
  assert.equal(out.has('通路已存进偏好'), false, '写失败不许把成功那句话说出口：' + out.texts.join('|'));
  const segActive = out.buttons.filter((b) => b.className.includes('is-active')).map((b) => b.text);
  assert.ok(segActive.includes('限定目录'), '写失败后通路段仍该亮在不变的那一档：' + JSON.stringify(segActive));
  assert.equal(segActive.includes('全盘索引'), false, '写失败后「全盘索引」不许变亮（不乐观翻转）：' + JSON.stringify(segActive));
  assert.equal(out.btn('全盘索引').disabled, false, '写失败后按钮要能再点一次（不是永久禁用）');
  assert.equal(bad.server.rec.search.mode, 'walk', '库里仍是 walk');
  bad.live.__unmount();
});

await checkAsync('cn-22 写偏好还在途时第二次提交：零叠写 + 按钮就地标「保存中…」（S12-④ 双击不叠整行覆盖写）', async () => {
  // ① 同一拍连点两下（真机双击的形状）：setSrchSaving 要等下一次重渲染才落到 props，
  //    这道闸只能由 ref 同步锁来扛 —— 撤掉它，两笔整行覆盖写都会发出去（变异电池 s12d-m2 就是冲这条来的）。
  const w0 = cnSearchWorld({ slowPost: true });
  await w0.enterSearch();
  w0.addDir('F:\\a');
  w0.addDir('F:\\b');
  await cnTick();
  assert.equal(w0.posts(), 1, '同一拍的第二次提交必须被同步锁挡下：' + JSON.stringify(w0.entries()));
  w0.releasePost();
  assert.ok(await cnWait(() => w0.render().has('已写入覆盖范围')), '放行后第一笔该落库');
  assert.deepEqual(w0.server.rec.search.walkDirs, ['F:\\dsh-plugins', 'F:\\a'], '库里只该有第一笔那条：' + JSON.stringify(w0.server.rec.search.walkDirs));
  assert.equal(w0.render().has('F:\\b'), false, '被锁掉的那次不许出现在覆盖范围里');
  w0.live.__unmount();

  // ② 跨渲染的第二次提交：按钮与输入框已禁用，且就地改口「保存中…」
  const w = cnSearchWorld({ slowPost: true });
  await w.enterSearch();
  w.addDir('F:\\new');
  await cnTick();
  let out = w.render();
  assert.ok(out.has('保存中…'), '在途期间按钮要改口成保存中：' + out.texts.join('|'));
  assert.equal(w.posts(), 1, '第一次点击只发一次写');
  const inp = findInputByPlaceholder(w.live.__root, '粘贴绝对路径');
  assert.equal(inp.disabled, true, '在途期间输入框该禁用（第二次点击无处可发）');
  inp.ref.current = { value: 'F:\\other' };
  inp.onKeyDown({ key: 'Enter', preventDefault() {} });
  await cnTick();
  assert.equal(w.posts(), 1, '在途期间第二次提交不许叠一次整行覆盖写：' + JSON.stringify(w.entries()));
  w.releasePost();
  assert.ok(await cnWait(() => w.render().has('已写入覆盖范围')), '放行后界面该按宿主回显改口');
  out = w.render();
  assert.deepEqual(w.server.rec.search.walkDirs, ['F:\\dsh-plugins', 'F:\\new'], '库里只该有第一次那一条：' + JSON.stringify(w.server.rec.search.walkDirs));
  assert.equal(out.has('F:\\other'), false, '被锁掉的那次提交不许假装成功：' + out.texts.join('|'));
  w.live.__unmount();
});

/* S13：扫描范围那一颗「展开明细」的真开合（pg2-58 只证了两种渲染形状，这里证点下去会换）。
   收起必须是整块从渲染树里拿掉 —— 留一个 hidden 的网格等于画面没变，用户批注的还是那句「占地方」。 */
await checkAsync('cn-23 扫描范围就地展开真接线（S13）：点开设、点收起，收起后网格不在 DOM 里也不在画面里', async () => {
  const w = cleanWorld({});
  const out0 = await enterClean(w);
  assert.equal(out0.classHas('so-scope'), false, '起点是收起态');
  w.click('展开明细')();
  const out1 = w.render();
  assert.ok(out1.classHas('so-scope'), '点开设的是卡内那块目录网格（就地展开，不是浮层）：' + out1.texts.join('|'));
  assert.ok(out1.has('用户临时目录'), out1.texts.join('|'));
  // 状态挂在容器上（页面本体零 useState）：切走再回来还是展开的，不该每次挂载都重置
  w.click('资源监控')();
  w.click('C 盘清理')();
  assert.ok(w.render().classHas('so-scope'), '跨标签回来保持展开：状态在容器，不在页面');
  const close = findClickExact(w.live.__root, '收起明细');
  assert.ok(close, '卡头那颗没在展开后换成「收起明细」');
  close();
  const out2 = w.render();
  assert.equal(out2.classHas('so-scope'), false, '收起 = 从渲染树里拿掉，不是留着占位');
  assert.equal(out2.has('用户临时目录'), false, out2.texts.join('|'));
  assert.ok(out2.texts.some((t) => t.includes('待遍历 2 类目录')), '收起后摘要那行还在，数不能跟着一起消失');
  w.live.__unmount();
});

/* cn-24（S15-②）：页签级接线。时间线整块从监控页底部搬进第 2 个页签，验收要覆盖三件事：
   ① 监控页只剩标签那一次「监控记录」字样（卡片本体不许留在原地），
   ② 点页签切得过去、时间线本体在新页上，
   ③ 就地筛选的档位是容器态 —— 切走再回来还停在原档位，且筛选不改数据只改显示。 */
await checkAsync('cn-24 监控记录页签真接线（S15-②）：时间线在新页、监控页不留本体，筛选档位是容器态', async () => {
  const dn = Date.now();
  const snap = { ...CN_SNAP, alerts: { unread: 0, rules: [], hits: [
    { hitId: 'h-1', t: dn - 60_000, kind: 'hit', ruleName: 'CPU ≥ 85% 连续 3 次', metric: 'cpu', value: 92.4, note: '连续 3 次' },
    { hitId: 'h-2', t: dn - 3 * 86_400_000, kind: 'op', text: '你开启了网速采集' },
  ] } };
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  await cnTick();
  const mon = w.render();
  assert.equal(mon.texts.filter((t) => t === '监控记录').length, 1, '监控页上「监控记录」只该出现一次 = 页签本身：' + mon.texts.join('|'));
  assert.equal(mon.has('本机保留最近 200 条'), false, '时间线卡片本体不许留在监控页底部');
  const openAlerts = () => { const f = findClickExact(w.live.__root, '监控记录'); assert.ok(f, '没找到「监控记录」页签'); f(); };
  openAlerts();
  const al = w.render();
  assert.ok(al.has('规则在设置页配置 · 本机保留最近 200 条'), '新页接住原话并指路设置页：' + al.texts.join('|'));
  assert.ok(al.has('92.4') && al.has('你开启了网速采集'), '两类行都在新页上');
  assert.equal(al.texts.filter((t) => t === '监控记录').length, 2, '页签 + 卡头，一处不多一处不少（不许搬成两份）');
  const d24 = findClickExact(w.live.__root, '最近 24 小时');
  assert.ok(d24, '没有「最近 24 小时」那档按钮');
  d24();
  const day = w.render();
  assert.ok(day.has('1 / 2 条'), '窗口态页头报「筛后 / 全部」：' + day.texts.join('|'));
  assert.ok(day.has('92.4') && !day.has('你开启了网速采集'), '窗口只筛显示：三天前那条不画');
  w.click('资源监控')();
  assert.equal(w.render().has('本机保留最近 200 条'), false, '切回监控页也不该把时间线带回来');
  openAlerts();
  const back = w.render();
  assert.ok(back.has('1 / 2 条'), '档位停在 24 小时：筛选态在容器，不在页面（与 cleanScopeOpen 同规）');
  assert.ok(back.classHas('so-tl-ago'), '每行右侧的相对时间列在位');
  w.live.__unmount();
});

/* cn-25（S15-⑦）：蓝点的清未读要跟着时间线走。时间线搬进第 2 个页签后，POST alerts/read 若还
   挂在监控页，用户感受是「读完记录蓝点不灭，翻到根本没有记录的监控页反倒灭了」—— 蓝点说谎。
   这条钉的是行为（发不发这个请求），不是注释。 */
await checkAsync('cn-25 清未读跟着时间线走（S15-⑦）：只有进监控记录页才 POST alerts/read', async () => {
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => sseRes([`event: snapshot\ndata: ${JSON.stringify(CN_SNAP)}\n\n`]) },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  await cnTick();
  const reads = () => w.log.filter((e) => e.url === '/sysops/api/alerts/read').map((e) => e.method);
  assert.deepEqual(reads(), [], '停在资源监控不该清未读：那一页已经没有时间线了');
  const openAlerts = findClickExact(w.live.__root, '监控记录');
  assert.ok(openAlerts, '没找到「监控记录」页签');
  openAlerts();
  /* 桩 React 的 setter 不自动重渲染，effect 只在渲染时跑（与 cn-3b 同一个坑）：
     点了页签不 render() 一次，dep 变了也不会执行，读到的就是假的「没发请求」。 */
  w.render();
  await cnTick();
  assert.deepEqual(reads(), ['POST'], '进监控记录页清一次未读（spec §3.5）');
  w.click('资源监控')();
  w.render();
  await cnTick();
  assert.deepEqual(reads(), ['POST'], '切回监控页不许再清第二次');
  w.live.__unmount();
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
// 一份真相：能力表的行数与 label 逐字吃 lib/caps.js（宿主加一行，这里跟着长一行，不再手抄一份旧文案）。
const HOST_CAPS = await import('../lib/caps.js');
const CAP_ROWS = HOST_CAPS.CAP_ROWS.map((r) => (HOST_CAPS.NEVER_PROVIDED.includes(r.key)
  ? { ...r, ok: false, detail: '' }
  : { ...r, ok: true, detail: '' }));
const CAPS_OK = Object.fromEntries(HOST_CAPS.CAP_KEYS.map((k) => [k, !HOST_CAPS.NEVER_PROVIDED.includes(k)]));
const SPAGE = (over = {}) => walk(SET.SettingsPage({ prefs: PREFS(), rules: [], caps: CAPS_OK, capRows: CAP_ROWS, snap: SNAP(), err: null, saving: false,
  onPatch() {}, onRuleAdd() {}, onRuleToggle() {}, onRuleRemove() {}, onSave() {}, ...over }));

check('pg4-1 四源行齐（L0/L1a/L1b/L2），每行带层级 pill 与代价说明', () => {
  const rows = SET.SOURCE_ROWS(PREFS(), null);
  assert.deepEqual(rows.map((r) => r.key), ['l0', 'l1a', 'l1b', 'l2']);
  assert.ok(rows[0].tier.includes('L0') && rows[1].tier.includes('L1a') && rows[2].tier.includes('L1b') && rows[3].tier.includes('L2'));
  assert.ok(rows[0].desc.includes('不起任何子进程'));
  assert.ok(rows[1].desc.includes('暖身') && rows[1].desc.includes('219ms'));
  assert.ok(rows[2].desc.includes('640ms'));
});

check('pg4-2 L0 没有开关（档位由监控页控），其余开关位吃宿主源行的 enabled（S18-①）', () => {
  // sources 只留 l2 ⇒ 模拟「库里从没写过 l1a」。真机症状正是这一格：宿主默认在采 L1a
  //（index.js DEFAULT_CONFIG + service 的 switches），而浏览器拿 `undefined` 猜成「关」。
  const rows = SET.SOURCE_ROWS(PREFS({ sources: { l2: true } }), SNAP());
  assert.equal(rows[0].switch, null, 'L0 的开关是档位 seg，不在这里重复一个入口');
  assert.equal(rows[1].switch.on, true, '库里没写、宿主在采 ⇒ 开关说「开」，默认值只在宿主侧裁一次');
  assert.equal(rows[2].switch.on, false, '实测代价决定默认关（spec §1.1 决策 7），这一位同样来自宿主');
  assert.equal(rows[3].switch.on, true, 'l2 是非常驻源、宿主不出那一行 ⇒ 这一格仍读库（口径见 SOURCE_ROWS 注释）');
  // 反向也得成立：宿主说关就是关，浏览器存的旧值不许把它点亮
  const offSnap = { ...SNAP(), sources: SNAP().sources.map((r) => (r.key === 'l1a' ? { ...r, enabled: false } : r)) };
  assert.equal(SET.SOURCE_ROWS(PREFS(), offSnap)[1].switch.on, false, '宿主的开关位是那一颗的唯一真相');
});

check('pg4-2b 宿主没给源行（首帧未到）：就地一句「未确认」，不画能点却没人认领的开关', () => {
  const out = SPAGE({ snap: null });
  assert.ok(out.has('开关状态未确认：宿主没给这一源的开关行。'), '缺行要说缺行，不许冒充 off：' + out.texts.join('|'));
  assert.equal(out.texts.filter((t) => t === '开关状态未确认：宿主没给这一源的开关行。').length, 2,
    'l1a / l1b 两行各说一次（缺一个源行就少一颗开关，必须数得出来）');
  assert.equal(out.buttons.filter((b) => String(b.className).includes('so-switch')).length, 1,
    '未确认的两行都不画开关，只剩 l2 那一颗');
});

check('pg4-3 关掉某一源 → 依赖它的规则在设置页也标不可用（与监控页同一个 st）', () => {
  const snap = { alerts: { rules: [{ rule: { id: 'r4', n: '下行持续 > 20 MB/s 满 1 分钟', dep: 'l1a' }, st: { dim: true, on: false, st: '依赖的采集已关闭' } }] } };
  const out = SPAGE({ snap });
  assert.ok(out.has('依赖的采集已关闭'));
  assert.ok(out.has('关掉某一源，依赖它的告警规则会就地标为不可用'));
});

check('pg4-3b S5 搬迁后的接线：告警开关走 onAlertToggle（不串清理规则），新建表单三框喂给 onAlertAdd', () => {
  const snap = { alerts: { rules: [{ rule: { id: 'r1', n: 'CPU ≥ 85% 连续 3 次', metric: 'cpu', dep: 'l0' }, st: { dim: false, on: true, st: '监控中' } }] } };
  const alertToggles = [], cleanToggles = [], adds = [];
  const root = SET.SettingsPage({ prefs: PREFS(), rules: [], caps: CAPS_OK, capRows: CAP_ROWS, snap, err: null, saving: false,
    onPatch() {}, onRuleAdd() {}, onRuleRemove() {}, onSave() {},
    onRuleToggle: (id, on) => cleanToggles.push([id, on]),
    onAlertToggle: (id, on) => alertToggles.push([id, on]),
    onAlertAdd: (x) => adds.push(x) });
  const sw = collectProps(root, 'button', (p) => String(p.className || '').includes('so-switch') && p.title === '停用规则')[0];
  assert.ok(sw, '找不到告警规则行的开关（title=停用规则）');
  sw.onClick();
  assert.deepEqual(alertToggles, [['r1', false]], '拨开关必须把 (规则 id, 下一态) 交给 onAlertToggle');
  assert.deepEqual(cleanToggles, [], '告警开关不许串到清理规则的 onRuleToggle（两套规则语义不同）');
  // 三框用 style.width 定位（清理规则的输入框没有内联宽度）：阈值 64 / 连续 48 / 冷却 64
  const sized = collectProps(root, 'input', (p) => p.style && p.style.width);
  assert.deepEqual(sized.map((p) => p.style.width), [64, 48, 64], '阈值告警表单的三框缺失或错位');
  sized[0].ref.current = { value: '90' };
  sized[1].ref.current = { value: '5' };
  sized[2].ref.current = { value: '10' };
  const save = collectProps(root, 'button', (p) => p.children === '保存规则')[0];
  assert.ok(save, '找不到「保存规则」按钮');
  save.onClick();
  assert.deepEqual(adds, [{ metric: 'cpu', value: 90, consecutive: 5, cooldownSec: 600 }],
    '冷却输入的是分钟，提交必须换算成秒（10 分钟 → 600s）');
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

check('pg4-5 黑名单 notice 逐字吃注入载荷的 redlines（宿主的 {id,text} 形状也得渲染成文本，不是 [object Object]）', () => {
  const lines = [
    { id: 'b-recycle-bin', text: '不碰回收站（2026-09-13 曾因按普通目录处理导致属主与 ACL 被改坏）' },
    { id: 'b-system-dir', text: '不碰 C:\\Windows\\*' },
    { id: 'b-program-files', text: '不碰 Program Files' },
    { id: 'b-registry', text: '不动注册表' },
  ];
  globalThis.__SYSOPS__ = clientPayload({ redlines: lines });
  try {
    const out = SPAGE();
    for (const line of lines) assert.ok(out.has(line.text.slice(0, 8)), `缺红线 ${line.text}`);
    assert.ok(out.has('不可移除的黑名单'));
    assert.ok(!out.has('[object Object]'), '对象形状不得渲染成 [object Object]：' + out.texts.join('|'));
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

check('pg4-9 能力表与 lib/caps.js 同行数（含 S12-C 的 ai 行），「宿主不提供」的行没有开关', () => {
  const cells = SET.capCells(CAP_ROWS);
  assert.equal(cells.length, HOST_CAPS.CAP_ROWS.length);
  assert.equal(cells.length >= 6, true, '六项能力（storageDomain/timer/webServer/ai/notifications/autostart）都该在表里');
  assert.deepEqual(cells.map((c) => c.hasSwitch), cells.map(() => false), '能力表只报事实，给开关就是假开关');
  const byKey = Object.fromEntries(cells.map((c, i) => [CAP_ROWS[i].key, c]));
  for (const k of HOST_CAPS.NEVER_PROVIDED) assert.equal(byKey[k].value, '宿主不提供', k + ' 该画「宿主不提供」');
  assert.equal(byKey.storageDomain.value, '提供');
  // ai 行（S12-C）：宿主没给模型时它只是一行事实，不该被画成开关，也不该有「打折」说法之外的第二种口径
  assert.match(CAP_ROWS.find((r) => r.key === 'ai').fallback, /两段式/);
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

check('pg4-14 能力表渲染证人：六行逐行消费 capRows，「宿主不提供」与「已降级」都得上屏，缺载荷走空态（N1）', () => {
  const out = SPAGE({});
  for (const row of CAP_ROWS) assert.ok(out.has(row.label), '能力行 label 没上屏：' + row.label + '；实际：' + out.texts.join('|'));
  assert.equal(out.texts.filter((t) => t === '提供').length, CAP_ROWS.filter((r) => r.ok === true).length, 'ok:true 的行该画「提供」pill');
  assert.equal(out.texts.filter((t) => t === '宿主不提供').length, HOST_CAPS.NEVER_PROVIDED.length, 'NEVER_PROVIDED 各行该画「宿主不提供」灰 pill');
  // 非 never-provided 的 ok:false ⇒ 琥珀 pill 显示 fallback 原文，detail 逐字上屏
  const deg = SPAGE({ capRows: [{ key: 'timer', label: 'timer（ctx.interval）', ok: false, detail: '宿主无 ctx.interval，已退到 setInterval', fallback: '已降级' }] });
  assert.ok(deg.has('已降级'), '降级态必须可见：' + deg.texts.join('|'));
  assert.ok(deg.has('宿主无 ctx.interval，已退到 setInterval'), 'detail 必须逐字渲染');
  // 载荷没给 ⇒ 诚实空态，不许自编六行
  const none = SPAGE({ capRows: [] });
  assert.ok(none.has('宿主未下发能力表。'), 'capRows 缺省该落空态而不是假数据');
  assert.ok(!none.has(CAP_ROWS[0].label), '空载荷不许残留默认行');
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

check('pg4-17 能力缺口横幅只吃「ok:false 且带 detail」的真实降级行；结构性不提供只在设置页能力表', () => {
  // 横幅长在根组件（client.js 的 capGaps），不在任何单页里 —— 必须渲染 SysopsPage 才够得上。
  // 判定规则：ok===false **且** detail 非空 = 真降级（该行必须挂）；detail 空 = 结构性「宿主不提供」，
  // 归设置页能力表（spec §4.6 指派的位置），不刷面板顶部（真机症状：五行噪声常驻）。
  const rows0 = clientPayload().capabilityRows;
  const allOk = rows0.map((r) => ({ ...r, ok: true, detail: '', fallback: '' }));
  globalThis.__SYSOPS__ = clientPayload({ capabilityRows: allOk });
  try {
    assert.ok(!walk(CLIENT.SysopsPage()).classHas('so-capgaps'), '五行全 ok 时不许挂缺口横幅');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
  // 默认载荷里 notifications / autostart 两行 ok:false 但 detail 为空 ⇒ 结构性不提供，横幅不挂
  const structural = walk(CLIENT.SysopsPage());
  assert.ok(!structural.classHas('so-capgaps'), 'detail 为空的「宿主不提供」不该刷横幅：' + structural.texts.join('|'));
  // 真降级行（ok:false + detail）⇒ 必须挂，且一条一行、文案取 detail 而不是 fallback。
  // label 从载荷里现取：lib/caps.js 改文案时这条用例跟着换，不许在测试里焊第二份 label。
  const timerLabel = rows0.find((r) => r.key === 'timer').label;
  const notifLabel = rows0.find((r) => r.key === 'notifications').label;
  globalThis.__SYSOPS__ = clientPayload({
    capabilityRows: rows0.map((r) => (r.key === 'timer'
      ? { ...r, ok: false, detail: '宿主未提供 ctx.timer.interval，已退到 setInterval' }
      : r)),
  });
  try {
    const out = walk(CLIENT.SysopsPage());
    assert.ok(out.classHas('so-capgaps'), '带 detail 的降级行必须挂横幅：' + out.classes.join('|'));
    assert.ok(out.has(`${timerLabel}：宿主未提供 ctx.timer.interval，已退到 setInterval`), '横幅按 label：detail 渲染：' + out.texts.join('|'));
    assert.ok(!out.has(`${notifLabel}：宿主不提供`), 'detail 为空的未提供行不得混进横幅');
  } finally {
    globalThis.__SYSOPS__ = clientPayload();
  }
});

/**
 * pg4-18（S15-③）：落点那句话是一份真相的四张副本。
 * 时间线从监控页底部搬进第 2 个页签后，「哪里能看到告警」同时写在宿主规则表、设置页两处文案、
 * 原型三处 —— 漏改任何一处，用户按旧话去找就扑空。这里逐字钉住，改文案必须四处同改。
 */
check('pg4-18 S15-③ 落点口径四处联动：宿主规则 note + 设置页两处 + 原型，旧落点清零', () => {
  const rulesSrc = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'alerts', 'rules.js'), 'utf8'));
  assert.match(rulesSrc, /冷却 10 分钟 · 落点：监控记录页/, '内置 r1 的 note 要说刷新页签');
  assert.ok(!/监控页时间线/.test(rulesSrc), '宿主规则不许再指旧落点');
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /命中只落在「监控记录」页时间线，不弹系统浮层/, '设置页阈值告警卡的副标题');
  assert.match(code, /defaultValue: '监控记录页 \+ 侧边栏蓝点'/, '新建规则的「提示落点」只读框');
  assert.match(code, /新建规则会插入列表首位，命中后记在「监控记录」页/, '新建表单的就地提示');
  assert.ok(!/监控页时间线|在监控页落时间线/.test(code), '浏览器半边不许留旧落点');
  const proto = fs.readFileSync(path.join(ROOT, 'prototype', 'index.html'), 'utf8');
  for (const s of ['落点：监控记录页', '监控记录页 + 侧边栏蓝点', '命中后记在「监控记录」页']) {
    assert.ok(proto.includes(s), '原型同处一字不差：' + s);
  }
  assert.ok(!/监控页时间线|在监控页落时间线/.test(proto), '原型也不许留旧落点');
});

/* S18-③：表头排序是纯 UI 态 —— 点一下只换画面，一次网络都不碰；新帧来了也不许把用户选的排序顶掉。 */
await checkAsync('cn-26 监控页表头排序真接线（S18-③）：点一下换列、再点换向、全程零请求，proc 新帧不顶掉排序态', async () => {
  const ROWS = [
    { pid: 7412, name: 'idea64.exe', ws: 4.1e9, cpuPct: 11.2 },
    { pid: 11384, name: 'Chrome.exe', ws: 2.4e9, cpuPct: 92.4 },
    { pid: 9184, name: 'MsMpEng.exe', ws: 3.6e8, cpuPct: null },
  ];
  const snap = {
    ...CN_SNAP,
    sources: CN_SRC_ROWS({ sources: { l0: true, l1a: true, l1b: true } })
      .map((r) => (r.key === 'l1b' ? { ...r, state: 'on', detail: '每 3s 一轮 · 运行中' } : r)),
    proc: { rows: ROWS, note: '' },
  };
  const stream = sseRes([`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`]);
  const w = cnWorld([
    { url: '/sysops/api/stream', reply: () => stream },
    { url: '/sysops/api/alerts/read', method: 'POST', reply: () => jsonRes({ ok: true, data: {} }) },
  ]);
  w.render();
  await cnTick();
  const order = () => {
    const t = w.render().texts;
    return [t.indexOf('idea64.exe'), t.indexOf('Chrome.exe'), t.indexOf('MsMpEng.exe')];
  };
  const calls = () => JSON.stringify(w.log.map((e) => e.method + ' ' + e.url));
  const o0 = order();
  assert.ok(o0[1] > -1 && o0[1] < o0[0] && o0[0] < o0[2], '默认 CPU 降序：Chrome 92.4 → idea 11.2 → 读不到的一行沉底：' + calls());
  const reqsBefore = w.log.length;
  const clickMem = findClick(w.live.__root, '内存');
  assert.ok(clickMem, '表头「内存」没接线');
  clickMem();
  const o1 = order();
  assert.ok(o1[0] < o1[1] && o1[1] < o1[2], '点内存 = 换列并回降序：idea 4.1G → Chrome 2.4G → MsMpEng 0.36G');
  const ths = byClass(w.live.__root, 'th', 'so-r so-th-sort');
  assert.equal(ths.length, 2, '可点的还是那两列');
  assert.equal(ths[1].props['aria-sort'], 'descending', '读屏要能报出当前列与方向');
  findClick(w.live.__root, '内存')();
  const o2 = order();
  assert.ok(o2[2] < o2[1] && o2[1] < o2[0], '再点同一列只翻方向：MsMpEng → Chrome → idea');
  assert.equal(w.log.length, reqsBefore, '排序是界面态，一次请求都不该发（数据在宿主那边没变）：' + calls());
  // 新帧按相反顺序推进来：榜必须按用户选的排序重排，而不是按帧里的顺序画，也不许把排序态打回默认
  stream.push(`event: proc\ndata: ${JSON.stringify({ rows: ROWS.slice().reverse(), note: '上限 400 行 · 已截断', t: 2 })}\n\n`);
  const kept = await cnWait(() => {
    const t = w.render().texts;
    return t.includes('上限 400 行 · 已截断')
      && t.indexOf('MsMpEng.exe') < t.indexOf('Chrome.exe') && t.indexOf('Chrome.exe') < t.indexOf('idea64.exe');
  });
  assert.ok(kept, 'proc 新帧到了但排序态被顶掉（或 note 没刷新）：' + calls());
  w.live.__unmount();
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
