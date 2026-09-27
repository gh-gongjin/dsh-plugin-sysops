/**
 * Task 12：`lib/clean/scanner.js` —— 只读遍历 + 进度 + 可停止。
 * 段①用假文件系统（零真 IO），只有 `cln-真机-1` 走真实 `%TEMP%`，可用 `SKIP_LOCAL=1` 跳过。
 */
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const skip = process.env.SKIP_LOCAL === '1';

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

const SC = await import('../lib/clean/scanner.js');

/** 假 FS：tree 是 { 绝对路径: {size?, children?: {名: {size, atimeMs, mtimeMs}}} }，扁平化更好写。 */
function fakeFs(entries, opts = {}) {
  // entries: [{ path, size, atimeMs, mtimeMs, dir? }]
  const map = new Map(entries.map((e) => [e.path.replace(/[\\/]+$/, ''), e]));
  const join = (...a) => a.join('/').replace(/\/+/g, '/');
  const denied = new Set(opts.denied ?? []);
  return {
    join,
    readdirSync(dir, { withFileTypes } = {}) {
      const key = dir.replace(/[\\/]+$/, '');
      if (denied.has(key)) throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' });
      const out = [];
      for (const [p, e] of map) {
        if (p === key || !p.startsWith(key + '/')) continue;
        const rest = p.slice(key.length + 1);
        if (!rest.includes('/')) {
          out.push({ name: rest, isDirectory: () => e.dir === true, isFile: () => e.dir !== true });
        } else if (!out.some((x) => x.name === rest.split('/')[0])) {
          const name = rest.split('/')[0];
          out.push({ name, isDirectory: () => true, isFile: () => false });
        }
      }
      if (!out.length && !map.has(key)) throw Object.assign(new Error('找不到路径'), { code: 'ENOENT' });
      return out;
    },
    statSync(p) {
      const key = p.replace(/[\\/]+$/, '');
      const e = map.get(key);
      if (!e) throw Object.assign(new Error('找不到路径'), { code: 'ENOENT' });
      if (denied.has(key)) throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' });
      return { size: e.size ?? 0, atimeMs: e.atimeMs ?? 0, mtimeMs: e.mtimeMs ?? 0, isFile: () => e.dir !== true, isDirectory: () => e.dir === true };
    },
    __map: map,
  };
}

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ago = (d) => NOW - d * DAY;

const rule = (over = {}) => ({
  id: 'temp-user', n: '用户临时目录', kind: '缓存', ageDays: 3, readonly: true,
  rel: 'AppData/Local/Temp', dir: 'C:/Users/gongj/AppData/Local/Temp', pattern: '*', ...over,
});

const tree = (over = {}) => ([
  { path: 'C:/Users/gongj/AppData/Local/Temp', dir: true },
  { path: 'C:/Users/gongj/AppData/Local/Temp/old.log', size: 1000, atimeMs: ago(10), mtimeMs: ago(10) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/fresh.log', size: 2000, atimeMs: ago(1), mtimeMs: ago(1) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir', dir: true },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir/a.bin', size: 4096, atimeMs: ago(20), mtimeMs: ago(20) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir/sub', dir: true, ...over.subDir },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir/sub/b.bin', size: 1024, atimeMs: ago(30), mtimeMs: ago(30) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/mixed', dir: true },
  { path: 'C:/Users/gongj/AppData/Local/Temp/mixed/x.bin', size: 10, atimeMs: ago(40), mtimeMs: ago(40) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/mixed/y.bin', size: 10, atimeMs: ago(2), mtimeMs: ago(2) },
]);

function world(entries, opts = {}) {
  const progress = [];
  const log = [];
  const sc = SC.createScanner({
    fsMod: fakeFs(entries, opts),
    now: opts.now ?? (() => NOW),
    logger: { warn: (m) => log.push(m) },
    onProgress: (p) => progress.push(p),
    ...opts.scanner,
  });
  return { sc, progress, log };
}

