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

/* guard：「能不能删」的唯一裁决点（纯字符串判定，零 IO） */
const Guard = await import('../lib/clean/guard.js');
// 只解构用例里真用到的两个名字。GUARD_CODE 留给实现与 api.js 用，测试按 branch 断言即可，
// 在测试里再抄一遍 code 只会让"改文案要改两处"复发。
const { checkOperation, BRANCH_IDS } = Guard;

/** 分支命中台账：guard-18 用它断言 16 条红线分支一条都没漏。 */
const seenBranches = new Map(BRANCH_IDS.map((id) => [id, 0]));
let denyAssertions = 0;

const deny = (raw, branch, opts) => {
  assert.ok(seenBranches.has(branch), `用例写了不存在的分支 id：${branch}（BRANCH_IDS 里查不到）`);
  const r = Guard.check(raw, opts);
  assert.equal(r.allow, false, `应拒绝但放行了: ${raw}`);
  assert.equal(r.branch, branch, `${raw} 落错分支：期望 ${branch} 实得 ${r.branch}（${r.code}）`);
  assert.ok(r.why.length > 0, `${raw} 拒绝必须有原因文案`);
  seenBranches.set(branch, seenBranches.get(branch) + 1);
  denyAssertions += 1;
  return r;
};
const allow = (raw, opts) => {
  const r = Guard.check(raw, opts);
  assert.equal(r.allow, true, `应放行但拒绝: ${raw} → ${r.code} ${r.why}`);
  return r;
};

