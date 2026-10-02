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
const { ALERT_HIT_MAX, hitKey } = await import('../lib/records/spec.js');
const { createMemoryFacility } = await import('./_helpers.mjs');

const N = { info() {}, warn() {} };
// 判键不判值：`mkStore({ facility: undefined })` 要的就是"宿主没给 storageDomain"，
// 而默认形参会把 undefined 吃掉换成新桩 —— 沙箱现采：那种写法下 hit-3 第一条断言必红（available 反而是 true）。
// 与 test/prefs.test.mjs ③段的 `fresh(over)` 同一手法（判名不判行号，搬桩挪段落都不会失效）。
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
  note: '冷却 10 分钟 · 落点：触发记录页',
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

await checkAsync('hit-6 close 必须减「当初 acquire 那个设施」的 refs：getFacility 每次给新对象也不许漏', async () => {
  // F-4：宿主 Context 是代理，`getFacility()` 每读一次都可能给出新的包装对象；
  // 而登记表按**设施对象**查 entry（WeakMap key）。close 时若重新 facilityOf()，
  // 减的是查无此人的 refs ⇒ 域永不关闭（C2），下一个实例再 open 撞 already-open（C3）。
  const inner = createMemoryFacility();
  const fresh = () => ({ open: (spec) => inner.open(spec) });
  const st = createAlertHitStore({ getFacility: fresh, logger: N });
  await st.append(hitRow(1000));
  await st.close();
  assert.deepEqual(inner.stats, { opens: 1, closes: 1 }, '最后一个持有者放手时必须真的把域关掉');
  const again = createAlertHitStore({ getFacility: fresh, logger: N });
  assert.deepEqual((await again.list({ limit: 10 })).map((r) => r.t), [1000],
    '名字释放后新实例要能重新 open 并读到旧行');
  await again.close();
  assert.deepEqual(inner.stats, { opens: 2, closes: 2 }, '两次开关配平，不留悬空持有');
});

/* ④段：prefs 阈值覆盖内置规则 */
check('merge-1 覆盖数值与冷却，冷却按秒换算成毫秒', () => {
  const out = R.mergeRules(R.DEFAULT_RULES, { cpu: { value: 95, consecutive: 5, cooldownSec: 120 } });
  const cpu = out.find((r) => r.metric === 'cpu');
  assert.equal(cpu.value, 95);
  assert.equal(cpu.consecutive, 5);
  assert.equal(cpu.cooldownMs, 120_000);
  assert.equal(out.find((r) => r.metric === 'mem').value, 90, '未覆盖的规则原样保留');
});

check('merge-2 enabled:false 映射为 userOff（置灰分支与依赖分支是两回事）', () => {
  const out = R.mergeRules(R.DEFAULT_RULES, { procCpu: { value: 60, consecutive: 1, cooldownSec: 600, enabled: false } });
  assert.equal(out.find((r) => r.metric === 'procCpu').userOff, true);
});

check('merge-3 不修改入参（DEFAULT_RULES 是常量表，改一次就污染全局）', () => {
  const before = JSON.stringify(R.DEFAULT_RULES);
  R.mergeRules(R.DEFAULT_RULES, { cpu: { value: 1, consecutive: 1, cooldownSec: 60 } });
  assert.equal(JSON.stringify(R.DEFAULT_RULES), before);
});

check('merge-4 未知指标键忽略但可被发现；缺字段的覆盖不半套生效', () => {
  const out = R.mergeRules(R.DEFAULT_RULES, { gpu: { value: 1 }, mem: { value: 70 } });
  assert.equal(out.find((r) => r.metric === 'mem').value, 70);
  assert.equal(out.find((r) => r.metric === 'mem').consecutive, 1, 'consecutive 未覆盖时保留内置值');
  assert.equal(out.length, R.DEFAULT_RULES.length);
});

/* ⑤段：告警服务（假 collect + 假 hitStore + 假时钟） */
const { createAlertService } = await import('../lib/alerts/service.js');

