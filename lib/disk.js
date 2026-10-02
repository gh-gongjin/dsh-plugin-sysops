/**
 * 系统盘容量读数的唯一口径（S12-A，2026-09-29）。
 *
 * 为什么要有这个文件：`fs.statfsSync()` 在真机上只交低阶扇区字段 ——
 * 现采读数（`node tmp/probe-s12-disk.mjs` → `tmp/s12-disk.txt`，Node v24）：
 * 键为 `type / bsize / blocks / bfree / bavail / files / ffree`，**没有 `available`，也没有 `total`**。
 * 而清理侧三处早先都写成 `fsMod.statfsSync('C:')?.available`（`lib/clean/service.js` 两处、
 * `lib/clean/executor.js` 一处）⇒ 真机上恒 `undefined`：`beforeFree` 落成 0、`afterFree` 落成 null，
 * 「释放了多少」这条留痕在真机上从来没有过一次真数。测试全绿是因为**假桩给的是 `{ available }`
 * 这个宿主根本没有的键** —— 桩替宿主圆谎，真机才炸（spec §8.7 / S9 同型事故）。
 *
 * 折字节的口径与 `lib/collect/l0-node.js` 一致：`blocks * bsize` 总容量、`bavail * bsize` 可用
 * （`bavail` 是非特权用户可用的块数，比 `bfree` 更贴近用户看到的「可用空间」）。
 * 字段缺失或非法一律交 `null`，**不凑 0**：凑 0 会被界面读成「盘满了」。
 */
export function statfsBytes(st) {
  const s = st && typeof st === 'object' ? st : {};
  const bsize = Number(s.bsize);
  const blocks = Number(s.blocks);
  const bavail = Number(s.bavail);
  if (!Number.isFinite(bsize) || bsize <= 0) return { total: null, free: null };
  return {
    total: Number.isFinite(blocks) && blocks >= 0 ? blocks * bsize : null,
    free: Number.isFinite(bavail) && bavail >= 0 ? bavail * bsize : null,
  };
}
