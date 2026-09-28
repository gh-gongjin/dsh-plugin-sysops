/**
 * lib/search/walk.js —— 本地遍历适配器（Task 17，通路 ③，本机唯一能实跑的通路）
 *
 * 显式栈遍历用户显式选择的目录（不碰红线裁决之外的路径；目录由 prefs.search.walkDirs 提供）。
 * 预算耗尽（timedOut）与命中超上限（truncated）分开标 —— 两种「不全」的原因不同。
 * 访问被拒（EPERM/ENOENT）记 skipped 继续走，与 Task 12 同一口径，不静默吞。
 */

/** 空格分词 = 同时满足（与原型「支持空格分词（= 同时满足）」文案一致） */
export function tokensOf(q) {
  const s = String(q ?? '').trim();
  return s ? s.split(/\s+/) : [];
}

/**
 * 全部词都要命中，大小写不敏感 —— 此决定与原型原文【相反】，如实标注出处（勿再误引原型）：
 * ① task-17 接口行与原型 UI 提示（prototype/index.html:659「大小写敏感 · 支持空格分词」）两处
 *    均写「大小写敏感」；② 真正的定音来源是测试 wk-1 的断言 message（test/search.test.mjs:229
 *    「Everything 默认大小写不敏感，walk 要跟它一致」），而非原型 —— 依 Everything 真身与 Windows
 *    文件名（皆不区分大小写）取不敏感，经 2026-09-28 评审（task-1617-review.md §4.1）裁定以用例为准；
 * ③ 原型 index.html:659 的「大小写敏感」文案与本实现的冲突，登记到 Task 25 回写 spec / 原型。
 */
export function matchName(name, tokens) {
  const n = String(name ?? '').toLowerCase();
  return tokens.every((t) => n.includes(t.toLowerCase()));
}

/** 保守折算率：实测 AppData\Local 14.5 万条目 ≈ 7.3s ≈ 20 条目/ms；预算换算成条目硬上限用 */
const ENTRIES_PER_MS = 20;

/**
 * 遍历查询：dirs 为空不假装能搜（直接返回空 + note 点名未选目录）。
 * 时钟可能粗粒度/冻结（注入 now），所以除 `now() - start > budgetMs` 外再加条目数硬上限兜底，
 * 保证「预算先到」与「上限先到」两种不全能被确定性地分开（wk-4）。
 */
export async function walkSearch({ q, limit, dirs, fsMod, pathMod, now, budgetMs = 4000, shouldStop }) {
  const dirList = Array.isArray(dirs) ? dirs.filter((d) => typeof d === 'string' && d) : [];
  if (dirList.length === 0) {
    return { rows: [], walked: 0, truncated: false, timedOut: false, skipped: [], note: '未选目录：到设置页 → 搜索通路 里添加要覆盖的目录' };
  }
  const tokens = tokensOf(q);
  if (tokens.length === 0) {
    return { rows: [], walked: 0, truncated: false, timedOut: false, skipped: [], note: '关键字为空，未执行遍历' };
  }
  const start = now();
  const hardEntryCap = Math.max(1, Math.trunc(budgetMs * ENTRIES_PER_MS));
  const rows = [];
  const skipped = [];
  let walked = 0;
  let truncated = false;
  let timedOut = false;
  let stopped = false;
  const stack = [...dirList];

  outer: while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fsMod.readdirSync(dir);
    } catch (error) {
      skipped.push(`${dir}：${(error && error.code) || 'ERR'} ${(error && error.message) || ''}`.trim());
      continue;
    }
    const subDirs = [];
    for (const entry of entries) {
      walked += 1;
      // 预算闸：条目硬上限逐条查（冻结时钟也能生效），wall-clock 每 200 条目查一次（避免高频调 now）
      if (walked > hardEntryCap || (walked % 200 === 0 && now() - start > budgetMs)) {
        timedOut = true;
        break;
      }
      if (shouldStop && shouldStop()) { stopped = true; break; }
      const name = typeof entry === 'string' ? entry : (entry && entry.name);
      if (!name) continue;
      const fullPath = pathMod.join(dir, name);
      const isDirent = typeof entry !== 'string' && typeof (entry && entry.isDirectory) === 'function';
      if (isDirent && entry.isDirectory()) {
        subDirs.push(fullPath);
        continue;
      }
      let st;
      try {
        st = fsMod.statSync(fullPath);
      } catch (error) {
        skipped.push(`${fullPath}：${(error && error.code) || 'ERR'} ${(error && error.message) || ''}`.trim());
        continue;
      }
      if (st.isDirectory()) {
        subDirs.push(fullPath);
        continue;
      }
      if (!matchName(name, tokens)) continue;
      rows.push({
        name,
        dir,
        size: Number.isFinite(st.size) ? st.size : null,
        mtime: Number.isFinite(st.mtimeMs) ? st.mtimeMs : null,
        source: 'walk',
        path: fullPath,
      });
      if (rows.length >= limit) {
        truncated = true;
        break outer;
      }
    }
    if (timedOut || stopped) break;
    for (const sd of subDirs) stack.push(sd);
  }

  const note = stopped ? '用户停止，遍历未完成' : '';
  return { rows, walked, truncated, timedOut, skipped, note };
}
