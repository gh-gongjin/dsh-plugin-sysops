/**
 * 偏好 domain：`prefs`（采集/搜索/告警设置）与 `clean_rules`（用户自建的清理规则）。
 *
 * 为什么不把 clean_plan / clean_log / alert_hit 放进来：那三张是**系统产生的记录**
 * （快照冻结、留痕、触发历史），语义与"用户设的、就是要被覆盖的"不同 ——
 * 混在一个 domain 里只能靠注释区分。参照 `dsh-plugin-stock-analysis` 把
 * append-only 存档与可覆盖偏好拆成两个 domain 的同一个理由。记录域在
 * `lib/clean/plan-store.js` 等文件各自的 spec 里声明（见 Task 13）。
 *
 * `clean_rules.off` 三态：**`off: []` 是合法值 = 内置规则全开**（用户在设置页把默认关
 * 的两条打开就是这个形状，必须存得下来）；`off` 缺省只在**整行缺失**时由读取侧（rules-store 的
 * emptyRow）以 DEFAULT_OFF 打底 —— 本模块的每个写口都从 `list()` 取行、把 `off` 物化后再落库，
 * 所以库里不存在缺 `off` 的行（外部模块直写缺 `off` 的行不在本模块契约内，不加防御分支）；
 * 非数组或元素非字符串才是脏形状、拒绝入库。
 */
import {
  defineDomain, domainTable, record, arrayOf, arrayOfItem, makeSchema,
  requiredString, optionalString, optionalInt, optionalBool,
} from '../kv-schema.js';
import { check } from '../clean/guard.js';

/** 清理后动作：只留痕或不动作，spec §8 定死的两个取值（到期只提醒不自动删）。 */
export const AFTER_CHOICES = ['none', 'log'];

/** 采样档位：与监控页顶部的「1s / 5s / 暂停」三选一，没有第四种。 */
export const COLLECT_CADENCE = ['1s', '5s', 'paused'];
/** 采集源分层，与 spec §1.2 的表一一对应。 */
export const SOURCE_KEYS = ['l0', 'l1a', 'l1b', 'l2'];
/** 搜索通路：everything=全盘索引 / es=命令行 / walk=限定目录遍历（降级）。 */
export const SEARCH_MODES = ['everything', 'es', 'walk'];

/**
 * 可选的记录体：整段缺省就返回 undefined，让外层 record 把这个键省掉。
 *
 * 直接嵌 `record(...)` 会把"这份偏好还没设 alerts"当成形状错误 ——
 * 于是"只改采样档位"这种半份配置永远存不进库。
 */
function optionalRecord(shape, label) {
  const inner = record(shape, label);
  return makeSchema((v) => (v === undefined || v === null ? undefined : inner.parse(v)));
}

/**
 * 源开关表：**未声明的键拒绝**，不是像 record 那样丢弃。
 *
 * 源分层是封闭集合，`sources: { l9: true }` 只可能是上层写错了键名；
 * 悄悄丢掉的话设置页再也说不清自己那个开关到底存没存进去。
 */
function sourceSwitches() {
  const shape = SOURCE_KEYS.reduce((acc, k) => ({ ...acc, [k]: optionalBool(`sources.${k}`) }), {});
  const inner = record(shape, 'sources');
  return makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    // 非对象（字符串/数组）直接交给 record 报「sources 必须是对象」——
    // 否则 Object.keys('all') 给出 ['0','1','2']，会误报成"含未声明的源开关 '0'"。
    if (typeof v !== 'object' || Array.isArray(v)) return inner.parse(v);
    for (const k of Object.keys(v)) {
      if (!SOURCE_KEYS.includes(k)) {
        throw new Error(`sources 含未声明的源开关 '${k}'，可用：${SOURCE_KEYS.join(' | ')}`);
      }
    }
    return inner.parse(v);
  });
}

const cadence = makeSchema((v) => {
  if (v === undefined || v === null) return undefined;
  if (!COLLECT_CADENCE.includes(v)) throw new Error(`cadence 必须是 ${COLLECT_CADENCE.join(' | ')} 之一，收到 ${JSON.stringify(v)}`);
  return v;
});

const keepMinutes = makeSchema((v) => {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < 5 || v > 120) throw new Error(`keepMinutes 必须是 5~120 的整数，收到 ${JSON.stringify(v)}`);
  return v;
});

/**
 * 阈值三元组：越线值 / 连续次数 / 冷却秒。数值范围写死在 schema 里，
 * 脏值进不了库也就进不了判定 —— 否则一个 0.85 混进 cpu 阈值会把告警永久静音。
 */
const threshold = (label, { max, cooldownMin = 60 }) =>
  optionalRecord(
    {
      value: makeSchema((v) => {
        if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`${label}.value 必须是 0~${max} 的数字`);
        return v;
      }),
      consecutive: makeSchema((v) => {
        if (!Number.isInteger(v) || v < 1 || v > 10) throw new Error(`${label}.consecutive 必须是 1~10 的整数`);
        return v;
      }),
      cooldownSec: makeSchema((v) => {
        if (!Number.isInteger(v) || v < cooldownMin || v > 86400) throw new Error(`${label}.cooldownSec 必须是 ${cooldownMin}~86400 的整数`);
        return v;
      }),
      enabled: optionalBool(`${label}.enabled`),
    },
    label,
  );

