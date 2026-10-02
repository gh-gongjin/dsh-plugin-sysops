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
    // env 由用例注入（默认 C 盘的 Program Files）：安装位置候选全靠它，读真机的 process.env 会让这条用例跟着机器变。
    env: over.env ?? { ProgramFiles: 'C:\\Program Files' },
    requestFn: async (url, opts = {}) => {
      calls.push({ url, method: opts.method ?? 'GET' });
      if (over.httpThrows) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (over.httpStatus === 403) return { status: 403, body: '' };
      if (over.httpStatus === 404) return { status: 404, body: '<html>404 Not Found</html>' };
      if (over.httpStatus === 500) return { status: 500, body: 'boom' };
      return { status: 200, body: over.httpBody ?? '{"results":[],"totalResults":0}' };
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

await checkAsync('pb-10 装在非常见位置但查询服务在应答 ⇒ ①②③ 全绿（S11-③ 那条：D 盘装机 + 根路径 JSON，全假世界）', async () => {
  // 这一条钉的就是用户截图上的「已安装为什么还是检测不到」：修前 ① 只看 C:\Program Files 的硬编码路径、
  // ② 打的 /fq/ 在本机回 404，两条同时否 ⇒ 自检三级全红、搜索降级成遍历。
  const w = probeWorld({ installedPaths: ['D:\\Program Files\\Everything\\Everything.exe'], env: { ProgramFiles: 'C:\\Program Files' }, esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, true, 'HTTP 服务在应答 = Everything 正在运行，装在哪个盘不改变结论');
  assert.equal(r.http, true, '根路径 + json=1 必须 200（不再打 /fq/）');
  assert.equal(r.via, 'http');
  assert.equal(r.ready, true);
  assert.match(r.checks.find((c) => c.key === 'installed').detail, /正在运行|便携版/);
});

await checkAsync('pb-11 安装路径候选来自 env：ProgramFiles 指哪块盘就查哪块盘（不把盘符焊进源码）', () => {
  const c = PB.everythingExeCandidates({ ProgramFiles: 'D:\\Program Files', 'ProgramFiles(x86)': 'D:\\Program Files (x86)' });
  assert.ok(c.includes('D:\\Program Files\\Everything\\Everything.exe'), JSON.stringify(c));
  assert.ok(c.includes('D:\\Program Files (x86)\\Everything\\Everything.exe'));
  assert.equal(c.some((p) => /^C:/.test(p)), false, 'env 给了 D 盘就不该再优先 C 盘');
  const d = PB.everythingExeCandidates({ ProgramFiles: 'D:\\Program Files\\' });
  assert.deepEqual(d, ['D:\\Program Files\\Everything\\Everything.exe'], '尾部斜杠不重复、去重后只留一条');
});

await checkAsync('pb-11b HTTP 404 单独成文案：说清「端口上有应答但不是 Everything 的接口」', async () => {
  const w = probeWorld({ installedPaths: [], httpStatus: 404, esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.http, false);
  assert.equal(r.installed, false, '404 不算「在应答」，不能拿它当已安装的证据');
  assert.match(r.checks.find((c) => c.key === 'http').detail, /404.*端口|端口.*不是 Everything/);
});

await checkAsync('pb-12 源码锁：lib/search 的**代码**里不许再出现 /fq/（本机实测 404，见 tmp/s11-everything.txt；注释里作为教训提及是允许的）', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../lib/search/', import.meta.url);
  const bad = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .filter((name) => {
      const code = fs.readFileSync(new URL(name, dir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return /\/fq\//.test(code);
    });
  assert.deepEqual(bad, [], '这些文件里还有 /fq/ 端点');
});

await checkAsync('pb-13 e2e 验的是「真吃得下」：results 不是数组就不算通', async () => {
  const w = probeWorld({ installedPaths: ['C:\\Program Files\\Everything\\Everything.exe'], httpBody: '{"results":"不是数组"}', esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.http, true, '通道级只看 200');
  assert.equal(r.e2e, false, '端到端要能把 results 当数组用，否则搜索页拿到的就是空表');
  assert.equal(r.ready, false);
  assert.match(r.advice[0], /无法解析|重启 Everything/);
});

/* ②段：Everything HTTP
 * 夹具形状按 2026-09-29 真机读回（tmp/s11-everything.txt）：
 *   `GET /?search=win.ini&count=3&json=1&path_column=1&size_column=1&date_modified_column=1`
 *   → 200 `{"totalResults":2,"results":[{"type":"file","name":"win.ini","path":"C:\\Windows","size":"92","date_modified":"132963745525044623"}]}`
 * —— size 是字符串、date_modified 是 FILETIME、path 是**父目录**。原先按 spec/原型写的夹具是
 * 「path=全路径 + size/日期是数字」，正好把这三处不符藏住了（S11-③）。 */
const EH = await import('../lib/search/everything-http.js');

/** 132963745525044623 = 2022-09-28 前后的 FILETIME；这里只要求解出来是 2000~2100 年之间的毫秒 */
const FT_SAMPLE = '132963745525044623';

const everythingBody = (n = 2) => JSON.stringify({
  results: Array.from({ length: n }, (_, i) => ({
    type: 'file', name: `report ${i}.pdf`, path: 'C:\\docs', size: String(1024 * (i + 1)), date_modified: FT_SAMPLE,
  })),
  totalResults: 1000,
});

check('sh-1 buildUrl：根路径 + json=1 + 三个列开关、count 带上限、query 走 URL 编码（/fq/ 在本机 404 —— S11-③）', () => {
  const u = EH.buildUrl({ q: 'report .pdf', limit: 200, port: 3417 });
  assert.match(u, /^http:\/\/127\.0\.0\.1:3417\/\?/);
  assert.doesNotMatch(u, /\/fq\/|\/json\/|\/ex\//, '这些端点本机全 404，不许再回到 URL 里');
  assert.match(u, /json=1/);
  assert.match(u, /path_column=1&size_column=1&date_modified_column=1/);
  assert.match(u, /search=report%20\.pdf|search=report\+%2E%20pdf|%20/);
  assert.match(u, /count=200/);
  assert.match(EH.buildUrl({ q: 'a', limit: 10, port: 3417, offset: 30 }), /offset=30/);
});

check('sh-2 parseEverythingJson：缺字段的行为 null 而不是 0（不许把未知当"没有"）', () => {
  const rows = EH.parseEverythingJson(JSON.stringify({ results: [{ name: 'a.txt', path: 'C:\\' }, { name: 'b.txt', path: 'C:\\x', size: '5', date_modified: FT_SAMPLE }] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].size, null);
  assert.equal(rows[1].size, 5, '真机 size 是十进制字符串，要解成数字');
});

check('sh-2b 宿主回话的形状（自包含夹具，不碰本机 Everything）：path 是父目录 ⇒ 拼回全路径；FILETIME ⇒ unix 毫秒；totalResults ⇒ total', () => {
  const rows = EH.parseEverythingJson(JSON.stringify({ totalResults: 14181, results: [{ type: 'file', name: 'win.ini', path: 'C:\\Windows', size: '92', date_modified: FT_SAMPLE }] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'win.ini');
  assert.equal(rows[0].path, 'C:\\Windows\\win.ini', '父目录 + 文件名拼成全路径（父目录已带尾分隔符时不重复拼）');
  assert.equal(rows[0].size, 92);
  const y = new Date(rows[0].mtime).getUTCFullYear();
  assert.ok(y >= 2000 && y <= 2100, `FILETIME 解出来该是 2000~2100 年，实际 ${y}（${rows[0].mtime}）`);
  assert.equal(rows[0].total, 14181);

  // 文件夹行：真机不给 size/日期，或给空串 ⇒ 都是 null，不是 0 B、不是 1970
  const dirRows = EH.parseEverythingJson(JSON.stringify({ totalResults: 1, results: [{ type: 'folder', name: 'Logs', path: 'C:\\x' }, { type: 'folder', name: 'Tmp', path: 'C:\\y', size: '', date_modified: '0' }] }));
  assert.deepEqual(dirRows.map((r) => r.size), [null, null]);
  assert.deepEqual(dirRows.map((r) => r.mtime), [null, null]);

  // unix 秒口径（早期 /fq/ 的返回）也得解对，别把 17 亿解成 1970
  const sec = EH.toMtimeMs(1760000000);
  assert.equal(new Date(sec).getUTCFullYear(), 2025);
  assert.equal(EH.toMtimeMs(0), null);
  assert.equal(EH.toMtimeMs('abc'), null);
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

/**
 * sh-真机-1（S11-③）：本机 Everything 真查一次，把「契约按 spec 写、没在本机验证」这笔账结清。
 * 装配口径与 index.js 同形：requestFn = `httpRequest`（index.js:192，返回 `{status, body:文本}`），
 * 直接给原生 fetch 的 Response 会让 `res.body` 是流 —— 探测评的是假失败，单测也拦不住。
 */
await checkAsync('sh-真机-1 本机 Everything（:3417）真查询：三级全绿、行里有大小与修改时间', async () => {
  const fs = await import('node:fs');
  const { createProbe } = await import('../lib/search/probe.js');
  const httpRequest = async (url, { timeoutMs } = {}) => {
    const ctrl = new AbortController();
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const r = await fetch(url, { method: 'GET', signal: ctrl.signal });
      return { status: r.status, body: await r.text() };
    } finally { if (timer) clearTimeout(timer); }
  };
  const port = 3417;
  const probe = createProbe({
    fsMod: fs, requestFn: httpRequest,
    // es.exe 门面同形 index.js:206（execFile 非 shell，返回 {stdout}）
    execFileMod: (bin, args, o = {}) => new Promise((resolve, reject) => {
      import('node:child_process').then(({ execFile }) => {
        execFile(bin, args, o, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
      });
    }),
    getPrefs: () => ({ search: { port } }),
    now: () => Date.now(),
  });
  const r = await probe.probe(true);
  if (!r.http) {
    // Everything 没在跑：这一条只验「不许谎称就绪」，不在没装机的环境里硬失败（与 hc-9 同口径）
    console.log('        本机 :3417 无应答（Everything 未运行）—— 只验降级面');
    assert.equal(r.ready, false);
    return;
  }
  assert.equal(r.installed, true, '查询服务在应答就算已安装（装在哪块盘由系统说话，不靠硬编码路径）');
  assert.equal(r.via, 'http');
  assert.equal(r.e2e, true, 'e2e 不过就是返回结构没吃到，正是修前那一版');
  assert.equal(r.ready, true, JSON.stringify(r.checks));

  const res = await EH.searchEverything({ q: 'win.ini', limit: 5, port, requestFn: httpRequest });
  assert.equal(res.error, undefined, `真查询不该报错：${res.error}`);
  assert.ok(res.rows.length > 0, 'win.ini 在系统盘上必定存在，搜不到就是通路不通');
  const first = res.rows[0];
  assert.match(String(first.path), /\\win\.ini$/i, `path 该是拼好的全路径：${first.path}`);
  assert.equal(typeof first.size, 'number', `size 该是数字（真机给的是字符串）：${first.size}`);
  assert.ok(first.mtime > 946_684_800_000 && first.mtime < 4_102_444_800_000,
    `mtime 该是 2000~2100 之间的 unix 毫秒（真机给的是 FILETIME）：${first.mtime}`);
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

/* ⑥段：Everything 一键安装（S12-⑤）
   「装什么」全部来自 installer.js 的常量，界面上那颗按钮只是这儿的读数。
   桩只给到宿主真会给的形状（winget --version 的 stdout / 一条 promise），不加宿主没有的宽容。 */
const IN = await import('../lib/search/installer.js');
const PinnedCommand = 'winget install --id voidtools.Everything --exact --source winget --accept-package-agreements --accept-source-agreements';
const tick = () => new Promise((r) => setImmediate(r));
const grab = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

function inWorld(opts = {}) {
  const clock = { t: 1000 };
  const execCalls = [];
  const warns = [];
  const infos = [];
  let invalidated = 0;
  let install = null;   // 安装那一步的 promise（测试自己决定何时/怎么收口）
  const inst = IN.createInstaller({
    bin: opts.bin,
    execFileMod: (b, args, o) => {
      execCalls.push({ b, args, o });
      if (args[0] === '--version') {
        if (opts.versionThrow) return Promise.reject(opts.versionThrow);
        return Promise.resolve({ stdout: opts.versionStdout ?? 'v1.8.1912.0' });
      }
      if (opts.installThrowSync) throw opts.installThrowSync;
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      install = { resolve, reject };
      return promise;
    },
    probe: { invalidate() { invalidated += 1; } },
    logger: { warn: (m) => warns.push(m), info: (m) => infos.push(m) },
    now: () => clock.t,
    detectTtlMs: opts.detectTtlMs,
  });
  return {
    inst, execCalls, clock, warns, infos,
    versionCalls: () => execCalls.filter((c) => c.args[0] === '--version').length,
    installCalls: () => execCalls.filter((c) => c.args[0] === 'install').length,
    lastInstall: () => execCalls.filter((c) => c.args[0] === 'install').slice(-1)[0],
    okInstall: async (out = { stdout: '已安装成功' }) => { install.resolve(out); await tick(); },
    badInstall: async (error) => { install.reject(error); await tick(); },
    settleCalls: () => invalidated,
    advance: (ms) => { clock.t += ms; },
  };
}

await checkAsync('in-1 探不到 winget（ENOENT）：ready 把原因说清，start 直接拒，并且一次安装都没跑', async () => {
  const w = inWorld({ versionThrow: Object.assign(new Error('spawn winget ENOENT'), { code: 'ENOENT' }) });
  const r = await w.inst.ready();
  assert.equal(r.can, false);
  assert.match(r.detail, /PATH 里没有 winget/, '按钮不亮的原话要能回答「这台机器缺什么」');
  const err = await grab(() => w.inst.start());
  assert.equal(err && err.code, IN.INSTALL_ERROR.UNAVAILABLE);
  assert.match(err.message, /所以这次没有启动安装/, '拒的时候必须明说「什么都没跑」');
  assert.equal(w.installCalls(), 0, '探不到就不许碰安装那一步');
});

await checkAsync('in-2 winget 在位：ready 交回版本号与命令原文（命令只在宿主这一处拼，界面只回显）', async () => {
  const w = inWorld();
  const r = await w.inst.ready();
  assert.equal(r.can, true);
  assert.match(r.version, /^v1\.8/, '版本号从 --version 的原文里挑');
  assert.match(r.detail, /winget v1\.8.*在位/);
  assert.equal(r.packageId, IN.EVERYTHING_PKG_ID);
  assert.equal(r.command, PinnedCommand);
  assert.equal(r.running, false);
  // 命令表逐字钉住：改这里就等于改「用户点确认时看到的到底是哪一条」
  assert.deepEqual([...IN.WINGET_ARGS], ['install', '--id', 'voidtools.Everything', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']);
});

await checkAsync('in-3 start 跑的就是 ready 回显的那一条：逐字参数表 + 非 shell + start 一个形参都没有', async () => {
  const w = inWorld();
  const snap = await w.inst.start();
  assert.equal(snap.phase, 'running');
  assert.equal(snap.job.command, PinnedCommand, '帧里的命令与 ready 回显的必须同一条');
  const c = w.lastInstall();
  assert.equal(c.b, 'winget');
  assert.deepEqual(c.args, ['install', '--id', 'voidtools.Everything', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements']);
  assert.equal(c.o.timeout, IN.WINGET_INSTALL_TIMEOUT_MS);
  assert.equal(c.o.windowsHide, true);
  assert.equal(c.o.shell, undefined, '非 shell：绝不把命令拼成字符串交给 cmd（参数表里有空格也不经 shell）');
  assert.equal(w.inst.start.length, 0, '形参个数 = 0：路由层转不进来任何东西（rt-42 证的是实参侧，这里证形参侧）');
  assert.equal(w.inst.state().job.packageId, IN.EVERYTHING_PKG_ID);
});

await checkAsync('in-4 一次只跑一装：在途期间的第二颗点击拒成 BUSY，且真的只起了一条 winget', async () => {
  const w = inWorld();
  await w.inst.start();
  w.advance(45_000);
  const err = await grab(() => w.inst.start());
  assert.equal(err && err.code, IN.INSTALL_ERROR.BUSY);
  assert.match(err.message, /已经有一装在进行中/);
  assert.match(err.message, /已跑 45 秒/, '要给出「跑了多久」，用户才知道不是在等死机');
  assert.equal(w.installCalls(), 1);
  assert.equal(w.inst.state().phase, 'running', '被拒的第二次不许把在途那装的状态改掉');
});

await checkAsync('in-5 装成功：running 与 done 各一帧、探针缓存作废、留痕进 logger.info', async () => {
  const w = inWorld();
  const frames = [];
  w.inst.onEvent((f) => frames.push(f));
  await w.inst.start();
  await w.okInstall({ stdout: '已找到 Everything\n已成功安装' });
  const s = w.inst.state();
  assert.equal(s.phase, 'done');
  assert.equal(s.job.exitCode, 0);
  assert.match(s.job.message, /正常退出（退出码 0）/);
  assert.ok(s.job.finishedAt >= s.job.startedAt);
  assert.deepEqual(frames.map((f) => f.phase), ['running', 'done'], '进度不靠界面轮询：两头各推一帧');
  assert.ok(frames.every((f) => f.type === 'search:install'));
  assert.equal(w.settleCalls(), 1, '装完要重探通路（probe.invalidate），否则按钮还挂着「未就绪」');
  assert.equal(w.infos.length, 2, '启动与完成各留一行 info');
});

await checkAsync('in-6 装失败：非 0 退出带出退出码与输出尾巴，缓存作废让下一次重探', async () => {
  const w = inWorld();
  const frames = [];
  w.inst.onEvent((f) => frames.push(f));
  await w.inst.start();
  await w.badInstall(Object.assign(new Error('winget 退出码 5'), { code: 5, stderr: 'Failed opening the requested file: 0x80070005 拒绝访问' }));
  const s = w.inst.state();
  assert.equal(s.phase, 'failed');
  assert.equal(s.job.exitCode, 5);
  assert.match(s.job.message, /winget 以非 0 退出（5）/);
  assert.match(s.job.outTail, /0x80070005/, '把看得懂的那一行留给界面，别让用户对着「失败」两个字猜');
  assert.deepEqual(frames.map((f) => f.phase), ['running', 'failed']);
  assert.equal(w.settleCalls(), 1);
  assert.ok(w.warns.length >= 1, '失败要 warn');
  const before = w.versionCalls();
  await w.inst.ready();
  assert.equal(w.versionCalls(), before + 1, '失败即作废探测结论：PATH 可能刚被用户改好');
});

await checkAsync('in-7 tailOutput：winget 的 \\r 进度条折成行、只留最后 12 行、总长封顶 2000', async () => {
  const many = Array.from({ length: 20 }, (_, i) => `L${i}`).join('\n');
  assert.equal(IN.tailOutput(many), Array.from({ length: 12 }, (_, i) => `L${i + 8}`).join('\n'));
  assert.doesNotMatch(IN.tailOutput('one\r\ntwo\rthree'), /\r/, '帧里不留 \r（原样进 SSE 会把界面进度条撑成一整行）');
  assert.equal(IN.tailOutput('  \n\n\t\n'), '', '全空输出就是空串，不是「undefined」');
  assert.equal(IN.tailOutput('x'.repeat(5000)).length, 2000);
  assert.equal(IN.tailOutput(null), '');
});

await checkAsync('in-8 探测结论带 TTL：期内不重探（每帧 spawn 一次 winget 是白烧），过期后必须重探', async () => {
  const w = inWorld();
  await w.inst.ready();
  await w.inst.ready();
  assert.equal(w.versionCalls(), 1);
  w.advance(IN.WINGET_DETECT_TTL_MS + 1);
  await w.inst.ready();
  assert.equal(w.versionCalls(), 2, 'App Installer 可能在这一段时间里被装上，缓存不能当永久结论');
});

await checkAsync('in-9 构造即拒（缺执行门面）与 idle 形状：装配漏接线不许悄悄变成「能装」', async () => {
  assert.throws(() => IN.createInstaller({ probe: null }), /需要 execFileMod/);
  assert.throws(() => IN.createInstaller(), /需要 execFileMod/);
  const w = inWorld();
  assert.deepEqual(w.inst.state(), { phase: 'idle', job: null }, '没起过安装就是 idle，界面据此不显示进度');
  assert.equal(w.execCalls.length, 0, '构造本身不许 spawn 任何进程');
  assert.deepEqual([...w.inst.PHASES], ['idle', 'running', 'done', 'failed'], '相位表就这四个，界面只按这四个出话');
});

await checkAsync('in-10 帧订阅：一个订阅者抛错不许吞掉别人的帧，退订要真的摘牌', async () => {
  const w = inWorld();
  const got = [];
  const off = w.inst.onEvent(() => { throw new Error('订阅者炸了'); });
  w.inst.onEvent((f) => got.push(f));
  await w.inst.start();
  assert.equal(got.length, 1, 'hub 里那一位抛错，这一位照收');
  assert.equal(w.warns.filter((m) => /订阅者抛错/.test(m)).length, 1);
  off();
  assert.equal(w.inst.__peek().listeners, 1);
  assert.equal(typeof w.inst.onEvent(null), 'function', '传错东西也别抛，退订函数照给');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
