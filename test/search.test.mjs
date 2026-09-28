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

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
