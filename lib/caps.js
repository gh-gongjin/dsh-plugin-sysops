/**
 * 宿主能力探测结果登记表。
 *
 * 三种状态必须分清，否则设置页的能力表会说假话：
 *   · 没探测过 → false（**不等于**宿主没有；启动早期就是这个值）
 *   · 探测过且缺 → false + detail 说清缺了什么、界面因此降级成什么样
 *   · 宿主架构上不提供（notifications / autostart）→ 恒 false，mark(true) 直接抛
 * 最后一种要拦着：留一个能拨但拨了没用的开关，比没有开关更糟（spec §1.1 决策 8）。
 */
export const CAP_KEYS = ['storageDomain', 'timer', 'webServer', 'ai', 'notifications', 'autostart'];

/** 宿主不提供 —— 不是"还没探到"，永远不该被标成 true。 */
export const NEVER_PROVIDED = ['notifications', 'autostart'];

/** 中文文案逐字取自 spec §4.6 的表；改这里要同步改 spec。 */
export const CAP_ROWS = [
  { key: 'storageDomain', label: '宿主存储 storageDomain', fallback: '配置转只读，写接口返回 501，保存按钮置灰并注明原因' },
  { key: 'timer', label: '宿主定时器 ctx.interval', fallback: '退到 setInterval，插件卸载时显式 stop；这行降级如实标出来' },
  { key: 'webServer', label: '宿主 Web 服务', fallback: '不注册侧边栏入口（点开空白页比看不到入口更糟）' },
  // AI 清理建议（S12-C）：这一行只报事实、不给开关；缺了不影响清理本体（两段式人工勾选照旧），
  // 所以 syncCaps 标它时**不带 why** —— 带 why 会让页头那条 capGaps 横幅常驻（真机噪声）。
  { key: 'ai', label: '宿主模型 ctx.llm（AI 清理建议）', fallback: 'AI 智能清理按钮不亮：清理仍走人工勾选的两段式确认，功能没有打折' },
  { key: 'notifications', label: '系统通知', fallback: '宿主不提供：告警只落插件内时间线 + 侧边栏蓝点，UI 不留开关' },
  { key: 'autostart', label: '开机自启常驻', fallback: '宿主不提供：不做常驻，UI 不留开关' },
];

export function createCaps({ logger } = {}) {
  const found = Object.fromEntries(CAP_KEYS.map((k) => [k, false]));
  const detail = {};
  // 留痕去重：能力位现在由 syncCaps 在**每次构建入口载荷**时现算（注入回调落地前后各一次，
  // 之后每个 index-inject 还会再算）。不去重的话同一条降级会被刷成日志噪声，留痕本身也就没人看。
  const warned = new Set();
  return {
    mark(key, ok, why = '') {
      if (!CAP_KEYS.includes(key)) throw new Error(`未知能力键：${key}`);
      if (NEVER_PROVIDED.includes(key) && ok) {
        // 拦下来而不是忽略：某天真接了通知，也要显式改 NEVER_PROVIDED 才会亮
        throw new Error(`宿主不提供 ${key}，不许 mark(true)`);
      }
      if (!NEVER_PROVIDED.includes(key)) found[key] = Boolean(ok);
      // detail 跟着当前状态走：恢复可用后不能留着上一条降级原因（否则能力表说两句话）
      if (why) detail[key] = why;
      else if (ok) delete detail[key];
      if (!found[key] && !NEVER_PROVIDED.includes(key) && !warned.has(key)) {
        warned.add(key);
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
