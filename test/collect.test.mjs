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

/* ③段：supervisor 状态机 */
const { createSupervisor, SUP_STATE, BACKOFF_MS, MAX_RESTARTS, KILL_ARGS } = await import('../lib/collect/supervisor.js');
const { EventEmitter } = await import('node:events');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { end() {}, write() {} };
  }
}

/** 假环境：手工推进时钟与定时器，退避序列才可断言。 */
function harness() {
  let t = 0;
  let nextPid = 1000;
  const timers = [];
  const kids = [];
  const kills = [];
  const changes = [];
  const sup = createSupervisor({
    spawnFn: (cmd, args, opts) => { const c = new FakeChild(nextPid++); kids.push({ c, cmd, args, opts }); return c; },
    killFn: (pid) => { kills.push(pid); },
    now: () => t,
    setTimeoutFn: (fn, ms) => { const h = { fn, ms, done: false }; timers.push(h); return h; },
    clearTimeoutFn: (h) => { if (h) h.done = true; },
    onChange: (key, s) => changes.push({ key, state: s.state }),
    logger: { warn() {}, info() {} },
  });
  const fire = () => { // 执行所有已排队的定时器（一次一个，便于断言次数）
    const h = timers.find((x) => !x.done);
    if (!h) throw new Error('没有待触发的定时器');
    h.done = true;
    h.fn();
  };
  // `timers` / `pending` 必须暴露给用例：退避序列（sup-3）与"dispose 后无活定时器"（sup-10）
  // 只能从定时器本身读，否则断言就退化成只数长度。
  return { sup, t: () => t, adv: (ms) => { t += ms; }, kids, kills, changes, fire, timers, pending: () => timers.find((x) => !x.done), lastKid: () => kids[kids.length - 1] };
}

check('sup-1 start 进 starting，首块 stdout 后转 on 并刷心跳', () => {
  const h = harness();
  const lines = [];
  h.sup.start('l1a', { label: '网络', cmd: 'typeperf', args: [], intervalMs: 1000, onData: (b) => lines.push(b) });
  assert.equal(h.sup.state('l1a').state, SUP_STATE.STARTING);
  h.lastKid().c.stdout.emit('data', Buffer.from('x\n'));
  const s = h.sup.state('l1a');
  assert.equal(s.state, SUP_STATE.ON);
  assert.equal(s.pid, 1000);
  // 行框定与"交出 Buffer"是 Task 6 的全部前提：typeperf 一行会被拆到多个 stdout 块里，
  // 而 GBK 只能在**字节**上还原 —— 这里若先 toString('latin1')，下游就再也解不出中文计数器名。
  h.lastKid().c.stdout.emit('data', Buffer.from('ab'));
  assert.deepEqual(lines.map((b) => b.toString('latin1')), ['x'], '没遇到换行前不该交出半行');
  h.lastKid().c.stdout.emit('data', Buffer.from('cd\r\nef'));
  assert.equal(Buffer.isBuffer(lines[1]), true, 'onData 必须交出 Buffer，不许在监督者里解码');
  assert.equal(lines[1].toString('latin1'), 'abcd', '跨块要拼成完整一行，并去掉行尾 \\r\\n');
  // 心跳刷点：假时钟起点就是 0，`lastTick >= 0` 是永真式；推进时钟再吐一块才真断得动。
  // 这一块只送来一个换行 —— 顺带钉住"上一块剩下的 `ef` 要等到行边界才被交出"。
  h.adv(1500);
  h.lastKid().c.stdout.emit('data', Buffer.from('\n'));
  assert.equal(h.sup.state('l1a').lastTick, 1500, '每块 stdout 都要刷 lastTick，否则心跳会误杀');
  assert.deepEqual(lines.map((b) => b.toString('latin1')), ['x', 'abcd', 'ef'], '交出顺序与内容要一路可追');
});

check('sup-2 非主动退出每次都进 crashed 并排一次重启，第 6 次失败进 exited-max 且不再自动重启（退避时长序列由 sup-3 断）', () => {
  const h = harness();
  h.sup.start('l1b', { label: '进程', cmd: 'powershell', args: [], intervalMs: 3000, onData() {} });
  for (let i = 0; i < MAX_RESTARTS; i += 1) {
    h.lastKid().c.emit('exit', 1, null);
    assert.equal(h.sup.state('l1b').state, SUP_STATE.CRASHED, `第 ${i + 1} 次退出应为 crashed`);
    assert.equal(h.kills.length, 0, '非主动退出不该再 kill');
    h.fire(); // 触发退避定时器
    assert.equal(h.sup.state('l1b').state, SUP_STATE.STARTING);
  }
  h.lastKid().c.emit('exit', 1, null);
  assert.equal(h.sup.state('l1b').state, SUP_STATE.EXITED_MAX);
  assert.equal(h.sup.state('l1b').restarts, MAX_RESTARTS);
});

