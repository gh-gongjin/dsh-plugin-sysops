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

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
