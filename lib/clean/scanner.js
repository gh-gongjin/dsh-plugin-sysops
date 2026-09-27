/**
 * 清理扫描器（Task 12）：**只读**遍历 + 进度节流 + 可停止。
 *
 * 这个模块不删任何东西 —— 删除在 Task 15，它只按 `item.id` 从 Task 13 冻结的清单快照里找回路径。
 * 所以这里唯一要守住的三件事：
 *  1. **只读**：全模块只有 `readdirSync` / `statSync`，没有 unlink / rm / rename / 写。
 *  2. **第二道闸**：每条规则的 `dir` 再送一次 `check(dir, { mode: 'path' })`。红线只有一套口径
 *     （`lib/clean/guard.js`），glob 的 `mode:'glob'` 复检已在 Task 11 的 `validate()` /
 *     `activeRules()` 做过，这里不重写、也不自己放宽。
 *  3. **不谎报完整性**：`truncated`（撞到 `maxEntries`）、`stopped`（被 `stop()` 收手）、
 *     `skipped`（被 guard 拒 / 拒绝访问 / 目录不存在 / 超过 `maxDepth`）都必须显式交出去，
 *     并且每个 catch 都留一条 `logger.warn`，让「看着像全量」的结果在界面上能被认出来。
 *     延伸（Ruling-77 F-1 + 复评 F-R1）：**没走完的那一条不作为候选** —— 深度截断、子项 readdir
 *     或 stat 读不到、中途收手（`stop()` / `maxEntries` 触顶：既包括它的子树还压在栈里没排空，
 *     也包括收手正好打断某个目录自己的兄弟条目遍历），都只说明「这一条的视图不完整」，
 *     而不能说明「整条都够老」。不完整的条目一律改记 `skipped` 的 `INCOMPLETE`、不进 `items`：
 *     `items` 是删除清单的唯一数据源，下游按 `item.id` 找回路径整目录递归删，
 *     清单之外的文件被连带删掉是本插件最重的一条红线。
 *
 * 「整条够老才算候选」的口径（cln-2/cln-3）：一条规则的第一层条目是一个整体 —— 目录的大小与
 * 文件数递归求和，`atime` 取条目内文件 `atimeMs` 的**最大值**（= 最近一次被动过）。
 * 判定用 `atime <= now - ageDays*DAY`，所以「半新半旧」的目录整条不报：要删就删得干净，
 * 不做「把里面老文件挑出来」的碎删（那是 Task 15 之后另说的故事）。
 */
import path from 'node:path';
import { check } from './guard.js';

const DAY = 86_400_000;

/** 正则元字符转义：`*` 与 `?` 由 glob 语义自己占位，不进这张表（表里含 `[`、`]`、`\`）。 */
const SPECIAL = ".+^${}()|[]\\";
const escapeChar = (ch) => (SPECIAL.includes(ch) ? '\\' + ch : ch);

/**
 * 规则的绝对目录从哪来（Ruling-69 C1）：取值顺序写死，**不许无条件重算**。
 *   1. `rule.dir` —— Task 11 导出的内置 rule 已带加载时展开好的绝对 `dir`，重算会把
 *      `os.homedir()` 的机器名再焊一遍，且 `rel` 在测试夹具里会被故意置 `undefined`。
 *   2. `path.dirname(rule.glob)` —— 本机规则只有 `glob` 没有 `dir`（`cleanRulesRecord.items[]`
 *      的形状是 id/n/glob/kind/ageDays/note），目录就是 glob 的字面量前缀。
 *   3. `path.join(home, ...rel.split('/'))` —— 仓库外手写形状的兜底；`home` 缺省时拼出相对串，
 *      由 guard 以 `GUARD_NO_DRIVE` 拒（比在这里抛 `TypeError` 好查，见 Ruling-69 C11）。
 * `pattern` 优先 `rule.pattern`，否则取 glob 最后一个分隔符之后的段；段里没有 `*`/`?` 时兜成 `'*'`。
 * 这里用 `node:path` 而不是注入的 `fsMod.join`：模块级函数拿不到 `createScanner` 的参数（C10），
 * win32 下 `path.join` / `dirname` 出来带反斜杠，cln-1 断的就是这个。
 */
