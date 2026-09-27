/**
 * 「能不能删」的唯一裁决点。
 *
 * 三条设计约定：
 *  1. **纯字符串判定，零 IO**：`opts.real` 由调用方（扫描器）用 `fs.realpathSync` 取到后传进来。
 *     guard 自己不开文件句柄，才能在测试里逐分支打满。
 *  2. **判定顺序 = 优先级**：形态异常（全角 / 命名空间前缀 / UNC / 注册表形态 / %VAR% / `..`）先于
 *     「有没有解析出盘符」这一步，因为绕过的形状本身就是危险信号，不该被"lowercase 之后不在保护表里"
 *     或者"这条串根本不是绝对路径"这种更弱的原因顶掉；同理，短名判定先于内容判定。
 *  3. **拒绝必须说得出原因**：`why` 直接进界面卡片文案，不允许空串。
 *
 * 判定优先级（自上而下，第一个命中即返回）：
 *   b-bad-input → b-fullwidth → b-prefix-escape → b-unc → b-registry → b-unexpanded-var
 *   → b-parent-escape → b-no-drive → b-short-name → b-case-variant / b-system-dir
 *   / b-recycle-bin / b-program-files → b-glob-overreach → b-junction-escape → 放行
 *
 * 红线只收紧不放宽：任何一条改动若让上面某一支的命中面变小，测试（test/guard.test.mjs）必须同步变红。
 */

export const GUARD_CODE = {
  OK: 'OK',
  BAD_INPUT: 'GUARD_BAD_INPUT',
  FULLWIDTH: 'GUARD_FULLWIDTH',
  PREFIX_ESCAPE: 'GUARD_PREFIX_ESCAPE',
  UNC: 'GUARD_UNC',
  UNEXPANDED_VAR: 'GUARD_UNEXPANDED_VAR',
  NO_DRIVE: 'GUARD_NO_DRIVE',
  SHORT_NAME: 'GUARD_SHORT_NAME',
  PARENT_ESCAPE: 'GUARD_PARENT_ESCAPE',
  REGISTRY: 'GUARD_REGISTRY',
  SYSTEM_DIR: 'GUARD_SYSTEM_DIR',
  RECYCLE_BIN: 'GUARD_RECYCLE_BIN',
  PROGRAM_FILES: 'GUARD_PROGRAM_FILES',
  CASE_VARIANT: 'GUARD_CASE_VARIANT',
  JUNCTION_ESCAPE: 'GUARD_JUNCTION_ESCAPE',
  GLOB_OVERREACH: 'GUARD_GLOB_OVERREACH',
  OPERATION_DENIED: 'GUARD_OPERATION_DENIED',
};

/** 分支清单：与 test/guard.test.mjs 的 guard-18 一一对应，加分支必须同时加用例。 */
export const BRANCH_IDS = [
  'b-bad-input', 'b-fullwidth', 'b-prefix-escape', 'b-unc', 'b-unexpanded-var',
  'b-no-drive', 'b-short-name', 'b-parent-escape', 'b-registry', 'b-system-dir',
  'b-recycle-bin', 'b-program-files', 'b-case-variant', 'b-junction-escape',
  'b-glob-overreach', 'b-operation-denied',
];

/**
 * 受保护目录规则。`prefixes` 里每条：
 *  - `drive`：限定盘符（小写）；`null` 表示任意盘符下都受保护。
 *  - `segs`：从盘根数起的受保护段名（**正常拼写**写法，比较时统一转小写）。
 *  - `tailSuffix`：末段允许后接空格后缀的同族目录（`Program Files (x86)` 一并算受保护）。
 * 段名一律按「整段相等」比较，所以 `c:\program filesx` 这种邻词不会被误命中；
 * 反之开启 `tailSuffix` 只会把命中面变大（更严），不会变小。
 * 受保护段是**盘根锚定**的（只比 segments 开头），所以 `…\Microsoft\Windows\INetCache` 这类
 * 非首段的 Windows 目录不会被误伤。Windows / 回收站相关条目一律 `drive: null`（任意盘）：
 * NTFS 每个卷根都有 `\$RECYCLE.BIN`，异盘回收站同样「删了就真没了、没有还原」。
 */
