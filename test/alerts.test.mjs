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

/* ①段：规则形状与置灰 */
const R = await import('../lib/alerts/rules.js');

const SRC = { l0: 'on', l1a: 'on', l1b: 'on', l2: 'on' };

check('rule-1 内置 5 条规则，与原型文案逐字一致', () => {
  assert.equal(R.DEFAULT_RULES.length, 5);
  assert.deepEqual(R.DEFAULT_RULES.map((r) => r.n), [
    'CPU ≥ 85% 连续 3 次',
    '内存占用率 ≥ 90%',
    'C 盘可用 < 15%',
    '下行持续 > 20 MB/s 满 1 分钟',
    '单进程 CPU > 60%',
  ]);
  assert.deepEqual(R.DEFAULT_RULES.map((r) => r.dep), ['l0', 'l0', 'l0', 'l1a', 'l1b']);
});

check('rule-2 依赖源关闭 → dim，且 st 说清是依赖问题不是用户关的', () => {
  const r = R.ruleState(R.DEFAULT_RULES[3], { ...SRC, l1a: 'off' });
  assert.equal(r.dim, true);
  assert.equal(r.on, false);
  assert.equal(r.st, '依赖的采集已关闭');
});

check('rule-3 用户关 → 不 dim，st 为「已暂停」', () => {
  const r = R.ruleState({ ...R.DEFAULT_RULES[4], userOff: true }, SRC);
  assert.equal(r.dim, false);
  assert.equal(r.st, '已暂停');
});

/* ②段：evaluate 阈值判定（假时钟，零 IO） */
const pts = (t0, step, vals) => vals.map((v, i) => ({ t: t0 + i * step, v }));
const cpuRule = R.DEFAULT_RULES[0]; // ≥85 连续 3 次，冷却 600s

check('rule-4 连续 N 次才报，差一次不报', () => {
  // 原稿这里写的是 [90, 91, 88] 却期望 null —— 三个点全 ≥85，`tail.every(breach)` 为真，
  // 按 Step 3 的实现必然报。沙箱取证（p9probe）：原稿 9/10，红就在 rule-4。
  // "差一次"要的是**尾部窗口里有一次不达标**，不是"数值看着不一样"。
  assert.equal(R.evaluate(cpuRule, pts(0, 1000, [90, 91, 30]), 3000, null), null, '第 3 次掉到阈值下 ⇒ 连续不成立');
  assert.equal(R.evaluate(cpuRule, pts(0, 1000, [90, 90, 90, 30, 30]), 5000, null), null,
    '约定 1：连续 N 次看的是尾部 N 个点，不是历史上累计出现过 N 次');
  const hit = R.evaluate(cpuRule, pts(0, 1000, [90, 91, 92]), 3000, null);
  assert.equal(hit.ruleId, 'r1');
  assert.equal(hit.value, 92);
  assert.equal(hit.name, 'CPU ≥ 85% 连续 3 次', 'name 是 alert_hit 的必填列，漏了它落库才炸');
  assert.equal(hit.t, 2000, '触发时刻是最后一个样本的时间，不是 now');
});

check('rule-5 冷却窗口内不重复报（异动是事件不是状态）', () => {
  const s = pts(0, 1000, [90, 91, 92]);
  assert.ok(R.evaluate(cpuRule, s, 3000, null));
  assert.equal(R.evaluate(cpuRule, s, 3000, 2500), null, '2.5s 前刚报过，600s 冷却内');
  assert.ok(R.evaluate(cpuRule, s, 3000, 2500 - 600_000), '冷却过了要能再报');
});

check('rule-6 方向：C 盘是「低于」阈值，网速是「高于」', () => {
  const disk = R.DEFAULT_RULES[2]; // <15%，cooldown 86400
  assert.ok(R.evaluate(disk, pts(0, 1000, [10]), 1000, null));
  assert.equal(R.evaluate(disk, pts(0, 1000, [40]), 1000, null), null);
  const net = R.DEFAULT_RULES[3]; // >20MB/s 满 1 分钟 = 60 个 1s 点
  assert.equal(R.evaluate(net, pts(0, 1000, Array(59).fill(30e6)), 59_000, null), null);
  assert.ok(R.evaluate(net, pts(0, 1000, Array(60).fill(30e6)), 60_000, null));
});