export function expandRule(rule, opts = {}) {
  const r = rule !== null && typeof rule === 'object' ? rule : {};
  const o = opts !== null && typeof opts === 'object' ? opts : {};
  let dir;
  if (r.dir !== undefined && r.dir !== null) {
    dir = r.dir;
  } else if (typeof r.glob === 'string' && r.glob.length > 0) {
    dir = path.dirname(r.glob);
  } else if (r.rel !== undefined && r.rel !== null && String(r.rel) !== '') {
    dir = path.join(String(o.home ?? ''), ...String(r.rel).split('/'));
  } else {
    // 三级都取不到：把 undefined 交给 guard，落 `GUARD_BAD_INPUT`，不另立形状错误分支（C11）。
    dir = undefined;
  }
  let pattern;
  if (r.pattern !== undefined && r.pattern !== null && String(r.pattern) !== '') {
    pattern = String(r.pattern);
  } else if (typeof r.glob === 'string' && r.glob.length > 0) {
    const seg = String(r.glob.split(/[\\/]/).pop());
    pattern = /[*?]/.test(seg) ? seg : '*';
  } else {
    pattern = '*';
  }
  return { ...r, dir, pattern };
}

/**
 * 单层通配转正则：`*` → `[^\\/]*`、`?` → `[^\\/]`，都不跨分隔符，整体 `^…$` + 忽略大小写
 * （Windows 路径大小写不敏感）。`**` 递归通配 = 整盘扫，guard 的 `b-glob-overreach` 已经拒过，
 * 这里是第二道：不静默降级成单层，直接抛。
 */
export function globToRegExp(pattern) {
  const p = String(pattern ?? '');
  if (p.includes('**')) throw new Error('不接受 **');
  let src = '^';
  for (const ch of p) {
    if (ch === '*') src += '[^\\\\/]*';
    else if (ch === '?') src += '[^\\\\/]';
    else src += escapeChar(ch);
  }
  return new RegExp(src + '$', 'i');
}

const MID_IDS = ['edge', 'wechat', 'dingtalk', 'vscode', 'packages'];

/**
 * 风险列的文案表（`why` 直接进清单的「风险」列）。
 * 两张表都不命中的（用户自建规则的 kind/id 五花八门）默认 `mid` 而不是 `low`：
 * `low` 那句「只影响事后分析或需重新下载」对任意目录是一个做不了保证的假承诺，宁可多提示一次。
 */
export function riskOf(rule) {
  const r = rule !== null && typeof rule === 'object' ? rule : {};
  const id = String(r.id ?? '').toLowerCase();
  const kind = String(r.kind ?? '');
  if (MID_IDS.some((s) => id.includes(s)) || kind === '缓存') {
    return { level: 'mid', why: '运行中的应用会锁住部分文件，锁住的项会被跳过' };
  }
  if (kind === '崩溃转储' || kind === '旧版本') {
    return { level: 'low', why: '只影响事后分析或需重新下载' };
  }
  return { level: 'mid', why: '不在风险表内，请按目录用途自行确认' };
}

/** 清单条目的稳定 id：Task 13 冻结它、Task 15 只按它找回路径，所以当成不透明串即可。 */
const itemId = (ruleId, p) => `${String(ruleId)}-${Buffer.from(String(p).toLowerCase()).toString('base64url')}`;

/**
 * 建一个扫描器。`fsMod` 必须交 `{ readdirSync, statSync, join }` —— 只读三件套，
 * 本模块不会用到别的键。没有 `osMod`（Ruling-69 C8：内置带绝对 `dir`、本机规则走
 * `dirname(glob)`，扫描器内部没有任何地方读 `os.homedir()`，留着就是死参）。
 */
