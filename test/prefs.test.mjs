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

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