check('rule-7 点序不按时间递增时不评估（脏 ring 不该触发告警）', () => {
  assert.equal(R.evaluate(cpuRule, [{ t: 5000, v: 99 }, { t: 3000, v: 99 }, { t: 4000, v: 99 }], 9000, null), null);
});

check('rule-8 空点/样本不足/consecutive 大于点数 → 不报也不抛', () => {
  assert.equal(R.evaluate(cpuRule, [], 1000, null), null);
  assert.equal(R.evaluate({ ...cpuRule, consecutive: 99 }, pts(0, 1000, [99, 99, 99]), 3000, null), null);
});

check('rule-9 procCpu 是「单进程」判定：吃 rows 而不是时序点', () => {
  const r = R.DEFAULT_RULES[4];
  const rows = [{ pid: 1, name: 'a', cpuPct: 70 }, { pid: 2, name: 'b', cpuPct: 10 }];
  const hit = R.evaluateProc(r, rows, 8000);
  assert.equal(hit.note, 'a');
  assert.equal(hit.value, 70);
  assert.equal(R.evaluateProc(r, [{ pid: 2, name: 'b', cpuPct: 10 }], 8000), null);
  assert.equal(R.evaluateProc(r, [{ pid: 3, name: 'c', cpuPct: null }], 8000), null, 'CPU 列降级后不得凭 null 判定');
  // Task 7 的下游契约："pid 0 是聚合值行"这个排除动作归消费侧，落点就是这里。
  assert.equal(R.evaluateProc(r, [{ pid: 0, name: 'System Idle Process', cpuPct: 95 }], 8000), null,
    'pid 0 的 cpuPct 是 _Total/Idle 覆盖出的聚合值（真机 90–102%），不许报成"某进程吃满 60%"');
  const after = R.evaluateProc(r, [{ pid: 0, name: 'Idle', cpuPct: 95 }, { pid: 7, name: 'x', cpuPct: 80 }], 8000);
  assert.equal(after.note, 'x', '排除 pid 0 之后要继续扫下一行，不能整轮作废');
  assert.equal(after.value, 80);
  assert.equal(R.evaluateProc(r, [{ pid: null, name: 'y', cpuPct: 90 }], 8000).value, 90,
    'pid 为 null 是"读不到 pid 的真进程"（Task 7 契约 number|null），不许当聚合行误伤');
});

check('rule-10 ALERT_METRICS 与 prefs.alerts 的五个键一致（Task 3 与这里只能有一处真相）', () => {
  assert.deepEqual(R.ALERT_METRICS.slice().sort(), ['cpu', 'diskFreePct', 'mem', 'netDown', 'procCpu']);
});

/* ③段：alert_hit 仓储（内存桩，零真 IO） */
const { createAlertHitStore, RECORDS_ERROR } = await import('../lib/alerts/store.js');
const { ALERT_HIT_MAX, hitKey } = await import('../lib/alerts/spec.js');
const { createMemoryFacility } = await import('./_helpers.mjs');

const N = { info() {}, warn() {} };
// 判键不判值：`mkStore({ facility: undefined })` 要的就是"宿主没给 storageDomain"，
// 而默认形参会把 undefined 吃掉换成新桩 —— 沙箱现采：那种写法下 hit-3 第一条断言必红（available 反而是 true）。
// 与 test/prefs.test.mjs:153 的 `fresh(over)` 同一手法。
const mkStore = (over = {}) => {
  const facility = 'facility' in over ? over.facility : createMemoryFacility();
  return { facility, st: createAlertHitStore({ getFacility: () => facility, logger: N }) };
};
const hitRow = (t, ruleId = 'r1') => ({
  ruleId,
  name: 'CPU ≥ 85% 连续 3 次',
  metric: 'cpu',
  t,
  value: 90,
  note: '冷却 10 分钟 · 落点：监控页时间线',
});