const PROTECTED = [
  {
    branch: 'b-system-dir',
    code: GUARD_CODE.SYSTEM_DIR,
    // 曾经这里还有一条 `{ drive: null, segs: ['Windows', 'System32'] }`：根 `Windows` 改成
    // `drive: null` 之后它被上一条完全覆盖（段比较从盘根锚定），删掉它 19 例仍全绿 —— 留着
    // 只会让读这份红线的人以为 System32 另有单独保护。若有人想把上一条收窄回 C 盘，
    // guard-01 的 `D:\windows\x` 用例会立刻变红。
    prefixes: [
      { drive: null, segs: ['Windows'] },
    ],
    why: (p) => `系统目录禁止操作：${p}`,
  },
  {
    branch: 'b-recycle-bin',
    code: GUARD_CODE.RECYCLE_BIN,
    prefixes: [
      { drive: null, segs: ['$Recycle.Bin'] },
      { drive: null, segs: ['Recycler'] },
    ],
    why: (p) => `回收站由系统管理，插件不代清（删了就真没了，且这里没有「还原」）：${p}`,
  },
  {
    branch: 'b-program-files',
    code: GUARD_CODE.PROGRAM_FILES,
    prefixes: [
      { drive: null, segs: ['Program Files'], tailSuffix: true },
    ],
    why: (p) => `已安装程序目录禁止删除：${p}`,
  },
];

/**
 * 受保护名的「正常拼写」表（键为小写形）。
 * 命中的段只允许两种写法：全小写、或表里的标准拼写；其余（PROGRAM FILES / WiNdOws / $RECYCLE.BIN）
 * 一律按大小写变体绕过处理，单独成支，好让界面能说清「为什么看着不一样也被拒」。
 * 表里没有的段不参与变体判定（它们本来就不会出现在受保护命中里）。
 */
const NORMAL_SPELLING = new Map(Object.entries({
  windows: 'Windows',
  '$recycle.bin': '$Recycle.Bin',
  recycler: 'Recycler',
  'program files': 'Program Files',
  'program files (x86)': 'Program Files (x86)',
}));

const OPS_ALLOWED = new Set(['delete-file', 'delete-dir', 'move-to-quarantine']);

const deny = (branch, code, why) => ({ allow: false, branch, code, why });
const ok = () => ({ allow: true, branch: 'b-allowed', code: GUARD_CODE.OK, why: '' });

