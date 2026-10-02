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
  // 同键重复 start 也必须走同一条"不留孤儿"的承诺：Task 8 的采集开关若忘记先 stop，
  // 只要这里漏掉 kill，注册表被覆盖但旧孩子仍在跑，且它的 stdout 监听器还在喂数据。
  const h2 = harness();
  h2.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const firstKid = h2.lastKid();
  h2.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  assert.deepEqual(h2.kills, [firstKid.c.pid], '重复 start 必须 kill 掉旧子进程');
  assert.equal(h2.sup.keys().length, 1, '重复 start 之后同键只能有一个注册项');
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
  // stalled 那条路是"自己 kill 的"（killChild 里 stopping=true），被杀的孩子随后必然补发一个 exit。
  // 这个尾巴不得把"等待重启"覆盖成 off —— handleExit 顶上那道 crashed/exited-max 闸门此前无人断言。
  h.kids[0].c.emit('exit', 1, null);
  const afterTail = h.sup.state('k').state;
  assert.ok(
    afterTail === SUP_STATE.CRASHED || afterTail === SUP_STATE.STARTING,
    `被 kill 孩子的 exit 尾巴不该把等待重启翻成 off（读到 ${afterTail}）`,
  );
  // 判卡之后那一次重启必须真的发生：退避定时器点火时若被 stopping 拦住，state 就永久停在
  // crashed、restarts 冻结、无孩子无定时器，而 tick() 只看 ON —— 采集源从此静默停摆，20/20 全绿也照不出来。
  h.fire();
  assert.equal(h.sup.state('k').state, SUP_STATE.STARTING, 'stalled 后排的退避定时器点火必须真正重启');
  assert.equal(h.kids.length, 2, '重启要真的再 spawn 一个');
  // 启动看门狗：进程活着但一句都不输出（typeperf 计数器名写错只往 stderr 喷）时永远进不了 ON，
  // 而心跳那条路只看 ON，于是它就挂在 starting 上无人发现。基准是 launch 置的 startedAt。
  const h2 = harness();
  h2.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h2.adv(3500);
  h2.sup.tick();
  assert.equal(h2.sup.state('k').state, SUP_STATE.CRASHED, 'starting 里长期无输出也要判起不来并走同一条收口');
  assert.equal(h2.kills.length, 1, '起不来也要真 kill，否则留下长挂的孤儿进程');
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

/* ④段：typeperf 解析（纯函数，零子进程） */
const fs = await import('node:fs');
const L1A = await import('../lib/collect/l1a-typeperf.js');
const FIX = fs.readFileSync(new URL('./fixtures/typeperf-multi-instance.txt', import.meta.url), 'utf8').split(/\r?\n/);

check('tp-1 splitCsv 认带引号的字段，且不把转义引号当分隔', () => {
  assert.deepEqual(L1A.splitCsv('"a","b,c","d"'), ['a', 'b,c', 'd']);
  assert.deepEqual(L1A.splitCsv('"\\"q\\"",x'), ['"q"', 'x']);
});

check('tp-2 parseHeader 丢机器名前缀，只取实例名与计数器名', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  assert.equal(counters.length, 4);
  assert.equal(counters[0].instance, 'Intel[R] Wi-Fi 6 AX201 160MHz');
  assert.equal(counters[0].counter, 'Bytes Received/sec');
  assert.equal(counters[0].metric, 'netDown');
  assert.equal(counters[1].metric, 'netUp');
  assert.equal(counters[2].instance, '\\isatap.{ABCDEF}');
});

check('tp-3 非表头行返回 null（流式解析会先撞上样本行）', () => {
  assert.equal(L1A.parseHeader(FIX[1]), null);
  assert.equal(L1A.parseHeader('正在退出，请稍候...'), null);
});

check('tp-4 parsePdTime 按本地时间解析 MM/DD/YYYY HH:mm:ss.fff', () => {
  const t = L1A.parsePdTime('09/27/2026 12:49:41.046');
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 27);
  assert.equal(d.getHours(), 12);
  assert.equal(d.getMinutes(), 49);
  assert.equal(d.getSeconds(), 41);
});

check('tp-5 样本解析：多实例按指标求和（界面要的是本机总吞吐），原始浮点不取整', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  const s = L1A.parseSampleLine(FIX[3], counters);
  // 断言字面量。`v` 是字节/秒的原始浮点，取整只在界面格式化时做。
  // （这里原本写的是 `Math.round(s.values.netDown) === 1048576 + 1.5` —— 左边四舍五入成
  //   1048578、右边是 1048577.5，**恒不相等**，预检实跑 tp-5 直接红。）
  assert.equal(s.values.netDown, 1048577.5);
  assert.equal(s.values.netUp, 131074.5);
});

check('tp-6 *_no data 列不计入和，但其它列照样出数；整行全是 *_no data 则整行不出数', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  const s = L1A.parseSampleLine(FIX[2], counters);
  assert.equal(s.values.netDown, 524288);
  assert.equal(s.values.netUp, 65536);
  // 真机每窗第一行常见形态就是全部 `*_no data`（typeperf 暖身期）。这种行必须整行丢弃：
  // 把它折成 0 会在曲线上画出一个假谷底，而 0 恰好是"没人用网"的意思，最难被发现。
  assert.equal(L1A.parseSampleLine('"09/27/2026 12:49:41.000","*_no data","*_no data","*_no data","*_no data"', counters), null);
});

check('tp-7 半行断流（列数不足 / 引号未闭合）返回 null，不抛、也不补 0', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  assert.equal(L1A.parseSampleLine(FIX[4], counters), null);
  assert.equal(L1A.parseSampleLine('正在退出，请稍候...', counters), null);
  // 列数不足但每列都有值（截断正好落在两个字段之间）也要判不完整，否则出半个吞吐值。
  assert.equal(L1A.parseSampleLine('"09/27/2026 12:49:44.093","2097152.0000"', counters), null);
});

check('tp-8 decodePd：GBK 字节解出中文，纯 ASCII 不受影响，解出替换符时回落 latin1', () => {
  assert.equal(L1A.decodePd(Buffer.from([0xce, 0xf1, 0xb9, 0xfa])), '务国');
  assert.equal(L1A.decodePd(Buffer.from('"1234.5"', 'latin1')), '"1234.5"');
  // 真机表头实测（计划期修正 #2 复核）：`"(PDH-CSV 4.0)","\\龚进的华为笔记\Network Interface(Intel[R] Wi-Fi 6 AX201 160MHz)\Bytes Received/sec"`
  // —— 机器名是 GBK 字节，其余全是 ASCII，所以"含高位字节就要解、纯 ASCII 不能被动过"是硬要求。
  // 非法 GBK 序列：TextDecoder('gbk') 默认非 fatal，**不抛**而是出 U+FFFD，
  // 所以回落必须靠检测替换符（原实现的 try/catch 是死代码，预检实测 [0x81] → '\uFFFD'）。
  assert.equal(L1A.decodePd(Buffer.from([0x81])), '\x81');
});

