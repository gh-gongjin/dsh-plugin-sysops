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

  /**
   * 逐监听器隔离：手法与"抛错也要留痕"的要求照 `lib/collect/service.js:61-66`（那边同样是防 SSE 写失败）。
   * 一个监听器抛错既不许带走别的监听器，也不许打断 `record()` 的尾巴 —— 中断一次就同时丢掉
   * 「时间线落库」和「存储不可用的降级事件」，只剩蓝点 +1，那是本文件头第 4 条约定最坏的一种破法。
   * 这不是 spec §4.7 禁止的静默 catch：静默指的是不留痕、不置状态；这里把被甩出的错误原样写进 warn。
   */
  const emit = (e) => {
    for (const cb of listeners) {
      try { cb(e); } catch (err) { logger?.warn?.(`[sysops] 告警订阅者抛错：${err?.message ?? err}`); }
    }
  };
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
      // 名差桥：`ev.type`/`ev.key` 是采集侧的事件名，`rule.metric` 是规则侧的指标键，两条命名域在这里对上。
      // 'proc' 这个字面量住在 lib/collect/service.js（emit proc 的三处），'procCpu' 住在
      // lib/alerts/rules.js 的 DEFAULT_RULES[4].metric 与 prefs.alerts 的键（rule-10 钉两侧一致）。
      // 改 collect 的事件名或改 rules.js 的 metric 键，必须同时改这里 —— 漏一侧的表现是整条规则静默不评估。
      if (rule.metric !== (ev.type === 'proc' ? 'procCpu' : ev.key)) continue;
      if (!ruleState(rule, states).on) continue;
      const hit = ev.type === 'proc'
        ? evaluateProc(rule, ev.rows, now(), lastHitAt.get(rule.id) ?? null)
        : evaluate(rule, snap.series?.[rule.metric], now(), lastHitAt.get(rule.id) ?? null);
      // record 是 async：里面残任何一处抛错，到这里是已 settled 的 rejection，采集侧的逐监听器
      // try/catch 救不到它（那是 collect 的 listeners，不是本模块的），而 `void record(hit)` 丢弃
      // promise ⇒ Node 24 默认 --unhandled-rejections=throw 会连宿主进程一起打死。
      // emit 加了隔离之后这条路径理论上到不了；留这层兜底是因为「record 里有没有可抛点」由后续改动决定，
      // 不由这一行决定：宁可掉一条告警并留痕，也不能让插件把 Cordis 带走。
      // 形态选 logger.warn 而不是再 emit 一条事件：listeners 本身可能正是抛错源，emit 是走同一条塌掉的路。
      if (hit) void record(hit).catch((e) => logger?.warn?.(`[sysops] 告警编排兜底：record 抛错 ${e?.message ?? e}`));
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
      try {
        return { rows: await hitStore.list({ limit }), error: null };
      } catch (e) {
        // 可用分支也要降级：`available` 只探测"宿主给没给设施 + 有没有 close"（store.js:112-115），
        // 而 list() 走 ensureDomain()，域 open() 失败在那里抛带 code 的 RECORDS_UNAVAILABLE
        // （store.js:66-81）⇒ "宿主给了 storageDomain 但域打不开"这条真实降级路上它仍是 true。
        // 降级形状由持有降级语义的本模块单点给出：Task 18 写 `res.json(await svc.hits())` 不带 try/catch
        // 时，一张卡的重试风暴就会变成未处理 rejection。code 一并透出（store.js:18 注明 Task 18 按 e.code 分支）。
        return { rows: [], error: String(e?.message ?? e), code: e?.code };
      }
    },
    unread: () => unreadCount,
    markRead: () => { unreadCount = 0; },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    dispose() {
      if (unsub) { unsub(); unsub = null; }
      listeners.clear();
      // lastHitAt 与 unreadCount 故意保留：本实例 dispose 即**终态**，重启走新实例 ——
      // 新实例的空 lastHitAt 正是 DEFAULT_RULES 里 r3"每次开机后首次必报"（rules.js:19）成立的地方，
      // 这里清了反而会把"刚开机就必报一次磁盘"变成看冷却脸。装配契约的收口归 Task 19/24，本轮不加 disposed 守卫。
    },
  };
}
