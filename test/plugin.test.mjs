import assert from 'node:assert/strict';

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

/* ①段：路由级（假 req/res，四个 service 全打桩） */
const API = await import('../lib/api.js');

// makeRes：除 on/once/emit 外逐字照简报。简报的桩把 on/once/emit 写成空实现，
// 于是 rt-2 / rt-3 里 `res.emit('close')` 打在没有监听表上、handler 注册的断开清理永不触发 ——
// rt-3「末个连接断开 → setVisible(false)」这条承重用例就永远测不到机制（真实 Node res 是 EventEmitter）。
// 这里把 on/once/emit 补成最小事件表，正是参照实现 dsh-plugin-stock-analysis/test/route-api.test.mjs 的 makeReq/makeRes 做法；
// 其余字段与 write 行为保持简报原样。断开清理是 hub 的核心职责，值得让桩如实驱动它。
function makeRes() {
  const listeners = {};
  return {
    statusCode: 0, headers: null, body: '', chunks: [], finished: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    setHeader(k, v) { this.headers = { ...(this.headers ?? {}), [k]: v }; },
    end(b) { this.body = b ?? ''; this.finished = true; },
    write(c) { this.chunks.push(c); return true; },
    on(ev, fn) { (listeners[ev] ??= []).push(fn); return this; },
    once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; w.fn = fn; return this.on(ev, w); },
    off(ev, fn) { const l = listeners[ev] ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); return this; },
    removeAllListeners(ev) { if (ev) listeners[ev] = []; else for (const k of Object.keys(listeners)) listeners[k] = []; },
    emit(ev, ...a) { for (const fn of (listeners[ev] ?? []).slice()) fn(...a); return true; },
  };
}

// ②段夹具：伪造一份**已过 clean_plan schema** 的冻结快照行（键集与 lib/records/spec.js 声明逐一对应），
// GET /api/clean/plan 的用例（rt-27 起）钉「路由透出的键集 = spec 声明的键集」。
const PLAN_ITEM_KEYS = ['id', 'ruleId', 'ruleName', 'kind', 'path', 'size', 'count', 'atime', 'mtime', 'riskLevel', 'riskWhy'];
const PLAN_FIXTURE = {
  planId: 'p-1000-1234',
  at: 1000,
  beforeFree: 111,
  afterFree: null,
  modeDefault: 'delete-file',
  rulesUsed: [{ id: 'r1', n: '系统临时文件', kind: '缓存' }],
  items: [{
    id: 'i-1', ruleId: 'r1', ruleName: '系统临时文件', kind: '缓存',
    path: 'C:\\Users\\me\\AppData\\Local\\Temp\\a.log', size: 10, count: 1,
    atime: 1, mtime: 2, riskLevel: 'low', riskWhy: '',
  }],
  totals: { n: 1, bytes: 10 },
};

// 假时钟：只记录回调与节拍，绝不让真 timer 挂进事件循环（收尾必须 cleared，否则留悬挂心跳）。
function fakeTimers() {
  const timers = [];
  let seq = 0;
  return {
    timers,
    setIntervalMod: (fn, ms) => { timers.push({ fn, ms, cleared: false }); seq += 1; return seq; },
    clearIntervalMod: (h) => { const t = timers[h - 1]; if (t) t.cleared = true; },
    fire: (i = 0) => { timers[i].fn(); },
  };
}

