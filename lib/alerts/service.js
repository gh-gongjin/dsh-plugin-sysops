/**
 * 告警编排：订阅采集事件 → 闸门 → 纯函数判定 → 落库 + 推流 + 未读。
 *
 * 四条约定：
 *  1. **闸门在前，判定在后**（spec §3.5）：闸门读 `ruleState(...).on`，它一次覆盖
 *     "依赖源不是 on"与"用户把这条规则关了"两种不报的情形。只看 `dim` 的话，
 *     关了开关的规则照样会天天往时间线里写记录（alert-5 钉死）。
 *  2. 采集服务是上游，本服务只订阅它的事件（单向依赖，service.js 不 import api.js）。
 *  3. 一轮事件只取一次 `snapshot()`：状态与 series 必须来自同一帧，
 *     否则真机上是两次采样之间的撕裂视图，判定结果无法复现。
 *  4. 落库失败必须变成一条可见事件（spec §4.7 禁止静默 catch），并且不影响后续判定。
 */
import { DEFAULT_RULES, mergeRules, ruleState, evaluate, evaluateProc } from './rules.js';

export function createAlertService({ collect, hitStore, getRulePrefs, logger, now }) {
  const lastHitAt = new Map();
  const listeners = new Set();
  let unsub = null;
  let unreadCount = 0;

  const emit = (e) => listeners.forEach((cb) => cb(e));
  const rules = () => mergeRules(DEFAULT_RULES, getRulePrefs?.());
  const srcStates = (snap) => (snap?.sources ?? []).reduce((acc, r) => ({ ...acc, [r.key]: r.state }), {});

  async function record(hit) {
    lastHitAt.set(hit.ruleId, hit.t);
    unreadCount += 1;
    emit({ type: 'alert', hit });
    if (!hitStore?.available) {
      emit({ type: 'alert-store', error: 'storageDomain 不可用，触发记录未落盘' });
      logger?.warn?.(`[sysops] 告警落库跳过：存储不可用（${hit.ruleId}）`);
      return;
    }
    try {
      await hitStore.append(hit);
    } catch (e) {
      emit({ type: 'alert-store', error: String(e?.message ?? e) });
      logger?.warn?.(`[sysops] 告警落库失败：${e?.message ?? e}`);
    }
  }

  function onCollectEvent(ev) {
    if (ev?.type !== 'metrics' && ev?.type !== 'proc') return;
    const snap = collect.snapshot();
    const states = srcStates(snap);
    for (const rule of rules()) {
      if (rule.metric !== (ev.type === 'proc' ? 'procCpu' : ev.key)) continue;
      if (!ruleState(rule, states).on) continue;
      const hit = ev.type === 'proc'
        ? evaluateProc(rule, ev.rows, now(), lastHitAt.get(rule.id) ?? null)
        : evaluate(rule, snap.series?.[rule.metric], now(), lastHitAt.get(rule.id) ?? null);
      if (hit) void record(hit);
    }
  }

  return {
    start() {
      if (unsub) return;
      unsub = collect.onEvent(onCollectEvent);
    },
    ruleRows() {
      const states = srcStates(collect.snapshot());
      return rules().map((rule) => ({ rule, st: ruleState(rule, states) }));
    },
    async hits({ limit = 50 } = {}) {
      if (!hitStore?.available) return { rows: [], error: 'storageDomain 不可用' };
      return { rows: await hitStore.list({ limit }), error: null };
    },
    unread: () => unreadCount,
    markRead: () => { unreadCount = 0; },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    dispose() {
      if (unsub) { unsub(); unsub = null; }
      listeners.clear();
    },
  };
}