check('tp-9 COUNTER_ARGS / 窗口参数是常量，界面文案要用它们而不是再抄一遍', () => {
  assert.deepEqual(L1A.COUNTER_ARGS, [
    '\\Network Interface(*)\\Bytes Received/sec',
    '\\Network Interface(*)\\Bytes Sent/sec',
  ]);
  assert.equal(L1A.WINDOW_SAMPLES, 30);
  assert.equal(L1A.INTERVAL_SEC, 1);
});

check('tp-10 l1a 门面：onData 收 Buffer、解码一次、下游抛错不外抛、disable 清表头', () => {
  // createL1a 是 l1a 唯一有副作用的部分，没有用例就等于"与代码不符的陈述"。
  const started = [];
  const stops = [];
  const sup = {
    start: (key, spec) => started.push({ key, spec }),
    stop: (k) => stops.push(k),
    state: () => ({ state: 'on' }),
  };
  const pts = [];
  const a = L1A.createL1a({
    sup,
    onPoint: (p) => {
      if (p.metric === 'netUp' && p.v === 131074.5) throw new Error('boom-downstream');
      pts.push(p);
    },
  });
  a.enable();
  assert.equal(started[0].key, 'l1a');
  assert.equal(started[0].spec.rolling, true);
  assert.deepEqual(started[0].spec.args.slice(-4), ['-sc', '30', '-si', '1']);
  const feed = (s) => started[0].spec.onData(Buffer.from(s, 'latin1'));
  feed(FIX[0]);
  feed(FIX[3]);            // netDown 已入列，netUp 那一点抛错 —— 必须被吞下，不外抛
  assert.deepEqual(pts.map((p) => p.metric), ['netDown']);
  assert.equal(pts[0].v, 1048577.5);
  feed(FIX[1]);            // 抛错之后的下一行仍要出数，不能整条流哑掉
  assert.deepEqual(pts.map((p) => p.metric), ['netDown', 'netDown', 'netUp']);
  assert.equal(a.state().state, 'on');
  // 这两个数值字段是 l1a 自己扩的（监督者快照里没有），Task 8 的界面直接读它们 ——
  // 没有断言就是"与代码不符的陈述"：吞掉的那次异常必须留痕，没认出表头的行必须能累加。
  assert.equal(a.state().dataErrors, 1);
  assert.match(a.state().detail, /boom-downstream/);
  a.disable();
  assert.deepEqual(stops, ['l1a']);
  feed(FIX[1]);            // disable 后表头必须已清空：不许拿旧 index 去解新列布局
  assert.equal(pts.length, 3);
  assert.equal(a.state().noHeaderRuns, 1);   // 阈值是 5，这里未到，只验计数本身在走
});

/* ⑤段：PowerShell 常驻进程榜 */
const L1B = await import('../lib/collect/l1b-powershell.js');
const osMod = await import('node:os');   // 顶层 await：check() 的回调是同步的，`await` 写在体内不会生效

const oneRow = (over = {}) => JSON.stringify({
  t: 1760000000000,
  rows: [{ id: 4, n: 'svchost.exe', ws: 1024 ** 2, cpu: 12.5 }, { id: 7, n: 'chrome.exe', ws: 512 * 1024 ** 2 / 1024, cpu: 0 }, ...[over.extra].filter(Boolean)],
});

check('ps-1 buildLoopScript：常驻 while、UTF-8 前置、采样间隔在脚本里写死、不预裁条数', () => {
  const s = L1B.buildLoopScript({ intervalSec: 3, withCpu: true });
  assert.match(s, /\$OutputEncoding=\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/, '不设 UTF-8，中文进程名会变问号');
  // 预检真机读数：语句只用空格拼接 ⇒ powershell exit=1、stdout 0 字节（"表达式或语句中包含意外的标记"）。
  // 这两条把"能跑"钉进用例，而不是留给 Step 5 的肉眼。
  assert.match(s, /::UTF8;/, '语句之间必须有分号');
  assert.doesNotMatch(s, /Write-Output \$/, '$? 是布尔不是那行 JSON');
  assert.match(s, /while\(\$true\)/);
  assert.match(s, /Start-Sleep -Seconds 3/);
  // 评审 M-1 的裁定：`Get-CimInstance Win32_Process` 不排序，脚本里 `-First 400` 取到的是"任意 400 个"，
  // 而 `parseProcLine` 的 truncated 又恒为 0（源已裁）⇒ 进程数 >400 的机器上"内存最大的那些"会无声消失。
  // 裁条数只在解析层做，脚本必须如实把全量吐出来。
  assert.doesNotMatch(s, /Select-Object\s+-First/, '条数上限归解析层，不许在脚本里预裁');
  assert.match(s, /ConvertTo-Json -Compress/);
  assert.match(s, /PercentProcessorTime/, 'withCpu=true 必须取 CPU');
});

check('ps-2 withCpu=false 时不查 Perf 表（CPU 列实测超预算时的降级分支）', () => {
  const s = L1B.buildLoopScript({ intervalSec: 3, withCpu: false });
  assert.doesNotMatch(s, /PercentProcessorTime/);
  assert.match(s, /WorkingSetSize/);
});

