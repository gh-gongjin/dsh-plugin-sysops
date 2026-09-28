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

/* ①段：三级探测 probe */
const PB = await import('../lib/search/probe.js');

function probeWorld(over = {}) {
  let t = 0;
  const calls = [];
  const probe = PB.createProbe({
    fsMod: { existsSync: (p) => (over.installedPaths ?? []).some((x) => p.toLowerCase() === x.toLowerCase()) },
    requestFn: async (url, opts = {}) => {
      calls.push({ url, method: opts.method ?? 'GET' });
      if (over.httpThrows) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (over.httpStatus === 403) return { status: 403, body: '' };
      if (over.httpStatus === 500) return { status: 500, body: 'boom' };
      return { status: 200, body: over.httpBody ?? '{"results":[],"total":0}' };
    },
    execFileMod: async (cmd, args) => {
      calls.push({ cmd, args });
      if (over.esThrows) throw Object.assign(new Error('找不到 es.exe'), { code: 'ENOENT' });
      return { stdout: over.esStdout ?? 'C:\\a.txt\nC:\\b.txt\n' };
    },
    getPrefs: () => ({ search: { mode: over.mode ?? 'everything', port: over.port, esPath: over.esPath, walkDirs: over.walkDirs ?? [] } }),
    now: () => t,
    advance: (ms) => { t += ms; },
    calls,
  });
  return { probe, calls, adv: (ms) => { t += ms; } };
}

check('pb-1 三级常量与原型自检卡的三行一致', () => {
  assert.deepEqual(PB.PROBE_LEVELS, ['installed', 'channel', 'e2e']);
  assert.equal(PB.DEFAULT_EVERYTHING_PORT, 3417);
  assert.equal(PB.ADVICE.length, 3, '安装指引三条：winget / 官网 / 勾选 HTTP 服务器');
  assert.ok(PB.ADVICE[0].includes('winget install voidtools.Everything'));
  assert.ok(PB.ADVICE[1].includes('voidtools.com/downloads'));
  assert.ok(PB.ADVICE[2].includes('HTTP 服务器'));
});

await checkAsync('pb-2 全绿：installed + channel(http) + e2e 都过 → ready，via=http', async () => {
  const w = probeWorld({ installedPaths: ['C:\\Program Files\\Everything\\Everything.exe'] });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, true);
  assert.equal(r.http, true);
  assert.equal(r.e2e, true);
  assert.equal(r.ready, true);
  assert.equal(r.via, 'http');
  assert.equal(r.degraded, false);
  assert.equal(r.level, 'e2e');
});

await checkAsync('pb-3 未安装：三级全否，advice 给全三条并 degraded', async () => {
  const w = probeWorld({ installedPaths: [], httpThrows: true, esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, false);
  assert.equal(r.ready, false);
  assert.equal(r.degraded, true);
  assert.equal(r.level, null);
  assert.equal(r.advice.length, 3);
  assert.ok(r.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0), '每一级都要说清卡在哪');
});

