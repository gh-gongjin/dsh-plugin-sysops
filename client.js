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
.so-track.is-indeterminate{position:relative}
.so-track.is-indeterminate>i{width:35%;animation:so-indeterminate 1.2s ease-in-out infinite}
@keyframes so-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
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
.so-tbl .so-c{text-align:center;width:34px}
.so-tbl .so-tr-name{font-weight:500}
.so-check{width:15px;height:15px;border-radius:4px;border:1px solid var(--so-bd2);background:var(--so-bg);display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:11px;line-height:1;color:var(--so-bg)}
.so-check[aria-checked="true"]{background:var(--so-t1);border-color:var(--so-t1)}
.so-check:disabled{background:var(--so-soft);border-color:var(--so-bd);cursor:not-allowed;color:var(--so-t3)}
.so-logrow{padding:10px 14px;border-bottom:1px solid var(--so-bd);font-size:12.5px}
.so-logrow:last-child{border-bottom:none}
.so-logrow>summary{cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.so-logrow .so-snap{margin-top:6px;color:var(--so-t2);font-size:12px}
.so-tbl-note{padding:8px 10px 0;font-size:11.5px;color:var(--so-t3)}
.so-notice{display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:8px;font-size:12px;line-height:1.65;margin-top:12px}
.so-notice svg{flex:0 0 14px;margin-top:3px}
.so-notice-amber{background:var(--so-amber-bg);border:1px solid color-mix(in srgb,var(--so-amber) 24%,transparent);color:var(--so-amber)}
.so-notice-red{background:var(--so-red-bg);border:1px solid color-mix(in srgb,var(--so-red) 24%,transparent);color:var(--so-red)}
.so-notice-blue{background:var(--so-blue-bg);border:1px solid color-mix(in srgb,var(--so-blue) 24%,transparent);color:var(--so-blue)}
.so-notice-gray{background:var(--so-soft);border:1px solid var(--so-bd);color:var(--so-t2)}
.so-capgaps{display:flex;flex-direction:column;gap:8px;margin-top:12px}
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
/* 表格里的路径列不换行：break-all 会让单元格的最小内容宽度退化成一个字符，
   表格因此被压扁到容器宽度（620 档实测路径列只剩 103px、一行折成 4 行），
   而原型是「表格撑住、外层 .so-tblwrap 横向滚动」。只覆盖表格上下文，
   监控页的遍历行、设置页的红线列表仍可折行。 */
.so-tbl .so-path{white-space:nowrap}
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
    // 2b) 监控页视图助手（纯函数；经 __test.monitor 暴露，测的就是跑的这份）
    // ------------------------------------------------------------
    const peak = (pts) => { const a = (pts || []).map((p) => num(p && p.v)).filter((v) => v !== null); return a.length ? Math.max(...a) : null; };

    /** warn/crit 分档。边界值归 warn：85 是"≥ 才触发"的阈值，进度条不该在等于阈值时就报红。 */
    function band(v, warn, crit) { const x = num(v); if (x === null) return ''; if (x > crit) return 'crit'; if (x > warn) return 'warn'; return ''; }

    /** 四指标行：顺序与 n 逐字固定（pg1-1）；快照没有的数字不显示、更不硬算（pg1-4）。 */
    function mtrRows(snap) {
      const l = (snap && snap.latest) || {};
      const s = (snap && snap.series) || {};
      const cpu = num(l.cpu), mem = num(l.mem);
      const total = num(l.diskTotalGb), free = num(l.diskFreeGb);
      const usedPct = total && free !== null ? Math.round((1 - free / total) * 1000) / 10 : null;
      return [
        { key: 'cpu', n: 'CPU 使用率', v: cpu === null ? '—' : cpu.toFixed(0), u: '%',
          c: `档位 ${snap.cadence} · 峰值 ${fmtPct(peak(s.cpu), 0)} · 阈值线 85%`, pct: cpu, cls: band(cpu, 70, 85) },
        { key: 'mem', n: '内存', v: mem === null ? '—' : mem.toFixed(1), u: '%',
          c: `峰值 ${fmtPct(peak(s.mem), 0)} · 保留 ${snap.keepMinutes}min`, pct: mem, cls: band(mem, 75, 85) },
        { key: 'disk', n: 'C 盘可用', v: free === null ? '—' : free.toFixed(1), u: 'GB',
          c: usedPct === null ? '总容量未知（statfs 未返回）' : `已用 ${usedPct.toFixed(1)}% · 总 ${total.toFixed(1)} GB`,
          pct: usedPct, cls: usedPct === null ? '' : band(usedPct, 85, 92) },
        { key: 'net', n: '网络吞吐', v: fmtRate(num(l.netDown)).split(' ')[0], u: 'MB/s',
          c: `下行 · 上行 ${fmtRate(num(l.netUp))}`, pct: null, cls: '' },
      ];
    }

    /** 曲线画布口径照原型 drawCurve：W=340 / H=92 / pad=3，阈值虚线。 */
    const CHART_W = 340, CHART_H = 92, CHART_PAD = 3;

    /** 四张曲线卡的静态定义：颜色与阈值口径照原型，数值一律运行时从快照取（pg1-15）。 */
    const CHART_DEFS = {
      cpu: { label: 'CPU 使用率', threshold: 85, color: 'var(--so-t1)' },
      mem: { label: '内存占用率', color: 'var(--so-blue)' },
      netDown: { label: '网络吞吐', second: 'netUp', color: 'var(--so-t1)', secondColor: 'var(--so-t3)' },
      // 标题逐字照原型 'C 盘可用空间'（约束 9）。原型同卡写「最近 24 小时」是演示数据 ——
      // 本实现的环形缓冲只留 keepMinutes（默认 30、钳 5~120），卡片窗口按真实保留窗口渲染。
      diskFreePct: { label: 'C 盘可用空间', thresholdGb: 32, color: 'var(--so-amber)' },
    };

    /**
     * 单卡曲线规格：points/max/threshold/color（喂 sparkPoints）。
     * C 盘卡的 thresholdGb=32 换算到「空闲占比」轴上；总容量未知就不画线（pg1-8）。
     */
    function curveSpec(snap, key) {
      const def = CHART_DEFS[key] || {};
      const s = (snap && snap.series) || {};
      const l = (snap && snap.latest) || {};
      const points = Array.isArray(s[key]) ? s[key] : [];
      let threshold = num(def.threshold);
      const thresholdGb = num(def.thresholdGb);
      if (thresholdGb !== null) {
        const total = num(l.diskTotalGb);
        threshold = total ? Math.round((thresholdGb / total) * 1000) / 10 : null;
      }
      const pk = peak(points);
      const max = pk === null ? null : Math.max(pk, threshold || 0, 1);
      return { key, label: def.label || key, points, max, threshold, thresholdGb, color: def.color || 'var(--so-t1)' };
    }

    /** 折线坐标串（SVG polyline 的 points 属性）；无有效点返回 null，由卡面标空态。 */
    function sparkPoints(points, max, W = CHART_W, H = CHART_H, pad = CHART_PAD) {
      const vals = (points || []).map((p) => num(p && p.v)).filter((v) => v !== null);
      const m = num(max);
      if (!vals.length || m === null) return null;
      const n = vals.length;
      return vals.map((v, i) => {
        const x = n === 1 ? W - pad : pad + (i * (W - pad * 2)) / (n - 1);
        const y = H - pad - (v / m) * (H - pad * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
    }

    /**
     * 采集源条：每源一格，四分清文案经 sourcePill；exited-max 把 stderr 尾巴
     * （≤400 字符）并进 detail 给人看（pg1-6）。link 非 sse 时尾部如实追加一格（pg1-14）。
     */
    function srcCells(snap, link) {
      const rows = Array.isArray(snap && snap.sources) ? snap.sources : [];
      const cells = rows.map((row) => {
        const p = sourcePill(row);
        let detail = String(row.detail || '');
        if (p.retryOnly && row.stderrTail) {
          detail = (detail ? detail + ' · ' : '') + String(row.stderrTail).slice(0, 400);
        } else if (p.note) {
          detail = (detail ? detail + ' · ' : '') + p.note;
        }
        const cell = { key: row.key, name: row.label || row.key, state: row.state, detail, cls: p.cls, pill: p.pill };
        if (p.retryOnly) cell.retryOnly = true;
        return cell;
      });
      if (link && link !== 'sse') {
        cells.push({ key: '__link', name: '推送通道', state: link, detail: '', cls: 'so-pill-amber', pill: link === 'reconnecting' ? '重连中' : '降级：轮询 2s' });
      }
      return cells;
    }

    // ------------------------------------------------------------
    // 2c) 清理页视图助手（Task 22；纯函数，经 __test.clean 出口）
    //     状态机在宿主侧（lib/clean/service.js 的 state()），这里只做渲染分支的取数：
    //     · 相位双形态宽容 —— 宿主成功态是 'ready'（service.js:83），简报/历史夹具是 'done'，两个都当「有清单」；
    //     · skipped 三形态宽容 —— 宿主 state 侧是**条数**（service.js:79），api.js:232 对数组形态截成
    //       {count, sample, truncated, note}，测试夹具是数组 —— 数组取 length、数字直取、对象取 count；
    //     · 截断/读不动必须显式说出来（spec §7 如实降级，pg2-14 钉），不许只在控制台留痕。
    // ------------------------------------------------------------

    /** 清单表头五列逐字（原型 <th> 顺序；第一列复选框占位不计入）。 */
    const PLAN_COLS = ['路径 / 内容', '大小', '命中规则', '最后访问', '风险'];

    /** skipped 三形态 → 条数（见上注释；无法识别时按 0，不猜）。 */
    function skippedCount(sk) {
      if (Array.isArray(sk)) return sk.length;
      const n = num(sk);
      if (n !== null) return Math.max(0, n);
      const c = sk && typeof sk === 'object' ? num(sk.count) : null;
      return c === null ? 0 : Math.max(0, c);
    }

    /**
     * 扫描条读数。`rulesTotal` 是**已启用规则数**（覆盖度估算的分母，简报 Step 3 口径）；
     * 宿主没在任何接口交待这个数（GET /api/rules 只回 {items, off}）⇒ 拿不到时 pct 交 **null**，
     * 卡面走不定量样式并写「进度未知」，绝不画实心 0%（那会被读成"一项都没扫"）。
     */
    function scanCells(state, rulesTotal = 0) {
      const st = state && typeof state === 'object' ? state : {};
      const phase = String(st.phase || 'idle');
      const hit = num(st.hit) ?? 0;
      const total = num(rulesTotal) ?? 0;
      const done = phase === 'ready' || phase === 'done';
      let phaseText = '尚未扫描';
      if (phase === 'scanning') phaseText = st.stopped ? '已停止' : '扫描中';
      else if (done) phaseText = st.stopped ? '已停止（部分清单）' : '扫描完成';
      else if (st.error || phase === 'error') phaseText = '扫描失败';
      const parts = [];
      // 200 000 是 scanner 的 maxEntries（lib/clean/scanner.js:124），写进文案而不是等运行时下发
      if (st.truncated) parts.push('条目数达上限 200 000，清单不完整');
      const sk = skippedCount(st.skipped);
      if (sk > 0) parts.push(`${sk} 个目录未纳入清单（读不动或命中红线被拒）`);
      if (st.skipped && typeof st.skipped === 'object' && !Array.isArray(st.skipped) && st.skipped.note) {
        parts.push(String(st.skipped.note));
      }
      let pct = null;
      if (done) pct = 100;
      else if (phase === 'scanning') {
        // 这是**覆盖度估算**不是字节进度（pg2-2 只约束 0~100）；真完成由 clean:done 帧定（service.js:85）。
        pct = total > 0 ? Math.min(96, Math.round((hit / total) * 100)) : null;
      }
      return {
        cur: String(st.dir || ''),
        walked: (num(st.walked) ?? 0).toLocaleString('en-US'),
        found: hit,
        size: fmtBytes(st.bytes),
        pct,
        phase: phaseText,
        note: parts.join(' · '),
      };
    }

    /** 判断条目是否被 guard 拒绝。纯渲染：只看服务端有没有给 guardDenied 键，页面不做任何路径裁决。 */
    const deniedOf = (it) => (it && it.guardDenied ? it.guardDenied : null);

    /** 清单行：只从冻结快照取数。riskPill 三态见简报 —— guardDenied→已拒绝 / mid→riskWhy / 否则无。 */
    function planRows(plan, sel) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      const has = (id) => (sel instanceof Set ? sel.has(id) : Array.isArray(sel) ? sel.includes(id) : false);
      return items.map((it) => {
        const gd = deniedOf(it);
        return {
          id: String(it.id),
          path: String(it.path ?? ''),
          sizeText: fmtBytes(it.size),
          ruleName: String(it.ruleName ?? ''),
          accText: fmtAge(Math.max(0, Date.now() - num(it.atime))),
          riskPill: gd ? '已拒绝' : (it.riskLevel === 'mid' ? String(it.riskWhy ?? '') : '无'),
          disabled: Boolean(gd),
          // guardDenied.why 原样显示（文案来自宿主 guard 的 why），页面不自造句子
          why: gd ? String(gd.why ?? gd.code ?? '') : (it.riskLevel === 'mid' ? String(it.riskWhy ?? '') : ''),
          checked: has(it.id) && !gd,
        };
      });
    }

    /**
     * 已选统计。可选集合定义 = `!guardDenied && sel.has(id)`（pg2-4 钉：勾了也没用）。
     * bytes 用十进制字节；bytesText 是 Windows 口径（GiB 标成 GB，与资源管理器一致），
     * 两者口径差已在 pg2-7 的区间断言里对齐（656 MiB + 1.24 GiB = 1.88e9 B ∈ (1.8e9, 1.9e9)）。
     */
    function selTotals(plan, sel) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      // sel 双形态：Set（页面勾选态）或 id 数组（selectAllIds 的输出直接喂进来，pg2-5 即此用法）
      const picked = items.filter((it) => !deniedOf(it)
        && (sel instanceof Set ? sel.has(it.id) : Array.isArray(sel) ? sel.includes(it.id) : false));
      const raw = picked.reduce((a, it) => a + (num(it.size) ?? 0), 0);
      // pg2-7 的区间把口径钉死：656 MiB + 1.24 GiB 真实字节和是 2.019e9，不在 (1.8e9, 1.9e9) 内；
      // 断言要的是 Windows 显示口径（资源管理器把 2^30 字节称作 1 GB）—— 1.88 "GB" × 1e9 = 1.88e9 ✓。
      // 所以 bytes 是「显示 GB 数 × 1e9」，与 bytesText（fmtBytes 同一口径）互为数字/文案两份读数。
      return {
        n: picked.length,
        bytes: Math.round((raw / 2 ** 30) * 1e9),
        bytesText: fmtBytes(raw),
        // 可选集合 = !guardDenied && sel.has(id)（pg2-4 钉：被拒项勾了也不进来）；执行请求只吃这份 id
        selectable: picked.map((it) => String(it.id)),
        risky: items.filter((it) => !deniedOf(it) && it.riskLevel === 'mid').length,
        rejected: items.filter((it) => deniedOf(it)).length,
      };
    }

    /** 「全选可清理项」的集合规则：未拒 + low，与原型 btnSelAll 同规则（mid 的被跳过，由 risky 计数说话）。 */
    function selectAllIds(plan) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      return items.filter((it) => !deniedOf(it) && it.riskLevel === 'low').map((it) => String(it.id));
    }

    /**
     * 构造 POST /api/clean/apply 的请求体 —— 页面里**唯一**的出口。
     * 结构上只有 planId/itemIds/mode 三键，连 path 键都不存在：路径永不采信前端（全局约束 6），
     * 执行对象只认宿主侧冻结快照交出的路径（lib/api.js:343 的三键闸门、spec §3.3）。
     */
    function applyBody(planId, ids, mode) {
      return { planId, itemIds: ids, mode };
    }

    /**
     * 留痕行读数。beforeFree/afterFree 是宿主 statfs('C:') 的**系统盘可用容量**
     * （lib/clean/service.js:39-46、executor.js:175），不是条目所在盘的容量 —— 文案如实写「系统盘」，
     * 免得用户把 70.4 GB 读成「D 盘还有 70.4 GB」（Task 25 若改用条目盘符口径，这里跟着换）。
     */
    function logRow(log) {
      const lg = log || {};
      const g = (v) => (num(v) === null ? '—' : (num(v) / 1e9).toFixed(1) + ' GB');
      return {
        id: String(lg.logId ?? ''),
        modePill: lg.mode === 'move-to-quarantine' ? '隔离到暂存' : (lg.mode ? '永久删除' : ''),
        restorable: lg.mode === 'move-to-quarantine',
        // start 行没有四档计数（lib/clean/log-store.js:122-127）⇒ 计数未确认，不许说成「全 0」
        line: num(lg.ok) === null
          ? '计数未确认：本次执行没写完成档'
          : `成功 ${num(lg.ok)} · 跳过 ${num(lg.skipped) ?? 0} · 失败 ${num(lg.failed) ?? 0} · 拒绝 ${num(lg.rejected) ?? 0}`,
        snapshot: `系统盘可用容量 ${g(lg.beforeFree)} → ${g(lg.afterFree)} · 释放 ${fmtBytes(lg.bytesFreed)}`,
      };
    }

    /**
     * 暂存目录文案三级回落（简报 Step 3 收口的口径冲突）：
     * prefs 实配 → cfg().defaults.quarantineDir（宿主展开好的绝对路径）→ 内置暂存根目录的如实口径。
     * 空在服务端就是 undefined（optionalString 语义，prefs schema 只收展开后的绝对路径 —— 
     * 未展开的 `%...%` 形在 lib/prefs/spec.js 的 guard 校验就被拒），所以不许渲染出字面量 undefined，
     * 也不许照抄原型里的演示串。
     * 第三级不许写「必须先去设置页配置才能隔离」：index.js:413-415 的 defaults 就是宿主展开的
     * 内置暂存根目录，没自定义也照样隔离（Ruling 口径）；只如实说明「由你手动清空、插件不自动删」。
     */
    function quarantineText(prefs) {
      const days = num(prefs && prefs.clean && prefs.clean.keepDays) ?? 7;
      const d = (prefs && prefs.clean && prefs.clean.quarantineDir)
        || cfg().defaults?.quarantineDir || '';
      if (!d) return `未自定义暂存目录：隔离将使用宿主展开的内置暂存根目录，保留 ${days} 天后由你手动清空，插件不会自动删。`;
      return `隔离 = 同盘移动到 ${d}\\（按日期子目录存放），立即腾出目录树但可随时还原；同盘移动不占额外空间。暂存目录保留 ${days} 天后由你手动清空，插件不会自动删。`;
    }

    /**
     * 写接口错误 → 就地 notice 文案（spec §4.7：错误落在触发它的那张卡里，无浮层）。
     * 501 与 403 两种原因文案不同：501 = 宿主没给 storageDomain（配置只读），403 = guard 红线拒绝。
     * apply 整批拒不落 200（批 C concern-1）：404 = 清单快照不存在/已被裁剪（措辞逐字跟宿主
     * lib/api.js:145 与 lib/clean/executor.js:64 —— 快照是被 plan-store 的 PLAN_KEEP 裁剪掉的，
     * 说「已被覆盖」会让人以为是自己刷新丢了数据而不去重扫），
     * 503 = 暂存目录不可用或记录域已关 —— 两种原因分开说，都如实交代「什么都没删」。
     */
    function cleanErrNotice(err) {
      if (!err) return null;
      const status = num(err.status);
      const code = String(err.code || '');
      if (status === 501 || code === 'PREFS_UNAVAILABLE' || code === 'SYSOPS_RECORDS_UNAVAILABLE') {
        return { tone: 'red', text: `配置只读：宿主未提供 storageDomain，写操作被拒（${err.message || '接口返回 501'}）` };
      }
      if (status === 404 || code === 'SYSOPS_RECORDS_NOT_FOUND') {
        return { tone: 'red', text: `清单快照不存在或已被裁剪：请重新扫描后再执行，本次未删除任何文件（${err.message || code || '接口返回 404'}）` };
      }
      if (status === 503 || code === 'SYSOPS_RECORDS_CLOSED' || code === 'SYSOPS_QUARANTINE_UNAVAILABLE') {
        return { tone: 'red', text: `暂存目录不可用或记录域已关闭：整批停止，本次未删除任何文件（${err.message || code || '接口返回 503'}）` };
      }
      if (status === 403 || code.indexOf('GUARD') >= 0) {
        return { tone: 'red', text: `红线拒绝：${err.message || 'guard 拒绝了这次写操作'}` };
      }
      return { tone: 'amber', text: `接口异常（${err.code || 'UNKNOWN'}）：${err.message || '未知错误'}` };
    }

    // ------------------------------------------------------------
    // 2d) 搜索页视图助手（Task 23；纯函数，经 __test.search 出口）
    //     自检行吃宿主 lib/search/probe.js:144 的 ProbeResult，结果表吃 lib/search/service.js:122 的 Result。
    //     两个形状的字段界面都不自己造；缺字段一律显示「—」而不是 0。
    // ------------------------------------------------------------
    const PROBE_ROWS = ['① 已安装 Everything', '② 有查询通路', '③ 端到端可用'];
    /** 上限三档逐字原型 limitSeg（与宿主 lib/api.js 的 clampInt(…, 1, 1000) 同区间）。 */
    const LIMITS = [50, 200, 1000];
    /**
     * 静态文案整句留在常量里（全局约束 5：只有动态值才拼接），逐字取原型
     * guideCard / walkNotice / 空态 / searchbar 的原话；**安装指引三条不在这里** —— 那条只吃注入载荷。
     */
    const SEARCH_TXT = {
      selfCheck: 'Everything 接入自检',
      probeSub: '三级探测，卡在哪一级就告诉你缺什么',
      guideTitle: '如何拿到全盘秒级搜索',
      guideLead: 'Everything 是 NTFS 索引工具，直接读 USN 日志，整盘几百万文件也只占几十 MB 内存、毫秒级返回。本插件不复制它的能力，只把它的结果画成下面的表。',
      guideOwn: '安装（任选一种，由你自己执行——本插件不会替你装程序、不会改注册表、也不会替你打开 HTTP 服务）：',
      guidePortA: '装好后在 Everything 里勾选 工具 → 选项 → HTTP 服务器（默认端口 ',
      guidePortB: '），或把官方的 es.exe 放进 PATH，然后点上方「重新检测」。',
      walkA: '限定目录模式：仅覆盖下面已选目录，不是全盘索引。',
      walkB: '实测遍历 AppData\\Local（14.5 万条目）需 7.3s，所以结果分批返回、可随时停止，且必须写明覆盖范围。',
      openNote: '本表只给名称、路径与来源：插件不替你打开文件、不执行任何程序，也不调用资源管理器定位（宿主没有这个接口）。要打开请自己按路径取用。',
      emptyNote: '没有匹配项。Everything 的分词规则是「空格 = 同时满足」，试试去掉扩展名或换个词。',
      e2eNote: '拿一个必定不存在的文件名真查一次，确认返回结构能解析，而不是失败或超时。',
      notReady: '通路未就绪 —— 暂不可选',
      qLabel: '输入关键字',
      // 逐字原型 index.html:649 的 q placeholder（不自造「通配 .ext、大小>100m」那种没验过的语法承诺）
      qHint: '输入关键字，如 report .pdf、client.js、东财 数据源',
      // 原型 index.html:659 逐字写的是「大小写敏感」，但 wk-1 定音为**不敏感**（Everything 真身与
      // Windows 文件名都不区分大小写，见 lib/search/walk.js:16-21 的三点裁定注释）⇒ 界面文案跟随实现，
      // 不照抄原型原文，否则就是界面在撒谎。
      tokenHint: '大小写不敏感 · 支持空格分词（= 同时满足）',
      dirHint: '粘贴绝对路径，如 F:\\dsh-plugins',
    };

    /** 宿主 checks 是四条（installed / http / es / walk），按 key 取对应的取证 detail。 */
    function probeDetail(probe, key) {
      const hit = ((probe && probe.checks) || []).find((c) => c && c.key === key);
      return hit && hit.detail ? String(hit.detail) : '';
    }

    /**
     * 三级自检行。标题逐字用 PROBE_ROWS（原型 ①②③ 的措辞），状态读 ProbeResult 的三个布尔量 ——
     * 宿主把 ②级拆成 http / es 两条 checks，所以 mark 认布尔量、detail 直吃 checks[].detail
     * （取证口径写在 probe.js 里，界面不重述一遍）。
     * 第三级在前两级没全过时是「未执行」（宿主压根没跑端到端探针），**不是**失败标记。
     */
    function probeCells(probe) {
      const p = probe || {};
      const ok1 = p.installed === true;
      const ok2 = p.http === true || p.es === true;
      const ok3 = p.e2e === true;
      const port = num((cfg().defaults || {}).searchPort);
      return [
        { title: PROBE_ROWS[0], mark: ok1 ? '✓' : '!', pill: ok1 ? '已装' : '未探到',
          pillCls: ok1 ? 'so-pill-down' : 'so-pill-up', detail: probeDetail(p, 'installed') },
        { title: PROBE_ROWS[1], mark: ok2 ? '✓' : '!',
          pill: p.http === true ? (port === null ? 'HTTP 通路' : 'HTTP ' + port) : (p.es === true ? 'es.exe' : '两条都没有'),
          pillCls: ok2 ? 'so-pill-down' : 'so-pill-up',
          detail: [probeDetail(p, 'http'), probeDetail(p, 'es')].filter(Boolean).join('；') },
        { title: PROBE_ROWS[2], mark: ok3 ? '✓' : (ok1 && ok2 ? '!' : '·'),
          pill: ok3 ? '试查询通过' : (ok1 && ok2 ? '试查询未通过' : '未执行'),
          pillCls: ok3 ? 'so-pill-down' : (ok1 && ok2 ? 'so-pill-up' : 'so-pill-gray'), detail: SEARCH_TXT.e2eNote },
      ];
    }

    /** 通路未就绪时**无条件**回落 walk：让人点一个必然失败的按钮，比直接降级更糟（简报 Step 3 的理由）。 */
    function modeOf(probe, wanted) {
      const p = probe || {};
      if (p.ready === true && wanted === 'everything') return 'everything';
      return 'walk';
    }

    /** modeOf 回落时给的原因；未就绪时它同时是「全盘索引」按钮的 title 与页面上的可见说明。 */
    function modeWhy(probe) {
      const p = probe || {};
      return p.ready === true ? '' : SEARCH_TXT.notReady;
    }

    /** 页头右侧的通路提示行（原型 probeHint）：端口号取注入载荷，不写死 3417。 */
    function probeHint(probe) {
      const p = probe || {};
      if (p.ready !== true) return '当前通路：未就绪 → 已降级为限定目录';
      const port = num((cfg().defaults || {}).searchPort);
      return '当前通路：' + (p.http === true ? ('Everything HTTP :' + (port === null ? '—' : port)) : 'es.exe') + ' · 全盘索引';
    }

    /**
     * 失败/降级的就地 notice（spec §4.4）。四类文案各说各的，原因一律**回显宿主原话**：
     * service.js 把适配器的 error 字符串原样带回来（例：'Everything 的 HTTP 服务未开启：…'、
     * '请求超时（timeout，4000ms 到点已取消）'），界面只加一句定性抬头，不再映射第二份 code→中文。
     */
    function searchDegrade(res) {
      const r = res || {};
      const err = String(r.error || '');
      if (!err || err === 'EMPTY_QUERY') return null; // 空查询是「没发请求」，不是通路故障
      let head;
      if (/403|HTTP 服务未开启/.test(err)) head = 'Everything 的 HTTP 服务没开，查询没走通：';
      else if (/超时|[Tt]imeout|[Aa]bort/.test(err)) head = '本次查询已超时取消：';
      else if (/未找到|未探到|连接被拒|ECONNREFUSED|通路/.test(err)) head = '查询通路不可用：';
      else head = '本次查询未成功：';
      const stale = r.stale === true ? '；表里留的是上次结果，已标陈旧，不拿旧结果冒充新结果' : '';
      return { tone: 'red', text: head + err + stale };
    }

    /** 结果头三个字段：范围说明 / 来源 pill / 命中数与上限（截断与陈旧都写在命中数后面）。 */
    function resultHead(res) {
      const r = res || {};
      const rows = Array.isArray(r.rows) ? r.rows : [];
      const lim = num(r.limit);
      const src = r.source === 'walk' ? '限定目录 · 非全盘索引'
        : r.source === 'everything' ? 'Everything · 全盘索引'
          : r.source === 'es' ? 'es.exe · 全盘索引' : '尚无结果';
      const label = String(r.sourceLabel || '').trim();
      return {
        sub: src,
        sourcePill: label === '' ? '—' : label,
        hitText: '命中 ' + rows.length + ' 项'
          + (lim === null ? '' : '（上限 ' + lim + '）')
          + (r.truncated === true ? ' · 已截断' : '')
          + (r.stale === true ? ' · 陈旧' : ''),
      };
    }

    /** 修改时间的绝对显示：24 小时制、跟随宿主环境的 zh-CN locale，不写死 en-US。 */
    const fmtTime = (ms) => { const v = num(ms); return v === null ? '—' : new Date(v).toLocaleString('zh-CN', { hour12: false }); };

    /**
     * 结果表行。来源 pill 取**结果级**的 sourceLabel：一次查询只走一条通路（service.js:19 的 normalize
     * 给每行盖同一个 source 键），界面不再维护一份 code→中文映射表（SOURCE_LABEL 的单点在宿主）。
     */
    function rowCells(res) {
      const r = res || {};
      const rows = Array.isArray(r.rows) ? r.rows : [];
      const fallback = String(r.sourceLabel || '').trim();
      return rows.map((raw) => {
        const it = raw || {};
        const own = String(it.sourceLabel || '').trim();
        return {
          name: String(it.name ?? '—'),
          dir: String(it.dir ?? '—'),
          sizeText: fmtBytes(it.size),
          mtimeText: fmtTime(it.mtime),
          sourcePill: own === '' ? (fallback === '' ? '—' : fallback) : own,
        };
      });
    }

    /** 指引三条**只**从注入载荷现取（Task 20 的懒取约定）：宿主没给就不显示，界面不编第二份安装指引。 */
    function advice() {
      const a = cfg().searchAdvice;
      return Array.isArray(a) ? a.map((x) => String(x)) : [];
    }

    /** 空 q 返回 null = 不发请求（宿主也会以 EMPTY_QUERY 拒，界面省一趟）。 */
    function searchQuery(qry) {
      const s = qry || {};
      const text = String(s.q ?? '').trim();
      if (!text) return null;
      const lim = LIMITS.indexOf(num(s.limit)) >= 0 ? s.limit : LIMITS[1];
      return { q: text, mode: s.mode === 'everything' ? 'everything' : 'walk', limit: lim };
    }

    // ------------------------------------------------------------
    // 2e) 设置页视图助手（Task 24；纯函数 + SettingsPage，经 __test.settings 出口）
    //     红线 / 能力行 / 档位 / 默认值一律吃 Task 19 注入载荷（cfg()），页面不抄第二份；
    //     guard 拒绝原因只**透传**宿主给的句子（denyWhy / err.message），客户端不做 code→中文映射
    //     —— 再映射一遍就等于把 lib/clean/guard.js 的裁决权挪出第二份（硬约束 5、spec §4.5）。
    // ------------------------------------------------------------

    /** L1a 暖身耗时常量：来自 §1.2 实测（Task 6），改值须同步 spec —— 不写死进文案串。 */
    const L1A_WARMUP_MS = 219;

    /** 宿主**永不提供**的能力键：只报事实「宿主不提供」，不给降级 pill，更不给开关（pg4-9）。 */
    const NEVER_PROVIDED = ['notifications', 'autostart'];

    /**
     * 四源行（恰好 L0 / L1a / L1b / L2）：tier 与 desc 逐字取原型 collectRules 的三行 + 新增 L2 行。
     * 开关读 **prefs.sources**（与 prefsRecord 同级的键，不在 prefs.collect 里）；
     * **L0 的 switch 是 null** —— 采样档位入口只在监控页顶部那一处，这里不重复一个 seg。
     * `cadText` 缺数一律落「—」/如实措辞，不硬算、不渲染 undefined（L1b 刷新间隔取 cfg().defaults.procIntervalSec）。
     */
    function SOURCE_ROWS(prefs, snap) {
      const p = prefs && typeof prefs === 'object' ? prefs : {};
      const src = p.sources && typeof p.sources === 'object' ? p.sources : {};
      const collect = p.collect && typeof p.collect === 'object' ? p.collect : {};
      const d = cfg().defaults || {};
      const cad = String(collect.cadence || '—');
      const keep = num(collect.keepMinutes);
      const procSec = num(d.procIntervalSec);
      const sw = (key) => ({ on: src[key] === true, disabled: false, key });
      return [
        { key: 'l0', name: '实时曲线（CPU / 内存 / 磁盘）', tier: 'L0 · 主进程内',
          desc: '纯 Node os + fs.statfsSync，不起任何子进程；采样档位由监控页顶部「1s / 5s / 暂停」控制',
          cadText: `采样 ${cad} · 保留 ${keep === null ? '—' : keep + 'min'}`, switch: null },
        { key: 'l1a', name: '网速采集', tier: 'L1a · 常驻 typeperf',
          desc: `单进程流式读 stdout，暖身 ${L1A_WARMUP_MS}ms 之后开销可忽略`,
          cadText: '定窗续采', switch: sw('l1a') },
        { key: 'l1b', name: '进程榜采集', tier: 'L1b · 常驻 PowerShell',
          // 640ms 是 §1.2 实测的单次代价；默认关（spec §1.1 决策 7）由 prefs.sources.l1b 决定
          desc: '单次 640ms，持续开启代价明显；建议只在需要时开',
          cadText: procSec === null ? '刷新间隔未确认' : `${procSec}s 一次`, switch: sw('l1b') },
        { key: 'l2', name: '按需扫描 / 搜索', tier: 'L2 · 请求驱动',
          desc: '扫描/搜索请求驱动，不常驻；遍历实测 14.5 万条目 / 7.3s，必须带进度与可停止',
          cadText: '非常驻 · 按需触发', switch: sw('l2') },
      ];
    }

    /**
     * 清理规则行读数：blocked 只看服务端有没有给 guardDenied 键（页面不做任何路径裁决）；
     * denyWhy 原样透传宿主 `guardDenied.why`，命中红线的行为由界面置灰 + 禁用开关（与原型 renderCleanRules 同行为）。
     * pill 只渲染宿主给的 `builtin` 标记（Ruling-106：内置/本机由宿主 BUILTIN_RULES id 集合单点裁决）：
     * 宿主没给标记（undefined）就**不画 pill** —— 不许按 id 前缀/白名单自判，也不许回落成「本机」骗人。
     */
    function ruleCells(rules) {
      const arr = Array.isArray(rules) ? rules : [];
      return arr.map((r) => {
        const row = r || {};
        const gd = row.guardDenied ? row.guardDenied : null;
        const ageDays = num(row.ageDays);
        return {
          n: String(row.n ?? row.name ?? ''),
          glob: String(row.glob ?? ''),
          ageText: ageDays === null ? '—' : (ageDays <= 0 ? '当天' : `${ageDays} 天未访问`),
          kind: String(row.kind ?? ''),
          pill: row.builtin === true ? '内置' : (row.builtin === false ? '本机' : ''),
          blocked: Boolean(gd),
          on: row.enabled === true,
          denyWhy: gd ? String(gd.why ?? gd.code ?? '') : '',
        };
      });
    }

    /**
     * 规则区计数三态（spec §3.2 硬要求：null ≠ []）。
     * `null` = 从未写入 → 「本机尚未写入清理规则」；`[]` = 用户清空 → 「本机规则已全部清空」；
     * 数组 → 「本机规则 N 条」。**未确认的计数不许渲染成 0**（非数组形状如实说未确认）。
     */
    function ruleStateText(v) {
      if (v === null || v === undefined) return '本机尚未写入清理规则，当前只用内置库';
      if (Array.isArray(v)) {
        if (v.length === 0) return '本机规则已全部清空';
        return `本机规则 ${v.length} 条`;
      }
      return '本机规则计数未确认';
    }

    /**
     * 本机规则计数单列一槽（复评 N-F1）：合并行同时含内置与本机两类，计数只该吃「本机」那一份。
     * 判据**只读宿主给的 `builtin` 标记**（Ruling-106 单源），不按 id 前缀/白名单自判：
     *   · `builtin === true` → 内置行，不进本机计数；
     *   · `builtin === false` → 宿主明标的本机行，计入；
     *   · 任一行没带 `builtin` 标记（老宿主形状）→ 不猜、不把它当 0 条本机、也不并进计数，
     *     整槽如实落「未确认」（返回非数组标记，交 ruleStateText 的未确认分支，绝不出具体数字）。
     * 接口整体读不到时调用方不进取值、保持 null → 走 ruleStateText 的「本机尚未写入」读不到态。
     */
    function userRuleSlot(rows) {
      if (!Array.isArray(rows)) return 'unconfirmed';
      const local = [];
      for (const r of rows) {
        const b = r ? r.builtin : undefined;
        if (b === true) continue;
        if (b === false) { local.push(r); continue; }
        return 'unconfirmed';
      }
      return local;
    }

    /**
     * 写偏好请求体：**只发差量** `{ prefs: patch }`（服务端 normalize 后回全量）。
     * 不整包回传当前 prefs —— 那会把用户在别处刚改的组抹掉（读-并-写的整域覆盖风险，同 writePrefsGroup 的理由）。
     */
    function patchBody(patch) {
      return { prefs: patch };
    }

    /**
     * 能力表行读数：`ok===true`→提供（绿 pill）；`ok===false && NEVER_PROVIDED`→宿主不提供（灰 pill）；
     * 其余 `ok===false`→fallback 文案 + 已降级（琥珀 pill）。**五行一律 hasSwitch:false** —— 能力表只报事实，
     * 给个看着能开却永远不响的开关比不画更糟（spec §1.1 决策 8）。
     */
    function capCells(rows) {
      const arr = Array.isArray(rows) ? rows : [];
      return arr.map((r) => {
        const row = r || {};
        const key = String(row.key || '');
        let value;
        let cls;
        if (row.ok === true) { value = '提供'; cls = 'so-pill-down'; }
        else if (NEVER_PROVIDED.indexOf(key) >= 0) { value = '宿主不提供'; cls = 'so-pill-gray'; }
        else { value = String(row.fallback || '已降级'); cls = 'so-pill-amber'; }
        return { label: String(row.label || key), value, cls, detail: String(row.detail || ''), hasSwitch: false };
      });
    }

    /**
     * 三页只读闸门的**唯一判定**（I-6/评审清单问 3：简报 task-23-brief.md:154 要求三页同一闸门）：
     * storageDomain 不是真 ⇒ 只读（fail-closed）。原先三页三种形状（`=== false` / `=== false` / `!== true`），
     * 缺键时前两页放开写、搜索页禁用——同一份 cfg().capabilities 不该有两副面孔。
     * 键缺失、载荷非对象、宿主没给 capabilities 一律落只读；禁用必须伴随可见原因（各页自己带 why 文案）。
     */
    function capsReadOnly(caps) {
      const c = caps && typeof caps === 'object' ? caps : {};
      return c.storageDomain !== true;
    }

    /**
     * 保存按钮的只读闸门，三个来源按优先级：storageDomain 缺失 → 上次保存 501 → 保存中。
     * 禁用了就一定有 `why` 显示在旁边（不允许只变灰）。第 4 参 saving 由组件传入（简报签名是 3 参，
     * saving 走默认值 false，纯函数用例只喂前 3 参即命中 storageDomain 分支）。
     */
    function SAVE_DISABLED(prefs, caps, err, saving) {
      if (capsReadOnly(caps)) return { disabled: true, why: '配置只读：宿主未提供 storageDomain' };
      const e = err && typeof err === 'object' ? err : {};
      if (e.code === 'PREFS_UNAVAILABLE' || num(e.status) === 501) {
        return { disabled: true, why: '上一次保存失败（501），原因同上：宿主未提供 storageDomain' };
      }
      if (saving === true) return { disabled: true, why: '保存中…' };
      return { disabled: false, why: '' };
    }

    /**
     * 写接口错误 → 就地 notice（无浮层）。**只回显宿主给的句子**：403 的拒绝原因、501 的只读原因都来自
     * 服务端 message / guardDenied，客户端不复制一份 code→中文映射表（硬约束 5）。
     */
    function settingsErrNotice(err) {
      if (!err) return null;
      const status = num(err.status);
      const tone = (status === 403 || status === 501) ? 'red' : 'amber';
      return { tone, text: String(err.message || err.code || '接口异常') };
    }

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
      // SVG 属性必须用 React 的驼峰名（strokeWidth / strokeLinecap / strokeLinejoin）：
      // 连字符名在真 React 里会逐条报 `Invalid DOM property`（桩 React 不校验，故老测试放过了它）。
      // aria-* 例外，React 保留连字符原样。
      const attrs = {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
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
    //    Monitor=完整实现（Task 21）；Clean/Search/Settings 仍是可跑骨架，
    //    Task 22~24 逐个换实现，导出名不动。
    // ------------------------------------------------------------

    /**
     * 监控页（Task 21 完整实现）：**自身零 useState** —— 快照、link、档位都在
     * SysopsPage 的连接层里，本组件只吃 props；换页/重采不打断这里的渲染。
     * 三个 useRef 只给「新建规则」输入框读值用，每次渲染顺序固定。
     */
    function MonitorPage({ snap, link, err, onSource, onRuleToggle, onRuleAdd, onRestart, onProcToggle } = {}) {
      const vRef = useRef(null);
      const cRef = useRef(null);
      const kRef = useRef(null);

      /** 采集源条：一格一源，点按钮只发意图（开/重试），裁决全在服务端。 */
      function srcStrip(cells) {
        return h('div', { className: 'so-srcs' }, cells.map((c) => {
          const bad = ['stalled', 'crashed', 'exited-max'].indexOf(c.state) >= 0;
          const dim = c.key === '__link' || c.state === 'off' || c.state === 'unavailable';
          return h('span', { className: 'so-src' + (bad ? ' is-bad' : dim ? ' is-off' : ''), key: c.key },
            h('span', { className: 'so-dot' }),
            c.name, ' ',
            h(Pill, { cls: c.cls }, c.pill),
            c.detail ? h('span', { className: 'so-hint so-num' }, c.detail) : null,
            (c.retryOnly || c.state === 'crashed') && c.key !== '__link'
              ? h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-quiet', onClick: () => onRestart && onRestart(c.key) }, '重试')
              : null,
            c.state === 'off' && c.key !== '__link'
              ? h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-quiet', onClick: () => onSource && onSource(c.key, true) }, '开启')
              : null);
        }));
      }

      /** 首帧未到：四张骨架卡 + 「等待首帧数据」，数值位全破折号，绝不 NaN（pg1-16）。 */
      if (!snap) {
        return h('div', { className: 'so-tabpanel' },
          h('div', { className: 'so-mtr-strip' }, ['CPU 使用率', '内存', 'C 盘可用', '网络吞吐'].map((n) => h('div', { className: 'so-mtr', key: n },
            h('div', { className: 'so-n' }, n),
            h('div', { className: 'so-v so-num' }, '—'),
            h('div', { className: 'so-skel' })))),
          h('div', { className: 'so-card' }, h('div', { className: 'so-card-b' },
            h('div', { className: 'so-empty' }, '等待首帧数据：连上本机接口后这里会出现真实曲线。'))),
          srcStrip(srcCells({ sources: [] }, link)));
      }

      const rows = mtrRows(snap);
      const l = snap.latest || {};
      const s = snap.series || {};
      const alerts = snap.alerts || {};
      const rules = Array.isArray(alerts.rules) ? alerts.rules : [];
      const hits = Array.isArray(alerts.hits) ? alerts.hits : [];
      // 降级信息优先于"空态"：库不可用时显示"还没有触发记录"是误导（spec §7）。
      const hitsError = alerts.hitsError || alerts.errorCode || null;
      const proc = snap.proc || { rows: [], state: 'off', note: '' };
      const procRows = (Array.isArray(proc.rows) ? proc.rows.slice() : []).sort((a, b) => (num(b.cpuPct) || 0) - (num(a.cpuPct) || 0));
      const labelOf = {};
      (Array.isArray(snap.sources) ? snap.sources : []).forEach((r0) => { labelOf[r0.key] = r0.label || r0.key; });

      // 脏点丢弃要报数但不挡曲线（pg1-7）：只列真实计数，不编原因
      const dr = snap.dropped || {};
      const dropParts = [];
      if ((num(dr.bad) || 0) > 0) dropParts.push(`丢弃 ${dr.bad} 个异常点`);
      if ((num(dr.stale) || 0) > 0) dropParts.push(`乱序 ${dr.stale}`);

      // 四张曲线卡：cpu / mem / 网络（下行主线 + 上行灰线）/ C 盘空闲占比
      const chartCards = ['cpu', 'mem', 'netDown', 'diskFreePct'].map((k) => {
        const def = CHART_DEFS[k] || {};
        const spec = curveSpec(snap, k);
        let max = spec.max;
        let line2 = null;
        if (def.second) {
          const up = curveSpec(snap, def.second);
          max = max === null ? up.max : (up.max === null ? max : Math.max(max, up.max));
          const p2 = sparkPoints(up.points, max);
          if (p2) line2 = { points: p2, color: def.secondColor || 'var(--so-t3)' };
        }
        const line1 = sparkPoints(spec.points, max);
        const thY = spec.threshold !== null && num(max) !== null
          ? (CHART_H - CHART_PAD - (spec.threshold / max) * (CHART_H - CHART_PAD * 2)).toFixed(1)
          : null;
        let value = '—';
        let note = `最近 ${snap.keepMinutes}min`;
        if (k === 'cpu') { value = rows[0].v + rows[0].u; note = `阈值线 85% · 峰值 ${fmtPct(peak(s.cpu), 0)}`; }
        if (k === 'mem') { value = rows[1].v + rows[1].u; note = `峰值 ${fmtPct(peak(s.mem), 0)} · 保留 ${snap.keepMinutes}min`; }
        if (k === 'netDown') { value = rows[3].v + ' ' + rows[3].u; note = `下行主线 · 上行 ${fmtRate(num(l.netUp))}`; }
        if (k === 'diskFreePct') {
          value = rows[2].v + ' ' + rows[2].u;
          note = spec.thresholdGb === null ? '阈值缺失' : `红线 = ${spec.thresholdGb} GB 空闲水位` + (spec.threshold !== null ? `（≈ ${spec.threshold}%）` : '（总容量未知，不画线）');
        }
        return h('div', { className: 'so-card', key: k },
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-curve-cap' }, h('h3', null, `${spec.label} · 最近 ${snap.keepMinutes} 分钟`), h('span', { className: 'so-grow so-num' }, note)),
            h('div', { className: 'so-curve-v so-num' }, value),
            h('svg', { className: 'so-spark', viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: 'none', style: { height: CHART_H + 'px' } },
              [1, 2, 3].map((q) => h('line', { key: 'g' + q, x1: 0, y1: (CHART_H * q) / 4, x2: CHART_W, y2: (CHART_H * q) / 4, stroke: 'var(--so-bd)', strokeWidth: 1 })),
              thY !== null ? h('line', { key: 'th', x1: 0, y1: thY, x2: CHART_W, y2: thY, stroke: 'var(--so-up)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.55 }) : null,
              line1 ? h('polyline', { key: 'p', points: line1, fill: 'none', stroke: spec.color, strokeWidth: 1.6, strokeLinejoin: 'round' }) : h('span', { key: 'e', className: 'so-hint' }, '暂无采样'),
              line2 ? h('polyline', { key: 'p2', points: line2.points, fill: 'none', stroke: line2.color, strokeWidth: 1.4 }) : null)));
      });

      // 规则行：置灰只吃宿主算好的 st 三态，页面绝不自己比 source.state（pg1-11）
      const ruleRows = rules.map((row) => {
        const rl = (row && row.rule) || {};
        const st = (row && row.st) || {};
        return h('div', { className: 'so-rule', key: rl.id },
          h('div', { className: 'so-ri' },
            h('div', { className: 'so-rn' }, rl.n || rl.name || rl.id),
            h('div', { className: 'so-rd' }, rl.d || `依赖 ${labelOf[rl.dep] || rl.dep || '本机采集'}`)),
          h('span', { className: 'so-rt' + (st.dim ? ' so-rule-dim' : '') }, st.st || ''),
          h(Switch, {
            on: st.on === true, disabled: st.dim === true,
            label: st.on ? '停用规则' : '启用规则',
            onChange: (next) => onRuleToggle && onRuleToggle(rl.id, next),
          }));
      });

      const readVal = (ref, dft) => { const x = ref && ref.current ? Number(ref.current.value) : NaN; const v = num(x); return v === null || v <= 0 ? dft : v; };
      const saveRule = () => {
        if (!onRuleAdd) return;
        onRuleAdd({ metric: 'cpu', value: readVal(vRef, 85), consecutive: readVal(cRef, 3), cooldownSec: Math.max(60, readVal(kRef, 10) * 60) });
      };

      const hitText = (hh) => {
        if (hh.kind === 'op') return hh.text || hh.note || '';
        const name = hh.ruleName || hh.name || (hh.rule && hh.rule.n) || '';
        const v = num(hh.value);
        const vs = v === null ? '' : (hh.metric === 'netDown' || hh.metric === 'netUp' ? fmtRate(v) : `${v}%`);
        return `${name}：${vs}${hh.note ? '（' + hh.note + '）' : ''}`;
      };

      const procBody = proc.state === 'on' && procRows.length
        ? h('div', null,
            h('div', { className: 'so-tblwrap' },
              h('table', { className: 'so-tbl' },
                h('thead', null, h('tr', null,
                  h('th', null, '进程'), h('th', { className: 'so-r' }, 'PID'), h('th', { className: 'so-r' }, 'CPU%'), h('th', { className: 'so-r' }, '内存'), h('th', null, '来源'))),
                h('tbody', null, procRows.map((p) => h('tr', { key: p.pid },
                  h('td', { className: 'so-tr-name' }, String(p.name ?? p.pid)),
                  h('td', { className: 'so-r so-num' }, String(p.pid ?? '—')),
                  h('td', { className: 'so-r so-num', style: { fontWeight: (num(p.cpuPct) || 0) > 15 ? 600 : 400 } }, num(p.cpuPct) === null ? '—' : p.cpuPct.toFixed(1)),
                  h('td', { className: 'so-r so-num' }, fmtBytes(p.ws)),
                  h('td', null, h(Pill, { cls: 'so-pill-line' }, 'Win32_Process'))))))),
            proc.note ? h('div', { className: 'so-tbl-note so-num' }, proc.note) : null,
            h('div', { className: 'so-notice so-notice-gray' },
              h('span', null, '只读榜：本插件不提供「结束进程」。要结束请在任务管理器自己做——误杀系统进程不该由一个监控面板代劳。')))
        : h('div', { className: 'so-empty' },
            '进程榜采集未开启。',
            h('div', { className: 'so-hint' }, '单次 Get-CimInstance Win32_Process 实测 640ms，按 5s 刷新会持续占用约一个核心的 13%，所以默认关；本页展开进程榜时会自动开启。'),
            h('button', { type: 'button', className: 'so-btn so-btn-sm', style: { marginTop: 10 }, onClick: () => onProcToggle && onProcToggle(true) }, '现在开启'));

      return h('div', { className: 'so-tabpanel' },
        err ? h(Notice, { tone: 'amber' }, `接口异常（${err.code || 'UNKNOWN'}）：${err.message || '未知错误'}`) : null,
        h('div', { className: 'so-mtr-strip' }, rows.map((r) => h('div', { className: 'so-mtr', key: r.key },
          h('div', { className: 'so-n' }, r.n),
          h('div', { className: 'so-v so-num' }, r.v, h('small', null, r.u)),
          h('div', { className: 'so-c so-num' }, r.c),
          r.pct === null ? null : h('div', { className: 'so-track' + (r.cls ? ' is-' + r.cls : '') },
            h('i', { style: { width: Math.max(0, Math.min(100, r.pct)) + '%' } }))))),
        srcStrip(srcCells(snap, link)),
        dropParts.length ? h('div', { className: 'so-hint', style: { marginTop: 8 } }, dropParts.join(' · ')) : null,
        h('div', { className: 'so-charts' }, chartCards),
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '进程占用榜'), h('span', { className: 'so-hsub' }, '按 PowerShell 周期采集，开销较高，默认关闭')),
          h('div', { className: 'so-card-b' }, procBody)),
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '阈值告警'), h('span', { className: 'so-hsub' }, '触发只在页面内落时间线，不弹系统浮层')),
          rules.length ? h('div', null, ruleRows) : h('div', { className: 'so-card-b' }, h('div', { className: 'so-empty' }, '还没有告警规则：在下方新建一条。')),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-grid so-g-2' },
              h('div', { className: 'so-field' }, h('label', null, '指标'), h('input', { className: 'so-input', type: 'text', defaultValue: 'CPU 使用率', readOnly: true })),
              h('div', { className: 'so-field' }, h('label', null, '阈值 / 持续'),
                h('input', { ref: vRef, className: 'so-input so-num', type: 'text', defaultValue: '85', style: { width: 64 } }), ' % · 连续',
                h('input', { ref: cRef, className: 'so-input so-num', type: 'text', defaultValue: '3', style: { width: 48 } }), ' 次'),
              h('div', { className: 'so-field' }, h('label', null, '冷却'),
                h('input', { ref: kRef, className: 'so-input so-num', type: 'text', defaultValue: '10', style: { width: 64 } }), ' 分钟内不重复'),
              h('div', { className: 'so-field' }, h('label', null, '提示落点'), h('input', { className: 'so-input', type: 'text', defaultValue: '监控页时间线 + 侧边栏蓝点', readOnly: true }))),
            h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', { type: 'button', className: 'so-btn so-btn-primary so-btn-sm', onClick: saveRule }, '保存规则'),
              h('span', { className: 'so-hint' }, '新建规则会插入列表首位，并写入下方触发记录。')))),
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '触发记录'), h('span', { className: 'so-hsub' }, '本机保留最近 200 条'),
            h('span', { className: 'so-grow so-hint so-num' }, `${hits.length} 条`)),
          h('div', { className: 'so-card-b' },
            hitsError
              ? h('div', { className: 'so-empty' },
                  `触发记录落盘不可用：${alerts.hitsError || alerts.errorCode}（规则仍在评估，命中不会写入本机记录）`)
              : null,
            hits.length
              ? h('div', { className: 'so-tl so-timeline' }, hits.map((hh, i) => h('div', {
                  className: 'so-tl-item ' + (hh.kind === 'op' ? 'so-tl-op' : 'so-tl-hit'), key: String(hh.hitId || (hh.t || i)) },
                  h('div', { className: 'so-tt so-num' }, fmtAge(Math.max(0, Date.now() - (num(hh.t) || Date.now())))),
                  h('div', { className: 'so-tx' }, hitText(hh)))))
              : (hitsError ? null : h('div', { className: 'so-empty' }, '本机还没有触发记录：规则命中后会出现在这里。')))));
    }

    /**
     * 清理页（Task 22 完整实现）：扫描只读 → 冻结清单 → 勾选 → 执行/隔离 → 留痕。
     * 与 MonitorPage 同规：自身零 useState —— sel/lastSummary/数据全由 SysopsPage 传入，
     * 状态机在宿主侧（lib/clean/service.js 的 state()），页面只做渲染分支：
     * idle（空态卡）/ scanning（进度卡）/ 有清单（清单卡）/ 执行完（失效卡）。
     * stopped/truncated 是附加标记不是独立相位（简报 Step 3）；错误就地落卡（.so-notice-red/amber，无浮层）。
     * 红线：本页**不判断任何路径能不能删** —— guardDenied 只做纯渲染，裁决只有 lib/clean/guard.js。
     */
    function CleanPage(props = {}) {
      const {
        clean = {}, plan = null, logs = [], unfinished = [], quar = null, rules = [],
        prefs = {}, caps = {}, link = 'sse', sel = new Set(), err = null, lastSummary = null,
        onScan, onStopScan, onToggle, onSelectAll, onSelectNone, onApply, onQuarantine,
      } = props;

      const st = clean && typeof clean === 'object' ? clean : {};
      const phase = String(st.phase || 'idle');
      const logsArr = Array.isArray(logs) ? logs : [];
      const unfArr = Array.isArray(unfinished) ? unfinished : [];
      const rulesTotal = Array.isArray(rules) ? rules.length : (rules && typeof rules === 'object' ? num(rules.total) ?? 0 : 0);
      const rulesRow = Array.isArray(rules) ? { items: rules, off: [] }
        : (rules && typeof rules === 'object' ? { items: Array.isArray(rules.items) ? rules.items : [], off: Array.isArray(rules.off) ? rules.off : [] } : { items: [], off: [] });
      const sc = scanCells(st, rulesTotal);
      const planObj = plan && typeof plan === 'object' && Array.isArray(plan.items) ? plan : null;
      const totals = planObj ? selTotals(planObj, sel) : { n: 0, bytes: 0, bytesText: '—', selectable: [], risky: 0, rejected: 0 };
      const rows = planObj ? planRows(planObj, sel) : [];
      const capsRO = capsReadOnly(caps); // I-6：三页同一个判定（storageDomain 不为真 ⇒ 只读，fail-closed）

      const pad2 = (n) => String(n).padStart(2, '0');
      const stamp = (ms) => { const v = num(ms); if (v === null) return '—'; const d = new Date(v); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
      const modeLabel = (m) => (m === 'move-to-quarantine' ? '隔离到暂存' : m === 'delete-dir' ? '永久删除（目录）' : m === 'delete-file' ? '永久删除（文件）' : '—');
      const unfProgress = (u) => (num(u.done) !== null && num(u.total) !== null
        ? ` · 已记录 ${u.done}/${u.total}`
        : (Array.isArray(u.itemIds) ? ` · 涉及 ${u.itemIds.length} 项（完成数未知）` : ''));

      const errN = cleanErrNotice(err);
      const errNotice = errN ? h(Notice, { tone: errN.tone }, errN.text) : null;
      // 错误落在触发它的那张卡：rules/prefs 的写失败落「扫描范围」卡，其余落当前主卡
      const errForScope = Boolean(err && /^(rules|prefs)/.test(String(err.source || '')));

      const writeDisabled = totals.selectable.length === 0 || capsRO === true;
      const writeWhy = capsRO === true ? '配置只读：宿主未提供 storageDomain' : (totals.selectable.length === 0 ? '勾选至少一项后才可执行' : '');

      // —— 主卡四分支：scanning / 清单 / 失效 / 空态 ——
      let main;
      if (phase === 'scanning') {
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '扫描进度'), h('span', { className: 'so-hsub' }, sc.phase),
            h('span', { className: 'so-grow so-num' }, sc.pct === null ? '进度未知' : `${sc.pct}%`)),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-curve-cap' }, h('h3', null, '正在遍历'), h('span', { className: 'so-grow so-path' }, sc.cur || '…')),
            h('div', { className: 'so-hint so-num' }, `已遍历 ${sc.walked} 个条目 · 已发现 ${sc.found} 项 · ${sc.size}`),
            h('div', { className: 'so-track' + (sc.pct === null ? ' is-indeterminate' : ''), style: { marginTop: 8 } },
              h('i', sc.pct === null ? null : { style: { width: Math.max(0, Math.min(100, sc.pct)) + '%' } })),
            h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'so-btn so-btn-sm', disabled: st.stopped === true, onClick: () => onStopScan && onStopScan() }, '停止扫描'),
              h('span', { className: 'so-hint' }, '扫描可随时中断，中断后已发现的部分仍可继续查看。进度条是规则覆盖度估算，不是字节进度，真实完成以扫描结束为准。')),
            sc.note ? h(Notice, { tone: 'amber' }, `本次扫描如实降级：${sc.note}`) : null,
            errForScope ? null : errNotice));
      } else if (planObj) {
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' },
            h('h2', null, '待清理清单'),
            h('span', { className: 'so-hsub' }, `快照生成于 ${stamp(planObj.at)} · 数据在扫描那一刻冻结 · ${sc.phase}`),
            h('span', { className: 'so-grow' },
              h('span', { className: 'so-hint so-num' }, `共 ${planObj.items.length} 项`),
              h('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: () => onSelectAll && onSelectAll() }, '全选可清理项'),
              h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-quiet', onClick: () => onSelectNone && onSelectNone() }, '清空选择'),
              totals.risky > 0 ? h('span', { className: 'so-hint' }, `全选已跳过 ${totals.risky} 项标风险的（应用正在运行）`) : null)),
          unfArr.length ? h('div', { className: 'so-card-b' }, unfArr.map((u) => h(Notice, { key: String(u.logId ?? ''), tone: 'amber' },
            `上次执行未确认完成：留痕 ${String(u.logId ?? '')} 开了头没写完成（模式 ${modeLabel(u.mode)}${unfProgress(u)}）—— 执行对象只认那份冻结清单，请对照下方「清理留痕」核实磁盘现状。`))) : null,
          sc.note ? h('div', { className: 'so-card-b' }, h(Notice, { tone: 'amber' },
            `这份清单如实降级：${sc.note}${st.stopped === true ? '（扫描是被停止的，未遍历到的目录不在清单里）' : ''}`)) : null,
          h('div', { className: 'so-tblwrap' },
            h('table', { className: 'so-tbl' },
              h('thead', null, h('tr', null,
                h('th', { className: 'so-c' }),
                PLAN_COLS.map((c) => h('th', { key: c, className: (c === '大小' || c === '最后访问') ? 'so-r' : '' }, c)))),
              h('tbody', null, rows.map((r, i) => h('tr', { key: r.id },
                h('td', { className: 'so-c' }, h('button', {
                  type: 'button', className: 'so-check', role: 'checkbox',
                  'aria-checked': r.checked ? 'true' : 'false', disabled: r.disabled,
                  title: r.disabled ? `guard 拒绝：${r.why}` : (r.why || (r.checked ? '取消勾选' : '勾选此项')),
                  onClick: () => { if (!r.disabled && onToggle) onToggle(r.id, !r.checked); },
                }, r.checked ? '✓' : '')),
                h('td', null, h('div', { className: 'so-path' }, r.path),
                  (num(planObj.items[i] && planObj.items[i].count) ?? 0) > 0 ? h('div', { className: 'so-hint' }, `共 ${planObj.items[i].count} 个文件`) : null),
                h('td', { className: 'so-r so-num' }, r.sizeText),
                h('td', null, r.ruleName),
                h('td', { className: 'so-r so-num' }, r.accText),
                h('td', null,
                  h(Pill, { cls: r.riskPill === '已拒绝' ? 'so-pill-red' : (r.riskPill === '无' ? 'so-pill-gray' : 'so-pill-amber') }, r.riskPill),
                  r.why ? h('div', { className: 'so-hint' }, r.why) : null))))),
            ),
          h('div', { className: 'so-card-b', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { className: 'so-num' }, `已选 ${totals.n} 项 · 预计释放 ${totals.bytesText}`),
            h('span', { className: 'so-hint' }, totals.selectable.length === 0 ? '勾选至少一项' : '删除不可恢复，回收站不参与'),
            capsRO === true ? h('span', { className: 'so-hint' }, '配置只读：宿主未提供 storageDomain，两个写按钮已禁用') : null,
            h('span', { className: 'so-grow', style: { display: 'inline-flex', gap: 8 } },
              h('button', { type: 'button', className: 'so-btn so-btn-sm', disabled: writeDisabled, title: writeWhy,
                onClick: () => onQuarantine && onQuarantine(totals.selectable) }, '隔离到暂存目录'),
              h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-primary', disabled: writeDisabled, title: writeWhy,
                onClick: () => onApply && onApply(totals.selectable, planObj.modeDefault || 'delete-file') }, '清理选中'))),
          h('div', { className: 'so-tbl-note' }, `执行方式取自快照 modeDefault：${modeLabel(planObj.modeDefault)}；类型不符的条目会被记为「跳过」，不会被硬删。`),
          h('div', { className: 'so-card-b' },
            h(Notice, { tone: 'gray' }, quarantineText(prefs)),
            quar && typeof quar === 'object' && (num(quar.files) !== null || num(quar.bytes) !== null)
              ? h('div', { className: 'so-hint so-num' }, `暂存区现状：${num(quar.dirs) ?? '—'} 个日期目录 · ${num(quar.files) ?? '—'} 个文件 · ${fmtBytes(quar.bytes)}${quar.oldest ? ` · 最早一天 ${quar.oldest}` : ''}`)
              : null),
          errForScope ? null : errNotice);
      } else if (lastSummary) {
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '清单已失效'), h('span', { className: 'so-hsub' }, `清理已执行 · 执行于 ${stamp(lastSummary.at)}`)),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-hint so-num' }, `上次执行（清单 ${String(lastSummary.planId ?? '—')}）：成功 ${num(lastSummary.ok) ?? 0} · 跳过 ${num(lastSummary.skipped) ?? 0} · 失败 ${num(lastSummary.failed) ?? 0} · 拒绝 ${num(lastSummary.rejected) ?? 0} · 释放 ${fmtBytes(lastSummary.bytesFreed)}`),
            h('div', { className: 'so-hint', style: { marginTop: 6 } }, '清单是扫描那一刻的冻结快照：执行完就作废，改勾选或再清别的都必须重新扫描。'),
            h('div', { style: { marginTop: 10 } }, h('button', { type: 'button', className: 'so-btn so-btn-primary so-btn-sm', onClick: () => onScan && onScan() }, '重新扫描')),
            errForScope ? null : errNotice));
      } else {
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-empty' },
              '尚未扫描。点击右上角', h('b', null, '「开始扫描」'), '生成待清理清单。', h('br'),
              h('span', { className: 'so-hint' }, '扫描是只读的：只统计大小与访问时间，删除只发生在你勾选之后点「清理选中」那一刻。')),
            h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
              h('button', { type: 'button', className: 'so-btn so-btn-primary so-btn-sm', onClick: () => onScan && onScan() }, st.planId ? '重新扫描' : '开始扫描')),
            st.error ? h(Notice, { tone: 'red' }, `扫描失败：${String(st.error)}`) : null,
            errForScope ? null : errNotice));
      }

      return h('div', { className: 'so-tabpanel' },
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' },
            h('h2', null, '扫描范围'),
            h('span', { className: 'so-hsub' }, `用户自建 ${rulesRow.items.length} 条 · 内置停用 ${rulesRow.off.length} 条`),
            h('span', { className: 'so-grow' },
              h(Pill, { cls: link === 'sse' ? 'so-pill-gray' : 'so-pill-amber' },
                link === 'sse' ? '推送通道 SSE' : (link === 'polling' ? '降级：轮询 2s' : '重连中')))),
          h('div', { className: 'so-card-b' },
            rulesRow.items.length ? h('div', { className: 'so-tabs' }, rulesRow.items.slice(0, 8).map((r) => h(Pill, { key: String(r.id ?? r.n), cls: 'so-pill-line' }, `${String(r.n ?? '')}（${String(r.kind ?? '自定义')}）`))) : null,
            h(Notice, { tone: 'amber' }, '红线由服务端 guard 单点裁决：系统目录 / 回收站 / Program Files、属主与 ACL、注册表一律不参与清理，客户端不复制也不放宽这套判定。命中红线的条目会被标为「已拒绝」，不进入可选集合。'),
            errForScope ? errNotice : null)),
        main,
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '清理留痕'), h('span', { className: 'so-hsub' }, '追加式，只读'),
            h('span', { className: 'so-grow so-hint so-num' }, `${logsArr.length} 段记录`)),
          logsArr.length ? h('div', null, logsArr.map((lg, i) => {
            const r = logRow(lg);
            return h('details', { key: r.id || String(lg.startedAt ?? i), className: 'so-logrow' },
              h('summary', null,
                h('span', { className: 'so-num' }, r.id),
                h(Pill, { cls: r.modePill === '隔离到暂存' ? 'so-pill-blue' : 'so-pill-gray' }, r.modePill),
                h('span', { className: 'so-hint so-num' }, r.line),
                h('span', { className: 'so-grow so-hint so-num' }, stamp(lg.startedAt))),
              h('div', { className: 'so-snap' },
                h('div', { className: 'so-num' }, r.snapshot),
                h('div', { className: 'so-hint' }, r.restorable
                  ? '隔离件可还原：原件按日期子目录存在暂存区，到期由你手动清空。'
                  : '永久删除不经过回收站，不可恢复；清单快照与三档计数已冻结在本条记录里。'),
                Array.isArray(lg.itemIds) ? h('div', { className: 'so-hint so-num' }, `涉及条目 ${lg.itemIds.length} 项`) : null));
          })) : h('div', { className: 'so-empty' }, '还没有清理记录：执行一次清理后会在这里追加一条可展开的记录（追加式，只读）。')));
    }

    /**
     * 搜索页（Task 23）：三级自检 → 引导卡（未就绪时）→ 通路选择 + 覆盖范围 → 结果表。
     * 与 MonitorPage / CleanPage 同规：自身零 useState，数据与写操作全由 useStream 侧传下来。
     */
    function SearchPage(props = {}) {
      const { probe = null, res = null, mode = 'walk', limit = LIMITS[1], q = '', dirs = [], err = null,
        onSearch, onMode, onLimit, onReprobe, onAddDir, onDelDir } = props;
      const dirRef = useRef(null);
      const qRef = useRef(null);
      const p = probe || {};
      const ready = p.ready === true;
      const effMode = modeOf(p, mode);
      const why = modeWhy(p);
      const port = num((cfg().defaults || {}).searchPort);
      const adv = advice();
      const cells = probeCells(p);
      const degrade = searchDegrade(res);
      const head = res ? resultHead(res) : null;
      const rows = res ? rowCells(res) : [];
      // 目录覆盖范围写 prefs，没有 storageDomain 就写不进去：chips 改只读 + 注明原因（I-6：三页同一个 capsReadOnly 判定）
      const dirsReadOnly = capsReadOnly(cfg().capabilities || {});

      return h('div', { className: 'so-tabpanel' },
        err ? h(Notice, { tone: 'amber' }, `接口异常（${err.code || 'UNKNOWN'}）：${err.message || '未知错误'}`) : null,
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, SEARCH_TXT.selfCheck),
            h('span', { className: 'so-hsub' }, SEARCH_TXT.probeSub),
            h('span', { className: 'so-grow' },
              h('span', { className: 'so-hint' }, probeHint(p)),
              h('button', { type: 'button', className: 'so-btn so-btn-sm', style: { marginLeft: 8 },
                onClick: () => onReprobe && onReprobe() }, '重新检测'))),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-srcs' }, cells.map((c) => h('div', { key: c.title, className: 'so-rule' },
              h('div', { className: 'so-ri' },
                h('div', { className: 'so-rn' }, c.title, h(Pill, { cls: c.pillCls }, c.pill)),
                c.detail ? h('div', { className: 'so-rd' }, c.detail) : null),
              h('span', { className: 'so-rt so-num' }, c.mark)))))),
        ready ? null : h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, SEARCH_TXT.guideTitle)),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-hint' }, SEARCH_TXT.guideLead),
            h('div', { className: 'so-hint', style: { marginTop: 8 } }, SEARCH_TXT.guideOwn),
            adv.length ? h('div', { className: 'so-snap', style: { marginTop: 8 } },
              adv.map((line, i) => h('div', { key: String(i), className: 'so-input-mono so-num' }, line))) : null,
            h('div', { className: 'so-hint', style: { marginTop: 9 } },
              SEARCH_TXT.guidePortA, h('span', { className: 'so-num' }, port === null ? '—' : String(port)), SEARCH_TXT.guidePortB))),
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '搜索'),
            h('span', { className: 'so-grow' },
              h('span', { className: 'so-seg' },
                h('button', { type: 'button', className: effMode === 'everything' ? 'is-active' : '',
                  'aria-pressed': effMode === 'everything' ? 'true' : 'false',
                  disabled: !ready, title: why || '用 Everything 的全盘索引查询',
                  onClick: () => onMode && onMode('everything') }, '全盘索引'),
                h('button', { type: 'button', className: effMode === 'walk' ? 'is-active' : '',
                  'aria-pressed': effMode === 'walk' ? 'true' : 'false',
                  onClick: () => onMode && onMode('walk') }, '限定目录')))),
          h('div', { className: 'so-card-b' },
            why ? h('div', { className: 'so-hint', style: { marginBottom: 8 } }, '全盘索引' + why) : null,
            h('div', { className: 'so-field' }, h('label', null, SEARCH_TXT.qLabel)),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              // 输入非受控：初值取 props.q；按钮读**输入框现值**（qRef）而不是 props.q ——
              // props.q 是上一条查询的关键字，拿它发请求会让「改了关键字点搜索」跑出上一条结果。
              h('input', { className: 'so-input', type: 'text', placeholder: SEARCH_TXT.qHint, defaultValue: q, ref: qRef, style: { height: 34, flex: 1 } }),
              h('button', { type: 'button', className: 'so-btn so-btn-primary', style: { height: 34 },
                onClick: () => onSearch && onSearch(qRef.current && typeof qRef.current.value === 'string' ? qRef.current.value : q) }, '搜索')),
            h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 9 } },
              h('span', { className: 'so-hint' }, '返回上限'),
              h(Seg, { options: LIMITS.map((n) => ({ v: n, t: String(n) })), value: num(limit) === null ? LIMITS[1] : limit,
                onChange: (v) => onLimit && onLimit(v) }),
              h('span', { className: 'so-hint', style: { marginLeft: 'auto' } }, SEARCH_TXT.tokenHint)),
            effMode === 'walk' ? h(Notice, { tone: 'amber' }, h('span', null, SEARCH_TXT.walkA), h('span', null, SEARCH_TXT.walkB)) : null,
            effMode === 'walk' ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 } },
              (Array.isArray(dirs) ? dirs : []).map((d) => h(Pill, { key: String(d), cls: 'so-pill-line' },
                h('span', { className: 'so-path' }, String(d)),
                dirsReadOnly ? null : h('button', { type: 'button', className: 'so-btn so-btn-quiet so-btn-sm',
                  title: '把该目录移出覆盖范围', onClick: () => onDelDir && onDelDir(String(d)) }, '×'))),
              dirsReadOnly
                ? h('span', { className: 'so-hint' }, '配置只读：宿主未提供 storageDomain，覆盖范围不可改')
                : h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('input', { className: 'so-input so-input-mono', type: 'text', placeholder: SEARCH_TXT.dirHint, ref: dirRef, style: { height: 26, width: 260 } }),
                    h('button', { type: 'button', className: 'so-btn so-btn-sm',
                      onClick: () => { const v = dirRef.current && dirRef.current.value ? String(dirRef.current.value).trim() : ''; if (v) onAddDir && onAddDir(v); } }, '＋ 添加目录'))) : null)),
        res === null
          ? h('div', { className: 'so-card' }, h('div', { className: 'so-card-b' },
              h('div', { className: 'so-empty' }, '还没有查询：输入关键字后点「搜索」。一次查询只走一条通路，来源会标在结果表上。')))
          : h('div', { className: 'so-card' },
            h('div', { className: 'so-card-h' }, h('h2', null, '结果'),
              h('span', { className: 'so-hsub' }, head.sub),
              h('span', { className: 'so-grow' },
                h(Pill, { cls: res.source === 'walk' ? 'so-pill-amber' : 'so-pill-blue' }, '来源：' + head.sourcePill),
                h('span', { className: 'so-hint so-num', style: { marginLeft: 8 } }, head.hitText))),
            h('div', { className: 'so-card-b' },
              degrade ? h(Notice, { tone: degrade.tone }, degrade.text) : null,
              res && res.note ? h(Notice, { tone: 'gray' }, String(res.note)) : null,
              rows.length ? h('div', null,
                h('div', { className: 'so-tblwrap' },
                  h('table', { className: 'so-tbl' },
                    h('thead', null, h('tr', null,
                      h('th', null, '名称'), h('th', null, '所在目录'), h('th', { className: 'so-r' }, '大小'),
                      h('th', { className: 'so-r' }, '修改时间'), h('th', { className: 'so-c' }, '来源'))),
                    h('tbody', null, rows.map((c, i) => h('tr', { key: String(i) },
                      h('td', { className: 'so-tr-name' }, c.name),
                      h('td', null, h('div', { className: 'so-path' }, c.dir)),
                      h('td', { className: 'so-r so-num' }, c.sizeText),
                      h('td', { className: 'so-r so-num' }, c.mtimeText),
                      h('td', { className: 'so-c' }, h(Pill, { cls: 'so-pill-line' }, c.sourcePill))))))),
                h('div', { className: 'so-tbl-note' }, SEARCH_TXT.openNote))
                : h('div', { className: 'so-empty' }, SEARCH_TXT.emptyNote))));
    }
    /**
     * 设置页（Task 24）：四源开关 / 清理规则（含 guard 拒绝的纯渲染）/ 暂存与默认方式 / 搜索通路 / 能力表。
     * 与 MonitorPage / CleanPage / SearchPage 同规：自身零 useState —— prefs / rules / caps / snap 都从容器传下来。
     * 红线：黑名单文案、能力行、档位、默认值全吃注入载荷；guard 拒绝原因只透传宿主给的句子，本页不做任何路径裁决。
     */
    function SettingsPage(props = {}) {
      const {
        prefs = {}, rules = [], userRules = null, caps = {}, capRows = [], snap = null, err = null, saving = false,
        onPatch, onRuleAdd, onRuleToggle, onRuleRemove, onSave,
      } = props;
      const nameRef = useRef(null);
      const globRef = useRef(null);
      const ageRef = useRef(null);
      const kindRef = useRef(null);
      const portRef = useRef(null);
      const esRef = useRef(null);

      const srcRows = SOURCE_ROWS(prefs, snap);
      const alertRules = (snap && snap.alerts && Array.isArray(snap.alerts.rules)) ? snap.alerts.rules : [];
      const cells = ruleCells(rules);
      const caps_ = Array.isArray(capRows) ? capRows : [];
      const capList = capCells(caps_);
      const save = SAVE_DISABLED(prefs, caps, err, saving);
      const errN = settingsErrNotice(err);
      const redlines = Array.isArray(cfg().redlines) ? cfg().redlines : [];

      const p = prefs && typeof prefs === 'object' ? prefs : {};
      const clean = p.clean && typeof p.clean === 'object' ? p.clean : {};
      const search = p.search && typeof p.search === 'object' ? p.search : {};
      const defaults = cfg().defaults || {};
      // 暂存目录：prefs 只会是展开后的绝对路径（schema 拒 `%...%`），没配时回落宿主展开的 defaults —— 都不许渲染 undefined
      const quarDir = String(clean.quarantineDir || defaults.quarantineDir || '—');
      const keepDays = num(clean.keepDays);
      const after = clean.after === 'log' ? 'log' : 'none';
      // 搜索通路：生效值读 prefs.search，占位与回落读 cfg().defaults.searchPort；esPath 是 optionalString，normalize 后多半 undefined → ?? '' 防渲染出字面量 undefined
      const portVal = num(search.port);
      const dfltPort = num(defaults.searchPort);
      const esVal = String(search.esPath ?? '');

      const readNum = (ref, dft) => { const x = ref && ref.current ? Number(ref.current.value) : NaN; const v = num(x); return v === null || v < 0 ? dft : v; };
      // 搜索通路保存（brief 任务24 :170）：把两个字段的现值交给容器 onSave，由容器走读-并-写（Ruling-105）。
      // 没填的字段（真实浏览器里 defaultValue 会预填现值；测试/异常态 ref 为空）不上报 —— 服务端现值原样保留。
      const saveSearch = () => {
        if (!onSave) return;
        const f = {};
        const pv = portRef.current && portRef.current.value !== undefined && portRef.current.value !== null ? String(portRef.current.value).trim() : '';
        if (pv !== '') f.port = pv;
        if (esRef.current && esRef.current.value !== undefined && esRef.current.value !== null) f.esPath = String(esRef.current.value);
        onSave(f);
      };
      const saveRule = () => {
        if (!onRuleAdd) return;
        onRuleAdd({
          n: nameRef.current && nameRef.current.value ? String(nameRef.current.value) : '',
          glob: globRef.current && globRef.current.value ? String(globRef.current.value) : '',
          ageDays: readNum(ageRef, 30),
          kind: kindRef.current && kindRef.current.value ? String(kindRef.current.value) : '缓存',
        });
      };

      return h('div', { className: 'so-tabpanel' },
        // —— 数据采集：四源开关 + 依赖采集的告警规则可用性（与监控页同一个 st） ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '数据采集'),
            h('span', { className: 'so-hsub' }, '关掉某一源，依赖它的告警规则会就地标为不可用')),
          h('div', { className: 'so-card-b' },
            srcRows.map((r) => h('div', { key: r.key, className: 'so-rule' },
              h('div', { className: 'so-ri' },
                h('div', { className: 'so-rn' }, r.name, h(Pill, { cls: 'so-pill-gray' }, r.tier)),
                h('div', { className: 'so-rd' }, r.desc)),
              h('span', { className: 'so-rt so-num' }, r.cadText),
              r.switch === null
                ? h('span', { className: 'so-hint' }, '档位由监控页控制')
                : h(Switch, { on: r.switch.on, disabled: r.switch.disabled, label: `切换 ${r.name}`,
                    onChange: (next) => onPatch && onPatch({ sources: { [r.key]: next } }) }))),
            alertRules.length ? h('div', { style: { marginTop: 10 } },
              h('div', { className: 'so-hint' }, '依赖本机采集的告警规则：'),
              alertRules.map((row) => {
                const rl = (row && row.rule) || {};
                const st = (row && row.st) || {};
                return h('div', { key: String(rl.id ?? rl.n ?? ''), className: 'so-rule' },
                  h('div', { className: 'so-ri' },
                    h('div', { className: 'so-rn' }, String(rl.n || rl.id || '')),
                    h('div', { className: 'so-rd' + (st.dim ? ' so-rule-dim' : '') }, String(st.st || ''))),
                  h('span', { className: 'so-rt so-num' + (st.dim ? ' so-rule-dim' : '') }, ''),
                  h(Switch, { on: st.on === true, disabled: st.dim === true,
                    label: st.on ? '停用规则' : '启用规则',
                    onChange: (next) => onRuleToggle && onRuleToggle(rl.id, next) }));
              })) : null)),
        // —— 清理规则：内置/本机 pill + guard 拒绝纯渲染 + 新增表单（按钮唯一）+ 黑名单 notice ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '清理规则'),
            h('span', { className: 'so-hsub' }, '内置规则只放通用缓存路径；本机私有路径存在你机器上，不进仓库'),
            h('span', { className: 'so-grow so-hint' }, ruleStateText(userRules))),
          errN ? h('div', { className: 'so-card-b', style: { paddingBottom: 0 } }, h(Notice, { tone: errN.tone }, errN.text)) : null,
          h('div', { className: 'so-card-b' },
            cells.length ? h('div', null, cells.map((c, i) => {
              const rid = (Array.isArray(rules) && rules[i]) ? rules[i].id : null;
              return h('div', { key: String(rid ?? i), className: 'so-rule' + (c.blocked ? ' so-rule-dim' : '') },
                h('div', { className: 'so-ri' },
                  h('div', { className: 'so-rn' }, c.n,
                    c.pill === '' ? null : h(Pill, { cls: c.pill === '内置' ? 'so-pill-gray' : 'so-pill-blue' }, c.pill),
                    c.blocked ? h(Pill, { cls: 'so-pill-up' }, '已被 guard 拒绝') : null),
                  h('div', { className: 'so-rd so-path' }, c.glob),
                  c.denyWhy ? h('div', { className: 'so-hint' }, c.denyWhy) : null),
                h('span', { className: 'so-rt so-num' }, c.ageText),
                h(Switch, { on: c.on && !c.blocked, disabled: c.blocked,
                  label: c.blocked ? 'guard 已拒绝，无法启用' : (c.on ? '停用规则' : '启用规则'),
                  onChange: (next) => { if (!c.blocked && onRuleToggle) onRuleToggle(rid, next); } }));
            })) : h('div', { className: 'so-empty' }, ruleStateText(userRules)),
            // 新增本机规则：自研控件，无原生校验气泡；保存时先过服务端 guard，命中红线的拒绝就地落 notice
            h('div', { className: 'so-grid so-g-2', style: { marginTop: 14 } },
              h('div', { className: 'so-field' }, h('label', null, '名称'),
                h('input', { ref: nameRef, className: 'so-input', type: 'text', placeholder: '例：pnpm 未引用包' })),
              h('div', { className: 'so-field' }, h('label', null, '路径 glob'),
                h('input', { ref: globRef, className: 'so-input so-input-mono', type: 'text', placeholder: '%LocalAppData%\\pnpm\\**' })),
              h('div', { className: 'so-field' }, h('label', null, '只清早于'),
                h('input', { ref: ageRef, className: 'so-input so-num', type: 'text', placeholder: '30 天未访问' })),
              h('div', { className: 'so-field' }, h('label', null, '类型'),
                h('input', { ref: kindRef, className: 'so-input', type: 'text', placeholder: '缓存 / 日志 / 旧版本' }))),
            h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', { type: 'button', className: 'so-btn so-btn-primary so-btn-sm', disabled: save.disabled, title: save.why || undefined, onClick: saveRule }, '保存并启用'),
              h('span', { className: 'so-hint' }, save.disabled ? save.why : '保存时先过 guard 校验，命中红线会直接拒绝写入。')),
            h(Notice, { tone: 'amber' },
              h('b', null, '不可移除的黑名单'),
              h('span', null, '（新增规则命中即拒绝）：'),
              redlines.length
                ? redlines.map((line, i) => h('span', { key: String(i), className: 'so-path' },
                    String((line && typeof line === 'object' && line.text) || line)))
                : h('span', null, '宿主未下发黑名单明细，判定仍以服务端 guard 为准。')))),
        // —— 暂存与默认方式：prefs 实配值 + 到期提醒不自动删 + after 两档 ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '暂存与默认方式')),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-grid so-g-2' },
              h('div', { className: 'so-field' }, h('label', null, '暂存目录'),
                h('span', { className: 'so-path' }, quarDir)),
              h('div', { className: 'so-field' }, h('label', null, '暂存保留'),
                h('span', { className: 'so-num' }, `${keepDays === null ? '—' : keepDays} 天（到期提醒，不自动删）`))),
            h('div', { className: 'so-field', style: { marginTop: 10 } }, h('label', null, '清理后动作'),
              h(Seg, { options: [{ v: 'none', t: '什么都不做' }, { v: 'log', t: '写一条留痕并刷新曲线' }], value: after,
                onChange: (v) => onPatch && onPatch({ clean: { after: v } }) })),
            h('div', { className: 'so-hint', style: { marginTop: 8 } }, '到期只提醒、不自动删：暂存件由你手动清空，插件不会替你删。'))),
        // —— 搜索通路：两字段（生效值 prefs.search，占位回落 defaults）+ 诚实降级说明 ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '搜索通路')),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-grid so-g-2' },
              h('div', { className: 'so-field' }, h('label', null, 'HTTP 端口'),
                h('input', { ref: portRef, className: 'so-input so-num', type: 'text', disabled: save.disabled,
                  defaultValue: portVal === null ? '' : String(portVal), placeholder: dfltPort === null ? '—' : String(dfltPort) })),
              h('div', { className: 'so-field' }, h('label', null, 'es.exe 路径'),
                h('input', { ref: esRef, className: 'so-input so-input-mono', type: 'text', disabled: save.disabled, defaultValue: esVal, placeholder: '（留空 = 用 PATH）' }))),
            h(Notice, { tone: 'gray' },
              '两条通路都探不到时自动降级为「限定目录」模式，并在搜索页顶部写明覆盖范围 —— 与股票插件「东财不通就标腾讯」是同一套诚实降级，不静默换源、不拿旧结果冒充。'))),
        // —— 宿主能力探测：五行只报事实，一律不给开关 ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '宿主能力探测'),
            h('span', { className: 'so-hsub' }, 'ctx.inject 实际拿到了什么')),
          h('div', { className: 'so-card-b' },
            capList.length ? capList.map((c) => h('div', { key: c.label, className: 'so-rule' },
              h('div', { className: 'so-ri' },
                h('div', { className: 'so-rn' }, c.label),
                c.detail ? h('div', { className: 'so-rd' }, c.detail) : null),
              h('span', { className: 'so-rt' }, h(Pill, { cls: c.cls }, c.value)))) : h('div', { className: 'so-empty' }, '宿主未下发能力表。'))),
        // —— 保存闸门：禁用一定伴随可见原因（不允许只变灰） ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-b', style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'so-btn so-btn-primary', disabled: save.disabled, onClick: saveSearch }, '保存设置'),
            h('span', { className: 'so-hint' }, save.disabled ? save.why : '保存只提交你改动过的字段（差量），其余保持服务端现值。'))));
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
      if (ev === 'alert-store') {
        // 落盘降级（lib/alerts/service.js:41/:48）：库不可用时命中仍评估，只是不写记录。
        // 不消费这条帧 = spec §7「降级必须看得见」破功（最终评审 Important-2）。
        const a = { ...(base.alerts || {}) };
        a.hitsError = (d && d.error) || '触发记录未落盘';
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
       * 写偏好：prefs domain 是**整条覆盖写**（lib/prefs/store.js:191 writeMany），
       * 所以先读回全量、只并进本次改动的组，再整条写回 —— 直接发半份会把别的组抹掉。
       * 读失败必须**阻断**：这时 merged 只剩本次那一组，整域写回会抹掉同域其它配置，
       * 且比不写更糟 —— 报错可见（约束 4），不静默重试。
       */
      async function writePrefsGroup(group, values) {
        const cur = await api('prefs');
        if (!cur.ok) { setPageErr({ source: 'prefs', ...(cur.error || { code: 'UNKNOWN', message: '接口调用失败' }) }); return cur; }
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

      // —— 清理页（Task 22）：勾选集 / 冻结清单 / 辅助数据 / 执行回执都上移在这里，
      //    CleanPage 自身零 useState（与 MonitorPage 同规）—— 换页/重采不打断渲染。
      const [cleanSel, setCleanSel] = useState(new Set());
      const [cleanPlan, setCleanPlan] = useState(null);   // 冻结清单实体（{planId, items, at, modeDefault, ...}）
      const [cleanAux, setCleanAux] = useState({ logs: [], unfinished: [], quar: null, rules: null, prefs: {} });
      const [cleanLast, setCleanLast] = useState(null);   // {planId, summary} → 「清单已失效」卡的数据源
      const cleanAppliedRef = useRef(null);               // 已执行的 planId：不让旧 clean:done 帧把它复活回清单卡
      const cleanPlanGetRef = useRef(null);               // 已按 GET /clean/plan 补拉过的 planId：同一 id 只补一次

      /**
       * 清理页辅助数据：留痕 / 未确认完成 / 暂存区 / 规则 / 偏好。
       * SSE 只覆盖扫描进度，这几样必须 GET 现读；任何一路失败都带 source 落可见 notice
       * （rules/prefs 的失败路由到「扫描范围」卡，见 CleanPage 的 errForScope）。
       */
      async function loadCleanAux() {
        const [logs, unf, quar, rules, prefs] = await Promise.all([
          api('clean/logs', { query: { limit: 50 } }),
          api('clean/unfinished'),
          api('quarantine'),
          api('rules'),
          api('prefs'),
        ]);
        const patch = {};
        if (logs.ok) patch.logs = Array.isArray(logs.data) ? logs.data : ((logs.data && logs.data.rows) || []);
        if (unf.ok) patch.unfinished = Array.isArray(unf.data) ? unf.data : [];
        if (quar.ok) patch.quar = quar.data && typeof quar.data === 'object' ? quar.data : null;
        if (rules.ok) patch.rules = rules.data && typeof rules.data === 'object' ? rules.data : null;
        if (prefs.ok) patch.prefs = (prefs.data && prefs.data.prefs) || {};
        setCleanAux((prev) => ({ ...prev, ...patch }));
        for (const pair of [['clean/logs', logs], ['clean/unfinished', unf], ['quarantine', quar], ['rules', rules], ['prefs', prefs]]) {
          if (!pair[1].ok) {
            setPageErr({ source: pair[0], ...((pair[1].error) || { code: 'UNKNOWN', message: '接口调用失败' }) });
            break; // 只报第一路：一次刷十几条红条不叫「可见」，叫噪音
          }
        }
      }

      async function doCleanScan() {
        setCleanLast(null);
        cleanAppliedRef.current = null;
        const r = await post('clean/scan');
        if (!r.ok) return;
        const d = r.data || {};
        if (d.busy) return; // 忙碌回执：扫描中卡已由 snap.clean 呈现，不另起一份
        if (d.plan && Array.isArray(d.plan.items)) { setCleanPlan(d.plan); setCleanSel(new Set()); }
        loadCleanAux();
      }
      const doCleanStop = () => { post('clean/scan/stop'); };
      const doCleanToggle = (id, on) => setCleanSel((prev) => {
        const n = new Set(prev);
        if (on) n.add(id); else n.delete(id);
        return n;
      });
      const doCleanSelectAll = () => setCleanSel(new Set(cleanPlan ? selectAllIds(cleanPlan) : []));
      const doCleanSelectNone = () => setCleanSel(new Set());
      async function doCleanApply(ids, mode) {
        if (!cleanPlan || !Array.isArray(ids) || ids.length === 0) return;
        // 页面唯一的写出口：请求体结构上只有三键（applyBody），路径永不来自前端
        const r = await post('clean/apply', applyBody(cleanPlan.planId, ids, mode));
        if (!r.ok) return;
        cleanAppliedRef.current = cleanPlan.planId;
        setCleanLast({ planId: cleanPlan.planId, summary: { at: Date.now(), ...(r.data || {}) } });
        setCleanPlan(null);
        setCleanSel(new Set());
        loadCleanAux();
      }

      // 进清理页 → 现读辅助数据（留痕/暂存/规则/偏好不在 SSE 帧里）
      useEffect(() => {
        if (tab !== 'clean') return;
        loadCleanAux();
      }, [tab]);

      /**
       * SSE 的 clean:done 帧带完整冻结清单（lib/clean/service.js:85 把 saved 并进帧里）。
       * POST /clean/scan 的响应通常已经接到同一份；这条 effect 兜住「扫描是别处发起的」场景。
       * 真机快照里 clean.plan 是 **planId 字符串**（lib/api.js:290），不是实体 —— 实体没落在帧里时
       * 按 GET /api/clean/plan?planId= 补一次（Ruling-98）；同一 planId 只补一次，
       * 已执行过的清单不复活。
       */
      useEffect(() => {
        const p = snap && snap.clean && snap.clean.plan;
        if (!p) return;
        if (typeof p === 'object' && Array.isArray(p.items)) {
          if (cleanAppliedRef.current === p.planId) return;
          setCleanPlan((prev) => (prev && prev.planId === p.planId ? prev : p));
          return;
        }
        if (typeof p !== 'string' || !p) return; // 快照里的 plan 键只认实体或 id 串两形态
        if (cleanAppliedRef.current === p) return; // 已执行过的清单不复活
        if (cleanPlanGetRef.current === p) return; // 同一 id 只补一次，不随每帧重发
        if (cleanPlan && cleanPlan.planId === p) return; // 实体已在场
        cleanPlanGetRef.current = p;
        api('clean/plan', { query: { planId: p } }).then((r) => {
          if (!r.ok) { setPageErr({ source: 'clean/plan', ...(r.error || { code: 'UNKNOWN', message: '接口调用失败' }) }); return; }
          const d = r.data || {};
          if (!Array.isArray(d.items)) {
            setPageErr({ source: 'clean/plan', code: 'BAD_PLAN', message: `清单 ${p} 的响应没有 items 数组，界面无清单可渲染` });
            return;
          }
          setCleanPlan((prev) => (prev && prev.planId === d.planId ? prev : d));
        });
      }, [snap]);

      // —— 搜索页（Task 23）：探针 / 结果 / 通路参数与目录覆盖范围都上移在容器，
      //    SearchPage 自身零 useState（与 CleanPage 同规）—— 换页与重采都不打断渲染。
      const [srchProbe, setSrchProbe] = useState(null);
      const [srchRes, setSrchRes] = useState(null);
      const [srchMode, setSrchMode] = useState('everything');
      const [srchLimit, setSrchLimit] = useState(LIMITS[1]);
      const [srchQ, setSrchQ] = useState('');
      const [srchDirs, setSrchDirs] = useState([]);

      /** 从 prefs 的 search 组取界面认得的形态：walkDirs 只认数组，mode 只认 everything/walk 两档。 */
      function searchFromPrefs(prefsRow) {
        const s = (prefsRow || {}).search || {};
        return {
          dirs: Array.isArray(s.walkDirs) ? s.walkDirs.map((d) => String(d)) : [],
          mode: s.mode === 'walk' ? 'walk' : 'everything',
          limit: LIMITS.indexOf(num(s.limit)) >= 0 ? s.limit : LIMITS[1],
        };
      }

      /**
       * 进搜索页现读两样：ProbeResult 与 prefs.search（覆盖范围与通路参数都不在 SSE 帧里）。
       * 任一路失败落可见错误并带 source（约束 4）；探测失败**不改**已有探针数据 ——
       * 拿着 null 探针渲染就是「假装已经探测过」，宁可让页面显示未检测。
       */
      async function loadSearchAux() {
        const [pr, pf] = await Promise.all([api('search/probe'), api('prefs')]);
        if (pr.ok) setSrchProbe(pr.data && typeof pr.data === 'object' ? pr.data : null);
        if (pf.ok) {
          const got = searchFromPrefs((pf.data || {}).prefs);
          setSrchDirs(got.dirs); setSrchMode(got.mode); setSrchLimit(got.limit);
        }
        for (const pair of [['search/probe', pr], ['prefs', pf]]) {
          if (!pair[1].ok) { setPageErr({ source: pair[0], ...(pair[1].error || { code: 'UNKNOWN', message: '接口调用失败' }) }); break; }
        }
      }

      /**
       * 一次查询只走一条通路（宿主 service.js 决定，界面不预判）。
       * 空 q 由 searchQuery 归成 null：不发请求，也不把上一条结果留在表上冒充新结果 ——
       * 清空回「还没有查询」的空态才是实情（pg3-11 的纯函数口径在容器这侧的落点）。
       */
      async function doSearch(q) {
        const arg = searchQuery({ q, mode: srchMode, limit: srchLimit });
        if (!arg) { setSrchQ(''); setSrchRes(null); return undefined; }
        setSrchQ(arg.q);
        const r = await api('search', { query: arg });
        if (!r.ok) { setPageErr({ source: 'search', ...(r.error || { code: 'UNKNOWN', message: '接口调用失败' }) }); return r; }
        setSrchRes(r.data && typeof r.data === 'object' ? r.data : null);
        return r;
      }
      async function doSearchReprobe() {
        const r = await post('search/reprobe', {});
        if (r.ok) setSrchProbe(r.data && typeof r.data === 'object' ? r.data : null);
        return r;
      }
      /** 目录覆盖范围写 prefs.search.walkDirs（整域写回的风险由 writePrefsGroup 的读-并-写兜住）。 */
      async function doSearchDirs(next) {
        const r = await writePrefsGroup('search', { walkDirs: next });
        if (!r.ok) return r;
        // 以宿主写回后的那一份为准（POST /api/prefs 回 readAll，lib/api.js:354）；宿主没给才回落本次期望值
        const got = searchFromPrefs((r.data || {}).prefs);
        setSrchDirs(Array.isArray(((r.data || {}).prefs || {}).search || {}).walkDirs ? got.dirs : next);
        return r;
      }
      const doSearchAddDir = (d) => {
        const cur = Array.isArray(srchDirs) ? srchDirs : [];
        // 已在覆盖范围里就不写：重复一条 chips 会画两个，写两次也只是把同一份数据再抹一遍
        if (cur.indexOf(d) >= 0) return Promise.resolve({ ok: true, data: null });
        return doSearchDirs(cur.concat([d]));
      };
      const doSearchDelDir = (d) => doSearchDirs((Array.isArray(srchDirs) ? srchDirs : []).filter((x) => x !== d));

      // —— 设置页（Task 24）：prefs / 合并后的清理规则行 / saving 都上移在容器，
      //    SettingsPage 自身零 useState（与其余三页同规）。
      const [setPrefs, setSetPrefs] = useState(null);
      const [setRules, setSetRules] = useState([]);
      // 本机规则计数槽（复评 N-F1）：不进合并行的内置行不计入本机条数；null=读不到、未确认标记=非数组、[]/数组=如实
      const [userRules, setUserRules] = useState(null);
      const [setSaving, setSetSaving] = useState(false);

      /**
       * 进设置页现读 prefs 与规则：偏好与规则都不在 SSE 帧里。
       * 规则行 = 宿主 GET /api/rules 交出的内置行（row.builtin）+ 本机行（row.items）合并 ——
       * 「内置/本机」标记**由宿主按 BUILTIN_RULES id 集合单点裁决**（Ruling-106），页面只拼接渲染，
       * 不自己按 id 前缀判、也不再读永不存在 cfg().builtinRules。
       * `guardDenied` 是**纯渲染**分支：全仓（lib/ + index.js）当前没有任何生产者 —— 命中红线的规则
       * 在写入阶段就被 rules-store 以 403 拒掉、扫到的受保护目录进 scanner 的 skipped（Ruling-94）。
       * 保留分支是为了页面永不自己裁决红线（约束 5 单点）；真实拒绝路径是 403 响应体与 skipped 列表。
       */
      async function loadSettingsAux() {
        const [pf, rl] = await Promise.all([api('prefs'), api('rules')]);
        const patch = {};
        if (pf.ok) patch.prefs = (pf.data && pf.data.prefs) || {};
        setSetPrefs(patch.prefs || {});
        const row = rl.ok && rl.data && typeof rl.data === 'object' ? rl.data : null;
        if (row) {
          const builtin = Array.isArray(row.builtin) ? row.builtin : [];
          const user = Array.isArray(row.items) ? row.items : [];
          const merged = builtin.concat(user);
          setSetRules(merged);
          // 计数只吃本机那一份（内置行不进），宿主没标 builtin 的行让整槽落未确认（复评 N-F1）
          setUserRules(userRuleSlot(merged));
        } else {
          // 规则接口读不到：计数不猜数字，回落到「本机尚未写入清理规则」的未确认/未写入态
          setUserRules(null);
        }
        for (const pair of [['prefs', pf], ['rules', rl]]) {
          if (!pair[1].ok) { setPageErr({ source: pair[0], ...(pair[1].error || { code: 'UNKNOWN', message: '接口调用失败' }) }); break; }
        }
      }

      /** 读-并-写偏好（Ruling-105）：prefs 是单行整记录（lib/prefs/store.js 的 writeMany 整行覆盖），
       *  差量直写会抹掉其余分组。故：先「现读」全量（绝不拿缓存 setPrefs 当读的那一份），
       *  读失败立即短路可见、不发写；按组浅合并后把完整记录 POST 回去，成功后以回的全量刷新界面。 */
      async function doSettingsPatch(patch) {
        setSetSaving(true);
        const cur = await api('prefs');
        if (!cur.ok) {
          setSetSaving(false);
          setPageErr({ source: 'prefs', ...(cur.error || { code: 'UNKNOWN', message: '接口调用失败' }) });
          return cur;
        }
        const base = (cur.data && cur.data.prefs) || {};
        const merged = { ...base };
        for (const group of Object.keys(patch || {})) {
          const values = patch[group] && typeof patch[group] === 'object' ? patch[group] : {};
          merged[group] = { ...(base[group] && typeof base[group] === 'object' ? base[group] : {}), ...values };
        }
        const r = await post('prefs', patchBody(merged));
        setSetSaving(false);
        if (r.ok) setSetPrefs((r.data && r.data.prefs) || {});
        return r;
      }
      /** 保存设置按钮（搜索通路两字段，brief 任务24 :170）：先本地校验端口，非法即见、零写入；
       *  合法则走 doSettingsPatch 的读-并-写（Ruling-105），成功后整页重载（prefs+rules 现读刷新）。 */
      async function doSettingsSave(fields) {
        const f = fields && typeof fields === 'object' ? fields : {};
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(f, 'port')) {
          const port = Number(f.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            setPageErr({ source: 'prefs', code: 'SEARCH_PORT_BAD', message: 'HTTP 端口需为 1-65535 之间的整数；本次未写入任何修改。' });
            return { ok: false };
          }
          patch.port = port;
        }
        if (Object.prototype.hasOwnProperty.call(f, 'esPath')) patch.esPath = String(f.esPath || '');
        if (Object.keys(patch).length === 0) { await loadSettingsAux(); return { ok: true }; }
        const r = await doSettingsPatch({ search: patch });
        if (r.ok) await loadSettingsAux();
        return r;
      }
      async function doSettingsRuleAdd(rule) {
        setSetSaving(true);
        const r = await api('rules/add', { method: 'POST', body: rule });
        setSetSaving(false);
        if (r.ok) loadSettingsAux();
        else setPageErr({ source: 'rules/add', ...(r.error || { code: 'UNKNOWN', message: '接口调用失败' }) });
        return r;
      }
      async function doSettingsRuleToggle(id, on) {
        const r = await api('rules/toggle', { method: 'POST', body: { id, on } });
        if (r.ok) setSetRules((prev) => prev.map((x) => (x.id === id ? { ...x, enabled: Boolean(on) } : x)));
        else setPageErr({ source: 'rules/toggle', ...(r.error || { code: 'UNKNOWN', message: '接口调用失败' }) });
        return r;
      }
      async function doSettingsRuleRemove(id) {
        const r = await api('rules/remove', { method: 'POST', body: { id } });
        if (r.ok) loadSettingsAux();
        else setPageErr({ source: 'rules/remove', ...(r.error || { code: 'UNKNOWN', message: '接口调用失败' }) });
        return r;
      }

      // 进搜索/设置页 → 现读（这两页的数据都不在 SSE 帧里）；离开不清，回来再补
      useEffect(() => {
        if (tab !== 'search') return undefined;
        loadSearchAux();
        return undefined;
      }, [tab]);

      useEffect(() => {
        if (tab !== 'settings') return undefined;
        loadSettingsAux();
        return undefined;
      }, [tab]);

      // 连接层：SSE → 断线退避 1s/2s/4s/8s/30s 封顶 → 连续失败落轮询 2s（spec §3.1）
      useEffect(() => {
        let alive = true;
        let napTimer = null;
        let pollTimer = null;
        const DELAYS = [1000, 2000, 4000, 8000, 30000];
        let fails = 0;
        // D-I-3：SSE 的 fetch 没有 EventSource 的自动关流，卸载时必须用 AbortController
        // 掐掉 /stream —— 否则消费循环挂在 await 上，连接悬挂到服务端超时为止。
        const ctrl = new AbortController();

        const sleep = (ms) => new Promise((r) => { napTimer = setTimeout(r, ms); });

        /**
         * 只补一份快照，**绝不改 link**：SSE 活着时的 collect:refresh / 回可见补拉走这里，
         * 若顺手 setLink('polling') 会把「降级：轮询 2s」钉在通道指示上（D-I-1 假降级）。
         * 换通道态只归 runPolling 一处。
         */
        async function fetchSnapshot() {
          const r = await api('snapshot');
          if (!alive) return;
          if (r.ok) { setSnap(() => r.data); }
          else setPageErr(r.error); // 补拉也失败：可见，不静默
        }
        async function runPolling() {
          setLink('polling'); // 真降级：SSE 连续失败 3 次才走到这里，通道态只在此处换
          while (alive) {
            if (typeof document === 'undefined' || !document.hidden) await fetchSnapshot();
            await new Promise((r) => { pollTimer = setTimeout(r, 2000); });
          }
        }
        async function streamLoop() {
          while (alive) {
            try {
              const res = await fetch(API_BASE() + '/stream', { signal: ctrl.signal });
              if (!res.ok || !res.body) throw new Error('推送通道握手失败（HTTP ' + (res && res.status) + '）');
              setLink('sse');
              fails = 0;
              await consumeSse(res, (ev, d) => {
                if (!alive) return;
                if (ev === 'collect:refresh') { fetchSnapshot(); return; } // 重采完成帧：只补快照，通道仍是 SSE
                setSnap((prev) => mergeFrame(prev, ev, d));
              });
              if (!alive) return;
            } catch (e) {
              if (!alive || ctrl.signal.aborted) return; // 卸载关流：不算断线，不再重连/报错
              if (String((e && e.name) || '') === 'AbortError') return;
            }
            setLink('reconnecting');
            fails += 1;
            await sleep(DELAYS[Math.min(fails - 1, DELAYS.length - 1)]);
            if (!alive) return;
            if (fails >= 3) { await runPolling(); return; }
          }
        }
        streamLoop();

        // 页面隐藏 → 停轮询并告诉服务端（这正是驱动 L1b 停采的那一路）；回来再补一次快照
        const onVis = () => {
          const visible = !(typeof document !== 'undefined' && document.hidden);
          api('collect/visibility', { method: 'POST', body: { visible } }).then((r) => {
            if (!r.ok && alive) setPageErr(r.error);
          });
          if (visible && alive) fetchSnapshot();
        };
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          document.addEventListener('visibilitychange', onVis);
        }
        return () => {
          alive = false;
          ctrl.abort(); // 关流：读循环与连接一起断，卸载不留悬挂请求
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
        tab === 'clean' && h(pages.CleanPage, {
          clean: (snap && snap.clean) || {}, plan: cleanPlan,
          logs: cleanAux.logs, unfinished: cleanAux.unfinished, quar: cleanAux.quar,
          rules: cleanAux.rules, prefs: cleanAux.prefs, caps: cfg().capabilities || {},
          link, sel: cleanSel, err: pageErr,
          lastSummary: cleanLast && cleanLast.summary ? { planId: cleanLast.planId, ...cleanLast.summary } : null,
          onScan: doCleanScan, onStopScan: doCleanStop, onToggle: doCleanToggle,
          onSelectAll: doCleanSelectAll, onSelectNone: doCleanSelectNone,
          onApply: doCleanApply, onQuarantine: (ids) => doCleanApply(ids, 'move-to-quarantine'),
        }),
        tab === 'search' && h(pages.SearchPage, {
          probe: srchProbe, res: srchRes, mode: srchMode, limit: srchLimit, q: srchQ, dirs: srchDirs,
          err: pageErr,
          onSearch: doSearch, onMode: setSrchMode, onLimit: setSrchLimit, onReprobe: doSearchReprobe,
          onAddDir: doSearchAddDir, onDelDir: doSearchDelDir,
        }),
        tab === 'settings' && h(pages.SettingsPage, {
          prefs: setPrefs || {}, rules: setRules, userRules, caps: cfg().capabilities || {},
          capRows: cfg().capabilityRows || [], snap, err: pageErr, saving: setSaving,
          onPatch: doSettingsPatch, onRuleAdd: doSettingsRuleAdd, onRuleToggle: doSettingsRuleToggle,
          onRuleRemove: doSettingsRuleRemove, onSave: doSettingsSave,
        }),
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
    exports.__test = { cfg, consumeSse, api, fmtBytes, fmtRate, fmtPct, fmtAge, stateClass, sourcePill, nav, pages, mergeFrame,
      monitor: { MonitorPage, mtrRows, srcCells, curveSpec, band, sparkPoints },
      clean: { CleanPage, PLAN_COLS, scanCells, planRows, selTotals, selectAllIds, applyBody, logRow, quarantineText },
      search: { SearchPage, PROBE_ROWS, LIMITS, probeCells, modeOf, resultHead, rowCells, advice, searchQuery },
      settings: { SettingsPage, SOURCE_ROWS, ruleCells, ruleStateText, patchBody, capCells, SAVE_DISABLED, capsReadOnly }, };
    return module.exports;
  },
});
