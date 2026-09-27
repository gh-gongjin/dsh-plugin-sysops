/**
 * 系统产生的记录：告警触发历史 / 清理清单快照 / 清理执行留痕。
 * 与 `sysops_prefs` 分 domain 的理由同参照实现：这些不是"用户设的、要被覆盖的"，
 * 而是**事实**，写进去就不能改（除裁剪最旧）。
 */
import {
  defineDomain,
  domainTable,
  record,
  requiredString,
  requiredNumber,
  requiredInt,
  optionalString,
  optionalNumber,
  optionalInt,
  arrayOf,
  arrayOfItem,
} from '../kv-schema.js';

export const RECORD_DOMAIN = 'sysops_records';
export const RECORD_VER = 1;
/** 触发历史裁剪上限（spec §3.5）。 */
export const ALERT_HIT_MAX = 200;
/** 清单快照保留段数：一次清理会话最多回看 20 份清单。 */
export const PLAN_KEEP = 20;
/** 执行留痕保留条数。 */
export const LOG_KEEP = 100;

const alertHit = record({
  hitId: requiredString('alert_hit.hitId'),
  ruleId: requiredString('alert_hit.ruleId'),
  name: requiredString('alert_hit.name'),
  metric: requiredString('alert_hit.metric'),
  t: requiredNumber('alert_hit.t'),
  value: requiredNumber('alert_hit.value'),
  note: optionalString('alert_hit.note'),
}, 'alert_hit');

const cleanItem = {
  id: requiredString('clean_plan.items[].id'),
  ruleId: requiredString('clean_plan.items[].ruleId'),
  ruleName: requiredString('clean_plan.items[].ruleName'),
  kind: requiredString('clean_plan.items[].kind'),
  path: requiredString('clean_plan.items[].path'),
  size: requiredNumber('clean_plan.items[].size'),
  count: requiredInt('clean_plan.items[].count'),
  atime: requiredNumber('clean_plan.items[].atime'),
  mtime: requiredNumber('clean_plan.items[].mtime'),
  riskLevel: requiredString('clean_plan.items[].riskLevel'),
  riskWhy: optionalString('clean_plan.items[].riskWhy'),
};

const cleanPlan = record({
  planId: requiredString('clean_plan.planId'),
  at: requiredNumber('clean_plan.at'),
  beforeFree: requiredNumber('clean_plan.beforeFree'),
  afterFree: optionalNumber('clean_plan.afterFree'),
  modeDefault: requiredString('clean_plan.modeDefault'),
  rulesUsed: arrayOf('clean_plan.rulesUsed', { id: requiredString('rulesUsed[].id'), n: requiredString('rulesUsed[].n'), kind: requiredString('rulesUsed[].kind') }),
  // 这 10 个字段是 Task 12 扫描器产物的全部字段，逐个声明（record/arrayOf 会静默丢弃未声明字段，
  // 漏一个就等于线上丢数据而测试全绿）；risk 的嵌套 {level, why} 由 plan-store 投影成扁平两列。
  items: arrayOf('clean_plan.items', cleanItem, { required: true }),
  totals: record({ n: requiredInt('totals.n'), bytes: requiredNumber('totals.bytes') }, 'totals'),
}, 'clean_plan');

const cleanLog = record({
  logId: requiredString('clean_log.logId'),
  planId: requiredString('clean_log.planId'),
  startedAt: requiredNumber('clean_log.startedAt'),
  finishedAt: optionalNumber('clean_log.finishedAt'),
  mode: requiredString('clean_log.mode'),
  itemIds: arrayOfItem('clean_log.itemIds', requiredString('itemIds[]')),
  ok: optionalInt('clean_log.ok'),
  skipped: optionalInt('clean_log.skipped'),
  failed: optionalInt('clean_log.failed'),
  rejected: optionalInt('clean_log.rejected'),
  bytesFreed: optionalNumber('clean_log.bytesFreed'),
  afterFree: optionalNumber('clean_log.afterFree'),
  note: optionalString('clean_log.note'),
  detail: optionalString('clean_log.detail'),
}, 'clean_log');

export const recordsDomain = defineDomain({
  name: RECORD_DOMAIN,
  version: RECORD_VER,
  tables: {
    alert_hit: domainTable(alertHit),
    clean_plan: domainTable(cleanPlan),
    clean_log: domainTable(cleanLog),
  },
});

/**
 * 行 key：`h-<触发毫秒>-<规则id>`，同一规则同一毫秒不会重复。
 * **但别拿它排序**：字典序只在毫秒位数相同（真机 13 位）时等于时间序，假时钟下 `h-9-r1 > h-1000-r1`。
 * 裁剪与 list 一律按 `Number(v.t)` 数值排（Ruling-55，hit-2 钉这条）。
 */
export const hitKey = (hit) => `h-${hit.t}-${hit.ruleId}`;

/**
 * 清单快照的行 key 就是 `planId` 本身（`p-<毫秒>-<随机>` 已含时间且唯一）。
 * 与 `hitKey` 同理：**不许拿它排序**（Ruling-55）—— 裁剪与 list 看 `Number(v.at)`。
 */
export const planKey = (planId) => String(planId);

/** 执行留痕的行 key 就是 `logId` 本身，同上不许拿它排序。 */
export const logKey = (logId) => String(logId);
