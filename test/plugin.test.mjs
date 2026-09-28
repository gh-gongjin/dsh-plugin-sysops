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

function apiWorld(over = {}) {
  const events = [];
  const calls = [];
  const collect = {
    snapshot: () => ({ cadence: '1s', keepMinutes: 30, timerBackend: 'setInterval', series: { cpu: [{ t: 1, v: 2 }] }, latest: { cpu: 2, mem: 50, diskFreeGb: 70, diskTotalGb: 200, netDown: 0, netUp: 0, t: 1 }, sources: [{ key: 'l0', label: '实时曲线', state: 'on', detail: '', restarts: 0, pid: null, stderrTail: '' }], proc: { rows: [], state: 'off', note: '' }, dropped: { stale: 0, bad: 0 } }),
    sourceRows: () => [], procRows: () => [], setCadence: async (v) => { calls.push(['setCadence', v]); }, setSource: async (k, o) => { calls.push(['setSource', k, o]); }, setVisible: async (v) => { calls.push(['setVisible', v]); }, restartSource: async (k) => { calls.push(['restart', k]); },
    onEvent: (cb) => { collect._cb = cb; return () => { collect._cb = null; }; }, dispose: () => {},
  };
  const alerts = { ruleRows: () => [{ rule: { id: 'r1' }, st: { dim: false, on: true, st: '监控中' } }], hits: async ({ limit } = {}) => ({ rows: [{ hitId: 'h-1' }], error: null }), unread: () => 3, markRead: () => { calls.push(['markRead']); }, onEvent: () => () => {}, dispose: () => {} };
  const clean = { startScan: async () => { calls.push(['scan']); return { busy: false }; }, stopScan: () => { calls.push(['scanStop']); }, state: () => ({ phase: 'idle', dir: '', walked: 0, hit: 0, bytes: 0, stopped: false, truncated: false, skipped: [], planId: null, error: '' }), apply: async (a) => { calls.push(['apply', a]); return { ok: 1, skipped: 0, failed: 0, rejected: 0 }; }, plans: async () => [], logs: async () => [], unfinished: async () => [], quarantineStats: async () => ({ dirs: 0, files: 0, bytes: 0, oldest: null }), onEvent: () => () => {}, dispose: () => {} };
  const search = { search: async (a) => { calls.push(['search', a]); return { rows: [], source: 'walk', sourceLabel: '本地遍历', note: '', error: null, took: 5, truncated: false, stale: false, limit: 200 }; } };
  const probe = { probe: async () => ({ ready: false, via: null, degraded: true, level: null, checks: [], advice: ['x'] }), invalidate: () => { calls.push(['invalidate']); } };
  const prefsMod = {
    readAll: async () => ({ prefs: { collect: { cadence: '1s' } }, clean_rules: null }),
    writeMany: async (p) => { calls.push(['writeMany', p]); if (over.prefsFails) throw Object.assign(new Error('没有 storageDomain'), { code: 'PREFS_UNAVAILABLE' }); return { written: p, skipped: [] }; },
    available: over.noStorage === true ? false : true,
  };
  const ruleStore = { add: async (r) => { calls.push(['ruleAdd', r]); throw Object.assign(new Error('回收站不碰'), { code: 'SYSOPS_RULE_GUARD_DENY', why: '回收站不碰' }); }, remove: async () => ({}), toggle: async () => ({}), list: async () => ({ items: [], off: [] }), error: null };
  // probe 作为独立 dep（属搜索域，不混进 clean 的桩里）
  const handler = API.createApiHandler({ collect, alerts, clean, probe, search, prefStore: prefsMod, ruleStore, caps: over.caps ?? { read: () => ({ storageDomain: prefsMod.available, timer: false, webServer: true, notifications: false, autostart: false }) }, logger: { warn: (m) => events.push(m) }, now: () => 1000 });
  const run = async (method, path, { body, query } = {}) => {
    const res = makeRes();
    const url = new URL(`http://127.0.0.1${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    await handler({ method, url, headers: { host: '127.0.0.1:4321', 'x-forwarded-for': over.xff }, socket: { remoteAddress: '127.0.0.1' } }, res, body === undefined ? {} : body);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, res };
  };
  return { run, calls, events, collect, alerts, clean, search, handler };
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

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
