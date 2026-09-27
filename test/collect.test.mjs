import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;

function check(name, fn) {
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

/* ①段：ring 边界 */
const { createRing } = await import('../lib/collect/ring.js');

const clock = () => { let t = 0; return { now: () => t, advance: (ms) => { t += ms; } }; };

check('ring-1 时间窗与条数双上限，先到先裁', () => {
  const c = clock();
  const r = createRing({ windowMs: 1000, maxPoints: 3, now: c.now });
  // `t` 必须是**数值**：`c.now` 是函数引用，`Number.isFinite(point.t)` 会把它判成脏点，
  // 三条上限里的那条"乱序/脏值丢弃"会让本例一个点都存不进去。
  for (let i = 0; i < 3; i++) { c.advance(100); r.push({ t: c.now(), v: i }); }
  assert.equal(r.series().length, 3);
  c.advance(100);
  r.push({ t: c.now(), v: 9 });          // 第 4 点：条数上限裁掉最老
  assert.equal(r.series()[0].v, 1);
  c.advance(5000);
  r.push({ t: c.now(), v: 10 });          // 时间窗外全部过期
  // 时间线：100/200/300 → 400 → 5400。末次 now() 是 5400，不是 5600。
  assert.deepEqual(r.series(), [{ t: 5400, v: 10 }]);
});

check('ring-2 乱序点丢弃并计数（一个倒着走的点会把曲线拉出假尖峰）', () => {
  const r = createRing({ windowMs: 1e6, maxPoints: 10, now: () => 1000 });
  r.push({ t: 3000, v: 1 });
  assert.equal(r.push({ t: 2000, v: 2 }), 'stale');
  assert.equal(r.stats().droppedStale, 1);
  assert.equal(r.series().length, 1);
});

check('ring-3 脏值（NaN / Infinity / 负 / >100 的百分比）拒收并单独计数', () => {
  const r = createRing({ windowMs: 1e6, maxPoints: 10, now: () => 1000, percent: true });
  assert.equal(r.push({ t: 1000, v: NaN }), 'bad');
  assert.equal(r.push({ t: 1001, v: Infinity }), 'bad');
  assert.equal(r.push({ t: 1002, v: -3 }), 'bad');
  assert.equal(r.push({ t: 1003, v: 120 }), 'bad');
  assert.equal(r.push({ t: 1004, v: 88 }), 'ok');
  assert.equal(r.stats().droppedBad, 4);
  assert.deepEqual(r.series(), [{ t: 1004, v: 88 }]);
});

check('ring-4 series(from,to) 取区间；latest 取末点', () => {
  const r = createRing({ windowMs: 1e9, maxPoints: 10, now: () => 0 });
  [1, 2, 3, 4, 5].forEach((t, i) => r.push({ t: t * 100, v: i }));
  assert.deepEqual(r.series(200, 400).map((p) => p.v), [1, 2, 3]);
  assert.deepEqual(r.latest(), { t: 500, v: 4 });
});

/* ②段：L0 纯 Node 采样 */
const { computeCpuPct, computeMemPct, createL0 } = await import('../lib/collect/l0-node.js');

const cpu = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

check('l0-1 CPU 用差值算，不是瞬时值', () => {
  // 两次样本的**总 ticks 必须增长**：`(10,90)→(30,70)` 总量恒定 100，`totalDelta` 是 0，
  // 那是"CPU 计数器没动"的脏状态（NaN），不是 50%。这里让总增量 40、忙增量 20。
  const pct = computeCpuPct([cpu(10, 90)], [cpu(30, 110)]);   // 忙 +20 / 总 +40 → 50%
  assert.equal(pct, 50);
});

check('l0-2 多核平均；无上一次样本时返回 NaN（ring 会丢并计数）', () => {
  // 核 1：忙 +30 / 总 +40 = 75%；核 2：忙 +30 / 总 +60 = 50%。
  // 按总 ticks 加权是 60/100 = 60%，百分比算术平均是 62.5% —— 断 60 才能钉住"加权"口径。
  assert.equal(computeCpuPct([cpu(10, 90), cpu(50, 50)], [cpu(40, 100), cpu(80, 80)]), 60);
  assert.ok(Number.isNaN(computeCpuPct(null, [cpu(1, 1)])));
  assert.ok(Number.isNaN(computeCpuPct([cpu(10, 90)], [cpu(10, 90)])), '忙闲增量都为 0 时是 0/0，必须当脏值');
});

check('l0-3 内存占用率', () => {
  assert.equal(computeMemPct(16 * 1024 ** 3, 4 * 1024 ** 3), 75);
  assert.ok(Number.isNaN(computeMemPct(0, 0)));
});

check('l0-4 read() 交出字节口径的磁盘与百分数口径的 cpu/mem', () => {
  let n = 0;
  const osMod = {
    // 第二次样本总 ticks 从 100 涨到 120、idle 不涨 → 满负荷 100%。
    // 原先写的 `(20,80)` 总量仍是 100，落到 `totalDelta <= 0` 分支变 NaN。
    cpus: () => (n++ === 0 ? [cpu(10, 90)] : [cpu(30, 90)]),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
  };
  const fsMod = { statfsSync: () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 400 }) };
  const l0 = createL0({ osMod, fsMod, drive: 'C:', now: () => 5000 });
  assert.ok(Number.isNaN(l0.read().cpu), '第一次没有差值基线');
  const p = l0.read();
  assert.deepEqual(p, { t: 5000, cpu: 100, mem: 50, diskFree: 400 * 4096, diskTotal: 1000 * 4096 });
});

check('l0-5 statfsSync 抛错（盘符不存在）时 read 抛出并带盘符名，不返回凑数 0', () => {
  const l0 = createL0({
    osMod: { cpus: () => [cpu(0, 0)], totalmem: 1, freemem: 1 },
    fsMod: { statfsSync: () => { throw new Error('ENOENT'); } },
    drive: 'Z:',
  });
  assert.throws(() => l0.read(), /Z:/);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