check('ps-3 parseProcLine 归一化：id→pid、n→name、ws→字节、cpu→百分数（按核数均摊）', () => {
  const r = L1B.parseProcLine(oneRow(), { procCount: 8 });
  assert.equal(r.t, 1760000000000);
  assert.equal(r.rows.length, 2);
  assert.deepEqual({ ...r.rows[0] }, { pid: 4, name: 'svchost.exe', ws: 1024 ** 2, cpuPct: 1.5625 });
  // 评审 M-2：`Number(x) || 0` 会把取不到的 pid 折成 0，而真机恒有 pid 0 的 System Idle Process
  // （且它的 cpuPct 是聚合值）—— 两者撞主键会让界面把"缺 pid"的行当成 Idle。缺就是 null。
  const bad = L1B.parseProcLine(JSON.stringify({ t: 1, rows: [{ id: 'x', n: 'a.exe', ws: 5 }] }), { procCount: 8 });
  assert.equal(bad.rows[0].pid, null);
  assert.equal(bad.rows[0].ws, 5);
  // 复审 Imp-2：`id` 是 JSON 的 null 或空串时，`Number()` 给出的是 **0**（不是 NaN），会被判成"合法 pid 0"
  // 正好撞上真机恒有的 System Idle Process —— 上面那条 `'x'` 用例挡不住这一形，必须各钉一发。
  const nullId = L1B.parseProcLine(JSON.stringify({ t: 2, rows: [{ id: null, n: 'b.exe', ws: 6 }, { id: '', n: 'c.exe', ws: 7 }] }), { procCount: 8 });
  assert.equal(nullId.rows[0].pid, null, '"id":null 不是 pid 0');
  assert.equal(nullId.rows[1].pid, null, '"id":"" 不是 pid 0');
  assert.deepEqual(nullId.rows.map((x) => x.ws), [6, 7], '畸形 pid 的行不许被丢掉，name/ws 照样带出');
  const real0 = L1B.parseProcLine(JSON.stringify({ t: 3, rows: [{ id: 0, n: 'System Idle Process', ws: 4096, cpu: 800 }] }), { procCount: 8 });
  assert.equal(real0.rows[0].pid, 0, '真的 pid 0 必须是数字 0，与上面的 null 区分开');
});

check('ps-4 CPU 缺列（withCpu=false 或系统未给）时 cpuPct 为 null，不是 0', () => {
  const text = JSON.stringify({ t: 1, rows: [{ id: 9, n: 'a.exe', ws: 10 }] });
  const r = L1B.parseProcLine(text, { procCount: 8 });
  assert.equal(r.rows[0].cpuPct, null);
  assert.equal(r.rows[0].ws, 10);
  // 真机第一轮 391 行里就有 2 行是 `"cpu":null`（进程刚建、还没进 Perf 表）。
  // `Number(null) === 0`，所以这一种必须单独钉：显式的"没测到"不许被折成 0%。
  const n = L1B.parseProcLine(JSON.stringify({ t: 1, rows: [{ id: 9, n: 'a.exe', ws: 10, cpu: null }] }), { procCount: 8 });
  assert.equal(n.rows[0].cpuPct, null);
});

check('ps-5 非 JSON 行（PowerShell 的告警、进度条、空行）返回 null 而不是抛', () => {
  assert.equal(L1B.parseProcLine('Write-Error : 找不到驱动', { procCount: 8 }), null);
  assert.equal(L1B.parseProcLine('', { procCount: 8 }), null);
  assert.equal(L1B.parseProcLine('{"rows":"不是数组"}', { procCount: 8 }), null);
});

check('ps-6 单行超长（实测 391 进程 / 行 21018 字节）不影响解析；超上限时按 ws 降序留前 maxRows 并计数', () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, n: 'p' + i, ws: 1024, cpu: 0 }));
  const r = L1B.parseProcLine(JSON.stringify({ t: 5, rows }), { procCount: 8, maxRows: 400 });
  assert.equal(r.rows.length, 400);
  assert.equal(r.truncated, 200);
  // 评审 M-1 的第二半：CIM 不排序，"前 400 个"是任意 400 个，界面要的是内存最大的 400 个。
  // 造一组 ws 递增的：截断后必须留下最大的那些（ws 从 600*1024 往下数 400 个），而不是枚举顺序的前 400。
  const rise = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, n: 'p' + i, ws: (i + 1) * 1024, cpu: 0 }));
  const t = L1B.parseProcLine(JSON.stringify({ t: 6, rows: rise }), { procCount: 8, maxRows: 400 });
  assert.equal(t.rows[0].ws, 600 * 1024, '截断要保留内存最大的一批');
  assert.equal(t.rows.at(-1).ws, 201 * 1024);
  assert.equal(t.truncated, 200);
});

check('ps-7 默认参数与实测一致：sleep 3s，但实际周期 4.37–4.91s ⇒ 心跳基准另算', () => {
  assert.equal(L1B.INTERVAL_SEC, 3);
  assert.equal(L1B.MAX_ROWS, 400);
});

/* 预检裁定：⑤段新增且只新增这一条（台账 Ruling-38）—— createL1b 是 l1b 唯一有副作用的部分，
   而预检实测"喂 Buffer 时每一行都判成非 JSON"，没有门面对象就等于把这条静默断流留在交付里。 */