function apiWorld(over = {}) {
  const events = [];
  const calls = [];
  const collect = {
    snapshot: () => ({ cadence: '1s', keepMinutes: 30, timerBackend: 'setInterval', series: { cpu: [{ t: 1, v: 2 }] }, latest: { cpu: 2, mem: 50, diskFreeGb: 70, diskTotalGb: 200, netDown: 0, netUp: 0, t: 1 }, sources: [{ key: 'l0', label: '实时曲线', state: 'on', detail: '', restarts: 0, pid: null, stderrTail: '' }], proc: { rows: [], state: 'off', note: '' }, dropped: { stale: 0, bad: 0 } }),
    sourceRows: () => [], procRows: () => [], setCadence: async (v) => { calls.push(['setCadence', v]); }, setSource: async (k, o) => { calls.push(['setSource', k, o]); }, setVisible: async (v) => { calls.push(['setVisible', v]); }, restartSource: async (k) => { calls.push(['restart', k]); },
    onEvent: (cb) => { collect._cb = cb; return () => { collect._cb = null; }; }, dispose: () => {},
  };
  const alerts = { ruleRows: () => [{ rule: { id: 'r1' }, st: { dim: false, on: true, st: '监控中' } }], hits: async ({ limit } = {}) => over.hitsResult ?? ({ rows: [{ hitId: 'h-1' }], error: null }), unread: () => 3, markRead: () => { calls.push(['markRead']); }, onEvent: () => () => {}, dispose: () => {} };
  const clean = { startScan: async () => { calls.push(['scan']); return { busy: false }; }, stopScan: () => { calls.push(['scanStop']); }, state: () => ({ phase: 'idle', dir: '', walked: 0, hit: 0, bytes: 0, stopped: false, truncated: false, skipped: [], planId: null, error: '' }), apply: async (a) => { calls.push(['apply', a]); return over.applySummary ?? { ok: 1, skipped: 0, failed: 0, rejected: 0 }; }, plans: async () => [], plan: async (id) => { calls.push(['plan', id]); if (over.planThrows) throw over.planThrows; return over.plan === undefined ? PLAN_FIXTURE : over.plan; }, logs: async () => [], unfinished: async () => [], quarantineStats: async () => ({ dirs: 0, files: 0, bytes: 0, oldest: null }), onEvent: () => () => {}, dispose: () => {} };
  const search = { search: async (a) => { calls.push(['search', a]); return { rows: [], source: 'walk', sourceLabel: '本地遍历', note: '', error: null, took: 5, truncated: false, stale: false, limit: 200 }; } };
  const probe = { probe: async () => ({ ready: false, via: null, degraded: true, level: null, checks: [], advice: ['x'] }), invalidate: () => { calls.push(['invalidate']); } };
  const prefsMod = {
    readAll: async () => ({ prefs: { collect: { cadence: '1s' } }, clean_rules: null }),
    writeMany: async (p) => { calls.push(['writeMany', p]); if (over.prefsFails) throw Object.assign(new Error('没有 storageDomain'), { code: 'PREFS_UNAVAILABLE' }); return { written: p, skipped: [] }; },
    available: over.noStorage === true ? false : true,
  };
  const ruleStore = { add: async (r) => { calls.push(['ruleAdd', r]); throw Object.assign(new Error('回收站不碰'), { code: 'SYSOPS_RULE_GUARD_DENY', why: '回收站不碰' }); }, remove: async () => ({}), toggle: async () => ({}), list: async () => over.ruleRows ?? ({ items: [], off: [] }), error: null };
  // probe 作为独立 dep（属搜索域，不混进 clean 的桩里）
  const handler = API.createApiHandler({ collect, alerts, clean, probe, search, prefStore: prefsMod, ruleStore, caps: over.caps ?? { read: () => ({ storageDomain: prefsMod.available, timer: false, webServer: true, notifications: false, autostart: false }) }, logger: { warn: (m) => events.push(m) }, now: () => 1000, sseTimers: over.sseTimers });
  const remote = over.remoteAddress ?? '127.0.0.1';
  const run = async (method, path, { body, query } = {}) => {
    const res = makeRes();
    const url = new URL(`http://127.0.0.1${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    await handler({ method, url, headers: { host: '127.0.0.1:4321', 'x-forwarded-for': over.xff }, socket: { remoteAddress: remote } }, res, body === undefined ? {} : body);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, res };
  };
  // SSE 走长连接：run() 会拿 res.body（SSE 不 end），建流用例直接驱动 handler 并自持 res
  const stream = async (res, path = '/api/stream') => {
    await handler({ method: 'GET', url: new URL(`http://127.0.0.1${path}`), headers: {}, socket: { remoteAddress: remote } }, res);
    return res;
  };
  return { run, stream, calls, events, collect, alerts, clean, search, handler };
}

await checkAsync('rt-1 GET /api/snapshot 返回采集快照全字段', async () => {
  const w = apiWorld();
  const r = await w.run('GET', '/api/snapshot');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(Object.keys(r.json.data).sort(), ['alerts', 'cadence', 'clean', 'dropped', 'keepMinutes', 'latest', 'proc', 'series', 'sources', 'timerBackend']);
});

await checkAsync('rt-2 GET /api/stream 走 SSE：先一帧 snapshot，再广播 service 事件', async () => {
  const w = apiWorld();
  const res = makeRes();
  await w.handler({ method: 'GET', url: new URL('http://127.0.0.1/api/stream'), headers: { host: '127.0.0.1:4321' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.chunks.join(''), /^event: snapshot\ndata: /m);
  w.collect._cb({ type: 'metrics', key: 'cpu', point: { t: 2, v: 3 } });
  assert.match(res.chunks.join(''), /event: metrics/);
  res.emit('close');
  assert.equal(res.chunks.at(-1).includes('event:'), true, '关闭前不留半帧');
});

await checkAsync('rt-3 首个 SSE 连接起来 → collect.setVisible(true)；最后一个断开 → false', async () => {
  const w = apiWorld();
  const a = makeRes(); const b = makeRes();
  await w.handler({ method: 'GET', url: new URL('http://127.0.0.1/api/stream'), headers: {}, socket: { remoteAddress: '127.0.0.1' } }, a);
  assert.deepEqual(w.calls.at(-1), ['setVisible', true]);
  await w.handler({ method: 'GET', url: new URL('http://127.0.0.1/api/stream'), headers: {}, socket: { remoteAddress: '127.0.0.1' } }, b);
  assert.equal(w.calls.filter((c) => c[0] === 'setVisible' && c[1] === true).length, 1, '第二个连接不该重复触发');
  a.emit('close'); b.emit('close');
  assert.deepEqual(w.calls.at(-1), ['setVisible', false]);
});

await checkAsync('rt-4 POST /api/prefs 落 writeMany 并返回归一化全量（不回显输入）', async () => {
  const w = apiWorld();
  const r = await w.run('POST', '/api/prefs', { body: { prefs: { collect: { cadence: '5s' } } } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(w.calls.find((c) => c[0] === 'writeMany')[1], { prefs: { collect: { cadence: '5s' } } });
  assert.ok(r.json.data.prefs, '响应必须是库里的样子');
});

await checkAsync('rt-5 写接口只认 POST：GET /api/prefs 只读，PATCH/PUT /api/prefs 一律 405', async () => {
  const w = apiWorld();
  assert.equal((await w.run('GET', '/api/prefs')).status, 200);
  for (const m of ['PATCH', 'PUT']) {
    const r = await w.run(m, '/api/prefs', { body: {} });
    assert.equal(r.status, 405, `${m} 应 405`);
    assert.match(r.json.error.message, /POST/);
  }
});

await checkAsync('rt-6 POST /api/clean/apply 只把三个键交给 clean.apply，多余字段丢掉', async () => {
  const w = apiWorld();
  await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file', path: 'C:\\Windows\\x' } });
  assert.deepEqual(w.calls.find((c) => c[0] === 'apply')[1], { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file' });
});

await checkAsync('rt-7 apply 缺 planId 或 itemIds 空数组 → 400，且不落到执行器', async () => {
  const w = apiWorld();
  const r1 = await w.run('POST', '/api/clean/apply', { body: { itemIds: ['i'], mode: 'delete-file' } });
  assert.equal(r1.status, 400);
  const r2 = await w.run('POST', '/api/clean/apply', { body: { planId: 'p', itemIds: [], mode: 'delete-file' } });
  assert.equal(r2.status, 400);
  assert.equal(w.calls.filter((c) => c[0] === 'apply').length, 0);
});

await checkAsync('rt-8 mode 不在三个操作白名单里 → 400 并点名允许值', async () => {
  const w = apiWorld();
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p', itemIds: ['i'], mode: 'takeown' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /delete-file.*delete-dir.*move-to-quarantine|允许/);
});

await checkAsync('rt-9 无 storageDomain：读仍 200，写返回 501 且 code 稳定（界面按它置灰保存按钮）', async () => {
  const w = apiWorld({ noStorage: true, prefsFails: true });
  assert.equal((await w.run('GET', '/api/prefs')).status, 200);
  const r = await w.run('POST', '/api/prefs', { body: { prefs: {} } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'PREFS_UNAVAILABLE');
});

await checkAsync('rt-10 guard 拒绝写规则 → 403 + 原文案（不是 500，用户要看得懂为什么）', async () => {
  const w = apiWorld();
  const r = await w.run('POST', '/api/rules/add', { body: { id: 'u-9', n: '回收站', glob: 'C:\\$Recycle.Bin\\*', ageDays: 1, kind: '缓存' } });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /回收站不碰/);
});

await checkAsync('rt-11 未知路由 404；GET /api/collect/restart（应为 POST）405', async () => {
  const w = apiWorld();
  assert.equal((await w.run('GET', '/api/nope')).status, 404);
  assert.equal((await w.run('GET', '/api/collect/source')).status, 405);
});

await checkAsync('rt-12 非回环来源的请求一律 403（本插件能删文件，不接受远程驱动）', async () => {
  const w = apiWorld({ xff: '10.1.2.3' });
  const r = await w.run('POST', '/api/clean/scan', { body: {} });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /回环|本机/);
});

await checkAsync('rt-13 GET /api/search 参数夹取：limit>1000 收到 1000，空 q 直接 200 + 空结果 + error', async () => {
  const w = apiWorld();
  await w.run('GET', '/api/search', { query: { q: 'a', limit: '99999' } });
  assert.equal(w.calls.find((c) => c[0] === 'search')[1].limit, 1000);
  const r = await w.run('GET', '/api/search', { query: { q: '  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.error, 'EMPTY_QUERY');
});

await checkAsync('rt-14 ROUTES 覆盖 spec §3 的每个端点，且写端点全是 POST', async () => {
  const keys = Object.keys(API.ROUTES);
  for (const need of ['GET /api/snapshot', 'GET /api/stream', 'GET /api/prefs', 'POST /api/prefs', 'POST /api/collect/cadence',
    'POST /api/collect/source', 'POST /api/collect/visibility', 'POST /api/collect/restart', 'GET /api/alerts', 'POST /api/alerts/read',
    'POST /api/clean/scan', 'POST /api/clean/scan/stop', 'GET /api/clean/state', 'POST /api/clean/apply', 'GET /api/clean/logs',
    'GET /api/clean/unfinished', 'GET /api/rules', 'POST /api/rules/add', 'POST /api/rules/remove', 'POST /api/rules/toggle',
    'GET /api/search', 'GET /api/search/probe', 'POST /api/search/reprobe', 'GET /api/caps', 'GET /api/quarantine']) {
    assert.ok(keys.includes(need), `缺路由 ${need}`);
  }
  for (const k of keys) {
    const [m] = k.split(' ');
    assert.ok(['GET', 'POST'].includes(m), `路由方法只能是 GET/POST，实得 ${k}`);
  }
});

await checkAsync('rt-15 每个 handler 抛错都会变 500 + logger.warn（禁止半截响应）', async () => {
  const w = apiWorld();
  w.search.search = async () => { throw new Error('适配器炸了'); };
  const r = await w.run('GET', '/api/search', { query: { q: 'a' } });
  assert.equal(r.status, 500);
  assert.match(r.json.error.message, /适配器炸了/);
  assert.ok(w.events.some((m) => /适配器炸了/.test(m)));
  assert.equal(r.res.finished, true);
});

/* ------------------------------------------------------------------ *
 * ①段续：批 C 修复回补的专证（rt-16 起，仍属路由级 rt-* 家族）
 * ------------------------------------------------------------------ */

// —— Important-1：apply 整批拒不再落 HTTP 200（执行器 rejectedBatch 的四计数全 0 + error code）
await checkAsync('rt-16 apply 整批拒（GUARD_OPERATION_DENIED）→ 403 且 code 可见，不落 200', async () => {
  const w = apiWorld({ applySummary: { planId: 'p-1', logId: null, ok: 0, skipped: 0, failed: 0, rejected: 0, bytesFreed: 0, results: [], error: 'GUARD_OPERATION_DENIED' } });
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file' } });
  assert.equal(r.status, 403, '整批被红线拒必须是 4xx，不能是 200');
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'GUARD_OPERATION_DENIED');
  assert.match(r.json.error.message, /红线|拒绝|不允许/);
});

await checkAsync('rt-17 apply 整批拒（SYSOPS_RECORDS_NOT_FOUND：快照不存在）→ 404', async () => {
  const w = apiWorld({ applySummary: { planId: 'p-9', logId: null, ok: 0, skipped: 0, failed: 0, rejected: 0, bytesFreed: 0, results: [], error: 'SYSOPS_RECORDS_NOT_FOUND' } });
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p-9', itemIds: ['i-1'], mode: 'delete-file' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'SYSOPS_RECORDS_NOT_FOUND');
});

await checkAsync('rt-18 apply 整批拒（SYSOPS_QUARANTINE_UNAVAILABLE）→ 503（该 code 已登记进 CODE_STATUS）', async () => {
  const w = apiWorld({ applySummary: { planId: 'p-1', logId: null, ok: 0, skipped: 0, failed: 0, rejected: 0, bytesFreed: 0, results: [], error: 'SYSOPS_QUARANTINE_UNAVAILABLE' } });
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'move-to-quarantine' } });
  assert.equal(r.status, 503, '暂存目录不可用是依赖不可用（同 *_CLOSED 档），不是客户端可修的 4xx');
  assert.equal(API.statusFor('SYSOPS_QUARANTINE_UNAVAILABLE'), 503);
  assert.equal(r.json.error.code, 'SYSOPS_QUARANTINE_UNAVAILABLE');
});

await checkAsync('rt-19 apply 整批拒（记录域不可用）→ 按表 501，且不留 200', async () => {
  const w = apiWorld({ applySummary: { planId: 'p-1', ok: 0, skipped: 0, failed: 0, rejected: 0, results: [], error: 'SYSOPS_RECORDS_UNAVAILABLE' } });
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file' } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'SYSOPS_RECORDS_UNAVAILABLE');
});

await checkAsync('rt-20 apply partial（有任何一条被处理）仍 200，执行器三档计数语义不动', async () => {
  const summary = { planId: 'p-1', logId: 'l-1', ok: 1, skipped: 2, failed: 0, rejected: 3, bytesFreed: 10, results: [{ id: 'i-1', state: 'ok' }], error: '' };
  const w = apiWorld({ applySummary: summary });
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.data, summary, 'partial 结果原样透出（只在真的没处理任何一条时才改状态码）');
  // 计数闸门的反向证人：只要有任何一条被处理过，即使 summary 带着 code 也不算整批拒（仍 200）
  const partWithCode = { planId: 'p-1', logId: 'l-2', ok: 0, skipped: 1, failed: 0, rejected: 0, results: [{ id: 'i-2', state: 'skipped' }], error: 'SYSOPS_QUARANTINE_UNAVAILABLE' };
  const w2 = apiWorld({ applySummary: partWithCode });
  const r2 = await w2.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-2'], mode: 'move-to-quarantine' } });
  assert.equal(r2.status, 200, 'partial（有一条被跳过）绝不许升格成整批拒');
});

await checkAsync('rt-21 apply 四计数全 0 但不带 error → 仍 200（不误判成整批拒）', async () => {
  const w = apiWorld({ applySummary: { planId: 'p-1', ok: 0, skipped: 0, failed: 0, rejected: 0, results: [] } });
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

// —— Important-2：alerts 记录域错误的 code 不再被吞（状态码保持 200，in-body 语义同 rt-13）
await checkAsync('rt-22 GET /api/alerts 记录域错误带出 errorCode，状态仍 200', async () => {
  const w = apiWorld({ hitsResult: { rows: [], error: '告警仓储不可用', code: 'RECORDS_UNAVAILABLE' } });
  const r = await w.run('GET', '/api/alerts');
  assert.equal(r.status, 200);
  assert.equal(r.json.data.error, '告警仓储不可用');
  assert.equal(r.json.data.errorCode, 'RECORDS_UNAVAILABLE');
});

await checkAsync('rt-23 snapshot 的 alerts.errorCode 透出；正常时该键为 null（键恒在）', async () => {
  const wErr = apiWorld({ hitsResult: { rows: [], error: '读不回', code: 'RECORDS_INVALID' } });
  const rErr = await wErr.run('GET', '/api/snapshot');
  assert.equal(rErr.status, 200);
  assert.equal(rErr.json.data.alerts.errorCode, 'RECORDS_INVALID');
  assert.equal(rErr.json.data.alerts.hitsError, '读不回');
  const wOk = apiWorld();
  const rOk = await wOk.run('GET', '/api/snapshot');
  assert.equal(rOk.json.data.alerts.errorCode, null, 'hits 不带 code 时补 null，不给客户端留 undefined');
});

// —— Minor-1：socket.remoteAddress 非回环的直拒专证（rt-12 只打了 XFF 变体）
await checkAsync('rt-24 remoteAddress 非回环（10.0.0.5）→ 403 中文理由，且分派前就停住', async () => {
  const w = apiWorld({ remoteAddress: '10.0.0.5' });
  const r = await w.run('GET', '/api/snapshot');
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'FORBIDDEN');
  assert.match(r.json.error.message, /回环|本机/);
  assert.equal(w.calls.length, 0, '闸门先于路由分派，一个 service 都不该被碰到');
});

// —— Minor-2：`: ok` 首注释帧 + 25s 心跳节拍
await checkAsync('rt-25 openSse 建流即发一帧 `: ok` 注释（冲掉反代缓冲），并设好 SSE 四头', async () => {
  const res = makeRes();
  const sse = API.openSse(res);
  try {
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
    assert.equal(res.headers['Connection'], 'keep-alive');
    assert.equal(res.headers['X-Accel-Buffering'], 'no');
    assert.equal(res.chunks[0], ': ok\n\n', '首帧必须是 : ok 注释，且在别的任何帧之前');
  } finally {
    sse.close(); // 真心跳已 unref，仍显式摘掉，不留悬挂 timer
  }
});

await checkAsync('rt-26 openSse 每 25s 发一帧 `: ping`；close 后 timer 摘牌且不再写', async () => {
  const res = makeRes();
  const t = fakeTimers();
  const sse = API.openSse(res, { setIntervalMod: t.setIntervalMod, clearIntervalMod: t.clearIntervalMod });
  assert.equal(t.timers.length, 1, '建流只挂一个心跳 timer');
  assert.equal(t.timers[0].ms, 25000, '心跳节拍 25s');
  assert.equal(API.SSE_HEARTBEAT_MS, 25000);
  t.fire(0);
  assert.equal(res.chunks.at(-1), ': ping\n\n');
  sse.close();
  assert.equal(t.timers[0].cleared, true, 'close 必须清掉心跳');
  const n = res.chunks.length;
  t.fire(0);
  assert.equal(res.chunks.length, n, '已关闭的连接不该再写帧');
});

// —— Minor-3：心跳写失败即摘牌（不等 Node 的 close 事件），末断驱动 setVisible(false)
await checkAsync('rt-27 心跳写失败 → 立即摘牌并在末断时 setVisible(false)', async () => {
  const t = fakeTimers();
  const w = apiWorld({ sseTimers: t });
  const res = makeRes();
  const base = res.write.bind(res);
  res.write = (c) => {
    if (String(c).startsWith(': ping')) throw new Error('写失败：客户端已断开');
    return base(c);
  };
  await w.stream(res);
  assert.equal(w.calls.filter((c) => c[0] === 'setVisible' && c[1] === true).length, 1, '首个连接起来 → setVisible(true)');
  t.fire(0);
  assert.deepEqual(w.calls.at(-1), ['setVisible', false], '心跳写失败即摘牌（僵尸订阅窗口关掉），不等 close 事件');
  assert.equal(t.timers[0].cleared, true, '摘牌时心跳 timer 一并清掉');
  t.fire(0);
  assert.equal(w.calls.filter((c) => c[0] === 'setVisible' && c[1] === false).length, 1, '重复心跳不得二次触发末断');
});

// —— Ruling-98：GET /api/clean/plan 按 planId 读冻结快照（只读、不接受路径）
await checkAsync('rt-28 GET /api/clean/plan 命中返回快照实体，键集符合 clean_plan 声明', async () => {
  const w = apiWorld();
  const r = await w.run('GET', '/api/clean/plan', { query: { planId: 'p-1000-1234' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.planId, 'p-1000-1234');
  assert.deepEqual(Object.keys(r.json.data).sort(), ['afterFree', 'at', 'beforeFree', 'items', 'modeDefault', 'planId', 'rulesUsed', 'totals']);
  assert.deepEqual(Object.keys(r.json.data.items[0]).sort(), [...PLAN_ITEM_KEYS].sort());
  assert.equal(r.json.data.items[0].path, PLAN_FIXTURE.items[0].path, '清单实体（含 path）来自快照，不是前端');
  assert.deepEqual(w.calls.find((c) => c[0] === 'plan'), ['plan', 'p-1000-1234']);
});

await checkAsync('rt-29 GET /api/clean/plan 未知 planId → 404 SYSOPS_RECORDS_NOT_FOUND（不落 200）', async () => {
  const w = apiWorld({ plan: null });
  const r = await w.run('GET', '/api/clean/plan', { query: { planId: 'p-没有这种快照' } });
  assert.equal(r.status, 404);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'SYSOPS_RECORDS_NOT_FOUND');
});

await checkAsync('rt-30 GET /api/clean/plan 只认 planId 查询参数：前端传 path/glob 不影响取数', async () => {
  const w = apiWorld();
  const r = await w.run('GET', '/api/clean/plan', { query: { planId: 'p-1000-1234', path: 'C:\\Windows\\System32', glob: '**/*', dir: 'C:\\' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.planId, 'p-1000-1234');
  const planCall = w.calls.find((c) => c[0] === 'plan');
  assert.deepEqual(planCall, ['plan', 'p-1000-1234'], '取数只交 planId 一个字符串，路径类键一概不带进仓储');
});

await checkAsync('rt-31 GET /api/clean/plan 缺 planId 查询参数 → 400 INVALID_PARAM，且不落到仓储', async () => {
  const w = apiWorld();
  const r = await w.run('GET', '/api/clean/plan', { query: {} });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'INVALID_PARAM');
  assert.equal(w.calls.filter((c) => c[0] === 'plan').length, 0);
});

await checkAsync('rt-32 GET /api/clean/plan 记录域不可用（抛带 code）→ 按表 501', async () => {
  const w = apiWorld({ planThrows: Object.assign(new Error('宿主未提供 storageDomain'), { code: 'SYSOPS_RECORDS_UNAVAILABLE' }) });
  const r = await w.run('GET', '/api/clean/plan', { query: { planId: 'p-1' } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'SYSOPS_RECORDS_UNAVAILABLE');
});

await checkAsync('rt-33 GET /api/clean/plan 的 skipped 数组按 normalizeCleanState 同口径截断', async () => {
  const big = Array.from({ length: 25 }, (_, i) => ({ dir: `C:\\temp\\d${i}`, why: '无权限' }));
  const w = apiWorld({ plan: { ...PLAN_FIXTURE, skipped: big } });
  const r = await w.run('GET', '/api/clean/plan', { query: { planId: 'p-1000-1234' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.skipped.count, 25);
  assert.equal(r.json.data.skipped.sample.length, 20, '无上限数组不得原样吐给浏览器');
  assert.equal(r.json.data.skipped.truncated, true);
  assert.match(r.json.data.skipped.note, /仅列前 20 条/);
});

await checkAsync('rt-34 clean service 的 plan 出口只薄转发 planId 给 planStore.get（Ruling-98 转发链）', async () => {
  const { createCleanService } = await import('../lib/clean/service.js');
  const seen = [];
  const row = { planId: 'p-1', at: 1, items: [], totals: { n: 0, bytes: 0 } };
  const svc = createCleanService({
    planStore: { get: (id) => { seen.push(id); return Promise.resolve(id === 'p-1' ? row : null); }, list: async () => [] },
    logStore: { list: async () => [], unfinished: async () => [] },
    ruleStore: { activeRules: async () => [] },
    makeScanner: () => ({ scan: async () => ({}) }),
    makeExecutor: () => ({ apply: async () => ({}) }),
    makeQuarantine: () => ({ stats: async () => ({ dirs: 0, files: 0, bytes: 0, oldest: null }) }),
    getPrefs: () => ({}),
    fsMod: { statfsSync: () => ({ available: 0 }) },
    osMod: { homedir: () => 'C:\\Users\\me' },
    pathMod: { join: (...p) => p.join('\\') },
    logger: { warn: () => {} },
  });
  assert.equal((await svc.plan('p-1')).planId, 'p-1', '命中的是 plan-store 里那份冻结快照，不加工');
  assert.equal(await svc.plan('p-没有'), null, '找不到交 null（由 api 层翻成 404），不冒充空对象');
  assert.deepEqual(seen, ['p-1', 'p-没有'], '转发只交 planId 一个参数');
});

await checkAsync('rt-35 GET /api/clean/plan 走真实 clean service 的 plan 转发：快照实体一路到响应（Ruling-98 端到端）', async () => {
  const { createCleanService } = await import('../lib/clean/service.js');
  const seen = [];
  const svc = createCleanService({
    planStore: { get: (id) => { seen.push(id); return Promise.resolve(id === PLAN_FIXTURE.planId ? PLAN_FIXTURE : null); }, list: async () => [] },
    logStore: { list: async () => [], unfinished: async () => [] },
    ruleStore: { activeRules: async () => [] },
    makeScanner: () => ({ scan: async () => ({}) }),
    makeExecutor: () => ({ apply: async () => ({}) }),
    makeQuarantine: () => ({ stats: async () => ({ dirs: 0, files: 0, bytes: 0, oldest: null }) }),
    getPrefs: () => ({}),
    fsMod: { statfsSync: () => ({ available: 0 }) },
    osMod: { homedir: () => 'C:\\Users\\me' },
    pathMod: { join: (...p) => p.join('\\') },
    logger: { warn: () => {} },
  });
  const w = apiWorld();
  w.clean = svc; // 只把 clean 换成真 service，其余仍是桩
  const handler2 = API.createApiHandler({
    collect: w.collect, alerts: w.alerts, clean: svc, search: w.search, probe: { probe: async () => ({}), invalidate: () => {} },
    prefStore: { readAll: async () => ({ prefs: null, clean_rules: null }) }, ruleStore: { list: async () => ({ items: [], off: [] }) },
    caps: { read: () => ({}) }, logger: { warn: (m) => w.events.push(m) }, now: () => 1000,
  });
  const res = makeRes();
  await handler2({ method: 'GET', url: new URL(`http://127.0.0.1/api/clean/plan?planId=${PLAN_FIXTURE.planId}`), headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).data.planId, PLAN_FIXTURE.planId);
  assert.deepEqual(seen, [PLAN_FIXTURE.planId], '取数只带 planId 进仓储');
  handler2.dispose();
});

await checkAsync('rt-36 GET /api/rules 的 builtin 标记由宿主 BUILTIN_RULES id 集合裁决（Ruling-106），items/off/updatedAt 原形状不动', async () => {
  const { BUILTIN_RULES } = await import('../lib/clean/rules.js');
  const w = apiWorld({ ruleRows: {
    items: [{ id: 'u-1', n: '自研规则', kind: '缓存', ageDays: 7, rel: 'notes/u1/**' }],
    off: ['packages-cache'],
    updatedAt: 7,
  } });
  const r = await w.run('GET', '/api/rules');
  assert.equal(r.status, 200);
  const d = r.json.data;
  // 原形状不动：仓储行的三个键还是那三个键（规则库语义没被这次改动外溢），只多出一个宿主裁决的 builtin 集合
  assert.deepEqual(Object.keys(d).sort().join(','), 'builtin,items,off,updatedAt');
  assert.equal(d.updatedAt, 7);
  assert.deepEqual(d.off, ['packages-cache']);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].id, 'u-1');
  // 本机行：标记由宿主 id 集合给出（id 不在 BUILTIN_RULES ⇒ builtin:false），不是页面拿前缀猜的
  assert.equal(d.items[0].builtin, false, '本机行的 builtin 必须由宿主裁决为 false');
  // 内置行：与 BUILTIN_RULES 同集合、逐行 builtin:true；enabled 由 off 推出
  assert.equal(d.builtin.length, BUILTIN_RULES.length);
  assert.deepEqual(d.builtin.map((b) => b.id).sort(), BUILTIN_RULES.map((b) => b.id).sort(), '内置行集合必须等于宿主 BUILTIN_RULES 的 id 集合');
  assert.ok(d.builtin.every((b) => b.builtin === true), '内置行的 builtin 恒为 true');
  assert.equal(d.builtin.find((b) => b.id === 'packages-cache').enabled, false, 'off 命中内置 id ⇒ enabled=false');
  assert.equal(d.builtin.find((b) => b.id === 'temp-user').enabled, true, '不在 off ⇒ enabled=true');
  // 私有路径不出接口：dir/glob 展开后含本机绝对路径，与注入载荷同口径地不透传
  for (const b of d.builtin) assert.ok(!('dir' in b) && !('glob' in b), '内置行不得带 dir/glob：' + b.id);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
