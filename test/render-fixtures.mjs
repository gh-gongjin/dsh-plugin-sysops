/* test/render-fixtures.mjs —— 页面组件的渲染夹具（零依赖，桩 React） */

/**
 * 桩 React：只要能撑起组件函数执行，不做真实渲染。
 * 状态**故意不持久化**：每次 useState 都用初始值。这个桩唯一的职责是"把组件函数跑一遍
 * 看会不会炸、渲染出了哪些文案"，模拟状态变化只会让结果不可预期。
 * 想指定某个 useState 的初值（例如强制停在某个页签），用 __force() 排队。
 */
export function makeStubReact() {
  let cursor = 0;
  let forced = [];
  // 跳过标记：__force 是按 hook 顺序逐个顶替的，想只顶第 3 个 hook 就得把前两个显式跳过。
  const SKIP = Symbol('skip');
  return {
    __skip: SKIP,
    __reset() { cursor = 0; forced = []; },
    __force(...vals) { forced = vals.slice(); },
    createElement(type, props, ...children) {
      // 真 React 会把 children 并进 props.children —— 桩必须同形，否则函数组件
      // （Pill/Notice 这类吃 children 的）在测试里拿到 undefined，与跑的那份分叉。
      const p = props ? { ...props } : {};
      if (children.length) p.children = children.length === 1 ? children[0] : children;
      return { type, props: p, children };
    },
    useState(init) {
      const own = () => (typeof init === 'function' ? init() : init);
      let v = own();
      cursor += 1;
      if (forced.length) { const f = forced.shift(); if (f !== SKIP) v = f; }
      return [v, () => {}];
    },
    useEffect() { cursor += 1; },
    useRef(v) { cursor += 1; return { current: v === undefined ? null : v }; },
    useMemo(fn) { cursor += 1; return fn(); },
    useCallback(fn) { cursor += 1; return fn; },
  };
}

/**
 * 遍历 createElement 返回的节点树，收集文案、类名与按钮。
 * 组件函数嵌套调用时同样适用（node.type 是函数就调用它，栈由 JS 自己管）。
 * 故意**不**在遇到函数组件时 __reset()：__force 排进去的值要能穿过父组件落到子组件手上。
 * 返回对象自带 has/classHas/btn 三个查询方法，④~⑦段直接 `walk(Page(props)).has('…')`。
 */
function newOut() {
  const out = { texts: [], classes: [], buttons: [] };
  out.has = (s) => out.texts.some((t) => t.includes(s));
  out.classHas = (s) => out.classes.some((c) => c.includes(s));
  out.btn = (t) => out.buttons.find((b) => b.text.includes(t)) ?? null;
  return out;
}
export function walk(node, out = newOut(), depth = 0) {
  if (depth > 60 || node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) walk(n, out, depth + 1); return out; }
  const props = node.props || {};
  if (typeof props.className === 'string') out.classes.push(props.className);
  if (node.type === 'button') {
    out.buttons.push({
      className: String(props.className || ''),
      // 文本用来做"这条检查确实扫到了目标按钮"的正向断言，避免用例静默失效
      text: (node.children || []).filter((c) => typeof c === 'string').join(''),
      onClick: typeof props.onClick === 'function',
      disabled: props.disabled === true,
    });
  }
  if (typeof node.type === 'function') walk(node.type(props), out, depth + 1);
  else {
    // 桩 createElement 把子节点存进 node.children（真 React 会并进 props.children）——
    // 优先按 children 数组下钻，取不到再退回 props.children，两种写法都遍历得到。
    const kids = Array.isArray(node.children) ? node.children : [props.children];
    for (const k of kids) walk(k, out, depth + 1);
  }
  return out;
}

/** 渲染一个函数组件并返回 walk 的结果。 */
export function render(Comp, props = {}) {
  return walk(Comp(props));
}

/**
 * ④~⑦段共用的宿主注入载荷，字段与 Task 19 `index-inject` 推进去的 `value` 逐键一致。
 * 每段渲染前要 `globalThis.__SYSOPS__ = clientPayload()` 写回：client.js 的 `cfg()` 是
 * 现取的（Task 20 的约定，只有 `PANEL_ID` 在模块求值时定死），上一段用例改过的载荷会串下来。
 * `redlines` / `searchAdvice` 故意留空 —— 吃它们的 `pg4-5`、`pg3-3` 会自己塞，空数组能顺便
 * 证明"宿主没给文案时界面不编第二份"。
 */
export function clientPayload(over = {}) {
  return {
    panelId: 'sysops', label: '系统运维', panelOrder: 12, routePrefix: '/sysops', api: '/sysops/api',
    capabilities: { storageDomain: true, timer: true, webServer: true, notifications: false, autostart: false },
    capabilityRows: [
      { key: 'storageDomain', label: 'storageDomain（持久化）', ok: true, detail: '', fallback: '' },
      { key: 'timer', label: 'timer（ctx.interval）', ok: true, detail: '', fallback: '' },
      { key: 'webServer', label: 'webServer（路由 + index-inject）', ok: true, detail: '', fallback: '' },
      { key: 'notifications', label: '系统通知（托盘）', ok: false, detail: '', fallback: '宿主不提供' },
      { key: 'autostart', label: '开机自启常驻', ok: false, detail: '', fallback: '宿主不提供' },
    ],
    cadences: ['1s', '5s', 'paused'],
    sourceKeys: ['l0', 'l1a', 'l1b', 'l2'],
    defaults: { procIntervalSec: 3, procMaxRows: 400, keepMinutes: 30, searchPort: 3417, quarantineDir: 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine' },
    redlines: [],
    searchAdvice: [],
    ...over,
  };
}
