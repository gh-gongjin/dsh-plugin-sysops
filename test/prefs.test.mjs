import assert from 'node:assert/strict';
import { createMemoryFacility } from './_helpers.mjs';

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

/* ①段：kv-schema 底座 */
const { defineDomain, domainTable, record, requiredString, optionalInt, optionalString, UNIT_NAME_RE } =
  await import('../lib/kv-schema.js');

check('schema-1 record 丢弃未声明字段（确定性优先）', () => {
  const r = record({ a: requiredString('a'), b: optionalInt('b') });
  const out = r.parse({ a: 'x', b: 1, zz: '脏字段' });
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b']);
});

check('schema-2 空串视为未填，直接拒绝', () => {
  const r = record({ a: requiredString('a') });
  assert.throws(() => r.parse({ a: '   ' }), /a 必填/);
});

check('schema-3 defineDomain 挡下非法 domain 名 / 表名 / 接受 null 的 global', () => {
  assert.throws(() => defineDomain({ name: 'Sysops-Prefs', version: 1, tables: { t: domainTable(record({})) } }),
    /domain 名/);
  assert.throws(() => defineDomain({ name: 'sysops_prefs', version: 1, tables: { 'Bad-Table': domainTable(record({})) } }),
    /表名/);
  // 「接受 null 的 global」要用真能吞下 null 的 schema 才触发守卫：
  // record({}) 拒绝 null（不是 plain object），optionalString 才会把 null 归一成 undefined。
  assert.throws(() => defineDomain({ name: 'sysops_prefs', version: 1, tables: { t: domainTable(record({})) }, global: { schema: optionalString('g') } }),
    /不能接受 null/);
});

/* ②段：prefs domain 声明 */
const { prefsDomain, PREF_KEYS, PREF_ROW_KEY, COLLECT_CADENCE, SOURCE_KEYS } =
  await import('../lib/prefs/spec.js');

check('prefs-1 domain 名合法且两张表', () => {
  assert.equal(prefsDomain.name, 'sysops_prefs');
  assert.equal(prefsDomain.version, 1);
  assert.deepEqual(PREF_KEYS.slice().sort(), ['clean_rules', 'prefs']);
  assert.deepEqual(Object.keys(prefsDomain.tables).sort(), ['clean_rules', 'prefs']);
  // 字面量钉住：KV 行键 / 采集档位白名单 / 源开关集合 —— Task 5–8 与 18 按字面量对接，
  // 今天改一个字母全套测试照样绿就是事故源头。
  assert.equal(PREF_ROW_KEY, 'current');
  assert.deepEqual([...COLLECT_CADENCE], ['1s', '5s', 'paused']);
  assert.deepEqual([...SOURCE_KEYS], ['l0', 'l1a', 'l1b', 'l2']);
});

check('prefs-2 prefs 记录：采样档位白名单、源开关三态、脏字段丢弃', () => {
  const t = prefsDomain.tables.prefs.valueSchema;
  const good = t.parse({ collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: false } });
  assert.deepEqual(good.collect, { cadence: '1s', keepMinutes: 30 });
  assert.equal(good.sources.l1b, undefined, '未声明的源不该被凭空补值');
  assert.throws(() => t.parse({ collect: { cadence: '2s' } }), /cadence/);
  assert.throws(() => t.parse({ sources: { l9: true } }), /l9/);
  assert.throws(() => t.parse({ collect: { keepMinutes: 0 } }), /keepMinutes/);
  // 非对象输入必须报"sources 必须是对象"，而不是 Object.keys('all') 误报出的源开关 '0'
  assert.throws(() => t.parse({ sources: 'all' }), /sources 必须是对象/);
});

