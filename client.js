// ============================================================
// dsh-plugin-sysops — Browser Client Half（浏览器半边）
// ============================================================
// 干两件事（与 dsh-plugin-stock-analysis/client.js 同形）：
//   1) 往侧边栏的全局面板列表（slot: sidebar.panellist）注册一个图标按钮
//   2) 往主列的面板位（slot: main，keyed）注册同 id 的整页 UI
// 两者靠同一个 panelId 关联：侧边栏只管画按钮，点击由宿主切主面板。
//
// 数据通路：SSE 主、轮询兜底（spec §3.1）。**不用 EventSource** ——
// 它只支持 GET，而本插件的流里有 POST 驱动的控制帧（可见性/档位/清理），
// 且断线重连后要能补历史，EventSource 都不便做。
//
// 视觉与交互全部继承 dsh-plugin-stock-analysis/docs/design-spec.md：
//   · §5.1 token：颜色先读宿主 --dsw-alias-*，缺了才用原型值兜底；
//   · §4 全局禁止顶部浮层提示条 —— 错误与状态一律就地落卡（.so-notice）；
//   · 三档断点 1080 / 860 / 620；数字一律 tabular-nums；
//   · 交互一律自研控件（按钮 / 开关 / 分段器），无原生弹层与下拉。
// 红线：路径永不采信前端 —— 清理执行只发 planId + itemIds + mode，
// 能不能删由 lib/clean/guard.js 单点裁决，本文件不复制、不放宽任何判定。

