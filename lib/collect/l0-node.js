/**
 * L0 —— 纯 Node 的低成本采样，**不起子进程**。
 *
 * 实测代价（spec §1.2）：`os.cpus()` 单次 0.7ms、`fs.statfsSync('C:')` 0ms，
 * 所以 1s 档在主进程内跑完全无感。CPU 占用必须用**两次样本的差值**算：
 * `os.cpus().times` 是自启动以来的累计ticks，直接读出来的是"开机至今平均"，
 * 不是"现在多忙"—— 这是这类监控最常见的错法。
 */
import os from 'node:os';
import fs from 'node:fs';
import { statfsBytes } from '../disk.js';

export function computeCpuPct(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length !== cur.length) return NaN;
  let busyDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < cur.length; i += 1) {
    const a = prev[i]?.times;
    const b = cur[i]?.times;
    if (!a || !b) return NaN;
    const idleDelta = b.idle + b.irq - (a.idle + a.irq);
    const total = b.user + b.nice + b.sys + b.idle + b.irq - (a.user + a.nice + a.sys + a.idle + a.irq);
    if (!Number.isFinite(idleDelta) || !Number.isFinite(total) || total <= 0) return NaN;
    busyDelta += total - idleDelta;
    totalDelta += total;
  }
  if (totalDelta <= 0) return NaN;
  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
}

export function computeMemPct(total, free) {
  if (!Number.isFinite(total) || total <= 0) return NaN;
  return Math.min(100, Math.max(0, ((total - free) / total) * 100));
}

export function createL0({ osMod = os, fsMod = fs, drive = 'C:', now = () => Date.now() } = {}) {
  let prevCpus = null;
  return {
    read() {
      const cpus = osMod.cpus();
      const cpu = computeCpuPct(prevCpus, cpus);
      prevCpus = cpus;
      let st;
      try {
        st = fsMod.statfsSync(`${drive}\\`);
      } catch (e) {
        // 盘符不存在 / 权限问题：说清是哪个盘，别让调用方猜（spec §4.7：禁止静默）
        throw new Error(`读取 ${drive} 盘容量失败：${e?.message ?? e}`);
      }
      // 折字节走 lib/disk.js 的唯一口径：statfsSync 只交 bsize/blocks/bavail 这类扇区字段，
      // 清理侧的 beforeFree/afterFree 也从那里换算 —— 两处口径必须一致，否则「监控说还有 71 GB」
      // 和「留痕说释放了 0 B」会同屏出现（S12-A）。
      const { total, free } = statfsBytes(st);
      if (total === null || free === null) {
        throw new Error(`读取 ${drive} 盘容量失败：statfs 返回里没有可用的 bsize / blocks / bavail 字段`);
      }
      return {
        t: now(),
        cpu,
        mem: computeMemPct(osMod.totalmem(), osMod.freemem()),
        diskFree: free,
        diskTotal: total,
      };
    },
    reset() {
      prevCpus = null;
    },
  };
}