check('prefs-3 prefs 记录：告警阈值、搜索通路、限定目录、null 与空数组的区别', () => {
  const t = prefsDomain.tables.prefs.valueSchema;
  const r = t.parse({ search: { walkDirs: [], port: 3417, esPath: 'D:\\tools\\es.exe' }, alerts: { cpu: { value: 85, consecutive: 3, cooldownSec: 600 } } });
  assert.deepEqual(r.search.walkDirs, [], '用户主动清空必须存得下来（不等于从未写入）');
  assert.equal(r.search.port, 3417, 'Task 16/17 与设置页都读这一键，进不了库就是假配置');
  assert.equal(r.search.esPath, 'D:\\tools\\es.exe');
  assert.throws(() => t.parse({ search: { port: 0 } }), /port/);
  assert.throws(() => t.parse({ search: { port: 70000 } }), /port/);
  assert.throws(() => t.parse({ search: { port: '3417' } }), /port/);
  assert.throws(() => t.parse({ alerts: { cpu: { value: '85', consecutive: 3, cooldownSec: 60 } } }), /value/);
  assert.throws(() => t.parse({ alerts: { cpu: { value: 85, consecutive: 0, cooldownSec: 60 } } }), /consecutive/);
  assert.throws(() => t.parse({ alerts: { cpu: { value: 85, consecutive: 1, cooldownSec: 5 } } }), /cooldownSec/);
  // search.mode 白名单必须有真断言：改名 mode 白名单不能无声漂掉
  assert.throws(() => t.parse({ search: { mode: 'find' } }), /mode/);
});

