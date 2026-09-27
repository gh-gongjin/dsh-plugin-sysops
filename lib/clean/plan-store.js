/**
 * 清单快照仓储（append-only）。
 *
 * 为什么快照要整份存而不是只存 itemIds：Task 15 的 re-stat 判定要拿
 * 「快照那一刻的 size / mtime / atime」跟现状比 —— 现状会自己变，历史不存下来就没法比。
 * 为什么同 planId 再写要抛错：清单一旦展示给用户，改内容不改 id 会让
 * 「看到 A 删 B」重新变得可能，那正是两段式要消灭的东西。
 *
 * 骨架（`facilityOf` / `assertUsable` / `ensureDomain` / `available` + `close` + 串行写队列 +
 * 按设施去重的域登记表）一律走 `lib/kv-records-base.js`（Ruling-63：不许抄出第三、第四份）。
 */
import { recordsDomain, PLAN_KEEP, planKey } from '../records/spec.js';
import { createRecordRepo, RECORDS_ERROR, RecordsError } from '../kv-records-base.js';

const TABLE = 'clean_plan';

/** 默认发号：`p-<落库毫秒>-<4 位随机>`。测试注入 `newId` 才能拿到确定的 id。 */
const defaultNewId = (now) => `p-${now()}-${Math.floor(1000 + Math.random() * 9000)}`;

/**
 * **一次显式投影**（Ruling-71 T13-A）：Task 12 扫描器产出的是嵌套 `risk: { level, why }`，
 * 而 `clean_plan.items[]` 声明的是扁平 `riskLevel` / `riskWhy`（Task 15/22 只认扁平名）。
 * 十个字段逐个白名单取，**不许 `...it` 展开** —— `record()` 会静默丢掉未声明的 `risk`，
 * 而 `riskLevel` 是必填，展开写法每条快照都会抛 `RECORDS_INVALID`。
 */
function projectItem(it) {
  return {
    id: it.id,
    ruleId: it.ruleId,
    ruleName: it.ruleName,
    kind: it.kind,
    path: it.path,
    size: it.size,
    count: it.count,
    atime: it.atime,
    mtime: it.mtime,
    riskLevel: it.risk?.level,
    riskWhy: it.risk?.why,
  };
}

/**
 * @param options.getFacility 惰性取宿主 storageDomain 的函数（**不要直接读 ctx 属性**，Context 是代理）
 * @param options.logger 可选，只在关域失败时留一行 warn
 * @param options.now 注入时钟：快照的 `at` 取**落库时刻** —— 它是裁剪与倒序的唯一依据，
 *   而 `scanResult.at`（遍历开始时刻）同一棵树重扫两次会相同，排不出先后
 * @param options.newId 注入发号（测试要确定的 `p-1..p-N`）
 */
export function createPlanStore({ getFacility, logger, now = () => Date.now(), newId } = {}) {
  const repo = createRecordRepo({
    getFacility,
    logger,
    domain: recordsDomain,
    table: TABLE,
    labels: {
      closed: '清单快照仓储已关闭',
      noFacility: '宿主未提供 ctx.storageDomain，清理清单快照无法落库（换台机器会丢）',
      openFail: '清单快照域 open 失败',
      invalid: '清单快照校验失败',
      closeFail: '清单快照域关闭失败',
    },
  });
  const genId = newId ?? (() => defaultNewId(now));

  /**
   * 裁剪到 `PLAN_KEEP`：按 `Number(v.at)` **数值升序**删最旧，同值再按 key 的 `localeCompare` 兜底。
   * **禁止按 `planId` 字典序**（Ruling-55 / Ruling-71 T13-B）：`p-1..p-21` 的字典序把 `p-10`
   * 排在 `p-2` 前面，注入假 id 时会裁错。与 `lib/alerts/store.js` 的 `trim` 逐字同式。
   */
  async function trim(t) {
    const rows = [...t.entries()].map(([key, v]) => ({ key, at: Number(v.at) }));
    if (rows.length <= PLAN_KEEP) return 0;
    rows.sort((a, b) => a.at - b.at || String(a.key).localeCompare(String(b.key)));
    const doomed = rows.slice(0, rows.length - PLAN_KEEP);
    for (const row of doomed) await t.delete(row.key);
    return doomed.length;
  }

  /** `rulesUsed` 由 items 去重反推：界面「命中规则」列要用它，不必让上游再算一遍。 */
  function deriveRulesUsed(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (seen.has(it.ruleId)) continue;
      seen.add(it.ruleId);
      out.push({ id: it.ruleId, n: it.ruleName, kind: it.kind });
    }
    return out;
  }

  return {
    get available() {
      return repo.available;
    },

    /**
     * 冻结一份清单快照。
     *
     * 方法必须是 `async`：`assertUsable` 的同步 throw 在 `async` 里才会变成 rejection，
     * 调用方（和 `assert.rejects`）才接得住 —— 与 `lib/alerts/store.js` 的 `async append` 同形。
     * @param scanResult Task 12 `scan()` 的返回（取 `items` / `totals`）
     * @param meta `{ planId?, beforeFree, afterFree?, modeDefault }`
     * @returns 落库行（已过 schema，未声明字段被丢弃）
     * @throws `DUPLICATE` 同 planId 再写 —— 清单不可被改写
     */
    async save(scanResult, meta = {}) {
      repo.assertUsable();
      return repo.enqueue(async () => {
        const planId = meta.planId ?? genId();
        const t = await repo.tableOf();
        const key = planKey(planId);
        if (t.get(key) !== undefined) {
          throw new RecordsError(
            RECORDS_ERROR.DUPLICATE,
            `清单快照 ${planId} 已存在：清单是 append-only，改内容不改 id 会让「看到 A 删 B」重新可行`,
          );
        }
        const items = (scanResult.items ?? []).map(projectItem);
        const row = repo.parseOrInvalid({
          planId,
          at: now(),
          beforeFree: meta.beforeFree,
          afterFree: meta.afterFree,
          modeDefault: meta.modeDefault,
          rulesUsed: deriveRulesUsed(items),
          items,
          totals: scanResult.totals,
        });
        await t.put(key, row);
        await trim(t);
        return row;
      });
    },

    /** @returns 快照行，或 `null`（从未写入 —— 不等于"空"） */
    get(planId) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const row = t.get(planKey(planId));
        return row === undefined ? null : row;
      });
    },

    /** 时间倒序（新的在前）—— 与 `hits()` 同契约，调用方不重排。 */
    list({ limit = 50 } = {}) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const rows = [...t.entries()].map(([, v]) => v);
        rows.sort(
          (a, b) => Number(b.at) - Number(a.at) || String(b.planId).localeCompare(String(a.planId)),
        );
        return rows.slice(0, limit);
      });
    },

    /** 供宿主卸载时调用。本仓储进终态；登记表只在最后一个持有者放手时才真的关域。 */
    close() {
      return repo.close();
    },
  };
}

export { RECORDS_ERROR };