window.__ModuleLoader__.load({
  id: 'dsh-plugin-sysops',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    // ------------------------------------------------------------
    // 0) 配置：宿主半边经 index-inject 推进来的载荷
    // ------------------------------------------------------------
    /** 与 lib/api.js 的 GLOBAL_KEY 导出同值（hx-5 / cf 两头盯住这一约定）。 */
    const GLOBAL_KEY = '__SYSOPS__';
    /**
     * 载荷一律经 cfg() 现取，不在模块顶层做整体快照：
     * index-inject 与 apply 的先后不受本文件控制，顶层快照会永远读到空对象，
     * 能力表 / 红线文案会静默空掉。
     */
    const cfg = () => globalThis[GLOBAL_KEY] || {};
    /**
     * PANEL_ID 同时是 factory 的导出与两个 slot 的 id/key，必须稳定 ——
     * 这是**唯一**在模块求值时定死的项。
     */
    const PANEL_ID = cfg().panelId || 'sysops';
    /** 面板排序：每次用时现取（缺载荷时按宿主内置「插件」项下方落 12）。 */
    const PANEL_ORDER = () => Number(cfg().panelOrder) || 12;
    /** 接口基址：同样现取；api() 与 useStream() 内部都走 cfg().api || '/sysops/api'。 */
    const API_BASE = () => cfg().api || '/sysops/api';

    // ------------------------------------------------------------
    // 1) 样式：宿主 token 优先，原型值兜底 —— 明暗主题都能跟
    // ------------------------------------------------------------
    const STYLE_ID = 'dsh-plugin-sysops:style';

    // 组件类逐条搬自 prototype/index.html 的 <style>，前缀改 so-；
    // 颜色全落成 --so-* 变量的 var() 引用，语义位不留裸十六进制。
    const CSS = `
.so-root{
  --so-bg:var(--dsw-alias-bg-base,#ffffff);
  --so-soft:var(--dsw-alias-bg-layer-2,#fafafb);
  --so-hover:var(--dsw-alias-bg-layer-3,#f0f0f1);
  --so-bd:var(--dsw-alias-border-l1,#ebebed);
  --so-bd2:var(--dsw-alias-border-l2,#e0e0e3);
  --so-t1:var(--dsw-alias-label-primary,#1a1a1a);
  --so-t2:var(--dsw-alias-label-secondary,#6b6b70);
  --so-t3:var(--dsw-alias-label-tertiary,#a0a0a6);
  --so-blue:var(--dsw-alias-state-business-primary,#3d6fe0);
  --so-amber:#b06f14; --so-amber-bg:#fdf4e3; --so-red:#c0392b; --so-red-bg:#fdeceb;
  --so-up:#d93a2b; --so-down:#17a34a; --so-flat:#8a8a90;
  --so-blue-bg:color-mix(in srgb,var(--so-blue) 10%,transparent);
  --so-active:color-mix(in srgb,var(--so-t1) 8%,transparent);
  box-sizing:border-box;padding:22px 28px 40px;max-width:1180px;color:var(--so-t1);font-size:13px;line-height:1.6;
}
.so-root *{box-sizing:border-box}
.so-num,.so-root .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.so-root svg{display:block}
.so-root button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}
.so-head{display:flex;align-items:flex-start;gap:12px;padding-right:4px}
.so-title{font-size:17px;font-weight:600;margin:0 0 4px;letter-spacing:-.2px}
.so-sub{color:var(--so-t2);font-size:13px;margin-top:2px}
.so-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.so-tabs{display:flex;gap:4px;margin-top:16px;flex-wrap:wrap}
.so-tab{height:30px;padding:0 12px;border-radius:8px;font-size:13px;color:var(--so-t2);background:none;border:none}
.so-tab:hover{background:var(--so-hover);color:var(--so-t1)}
.so-tab[aria-selected="true"]{background:var(--so-active);color:var(--so-t1);font-weight:500}
.so-tabpanel{padding-top:16px}
.so-card{border:1px solid var(--so-bd);border-radius:12px;background:var(--so-bg);overflow:hidden}
.so-card+.so-card{margin-top:14px}
.so-card-h{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--so-bd);background:var(--so-soft)}
.so-card-h h2,.so-card-h h3{margin:0;font-size:13px;font-weight:600}
.so-card-h .so-hsub{font-size:12px;color:var(--so-t3)}
.so-card-h .so-grow{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.so-card-b{padding:14px}
.so-pill{display:inline-flex;align-items:center;height:18px;padding:0 5px;border-radius:4px;font-size:11px;line-height:18px;white-space:nowrap;background:var(--so-soft);color:var(--so-t2)}
.so-pill-blue{background:var(--so-blue-bg);color:var(--so-blue)}
.so-pill-gray{background:var(--so-hover);color:var(--so-t2)}
.so-pill-amber{background:var(--so-amber-bg);color:var(--so-amber)}
.so-pill-red{background:var(--so-red-bg);color:var(--so-red)}
.so-pill-up{background:color-mix(in srgb,var(--so-up) 8%,transparent);color:var(--so-up)}
.so-pill-down{background:color-mix(in srgb,var(--so-down) 10%,transparent);color:var(--so-down)}
.so-pill-on{background:color-mix(in srgb,var(--so-down) 10%,transparent);color:var(--so-down)}
.so-pill-line{border:1px solid var(--so-bd2);color:var(--so-t3);background:var(--so-bg)}
.so-mtr-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.so-mtr{border:1px solid var(--so-bd);border-radius:12px;padding:12px 14px;background:var(--so-bg)}
.so-mtr .so-n{color:var(--so-t2);font-size:12px;display:flex;align-items:center;gap:6px}
.so-mtr .so-v{font-size:21px;font-weight:600;letter-spacing:-.5px;margin-top:4px}
.so-mtr .so-v small{font-size:12px;font-weight:500;color:var(--so-t3);margin-left:3px;letter-spacing:0}
.so-mtr .so-c{font-size:11.5px;color:var(--so-t3);margin-top:2px}
.so-mtr .so-track{margin-top:9px}
.so-track{height:3px;border-radius:2px;background:var(--so-soft);overflow:hidden}
.so-track>i{display:block;height:100%;background:var(--so-t1)}
.so-track.is-warn>i{background:var(--so-amber)}
.so-track.is-crit>i{background:var(--so-up)}
.so-srcs{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;padding:8px 11px;border:1px solid var(--so-bd);border-radius:8px;background:var(--so-soft);font-size:12px;color:var(--so-t2)}
.so-src{display:inline-flex;align-items:center;gap:5px}
.so-src .so-dot{width:6px;height:6px;border-radius:50%;background:var(--so-down)}
.so-src.is-off .so-dot{background:var(--so-bd2)}
.so-src.is-bad .so-dot{background:var(--so-up)}
.so-src b{font-weight:500;color:var(--so-t1)}
.so-srcs .so-sep{color:var(--so-bd2)}
.so-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}
.so-spark{width:100%;height:auto;display:block}
.so-curve-cap{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.so-curve-cap h3{margin:0;font-size:12.5px;font-weight:600}
.so-curve-cap .so-grow{margin-left:auto;font-size:11.5px;color:var(--so-t3)}
.so-curve-v{font-size:16px;font-weight:600;letter-spacing:-.3px;margin:2px 0 8px}
.so-tblwrap{overflow-x:auto}
table.so-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.so-tbl th{background:var(--so-soft);color:var(--so-t3);font-weight:500;font-size:11.5px;text-align:left;padding:7px 10px;border-bottom:1px solid var(--so-bd);white-space:nowrap}
.so-tbl td{padding:8px 10px;border-bottom:1px solid var(--so-bd);vertical-align:middle}
.so-tbl tbody tr:hover td{background:var(--so-hover)}
.so-tbl .so-r{text-align:right;font-variant-numeric:tabular-nums}
.so-tbl .so-tr-name{font-weight:500}
.so-tbl-note{padding:8px 10px 0;font-size:11.5px;color:var(--so-t3)}
.so-notice{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:8px;font-size:12px;line-height:1.65;margin-top:12px}
.so-notice svg{flex:0 0 14px;margin-top:3px}
.so-notice-amber{background:var(--so-amber-bg);border:1px solid color-mix(in srgb,var(--so-amber) 24%,transparent);color:var(--so-amber)}
.so-notice-blue{background:var(--so-blue-bg);border:1px solid color-mix(in srgb,var(--so-blue) 24%,transparent);color:var(--so-blue)}
.so-notice-gray{background:var(--so-soft);border:1px solid var(--so-bd);color:var(--so-t2)}
.so-seg{display:flex;gap:2px;background:var(--so-soft);border:1px solid var(--so-bd);border-radius:8px;padding:2px;flex-wrap:wrap}
.so-seg button{height:22px;padding:0 9px;border-radius:5px;font-size:12px;color:var(--so-t2);white-space:nowrap;border:1px solid transparent;background:none}
.so-seg button:hover{color:var(--so-t1)}
.so-seg button.is-active{background:var(--so-bg);border:1px solid var(--so-bd2);color:var(--so-t1);font-weight:500}
.so-switch{width:34px;height:19px;border-radius:10px;background:var(--so-bd2);position:relative;transition:background .16s;flex:0 0 34px;display:inline-block;padding:0}
.so-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--so-bg);transition:transform .16s}
.so-switch[aria-checked="true"]{background:var(--so-t1)}
.so-switch[aria-checked="true"]::after{transform:translateX(15px)}
.so-switch.is-disabled{background:var(--so-bd);cursor:not-allowed}
.so-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;font-size:13px;border:1px solid var(--so-bd2);background:var(--so-bg);color:var(--so-t1);white-space:nowrap}
.so-btn:hover{background:var(--so-hover)}
.so-btn:disabled{color:var(--so-t3);background:var(--so-soft);cursor:not-allowed}
.so-btn-primary{background:var(--so-t1);border-color:var(--so-t1);color:var(--so-bg)}
.so-btn-primary:hover{background:var(--so-t1)}
.so-btn-primary:disabled{background:var(--so-soft);border-color:var(--so-bd);color:var(--so-t3)}
.so-btn-sm{height:26px;padding:0 9px;font-size:12px;border-radius:6px}
.so-btn-quiet{border-color:transparent;color:var(--so-t2)}
.so-input{height:30px;border:1px solid var(--so-bd2);border-radius:6px;padding:0 9px;font:inherit;font-size:12.5px;color:var(--so-t1);background:var(--so-bg);width:100%}
.so-input:focus{outline:none;border-color:var(--so-t3)}
.so-input-mono{font-family:Consolas,"Cascadia Mono",monospace;font-size:12px}
.so-field{display:flex;align-items:center;gap:8px}
.so-field label{width:96px;flex:0 0 96px;color:var(--so-t2);font-size:12px}
.so-grid{display:grid;gap:14px}
.so-grid>*,.so-charts>*,.so-mtr-strip>*{min-width:0}
.so-g-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.so-hint{font-size:12px;color:var(--so-t3);white-space:normal}
.so-rule{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--so-bd)}
.so-rule:last-child{border-bottom:none}
.so-rule .so-ri{flex:1;min-width:0}
.so-rule .so-rn{font-weight:500;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.so-rule .so-rd{color:var(--so-t2);font-size:12px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.so-rule .so-rt{color:var(--so-t3);font-size:12px;width:118px;text-align:right;flex:0 0 118px}
.so-rule-dim{color:var(--so-amber)}
.so-rule .so-rn.so-rule-dim,.so-rule .so-rd.so-rule-dim{color:var(--so-t3)}
.so-tl{position:relative;padding-left:16px}
.so-tl::before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:1px;background:var(--so-bd)}
.so-tl-item{position:relative;padding:7px 0}
.so-tl-item::before{content:"";position:absolute;left:-16px;top:13px;width:7px;height:7px;border-radius:50%;background:var(--so-bg);border:1.5px solid var(--so-bd2)}
.so-tl-item.so-tl-hit::before{border-color:var(--so-up);background:var(--so-up)}
.so-tl-item.so-tl-op::before{border-color:var(--so-blue);background:var(--so-blue)}
.so-tl-item .so-tt{color:var(--so-t3);font-size:12px}
.so-tl-item .so-tx{font-size:13px}
.so-empty{padding:26px 14px;text-align:center;color:var(--so-t3);font-size:12.5px;line-height:1.9}
.so-path{font-family:Consolas,"Cascadia Mono",monospace;font-size:11.5px;color:var(--so-t2);word-break:break-all}
.so-skel{height:9px;border-radius:4px;background:var(--so-hover);margin-bottom:8px}
.so-disclaimer{margin-top:20px;color:var(--so-t3);font-size:12px;border-top:1px solid var(--so-bd);padding-top:12px;line-height:1.75}
@media (max-width:1080px){
  .so-mtr-strip{grid-template-columns:repeat(2,minmax(0,1fr))}
  .so-charts{grid-template-columns:1fr}
  .so-g-2{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:860px){
  .so-rule .so-rt{width:auto;text-align:left;order:3;flex-basis:100%}
  .so-head{flex-wrap:wrap}
  .so-actions{margin-left:0;width:100%}
  .so-card-h{flex-wrap:wrap}
  .so-card-h .so-grow{margin-left:0}
  .so-field label{width:auto;flex:0 0 auto}
}
@media (max-width:620px){
  .so-mtr-strip{grid-template-columns:1fr}
  .so-tblwrap{overflow-x:scroll}
}
`;

    /** 注入样式，返回清理函数（随 ctx.effect 的生命周期回收）。 */
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return () => {};
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
      return () => {
        el.remove();
      };
    }

    // ------------------------------------------------------------
    // 2) 工具（全部经 __test 出口，测的就是跑的这一份）
    // ------------------------------------------------------------

    /**
     * 手工解 SSE 帧（抄股票插件的实现）。
     * **不能用 EventSource** —— 它只支持 GET，而本插件要 POST 控制帧、
     * 断线重连还要补历史。帧格式：`event: xxx\n` + `data: {json}\n` + 空行。
     */
    async function consumeSse(res, onEvent) {
      const reader = await res.body.getReader(); // await：兼容返回 Promise 的 reader 工厂（cf-7 钉住），真机同步 reader 亦无害
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let ev = 'message';
          const dataLines = [];
          for (const line of frame.split('\n')) {
            if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
            else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
            // 以 ':' 开头的是注释帧（心跳 `: ping` / 开场 `: ok`），整行跳过
          }
          if (!dataLines.length) continue;
          try {
            onEvent(ev, JSON.parse(dataLines.join('\n')));
          } catch {
            /* 坏帧只跳过该帧：跨 chunk 的半帧不该炸掉整条流（cf-7） */
          }
        }
      }
    }

    /**
     * 统一接口调用。**返回解析后的 envelope（{ok,data,error}）而不是抛**：
     * spec §4.7 禁止静默失败，界面要拿 error.code 就地渲染在触发它的那张卡上；
     * 抛了就得每张卡写 try/catch，早晚有人 catch {}。网络层真抛（断网）时
     * 返回 {ok:false,error:{code:'NETWORK',message}}。
     */
    async function api(name, opts = {}) {
      const { method = 'GET', body, query } = opts;
      let url = API_BASE() + '/' + name;
      if (query) {
        const parts = [];
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
        }
        if (parts.length) url += '?' + parts.join('&');
      }
      const init = { method };
      if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      try {
        const res = await fetch(url, init);
        let env = null;
        try {
          env = await res.json();
        } catch {
          // 非 JSON 响应（网关错误页等）：转成可见错误，不静默
          return { ok: false, error: { code: 'BAD_RESPONSE', message: `接口 ${name} 返回了非 JSON 响应（HTTP ${res.status}）` } };
        }
        if (env && typeof env === 'object' && 'ok' in env) return env;
        return res.ok
          ? { ok: true, data: env }
          : { ok: false, error: { code: 'HTTP_' + res.status, message: `接口 ${name} 异常（HTTP ${res.status}）` } };
      } catch (e) {
        return { ok: false, error: { code: 'NETWORK', message: String((e && e.message) || e) } };
      }
    }

    /** 只认有限数字，其它（null/undefined/NaN/字符串）一律归 null —— 界面宁可不显示也不出 NaN。 */
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    /** 1024 进制字节量；空值显示破折号而不是 0。 */
    function fmtBytes(n) {
      const v = num(n);
      if (v === null) return '—';
      if (Math.abs(v) < 1024) return v + ' B';
      const u = ['KB', 'MB', 'GB', 'TB'];
      let i = -1;
      let x = v;
      do { x /= 1024; i += 1; } while (x >= 1024 && i < u.length - 1);
      return (x >= 100 ? x.toFixed(0) : x.toFixed(x >= 10 ? 1 : 2)) + ' ' + u[i];
    }

    /**
     * 网速格式化：**v / 1e6 出 MB/s**。
     * L1a 的 v 是字节/秒；原型曲线里的 /8 是按 bit 演示的假数据，运行时代码不许照抄
     * （pg1-2 钉住这条）。
     */
    function fmtRate(bytesPerSec) {
      const v = num(bytesPerSec);
      if (v === null) return '—';
      const mb = v / 1e6;
      return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + ' MB/s';
    }

    function fmtPct(v, digits = 1) {
      const x = num(v);
      return x === null ? '—' : x.toFixed(digits) + '%';
    }

    /** 相对时间："x 分钟前 / x 小时前 / x 天前"。 */
    function fmtAge(ms) {
      const v = num(ms);
      if (v === null || v < 0) return '—';
      if (v < 60_000) return '刚刚';
      if (v < 3_600_000) return Math.floor(v / 60_000) + ' 分钟前';
      if (v < 86_400_000) return Math.floor(v / 3_600_000) + ' 小时前';
      return Math.floor(v / 86_400_000) + ' 天前';
    }

    /** 采集源状态 → 胶囊类名（spec §4.2 四分清：on/off/坏/不可用 视觉必须不同）。 */
    function stateClass(state) {
      if (state === 'on') return '';
      if (state === 'off') return 'so-pill-gray';
      if (state === 'stalled' || state === 'crashed' || state === 'exited-max') return 'so-pill-red';
      if (state === 'starting') return 'so-pill-blue';
      if (state === 'unavailable') return 'so-pill-gray';
      return 'so-pill-gray';
    }

    /**
     * 单条采集源 → 胶囊文案。四类基础状态文案各不相同（pg1-5），
     * exited-max 附带退避次数且只留「重试」（pg1-6）：5 次封顶后再自动重启
     * 只会反复起进程，必须停下来让人看 stderr。
     */
    function sourcePill(row) {
      const st = row && row.state;
      if (st === 'off') return { pill: '未开启', cls: 'so-pill-gray' };
      if (st === 'starting') return { pill: '启动中', cls: 'so-pill-blue' };
      if (st === 'on') return { pill: '运行中', cls: 'so-pill-on' };
      if (st === 'stalled') return { pill: '超时无输出', cls: 'so-pill-red', note: '3× 采样间隔' };
      if (st === 'crashed') return { pill: '进程已退出', cls: 'so-pill-red', note: `restarts ${row.restarts ?? 0} · 退避中` };
      if (st === 'exited-max') return { pill: `已退出 ${row.restarts ?? 0} 次`, cls: 'so-pill-red', retryOnly: true };
      if (st === 'unavailable') return { pill: '权限不足/计数器缺失', cls: 'so-pill-gray' };
      return { pill: String(st ?? '未知'), cls: 'so-pill-gray' };
    }

    /** 页签表：label 与已确认原型逐字一致（cf-6）。 */
    const nav = [
      { k: 'monitor', t: '资源监控' },
      { k: 'clean', t: 'C 盘清理' },
      { k: 'search', t: '文件搜索' },
      { k: 'settings', t: '设置' },
    ];

    // ------------------------------------------------------------
    // 3) 基础组件（自研控件，无原生弹层）
    // ------------------------------------------------------------
    const Pill = ({ cls = '', children }) => h('span', { className: ('so-pill ' + cls).trim() }, children);

    function Notice({ tone = 'gray', children }) {
      return h('div', { className: 'so-notice so-notice-' + tone },
        h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
          h('circle', { cx: 12, cy: 12, r: 9 }),
          h('path', { d: 'M12 8v5M12 16.2v.1' })),
        h('span', null, children));
    }

    /** 自研开关：disabled 时带 aria-disabled，点击不改状态（规则置灰走它）。 */
    function Switch({ on = false, disabled = false, onChange, label = '' }) {
      return h('button', {
        type: 'button',
        className: 'so-switch' + (disabled ? ' is-disabled' : ''),
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-disabled': disabled ? 'true' : undefined,
        disabled: disabled === true,
        title: label,
        onClick: () => { if (!disabled && onChange) onChange(!on); },
      });
    }

    /** 自研分段器：代替原生下拉。options=[{v,t}] */
    function Seg({ options = [], value, onChange }) {
      return h('span', { className: 'so-seg' }, options.map((o) => h('button', {
        type: 'button',
        key: String(o.v),
        className: o.v === value ? 'is-active' : '',
        'aria-pressed': o.v === value ? 'true' : 'false',
        onClick: () => onChange && onChange(o.v),
      }, o.t)));
    }

    // ------------------------------------------------------------
    // 3b) 侧边栏图标：20px 线性图标（原型侧边栏那颗），stroke=currentColor；
    //     unread > 0 时右上角一个 r=3 的蓝点 —— 蓝点是侧边栏唯一允许的提示
    //     （spec §1.1 决策 8），且数值来自未读告警数而不是拍脑袋。
    // ------------------------------------------------------------
    let sidebarUnread = 0; // 流事件里最近一次未读数；真机重挂侧边栏项时兜底用

    function SysopsPanelIcon({ size, active, unread } = {}) {
      const s = num(size) || 20;
      const shown = unread === undefined ? sidebarUnread : unread;
      const attrs = {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': active ? 'true' : 'false',
      };
      const kids = [
        h('rect', { key: 'r', x: 3, y: 4, width: 18, height: 12, rx: 2.5 }),
        h('path', { key: 's', d: 'M8 20h8M12 16v4' }),
        h('path', { key: 'l', d: 'M6.5 12.5l2.5-3 2 1.8 2.5-3.6' }),
      ];
      if (shown > 0) {
        kids.push(h('circle', { key: 'u', className: 'so-unread', cx: 19, cy: 5, r: 3, fill: 'var(--so-blue)', stroke: 'none' }));
      }
      return h('svg', attrs, ...kids);
    }

    // ------------------------------------------------------------
    // 4) 四个页签组件
    //    本任务先交能跑的骨架（Task 21~24 逐个换实现，导出名不动）：
    //    Monitor=空态卡 / Clean=扫描按钮（禁用+原因）/ Search=搜索框 / Settings=表单壳
    // ------------------------------------------------------------

    function MonitorPage({ snap, link } = {}) {
      // Task 20 骨架：只画四张指标卡的空态；Task 21 换成完整实现（名字与 props 不变）。
      const heads = ['CPU 使用率', '内存', 'C 盘可用', '网络吞吐'];
      return h('div', { className: 'so-tabpanel' },
        h('div', { className: 'so-mtr-strip' }, heads.map((n) => h('div', { className: 'so-mtr', key: n },
          h('div', { className: 'so-n' }, n),
          h('div', { className: 'so-v so-num' }, '—')))),
        snap ? null : h('div', { className: 'so-card' }, h('div', { className: 'so-card-b' },
          h('div', { className: 'so-empty' }, '等待首帧数据：连上本机接口后这里会出现真实曲线。'))),
        link && link !== 'sse' ? h('div', { className: 'so-srcs' }, h('span', { className: 'so-src' },
          h(Pill, { cls: 'so-pill-gray' }, link === 'reconnecting' ? '重连中' : '降级：轮询 2s'))) : null);
    }

    function CleanPage() {
      return h('div', { className: 'so-tabpanel' },
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '待清理清单'), h('span', { className: 'so-hsub' }, '扫描只读 → 勾选 → 清理选中')),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-empty' }, '扫描与清单两步式界面正在接通中；删除只发生在你勾选之后点「清理选中」那一刻。'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 10 } },
              h('button', { type: 'button', className: 'so-btn so-btn-primary so-btn-sm', disabled: true }, '开始扫描'),
              h('span', { className: 'so-hint' }, '暂不可用：清理页的浏览器半边尚未接入扫描接口（原因如实标出，不装作能用）。')))));
    }

    function SearchPage() {
      return h('div', { className: 'so-tabpanel' },
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '搜索')),
          h('div', { className: 'so-card-b' },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', { className: 'so-input', type: 'text', placeholder: '输入关键字，如 report .pdf、client.js', disabled: true, style: { height: 34 } }),
              h('button', { type: 'button', className: 'so-btn so-btn-primary', disabled: true, style: { height: 34 } }, '搜索')),
            h('div', { className: 'so-hint', style: { marginTop: 9 } }, '通路选择与结果表正在接通中；两条通路都探不到时会自动降级为限定目录遍历并写明覆盖范围。'))));
    }

    function SettingsPage() {
      return h('div', { className: 'so-tabpanel' },
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '数据采集'), h('span', { className: 'so-hsub' }, '关掉某一源，依赖它的告警规则会就地标为不可用')),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-grid so-g-2' },
              h('div', { className: 'so-field' }, h('label', null, '曲线保留窗口'), h('input', { className: 'so-input', type: 'text', defaultValue: '30 分钟', disabled: true })),
              h('div', { className: 'so-field' }, h('label', null, '进程榜刷新'), h('input', { className: 'so-input', type: 'text', defaultValue: '10 秒', disabled: true }))),
            h('div', { className: 'so-hint', style: { marginTop: 10 } }, '设置表单正在接通中；写接口在无 storageDomain 时返回 501，届时保存按钮会置灰并注明原因。'))));
    }

    const pages = { MonitorPage, CleanPage, SearchPage, SettingsPage };

    // ------------------------------------------------------------
    // 4b) 连接层 useStream：SSE 主、轮询兜底、可见性驱动（spec §3.1）
    //     增量帧合并：snapshot 整体替换；metrics/proc/sources/alert/clean:*/collect:refresh 局部合并。
    // ------------------------------------------------------------
    function mergeFrame(prev, ev, d) {
      if (!d || typeof d !== 'object') return prev;
      if (ev === 'snapshot') {
        if (d.alerts && typeof d.alerts.unread === 'number') sidebarUnread = d.alerts.unread;
        return d; // 整体替换
      }
      if (!prev) return prev; // 服务端保证 snapshot 是首帧；早到的增量丢弃并由下一次快照兜回
      const base = { ...prev };
      if (ev === 'metrics' && d.key) {
        const series = { ...(base.series || {}) };
        const arr = (Array.isArray(series[d.key]) ? series[d.key] : []).concat(d.point ? [d.point] : []);
        series[d.key] = arr.length > 900 ? arr.slice(arr.length - 900) : arr; // 客户端窗口只画得下这么多
        base.series = series;
        return base;
      }
      if (ev === 'proc') {
        base.proc = { rows: d.rows ?? (base.proc && base.proc.rows) ?? [], state: d.state ?? (base.proc && base.proc.state) ?? 'off', note: d.note ?? '' };
        if (d.dropped) base.dropped = d.dropped;
        return base;
      }
      if (ev === 'sources') {
        base.sources = d.rows || d.sources || base.sources;
        if (d.dropped) base.dropped = d.dropped;
        return base;
      }
      if (ev === 'alert') {
        const a = { ...(base.alerts || {}) };
        if (d.hit) a.hits = [d.hit].concat(a.hits || []).slice(0, 200); // 本机保留最近 200 条
        if (typeof d.unread === 'number') { a.unread = d.unread; sidebarUnread = d.unread; }
        if (d.rules) a.rules = d.rules;
        base.alerts = a;
        return base;
      }
      if (ev.indexOf('clean:') === 0) {
        base.clean = { ...(base.clean || {}), ...(typeof d === 'object' ? d : {}) };
        return base;
      }
      return base;
    }

    // ------------------------------------------------------------
    // 5) SysopsPage：页头 → 能力缺口 notice（就地落卡，不是浮层）→ 页签 → 页脚 disclaimer
    // ------------------------------------------------------------
    function SysopsPage() {
      const [snap, setSnap] = useState(null);
      const [link, setLink] = useState('sse');
      const [tab, setTab] = useState('monitor');
      const [pageErr, setPageErr] = useState(null);
      const snapRef = useRef(null);
      snapRef.current = snap;

      /** POST 统一口：失败必须变成可见状态（pageErr → 就地落卡），绝不静默。 */
      async function post(name, body) {
        const r = await api(name, { method: 'POST', body });
        if (!r.ok) setPageErr(r.error || { code: 'UNKNOWN', message: '接口调用失败' });
        return r;
      }

      /**
       * 写偏好：prefs domain 是**整条覆盖写**（lib/prefs/store.js writeMany），
       * 所以先读回全量、只并进本次改动的组，再整条写回 —— 直接发半份会把别的组抹掉。
       */
      async function writePrefsGroup(group, values) {
        const cur = await api('prefs');
        const merged = { ...((cur.data && cur.data.prefs) || {}), [group]: { ...(((cur.data || {}).prefs || {})[group] || {}), ...values } };
        return post('prefs', { prefs: merged });
      }

      const doCadence = (v) => { post('collect/cadence', { cadence: v }); };
      const doSource = (key, on) => { post('collect/source', { key, on }); };
      const doRestart = (key) => { post('collect/restart', { key }); };
      const doProcToggle = (on) => { post('collect/source', { key: 'l1b', on }); };
      const doRuleToggle = (id, on) => {
        const rows = (snapRef.current && snapRef.current.alerts && snapRef.current.alerts.rules) || [];
        const row = rows.find((r) => r.rule && r.rule.id === id);
        const metric = row && row.rule && row.rule.metric;
        if (!metric) { setPageErr({ code: 'RULE_METRIC', message: `规则 ${id} 没带指标键，无法写回偏好` }); return Promise.resolve({ ok: false }); }
        return writePrefsGroup('alerts', { [metric]: { enabled: on } });
      };
      const doRuleAdd = ({ metric = 'cpu', value, consecutive, cooldownSec }) =>
        writePrefsGroup('alerts', { [metric]: { value, consecutive, cooldownSec, enabled: true } });

      // 连接层：SSE → 断线退避 1s/2s/4s/8s/30s 封顶 → 连续失败落轮询 2s（spec §3.1）
      useEffect(() => {
        let alive = true;
        let napTimer = null;
        let pollTimer = null;
        const DELAYS = [1000, 2000, 4000, 8000, 30000];
        let fails = 0;

        const sleep = (ms) => new Promise((r) => { napTimer = setTimeout(r, ms); });

        async function pollOnce() {
          const r = await api('snapshot');
          if (!alive) return;
          if (r.ok) { setSnap(() => r.data); setLink('polling'); }
          else setPageErr(r.error); // 轮询也失败：可见，不静默
        }
        async function runPolling() {
          setLink('polling');
          while (alive) {
            if (typeof document === 'undefined' || !document.hidden) await pollOnce();
            await new Promise((r) => { pollTimer = setTimeout(r, 2000); });
          }
        }
        async function streamLoop() {
          while (alive) {
            try {
              const res = await fetch(API_BASE() + '/stream');
              if (!res.ok || !res.body) throw new Error('推送通道握手失败（HTTP ' + (res && res.status) + '）');
              setLink('sse');
              fails = 0;
              await consumeSse(res, (ev, d) => {
                if (!alive) return;
                if (ev === 'collect:refresh') { pollOnce(); return; } // 重采完成帧：拉一次快照即可
                setSnap((prev) => mergeFrame(prev, ev, d));
              });
              if (!alive) return;
            } catch {
              if (!alive) return; // 断线本身由 link 状态如实呈现，不重复报
            }
            setLink('reconnecting');
            fails += 1;
            await sleep(DELAYS[Math.min(fails - 1, DELAYS.length - 1)]);
            if (!alive) return;
            if (fails >= 3) { await runPolling(); return; }
          }
        }
        streamLoop();

        // 页面隐藏 → 停轮询并告诉服务端（这正是驱动 L1b 停采的那一路）；回来再补一次
        const onVis = () => {
          const visible = !(typeof document !== 'undefined' && document.hidden);
          api('collect/visibility', { method: 'POST', body: { visible } }).then((r) => {
            if (!r.ok && alive) setPageErr(r.error);
          });
          if (visible && alive) pollOnce();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVis);
        }
        return () => {
          alive = false;
          if (napTimer) clearTimeout(napTimer);
          if (pollTimer) clearTimeout(pollTimer);
          if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
            document.removeEventListener('visibilitychange', onVis);
          }
        };
      }, []);

      // 进入监控页 → 清蓝点（POST alerts/read）；离开页面不清（spec §3.5）
      useEffect(() => {
        if (tab !== 'monitor') return undefined;
        let alive = true;
        api('alerts/read', { method: 'POST', body: {} }).then((r) => {
          if (!alive) return;
          if (r.ok) {
            sidebarUnread = 0;
            setSnap((prev) => (prev && prev.alerts ? { ...prev, alerts: { ...prev.alerts, unread: 0 } } : prev));
          } else {
            setPageErr(r.error); // 清未读失败也要看得见
          }
        });
        return () => { alive = false; };
      }, [tab]);

      // 宿主能力缺什么就在页头下面挂一条灰 notice（就地，不浮层）
      const capGaps = (cfg().capabilityRows || []).filter((r) => r && r.ok === false);
      const cadenceOptions = (cfg().cadences || ['1s', '5s', 'paused']).map((v) => ({ v, t: v === 'paused' ? '暂停' : v }));

      return h('div', { className: 'so-root' },
        h('div', { className: 'so-head' },
          h('div', null,
            h('h1', { className: 'so-title' }, cfg().label || '系统运维'),
            h('p', { className: 'so-sub' }, '本机实时监控 · 两步式 C 盘清理 · 全盘文件搜索')),
          tab === 'monitor' && snap ? h('div', { className: 'so-actions' },
            h(Seg, { options: cadenceOptions, value: snap.cadence, onChange: doCadence })) : null),
        capGaps.length ? h('div', { className: 'so-capgaps' }, capGaps.map((r) => h(Notice, { key: r.key, tone: 'gray' },
          `${r.label}：${r.detail || r.fallback || '宿主不提供'}`))) : null,
        h('div', { className: 'so-tabs', role: 'tablist' }, nav.map((t) => h('button', {
          type: 'button', key: t.k, role: 'tab', className: 'so-tab',
          'aria-selected': tab === t.k ? 'true' : 'false',
          onClick: () => setTab(t.k),
        }, t.t))),
        tab === 'monitor' && h(pages.MonitorPage, {
          snap, link, err: pageErr,
          onCadence: doCadence, onSource: doSource, onRuleToggle: doRuleToggle,
          onRuleAdd: doRuleAdd, onRestart: doRestart, onProcToggle: doProcToggle,
        }),
        tab === 'clean' && h(pages.CleanPage, null),
        tab === 'search' && h(pages.SearchPage, null),
        tab === 'settings' && h(pages.SettingsPage, null),
        h('div', { className: 'so-disclaimer' },
          '本插件对系统只读监控、对文件只删你明确勾选的项。不提供结束进程、不改注册表、不改属主与 ACL、不碰回收站与系统目录。所有清理动作都留一条可展开的追加式记录。'));
    }

    // ------------------------------------------------------------
    // 6) apply：入口注册（slot 用法照内置 plugin-manager / 股票插件）
    // ------------------------------------------------------------
    function apply(ctx) {
      // 宿主没给路由前缀（多半是没有 webServer，见 lib/caps.js 的降级说明）就**一个入口都不注册**：
      // 没有接口可连，点开空白页比看不到入口更糟（spec §4.6）。这条判断必须留在 apply 首行。
      if (!cfg().routePrefix) {
        return;
      }
      // 样式随插件生命周期挂载 / 回收
      ctx.effect(() => injectStyle(), 'sysops:style');

      // (1) 侧边栏：往全局面板列表里插一个图标按钮
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER(),
            label: () => cfg().label || '系统运维',
          },
          SysopsPanelIcon,
       ));

      // (2) 主列：注册同 id 的面板页（keyed slot，靠 key 与侧边栏项对应）
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, SysopsPage));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.PANEL_ID = PANEL_ID;
    exports.SysopsPanelIcon = SysopsPanelIcon;
    exports.SysopsPage = SysopsPage;
    /**
     * 测试专用出口（页面代码本身也从这里取，杜绝"测的是一份、跑的是另一份"）。
     * monitor 键在 Task 21 追加，其余键名自此不动。
     */
    exports.__test = { cfg, consumeSse, api, fmtBytes, fmtRate, fmtPct, fmtAge, stateClass, sourcePill, nav, pages };
    return module.exports;
  },
});