await checkAsync('cln-1 展开规则的三级取值：dir 原样 > glob 字面量前缀 > rel+home 兜底', () => {
  // 优先级链的每一级都要钉：内置库走第一级（Task 11 已展开好），本机规则只有 glob 走第二级，
  // 第三级是给"仓库外手写的规则形状"兜底（cln-真机-1 不走它，所以链必须在这里断全）。
  const builtin = SC.expandRule({ id: 'b', n: 'B', kind: '缓存', ageDays: 3, dir: 'C:/Users/gongj/AppData/Local/Temp', glob: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*', rel: '这条不该被用' }, {});
  assert.equal(builtin.dir, 'C:/Users/gongj/AppData/Local/Temp', '已展开好的 dir 不许被 rel 重算覆盖');
  assert.equal(builtin.pattern, '*');
  const user = SC.expandRule({ id: 'x', n: 'X', kind: '缓存', ageDays: 7, glob: 'C:\\Users\\gongj\\AppData\\Local\\npm-cache\\*' }, { home: 'C:\\Users\\gongj' });
  assert.equal(user.dir, 'C:\\Users\\gongj\\AppData\\Local\\npm-cache', '本机规则只有 glob：dir 由 glob 的字面量前缀推');
  assert.equal(user.pattern, '*');
  const rel = SC.expandRule({ id: 'y', n: 'Y', kind: '缓存', ageDays: 7, rel: 'AppData/Local/pip/Cache' }, { home: 'C:\\Users\\gongj' });
  assert.equal(rel.dir, 'C:\\Users\\gongj\\AppData\\Local\\pip\\Cache');
  assert.equal(rel.pattern, '*', '没有通配段时 pattern 兜成 *');
});

await checkAsync('cln-2 只有整条都够老才算候选（半新半旧不整删）', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule()]);
  const ids = res.items.map((i) => i.path.replace(/\\/g, '/'));
  assert.ok(ids.includes('C:/Users/gongj/AppData/Local/Temp/old.log'));
  assert.ok(ids.some((p) => p.endsWith('/olddir')), 'olddir 内全是 20~30 天前的，应命中');
  assert.ok(!ids.some((p) => p.endsWith('/mixed')), 'mixed 里有 2 天前的文件 → 整条不报');
  assert.ok(!ids.some((p) => p.endsWith('fresh.log')));
});

await checkAsync('cln-3 条目大小 = 递归求和，count = 文件数', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule()]);
  const olddir = res.items.find((i) => i.path.replace(/\\/g, '/').endsWith('/olddir'));
  assert.equal(olddir.size, 5120);
  assert.equal(olddir.count, 2);
  assert.equal(olddir.atime, ago(20), 'atime 取条目内最大值=最近一次动过（保守口径；原稿这里的 ago(30) 是 min，与 cln-2 的 mixed 断言互斥 —— 见 Ruling-69 C5）');
});

await checkAsync('cln-4 totals 与 items 一致；walked 统计所有 stat 过的条目', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule()]);
  assert.equal(res.totals.n, res.items.length);
  assert.equal(res.totals.bytes, res.items.reduce((a, b) => a + b.size, 0));
  assert.ok(res.walked >= 10, `walked=${res.walked}`);
});

await checkAsync('cln-5 拒绝访问的目录记进 skipped 且写日志，不静默', async () => {
  const w = world(tree(), { denied: ['C:/Users/gongj/AppData/Local/Temp/olddir/sub'] });
  const res = await w.sc.scan([rule()]);
  assert.ok(res.skipped.length >= 1);
  assert.equal(res.skipped[0].code, 'EPERM');
  assert.ok(w.log.length >= 1, '每个 catch 都要留下可见痕迹（spec §4.7）');
});

await checkAsync('cln-6 命中红线的规则目录直接跳过（第二道闸，不依赖扫描器自觉）', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule({ dir: 'C:\\Windows\\Temp', rel: undefined })]);
  assert.equal(res.items.length, 0);
  assert.ok(res.skipped.some((s) => /GUARD/.test(s.code)), `实际 skipped=${JSON.stringify(res.skipped)}`);
});

await checkAsync('cln-7 stop() 中途收手：stopped=true，已发现的部分仍然返回（可继续查看）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 50; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}.log`, size: 10, atimeMs: ago(9), mtimeMs: ago(9) });
  const w = world(entries);
  const p = w.sc.scan([rule()], { every: () => w.sc.stop() });
  const res = await p;
  assert.equal(res.stopped, true);
  assert.ok(res.items.length < 50, '真停住了，不是跑完才标 stopped');
});

