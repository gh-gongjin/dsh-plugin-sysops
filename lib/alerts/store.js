/**
 * 告警触发历史仓储 —— 记录域 `sysops_records` 的 `alert_hit` 表。
 *
 * 骨架照抄 `lib/prefs/store.js:74-101`：`assertUsable`（先判 closed、再判宿主给没给设施）
 * 与 `ensureDomain`（缓存 open 的 promise，**失败时清缓存**让下次能重试）。
 * 与偏好侧的两点不同：
 *
 * 1. **append-only**：只有 `append` / `list`，没有覆盖写的语义 —— 触发历史是事实，
 *    改一条就是造假。唯一会删的地方是超出 200 条后裁最旧。
 * 2. **写前校验**：脏行必须在 `put` 之前被 schema 挡下并包成带 code 的 `INVALID`，
 *    否则半条脏记录会留在域里，`list` 每次都要为它兜底。
 *
 * `close()` 是**终态**（与 prefs 同形，本任务不提供 `open()`）：记录本身在宿主域里、
 * 不在 store 实例的内存里，换一个新实例复用同一设施就能接着读、接着写。
 */
import { alertsDomain, hitKey, ALERT_HIT_MAX } from './spec.js';

/** 稳定错误码。与 `PREFS_ERROR` 同形 —— Task 18 按 `e.code` 分支，裸 Error 接不住。 */
export const RECORDS_ERROR = {
  UNAVAILABLE: 'RECORDS_UNAVAILABLE',
  INVALID: 'RECORDS_INVALID',
  CLOSED: 'RECORDS_CLOSED',
};

class RecordsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecordsError';
    this.code = code;
  }
}

const TABLE = 'alert_hit';

/**
 * @param options.getFacility 惰性取宿主 storageDomain 的函数。
 *   **不要直接传 ctx 读属性** —— 理由与 `lib/prefs/store.js:44-46` 相同（Context 是代理）。
 * @param options.logger 可选，只在关域失败时留一行 warn。
 *   没有 `now`：行的 `t` 由 `evaluate` / `evaluateProc` 一侧给，store 拿着也只是死重量。
 */
export function createAlertHitStore({ getFacility, logger } = {}) {
  let handle = null;
  let opening = null;
  let closed = false;

  const facilityOf = () => {
    try {
      return typeof getFacility === 'function' ? getFacility() : undefined;
    } catch {
      return undefined;
    }
  };

  function assertUsable() {
    if (closed) throw new RecordsError(RECORDS_ERROR.CLOSED, '告警记录仓储已关闭');
    const f = facilityOf();
    if (!f || typeof f.open !== 'function') {
      throw new RecordsError(
        RECORDS_ERROR.UNAVAILABLE,
        '宿主未提供 ctx.storageDomain，告警触发历史无法落库（换台机器会丢）',
      );
    }
  }

  /** 懒打开。domain 名重复 open 会报 already-open，所以缓存住 promise；失败必须清缓存。 */
  function ensureDomain() {
    assertUsable();
    if (!opening) {
      opening = facilityOf()
        .open(alertsDomain)
        .catch((error) => {
          opening = null; // 失败允许下次重试，不要缓存一个坏掉的 promise
          // open 失败也是降级：映射成带 code 的 UNAVAILABLE，Task 18 按 code 分支才接得住
          throw new RecordsError(
            RECORDS_ERROR.UNAVAILABLE,
            `告警记录域 open 失败：${error?.message ?? error}`,
          );
        });
    }
    return opening;
  }

  async function table() {
    handle = await ensureDomain();
    return handle.table(TABLE);
  }

  /** 校验脏记录必须以带 code 的 INVALID 抛出，并把 schema 点名的字段（alert_hit.xxx）带进 message。 */
  function parseOrInvalid(value) {
    try {
      return alertsDomain.tables[TABLE].valueSchema.parse(value);
    } catch (e) {
      throw new RecordsError(RECORDS_ERROR.INVALID, `告警记录校验失败：${e?.message ?? e}`);
    }
  }

  /**
   * 裁剪：按 `Number(v.t)` **数值升序**删最旧。
   * 不能按 key 字典序 —— `hitKey` 的时间前缀只在毫秒位数相同（真机 13 位）时
   * 才等于时间序，假时钟下 `h-9-r1 > h-10-r1`，会把最新那条裁掉（Ruling-55）。
   */
  async function trim(t) {
    const rows = [...t.entries()].map(([key, v]) => ({ key, t: Number(v.t) }));
    if (rows.length <= ALERT_HIT_MAX) return 0;
    rows.sort((a, b) => a.t - b.t || String(a.key).localeCompare(String(b.key)));
    const doomed = rows.slice(0, rows.length - ALERT_HIT_MAX);
    for (const row of doomed) await t.delete(row.key);
    return doomed.length;
  }

  return {
    get available() {
      const f = facilityOf();
      return Boolean(f && typeof f.open === 'function') && !closed;
    },

    /** 供宿主卸载时调用。必须 await，否则紧接着重新 open 会撞 already-open。 */
    async close() {
      closed = true;
      const pending = opening;
      opening = null;
      handle = null;
      if (!pending) return;
      try {
        await (await pending).close();
      } catch (error) {
        logger?.warn?.(`[sysops] 告警记录域关闭失败：${error?.message ?? error}`);
      }
    },

    /**
     * 读触发历史。按 `Number(v.t)` 倒序（新的在前），`t` 相同再按 `hitId` 倒序。
     * @param options.limit 最多返回多少条，默认 50
     */
    async list({ limit = 50 } = {}) {
      const t = await table();
      const rows = [...t.entries()].map(([, v]) => v);
      rows.sort(
        (a, b) => Number(b.t) - Number(a.t) || String(b.hitId).localeCompare(String(a.hitId)),
      );
      return rows.slice(0, limit);
    },

    /**
     * 追加一条触发记录。
     * @param hit `evaluate` / `evaluateProc` 的返回形状（不含 `hitId`）
     * @returns 落库行（含 `hitId`，界面拿它当 key）
     */
    async append(hit) {
      assertUsable();
      const hitId = hitKey(hit);
      const row = parseOrInvalid({ ...hit, hitId }); // put 之前校验：脏行一条都不许留
      const t = await table();
      await t.put(hitId, row);
      await trim(t);
      return row;
    },
  };
}