await checkAsync('pb-4 装了但 HTTP 403 → channel 否、e2e 否，advice 只剩「勾选 HTTP 服务器」一条', async () => {
  const w = probeWorld({ installedPaths: ['C:\\Program Files\\Everything\\Everything.exe'], httpStatus: 403, esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, true);
  assert.equal(r.http, false);
  assert.equal(r.level, 'installed');
  assert.equal(r.advice.length, 1);
  assert.match(r.advice[0], /HTTP 服务器/);
});

await checkAsync('pb-5 只有 es.exe 可用：via=es（installed 靠 es 命中也算）', async () => {
  const w = probeWorld({ installedPaths: [], esThrows: false });
  const r = await w.probe.probe(true);
  assert.equal(r.es, true);
  assert.equal(r.via, 'es');
  assert.equal(r.installed, true, 'es.exe 在 PATH 里同样算「已装」');
});

await checkAsync('pb-6 探测结果缓存 30s：期间重复 probe 不再发请求，过期后重探', async () => {
  const w = probeWorld();
  await w.probe.probe(true);
  const n1 = w.calls.length;
  await w.probe.probe();
  assert.equal(w.calls.length, n1, '缓存内不得重探');
  w.adv(31_000);
  await w.probe.probe();
  assert.ok(w.calls.length > n1);
});

await checkAsync('pb-7 invalidate()（界面的「重新检测」）强制绕开缓存', async () => {
  const w = probeWorld();
  await w.probe.probe();
  const n1 = w.calls.length;
  w.probe.invalidate();
  await w.probe.probe();
  assert.ok(w.calls.length > n1);
});

await checkAsync('pb-8 walkDirs 为空时即使 Everything 不可用也不谎称就绪；degraded 附带覆盖范围说明', async () => {
  const w = probeWorld({ installedPaths: [], httpThrows: true, esThrows: true, walkDirs: [] });
  const r = await w.probe.probe(true);
  assert.equal(r.ready, false);
  assert.match(r.checks.find((c) => c.key === 'walk').detail, /未选目录|限定目录/);
});

await checkAsync('pb-9 端口取自 prefs.search.port，未配置时用 3417', async () => {
  const w = probeWorld({ port: 4321 });
  await w.probe.probe(true);
  assert.ok(w.calls.some((c) => c.url && String(c.url).includes(':4321')), JSON.stringify(w.calls));
});

/* ②段：Everything HTTP */
const EH = await import('../lib/search/everything-http.js');

const everythingBody = (n = 2) => JSON.stringify({
  results: Array.from({ length: n }, (_, i) => ({ name: `report ${i}.pdf`, path: `C:\\docs\\report ${i}.pdf`, size: 1024 * (i + 1), date_modified: 1760000000 })),
  total: 1000,
});

check('sh-1 buildUrl：/fq/ 端点、count 带上限、query 走 URL 编码', () => {
  const u = EH.buildUrl({ q: 'report .pdf', limit: 200, port: 3417 });
  assert.match(u, /^http:\/\/127\.0\.0\.1:3417\/fq\/\?/);
  assert.match(u, /search=report%20\.pdf|search=report\+%2E%20pdf|%20/);
  assert.match(u, /count=200/);
});

check('sh-2 parseEverythingJson：缺字段的行为 null 而不是 0（不许把未知当"没有"）', () => {
  const rows = EH.parseEverythingJson(JSON.stringify({ results: [{ name: 'a', path: 'C:\\a' }, { name: 'b', path: 'C:\\b', size: 5, date_modified: 1 }] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].size, null);
  assert.equal(rows[1].size, 5);
});

check('sh-3 畸形 JSON / results 不是数组 → 返回空数组并交调用方记错误', () => {
  assert.deepEqual(EH.parseEverythingJson('<html>500</html>'), []);
  assert.deepEqual(EH.parseEverythingJson('{"results":"x"}'), []);
});

await checkAsync('sh-4 403 单独成错并给出可执行指引（spec §4.4）', async () => {
  const r = await EH.searchEverything({ q: 'a', limit: 10, port: 3417, requestFn: async () => ({ status: 403, body: '' }) });
  assert.equal(r.rows.length, 0);
  assert.equal(r.status, 403);
  assert.match(r.error, /HTTP 服务器/);
});

await checkAsync('sh-5 超时：4s 到点取消请求，error 里点名 timeout', async () => {
  const r = await EH.searchEverything({
    q: 'a', limit: 10, port: 3417, timeoutMs: 20,
    requestFn: (_u, { signal } = {}) => new Promise((_res, rej) => { signal?.addEventListener?.('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
  });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /超时|timeout|abort/i);
});

await checkAsync('sh-6 正常返回：行数、路径、来源都归一化好', async () => {
  const r = await EH.searchEverything({ q: 'report', limit: 10, port: 3417, requestFn: async () => ({ status: 200, body: everythingBody(3) }) });
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].name, 'report 0.pdf');
});

/* ③段：es.exe */
const ES = await import('../lib/search/es-exe.js');

check('se-1 buildArgs：空 query 直接拒（es.exe 无参会吐全库）', () => {
  assert.throws(() => ES.buildArgs({ q: '  ', limit: 10 }), /query|关键字/);
  const a = ES.buildArgs({ q: 'report .pdf', limit: 50 });
  assert.deepEqual(a.slice(0, 4), ['-max-count', '50', '-sort', 'path']);
  assert.equal(a[4], 'report .pdf');
});

check('se-2 parseEsOutput：每行一条完整路径，空行与表头丢弃', () => {
  const rows = ES.parseEsOutput('C:\\a.txt\r\n\r\nC:\\b c.md\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].path, 'C:\\b c.md');
  assert.equal(rows[1].name, 'b c.md');
});

await checkAsync('se-3 es.exe 不存在（ENOENT）→ error 说清未找到，不抛', async () => {
  const r = await ES.searchEs({ q: 'a', limit: 10, execFileMod: async () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /es\.exe|未找到/);
});

/* ④段：walk（本机唯一实跑通路） */
const WK = await import('../lib/search/walk.js');

check('wk-1 空格分词=同时满足，大小写不敏感（原型 index.html:659 写的「大小写敏感」是错的，以本用例为准）', () => {
  assert.deepEqual(WK.tokensOf('东财 数据源'), ['东财', '数据源']);
  assert.equal(WK.matchName('东财数据源.csv', ['东财', '数据源']), true);
  assert.equal(WK.matchName('数据源东财.csv', ['东财', '数据源']), true, '词序无关');
  assert.equal(WK.matchName('Report.pdf', ['report']), true, 'Everything 默认大小写不敏感，walk 要跟它一致');
  assert.equal(WK.matchName('a.txt', ['b']), false);
});

function walkFs(files, opts = {}) {
  const map = new Map(Object.entries(files));
  return {
    readdirSync: (dir) => {
      if (opts.denied && dir.startsWith(opts.denied)) throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' });
      const out = [];
      for (const p of map.keys()) {
        if (!p.startsWith(dir + '\\')) continue;
        const rest = p.slice(dir.length + 1);
        if (!rest.includes('\\')) out.push(rest);
        else if (!out.some((x) => x.split('\\')[0] === rest.split('\\')[0])) out.push(rest.split('\\')[0] + '\\');
      }
      return out.map((n) => ({ name: n.replace(/\\$/, ''), isDirectory: () => n.endsWith('\\'), isFile: () => !n.endsWith('\\') }));
    },
    statSync: (p) => { const f = map.get(p); if (!f) throw Object.assign(new Error('无'), { code: 'ENOENT' }); return { isFile: () => true, isDirectory: () => false, size: f.size ?? 1, mtimeMs: f.mtime ?? 1 }; },
    join: (a, b) => `${a}\\${b}`,
  };
}

await checkAsync('wk-2 命中集与 Everything 同形状（name/dir/size/mtime/path），只差 source', async () => {
  const r = await WK.walkSearch({
    q: 'report pdf', limit: 10, dirs: ['C:\\Users\\gongj\\AppData\\Local'],
    fsMod: walkFs({ 'C:\\Users\\gongj\\AppData\\Local\\report a.pdf': { size: 11 }, 'C:\\Users\\gongj\\AppData\\Local\\sub\\report b.pdf': { size: 22 }, 'C:\\Users\\gongj\\AppData\\Local\\other.txt': { size: 3 } }),
    pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() }, now: () => 1000,
  });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].dir, 'C:\\Users\\gongj\\AppData\\Local');
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['dir', 'mtime', 'name', 'path', 'size', 'source']);
});

