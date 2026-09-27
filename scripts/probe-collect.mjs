#!/usr/bin/env node
/**
 * 采集代价实测（spec §1.2 的六条 + 计划期修正的两条）。
 * 用法：node scripts/probe-collect.mjs
 * 输出就是一张表；跑完把它和 spec §1.2 对一遍，偏差 >20% 要回写 spec。
 */
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { COUNTER_ARGS, decodePd } from '../lib/collect/l1a-typeperf.js';

const ms = (fn, rounds = 1) => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) fn();
  return Number(process.hrtime.bigint() - t) / 1e6 / rounds;
};
const row = (name, value, note = '') => console.log(`${name.padEnd(34)} ${String(value).padStart(12)}  ${note}`);

console.log('\n== L0 ==');
row('os.cpus() 单次均耗时(ms)', ms(() => os.cpus(), 100).toFixed(2), `逻辑核 ${os.cpus().length}`);
const st = fs.statfsSync('C:\\');
row('fs.statfsSync(C:) 耗时(ms)', ms(() => fs.statfsSync('C:\\'), 20).toFixed(1));
row('C: 总容量(GB)', (st.blocks * st.bsize / 2 ** 30).toFixed(1));
row('C: 可用(GB)', (st.bavail * st.bsize / 2 ** 30).toFixed(1));

console.log('\n== L1a ==');
const cold = spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '1'], { encoding: 'buffer', windowsHide: true });
row('typeperf -sc 1 冷启动(ms)', ms(() => spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '1'], { windowsHide: true }), 1).toFixed(0));
const warm = ms(() => spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '3'], { windowsHide: true }), 1);
row(`typeperf -sc 3 整窗(ms)`, warm.toFixed(0), `减掉 3×1s 采样 ⇒ 暖身 ≈ ${(warm - 3000).toFixed(0)}ms / 窗（与"首行到达"那行互相印证），30 样本窗摊薄后 <1%`);
// 真机实测：typeperf 的 stdout 以 `0d 0a`（空行）起头，表头在第二个非空行 —— 直接取 [0] 会打印空白，
// 那一行就等于什么都没测。取首个非空行并把它是不是表头如实标出来。
const firstLine0 = decodePd(cold.stdout).split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
row('typeperf 首个非空行前 60 字符', firstLine0.slice(0, 60), `是表头=${/^\(PDH-CSV/.test(firstLine0.replace(/^"/, '')) ? '是' : '否（要看一眼）'}；机器名为 GBK 字节，解析层只取实例名与计数器名`);
const zero = spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '0'], { windowsHide: true, timeout: 8000 });
row('typeperf -sc 0 exitCode', zero.status, '0 且只出一个样本 = 无控制台管道下不提供无限流式（修正 #1）');
// 启动看门狗校准：Task 5 的 STARTING 阈值是 3 × intervalMs = 3000ms。量"进程起来 → stdout 第一行"，
// 超过 1500ms（阈值一半）就得为 l1a 单独放宽 heartbeatFactor，否则慢机器上反复误杀并累计到 exited-max。
const firstLine = await new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn('typeperf', [...COUNTER_ARGS, '-sc', '5', '-si', '1'], { windowsHide: true });
  let acc = Buffer.alloc(0);
  p.stdout.on('data', (b) => {
    acc = Buffer.concat([acc, b]);
    if (acc.indexOf(0x0a) >= 0) { resolve(Date.now() - t0); p.kill(); }
  });
  p.on('exit', () => resolve(-1));   // 没等到行就退了 = 本机这条路不通，如实记 -1
});
row('typeperf 首行到达(ms)', firstLine, '看门狗 3000ms；>1500ms 要为 l1a 放宽');

console.log('\n== L1b ==');
row('Get-CimInstance Win32_Process(ms)',
  ms(() => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process | Measure-Object).Count'], { windowsHide: true }), 1).toFixed(0));

console.log('\n== L2（最贵的一项，约 7s）==');
const root = path.join(os.tmpdir(), 'sysops-probe-walk-' + Date.now());
fs.mkdirSync(root, { recursive: true });
for (let i = 0; i < 400; i++) {
  const d = path.join(root, 'd' + (i % 8));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'f' + i + '.tmp'), 'x'.repeat(1024));
}
let entries = 0;
const walkStart = Date.now();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    entries += 1;
    if (e.isDirectory()) walk(path.join(dir, e.name));
  }
};
walk(path.join(process.env.LOCALAPPDATA, 'Temp'));
row('遍历 %LOCALAPPDATA%\\Temp 条目', entries, `${Date.now() - walkStart}ms`);
fs.rmSync(root, { recursive: true, force: true });
console.log('\n探针结束。偏差 >20% 时更新 docs/superpowers/specs/2026-09-27-dsh-plugin-sysops-design.md §1.2。\n');