check('prefs-4 clean_rules：本机新增规则的形状，glob 必填、拒绝形状进库', () => {
  const t = prefsDomain.tables.clean_rules.valueSchema;
  // 夹具补 `kind`：Task 11 把 kind 变成 items[] 必填字段（schema 演进），这是夹具随动，
  // 三条拒绝路径与断言原样保留。
  const r = t.parse({ items: [{ id: 'u-1', n: '浏览器缓存', glob: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*', ageDays: 7, kind: '缓存' }], updatedAt: 1 });
  assert.equal(r.items[0].glob, 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*');
  assert.equal(r.items[0].ageDays, 7);
  assert.throws(() => t.parse({ items: [{ id: 'u-1', n: '缺 glob', ageDays: 1 }] }), /glob/);
  assert.throws(() => t.parse({ items: [{ id: 'u-1', n: 'x', glob: 'C:\\a\\b\\*', ageDays: -3 }] }), /ageDays/);
});

/* ③段：store 行为（内存桩在 ./_helpers.mjs，与本文件顶部的 import 同一份） */
const { createPrefStore, PREFS_ERROR } = await import('../lib/prefs/store.js');

const fresh = (over = {}) => {
  // 判键在不在，不判值：`fresh({ facility: undefined })` 要的就是"宿主没有 storageDomain"，
  // 用 `over.facility === undefined` 判会把它当成"没传"而塞进内存桩，prefs-9 就什么也没测到。
  const facility = 'facility' in over ? over.facility : createMemoryFacility();
  return createPrefStore({ getFacility: () => facility, now: () => 777, logger: { warn() {} }, ...over });
};

await checkAsync('prefs-5 readAll：从未写入返回 null，而不是 []', async () => {
  const s = fresh();
  const all = await s.readAll();
  assert.deepEqual(all, { prefs: null, clean_rules: null });
});

await checkAsync('prefs-6 write 覆盖同 key（偏好的本职就是要被改）', async () => {
  const s = fresh();
  await s.write('prefs', { collect: { cadence: '1s' } });
  await s.write('prefs', { collect: { cadence: '5s' } });
  const back = await s.read('prefs');
  assert.equal(back.collect.cadence, '5s');
  assert.equal(back.updatedAt, 777, 'updatedAt 由仓储统一加盖');
});

await checkAsync('prefs-7 空数组能存下来，与 null 不是一回事', async () => {
  const s = fresh();
  await s.write('prefs', { search: { walkDirs: [] } });
  const back = await s.read('prefs');
  assert.deepEqual(back.search.walkDirs, []);
});

await checkAsync('prefs-8 未知 key 拒绝；writeMany 跳过未知键但不拖垮整批', async () => {
  const s = fresh();
  await assert.rejects(() => s.write('nope', {}), (e) => e.code === PREFS_ERROR.UNKNOWN_KEY);
  const { written, skipped } = await s.writeMany({ prefs: { collect: { cadence: '1s' } }, nofix: {}, clean_rules: null });
  assert.deepEqual(Object.keys(written), ['prefs']);
  assert.deepEqual(skipped.sort(), ['clean_rules', 'nofix']);
  // 脏值写入必须以带 code 的 INVALID 失败（消息要能指明是哪一份设置）
  await assert.rejects(
    () => s.write('prefs', { collect: { cadence: 'nope' } }),
    (e) => e.code === PREFS_ERROR.INVALID && /偏好 prefs 校验失败/.test(e.message),
    '脏 prefs 写入要落成 PREFS_INVALID，不能是裸 Error',
  );
});

await checkAsync('prefs-9 无 storageDomain 是降级不是异常：available=false 且读抛 UNAVAILABLE', async () => {
  const s = fresh({ facility: undefined });
  assert.equal(s.available, false);
  await assert.rejects(() => s.readAll(), (e) => e.code === PREFS_ERROR.UNAVAILABLE);
  // 给了设施但 open 失败：available 仍 true（能力探测，不看上次 open 成败），
  // 但读必须抛带 code PREFS_UNAVAILABLE 的错误，且保留原始 message 供排查。
  const s2 = fresh({ facility: { open: () => Promise.reject(new Error('already open')) } });
  assert.equal(s2.available, true);
  await assert.rejects(() => s2.readAll(), { code: PREFS_ERROR.UNAVAILABLE, message: /already open/ });
});

await checkAsync('prefs-10 close() 必须可 await，且 close 后写报 CLOSED', async () => {
  const s = fresh();
  await s.write('prefs', { collect: { cadence: '1s' } });
  await s.close();
  await assert.rejects(() => s.write('prefs', { collect: { cadence: '5s' } }), (e) => e.code === PREFS_ERROR.CLOSED);
});

/* ④段：内置规则库 + 本机规则仓储 */
const guardMod = await import('../lib/clean/guard.js');
const prefsMod = await import('../lib/prefs/spec.js');
const CR = await import('../lib/clean/rules.js');
const { createRuleStore, RULE_ERROR } = await import('../lib/prefs/rules-store.js');

check('rules-1 内置库只收本机实测存在的路径（凭印象列路径 = 清单永远 0 命中）', () => {
  assert.equal(CR.BUILTIN_RULES.length, 12); // WER 实测不存在，见 Step 3 下方的现采说明
  for (const r of CR.BUILTIN_RULES) {
    assert.ok(/^[a-z0-9._-]+$/.test(r.id), `规则 id 非法：${r.id}`);
    assert.ok(CR.RULE_KINDS.includes(r.kind), `${r.id} 的 kind 不在表内：${r.kind}`);
    assert.ok(r.readonly === true, '内置规则不可被用户改');
    assert.ok(r.ageDays >= 0);
  }
  // 明确排除：实测不存在的 7 条不能混进来
  const banned = ['Crashpad', 'NuGet', '.npm', '.pnpm-store', 'WeChat Runtime'];
  for (const b of banned) {
    assert.ok(!CR.BUILTIN_RULES.some((r) => r.dir.includes(b) || r.glob.includes(b)), `实测不存在的路径进了内置库：${b}`);
  }
  // DEFAULT_OFF 里的 id 必须真实存在：拼错一个字母 = 那条默认关永远关不上，且不会有任何报错
  for (const id of CR.DEFAULT_OFF) {
    assert.ok(CR.BUILTIN_RULES.some((r) => r.id === id), `DEFAULT_OFF 引用了不存在的内置规则 id：${id}`);
  }
});

check('rules-2 每条内置规则的字面量与 glob 都能过 guard（自产规则先过红线）', () => {
  const { check } = guardMod;
  for (const r of CR.BUILTIN_RULES) {
    const a = check(r.dir, { mode: 'path' });
    assert.equal(a.allow, true, `${r.id} 的 dir 被 guard 拒了：${a.code} ${a.why}`);
    const b = check(r.glob, { mode: 'glob' });
    assert.equal(b.allow, true, `${r.id} 的 glob 被 guard 拒了：${b.code} ${b.why}`);
  }
});

check('rules-3 enabledBuiltin 按 offIds 过滤，内置开关不改动常量表', () => {
  const before = CR.BUILTIN_RULES.length;
  const on = CR.enabledBuiltin([CR.BUILTIN_RULES[0].id]);
  assert.equal(on.length, before - 1);
  assert.equal(CR.BUILTIN_RULES.length, before);
});

check('rules-4 clean_rules 记录形状：off 是内置规则 id 数组，脏形状进不了库', () => {
  const t = prefsMod.cleanRulesRecord;
  const r = t.parse({ items: [], off: ['temp-user', 'npm-cache'], updatedAt: 1 });
  assert.deepEqual(r.off, ['temp-user', 'npm-cache']);
  assert.throws(() => t.parse({ items: [], off: 'temp-user' }), /off/);
  assert.throws(() => t.parse({ items: [], off: [1] }), /off/);
  // kind 必须在 schema 里声明：arrayOf 会丢未声明字段，丢了以后 validate() 会在每次读规则时抛错
  const one = t.parse({ items: [{ id: 'u-1', n: 'x', glob: 'C:\\x\\*', ageDays: 1, kind: '缓存' }], off: [], updatedAt: 1 });
  assert.equal(one.items[0].kind, '缓存', 'kind 没存住 = 被 arrayOf 静默丢字段');
  assert.throws(() => t.parse({ items: [{ id: 'u-1', n: 'x', glob: 'C:\\x\\*', ageDays: 1 }], off: [], updatedAt: 1 }), /kind/);
});

const userRule = (over = {}) => ({
  id: 'u-1', n: 'pnpm 未引用包', glob: 'C:\\Users\\gongj\\AppData\\Local\\pnpm\\store\\*',
  ageDays: 30, kind: '缓存', ...over,
});

const ruleWorld = (over = {}) => {
  // **判键在不在，不判值**：`ruleWorld({ facility: undefined })` 要的就是"宿主没有 storageDomain"，
  // 写成 `over.facility === undefined ? 内存桩 : over.facility` 会把它当成"没传"而塞进内存桩，
  // rules-10 就什么也没测到（③段 prefs-9 踩过同一处，注释在 `test/prefs.test.mjs:122-127`）。
  const facility = 'facility' in over ? over.facility : createMemoryFacility();
  const prefStore = createPrefStore({ getFacility: () => facility, now: () => 1000, logger: { warn() {} } });
  return { prefStore, store: createRuleStore({ prefStore, logger: { warn() {} } }) };
};

await checkAsync('rules-5 新增本机规则：合法 glob 入库，返回归一化全量', async () => {
  const w = ruleWorld();
  const out = await w.store.add(userRule());
  assert.equal(out.items.length, 1);
  // updatedAt 是**行级**戳（record 只有行级），由 prefStore.write 盖；断成 items[0].updatedAt 会永远 undefined
  assert.equal(out.updatedAt, 1000);
  assert.equal(out.items[0].kind, '缓存', '走完整写-读一轮回来看 kind 存没存住');
});

await checkAsync('rules-6 命中红线的规则在**写入阶段**就被拒（不是执行阶段才失败）', async () => {
  const w = ruleWorld();
  for (const bad of [
    'C:\\Windows\\Temp\\*',
    'C:\\$Recycle.Bin\\S-1-5-21\\*',
    'C:\\Program Files\\SomeApp\\*',
    'C:\\Users\\gongj\\AppData\\Local\\Temp\\..\\..\\..\\*',
    'C:\\Users\\gongj\\AppData\\Local\\**',
  ]) {
    await assert.rejects(
      () => w.store.add(userRule({ glob: bad })),
      (e) => e.code === RULE_ERROR.GUARD_DENY && e.why.length > 0,
      `应拒绝写入：${bad}`,
    );
  }
  const all = await w.store.list();
  assert.equal(all.items.length, 0, '被拒的规则不得留半条');
});

await checkAsync('rules-7 展开名不采信：规则里的 glob 必须已展开成绝对路径', async () => {
  const w = ruleWorld();
  await assert.rejects(() => w.store.add(userRule({ glob: '%LOCALAPPDATA%\\pnpm\\*' })), (e) => e.code === RULE_ERROR.GUARD_DENY);
});

await checkAsync('rules-8 activeRules = 开启的内置 + 用户规则，按 guard 过滤后才交给扫描器', async () => {
  const w = ruleWorld();
  await w.store.add(userRule());
  const rows = await w.store.activeRules();
  // 从未写入过 ⇒ off 取 DEFAULT_OFF，所以「开着的内置」是 12 - DEFAULT_OFF.length，不是 12
  assert.equal(rows.filter((r) => r.readonly).length, CR.BUILTIN_RULES.length - CR.DEFAULT_OFF.length);
  assert.equal(rows.filter((r) => !r.readonly).length, 1);
  assert.ok(rows.every((r) => r.glob && r.ageDays >= 0));
});

await checkAsync('rules-9 toggle 内置规则写入 off；remove 删用户规则，未知 id 报 UNKNOWN_ID', async () => {
  const w = ruleWorld();
  await w.store.add(userRule());
  const first = CR.BUILTIN_RULES[0].id;
  // 本例假设"首条内置规则默认是开的"；哪天它进了 DEFAULT_OFF，关-开两步就变成空操作而仍然全绿
  assert.ok(!CR.DEFAULT_OFF.includes(first), `首条内置规则 ${first} 已默认关闭，本例失效`);
  await w.store.toggle(first, false);
  let all = await w.store.list();
  // 从未写入时 off 以 DEFAULT_OFF 打底，所以断"包含"而不是断"等于那一条"
  assert.deepEqual([...all.off].sort(), [...CR.DEFAULT_OFF, first].sort());
  await w.store.toggle(first, true);
  assert.deepEqual([...(await w.store.list()).off].sort(), [...CR.DEFAULT_OFF].sort());
  await w.store.remove('u-1');
  assert.equal((await w.store.list()).items.length, 0);
  await assert.rejects(() => w.store.remove('u-404'), (e) => e.code === RULE_ERROR.UNKNOWN_ID);
});

await checkAsync('rules-10 存储不可用时 error 有值、activeRules 只剩内置（清理页仍可用，但看不到本机规则）', async () => {
  const w = ruleWorld({ facility: undefined });
  const rows = await w.store.activeRules();
  // 同样减去默认关那两条：无库时读到的 off 就是 DEFAULT_OFF，不是空数组
  assert.equal(rows.length, CR.BUILTIN_RULES.length - CR.DEFAULT_OFF.length);
  assert.equal(w.store.error, RULE_ERROR.STORE_UNAVAILABLE);
});

await checkAsync('rules-11 用户规则不许占用内置 id（撞名会拆成两个寻址空间：toggle 关内置、清单里却留着同 id 的用户条目）', async () => {
  const w = ruleWorld();
  const builtinId = CR.BUILTIN_RULES[0].id;
  // 只换 id，glob 仍是合法的 pnpm store —— 红必须归因到撞名检查，不能是 guard 先拒
  await assert.rejects(() => w.store.add(userRule({ id: builtinId })), (e) => e.code === RULE_ERROR.BAD_RULE);
  assert.equal((await w.store.userRules()).some((r) => r.id === builtinId), false, '撞名的用户规则不能落库');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