check('ps-8 l1b 门面：onData 收 Buffer、UTF-8 解码一次、非 JSON 行走 onRows(null, line) 不静默', () => {
  const started = [], stops = [];
  const sup = {
    start: (key, spec) => started.push({ key, spec }),
    stop: (k) => { stops.push(k); return { stopped: true }; },
    state: () => ({ state: 'on' }),
  };
  const got = [];
  const b = L1B.createL1b({ sup, onRows: (parsed, line) => got.push(parsed ? 'rows' : 'noise') });
  b.enable();
  assert.equal(started[0].key, 'l1b');
  assert.deepEqual(started[0].spec.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(started[0].spec.intervalMs, 5000, '心跳按实际周期（sleep 3s + 干活 1.6–1.9s）算，不是 sleep 秒数');
  const feed = (s) => started[0].spec.onData(Buffer.from(s, 'utf8'));
  // 中文进程名过 UTF-8：不加 UTF-8 前置时真机是 GBK 字节（实测 b9a8bdf8），加了才是这里的 UTF-8
  feed(JSON.stringify({ t: 1760000000000, rows: [{ id: 4, n: '龚进.exe', ws: 1024, cpu: 8 }] }));
  assert.deepEqual(got, ['rows']);
  assert.equal(b.latest().rows[0].name, '龚进.exe');
  assert.equal(b.latest().rows[0].cpuPct, 8 / osMod.cpus().length);   // 均摊口径，核数跟随本机而不是写死 8
  feed('Write-Error : 找不到驱动');                                 // 非 JSON 行必须走 (null, line) 分支，不许静默 return
  assert.deepEqual(got, ['rows', 'noise']);
  assert.equal(b.state().state, 'on');
  // 评审 Important-1：残值。源停了或新一轮还没出数时，latest() 不能再把上一轮的 rows 冒充"当前"。
  b.disable();
  assert.deepEqual(stops, ['l1b']);
  assert.equal(b.latest(), null, 'disable 必须清缓存：否则界面拿着已停源的旧进程榜当实时');
  feed(JSON.stringify({ t: 1760000000001, rows: [{ id: 5, n: 'x.exe', ws: 10, cpu: 1 }] }));  // 把缓存重新灌满，好让下一条断言真的承重
  b.enable();
  assert.equal(b.latest(), null, 'enable 之后、首轮到达之前同样不许留旧值');
  // 评审 M-3 的落点（按 Ruling-16 折进本条，不新开 check）：装配漏传 onRows 时，实现里的
  // `onRows?.()` 会把整条进程榜静默吞掉 —— 所以构造入口就要抛，而不是等数据流走空。
  assert.throws(() => L1B.createL1b({ sup }), /onRows/);
  assert.throws(() => L1B.createL1b({ sup, onRows: 1 }), /onRows/);
});

/* ⑥段：collect service 编排 */
const { createCollectService } = await import('../lib/collect/service.js');

function fakeWorld(over = {}) {
  let t = 0;
  const timers = [];
  const events = [];
  const started = [];
  const stopped = [];
  const l0Reads = [];
  const caps = {};                    // 服务传给工厂的出口（onPoint / onRows）落在这里，用例才有东西可断
  const warns = [];                   // logger.warn 的落点：svc-8 要断"rejection 被就地接住且留了痕"，空桩就看不见
  let coreCount = over.cores ?? 8;    // svc-1 要在跑的过程中改核数（热插拔基线复位那条契约）
  let resetCount = 0;
  // 宿主文档口径：`ctx.interval(fn, ms)` 返回的是 **disposer 函数**
  // （`dsh-plugin-stock-analysis/docs/host-capabilities.md:244-251`；参照实现
  // `dsh-plugin-stock-analysis/lib/monitor/service.js:393` 也是把返回值直接当停止函数存成 `stopFn`）。
  // 原样桩返回的是可变句柄对象、服务靠 `h.done = true` 停 —— 那等于往函数对象上挂一个没人读的
  // property：真宿主的定时器照敲，暂停/切档/dispose 全都停不下来。桩改成
  // 「返回 disposer，disposer 被调用才置 done」，"服务有没有真的调用 disposer" 才是用例能断的事实
  // （Task 8 评审变异 C7：摘掉停止调用，原样 48 条照样全绿）。
  const intervalFn = (fn, ms) => { const h = { fn, ms, done: false }; timers.push(h); return () => { h.done = true; }; };
  // svc-7 走的是 `globalThis.setInterval` 回退分支。**不打桩真的话，`w.timers` 恒是空数组**
  // —— 预检变异取证：把实现里的 `globalThis.clearInterval(l0Handle.h)` 整行删掉，原样用例仍 PASS（空断言）。
  const realSI = globalThis.setInterval, realCI = globalThis.clearInterval;
  const si = [];
  if (over.noTimer) {
    globalThis.setInterval = (fn, ms) => { const h = { fn, ms, live: true }; si.push(h); return h; };
    globalThis.clearInterval = (h) => { if (h && 'live' in h) h.live = false; };
  }
  const sup = {
    start: (key, spec) => { started.push(key); return { key, state: 'starting', restarts: 0, detail: '' }; },
    stop: async (key) => { stopped.push(key); return null; },
    state: (key) => ({ key, state: over.supState ?? 'on', restarts: 0, pid: 1, lastTick: 0, stderrTail: '', detail: '' }),
    status: () => over.supStatus ?? [],
    tick: () => {},
    // 标志必须挂在**桩对象自己**上。原先写 `over.supDisposed = true`，而 `over` 没暴露给用例，
    // svc-8 的 `w.sup.supDisposed` 就永远取不到 —— 探针实测是硬失败（`undefined`），不是空断言。
    supDisposed: false,
    dispose() { this.supDisposed = true; },
  };
  const svc = createCollectService({
    getPrefs: () => over.prefs ?? { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: false } },
    // warns 落盘：svc-8 要断"dispose 里 disable 的 rejection 被就地接住**且留了痕**"，空桩看不见接住动作。
    logger: { warn: (...a) => { warns.push(a.map((x) => String(x?.message ?? x)).join(' ')); }, info() {} },
    now: () => t,
    getIntervalFn: () => (over.noTimer ? null : intervalFn),
    osMod: { cpus: () => Array.from({ length: coreCount }, () => 0) },
    makeSupervisor: () => sup,
    makeL0: () => ({
      // cpu 必须**始终落在 0~100**：percent ring 见到 >100 判 bad 直接丢（真实现也是如此）。
      // 预检取证：原样写 `cpu: 10 + i` 时第 91 拍起全是 bad，svc-6 的点数上限断言永远填不满，
      // 于是那条断言只在数一个早就被丢弃的环 —— 断的是替身的形状，不是服务的行为。
      read: () => { const i = l0Reads.length; l0Reads.push(1); return over.l0?.(i) ?? { t, cpu: 10 + (i % 80), mem: 50, diskFree: 70 * 2 ** 30, diskTotal: 200 * 2 ** 30 }; },
      reset: () => { l0Reads.length = 0; resetCount += 1; },
    }),
    makeL1a: ({ sup: s, onPoint }) => { caps.onPoint = onPoint; return { enable: () => s.start('l1a'), disable: () => s.stop('l1a'), state: () => sup.state('l1a') }; },
    makeL1b: ({ sup: s, onRows }) => { caps.onRows = onRows; return { enable: () => s.start('l1b'), disable: () => s.stop('l1b'), state: () => sup.state('l1b'), latest: () => over.procRows ?? null }; },
  });
  svc.onEvent((e) => events.push(e));
  // fire 是"重复敲同一个活着定时器"，不是"消耗一个定时器"：`h.done` 只由服务在 clearL0 时置。
  // 预检取证：原样 `h.done = true; h.fn();` 时 svc-6 的 400 次循环实际只跑了一拍（第 2 次起 find 不到句柄），
  // 而把 windowMs/maxPoints 改成 1e12/1e9 那条仍 PASS —— 断言完全空转。
  return { svc, caps, si, warns, t: () => t, clock: () => t, reads: () => l0Reads.length, resets: () => resetCount, setCores: (n) => { coreCount = n; },
    adv: (ms) => { t += ms; }, events, started, stopped, timers, sup,
    fire: (n = 1) => { const h = timers.find((x) => !x.done); if (!h) return; for (let i = 0; i < n; i++) h.fn(); },
    restore: () => { globalThis.setInterval = realSI; globalThis.clearInterval = realCI; } };
}