check('guard-01 系统目录：C:\\Windows 三种写法都拒', () => {
  deny('C:\\Windows\\win.ini', 'b-system-dir');
  deny('C:\\Windows', 'b-system-dir');
  deny('c:\\windows\\Temp', 'b-system-dir');
  // 受保护范围扩到任意盘：异盘小写形（非变体）也必须是 b-system-dir
  deny('D:\\windows\\x', 'b-system-dir');
  // 只能由 { drive: null, segs: ['Windows', 'System32'] } 命中的形态（异盘根下无 C 盘 Windows）
  deny('D:\\Windows\\System32\\drivers\\x', 'b-system-dir');
});
check('guard-02 回收站：$Recycle.Bin 与其内层目录都拒', () => {
  deny('C:\\$Recycle.Bin', 'b-recycle-bin');
  deny('C:\\$Recycle.Bin\\S-1-5-21-100', 'b-recycle-bin');
  deny('C:\\Recycler', 'b-recycle-bin');
  // 异盘卷根同样有回收站：删了就真没了，没有「还原」
  deny('D:\\$Recycle.Bin\\S-1-5-21-1\\x', 'b-recycle-bin');
});
check('guard-03 Program Files：含 (x86) 与子层都拒', () => {
  deny('C:\\Program Files\\App', 'b-program-files');
  deny('C:\\Program Files (x86)\\App', 'b-program-files');
  deny('D:\\Program Files\\x', 'b-program-files');
});
check('guard-04 大小写变体绕过受保护前缀', () => {
  deny('C:\\WiNdOws\\x', 'b-case-variant');
  deny('C:\\PROGRAM FILES\\x', 'b-case-variant');
  deny('C:\\$RECYCLE.BIN\\x', 'b-case-variant');
});
check('guard-05 全角字符伪装（U+FF23 冒盘符 / 全角冒号）', () => {
  deny('\uFF23:\\Windows\\x', 'b-fullwidth');
  deny('C\uFF1A\\Users\\x', 'b-fullwidth');
  deny('C:\\\\Ｕｓｅｒｓ\\a', 'b-fullwidth');
});
check('guard-06 \\?\\ 与 \\.\ 前缀逃逸', () => {
  deny('\\\\?\\C:\\Windows\\x', 'b-prefix-escape');
  deny('\\\\.\\C:\\Users\\a', 'b-prefix-escape');
  deny('\\\\?\\UNC\\server\\share\\x', 'b-prefix-escape');
});
check('guard-07 UNC 路径', () => {
  deny('\\\\fileserver\\c$\\Users', 'b-unc');
  deny('\\\\nas\\share\\cache', 'b-unc');
  deny('\\\\10.0.0.5\\temp', 'b-unc');
});
check('guard-08 8.3 短名', () => {
  deny('C:\\PROGRA~1\\App', 'b-short-name');
  deny('C:\\Users\\gongj\\AppData\\LOCAL~1\\Temp', 'b-short-name');
  deny('C:\\Windows\\SYSWOW~1\\x', 'b-short-name');
});
check('guard-09 .. 逃逸到受保护区', () => {
  deny('C:\\Users\\gongj\\AppData\\..\\..\\Windows\\x', 'b-parent-escape');
  deny('C:\\Users\\gongj\\..\\..\\$Recycle.Bin\\x', 'b-parent-escape');
  deny('..', 'b-parent-escape');
  // drive-relative 写法：预检切出的 token 是 `C:..`，只有解析后的段检查能拦住
  deny('C:..\\Windows\\x', 'b-parent-escape');
});
check('guard-10 junction 逃逸：raw 干净但 real 落进受保护区', () => {
  deny('C:\\Users\\gongj\\link\\win.ini', 'b-junction-escape',
    { real: 'C:\\Windows\\win.ini' });
  deny('C:\\Users\\gongj\\link\\a', 'b-junction-escape',
    { real: 'C:\\Program Files\\x\\a' });
  deny('C:\\Users\\gongj\\link\\b', 'b-junction-escape',
    { real: 'C:\\$RECYCLE.BIN\\S-1-5-21-1\\b' });
  // fail-closed：real 键存在但不是有效非空字符串 → 无法确认落点，拒绝
  deny('C:\\Users\\gongj\\link\\c', 'b-junction-escape', { real: null });
});
check('guard-11 未展开的 %VAR%', () => {
  deny('%LOCALAPPDATA%\\Temp', 'b-unexpanded-var');
  deny('C:\\Users\\%USERNAME%\\AppData\\Local\\Temp', 'b-unexpanded-var');
  deny('C:\\Windows\\%SystemRoot%\\x', 'b-unexpanded-var');
  // 未闭合的 %变量引用：展开位置不明，同样不可控
  deny('C:\\Users\\gongj\\Desktop\\%USERNAME', 'b-unexpanded-var');
});
check('guard-12 省略盘符 / 相对路径 / 只到盘根', () => {
  deny('Users\\gongj\\AppData\\Local\\Temp', 'b-no-drive');
  deny('.\\AppData\\Local\\Temp', 'b-no-drive');
  deny('/etc/passwd', 'b-no-drive');
  deny('C:\\', 'b-glob-overreach', { mode: 'glob' });
});
check('guard-13 通配越界：盘根 / 一级目录 / ** / 中段星号越到受保护区', () => {
  deny('C:\\*', 'b-glob-overreach', { mode: 'glob' });
  deny('C:\\Users\\*', 'b-glob-overreach', { mode: 'glob' });
  deny('C:\\Users\\gongj\\**\\cache', 'b-glob-overreach', { mode: 'glob' });
  deny('C:\\*\\Windows\\*', 'b-glob-overreach', { mode: 'glob' });
});
check('guard-14 操作白名单：属主 / ACL / 注册表 / 结束进程一律拒', () => {
  // 操作级红线也走台账：denyOp 记 b-operation-denied，否则 grd-98 的 40 例口径会漏掉这五条。
  const denyOp = (op) => {
    const r = checkOperation(op);
    assert.equal(r.allow, false, `操作 ${op} 应被拒绝`);
    assert.equal(r.branch, 'b-operation-denied');
    assert.ok(r.why.length > 0, `操作 ${op} 拒绝必须有原因文案`);
    seenBranches.set('b-operation-denied', seenBranches.get('b-operation-denied') + 1);
    denyAssertions += 1;
  };
  ['delete-file', 'delete-dir', 'move-to-quarantine'].forEach((op) => {
    assert.equal(checkOperation(op).allow, true, `${op} 是唯一允许的三种动作`);
  });
  ['set-owner', 'set-acl', 'registry-write', 'kill-process', 'recursive-force'].forEach(denyOp);
});
check('guard-15 注册表形态路径直接拒（不靠 checkOperation 兜）', () => {
  deny('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'b-registry');
  deny('HKEY_CURRENT_USER\\Software\\x', 'b-registry');
  deny('REG:HKCU\\Software\\x', 'b-registry');
  // 注册表形态嵌在段里（串首不是根键）：归因必须是 b-registry，不能退化成 b-no-drive
  deny('Computer\\HKEY_LOCAL_MACHINE\\SOFTWARE\\x', 'b-registry');
  deny('Registry::HKEY_LOCAL_MACHINE\\Software\\x', 'b-registry');
});
check('guard-16 非法输入：非字符串 / 空串 / 超长', () => {
  deny('', 'b-bad-input');
  deny(123, 'b-bad-input');
  deny(null, 'b-bad-input');
  deny('C:\\' + 'x'.repeat(32768), 'b-bad-input');
  // 系统边界：opts 传 null / 缺省不得抛 TypeError（默认参数只对 undefined 生效）
  assert.equal(Guard.check('C:\\Users\\gongj\\AppData\\Local\\Temp', null).allow, true,
    'opts=null 应正常判定为放行');
  assert.equal(Guard.check('C:\\Windows\\win.ini').branch, 'b-system-dir',
    'opts 缺省应正常判定');
});
check('guard-17 正常路径必须放行（防过度收紧）', () => {
  allow('C:\\Users\\gongj\\AppData\\Local\\Temp');
  allow('C:\\Users\\gongj\\.cache\\pnpm');
  allow('D:\\备份\\2026Q1');
  allow('C:\\Users\\gongj\\AppData\\Local\\npm-cache\\_cacache', { mode: 'glob' });
  allow('C:\\Users\\gongj\\AppData\\Local\\pip\\Cache\\*', { mode: 'glob' });
  allow('C:\\Users\\gongj\\AppData\\Roaming\\DingTalk\\*\\log', { mode: 'glob' });
});
check('guard-18 分支清单 100% 覆盖（spec §5 验收门禁 2）', () => {
  // 直接读台账，不再另造一份探针清单：另造就会和上面的用例漂移（历史上就漏过 glob 一条）。
  const zero = [...seenBranches].filter(([, n]) => n === 0).map(([id]) => id);
  assert.deepEqual(zero, [], `这些红线分支没被任何用例打到：${zero.join(', ')}`);
  assert.equal(seenBranches.size, 16, 'BRANCH_IDS 应是 16 条；增删分支要同步增删用例');
});
check('guard-19 红线矩阵达到 spec §5 的 ≥40 例口径（按拒绝断言计数）', () => {
  assert.ok(denyAssertions >= 40, `当前只有 ${denyAssertions} 条拒绝断言 —— 补变体，不许改口径`);
});

// 收尾两行之前先把台账打出来：Task 25 的门禁②证据就是这一行，不是人眼数用例。
console.log(`  红线矩阵：拒绝断言 ${denyAssertions} 条 / 分支命中 ${[...seenBranches.values()].filter((n) => n > 0).length}/${BRANCH_IDS.length}`);

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
