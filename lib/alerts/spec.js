/**
 * 系统产生的记录：告警触发历史 / 清理清单快照 / 清理执行留痕。
 * 与 `sysops_prefs` 分 domain 的理由同参照实现：这些不是"用户设的、要被覆盖的"，
 * 而是**事实**，写进去就不能改（除裁剪最旧）。
 */
// 只 import 用得着的：requiredInt / optionalNumber / optionalInt 是 Task 13 那两张表的事，现在引了就是死引用
import { defineDomain, domainTable, record, requiredString, requiredNumber, optionalString } from '../kv-schema.js';

export const RECORD_DOMAIN = 'sysops_records';
export const RECORD_VER = 1;
/** 触发历史裁剪上限（spec §3.5）。 */
export const ALERT_HIT_MAX = 200;

const alertHit = record({
  hitId: requiredString('alert_hit.hitId'),
  ruleId: requiredString('alert_hit.ruleId'),
  name: requiredString('alert_hit.name'),
  metric: requiredString('alert_hit.metric'),
  t: requiredNumber('alert_hit.t'),
  value: requiredNumber('alert_hit.value'),
  note: optionalString('alert_hit.note'),
}, 'alert_hit');

export const alertsDomain = defineDomain({
  name: RECORD_DOMAIN,
  version: RECORD_VER,
  tables: {
    alert_hit: domainTable(alertHit),
    // clean_plan / clean_log 在 Task 13 追加到这里（同一个 domain，避免 open 两次）
  },
});

/**
 * 行 key：`h-<触发毫秒>-<规则id>`，同一规则同一毫秒不会重复。
 * **但别拿它排序**：字典序只在毫秒位数相同（真机 13 位）时等于时间序，假时钟下 `h-9-r1 > h-1000-r1`。
 * 裁剪与 list 一律按 `Number(v.t)` 数值排（Ruling-55，hit-2 钉这条）。
 */
export const hitKey = (hit) => `h-${hit.t}-${hit.ruleId}`;