check('svc-1 start 后 L0 按档位跑，L1a/L1b 的出口被接上且点真的进环并 emit metrics', () => {
  const w = fakeWorld();
  w.svc.start();
  assert.ok(w.started.includes('l1a'), 'l1a 默认开（实测 <1% 代价），应被 start');
  assert.equal(w.svc.snapshot().cadence, '1s');
  // 这两条是预检补的：原用例断一个 `type==='l1a-enable'` 的事件，而 `fakeWorld` 里**没有任何代码会 emit 它**
  // —— 工厂收到的 `onPoint` 被塞进返回对象当属性，`events` 又没暴露给工厂，所以那条断言是硬失败（不是空断言，是根本不可能成立）。
  // 换成真口径：断服务确实把出口函数传给了工厂，再手工灌一个点，验它落进对应的 ring 并推了事件。
  assert.equal(typeof w.caps.onPoint, 'function', '服务必须把 onPoint 传给 createL1a');
  assert.equal(typeof w.caps.onRows, 'function', '服务必须把 onRows 传给 createL1b（Task 7 已定为不传就抛，漏接=静默吞榜）');
  w.adv(1000); w.fire();                       // 先敲一拍 L0，让假时钟走到 1000（ring 只收严格递增的 t）
  const before = w.events.length;
  w.caps.onPoint({ metric: 'netDown', t: w.clock(), v: 2 * 1024 * 1024 });
  const s = w.svc.snapshot();
  assert.equal(s.series.netDown.at(-1).v, 2 * 1024 * 1024, 'L1a 的点必须落进 netDown ring（字节/秒原值，不做 /8）');
  assert.equal(s.latest.netDown, 2 * 1024 * 1024, 'latest.netDown 与 ring 同口径，界面自己换算 MB/s');
  assert.equal(w.events.length, before + 1, '写点成功必须 emit');
  assert.equal(w.events.at(-1).type, 'metrics');
  assert.equal(w.events.at(-1).key, 'netDown');
  // 非 JSON 行不许静默（Task 7 下游契约）：走 (null, line) 分支必须在 snapshot 里留痕
  w.caps.onRows(null, 'Write-Error : 表达式或语句中包含意外的标记');
  assert.notEqual(w.svc.snapshot().proc.note, '', '非 JSON 行要留下可见的因由，不能只丢');
  // 非 JSON 轮**没有**可信的轮次时间戳：`proc.t` 只在解析成功时写。界面按 `proc.t` 判新鲜度，
  // 把它折成 0 或留着上一轮的值都会让"多久没出数"这个数算错。
  assert.equal(w.svc.snapshot().proc.t, null, '整轮非 JSON 时 proc.t 必须是 null，不是 0 也不是残值');
  // 台账 Task 5 下游契约②：核数变了要复位 cpu 基线，否则 `computeCpuPct` 在两次样本核数不等时返回 NaN
  // ⇒ 曲线**成片**丢点（每拍都丢）。两条一起断，才挡住"每拍都 reset"这个反向的错。
  const r0 = w.resets();
  w.adv(1000); w.fire();
  assert.equal(w.resets(), r0, '核数没变不许复位');
  w.setCores(4);
  w.adv(1000); w.fire();
  assert.equal(w.resets(), r0 + 1, '核数变化必须调 l0.reset()');
  // sources 只在**内容变了**时推（Task 18 的 SSE 靠这条减负，否则 1s 推一屏同样的三行）。
  // 到这里 l0 的档位/窗口、l1a/l1b 的 supervisor 状态全程没变过 ⇒ 除了 start() 那一屏，一条都不许多推。
  // 评审变异 C8：摘掉 `refreshSources()` 的去重提前 return，48 条全绿 —— 这个承诺原先无人承重。
  assert.equal(w.events.filter((e) => e.type === 'sources').length, 1,
    `状态没变时每拍 refreshSources 不许重复推 sources（实得 ${w.events.filter((e) => e.type === 'sources').length} 屏，只有 start 该推 1 屏）`);
});

check('svc-2 档位切 5s / 暂停：源状态与 cadence 同步变，并 emit sources', () => {
  const w = fakeWorld();
  w.svc.start();
  w.svc.setCadence('5s');
  assert.equal(w.svc.snapshot().cadence, '5s');
  // 切档时旧定时器必须被**停掉**，不是只在服务这边换个引用：宿主句柄是 disposer 函数
  // （`docs/host-capabilities.md:244`），不调它就没有任何动作发生 ⇒ 新旧两拍一起敲。
  assert.ok(w.timers[0].done, 'setCadence 必须调用宿主句柄的 disposer，否则旧定时器还在敲（会出现双档并跑）');
  w.svc.setCadence('暂停');
  const s = w.svc.snapshot();
  assert.equal(s.cadence, '暂停');
  assert.equal(s.sources.find((r) => r.key === 'l0').state, 'off');
  assert.equal(s.timerBackend, null, '暂停=没挂任何表，不许继续报上一个后端（参照实现 stop() 就把它置回 null）');
  assert.ok(w.events.some((e) => e.type === 'sources'), '切档必须有 sources 事件（界面要立刻改文案）');
  assert.throws(() => w.svc.setCadence('2s'), /cadence/);
});

check('svc-3 脏点不写 ring，只进 dropped 计数（一个假点会被读成真实尖峰）', () => {
  const w = fakeWorld({ l0: (i) => (i === 1 ? { t: 0, cpu: NaN, mem: 50, diskFree: 1, diskTotal: 2 } : undefined) });
  w.svc.start();
  const before = w.svc.snapshot().dropped.bad;
  // 手工推两拍：第一拍正常、第二拍 cpu 是 NaN
  w.fire(2);
  // **必须 `+ 1` 而不是 `>= before`**：原样写 `>=` 时 `before` 是 0，断言永真，
  // 预检变异取证 —— 把实现里的 `droppedBad` 计数整段删掉，原样用例照样 PASS（空断言）。
  assert.equal(w.svc.snapshot().dropped.bad, before + 1, 'NaN 点必须计数一次，且只计那一个指标');
  assert.ok(w.svc.snapshot().series.cpu.length <= 1, '脏点不许写进 cpu ring');
});