export const prefsRecord = record(
  {
    collect: optionalRecord({ cadence, keepMinutes, procLimit: optionalInt('collect.procLimit') }, 'collect'),
    sources: sourceSwitches(),
    alerts: optionalRecord(
      {
        cpu: threshold('alerts.cpu', { max: 100 }),
        mem: threshold('alerts.mem', { max: 100 }),
        diskFreePct: threshold('alerts.diskFreePct', { max: 100, cooldownMin: 3600 }),
        netDown: threshold('alerts.netDown', { max: 10_000_000_000, cooldownMin: 60 }),
        procCpu: threshold('alerts.procCpu', { max: 100 }),
      },
      'alerts',
    ),
    search: optionalRecord(
      {
        mode: makeSchema((v) => {
          if (v === undefined || v === null) return undefined;
          if (!SEARCH_MODES.includes(v)) throw new Error(`search.mode 必须是 ${SEARCH_MODES.join(' | ')} 之一`);
          return v;
        }),
        walkDirs: arrayOfItem('search.walkDirs', requiredString('walkDirs[]')),
        limit: optionalInt('search.limit'),
        /** 这两键是"用户可改"而非"装机配置"：Task 16 探测与 Task 17 搜索都从这里读，
         *  设置页 pg4-8 也渲染它们 —— 少一键，改端口就永远存不进库。 */
        port: makeSchema((v) => {
          if (v === undefined || v === null) return undefined;
          if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`search.port 必须是 1~65535 的整数，收到 ${JSON.stringify(v)}`);
          return v;
        }),
        esPath: optionalString('search.esPath'),
      },
      'search',
    ),
    /**
     * 暂存目录：路径先过 guard，再拒绝落在内置清理规则覆盖的目录里。
     * 校验放 schema 里是有意的 —— 仓储写不进去，界面就红不了，比运行到 stash 才发现早得多。
     *
     * 外层必须是 optionalRecord 而不是裸 record：简报原稿写 `record(…, 'clean')`，
     * 但 prefsRecord 是**整条覆盖写**的记录体，①~④段既有用例（prefs-2/prefs-6 等）都在写
     * 「没有 clean 组的半份配置」—— 裸 record 会在 clean 缺省时抛「clean 必须是对象」，
     * Task 14 Step 4 要求的 28/28 与现状不能两全。optionalRecord 与本文件其它可选组同形：
     * 缺省整段省掉，写了才逐键校验；三个键的校验器与文案逐字照简报。
     */
    clean: optionalRecord({
      quarantineDir: makeSchema((v) => {
        if (v === undefined || v === null) return undefined;
        if (typeof v !== 'string' || v.trim() === '') throw new Error('clean.quarantineDir 必须是非空字符串');
        const g = check(v);
        if (!g.allow) throw new Error(`clean.quarantineDir 未通过 guard：${g.why}`);
        return v;
      }),
      keepDays: makeSchema((v) => {
        if (v === undefined || v === null) return undefined;
        if (!Number.isInteger(v) || v < 7 || v > 365) throw new Error('clean.keepDays 必须是 7~365 的整数');
        return v;
      }),
      after: makeSchema((v) => {
        if (v === undefined || v === null) return undefined;
        if (!AFTER_CHOICES.includes(v)) throw new Error(`clean.after 必须是 ${AFTER_CHOICES.join(' | ')} 之一`);
        return v;
      }),
    }, 'clean'),
    updatedAt: optionalInt('updatedAt'),
  },
  'prefs',
);

export const cleanRulesRecord = record(
  {
    items: arrayOf('clean_rules.items', {
      id: requiredString('items[].id'),
      n: requiredString('items[].n'),
      glob: requiredString('items[].glob'),
      ageDays: makeSchema((v) => {
        if (!Number.isInteger(v) || v < 0 || v > 3650) throw new Error(`items[].ageDays 必须是 0~3650 的整数`);
        return v;
      }),
      // `kind` 必须在此声明：arrayOf 会**静默丢弃**未声明字段（lib/kv-schema.js），
      // 不声明就是规则存进去、读出来没有分类，而 rules-store 的 validate() 要求 kind 非空
      // ⇒ 每次 activeRules() 读取都抛 BAD_RULE，清理页整页打不开。写入口已强制非空，
      // schema 与校验器同一口径，用 required 而不是 optional。
      kind: requiredString('items[].kind'),
      note: optionalString('items[].note'),
    }),
    // `off` 只装内置规则 id（内置开关持久化；用户规则的存在与否由 items 表达）
    off: arrayOfItem('clean_rules.off', requiredString('off[]')),
    updatedAt: optionalInt('updatedAt'),
  },
  'clean_rules',
);

export const DOMAIN_NAME = 'sysops_prefs';
export const SCHEMA_VER = 1;
export const PREF_ROW_KEY = 'current';
export const PREF_KEYS = ['prefs', 'clean_rules'];

export const prefsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: SCHEMA_VER,
  tables: {
    prefs: domainTable(prefsRecord),
    clean_rules: domainTable(cleanRulesRecord),
  },
});