/**
 * 假世界三条约定，缺一条就会把编排测成假绿：
 *  1. **每个采样点自带 1 秒推进**。`evaluate` 前面有 Task 9 的点序闸门
 *     （`tail[i].t > tail[i-1].t` 严格递增），时钟不推进 ⇒ 三点同 `t` ⇒ 永远不报，
 *     alert-1/2/6/8 全部只是"没测到"而不是"测错了"。
 *  2. **订阅者存成数组**。`dispose()` 走的是 unsub 路径，桩里只留一个 `_cb` 的话
 *     退订与重复订阅都看不见（`start()` 两次也只是覆盖同一个变量）。
 *  3. **落库是异步的**，`alert-store` 失败事件要等一回合才到 listeners，
 *     所以需要 `tick()`；成功分支不用（假 `append` 体里没有 await，push 在同步段就跑完了）。
 */
function alertWorld(over = {}) {
  let t = 0;
  const events = [];
  const appended = [];
  const cbs = [];
  const srcStates = over.srcStates ?? { l0: 'on', l1a: 'on', l1b: 'on' };
  const series = { cpu: [], mem: [], diskFreePct: [], netDown: [], netUp: [], ...over.series };
  const collect = {
    snapshot: () => ({
      series,
      latest: {},
      cadence: over.cadence ?? '1s',
      sources: Object.entries(srcStates).map(([key, state]) => ({ key, state })),
      proc: { rows: over.procRows ?? [] },
    }),
    onEvent: (cb) => {
      cbs.push(cb);
      return () => { const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1); };
    },
  };
  const hitStore = over.noStore ? null : {
    available: true,
    append: async (h) => { if (over.storeFails) throw new Error('disk full'); appended.push(h); return h; },
    // `listFails` 造的是"宿主给了 storageDomain（available 仍 true），但记录域 open() 失败"这条真实降级路：
    // 抛的必须是带 code 的 RECORDS_UNAVAILABLE —— 形状照 `lib/alerts/store.js:66-81`，钉的就是 service 那层收口。
    list: async ({ limit } = {}) => {
      if (over.listFails) { const e = new Error('告警记录域 open 失败'); e.code = 'RECORDS_UNAVAILABLE'; throw e; }
      return appended.slice(-limit).reverse();
    },
  };
  const svc = createAlertService({
    collect,
    hitStore,
    getRulePrefs: () => over.alertPrefs,
    now: () => t,
    logger: { warn(msg) { events.push({ type: 'log', msg }); } },
  });
  svc.onEvent((e) => events.push(e));
  svc.start();
  const adv = (ms) => { t += ms; };
  const fire = (ev) => cbs.slice().forEach((cb) => cb(ev));
  const emitPoint = (key, v) => { t += 1000; series[key].push({ t, v }); fire({ type: 'metrics', key, point: { t, v } }); };
  const emitProc = (rows) => { over.procRows = rows; fire({ type: 'proc', rows }); };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { svc, adv, t: () => t, events, appended, cbs, emitPoint, emitProc, tick, series, srcStates };
}

await checkAsync('alert-1 CPU 连续 3 次越线 → emit alert 且落库一次', async () => {
  const w = alertWorld();
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91);
  assert.equal(w.events.filter((e) => e.type === 'alert').length, 0, '两次不够，别提前报');
  w.emitPoint('cpu', 92);
  const t3 = w.t(); // 第三个采样点的时间（假世界的约定 1：每点自带 1s 推进，此处 = 3000）
  await w.tick(); // record 的尾巴（append 之后）是异步的，不 settle 就数不清几次
  const hit = w.events.find((e) => e.type === 'alert').hit;
  assert.equal(hit.ruleId, 'r1');
  assert.equal(w.appended.length, 1);
  assert.equal(w.events.filter((e) => e.type === 'alert').length, 1, '一次命中只能有一条 alert');
  assert.equal(w.appended[0], hit, '落库的对象必须就是判定返回的那个 hit，service 不许半路换成别的形状');
  assert.equal(w.appended[0].t, t3, '落库时间取第三个采样点的 t（触发时刻），不是 now');
});

