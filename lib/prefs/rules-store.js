/**
 * 本机清理规则的读写口。
 *
 * 与偏好仓储（store.js）的分工：store 管"怎么存"，这里管"存之前先过 guard"。
 * 校验阶段就拒绝（spec §4.5），因为让用户存进去一条永远删不掉的规则，
 * 比拒绝写入难得查得多。
 *
 * 只经 prefStore 读写 `clean_rules` —— `sysops_prefs` 域由 prefs 仓储独占，
 * 这里绝不自己 facility.open()。
 */
import { check } from '../clean/guard.js';
import { BUILTIN_RULES, DEFAULT_OFF, enabledBuiltin } from '../clean/rules.js';

export const RULE_ERROR = {
  GUARD_DENY: 'SYSOPS_RULE_GUARD_DENY',
  UNKNOWN_ID: 'SYSOPS_RULE_UNKNOWN_ID',
  BAD_RULE: 'SYSOPS_RULE_BAD_RULE',
  STORE_UNAVAILABLE: 'SYSOPS_RULE_STORE_UNAVAILABLE',
};

const err = (code, why) => Object.assign(new Error(why), { code, why });

export function createRuleStore({ prefStore, logger }) {
  /** 从未写入 / 存储不可用时的空行形状。**只能有一处定义** ——
   *  read() 与 list() 各写一份字面量时，改一处会让一半默认行为无声失效（Task 11 Step 6 的 V5）。
   *  `off` 以 DEFAULT_OFF 打底：默认关（Packages 范围大、ms-playwright 重装代价大）没有打底就等于没实现。 */
  const emptyRow = () => ({ items: [], off: DEFAULT_OFF.slice(), updatedAt: 0 });

  const read = async () => {
    if (!prefStore?.available) return null;
    try {
      const row = await prefStore.read('clean_rules');
      return row ?? emptyRow();
    } catch (e) {
      logger?.warn?.(`[sysops] 本机清理规则读取失败：${e.message}`);
      return null;
    }
  };

  const write = async (next) => {
    if (!prefStore?.available) throw err(RULE_ERROR.STORE_UNAVAILABLE, 'storageDomain 不可用，规则只能只读');
    // 必须返回 prefStore 落库后那一份，不是手里的 `next`：行级 `updatedAt` 由 prefStore 盖，
    // 且未声明字段已被 schema 丢弃 —— 返回入参会让调用方以为自己的对象原样存住了。
    return prefStore.write('clean_rules', next);
  };

  const validate = (r) => {
    if (!r || typeof r !== 'object') throw err(RULE_ERROR.BAD_RULE, '规则必须是对象');
    for (const k of ['id', 'n', 'glob', 'kind']) {
      if (typeof r[k] !== 'string' || r[k].trim() === '') throw err(RULE_ERROR.BAD_RULE, `规则.${k} 必须是非空字符串`);
    }
    if (!Number.isInteger(r.ageDays) || r.ageDays < 0) throw err(RULE_ERROR.BAD_RULE, '规则.ageDays 必须是 ≥0 的整数');
    const g = check(r.glob, { mode: 'glob' });
    if (!g.allow) throw err(RULE_ERROR.GUARD_DENY, g.why);
    return r;
  };

  return {
    get error() {
      return prefStore?.available ? null : RULE_ERROR.STORE_UNAVAILABLE;
    },
    async list() {
      return (await read()) ?? emptyRow();
    },
    async userRules() {
      return (await this.list()).items;
    },
    async activeRules() {
      const row = await this.list();
      return [...enabledBuiltin(row.off), ...row.items].map((r) => validate(r) && r);
    },
    async add(rule) {
      validate(rule);
      const row = await this.list();
      if (row.items.some((x) => x.id === rule.id)) throw err(RULE_ERROR.BAD_RULE, `规则 id 重复：${rule.id}`);
      return write({ ...row, items: [...row.items, rule] });
    },
    async remove(id) {
      const row = await this.list();
      if (!row.items.some((x) => x.id === id)) throw err(RULE_ERROR.UNKNOWN_ID, `没有 id 为 ${id} 的本机规则（内置规则请用开关停用）`);
      return write({ ...row, items: row.items.filter((x) => x.id !== id) });
    },
    async toggle(id, on) {
      const row = await this.list();
      if (!BUILTIN_RULES.some((r) => r.id === id)) throw err(RULE_ERROR.UNKNOWN_ID, `${id} 不是内置规则，删除请用 remove()`);
      const off = new Set(row.off);
      if (on) off.delete(id); else off.add(id);
      return write({ ...row, off: [...off] });
    },
  };
}
