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

// F-1（Ruling-77）的共用夹具：一个「第一层是目录」的候选，它内部更深的位置可以藏文件。
// X 用假 FS 的 join 口径（`/`），断言直接与 `item.path` / `skipped[].dir` 比对，不做反斜杠归一。
const X_OLDDIR = 'C:/Users/gongj/AppData/Local/Temp/olddir';

await checkAsync('cln-5 拒绝访问的目录记进 skipped 且写日志，不静默', async () => {
  const w = world(tree(), { denied: ['C:/Users/gongj/AppData/Local/Temp/olddir/sub'] });
  const res = await w.sc.scan([rule()]);
  assert.ok(res.skipped.length >= 1);
  assert.equal(res.skipped[0].code, 'EPERM');
  assert.ok(w.log.length >= 1, '每个 catch 都要留下可见痕迹（spec §4.7）');
});

await checkAsync('cln-5b 候选内部某个条目 stat 失败 ⇒ 整条不作样本（F-1：读不到就不知道它是不是新文件）', async () => {
  // secret.bin 是候选 olddir 内部的一个子项：只把它标成拒绝访问，olddir 的其余子项照样能读、
  // 也照样「够老」（a.bin 是 20 天前），所以漏掉它时 olddir 看着像「整条都够老」—— 这正是 F-1。
  const entries = tree().concat([
    { path: `${X_OLDDIR}/secret.bin`, size: 5, atimeMs: ago(5), mtimeMs: ago(5) },
  ]);
  const w = world(entries, { denied: [`${X_OLDDIR}/secret.bin`] });
  const res = await w.sc.scan([rule()]);
  assert.ok(
    res.skipped.some((s) => s.code === 'EPERM' && s.dir === `${X_OLDDIR}/secret.bin`),
    `stat 失败的子项要留在 skipped：${JSON.stringify(res.skipped)}`,
  );
  assert.equal(
    res.items.some((i) => i.path === X_OLDDIR),
    false,
    '这一条里有读不到的子项 ⇒ 本次不作为候选（不进删除清单）',
  );
  assert.equal(
    res.skipped.some((s) => s.code === 'INCOMPLETE' && s.dir === X_OLDDIR),
    true,
    '不完整要说得出原因，而不是悄悄空掉',
  );
});

await checkAsync('cln-6 命中红线的规则目录直接跳过（第二道闸，不依赖扫描器自觉）', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule({ dir: 'C:\\Windows\\Temp', rel: undefined })]);
  assert.equal(res.items.length, 0);
  assert.ok(res.skipped.some((s) => /GUARD/.test(s.code)), `实际 skipped=${JSON.stringify(res.skipped)}`);
});

await checkAsync('cln-7 stop() 中途收手：stopped=true，已发现的部分仍然返回（可继续查看）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 49; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}.log`, size: 10, atimeMs: ago(9), mtimeMs: ago(9) });
  // d 是第一层的**目录**候选，收手点选在它的子树里：d 已经累加到一个文件（count>0），
  // 但它的子目录 d/deep 还压在栈里没走（pending>0）—— 这就是 F-1 说的「半截候选」。
  entries.push({ path: 'C:/Users/gongj/AppData/Local/Temp/d', dir: true });
  entries.push({ path: 'C:/Users/gongj/AppData/Local/Temp/d/a.bin', size: 10, atimeMs: ago(9), mtimeMs: ago(9) });
  entries.push({ path: 'C:/Users/gongj/AppData/Local/Temp/d/deep', dir: true });
  entries.push({ path: 'C:/Users/gongj/AppData/Local/Temp/d/deep/x.bin', size: 10, atimeMs: ago(9), mtimeMs: ago(9) });
  const w = world(entries);
  // every() 的调用次序：49 个文件 + 目录 d 入栈 = 前 50 次；出栈进 d 后 a.bin 第 51 次；
  // d/deep 入栈第 52 次 ⇒ 在这里收手，d 正是「有 count 但子树没排空」的那一条。
  let ticks = 0;
  const res = await w.sc.scan([rule()], { every: () => { ticks += 1; if (ticks === 52) w.sc.stop(); } });
  assert.equal(res.stopped, true);
  // F-1：收手时子树没排空的候选不得带着半截 size/count/newest 进清单；已定稿的部分照样交回去。
  // 顺序有意为之：专属断言排在泛化的 items.length 之前，否则 W3（删掉 pending 判据）的红点
  // 会被 `length < 50` 顺手接住，pending 判据就从来没有在红态下自证过（复评测试强度评估）。
  assert.equal(
    res.items.some((i) => i.path === 'C:/Users/gongj/AppData/Local/Temp/d'),
    false,
    '中途收手时仍在栈里的候选不作样本',
  );
  assert.ok(res.items.length < 50, '真停住了，不是跑完才标 stopped');
  assert.equal(
    res.skipped.some((s) => s.code === 'INCOMPLETE' && s.dir === 'C:/Users/gongj/AppData/Local/Temp/d'),
    true,
    '被收手打断的候选要留下一条不完整记录',
  );
  assert.equal(res.items.some((i) => i.path === 'C:/Users/gongj/AppData/Local/Temp/f0.log'), true);
  // 对照（Ruling-79）：同一棵树、不收手 ⇒ d 走完子树本来就该进清单。
  // 缺这一句就分不清「是 pending 判据拦掉了它」还是「它本来就不进清单」，上面两条断言会是空证。
  const full = await world(entries).sc.scan([rule()]);
  assert.equal(
    full.items.some((i) => i.path === 'C:/Users/gongj/AppData/Local/Temp/d'),
    true,
    '对照：走完整个子树时这条本来就该进清单',
  );
  assert.equal(
    full.skipped.some((s) => s.code === 'INCOMPLETE'),
    false,
    `走完了就不该有不完整记录：${JSON.stringify(full.skipped)}`,
  );
});