await checkAsync('hit-1 append 后 list 倒序返回，且落库行带 hitId', async () => {
  const { st } = mkStore();
  assert.equal(st.available, true, '有设施就该报可用');
  await st.append(hitRow(1000));
  await st.append(hitRow(3000));
  await st.append(hitRow(2000));
  const rows = await st.list({ limit: 10 });
  assert.deepEqual(rows.map((r) => r.t), [3000, 2000, 1000], '倒序 = 新的在前');
  assert.equal(rows[0].hitId, hitKey(hitRow(3000)), 'hitId 由 hitKey 生成，界面拿它当 key');
  assert.equal(rows[0].name, 'CPU ≥ 85% 连续 3 次', 'name 是必填列，evaluate 那边漏了这里就会炸');
});

await checkAsync('hit-2 写满 201 条时最旧一条被裁掉，list 长度恒 ≤200', async () => {
  const { st } = mkStore();
  // t 故意跨位数（9 → 209）：按 key 字典序裁剪会把 t=209 之外判错方向，
  // `h-9-r1` 字典序大于 `h-10-r1` —— 这条用例就是逼实现按 Number(t) 排。
  for (let i = 0; i < ALERT_HIT_MAX + 1; i += 1) await st.append(hitRow(9 + i));
  const rows = await st.list({ limit: 500 });
  assert.equal(rows.length, ALERT_HIT_MAX, `上限 ${ALERT_HIT_MAX} 条，多一条都得裁`);
  assert.equal(rows[0].t, 209, '最新的那条必须留着');
  assert.equal(rows[rows.length - 1].t, 10, 't=9 是最旧的，必须被裁掉');
  assert.ok(!rows.some((r) => r.t === 9), '被裁的行不许还在');
});

await checkAsync('hit-3 无 facility 是降级不是异常：available=false 且读写抛 RECORDS_UNAVAILABLE', async () => {
  const { st } = mkStore({ facility: undefined });
  assert.equal(st.available, false);
  await assert.rejects(() => st.append(hitRow(1000)), { code: RECORDS_ERROR.UNAVAILABLE });
  await assert.rejects(() => st.list(), { code: RECORDS_ERROR.UNAVAILABLE });
  // 给了设施但 open 失败：available 仍 true（它探测的是"宿主给没给设施"），但读抛带 code 的错误且保留原始 message
  const w = mkStore({ facility: { open: () => Promise.reject(new Error('already open')) } });
  assert.equal(w.st.available, true);
  await assert.rejects(() => w.st.list(), { code: RECORDS_ERROR.UNAVAILABLE, message: /already open/ });
  // open 失败不许被缓存成坏 promise：下次调用要重开一次（与 prefs 的 `opening = null` 同形）
  let tries = 0;
  const flaky = { open: () => { tries += 1; return Promise.reject(new Error('第 ' + tries + ' 次 open 失败')); } };
  const f = mkStore({ facility: flaky }).st;
  await assert.rejects(() => f.list(), { code: RECORDS_ERROR.UNAVAILABLE });
  await assert.rejects(() => f.list(), { code: RECORDS_ERROR.UNAVAILABLE });
  assert.equal(tries, 2, '两次读各敲一次 open —— 缓存住失败会让仓储永久瘫着');
});

await checkAsync('hit-4 脏记录（缺 ruleId）被 schema 挡在门外，抛错信息点名 alert_hit.ruleId', async () => {
  const { st } = mkStore();
  const dirty = hitRow(1000);
  delete dirty.ruleId;
  await assert.rejects(
    () => st.append(dirty),
    (e) => e.code === RECORDS_ERROR.INVALID && /alert_hit\.ruleId/.test(e.message),
    '脏行必须落成带 code 的 INVALID，裸 Error 会让 Task 18 落进 default 分支',
  );
  assert.equal((await st.list({ limit: 10 })).length, 0, '被挡在门外的行不许留半条');
});

await checkAsync('hit-5 close() 是终态；换实例复用同一域仍读得到关前的行', async () => {
  const w = mkStore();
  await w.st.append(hitRow(1000));
  await w.st.close();
  assert.equal(w.st.available, false, '与 prefs 同形：close 过的实例不再报可用');
  await assert.rejects(() => w.st.append(hitRow(2000)), { code: RECORDS_ERROR.CLOSED });
  const again = createAlertHitStore({ getFacility: () => w.facility, logger: N });
  assert.equal(again.available, true);
  assert.deepEqual((await again.list({ limit: 10 })).map((r) => r.t), [1000],
    '记录在宿主域里，不在 store 实例的内存里 —— 换实例不许把历史丢掉');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