await checkAsync('wk-3 无 dirs 时不假装能搜：返回空 + note 点名未选目录', async () => {
  const r = await WK.walkSearch({ q: 'a', limit: 10, dirs: [], fsMod: walkFs({}), pathMod: { join: (a, b) => a + b, basename: (p) => p }, now: () => 1 });
  assert.equal(r.rows.length, 0);
  assert.match(r.note, /未选目录|设置/);
});

await checkAsync('wk-4 预算耗尽/超 limit：timedOut 与 truncated 分开标（两种"不全"原因不同）', async () => {
  const files = {};
  for (let i = 0; i < 500; i++) files[`C:\\d\\report ${i}.pdf`] = { size: i };
  const fsMod = walkFs(files);
  const r = await WK.walkSearch({ q: 'report', limit: 50, dirs: ['C:\\d'], fsMod, pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() }, now: () => 1, budgetMs: 1 });
  assert.equal(r.timedOut, true);
  assert.equal(r.truncated, false, '预算先到就不算截断');
  const r2 = await WK.walkSearch({ q: 'report', limit: 50, dirs: ['C:\\d'], fsMod, pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() }, now: () => 1, budgetMs: 1e9 });
  assert.equal(r2.truncated, true);
  assert.equal(r2.rows.length, 50);
});

