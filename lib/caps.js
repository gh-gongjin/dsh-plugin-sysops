/**
 * 宿主能力探测结果登记表。
 *
 * 三种状态必须分清，否则设置页的能力表会说假话：
 *   · 没探测过 → false（**不等于**宿主没有；启动早期就是这个值）
 *   · 探测过且缺 → false + detail 说清缺了什么、界面因此降级成什么样
 *   · 宿主架构上不提供（notifications / autostart）→ 恒 false，mark(true) 直接抛
 * 最后一种要拦着：留一个能拨但拨了没用的开关，比没有开关更糟（spec §1.1 决策 8）。
 */
export const CAP_KEYS = ['storageDomain', 'timer', 'webServer', 'notifications', 'autostart'];

/** 宿主不提供 —— 不是"还没探到"，永远不该被标成 true。 */
export const NEVER_PROVIDED = ['notifications', 'autostart'];

/** 中文文案逐字取自 spec §4.6 的表；改这里要同步改 spec。 */
export const CAP_ROWS = [
  { key: 'storageDomain', label: '宿主存储 storageDomain', fallback: '配置转只读，写接口返回 501，保存按钮置灰并注明原因' },
  { key: 'timer', label: '宿主定时器 ctx.interval', fallback: '退到 setInterval，插件卸载时显式 stop；这行降级如实标出来' },
  { key: 'webServer', label: '宿主 Web 服务', fallback: '不注册侧边栏入口（点开空白页比看不到入口更糟）' },
  { key: 'notifications', label: '系统通知', fallback: '宿主不提供：告警只落插件内时间线 + 侧边栏蓝点，UI 不留开关' },
  { key: 'autostart', label: '开机自启常驻', fallback: '宿主不提供：不做常驻，UI 不留开关' },
];

export function createCaps({ logger } = {}) {
  const found = Object.fromEntries(CAP_KEYS.map((k) => [k, false]));
  const detail = {};
  return {
    mark(key, ok, why = '') {
      if (!CAP_KEYS.includes(key)) throw new Error(`未知能力键：${key}`);
      if (NEVER_PROVIDED.includes(key) && ok) {
        // 拦下来而不是忽略：某天真接了通知，也要显式改 NEVER_PROVIDED 才会亮
        throw new Error(`宿主不提供 ${key}，不许 mark(true)`);
      }
      if (!NEVER_PROVIDED.includes(key)) found[key] = Boolean(ok);
      if (why) detail[key] = why;
      if (!found[key] && !NEVER_PROVIDED.includes(key)) {
        logger?.warn?.(`[sysops] 宿主缺少 ${key}：${CAP_ROWS.find((r) => r.key === key).fallback}`);
      }
    },
    read: () => ({ ...found }),
    rows: () => CAP_ROWS.map((r) => ({ ...r, ok: found[r.key], detail: detail[r.key] ?? '' })),
    get storageDomain() { return found.storageDomain; },
    get timer() { return found.timer; },
    get webServer() { return found.webServer; },
  };
}
