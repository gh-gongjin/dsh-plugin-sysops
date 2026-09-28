/**
 * 暂存目录：「隔离」这条路径的落点。
 *
 * 三条要点：
 *  1. **绝不覆盖**：目标重名时在名字前加 `2-` / `3-` **前缀**，撞到底（99 次）也宁可失败。
 *  2. **EXDEV 回退先写后删**（spec §4.3）：复制失败 → 原件不动；复制成功但删源失败
 *     → 返回 ok:false 并说明「副本已在暂存区，原件未删」，让用户自己决定。
 *  3. **暂存目录不能落在被清理路径里**，否则第二次扫描会清掉第一次的后悔药。
 *     这条靠 `forbiddenPrefixes`，由调用方喂（Task 15 传 active rules 的 `dir` 集）；
 *     guard 对 Temp 一类可清理区是放行的，它管不了这个。
 */
import { join } from 'node:path';
import { check } from './guard.js';

// T14-G：必须用 path.join —— 字符串直拼遇到带尾分隔符的 appData 会多出一个反斜杠，
// 而 `prefq-4` 是拿 `path.join` 的结果对比的。
export const DEFAULT_QUARANTINE = (appData) => join(appData, 'dsh-plugin-sysops', 'quarantine');

export function dayDir(now, rootDir) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${rootDir}\\${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createQuarantine({ rootDir, fsMod, pathMod, logger, now, forbiddenPrefixes = [] }) {
  const log = (m) => logger?.warn?.(`[sysops] ${m}`);

  async function ensureRoot() {
    const g = check(rootDir);
    if (!g.allow) throw new Error(`暂存目录不合法：${g.why}`);
    for (const p of forbiddenPrefixes) {
      if (rootDir.toLowerCase().startsWith(p.toLowerCase())) {
        throw new Error(`暂存目录落在被清理路径 ${p} 内部，会被自己清掉，请改设置里的暂存目录`);
      }
    }
    if (!fsMod.existsSync(rootDir)) fsMod.mkdirSync(rootDir, { recursive: true });
    return rootDir;
  }

  function freeDest(dir, base) {
    let dest = `${dir}\\${base}`;
    for (let i = 2; fsMod.existsSync(dest) && i < 100; i += 1) dest = `${dir}\\${i}-${base}`;
    if (fsMod.existsSync(dest)) throw new Error(`暂存目录里 ${base} 的重名条目过多，停止以免覆盖`);
    return dest;
  }

  async function stash(absPath) {
    const g = check(absPath);
    if (!g.allow) return { ok: false, dest: '', method: 'none', why: g.why };
    // 配置错 → 抛异常（不是 {ok:false}）：整批该停。Task 15 在批次外层 catch。
    await ensureRoot();
    const dir = dayDir(now(), rootDir);
    if (!fsMod.existsSync(dir)) fsMod.mkdirSync(dir, { recursive: true });
    const base = pathMod.basename(absPath);
    // T14-C：这里是显式 try/catch + 提前 return。原稿把一个 IIFE 的返回值（抛错时是**对象**）
    // 赋给 isDir 再往下走，于是「源已被别的程序删掉」这个真机上最常见的条目级失败，
    // 会被报成 method:'move'（同盘 rename 抛 ENOENT）或「目录跨卷复制未实现」（先抛 EXDEV 时）。
    let isDir;
    try {
      isDir = fsMod.statSync(absPath).isDirectory();
    } catch (e) {
      return { ok: false, dest: '', method: 'none', why: `${base} 读不到：${e.code ?? e.message}` };
    }
    let dest;
    try { dest = freeDest(dir, base); } catch (e) { return { ok: false, dest: '', method: 'none', why: e.message }; }
    try {
      fsMod.renameSync(absPath, dest);
      return { ok: true, dest, method: 'move', why: '' };
    } catch (e) {
      if (e.code !== 'EXDEV') {
        log(`隔离 ${absPath} 移动失败：${e.code ?? ''} ${e.message}`);
        return { ok: false, dest: '', method: 'move', why: `${e.code ?? ''} ${e.message}` };
      }
    }
    // 跨卷回退：先复制到暂存区，成功后再删源
    try {
      if (isDir) throw new Error('目录跨卷复制未实现，请改用「直接删除」或把暂存目录放到同一盘');
      fsMod.copyFileSync(absPath, dest);
    } catch (e) {
      log(`跨卷复制失败，原件保留：${e.message}`);
      return { ok: false, dest: '', method: 'copy-delete', why: `复制失败，原件未动：${e.message}` };
    }
    try {
      fsMod.unlinkSync(absPath);
    } catch (e) {
      log(`副本已写入 ${dest} 但源删除失败：${e.code ?? ''} ${e.message}`);
      return { ok: false, dest, method: 'copy-delete', why: `副本已在暂存区，源删除失败（${e.code ?? e.message}）—— 需手动确认后再删源` };
    }
    return { ok: true, dest, method: 'copy-delete', why: '' };
  }

  async function stats() {
    const days = fsMod.existsSync(rootDir) ? fsMod.readdirSync(rootDir) : [];
    let files = 0; let bytes = 0; let oldest = null;
    for (const d of days) {
      const full = `${rootDir}\\${d}`;
      if (!fsMod.statSync(full).isDirectory()) continue;
      if (!oldest || d < oldest) oldest = d;
      for (const f of fsMod.readdirSync(full)) {
        files += 1;
        try { bytes += fsMod.statSync(`${full}\\${f}`).size; } catch (e) { log(`暂存件 ${f} 统计失败：${e.code ?? e.message}`); }
      }
    }
    return { dirs: days.length, files, bytes, oldest };
  }

  return { ensureRoot, stash, stats, rootDir: () => rootDir };
}
