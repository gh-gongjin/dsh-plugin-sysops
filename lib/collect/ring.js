/**
 * 按源分带的环形缓冲。
 *
 * 三条上限各自解决一个真实故障：
 *  - `maxPoints`：内存上界。1800 点 × 4 条曲线 ≈ 100KB，够 30min@1s。
 *  - `windowMs`：时间窗。用户要的是"最近 30 分钟"，不是"我能装多少"。
 *  - 乱序 / 脏值丢弃：**一个假点会在曲线上被读成真实尖峰**（spec §4.2 第四类），
 *    所以宁可不画，也要把丢弃数留着让界面能说"丢了 N 个不可信的点"。
 *
 * `opts.percent` 为真时把值域限制在 0~100（cpu / mem / 可用率），
 * 字节类指标（网速、剩余容量）不传这个选项。
 */
export function createRing({ windowMs = 30 * 60 * 1000, maxPoints = 1800, percent = false, now = () => Date.now() } = {}) {
  let pts = [];
  let droppedStale = 0;
  let droppedBad = 0;

  function prune() {
    const floor = now() - windowMs;
    while (pts.length && pts[0].t < floor) pts.shift();
    while (pts.length > maxPoints) pts.shift();
  }

  return {
    push(point) {
      if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.v)) {
        droppedBad += 1;
        return 'bad';
      }
      if (point.v < 0 || (percent && point.v > 100)) {
        droppedBad += 1;
        return 'bad';
      }
      if (pts.length && point.t <= pts[pts.length - 1].t) {
        droppedStale += 1;
        return 'stale';
      }
      pts.push({ t: point.t, v: point.v });
      prune();
      return 'ok';
    },
    series(from, to) {
      prune();
      if (from === undefined && to === undefined) return pts.slice();
      const lo = from === undefined ? -Infinity : from;
      const hi = to === undefined ? Infinity : to;
      return pts.filter((p) => p.t >= lo && p.t <= hi);
    },
    latest() {
      prune();
      return pts.length ? pts[pts.length - 1] : null;
    },
    stats() {
      prune();
      return { points: pts.length, droppedStale, droppedBad };
    },
    clear() {
      pts = [];
    },
  };
}