await checkAsync('alert-2 冷却内再越线不重复报（时间线会被同一次尖峰刷屏）', async () => {
  const w = alertWorld();
  for (const v of [90, 91, 92]) w.emitPoint('cpu', v);
  w.adv(1000);
  w.emitPoint('cpu', 99);
  await w.tick();
  assert.equal(w.appended.length, 1, `冷却 10 分钟，第二次不该落库，实得 ${w.appended.length}`);
});

await checkAsync('alert-3 依赖源关了 → 整条规则不评估（不是评估后隐藏）', async () => {
  const w = alertWorld({ srcStates: { l0: 'on', l1a: 'off', l1b: 'on' } });
  for (let i = 0; i < 70; i++) { w.adv(1000); w.emitPoint('netDown', 30e6); }
  assert.equal(w.appended.length, 0);
  assert.equal(w.svc.ruleRows().find((r) => r.rule.id === 'r4').st.dim, true);
});

await checkAsync('alert-4 档位暂停 = l0 源 off → cpu/mem/磁盘三条一起置灰', async () => {
  const w = alertWorld({ srcStates: { l0: 'off', l1a: 'on', l1b: 'on' } });
  w.emitPoint('cpu', 99);
  const rows = w.svc.ruleRows();
  assert.deepEqual(rows.filter((r) => r.rule.dep === 'l0').map((r) => r.st.dim), [true, true, true]);
  assert.equal(w.appended.length, 0);
});

await checkAsync('alert-5 用户关掉规则 → 不报，但 st 是「已暂停」不是「依赖关闭」', async () => {
  const w = alertWorld({ alertPrefs: { mem: { value: 90, consecutive: 1, cooldownSec: 900, enabled: false } } });
  w.emitPoint('mem', 99);
  assert.equal(w.appended.length, 0);
  assert.equal(w.svc.ruleRows().find((r) => r.rule.id === 'r2').st.st, '已暂停');
});

await checkAsync('alert-6 未读计数：命中 +1，markRead 归零（驱动侧边栏蓝点）', async () => {
  const w = alertWorld();
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  await w.tick(); // 只能在 record 全落定后断言，否则"命中 +1 且只 +1"是撞对的
  assert.equal(w.svc.unread(), 1);
  w.svc.markRead();
  assert.equal(w.svc.unread(), 0);
});

await checkAsync('alert-7 procCpu 走 rows 判定，命中后 note 是进程名', async () => {
  const w = alertWorld({ alertPrefs: { procCpu: { value: 60, consecutive: 1, cooldownSec: 600, enabled: true } } });
  w.emitProc([{ pid: 1, name: 'render.exe', ws: 1, cpuPct: 88 }]);
  const hit = w.appended[0];
  assert.equal(hit.metric, 'procCpu');
  assert.equal(hit.note, 'render.exe');
});

await checkAsync('alert-8 落库失败不静默：转成 alert-store 事件 + logger.warn', async () => {
  const w = alertWorld({ storeFails: true });
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  await w.tick(); // append 的 rejection 在下一个微任务回合才落到 catch，不等就永远看不到这条事件
  const e = w.events.find((x) => x.type === 'alert-store');
  assert.ok(e, '必须有一条可见的失败事件');
  assert.match(e.error, /disk full/);
  assert.ok(w.events.some((x) => x.type === 'log'));
  assert.equal(w.svc.unread(), 1, '落库失败不影响未读计数');
});

await checkAsync('alert-9 宿主没给 storageDomain：仍评估仍计未读，但写与读都是可见的降级', async () => {
  const w = alertWorld({ noStore: true });
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  assert.equal(w.appended.length, 0);
  assert.equal(w.svc.unread(), 1, '没库也要报到人前');
  const e = w.events.find((x) => x.type === 'alert-store');
  assert.ok(e && /storageDomain/.test(e.error), '不可用必须是事件，不是沉默');
  assert.ok(w.events.some((x) => x.type === 'log'));
  const r = await w.svc.hits({ limit: 10 });
  assert.deepEqual(r, { rows: [], error: 'storageDomain 不可用' });
});