export function createScanner(options = {}) {
  const {
    fsMod,
    logger,
    now = () => Date.now(),
    onProgress = () => {},
    progressIntervalMs = 250,
    maxEntries = 200000,
    maxDepth = 12,
  } = options;

  const state = { stopped: false };
  const stop = () => { state.stopped = true; };
  const warn = (msg) => { logger?.warn?.(msg); };

  async function scan(rules, opts = {}) {
    const o = opts !== null && typeof opts === 'object' ? opts : {};
    const every = typeof o.every === 'function' ? o.every : null;
    const list = Array.isArray(rules) ? rules : [];
    state.stopped = false;

    const items = [];
    const skipped = [];
    let walked = 0;
    let hit = 0;
    let bytes = 0;
    let truncated = false;
    let lastEmit = 0;

    const done = () => state.stopped || truncated;
    const bump = () => {
      // 撞到上限就是「结果不完整」，绝不能把它当完整清单交出去：置标记 + 留日志 + 收手。
      if (truncated || walked < maxEntries) return;
      truncated = true;
      warn(`扫描达到条目上限 ${maxEntries} 条，本次结果已截断，未遍历到的目录不在清单里`);
    };
    const skip = (where, code, why) => {
      skipped.push({ dir: where, code, why });
      warn(`跳过 ${where}：${code} ${why}`);
    };
    const emit = (dir) => {
      const t = now();
      if (t - lastEmit < progressIntervalMs) return;
      onProgress({ dir: String(dir), walked, hit, bytes });
      lastEmit = t;
    };

    for (const raw of list) {
      if (done()) break;
      const rule = expandRule(raw, {});
      // 第二道闸：**同步**调用、不 await（Ruling-69 C2）；只补 `dir` 的 mode:'path'，
      // glob 的复检在 Task 11 那侧已经做过，红线只有一套口径。
      const g = check(rule.dir, { mode: 'path' });
      if (!g.allow) {
        skip(rule.dir, g.code, g.why);
        continue;
      }
      // 单层通配只打名字；`**` 在这里抛 —— guard 已拒过的形状不该被扫描器悄悄接受。
      const re = globToRegExp(rule.pattern);
      const ageMs = (Number.isFinite(Number(rule.ageDays)) ? Number(rule.ageDays) : 0) * DAY;
      const cutoff = now() - ageMs;
      const risk = riskOf(rule);
      const candidates = [];

      // 规则目录本身：stat 一次。本机没装 Edge 不是错误 —— ENOENT 记进 skipped 继续下一条，不抛。
      try {
        fsMod.statSync(rule.dir);
        walked += 1;
      } catch (err) {
        skip(rule.dir, err?.code ?? 'STAT_FAILED', `规则目录读不到：${err?.message ?? err}`);
        continue;
      }
      bump();
      if (done()) break;

      // 显式栈遍历（深目录不吃调用栈）。栈元素的 depth 相对规则目录：0 = 规则目录本身。
      const stack = [{ dir: rule.dir, depth: 0, cand: null }];
      while (stack.length) {
        if (done()) break;
        const node = stack.pop();
        if (node.depth > 0 && node.cand) {
          // 出栈即「正在走」，栈账（pending）到此结清；祖先不欠它任何账 —— 祖先的目录 break 之后
          // 就不会再回来。所以「打断在自己这一层的兄弟条目中间」只能由下面 for 末尾的 partial 标记兜。
          node.cand.pending -= 1;
        }
        let entries;
        try {
          entries = fsMod.readdirSync(node.dir, { withFileTypes: true });
        } catch (err) {
          // depth > 0 ⇒ 这是某个第一层候选内部的子目录：它的整棵子树都没看见，
          // 这条候选的 size/count/newest 都是半截的，必须标成不完整（F-1）。
          if (node.depth > 0 && node.cand) node.cand.partial = true;
          skip(node.dir, err?.code ?? 'READ_FAILED', `目录列不出来：${err?.message ?? err}`);
          continue;
        }
        for (const ent of entries) {
          const childPath = String(fsMod.join(node.dir, ent.name));
          // 只有规则目录的第一层条目成为候选；更深的路径只往所属第一层条目里累加（cln-2/3 的语义）。
          // partial/pending 是内部判据字段，只走 skipped 通道，不进 items（Task 13 的 schema 没声明过）。
          const cand = node.depth === 0
            ? { path: childPath, size: 0, count: 0, newest: 0, mtime: 0, partial: false, pending: 0 }
            : node.cand;
          if (node.depth === 0) candidates.push(cand);

          let st = null;
          try {
            st = fsMod.statSync(childPath);
          } catch (err) {
            // 权限不足 / 读取中途消失：记进 skipped 并写日志，不静默（spec §4.7）。
            // 同时把所属候选标不完整：取不到信息就不知道它是不是一个装了新文件的目录，宁可不报。
            if (cand) cand.partial = true;
            skip(childPath, err?.code ?? 'STAT_FAILED', `条目取不到信息：${err?.message ?? err}`);
          }
          walked += 1;
          bump();

          if (st) {
            if (typeof st.isFile === 'function' ? st.isFile() : true) {
              if (cand) {
                cand.size += Number(st.size) || 0;
                cand.count += 1;
                // 保守口径：atime 取条目内**最大值**（最近一次被动过），整条都够老才算候选。
                cand.newest = Math.max(cand.newest, Number(st.atimeMs) || 0);
                cand.mtime = Math.max(cand.mtime, Number(st.mtimeMs) || 0);
              }
            } else if (node.depth + 1 >= maxDepth) {
              // 深度收手：这个子树没下探，里面可能有昨天的新文件；把所属的第一层候选标不完整，
              // 否则它的 newest 会因为没统计到这一截而显得「整条都够老」。
              if (cand) cand.partial = true;
              skip(childPath, 'DEPTH', `已达最大遍历深度 ${maxDepth}，这个目录没有下探，里面的内容不在清单里，并且这条目录本次不作为候选`);
            } else {
              if (cand) cand.pending += 1;
              stack.push({ dir: childPath, depth: node.depth + 1, cand });
            }
          }

          every?.();
          if (done()) {
            // 收手/触顶落在「正在遍历的这个目录」中间：它后面的兄弟条目从未被访问，
            // 而这条候选的栈账已在出栈时结清 ⇒ 不补这一标就会带着半截视图定稿（复评 F-R1）。
            if (node.depth > 0 && node.cand) node.cand.partial = true;
            break;
          }
          emit(rule.dir);
        }
      }

      // 候选定稿：命中过通配、且条目内**最新**那个文件也够老（整条都够老）才进清单。
      for (const cand of candidates) {
        if (cand.count < 1) continue;
        if (cand.partial || cand.pending > 0) {
          skip(cand.path, 'INCOMPLETE', '这一条的目录树没有全部走完（深度上限 / 中途收手 / 有子项读不到），本次不作为候选 —— 避免把没看见的新文件连同目录一起删掉');
          continue;
        }
        if (!re.test(String(cand.path).split(/[\\/]/).pop())) continue;
        if (cand.newest > cutoff) continue;
        hit += 1;
        bytes += cand.size;
        items.push({
          id: itemId(rule.id, cand.path),
          ruleId: rule.id,
          ruleName: rule.n,
          kind: rule.kind,
          path: cand.path,
          size: cand.size,
          count: cand.count,
          atime: cand.newest,
          mtime: cand.mtime,
          risk,
        });
      }
      emit(rule.dir);
    }

    return {
      items,
      totals: { n: items.length, bytes: items.reduce((a, i) => a + i.size, 0) },
      walked,
      hit,
      skipped,
      stopped: state.stopped,
      truncated,
      at: now(),
    };
  }

  return { scan, stop };
}