await checkAsync('wk-5 递进时钟驱动 wall-clock 预算闸在遍历中途真实触发（超时腿的唯一证人）', async () => {
  const files = {};
  for (let i = 0; i < 500; i++) files[`C:\\d\\report ${i}.pdf`] = { size: i };
  let k = 0; // 假时钟每调一次真的往前 1000ms —— 区别于 wk-2/wk-3/wk-4 全程冻结的 now
  const r = await WK.walkSearch({
    q: 'report', limit: 1000, dirs: ['C:\\d'], fsMod: walkFs(files),
    pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() },
    now: () => { k += 1; return k * 1000; }, budgetMs: 999,
  });
  // budgetMs=999 → 条目硬上限 = trunc(999*20) = 19980，500 个文件永远够不到；timedOut 只可能来自 wall-clock 腿
  assert.equal(r.timedOut, true, 'wall-clock 预算闸应在第 200 条目检查点因时钟超预算触发');
  assert.equal(r.truncated, false, '标的是预算耗尽（超时），不是命中够 limit 的截断');
  assert.equal(r.walked, 200, `硬上限不可达，只可能在首个 200 条目检查点被 wall-clock 中断，实测 walked=${r.walked}`);
  assert.equal(r.rows.length, 199, `超时中断使命中集停在已扫的 199 条，实测 rows=${r.rows.length}`);
});

/* ⑤段：service 选路与诚实降级 */
const SS = await import('../lib/search/service.js');

function svWorld(probeResult, over = {}) {
  const calls = [];
  const adapters = {
    everything: async (a) => { calls.push(['everything', a]); return over.everything ?? { rows: [{ name: 'a', path: 'C:\\a', size: 1, mtime: 1 }], error: null } },
    es: async (a) => { calls.push(['es', a]); return over.es ?? { rows: [{ name: 'b', path: 'C:\\b' }], error: null } },
    walk: async (a) => { calls.push(['walk', a]); return over.walk ?? { rows: [{ name: 'c', path: 'C:\\c', size: 3 }], truncated: false, timedOut: false, skipped: [], note: '' } },
  };
  const svc = SS.createSearchService({
    probe: { probe: async () => probeResult, invalidate: () => {} },
    getPrefs: () => ({ search: { mode: over.mode ?? 'everything', walkDirs: over.walkDirs ?? ['C:\\Users\\gongj\\AppData\\Local'], limit: over.limit, port: 3417, esPath: '' } }),
    adapters, logger: { warn() {} }, now: () => 1000,
  });
  return { svc, calls };
}

const READY = { ready: true, via: 'http', degraded: false, checks: [], advice: [] };

await checkAsync('sv-1 探测就绪 → 走 Everything，source 与 sourceLabel 一起返回', async () => {
  const w = svWorld(READY);
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'everything');
  assert.equal(r.sourceLabel, 'Everything HTTP');
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0][0], 'everything');
});

await checkAsync('sv-2 探测不通 → 自动降级 walk，note 说清缺哪一级', async () => {
  const w = svWorld({ ready: false, via: null, degraded: true, level: 'installed', checks: [{ key: 'http', ok: false, detail: '未开 HTTP 服务' }], advice: [] });
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'walk');
  assert.match(r.note, /未开 HTTP 服务|降级/);
});

await checkAsync('sv-3 用户显式选 walk（mode=walk）时不看探测结果', async () => {
  const w = svWorld(READY, { mode: 'walk' });
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'walk');
  assert.equal(w.calls.length, 1);
});

await checkAsync('sv-4 via=es 走 es.exe（两条通路只通一条时不误判为降级）', async () => {
  const w = svWorld({ ready: true, via: 'es', degraded: false, checks: [], advice: [] });
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'es');
  assert.equal(r.sourceLabel, 'es.exe');
});

await checkAsync('sv-5 适配器报错：保留上次结果并标 stale（不拿旧结果冒充新查）', async () => {
  const w = svWorld(READY);
  await w.svc.search({ q: 'first' });
  const bad = SS.createSearchService({
    probe: { probe: async () => READY }, getPrefs: () => ({ search: { mode: 'everything', walkDirs: [], port: 3417 } }),
    adapters: { everything: async () => ({ rows: [], error: 'HTTP 403' }) }, logger: { warn() {} }, now: () => 2000,
  });
  const r = await bad.search({ q: 'a' });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /403/);
  const r2 = await bad.search({ q: 'b' });
  assert.ok(typeof r2.stale === 'boolean');
});

await checkAsync('sv-6 归一化一致：三条通路的行都能喂给同一张表', async () => {
  const norm = SS.normalize({ name: 'x', path: 'C:\\d\\x', size: null, mtime: null }, 'everything');
  assert.equal(norm.dir, 'C:\\d');
  assert.equal(norm.source, 'everything');
  assert.equal(norm.size, null, '未知大小保持 null，界面显示「—」而不是 0 B');
});

await checkAsync('sv-7 空 query 拒（不发请求也不遍历）', async () => {
  const w = svWorld(READY);
  const r = await w.svc.search({ q: '   ' });
  assert.equal(r.error, 'EMPTY_QUERY');
  assert.equal(w.calls.length, 0);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
