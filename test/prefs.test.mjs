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
  const r = t.parse({ items: [{ id: 'u-1', n: '浏览器缓存', glob: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*', ageDays: 7 }], updatedAt: 1 });
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

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