await checkAsync('cln-8 onProgress 按时间片节流（1s 推 60 帧会把 SSE 挤爆）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 3000; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}`, size: 1, atimeMs: ago(9), mtimeMs: ago(9) });
  let t = NOW;
  const w = world(entries, { now: () => t, scanner: { progressIntervalMs: 1000 } });
  // 假时钟必须能推进：每条条目 +1ms ⇒ 3000 条走完是 3000ms，1000ms 一片 ⇒ 约 3 帧。
  // 冻结时钟下第一次 NOW-0>=1000 成立、之后 lastEmit=NOW 让 NOW-NOW=0>=1000 永假 ⇒ 恒 1 帧，
  // 于是"推一帧就死"的错实现也能过 >0 的下界（Ruling-69 C7）。下界提到 >=2 才是双向堵：
  // 不节流 = 3000 帧（红），只推一次 = 1 帧（红）。
  await w.sc.scan([rule()], { every: () => { t += 1; } });
  assert.ok(w.progress.length >= 2 && w.progress.length < 60, `进度帧数=${w.progress.length}，应远小于条目数且不止一帧`);
  assert.deepEqual(Object.keys(w.progress[0]).sort(), ['bytes', 'dir', 'hit', 'walked']);
});

await checkAsync('cln-9 maxEntries 触顶时 truncated=true 并写日志（把上限当成完整结果是不诚实）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 20; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}`, size: 1, atimeMs: ago(9), mtimeMs: ago(9) });
  const w = world(entries, { scanner: { maxEntries: 8 } });
  const res = await w.sc.scan([rule()]);
  assert.equal(res.truncated, true);
  assert.ok(w.log.some((m) => /截断|上限/.test(m)), '必须留下被截断的痕迹');
});

await checkAsync('cln-9b maxDepth 越深的目录不再下探，计入 skipped 而不是漏掉无声', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }, { path: 'C:/Users/gongj/AppData/Local/Temp/d', dir: true }, { path: 'C:/Users/gongj/AppData/Local/Temp/d/e', dir: true }, { path: 'C:/Users/gongj/AppData/Local/Temp/d/e/f.bin', size: 5, atimeMs: ago(90), mtimeMs: ago(90) }];
  const w = world(entries, { scanner: { maxDepth: 1 } });
  const res = await w.sc.scan([rule()]);
  assert.ok(res.skipped.some((s) => s.code === 'DEPTH'), JSON.stringify(res.skipped));
});

await checkAsync('cln-10 riskOf：浏览器/IM 缓存标 mid 并说明会被锁，转储类标 low', () => {
  assert.equal(SC.riskOf({ id: 'edge-cache', kind: '缓存' }).level, 'mid');
  assert.equal(SC.riskOf({ id: 'crash-dumps', kind: '崩溃转储' }).level, 'low');
  assert.ok(SC.riskOf({ id: 'edge-cache', kind: '缓存' }).why.length > 0);
});

await checkAsync('cln-真机-1 真遍历 %TEMP%：Task 11 的规则原样送进扫描器，walked>0', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { BUILTIN_RULES } = await import('../lib/clean/rules.js');
  const sc = SC.createScanner({
    fsMod: { readdirSync: fs.readdirSync, statSync: fs.statSync, join: path.join },
    now: () => Date.now(), logger: { warn() {} }, onProgress() {},
  });
  const temp = BUILTIN_RULES.find((r) => r.id === 'temp-user');
  assert.ok(temp, '内置库里没有 temp-user —— 这条真机例钉的就是 Task 11 → Task 12 的交接面');
  // **原样送，不再 expandRule 一遍、不把 glob 重拼成 rel+'/*'**（原稿那么写正好把 C1 的撞车藏掉了）。
  // ageDays 覆盖成 0 只为了保证有候选，不改 dir / glob。
  const r = await sc.scan([{ ...temp, ageDays: 0 }]);
  assert.ok(r.walked > 0, `本机 %TEMP% 遍历条目数为 0，说明假 FS 掩盖了真错：${JSON.stringify(r.skipped)}`);
  assert.equal(r.skipped.some((s) => /GUARD/.test(s.code)), false, 'Task 11 过了红线的规则，不该被扫描器的第二道闸拦住（两道闸的口径必须一致）');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