check('sup-3 退避序列逐位等于字面量 1/2/4/8/30s', () => {
  // 断言目标是**字面量**，不是实现导出的 `BACKOFF_MS` —— 拿实现自己的常量自比，
  // 把退避改成 `[1000,1000,…]` 也一样绿，等于没断言（Step 5 的变异就是冲这条来的）。
  // 同时把导出的那个 `BACKOFF_MS` 钉在同一个字面量上：Task 8 的界面提示会读它。
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const got = [];
  for (let i = 0; i < MAX_RESTARTS; i += 1) {
    h.lastKid().c.emit('exit', 3, null);
    const p = h.pending();
    got.push(p.ms);
    h.fire();
  }
  assert.deepEqual(got, [1000, 2000, 4000, 8000, 30000]);
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 4000, 8000, 30000]);
});

check('sup-4 stop 幂等：连调两次不抛，且不算崩溃、不再重启', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.sup.stop('k');
  h.sup.stop('k');
  h.sup.stop('不存在的键');
  h.lastKid().c.emit('exit', 0, null);
  assert.equal(h.sup.state('k').state, SUP_STATE.OFF);
  assert.equal(h.timers.length, 0, '主动退出后不该排任何重启定时器');
  // 「幂等」的真正含义在这条上：第二次 stop 不能再 kill 一遍。`stop` 里只要还有一个
  // `await` 在 `reg.delete` 之前，这条就会读出 kills=[1000,1000] 而测试仍全绿。
  assert.deepEqual(h.kills, [1000], '重复 stop 不得重复 kill');
});

check('sup-5 kill 走 taskkill /PID /T /F，PID 只能来自 spawn 返回值', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const kid = h.lastKid();
  h.sup.stop('k');
  assert.deepEqual(h.kills, [kid.c.pid]);
  assert.equal(h.sup.state('k').state, SUP_STATE.OFF);
  // `/T`（连进程树一道杀）是这个用例标题的真实承诺：typeperf / powershell 都会再派生子进程，
  // 只杀父进程会留下一群孤儿继续吃 CPU。参数形状单独断，才不会因为测试注入了 killFn 而落空。
  assert.deepEqual(KILL_ARGS(4321), ['/PID', '4321', '/T', '/F']);
});

check('sup-6 心跳：超过 3× 采样间隔无输出判 stalled，kill 并计一次重启', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.lastKid().c.stdout.emit('data', Buffer.from('a'));
  h.adv(3500);
  h.sup.tick();
  assert.equal(h.sup.state('k').state, SUP_STATE.CRASHED, 'stalled 应转为等待重启');
  assert.equal(h.kills.length, 1, 'stalled 必须真 kill，挂着不输出比崩更难发现');
  assert.equal(h.sup.state('k').restarts, 1);
  // `stalled` 是一闪而过的中间态（随即进 crashed 走退避），但它是 Task 8 的 sourceRow
  // 与 Task 21 采集源条的**红字依据**（`stalled|crashed|exited-max → so-pill-red`）。
  // 实现里只要不赋值这个态，界面就只会显示"崩了"而说不出"是挂着不吐数据" —— 故经 onChange 留痕断。
  assert.ok(h.changes.some((c) => c.state === SUP_STATE.STALLED), '必须真的进入过 stalled，否则该态是死枚举');
});

check('sup-7 rolling：窗口正常结束立即续采，不计入重启次数', () => {
  const h = harness();
  h.sup.start('l1a', { label: '网络', cmd: 'typeperf', args: [], intervalMs: 1000, rolling: true, minWindowMs: 5000, onData() {} });
  h.lastKid().c.stdout.emit('data', Buffer.from('a'));
  h.adv(6000);
  h.lastKid().c.emit('exit', 0, null);
  assert.equal(h.sup.state('l1a').state, SUP_STATE.STARTING, 'rolling 应立刻起下一窗');
  assert.equal(h.kids.length, 2);
  assert.equal(h.sup.state('l1a').restarts, 0);
});

check('sup-8 rolling 短窗连续 3 次进 exited-max（防热循环）', () => {
  const h = harness();
  h.sup.start('l1a', { label: '网络', cmd: 'typeperf', args: [], intervalMs: 1000, rolling: true, minWindowMs: 5000, onData() {} });
  for (let i = 0; i < 3; i += 1) {
    h.lastKid().c.emit('exit', 0, null); // 窗口不足 minWindowMs 就退
  }
  assert.equal(h.sup.state('l1a').state, SUP_STATE.EXITED_MAX);
});

check('sup-9 stderr 只保留末尾 400 字符，供采集源条附因', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.lastKid().c.stderr.emit('data', Buffer.from('E'.repeat(600)));
  const tail = h.sup.state('k').stderrTail;
  assert.equal(tail.length, 400);
});

check('sup-10 dispose 停掉所有在跑的 child 并清掉待触发的定时器', () => {
  const h = harness();
  h.sup.start('a', { label: 'a', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.sup.start('b', { label: 'b', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.lastKid().c.emit('exit', 1, null);
  h.sup.dispose();
  assert.equal(h.kills.length, 2);
  assert.ok(h.timers.every((x) => x.done), 'dispose 后不能有活的定时器');
  assert.deepEqual(h.sup.status(), []);
});

check('sup-11 status() 每项带 label / state / restarts / pid / detail，界面直接消费', () => {
  const h = harness();
  h.sup.start('l1a', { label: '网络（typeperf）', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const row = h.sup.status()[0];
  assert.equal(row.key, 'l1a');
  assert.equal(row.label, '网络（typeperf）');
  assert.equal(row.state, SUP_STATE.STARTING);
  assert.equal(row.detail, '已排 0 次重启');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