await checkAsync('svc-4 L1b 默认关；只有「开 + 页面可见」才启动，不可见时停采并清残值', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s' }, sources: { l0: true, l1a: true, l1b: true } } });
  w.svc.start();
  assert.ok(!w.started.includes('l1b'), '默认不可见时不起 L1b（实测单轮 1.6–1.9s 的代价不能白付）');
  await w.svc.setVisible(true);
  assert.ok(w.started.includes('l1b'), '可见 + 开关为真 才起');
  // Task 7 的 I-1 在编排层的镜像：`latest()` 现在 disable 就返 null，服务侧的 proc.rows 也必须跟着清，
  // 否则界面拿着"已停源的上一轮进程榜"画实时卡片 —— 这是最坏的一种静默。
  w.caps.onRows({ t: 5, rows: [{ pid: 1, name: 'a.exe', ws: 1024, cpuPct: 1 }] });
  assert.equal(w.svc.snapshot().proc.rows.length, 1);
  assert.equal(w.svc.snapshot().proc.t, 5, '成功轮的 t 必须透到 snapshot().proc.t（Task 7 §Produces 点名的字段）');
  await w.svc.setVisible(false);
  assert.ok(w.stopped.includes('l1b'), '页面切走要停采');
  assert.deepEqual(w.svc.snapshot().proc.rows, [], '停采必须清进程榜残值');
  assert.equal(w.svc.snapshot().proc.t, null, '残值清理要连 t 一起清，否则界面拿到"带新鲜时间戳的空榜"或反过来');
  assert.ok(w.events.some((e) => e.type === 'proc' && e.rows.length === 0), '清空也要推 proc 事件，否则 SSE 侧留着旧榜');
});

await checkAsync('svc-5 supervisor 终态原样透传进 sources，且 L1a 不随页面可见性停采', async () => {
  // l1b 的开关这里必须是**真的开着**：上一版用默认关的 l1b 断「setVisible(false) 里 L1b 被停」，
  // 而老实现那条 else 是无条件调 disable() 的 —— 于是一条从没跑过的源也能把断言考绿。
  // S18 起 setVisible(false) 只在真的在跑时才停（不再白推一帧空榜），用例改成先让它跑起来。
  const w = fakeWorld({
    supState: 'exited-max',
    prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: true } },
  });
  w.svc.start();
  await w.svc.setVisible(true);
  const row = w.svc.snapshot().sources.find((r) => r.key === 'l1a');
  assert.equal(row.state, 'exited-max', 'supervisor 的终态要原样透传，界面按四类分支给文案');
  // 用例标题原本写"网络计数器名缺失时 state 为 unavailable"，但体内断的是 exited-max，
  // 而 `unavailable` 这个态在本文件里从来没有实现会置它（Task 6 的 l1a 只经 supervisor 置态）——
  // 标题改成断言的真实口径。计数器名缺失的真机文案归 Task 21（台账：typeperf 以 exit=4026531842 退出且错误走 stdout）。
  assert.ok(w.started.includes('l1b'), '开 + 可见 ⇒ L1b 这一路真的起了（否则下面那条「必须被停」是空断言）');
  await w.svc.setVisible(false);
  assert.ok(!w.stopped.includes('l1a'), 'L1a 成本实测 <1%，不随可见性起停（只有 L1b 受闸门）');
  assert.ok(w.stopped.includes('l1b'), '同一动作里 L1b 必须被停');
});

check('svc-6 snapshot 的点位数上限 = keepMinutes×60+1（1s 档，含边界一拍）', () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 5 } } });
  w.svc.start();
  for (let i = 0; i < 400; i++) { w.adv(1000); w.fire(); }
  assert.ok(w.reads() >= 400, `400 次 fire 必须真的采了 400 拍（读到 ${w.reads()} 次）—— 这条钉住 fire() 是"重复敲同一个活着的定时器"，不是消耗句柄`);
  const s = w.svc.snapshot();
  // **断精确值而不是 `<= 301`**：`<=` 在 windowMs/maxPoints 被改成天文数字时照样绿（预检变异取证：
  // 把 ring 的 windowMs 改 1e12、maxPoints 改 1e9，原样用例仍 PASS —— 因为 fire() 只跑了一拍，环里只有 1 个点）。
  // 5min 窗 + `maxPoints = keepMinutes*60 + 1` ⇒ 400 拍里只剩最后 301 个（窗底含边界保留）。
  assert.equal(s.series.cpu.length, 301, `5min 窗 @1s 上限 301，实得 ${s.series.cpu.length}`);
  assert.equal(s.keepMinutes, 5);
});

check('svc-7 宿主无 timer 时退 setInterval，并在 snapshot.timerBackend 如实标', () => {
  const w = fakeWorld({ noTimer: true });
  w.svc.start();
  assert.equal(w.svc.snapshot().timerBackend, 'setInterval');
  assert.equal(w.si.length, 1, `回退分支必须真的挂上一个 setInterval（实得 ${w.si.length} 个）`);
  assert.equal(w.timers.length, 0, '宿主给了 null 就不许再走 ctx.interval 那条路');
  w.svc.dispose();
  // 原来这条断 `w.timers.every(...)`，但 noTimer 分支下 `timers` 恒是空数组，`.every()` 真空通过
  // —— 预检变异取证：删掉实现里的 `globalThis.clearInterval(l0Handle.h)`，原样用例照样 PASS。
  // 现在打桩真的 setInterval/clearInterval（fakeWorld 里装、本条末尾还原），断**那个句柄**被置死。
  assert.ok(w.si.every((h) => h.live === false), '退 setInterval 必须显式 clearInterval，否则留野定时器');
  w.restore();
});

