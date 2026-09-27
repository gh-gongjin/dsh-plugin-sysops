/**
 * 用户偏好仓储 —— `prefs`（采集/搜索/告警设置）与 `clean_rules`（本机自建清理规则）。
 *
 * ## 与记录仓储的三点不同（别把两者混为一谈）
 *
 * 1. **可覆盖，不是 append-only。** 存档那层刻意不导出 update/delete，这里反过来：
 *    覆盖是它的本职。同 key 再写就是"用户改主意了"。
 * 2. **没有发号、没有顺序约束。** 两份偏好各自独立，不存在"写了一半"的状态。
 * 3. **仍然串行写。** KV 没有事务，串起来是唯一能买到原子性的地方；
 *    而且并发写同一个 key 时"最后谁赢"必须是确定的。
 *
 * ## 降级是预期行为，不是异常
 *
 * 宿主没给 `ctx.storageDomain`（或 open 失败）时，**不抛给调用方去崩**：
 * `available` 变 false、`readAll()` 抛 `UNAVAILABLE`，由 index.js 转成
 * `{ backend: 'local' }` 交给前端回落浏览器本地并如实标注。
 * 用户看到的是"存在哪"，而不是一个红字报错。
 */

import { prefsDomain, PREF_KEYS, PREF_ROW_KEY } from './spec.js';

/** 稳定错误码。调用方按 code 分支，不要匹配 message。 */
export const PREFS_ERROR = {
  UNAVAILABLE: 'PREFS_UNAVAILABLE',
  UNKNOWN_KEY: 'PREFS_UNKNOWN_KEY',
  INVALID: 'PREFS_INVALID',
  CLOSED: 'PREFS_CLOSED',
};

class PrefStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrefStoreError';
    this.code = code;
  }
}

/**
 * @param options.getFacility 惰性取宿主 storageDomain 的函数。
 *   **不要直接传 ctx 读属性** —— Cordis 的 Context 是代理，读未 inject 的服务
 *   会抛 `cannot get property "storageDomain" without inject`。
 * @param options.logger 可选
 * @param options.now    可选，注入时钟（测试用）
 */
export function createPrefStore({ getFacility, logger, now = () => Date.now() } = {}) {
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

  // 写队列：与存档层同样的理由 —— KV 没有事务，串行是唯一能保证"谁最后写"确定的办法
  let chain = Promise.resolve();
  const enqueue = (job) => {
    const run = chain.then(() => job());
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  function assertUsable() {
    if (closed) throw new PrefStoreError(PREFS_ERROR.CLOSED, '偏好仓储已关闭');
    const f = facilityOf();
    if (!f || typeof f.open !== 'function') {
      throw new PrefStoreError(
        PREFS_ERROR.UNAVAILABLE,
        '宿主未提供 ctx.storageDomain，偏好只能存在浏览器本地（换台机器会丢）',
      );
    }
  }

  /** 懒打开。domain 名重复 open 会报 already-open，所以缓存住 promise。 */
  function ensureDomain() {
    assertUsable();
    if (!opening) {
      opening = facilityOf()
        .open(prefsDomain)
        .catch((error) => {
          opening = null; // 失败允许下次重试，不要缓存一个坏掉的 promise
          throw error;
        });
    }
    return opening;
  }

  async function table(name) {
    if (!PREF_KEYS.includes(name)) {
      throw new PrefStoreError(PREFS_ERROR.UNKNOWN_KEY, `未知偏好：${name}`);
    }
    handle = await ensureDomain();
    return handle.table(name);
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
      } catch {
        /* 打开就没成功，没什么可关的 */
      }
    },

    /**
     * 读出全部偏好。
     * @returns 形如 `{ prefs: {...}|null, clean_rules: {...}|null }`
     *   `null` 表示**从未写入**（不等于"空"），调用方据此决定要不要用默认值。
     */
    readAll() {
      return enqueue(async () => {
        const out = {};
        for (const key of PREF_KEYS) {
          const t = await table(key);
          const row = t.get(PREF_ROW_KEY);
          out[key] = row === undefined ? null : row;
        }
        return out;
      });
    },

    /**
     * 读一份偏好。`null` 表示**从未写入**。
     *
     * 与 `readAll()` 并存而不是只留一个：采集与告警评估每轮只要 `prefs` 这一份，
     * 走 readAll 会把两张表都打开一遍 —— 每个采样周期都付这个代价没必要。
     * 两条路都走同一条写队列，读到的顺序与写入顺序一致。
     */
    read(key) {
      return enqueue(async () => {
        const t = await table(key);
        const row = t.get(PREF_ROW_KEY);
        return row === undefined ? null : row;
      });
    },

    /**
     * 写一份偏好。整份覆盖 —— 偏好没有"追加"语义。
     * @returns 落库后的记录（已过 schema，未声明的字段被丢弃）
     */
    write(key, value) {
      return enqueue(async () => {
        const t = await table(key);
        const parsed = prefsDomain.tables[key].valueSchema.parse(value);
        const row = { ...parsed, updatedAt: now() };
        await t.put(PREF_ROW_KEY, row);
        return row;
      });
    },

    /**
     * 批量写。**未知 key 直接跳过**，不让它把整批拖垮 —— 一次迁移里有一个
     * 名字拼错，不该让另外一份也存不进去。跳过了什么会一并返回，调用方要看得见。
     * @returns `{ written: {key: row}, skipped: string[] }`
     */
    writeMany(patch = {}) {
      return enqueue(async () => {
        // 注意：**不能在这里调 this.write** —— 那也会往同一条队列排队，
        // 而这条队列正等着本任务跑完，直接死锁。批量写必须自己 put。
        const written = {};
        const skipped = [];
        for (const [key, value] of Object.entries(patch || {})) {
          if (!PREF_KEYS.includes(key)) {
            skipped.push(key);
            continue;
          }
          // value 为 null/undefined 视为"这份不写"，而不是"写入空"
          if (value === null || value === undefined) {
            skipped.push(key);
            continue;
          }
          const t = await table(key);
          const parsed = prefsDomain.tables[key].valueSchema.parse(value);
          const row = { ...parsed, updatedAt: now() };
          await t.put(PREF_ROW_KEY, row);
          written[key] = row;
        }
        if (skipped.length) {
          logger?.warn?.(`[sysops] 偏好写入跳过了未知/空键：${skipped.join(', ')}`);
        }
        return { written, skipped };
      });
    },
  };
}