const FULLWIDTH_RE = /[\uFF01-\uFF5E\u3000]/;
const VAR_RE = /%[^%\\/:*?"<>|]{1,64}%/;
const SHORT_NAME_RE = /(^|[\\/])[^\\/~]{1,8}~\d{1,2}(\.[^\\/]{1,6})?($|[\\/])/i;
/** 未闭合的变量引用：`%` 后紧跟合法变量名字符即视为没展开完（如 `…\%USERNAME`），同属不可控形态。 */
const UNCLOSED_VAR_RE = /%[^%\\/:*?"<>|]/;
/** 注册表形态（串首）：REG: 前缀 + HKLM / HKCU / HKCR / HKCC / HKU / HKEY_ 打头，一律不碰。 */
const REGISTRY_RE = /^(reg:)?(hk(al|cr|cu|cc|lm|u)|hkey_)/i;
/** 注册表形态（内嵌段）：某段以根键名开头（如 `Computer\HKEY_LOCAL_MACHINE\…`、`Registry::HKEY_…`）。
 *  只扩大 b-registry 的命中面（原本这些形态会落 b-no-drive），不放行任何原被拒的串。 */
const REGISTRY_EMBEDDED_RE = /(^|[\\/:])((hk(al|cr|cu|cc|lm|u)|hkey_[a-z0-9_]+)([\\/]|$))/i;

/** 拆成 [盘符, 段数组]；段数组去掉尾部的空段与分隔符。非绝对路径返回 null。 */
function splitPath(raw) {
  const slashes = raw.replace(/[\\/]+/g, '\\');
  const m = /^([a-zA-Z]):\\?(.*)$/.exec(slashes);
  if (!m) return null;
  return { drive: m[1].toLowerCase(), segments: m[2].split('\\').filter(Boolean) };
}

/** 受保护判定用的规范化串：`c:\Windows\win.ini`（保留原大小写，比较时另外转小写）。 */
function canonical(parsed) {
  return parsed.drive + ':\\' + parsed.segments.join('\\');
}

function isNormalSpelling(seg) {
  const low = seg.toLowerCase();
  const normal = NORMAL_SPELLING.get(low);
  if (normal === undefined) return true;
  return seg === low || seg === normal;
}

/** 命中哪条受保护规则（含命中的段前缀，供大小写变体支定位到具体段）。 */
function matchProtected(parsed) {
  if (!parsed) return null;
  const low = parsed.segments.map((s) => s.toLowerCase());
  for (const rule of PROTECTED) {
    for (const p of rule.prefixes) {
      if (p.drive && p.drive !== parsed.drive) continue;
      if (low.length < p.segs.length) continue;
      let hit = true;
      for (let i = 0; i < p.segs.length; i += 1) {
        const want = p.segs[i].toLowerCase();
        const got = low[i];
        if (got === want) continue;
        if (i === p.segs.length - 1 && p.tailSuffix && got.startsWith(want + ' ')) continue;
        hit = false;
        break;
      }
      if (hit) return { rule, prefix: p };
    }
  }
  return null;
}

export function check(raw, opts) {
  // 系统边界兜底：参数默认值只对 undefined 生效，null / 非对象 opts 统一落到 {}，不允许抛 TypeError
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  const mode = o.mode === 'glob' ? 'glob' : 'path';

  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 32767) {
    return deny('b-bad-input', GUARD_CODE.BAD_INPUT, '路径必须是 1~32767 个字符的非空字符串');
  }
  if (FULLWIDTH_RE.test(raw)) {
    return deny('b-fullwidth', GUARD_CODE.FULLWIDTH, '路径含全角字符，可能是绕过大小的伪装写法：' + raw);
  }
  if (raw.startsWith('\\\\?\\') || raw.startsWith('\\\\.\\')) {
    return deny('b-prefix-escape', GUARD_CODE.PREFIX_ESCAPE, 'Win32 命名空间前缀（\\\\?\\ 或 \\\\.\\）会跳过解析规则，禁止：' + raw);
  }
  if (raw.startsWith('\\\\')) {
    return deny('b-unc', GUARD_CODE.UNC, '不接受网络路径（UNC）：' + raw);
  }
  if (REGISTRY_RE.test(raw) || REGISTRY_EMBEDDED_RE.test(raw)) {
    return deny('b-registry', GUARD_CODE.REGISTRY, '本插件不碰注册表：' + raw);
  }
  // 闭合 %VAR%（VAR_RE）与未闭合的 `%变量名`（UNCLOSED_VAR_RE）同支：展开结果都不可控
  if (VAR_RE.test(raw) || UNCLOSED_VAR_RE.test(raw)) {
    return deny('b-unexpanded-var', GUARD_CODE.UNEXPANDED_VAR, '路径含未展开或未闭合的 %变量%，展开结果不可控：' + raw);
  }
  // `..` 在任何解析结果之前就是危险形状，连「有没有盘符」都不必问
  if (raw.split(/[\\/]+/).filter(Boolean).includes('..')) {
    return deny('b-parent-escape', GUARD_CODE.PARENT_ESCAPE, '路径含 .. 段，先解析成绝对路径再送进来：' + raw);
  }
  const parsed = splitPath(raw);
  if (!parsed || parsed.segments.length === 0) {
    if (parsed && mode === 'glob') {
      // 只剩盘根（`C:\`）的批量匹配：整盘扫，越界程度比「没带盘符」更值得说清楚
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH,
        `通配范围到了盘根，等于整盘批量操作，禁止：${raw}`);
    }
    return deny('b-no-drive', GUARD_CODE.NO_DRIVE, '必须是带盘符的绝对路径（如 C:\\Users\\…）：' + raw);
  }
  if (parsed.segments.some((s) => s === '..' || s === '.')) {
    return deny('b-parent-escape', GUARD_CODE.PARENT_ESCAPE, '路径含 .. / . 段，先解析成绝对路径再送进来：' + raw);
  }
  if (SHORT_NAME_RE.test(raw)) {
    return deny('b-short-name', GUARD_CODE.SHORT_NAME, '不接受 8.3 短文件名（可能指向任意目录）：' + raw);
  }

  const hit = matchProtected(parsed);
  if (hit) {
    // 大小写变体单独成支：同一条红线，但"为什么被拒"要说得准 —— 界面文案要用它
    const canonicalForm = canonical(parsed);
    if (hit.prefix.segs.some((_, i) => !isNormalSpelling(parsed.segments[i]))) {
      return deny('b-case-variant', GUARD_CODE.CASE_VARIANT,
        `受保护目录（大小写变体一样命中）：${canonicalForm}`);
    }
    return deny(hit.rule.branch, hit.rule.code, hit.rule.why(canonicalForm));
  }

  // glob 的越界判定，实现只校验两件事：①字面量前缀（第一个 `*` 之前的部分）的段数 ≥ 盘符下三级；
  // ②该字面量前缀本身不落受保护区。刻意**不做中缀扫描**（不检查 `*` 之后是否出现 Windows /
  // Program Files 等字面段）：异盘或非盘根位置的 `Windows` 段并不是系统目录（如
  // `…\Microsoft\Windows\INetCache\*` 这类 Task 11 要用的合法缓存 glob），扫中缀会误伤它们。
  if (mode === 'glob') {
    if (/\*\*/.test(raw)) {
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH, '不接受 ** 递归通配：' + raw);
    }
    const starAt = raw.indexOf('*');
    const literal = starAt === -1 ? raw : raw.slice(0, starAt);
    const litParsed = splitPath(literal.replace(/[\\/]$/, ''));
    if (!litParsed || litParsed.segments.length < 3) {
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH,
        `通配的字面量前缀至少要到盘符下第三级目录才允许批量匹配：${raw}`);
    }
    if (matchProtected(litParsed)) {
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH, '通配前缀落在受保护目录：' + raw);
    }
  }

  // junction / symlink 逃逸：只有调用方交出 realpath 才判得到。
  // fail-closed：opts 里出现了 real 键却不是有效非空字符串，等同「无法证明不在受保护区」，直接拒；
  // real 键不存在时行为不变（调用方自行决定是否放弃这条红线）。
  if ('real' in o) {
    const real = o.real;
    if (typeof real !== 'string' || real.trim() === '') {
      return deny('b-junction-escape', GUARD_CODE.JUNCTION_ESCAPE,
        '调用方交出的真实路径（real）不是有效非空字符串，无法确认落点，禁止');
    }
    const realParsed = splitPath(real);
    const realShapesAway =
      !realParsed
      || FULLWIDTH_RE.test(real)
      || SHORT_NAME_RE.test(real)
      || realParsed.segments.some((s) => s === '..' || s === '.');
    if (realShapesAway) {
      // realpath 自身形态可疑 / 解析不出来 = 无法证明它不在受保护区，按红线处理。
      // 真机 fs.realpathSync 只会交出带盘符的绝对长路径，走到这里就说明调用方给的东西不可信。
      return deny('b-junction-escape', GUARD_CODE.JUNCTION_ESCAPE,
        `无法确认真实路径落在哪里，禁止：${real}`);
    }
    if (matchProtected(realParsed)) {
      return deny('b-junction-escape', GUARD_CODE.JUNCTION_ESCAPE,
        `路径字面量看着正常，实际解析到受保护目录：${canonical(realParsed)}`);
    }
  }

  return ok();
}

export function checkOperation(op) {
  if (OPS_ALLOWED.has(op)) return ok();
  return deny('b-operation-denied', GUARD_CODE.OPERATION_DENIED,
    `操作「${op}」不在允许范围内。本插件只删文件/目录、只搬到暂存区，不改属主、不改 ACL、不写注册表、不结束进程。`);
}