await checkAsync('svc-8 dispose：停 L0 定时器、停所有子进程、清 ring；重复调用不抛', async () => {
  // l1b 开关这里**必须为真**：残值/闸门那几条断的是"迟到的 setVisible 会把 l1b 复活"，
  // 而 setVisible 只在「开关 + 可见」两个条件都成立时才动 l1b —— 用默认 prefs（l1b:false）
  // 的话那条闸门删掉也没人看得见（fix round 变异取证：C10b 摘掉 setVisible 闸门照样 48/48 全绿）。
  // start() 时 visible 仍是 false，所以 l1b 并没有被起，`started` 的增量仍然只归 dispose 后的复活路径。
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: true } } });
  w.svc.start();
  w.adv(1000); w.fire();
  assert.ok(w.svc.snapshot().series.cpu.length >= 1, '前置条件：ring 里得先有点，否则下面"清 ring"那条是空的');
  w.svc.dispose();
  w.svc.dispose();
  assert.ok(w.stopped.includes('l1a'));
  assert.ok(w.sup.supDisposed, 'supervisor 要 dispose');
  assert.equal(w.svc.snapshot().series.cpu.length, 0, 'dispose 要清 ring（标题主张，原来没有断言承重）');
  assert.deepEqual(w.svc.snapshot().proc.rows, [], 'dispose 也要清进程榜');
  // 真机串跑实测：dispose 后 sources 是 `l0:on,l1a:off,l1b:off` —— l0 那行按「开关+档位」算，
  // 而 dispose 只清了定时器。这一条把它钉成 off，否则界面/日志会以为主进程还在采样。
  const l0row = w.svc.snapshot().sources.find((r) => r.key === 'l0');
  assert.equal(l0row.state, 'off', 'dispose 后 l0 行不许再报 on');
  assert.match(l0row.detail, /dispose/, 'detail 要说清是 dispose 停的，不是用户把档位调成暂停');
  // dispose 走的是 push 通道那半：Task 18 的 SSE 只按事件更新采集源条、不轮询 snapshot，
  // dispose 不补推一屏，订阅者手里的 l0 行就永远停在 on —— 正是上面那条 off 想拦的假陈述，只是换了通道。
  const lastSrc = w.events.filter((e) => e.type === 'sources').at(-1);
  assert.equal(lastSrc?.rows?.find((r) => r.key === 'l0')?.state, 'off',
    'dispose 末尾必须 refreshSources()：事件通道的终态也要是 off');
  assert.ok(w.timers.every((h) => h.done), 'dispose 必须调用宿主句柄的 disposer（不调就停不下来）');
  assert.equal(w.svc.snapshot().timerBackend, null, 'dispose 后不许继续报上一个定时器后端');
  // dispose 会重建 ring、清进程榜，磁盘那两格取自 lastSample 而不是 ring ⇒ 不清就是"半新半旧"的快照
  assert.equal(w.svc.snapshot().latest.diskFreeGb, null, 'dispose 后 latest.diskFreeGb 不许留旧账（与"不报旧账"一致）');
  assert.equal(w.svc.snapshot().latest.diskTotalGb, null, '同上，diskTotalGb 也是 lastSample 的残值');
  // dispose 之后一条**迟到的** visibility POST / 开关写入（页面切换与卸载竞态，Task 18 完全可能送慢一拍）
  // 会把已 dispose 的服务背后的子进程再拉起来：界面说服务已死、系统里却多一个活的采集进程。
  const startedN = w.started.length;
  await w.svc.setVisible(true);
  await w.svc.setSource('l1a', true);
  w.svc.setCadence('5s');
  assert.equal(w.started.length, startedN, 'dispose 后 setVisible/setSource 不许复活子进程');
  assert.equal(w.timers.length, 1, 'dispose 后 setCadence 不许重挂定时器（重挂了 l0 行仍报 off，就是自相矛盾）');
  // dispose 里 `disable()` 的 rejection 必须**就地接住**：裸 `try { l1a.disable() } catch` 抓不到 promise
  // 拒绝，而 Node ≥15 默认 `--unhandled-rejections=throw` 会直接**打死宿主进程** —— Task 19 就是把 dispose
  // 挂在插件卸载钩子上。默认桩的 `stop` 永不 reject，所以摘掉 `.catch` 也全绿（fix round 变异 C11 取证），
  // 这里现场换一个会 reject 的 `sup.stop` 再 dispose 一拍。装探针这件事本身也让 Node 不再当场杀进程，
  // 于是断言看得见"有没有被甩出来"，而不是整轮测试直接崩。
  const thrown = [];
  const probe = (reason) => thrown.push(reason);
  process.on('unhandledRejection', probe);
  w.sup.stop = async () => { throw new Error('模拟杀进程失败'); };
  w.svc.dispose();
  await new Promise((r) => setTimeout(r, 0));   // rejection 在微任务检查点上报，必须让出一拍才收得到
  process.off('unhandledRejection', probe);
  assert.deepEqual(thrown.map((e) => String(e?.message ?? e)), [],
    `dispose 不许把 disable 的 rejection 甩给宿主（甩出来 ${thrown.length} 条）`);
  assert.ok(w.warns.some((m) => /dispose 停 l1a 抛错/.test(m)) && w.warns.some((m) => /dispose 停 l1b 抛错/.test(m)),
    `接住的两条都要留痕，实得 warn：${JSON.stringify(w.warns)}`);
});

await checkAsync('svc-9 setSource(key,on) 改开关会立即起/停对应源', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s' }, sources: { l0: true, l1a: false, l1b: false } } });
  w.svc.start();
  assert.ok(!w.started.includes('l1a'), '配置里 l1a=false 就不该起');
  await w.svc.setSource('l1a', true);
  assert.ok(w.started.includes('l1a'));
  await w.svc.setSource('l1a', false);
  assert.ok(w.stopped.includes('l1a'));
});

check('svc-10 diskFreePct 序列 = 可用/总容量，单位与 diskFreeGb 分两处口径不混用', () => {
  const w = fakeWorld();
  w.svc.start();
  w.adv(1000); w.fire();
  const s = w.svc.snapshot();
  assert.equal(Math.round(s.latest.diskFreeGb * 10) / 10, 70);
  assert.equal(Math.round(s.latest.diskTotalGb * 10) / 10, 200);
  assert.equal(Math.round(s.series.diskFreePct.at(-1).v * 10) / 10, 35);
});

/* ---------------- S18 四源开关的三条不变量（真机批注 ①②④） ---------------- */

await checkAsync('svc-11 重复的「页面可见」不许再动 L1b 的孩子（S18-④ 进程采集不停重启）', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: true } } });
  w.svc.start();
  await w.svc.setVisible(true);
  assert.deepEqual(w.started, ['l1a', 'l1b'], `首帧只各起一次（实起 ${JSON.stringify(w.started)}）`);
  // 真机那一路：SSE 重连 / 切页签 / visibilitychange 都会再敲一次 setVisible(true)。
  // 老实现每次都 l1b.enable() ⇒ 监督者 start() 先 teardown 正在跑的孩子再冷启（实测 4.3s 空窗）。
  for (let i = 0; i < 5; i++) await w.svc.setVisible(true);
  assert.equal(w.started.filter((k) => k === 'l1b').length, 1,
    `5 次重复可见只许起 1 次（实起 ${w.started.filter((k) => k === 'l1b').length} 次）`);
  assert.equal(w.stopped.length, 0, '没停过：重复可见也不该走 disable 那条路');
  // 隐藏再回来 ⇒ 这才是真的该重起一次（上一轮的孩子已经被停掉了）
  await w.svc.setVisible(false);
  await w.svc.setVisible(true);
  assert.equal(w.started.filter((k) => k === 'l1b').length, 2, '停过之后再可见要能重新起');
});

