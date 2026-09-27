/**
 * 阈值判定：纯函数，零 IO。
 *
 * 三条容易写错的约定：
 *  1. **连续 N 次**看的是尾部 N 个点，不是"历史上出现过 N 次"。
 *  2. **冷却**用最近一次触发时间比较，触发时刻取样本时间而不是 now ——
 *     否则 SSE 延迟会让同一次尖峰报两遍。
 *  3. 依赖的采集源关了 → **不参与评估**（不是评估完再隐藏），闸门由 ruleState 给，
 *     service 里先问 ruleState 再 evaluate。
 */
import { SOURCE_KEYS } from '../prefs/spec.js';

export const ALERT_METRICS = ['cpu', 'mem', 'diskFreePct', 'netDown', 'procCpu'];

/** 与已确认原型 prototype/index.html 的 rules 数组逐字对应；改文案要同步原型。 */
export const DEFAULT_RULES = [
  { id: 'r1', n: 'CPU ≥ 85% 连续 3 次', d: '冷却 10 分钟 · 落点：监控页时间线', dep: 'l0', metric: 'cpu', op: 'gte', value: 85, consecutive: 3, cooldownMs: 10 * 60_000 },
  { id: 'r2', n: '内存占用率 ≥ 90%', d: '冷却 15 分钟', dep: 'l0', metric: 'mem', op: 'gte', value: 90, consecutive: 1, cooldownMs: 15 * 60_000 },
  { id: 'r3', n: 'C 盘可用 < 15%', d: '冷却 24 小时 · 每次开机后首次必报', dep: 'l0', metric: 'diskFreePct', op: 'lte', value: 15, consecutive: 1, cooldownMs: 24 * 60 * 60_000 },
  { id: 'r4', n: '下行持续 > 20 MB/s 满 1 分钟', d: '依赖常驻 typeperf', dep: 'l1a', metric: 'netDown', op: 'gte', value: 20e6, consecutive: 60, cooldownMs: 10 * 60_000 },
  { id: 'r5', n: '单进程 CPU > 60%', d: '依赖进程榜采集（PowerShell）', dep: 'l1b', metric: 'procCpu', op: 'gte', value: 60, consecutive: 1, cooldownMs: 10 * 60_000, userOff: true },
];

const STATE_ON = 'on';

export function ruleState(rule, srcStates) {
  const src = srcStates?.[rule.dep];
  const dim = !SOURCE_KEYS.includes(rule.dep) || src !== STATE_ON;
  return { dim, on: !dim && rule.userOff !== true, st: dim ? '依赖的采集已关闭' : (rule.userOff ? '已暂停' : '监控中') };
}

function tailAscending(points, n) {
  if (!Array.isArray(points) || points.length < n) return null;
  const tail = points.slice(-n);
  for (let i = 1; i < tail.length; i += 1) {
    if (!(tail[i].t > tail[i - 1].t)) return null; // 点序异常直接不评估（rule-7）
  }
  return tail;
}

const breach = (rule, v) => (rule.op === 'lte' ? v < rule.value : v >= rule.value);

export function evaluate(rule, points, now, lastHitAt) {
  const tail = tailAscending(points, rule.consecutive);
  if (!tail) return null;
  if (Number.isFinite(lastHitAt) && now - lastHitAt < rule.cooldownMs) return null;
  if (!tail.every((p) => breach(rule, p.v))) return null;
  const last = tail[tail.length - 1];
  return {
    ruleId: rule.id,
    name: rule.n,
    metric: rule.metric,
    t: last.t,
    value: last.v,
    note: rule.d,
  };
}

/** 进程榜不是时序点而是"某一轮的 rows"，判定单独一个入口，别硬塞进 evaluate。 */
export function evaluateProc(rule, rows, now, lastHitAt = null) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (Number.isFinite(lastHitAt) && now - lastHitAt < rule.cooldownMs) return null;
  // 只按 pid 排除，不按名字：pid 0 那行的 Name 取决于 _Total 与 Idle 谁后写进哈希表。
  // pid 为 null 的行照判 —— 那是读不到 pid 的真进程，不是聚合值。
  const hit = rows.find((r) => r.pid !== 0 && Number.isFinite(r.cpuPct) && breach(rule, r.cpuPct));
  if (!hit) return null;
  return { ruleId: rule.id, name: rule.n, metric: rule.metric, t: now, value: hit.cpuPct, note: hit.name };
}

/**
 * 用户阈值覆盖内置规则。
 *
 * 为什么用「覆盖」而不是「替换整张表」：内置规则的形状（op / metric / dep / 文案）
 * 与代码绑定 —— 让用户能改出一张不认识的规则表，等于把 ruleState 的依赖闸门变成可绕过的装饰。
 * 能被用户改的只有三个数 + 一个开关。
 */
export function mergeRules(builtin, prefsAlerts) {
  const over = prefsAlerts && typeof prefsAlerts === 'object' ? prefsAlerts : {};
  return builtin.map((rule) => {
    const o = over[rule.metric];
    if (!o) return { ...rule };
    const merged = { ...rule };
    if (Number.isFinite(o.value)) merged.value = o.value;
    if (Number.isInteger(o.consecutive) && o.consecutive >= 1) merged.consecutive = o.consecutive;
    if (Number.isInteger(o.cooldownSec) && o.cooldownSec >= 60) merged.cooldownMs = o.cooldownSec * 1000;
    if (o.enabled === false) merged.userOff = true;
    if (o.enabled === true) merged.userOff = false;
    return merged;
  });
}