await checkAsync('alert-10 dispose 退订：之后的采样点不再产生任何事件，start() 两次也只订阅一次', async () => {
  const w = alertWorld();
  w.svc.start(); // 重复 start 必须被去重，否则一次尖峰会报两遍
  assert.equal(w.cbs.length, 1, `start() 两次不该留两条订阅，实有 ${w.cbs.length}`);
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91);
  w.svc.dispose();
  assert.equal(w.cbs.length, 0, 'dispose 必须真的从桩里退订');
  w.emitPoint('cpu', 92);
  assert.equal(w.appended.length, 0, 'dispose 后必须退订');
  assert.equal(w.svc.unread(), 0);
});

await checkAsync('alert-11 一个监听器抛错不许影响别的监听器与落库', async () => {
  const w = alertWorld();
  const got = [];
  // 抛错的那个注册在前、正常的在后：无逐监听器隔离时它一甩手，`alert` 收不到、
  // record 的尾巴（落库 + 降级事件）也整段跑不到，只剩 unreadCount +1 —— 那正是评审 I-1 的现场。
  w.svc.onEvent(() => { throw new Error('SSE 写失败'); });
  w.svc.onEvent((e) => got.push(e));
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  await w.tick();
  assert.equal(got.filter((e) => e.type === 'alert').length, 1, '后面的监听器必须照样收到 alert');
  assert.equal(w.appended.length, 1, '监听器抛错不许打断落库（时间线是事实，不是通知的副产品）');
  assert.equal(w.svc.unread(), 1, '未读计数只加一次，不因隔离多算或漏算');
  assert.ok(w.events.some((e) => e.type === 'log' && /SSE 写失败/.test(e.msg)),
    '被甩出的监听器必须留痕（spec §4.7 禁的是不留痕的静默 catch）');
});

await checkAsync('alert-12 proc 冷却：进程榜连发多轮只落一条', async () => {
  const w = alertWorld({ alertPrefs: { procCpu: { value: 60, consecutive: 1, cooldownSec: 600, enabled: true } } });
  w.emitProc([{ pid: 1, name: 'render.exe', ws: 1, cpuPct: 88 }]);
  w.adv(1000); // 真机上 l1b 每 1.6–1.9s 出一轮：这一秒的推进就是"冷却 600s 之内"
  w.emitProc([{ pid: 1, name: 'render.exe', ws: 1, cpuPct: 95 }]);
  await w.tick();
  // 这条钉的是 `evaluateProc(..., lastHitAt.get(rule.id))` 那个入参：漏传一次时间线就被同一个进程每秒刷满、蓝点无界增长。
  assert.equal(w.appended.length, 1, `冷却 600s 内两轮进程榜只该落一条，实得 ${w.appended.length}`);
  assert.equal(w.events.filter((e) => e.type === 'alert').length, 1);
  assert.equal(w.svc.unread(), 1);
});

await checkAsync('alert-13 hits() 可用分支原样透传 list 的顺序与 limit', async () => {
  const w = alertWorld();
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92); // r1
  w.emitPoint('mem', 99);                                                 // r2
  w.emitPoint('diskFreePct', 10);                                         // r3
  await w.tick();
  assert.equal(w.appended.length, 3, '三条规则各命中一次，才有"顺序"可钉');
  const r = await w.svc.hits({ limit: 2 });
  assert.equal(r.error, null, '可用分支读成功时 error 必须是 null');
  assert.equal(r.rows.length, 2, 'limit 必须原样交给 store（假 store 吞掉 limit 就返回 3 条）');
  assert.equal(r.rows[0], w.appended[2], '行对象与顺序原样透传：倒序是 store 的契约，service 不重排不拷贝');
  assert.equal(r.rows[1], w.appended[1]);
});

await checkAsync('alert-14 hits() 在 available=true 但 list() 抛错时降级，不甩 rejection', async () => {
  // 造的是"宿主给了 storageDomain（available 仍 true），但记录域 open() 失败"这条真实降级路（store.js:66-81）。
  const bad = alertWorld({ listFails: true });
  assert.deepEqual(await bad.svc.hits({ limit: 5 }),
    { rows: [], error: '告警记录域 open 失败', code: 'RECORDS_UNAVAILABLE' },
    'Task 18 按 e.code 分支（store.js:18），把 rejection 甩上去就是重试风暴打死宿主');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