await checkAsync('svc-12 同值重放 setSource 不许起/停任何子进程（S18-② 开网速采集顺手起进程采集）', async () => {
  // 承重：index.js 的 syncRuntime() 在**任何一次 prefs 写入**后把四个源全量重放一遍。
  // 库里 sources.l1b 存着 true 而这一路当前没跑（页面隐藏）时，老实现会在用户点开网速采集
  // 那一刻把 PowerShell 起来 —— 用户看到的就是「网络采集一开，进程采集也跟着开了」。
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: false, l1b: true } } });
  w.svc.start();                                    // 不可见 ⇒ l1b 开着但没起
  assert.ok(!w.started.includes('l1b'), '不可见时不该起 L1b');
  await w.svc.setSource('l1a', true);               // 用户点开网速采集
  assert.deepEqual(w.started, ['l1a'], `只该起被点的那一路（实起 ${JSON.stringify(w.started)}）`);
  for (const k of ['l0', 'l1a', 'l1b', 'l2']) await w.svc.setSource(k, w.svc.sourceRows().find((r) => r.key === k)?.enabled === true);
  assert.deepEqual(w.started, ['l1a'], `全量重放同值⇒ 一次都没多（实为 ${JSON.stringify(w.started)}）`);
  assert.equal(w.stopped.length, 0, `同值重放也不许停任何一路（实停 ${JSON.stringify(w.stopped)}）`);
  await w.svc.setSource('l1a', false);
  assert.deepEqual(w.stopped, ['l1a'], '真的关掉时才停那一路');
});

await checkAsync('svc-13 源行的 enabled 是开关意图，state 是这一路现在在不在跑（两者可以不等）', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: true } } });
  w.svc.start();
  const off = w.svc.snapshot().sources;
  assert.equal(off.find((r) => r.key === 'l0').enabled, true,
    'l0 那一格同样报的是开关意图：index.js 的 syncRuntime 会拿它重放 setSource("l0", …)，报 false 等于把正在采的曲线关掉');
  assert.equal(off.find((r) => r.key === 'l1b').enabled, true, '库里开着 ⇒ enabled:true');
  assert.equal(off.find((r) => r.key === 'l1b').state, 'on', '假监督者报 on（真机这里是没起 ⇒ off）');
  await w.svc.setSource('l1b', false);
  const row = w.svc.snapshot().sources.find((r) => r.key === 'l1b');
  assert.equal(row.enabled, false, '关掉开关后 enabled 跟着变，界面那颗开关读的必须是这个而不是 state');
  // l1a 默认开、库里从没写过时，浏览器读不到 sources.l1a ⇒ 只能靠宿主这一格说真话（S18-①）
  const w2 = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true } } });
  w2.svc.start();
  assert.equal(w2.svc.snapshot().sources.find((r) => r.key === 'l1a').enabled, true,
    '宿主默认的 L1a 要在源行里报 enabled:true，别让设置页把在采的源画成没开');
});

await checkAsync('svc-14 restartSource 是「收干净再按当前条件重起」，且这个方法真的在服务出口上', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: true } } });
  // lib/api.js:396 的 POST /api/collect/restart 直接调它；S18 核对时发现出口里**根本没有这个方法**，
  // 源条那颗「重试」点下去必然 TypeError ⇒ 500。这条先钉"函数存在"，再钉行为。
  assert.equal(typeof w.svc.restartSource, 'function', '服务出口必须带 restartSource（路由在调它）');
  w.svc.start();
  await w.svc.setVisible(true);
  assert.deepEqual(w.started, ['l1a', 'l1b']);
  const row = await w.svc.restartSource('l1b');
  assert.deepEqual(w.stopped, ['l1b'], '重启要先停掉当前孩子（同键 start 会 teardown，这里显式走一遍）');
  assert.equal(w.started.filter((k) => k === 'l1b').length, 2, '开 + 可见 ⇒ 重起一次');
  assert.equal(row && row.key, 'l1b', '返回重启后的那一源行');
  await w.svc.setVisible(false);
  const before = w.started.length;
  await w.svc.restartSource('l1b');
  assert.equal(w.started.length, before, '不可见时重启只该把它停掉，不该再起');
  // 非常驻的两路不碰子进程
  const l0Row = await w.svc.restartSource('l0');
  assert.equal(l0Row && l0Row.key, 'l0', 'l0 走重挂定时器，返回自己的源行');
  assert.equal(await w.svc.restartSource('l2'), null, 'l2 没有常驻进程，也没有源行 ⇒ null');
  await assert.rejects(() => w.svc.restartSource('l9'), /未知源开关/);
});

/* S18-① 的真机那一半：上一轮只把「界面读的那一格」（源行的 enabled）修对了，采集本身在启动期
   仍然没人去起。判据必须按真装配口径来 —— `index.js:432` 故意不调 `collect.start()`（无宿主子进程
   生命周期管理时会留下孤儿 typeperf/powershell），第一个 SSE 连接由 `lib/api.js:684` 打成
   `setVisible(true)`。GET-only 复核读数（`tmp/s18-get2.txt`）：`enabled:true` 而 `state:off`、
   `pid:null`、`series.netDown n=0` ⇒ 用户看到的正是截图里那句「网络吞吐 未开启」。
   注意别拿 `sup.state()` 当证据：假监督者恒报 'on'，断 `state==='on'` 是空断言。 */
await checkAsync('svc-15 首连（setVisible(true)）必须把默认开的 L1a 拉起来，隐藏不停它、重复首连不再起（S18-①）', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true } } });
  await w.svc.setVisible(true);
  assert.deepEqual(w.started, ['l1a'], `首连只该起默认开的那一路（实起 ${JSON.stringify(w.started)}）`);
  assert.equal(w.svc.snapshot().sources.find((r) => r.key === 'l1a').enabled, true, '开关意图仍是 true');
  await w.svc.setVisible(false);
  assert.deepEqual(w.stopped, [], '隐藏页面只停 l1b：l1a 跟着起停会白丢一窗暖身（spec §3.1）');
  for (let i = 0; i < 4; i++) await w.svc.setVisible(true);
  assert.equal(w.started.filter((k) => k === 'l1a').length, 1,
    `SSE 重连 / 切回页面各敲一次也只起 1 次（实起 ${w.started.filter((k) => k === 'l1a').length} 次）`);
  // 反向：库里说关 ⇒ 首连也不许自作主张起它（幂等门不等于「默认起」）
  const w2 = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: false } } });
  await w2.svc.setVisible(true);
  assert.deepEqual(w2.started, [], '开关意图是关 ⇒ 首连一起都不起');
  assert.equal(w2.svc.snapshot().sources.find((r) => r.key === 'l1a').enabled, false, '这一格的 enabled 也得跟着库');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);