await checkAsync('cln-7c 收手/触顶打断候选自己那一层的兄弟条目：半截视图一律不作样本（复评 F-R1）', async () => {
  // d 是**只装文件**的第一层目录：它的 pending 在出栈那一格就销回 0，此后正在遍历的目录里
  // 再没有节点压在栈上。收手若落在它的兄弟条目中间，旧判据（partial || pending>0）两头都不沾
  // ⇒ 半截 size/count/newest 无标记进 items（复评 F-R1 案例 A/B，Task 15 递归删会带走没看见的文件）。
  const D = 'C:/Users/gongj/AppData/Local/Temp/d';
  const mk = (freshLast) => [
    { path: 'C:/Users/gongj/AppData/Local/Temp', dir: true },
    { path: 'C:/Users/gongj/AppData/Local/Temp/f0.log', size: 10, atimeMs: ago(9), mtimeMs: ago(9) },
    { path: D, dir: true },
    { path: `${D}/a.bin`, size: 10, atimeMs: ago(9), mtimeMs: ago(9) },
    { path: `${D}/z.bin`, size: 999, atimeMs: ago(freshLast ? 1 : 9), mtimeMs: ago(freshLast ? 1 : 9) },
  ];
  // 每条目一次 every 回调：f0.log 第 1 次、d 入栈第 2 次、d 出栈后 a.bin 第 3 次。
  // 在第 3 次收手 ⇒ a.bin 已累加（count>0，所以定稿循环不会因 count<1 先跳过它），z.bin 从未被访问。
  const TICK = 3;

  const runStop = async (freshLast) => {
    const w = world(mk(freshLast));
    let ticks = 0;
    return w.sc.scan([rule()], { every: () => { ticks += 1; if (ticks === TICK) w.sc.stop(); } });
  };
  const stopped = await runStop(true);
  assert.equal(stopped.stopped, true, '收手桩本身要生效');
  assert.equal(stopped.items.some((i) => i.path === D), false, '打断在自己目录中间的候选不作样本');
  assert.equal(
    stopped.skipped.some((s) => s.code === 'INCOMPLETE' && s.dir === D),
    true,
    `被拦下要留下指向该条的记录：${JSON.stringify(stopped.skipped)}`,
  );
  // 已走完的部分照样交回去（拦这一条不能把整次扫描判废）。
  assert.equal(stopped.items.some((i) => i.path === 'C:/Users/gongj/AppData/Local/Temp/f0.log'), true);

  // 取证方向 1（危害对照）：同一棵树走完 ⇒ d 本来**不该**进清单（z.bin 是昨天的，被 newest 抓到）。
  // 所以上面那条 item 不是"少报一条"，而是把完整遍历本会拒绝的目录报成了可删 —— F-1 的原始形状。
  const walkedFull = await world(mk(true)).sc.scan([rule()]);
  assert.equal(walkedFull.items.some((i) => i.path === D), false, '对照：走完时这条因含新文件而不进清单');
  assert.equal(walkedFull.skipped.some((s) => s.code === 'INCOMPLETE'), false);

  // 取证方向 2（防空证）：同一棵树、把 z.bin 也改成够老、并且不收手 ⇒ d 正常进清单且零 INCOMPLETE。
  // 缺这一格就分不清"拦下它"是判据起作用还是夹具本来就不报目录。
  const reportable = await world(mk(false)).sc.scan([rule()]);
  assert.equal(reportable.items.some((i) => i.path === D), true, '对照：整条都够老且走完时这条该进清单');
  assert.equal(reportable.skipped.some((s) => s.code === 'INCOMPLETE'), false);
  // 收手发生在「自己那一层」才是本用例的靶子：不打断时这条树必须能进清单（上面两格合起来钉死）。
  const stoppedOnOld = await runStop(false);
  assert.equal(stoppedOnOld.items.some((i) => i.path === D), false, '即使整条都够老，没走完就不报（保守方向）');

  // 另一条收手来源（maxEntries 触顶）走的是同一个 break：规则目录自身也计数
  // ⇒ walked 依次为 1(规则目录)、2(f0.log)、3(d)、4(a.bin)，上限设 4 就正好打断在 a.bin 之后。
  const truncatedRun = await world(mk(true), { scanner: { maxEntries: 4 } }).sc.scan([rule()]);
  assert.equal(truncatedRun.truncated, true, '上限桩本身要生效');
  assert.equal(truncatedRun.items.some((i) => i.path === D), false, '触顶打断同一格时同样不作样本');
  assert.equal(
    truncatedRun.skipped.some((s) => s.code === 'INCOMPLETE' && s.dir === D),
    true,
    `触顶拦下也要留记录：${JSON.stringify(truncatedRun.skipped)}`,
  );

  // pending 判据的专属证人：收手发生在**进度回调**里（`emit` 在 `:253` 的检查之后才跑），
  // 于是候选自己那一层是「正常走完」的、break 补标轮不到它，只有栈里那个没弹出的子目录（pending=1）
  // 说明它没走完 —— 删掉 `|| pending > 0` 只有这一格会红（变异 W3），所以它不是摆设。
  const PD = 'C:/Users/gongj/AppData/Local/Temp/p';
  const pTree = [
    { path: 'C:/Users/gongj/AppData/Local/Temp', dir: true },
    { path: PD, dir: true },
    { path: `${PD}/a.bin`, size: 10, atimeMs: ago(9), mtimeMs: ago(9) },
    { path: `${PD}/sub`, dir: true },
    { path: `${PD}/sub/x.bin`, size: 10, atimeMs: ago(9), mtimeMs: ago(9) },
  ];
  let emits = 0;
  const wp = world(pTree, { scanner: { progressIntervalMs: 0, onProgress: () => { emits += 1; if (emits === 3) wp.sc.stop(); } } });
  const pend = await wp.sc.scan([rule()]);
  assert.equal(pend.stopped, true, '进度回调里的收手要生效');
  assert.equal(pend.items.some((i) => i.path === PD), false, '自己目录走完、但子目录还压在栈里的候选不作样本');
  assert.equal(
    pend.skipped.some((s) => s.code === 'INCOMPLETE' && s.dir === PD),
    true,
    `栈账拦下也要留记录：${JSON.stringify(pend.skipped)}`,
  );
  // 同一棵树不收手 ⇒ p 整条都够老、正常进清单（否则上面两句又是空证）。
  const pendFull = await world(pTree).sc.scan([rule()]);
  assert.equal(pendFull.items.some((i) => i.path === PD), true, '对照：走完时这条该进清单');
  assert.equal(pendFull.skipped.some((s) => s.code === 'INCOMPLETE'), false);
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

await checkAsync('cln-9c 深度截断的子树 ⇒ 父目录本次不作候选（F-1 的主证：没走完不得当「整条都够老」）', async () => {
  // olddir 的第一层子项 a.bin 是 20 天前（够老），更深的 sub 里藏一个**昨天**的 fresh.bin。
  // maxDepth=2 时 sub 不被下探 ⇒ fresh.bin 进不了 newest，olddir 看着像「整条都够老」，
  // 而 Task 15 的 delete-dir 会对它 recursive 整删 —— 清单之外的文件被删掉是本插件最重的红线。
  const entries = [
    { path: 'C:/Users/gongj/AppData/Local/Temp', dir: true },
    { path: X_OLDDIR, dir: true },
    { path: `${X_OLDDIR}/a.bin`, size: 4096, atimeMs: ago(20), mtimeMs: ago(20) },
    { path: `${X_OLDDIR}/sub`, dir: true },
    { path: `${X_OLDDIR}/sub/fresh.bin`, size: 100, atimeMs: ago(1), mtimeMs: ago(1) },
  ];
  const cut = await world(entries, { scanner: { maxDepth: 2 } }).sc.scan([rule()]);
  assert.equal(
    cut.items.some((i) => i.path === X_OLDDIR),
    false,
    '深度截断 ⇒ 这一条没走完，本次不作为候选',
  );
  assert.ok(cut.skipped.some((s) => s.code === 'DEPTH'), `应有 DEPTH 记录：${JSON.stringify(cut.skipped)}`);
  assert.ok(cut.skipped.some((s) => s.code === 'INCOMPLETE' && s.dir === X_OLDDIR), '应有父候选的 INCOMPLETE 记录');
  // 对照：同一棵树把 maxDepth 放到够深 ⇒ 走完整个子树，昨天的 fresh.bin 被 newest 抓到，
  // 这条同样不进清单（两个方向合起来才钉住判据是「走完 + 够老」，不是「没走完就当它老」）。
  const w = world(entries);
  const full = await w.sc.scan([rule()]);
  assert.equal(
    full.items.some((i) => i.path === X_OLDDIR),
    false,
    '走完并发现新文件 ⇒ 按 newest 过龄判定，同样不进清单',
  );
  assert.equal(
    full.skipped.some((s) => s.code === 'INCOMPLETE'),
    false,
    '走完了就不该有不完整记录：' + JSON.stringify(full.skipped),
  );
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

/* ②段：清单快照与执行留痕 */
const { recordsDomain, PLAN_KEEP, LOG_KEEP } = await import('../lib/records/spec.js');
const { createPlanStore } = await import('../lib/clean/plan-store.js');
const { createLogStore, RECORDS_ERROR } = await import('../lib/clean/log-store.js');
const { createMemoryFacility } = await import('./_helpers.mjs');

// ①段只有 checkAsync；简报的 rec-1/rec-2 是同步断言，这里做一层薄包装复用同一套计数与失败打印。
const check = (name, fn) => checkAsync(name, async () => fn());

// 形状必须是 Task 12 扫描器的**真产物**：risk 是嵌套的 {level, why}。
// 扁平的 riskLevel/riskWhy 是 plan-store 投影**之后**的样子（Ruling-71 T13-A）——
// 夹具若直接写扁平，「save 不拍平 ⇒ 每条快照写入抛 RECORDS_INVALID」这个缺陷永远测不到。
const itemFixture = (over = {}) => ({
  id: 'temp-user-aG9tZQ', ruleId: 'temp-user', ruleName: '用户临时目录', kind: '缓存',
  path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log', size: 1000, count: 1,
  atime: 1, mtime: 1, risk: { level: 'mid', why: '应用可能锁文件' }, ...over,
});

function recWorld(over = {}) {
  // 判键不判值（同 `test/alerts.test.mjs` 的 mkStore）：`recWorld({ facility: undefined })`
  // 要的就是"宿主没给 storageDomain"，写成三元判断会把"没设施"当成"默认给一个"。
  const facility = 'facility' in over ? over.facility : createMemoryFacility();
  let n = 0;
  // 时钟必须会走（Ruling-71 T13-B）：冻结在 5000 时「按 at 数值升序」与「按 planId 字典序」
  // 删掉的是同一条，rec-5 证不出裁剪究竟看了哪个字段。
  const planStore = createPlanStore({ getFacility: () => facility, logger: { warn() {} }, now: (() => { let at = 4000; return () => (at += 1000); })(), newId: () => `p-${++n}` });
  const logStore = createLogStore({ getFacility: () => facility, logger: { warn() {} }, now: over.logNow ?? (() => 6000) });
  return { facility, planStore, logStore, n: () => n };
}

const scanFixture = (items = [itemFixture()]) => ({
  items, totals: { n: items.length, bytes: items.reduce((a, b) => a + b.size, 0) },
  walked: 100, hit: items.length, skipped: [], stopped: false, truncated: false, at: 5000,
});

// rec-2 直接喂 schema，喂的必须是**投影之后**的扁平形状（`clean_plan.items[]` 声明的是
// riskLevel/riskWhy，Ruling-71 T13-A）；嵌套 risk 是 save 的输入，由 rec-3 覆盖。
const flatItemFixture = (over = {}) => {
  const { risk, ...rest } = itemFixture(over);
  return { ...rest, riskLevel: risk.level, riskWhy: risk.why };
};

check('rec-1 records 域三张表，domain 名不变（已有落盘数据）', () => {
  assert.equal(recordsDomain.name, 'sysops_records');
  assert.deepEqual(Object.keys(recordsDomain.tables).sort(), ['alert_hit', 'clean_log', 'clean_plan']);
});

check('rec-2 clean_plan schema：riskWhy 可缺，path 必须是字符串', () => {
  const t = recordsDomain.tables.clean_plan.valueSchema;
  assert.doesNotThrow(() => t.parse({ planId: 'p-1', at: 1, beforeFree: 1, modeDefault: 'delete-file', rulesUsed: [], items: [{ ...flatItemFixture(), riskWhy: undefined }], totals: { n: 1, bytes: 1 } }));
  assert.throws(() => t.parse({ planId: 'p-1', at: 1, beforeFree: 1, modeDefault: 'delete-file', rulesUsed: [], items: [{ ...flatItemFixture(), path: 123 }], totals: { n: 1, bytes: 1 } }), /path/);
  // `arrayOf(..., { required: true })` 也是声明面的一部分（复评 F-1 同族）：少了这个标志，
  // `items` 传 undefined 会安静落成"没有清单的清单快照"，Task 15 执行器拿不到条目却不知道出了什么事。
  assert.throws(() => t.parse({ planId: 'p-1', at: 1, beforeFree: 1, modeDefault: 'delete-file', rulesUsed: [], totals: { n: 0, bytes: 0 } }), /items/,
    'items 必填：连条清单都没有的快照不许落库');
});

await checkAsync('rec-3 save 冻结快照：读回的路径与条数与扫描结果逐字一致', async () => {
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 70 * 2 ** 30, modeDefault: 'delete-file' });
  assert.equal(plan.items.length, 1);
  const back = await w.planStore.get(plan.planId);
  assert.equal(back.items[0].path, 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log');
  assert.equal(back.beforeFree, 70 * 2 ** 30);
  assert.equal(back.rulesUsed.length, 1, 'rulesUsed 由 items 反推，界面「命中规则」列要用');
  // 投影必须真的发生：写进去的是嵌套 risk，读回来必须是扁平名（Task 15/22 只认扁平名）
  assert.equal(back.items[0].riskLevel, 'mid', 'save 没把嵌套 risk 拍平 ⇒ 读回来根本没有这个字段');
  assert.equal(back.items[0].riskWhy, '应用可能锁文件');
  assert.equal('risk' in back.items[0], false, 'record() 静默丢弃未声明字段，读回来不该再有 risk');
  // F-1：上面几条判的是「值对了」，这三条判的是「一个字段都没漏声明」。
  // `record()` / `arrayOf` 是白名单语义 —— 少声明一个键不会报错，只会让那一列在读回来时
  // 安静地不存在，界面拿到 undefined。μ1-μ8 删掉任意一条上游字段声明时必须撞红这里。
  const expectItemKeys = Object.keys(itemFixture())
    .filter((k) => k !== 'risk')
    .concat(['riskLevel', 'riskWhy'])
    .sort();
  assert.deepEqual(Object.keys(back.items[0]).sort(), expectItemKeys,
    `items[] 声明面必须覆盖扫描器全部 ${expectItemKeys.length} 个字段（漏一个就是静默丢数据）`);
  assert.deepEqual(Object.keys(back.rulesUsed[0]).sort(), ['id', 'kind', 'n'],
    'rulesUsed 三键都要声明，少一个「命中规则」列就空一半');
  assert.deepEqual(Object.keys(back.totals).sort(), ['bytes', 'n'],
    'totals 两键都要声明，可回收字节数靠它');
});

await checkAsync('rec-4 快照 append-only：同 planId 再写必须抛（清单不可被改写）', async () => {
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  await assert.rejects(
    () => w.planStore.save({ ...scanFixture(), items: [] }, { beforeFree: 1, modeDefault: 'delete-file', planId: plan.planId }),
    (e) => e.code === RECORDS_ERROR.DUPLICATE,
  );
});

await checkAsync('rec-5 快照只留最近 20 段，第 21 段挤掉最旧', async () => {
  const w = recWorld();
  // F-2：id 必须与时间**脱钩**。原夹具是 `p-1..p-21` 配递增 `at`，而 `p-1` 恰好既是字典序最小
  // 也是时间最旧 —— 把 trim 的比较器改回 `String(key).localeCompare` 照样全绿（复评 μ 组 N1）。
  // 这里按**字典序递减**发号（p-u 最早 … p-a 最新）：一旦按 key 排，被裁掉的就是最新的 `p-a`。
  const ids = Array.from({ length: 21 }, (_, i) => `p-${String.fromCharCode(117 - i)}`);
  for (const [i, planId] of ids.entries()) {
    await w.planStore.save(scanFixture(), { beforeFree: i, modeDefault: 'delete-file', planId });
  }
  const list = await w.planStore.list({ limit: 50 });
  assert.equal(list.length, PLAN_KEEP);
  // list() 是**时间倒序**（与 hits() 同契约，alert-13 已把「倒序是 store 的契约」钉死）：
  // 原稿在这里断 list[0] === ids[1]，把自家契约写反了 —— 见 Ruling-71 T13-E。
  assert.equal(list[0].planId, ids[20], '倒序：第一条必须是最新的 p-a（按 key 排的话它已经被裁掉了）');
  assert.equal(list[PLAN_KEEP - 1].planId, ids[1], '倒序：末条是剩余 20 条里最旧的 p-t');
  assert.equal(await w.planStore.get(ids[0]), null, '最旧的 p-u 必须已被挤掉（这才是「裁最旧」的直接证据）');
});

await checkAsync('rec-6 log.start 立刻落一条 running 记录（中断后能查出「未确认完成」）', async () => {
  const w = recWorld();
  const log = await w.logStore.start({ planId: 'p-1', itemIds: ['a'], mode: 'delete-file' });
  assert.equal(log.finishedAt, undefined);
  assert.equal((await w.logStore.unfinished()).length, 1);
});

await checkAsync('rec-7 finish 补齐三档计数并写 afterFree；重复 finish 只保留第一次的完成时间', async () => {
  const w = recWorld();
  const log = await w.logStore.start({ planId: 'p-1', itemIds: ['a', 'b'], mode: 'delete-file' });
  const done = await w.logStore.finish(log.logId, { ok: 1, skipped: 1, failed: 0, rejected: 0, bytesFreed: 512, afterFree: 71 * 2 ** 30 });
  assert.equal(done.ok, 1);
  assert.equal(done.finishedAt, 6000);
  assert.equal((await w.logStore.unfinished()).length, 0);
  const again = await w.logStore.finish(log.logId, { ok: 9, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1, afterFree: 1 });
  assert.equal(again.ok, 1, '留痕不能被第二次 finish 改写（append-only 语义）');
});

await checkAsync('rec-8 log 缺失 logId 报 NOT_FOUND；无 facility 报 UNAVAILABLE', async () => {
  const w = recWorld();
  await assert.rejects(() => w.logStore.finish('nope', { ok: 0, skipped: 0, failed: 0, rejected: 0, bytesFreed: 0, afterFree: 0 }), (e) => e.code === RECORDS_ERROR.NOT_FOUND);
  const v = recWorld({ facility: undefined });
  assert.equal(v.planStore.available, false);
  await assert.rejects(() => v.logStore.start({ planId: 'p', itemIds: [], mode: 'delete-file' }), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

await checkAsync('rec-9 close() 可 await；close 后写报 CLOSED；跨 open 快照仍在', async () => {
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  await w.planStore.close();
  await assert.rejects(() => w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' }), (e) => e.code === RECORDS_ERROR.CLOSED);
  const w2 = recWorld({ facility: w.facility });
  assert.equal((await w2.planStore.get(plan.planId)).planId, plan.planId);
});

await checkAsync('rec-10 同一设施上多个仓储共用一个域：各自读写都可用，关一个不带走别人', async () => {
  // Ruling-71 T13-D：sysops_records 里有三张表 = 三个 open 者（alert_hit 的 Task 9 仓储 + 本任务的两个），
  // 而宿主契约写明「domain 名是排他的，重复 open 报 already-open」。没有登记表，Task 19 装配现场必炸。
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  const log = await w.logStore.start({ planId: plan.planId, itemIds: ['a'], mode: 'delete-file' });
  assert.equal(plan.planId, 'p-1', 'planStore 先 open 并持有域');
  assert.equal(typeof log.logId, 'string', 'logStore 复用的是登记表里那个 handle —— 它若自己 open 会在这里抛 UNAVAILABLE');
  assert.equal((await w.logStore.unfinished()).length, 1);
  assert.equal((await w.planStore.get(plan.planId)).planId, plan.planId, '两个仓储各自读写，互不干扰');
  // 引用计数：还剩 logStore 持有，域必须活着 ⇒ planStore 自己进终态，但不许把域一起关掉
  await w.planStore.close();
  await assert.rejects(() => w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' }),
    (e) => e.code === RECORDS_ERROR.CLOSED, 'close 是该仓储的终态，与域是否关闭无关');
  const done = await w.logStore.finish(log.logId, { ok: 1, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1, afterFree: 2 });
  assert.equal(done.ok, 1, 'planStore 关了不许把域关掉，否则这里报 UNAVAILABLE');
  // 最后一个持有者关掉后名字释放：新实例复用同一设施能重新 open，且读到旧行
  await w.logStore.close();
  // 关闭侧也要有证据：这里换一层"只计数不改语义"的设施 —— 登记表里若没有真的 handle.close()
  // （refs 降到 0 却没关域），下面这次 open 会撞 already-open（Ruling-71 T13-D 的关闭侧）。
  let opens = 0;
  const counting = { open: (d) => { opens += 1; return w.facility.open(d); } };
  const w3 = recWorld({ facility: counting });
  assert.equal((await w3.planStore.get(plan.planId)).planId, plan.planId, '关干净后重开，数据必须还在（介质权威）');
  assert.equal(opens, 1, '最后一个持有者放手时必须真的关域 —— 否则域名字永远被占着');
});

await checkAsync('rec-11 留痕裁到 LOG_KEEP 条：挤掉的是数值最旧那条，不是 key 字典序最小那条', async () => {
  // F-5：`LOG_KEEP` 的删除分支此前零证人 —— 只写过 1 条 start，`rows.length <= LOG_KEEP` 直接 return。
  // 时钟故意从 4 位跨到 5 位（`l-9999-…` 是最旧的，字典序却是**最大**的）：
  // 比较器若改成 `String(a.key).localeCompare(...)`，被删的就是次旧的 `l-10003-…`，这里必红。
  let tick = 0;
  const w = recWorld({ logNow: () => (tick += 1) === 1 ? 9999 : 10000 + tick });
  const first = await w.logStore.start({ planId: 'p-1', itemIds: ['a'], mode: 'delete-file' });
  assert.equal(first.startedAt, 10002, '夹具自证：第一条的 startedAt 必须是 4 位→5 位跨界后的首个值');
  let last;
  for (let i = 0; i < LOG_KEEP; i++) {
    last = await w.logStore.start({ planId: `p-${i}`, itemIds: ['a'], mode: 'delete-file' });
  }
  const rows = await w.logStore.list({ limit: 500 });
  assert.equal(rows.length, LOG_KEEP, `上限 ${LOG_KEEP} 条，多一条都得裁`);
  assert.ok(!rows.some((r) => r.logId === first.logId), '字典序最大但时间最旧的那条必须被挤掉');
  assert.equal(rows[0].logId, last.logId, '最新一条必须留着，且排在倒序首位');
});

await checkAsync('rec-12 关域窗口里的新持有者：等别人关完再重新 open，不许撞 already-open', async () => {
  // F-3：登记表若在 `handle.close()` 完成**之前**摘牌，此刻另一仓储首写会自己发一发 open，
  // 撞上尚未释放的域名 ⇒ 无辜的 `logStore` 拿到 SYSOPS_RECORDS_UNAVAILABLE（复评 S3）。
  const facility = createMemoryFacility({ closeDelayMs: 40 });
  const w = recWorld({ facility });
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  const closing = w.planStore.close(); // 故意不 await：要的就是"关闭进行中"那段窗口
  const log = await w.logStore.start({ planId: plan.planId, itemIds: ['a'], mode: 'delete-file' });
  assert.equal(typeof log.logId, 'string', 'planStore 正在关域时，logStore 的首写必须成功');
  await closing;
  await w.logStore.close();
  assert.deepEqual(facility.stats, { opens: 2, closes: 2 }, '必须串行：先等旧域关完，再开新域');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
