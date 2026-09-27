/**
 * 清理执行留痕仓储（append-only）。
 *
 * `start()` 立刻落一条**没有 finishedAt** 的记录：进程在删除中途被杀、宿主崩了、
 * 或者用户直接关了窗口，重启后 Task 15 靠 `unfinished()` 问得出「上次有一段没确认完成」。
 * 反过来，如果只在结束时写一条，中断的那次就**一条都不留** —— 那正是留痕最该记住的事。
 *
 * `finish()` 第二次调用**原样返回旧行并 warn**，不改写：留痕是事实，
 * 同一个 logId 的完成时间与计数只能有一次。
 *
 * 骨架走 `lib/kv-records-base.js`（Ruling-63：不许抄出第三、第四份）。
 */
import { recordsDomain, LOG_KEEP, logKey } from '../records/spec.js';
import { createRecordRepo, RECORDS_ERROR, RecordsError } from '../kv-records-base.js';

const TABLE = 'clean_log';

/** `l-<毫秒>-<6 位 base36>`：同一毫秒里的多次 start 也不能撞 key。 */
const defaultNewLogId = (now) => `l-${now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * @param options.getFacility 惰性取宿主 storageDomain 的函数（**不要直接读 ctx 属性**）
 * @param options.logger 可选：重复 finish 与关域失败各留一行 warn
 * @param options.now 注入时钟：`startedAt` / `finishedAt` 都取它
 */
export function createLogStore({ getFacility, logger, now = () => Date.now() } = {}) {
  const repo = createRecordRepo({
    getFacility,
    logger,
    domain: recordsDomain,
    table: TABLE,
    labels: {
      closed: '执行留痕仓储已关闭',
      noFacility: '宿主未提供 ctx.storageDomain，清理执行留痕无法落库（换台机器会丢）',
      openFail: '执行留痕域 open 失败',
      invalid: '执行留痕校验失败',
      closeFail: '执行留痕域关闭失败',
    },
  });

  /** 裁剪到 `LOG_KEEP`：按 `Number(v.startedAt)` 数值升序删最旧，同值再按 key 兜底（Ruling-55）。 */
  async function trim(t) {
    const rows = [...t.entries()].map(([key, v]) => ({ key, at: Number(v.startedAt) }));
    if (rows.length <= LOG_KEEP) return 0;
    rows.sort((a, b) => a.at - b.at || String(a.key).localeCompare(String(b.key)));
    const doomed = rows.slice(0, rows.length - LOG_KEEP);
    for (const row of doomed) await t.delete(row.key);
    return doomed.length;
  }

  return {
    get available() {
      return repo.available;
    },

    /**
     * 开删之前先落一条 running 留痕。
     *
     * 方法必须是 `async`：`assertUsable` 的同步 throw 在 `async` 里才会变成 rejection，
     * 调用方（和 `assert.rejects`）才接得住 —— 与 `lib/alerts/store.js` 的 `async append` 同形。
     * @returns 落库行（无 `finishedAt`）
     */
    async start({ planId, itemIds, mode } = {}) {
      repo.assertUsable();
      return repo.enqueue(async () => {
        const logId = defaultNewLogId(now);
        const t = await repo.tableOf();
        const row = repo.parseOrInvalid({
          logId,
          planId,
          startedAt: now(),
          mode,
          itemIds: itemIds ?? [],
        });
        await t.put(logKey(logId), row);
        await trim(t);
        return row;
      });
    },

    /**
     * 补齐三档计数并写 `finishedAt`。
     * 同 `start()`：`async` 让 `assertUsable` 的同步 throw 变成 rejection。
     * @throws `NOT_FOUND` logId 不存在（留痕不许被凭空补写）
     */
    async finish(logId, patch = {}) {
      repo.assertUsable();
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const key = logKey(logId);
        const current = t.get(key);
        if (current === undefined) {
          throw new RecordsError(RECORDS_ERROR.NOT_FOUND, `执行留痕 ${logId} 不存在，无法补写完成结果`);
        }
        if (current.finishedAt !== undefined) {
          logger?.warn?.(
            `[sysops] 执行留痕 ${logId} 已于 ${current.finishedAt} 完成，第二次 finish 不改写（append-only）`,
          );
          return current; // 原样返回旧行
        }
        const row = repo.parseOrInvalid({ ...current, ...patch, finishedAt: now() });
        await t.put(key, row);
        await trim(t);
        return row;
      });
    },

    /** 时间倒序（新的在前）—— 与 `hits()` / `planStore.list()` 同契约。 */
    list({ limit = 50 } = {}) {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        const rows = [...t.entries()].map(([, v]) => v);
        rows.sort(
          (a, b) =>
            Number(b.startedAt) - Number(a.startedAt) ||
            String(b.logId).localeCompare(String(a.logId)),
        );
        return rows.slice(0, limit);
      });
    },

    /** 全表里 `finishedAt` 为空的行：Task 15 重启后据此提示「上次有清理未确认完成」。 */
    unfinished() {
      return repo.enqueue(async () => {
        const t = await repo.tableOf();
        return [...t.entries()].map(([, v]) => v).filter((row) => row.finishedAt === undefined);
      });
    },

    /** 供宿主卸载时调用。本仓储进终态；登记表只在最后一个持有者放手时才真的关域。 */
    close() {
      return repo.close();
    },
  };
}

export { RECORDS_ERROR };
