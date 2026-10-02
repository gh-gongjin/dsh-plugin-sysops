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
//   · 交互一律自研控件（按钮 / 开关 / 分段器），不画浮层提示条 —— 唯一例外：清理页的分类下拉
//     用原生 select（S19-① 用户点名「使用下拉选择」；它弹出的是浏览器自己的控件层，不是本插件画的浮条）。
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
  /* 宿主主列 centerCol 是 overflow:hidden（dsh-client-ui-layout/AppFrame.module.css 的 .centerCol），
     插件内容超高会被直接裁掉、页面滚不动 → 滚动必须由根容器自己兜住。同仓 dsh-plugin-stock-analysis
     的 .sa-root 就是为这件事加的同一款兜底。 */
  max-height:100vh;overflow-y:auto;
}
.so-root *{box-sizing:border-box}
.so-num,.so-root .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.so-root svg{display:block}
/* 裸 button 只清 UA 的字体/指针。不变式是**这条清零规则自身的特异性必须低于一切控件类**：
   :where() 贡献 0 特异性，故 :where(.so-root) button = (0,0,1)，输给 .so-btn / .so-btn-primary /
   .so-btn-sm / .so-check / .so-tab 的 (0,1,0) —— 它们才能在 background、color、font-size、
   border、padding 上**全属性**胜出。若写回 .so-root button（(0,1,1)）就会反过来压住控件类：
   先是 background 被吃 → 只有 :hover 一档（(0,2,0)）还生效，「鼠标一移上去 primary 突然变黑」；
   只删 background 而后留下 color:inherit，主按钮那档就退化成深底+继承来的深色字，
   也就是「常驻黑块、文字看不见」。要清零的控件各自在自己的类里写（.so-tab / .so-seg button / .so-switch）。 */
:where(.so-root) button{font:inherit;color:inherit;cursor:pointer}
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
/* 卡间距只由「面板的直接子级」这条关系定，两种失效模式都出自旧的 .so-card+.so-card：
   ① 网格（.so-charts）里的卡也是兄弟卡，那条 14px 会漏进去——同排第 2/4 张被 margin 压下 14px
      又被 align-items:stretch 压矮 14px（真机反馈「这两个边框高度不一样」）；
   ② 卡前面不是卡时（曲线网格、提示行）旧规则给不出间距，卡与上一块贴边。
   改挂 .so-tabpanel>*+.so-card 后：网格子级不在选择器里，两种毛病一起消失。 */
.so-tabpanel>*+.so-card{margin-top:14px}
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
/* 执行进度（S11-②）：条宽跟着 clean:item 帧走，transition 让每一步都有可见的移动；
   左侧圆点在 running 时脉冲，结束（含失败）后停住 —— 不看数字也知道「还在动 / 已经停了」。 */
.so-track>i{transition:width .25s ease}
.so-run{margin-top:10px;padding:10px 12px;border:1px solid var(--so-bd);border-radius:8px;background:var(--so-soft)}
/* 面板底就是 --so-soft：槽再取 --so-soft 就看不见，截图里只剩一条黑线（S11 截图核对时发现）。槽深一档、加粗 1px。 */
.so-run .so-track{height:4px;background:var(--so-bd2)}
.so-run-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--so-t2)}
.so-run-dot{width:7px;height:7px;border-radius:50%;background:var(--so-bd2);flex:0 0 auto}
.so-run.is-running .so-run-dot{background:var(--so-down);animation:so-pulse .9s ease-in-out infinite}
.so-run.is-done .so-run-dot{background:var(--so-t1)}
@keyframes so-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(1.6)}}
.so-run-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--so-t2)}
.so-run-list li{display:flex;align-items:center;gap:7px;min-width:0}
.so-run-list .so-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
/* 曲线悬停读数（S15）：引导线留在 SVG 里，圆环与气泡是**卡内** HTML 元素。
   为什么把文字和圆点搬出 SVG —— 本卡 svg 是 preserveAspectRatio="none"（viewBox 340×92 拉到 ~540px 宽），
   画在里面的 <text> 与 <circle> 会被横向拉伸 1.6 倍：字发胖、点变椭圆，这正是真机批「太丑」的根因。
   两者都只在这张卡内出现（.so-curve 是本卡的定位父级），不是浮层提示条（§4 禁令）。
   气泡的横向朝向由 tipLayout 给（点在哪半边就朝里长），类里不写 transform，免得两处各写一份互相压。
   引导线 S16-① 由「3 3 虚线 + .45」改成**实心细线 + .28**：真机批「虚线样式不好看」。虚线本身不是问题，
   问题是这张图里已经有一条虚线了 —— 阈值线也是 3 3 虚线（.so-spark 里的 th 那条），引导线用同一套虚线
   还压在它上面，两条不同含义的线在视觉上成了同一类东西，交点处糊成一片。含义不同的线该用**虚实**区分，
   而不是靠粗细与颜色。 */
.so-curve{position:relative}
.so-tip-line{stroke-width:1;opacity:.28}
.so-tip-ring{position:absolute;transform:translate(-50%,-50%);width:11px;height:11px;box-sizing:border-box;border-radius:50%;background:var(--so-bg);border:2px solid var(--so-t1);pointer-events:none}
.so-tip-box{position:absolute;top:1px;display:inline-flex;align-items:baseline;gap:6px;padding:3px 9px;border:1px solid var(--so-bd2);border-radius:8px;background:var(--so-bg);box-shadow:0 1px 3px rgba(0,0,0,.09);font-size:11.5px;line-height:1.35;color:var(--so-t1);white-space:nowrap;pointer-events:none}
.so-tip-box b{font-weight:600;font-variant-numeric:tabular-nums}
.so-tip-box .so-tip-t{color:var(--so-t3);font-variant-numeric:tabular-nums}
.so-tblwrap{overflow-x:auto}
/* S10-②：清理清单限高在卡内滚动（真机批注「滚动只在这个框内，不要整个屏滚动」）。
   507 项时整页要滚好几屏，限高 + 表头吸顶把滚动关进这个框里；操作条当时仍留在框下方，
   S19-② 真机批「不要放在最下面，放在上面」，整条才挪到卡头正下方。限高当时只给清理清单这一张表；S18-③ 把同一口径搬到进程榜（见 .so-tblwrap-proc），搜索表仍未限高。 */
.so-tblwrap-plan{max-height:clamp(240px,52vh,480px);overflow:auto}
.so-tblwrap-plan .so-tbl thead th{position:sticky;top:0;z-index:1}
/* S18-③（真机批注「进程采集列表不要整页滚动，只在框内滚动」）：进程榜最多 400 行，
   不限高就把曲线卡与源条顶出屏幕、且整页要滚好几屏。限高比清理清单矮一档 —— 这一页还要留
   四张曲线卡的可见性。滚动容器独立在这一层 wrapper 上（S16 教训：跟 overflow-x 挤在同一层
   会把 sticky 表头顶歪）。 */
.so-tblwrap-proc{max-height:clamp(220px,42vh,400px);overflow:auto}
.so-tblwrap-proc .so-tbl thead th{position:sticky;top:0;z-index:1}
/* 可排序表头：按钮铺满整格，点哪都算点这一列；aria-sort 挂在 th 上（ARIA 规定的位置）。
   这段在 CSS 模板字符串里，注释不许出现反引号 —— 出现就是把样式表从中间截断。 */
.so-tbl th.so-th-sort{padding:0}
.so-th-btn{display:flex;align-items:center;justify-content:flex-end;gap:4px;width:100%;padding:7px 10px;background:none;border:0;font:inherit;font-size:11.5px;color:inherit;text-align:right;white-space:nowrap}
.so-th-btn:hover{color:var(--so-t1)}
.so-th-btn.is-on{color:var(--so-t1);font-weight:600}
.so-th-i{font-size:10px;line-height:1}
/* S12-A 容量概览条：清理页顶上一行「系统盘现在可用多少 / 这份清单能腾出多少」。
   数据只有两个来源（监控快照的 C 盘读数、冻结清单的 beforeFree 与条目大小），页面不自算容量。 */
.so-disk{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;padding:9px 12px;border:1px solid var(--so-bd);border-radius:8px;background:var(--so-soft);font-size:12px;color:var(--so-t2)}
.so-disk b{font-weight:600;color:var(--so-t1);font-variant-numeric:tabular-nums}
.so-disk .so-track{flex:1 1 110px;min-width:80px;height:4px;background:var(--so-bd2)}
/* S12-A 的分类读数在 S19-① 收成一枚下拉（真机批注「这些不要放在这里，放在全部分类那里使用下拉选择」）：
   六颗 chip 在 4709 项那一屏摊成五行高，把清单表本身顶到第二屏。收成一行 ≠ 删掉：
   每个 option 里仍是「类名 · 项数 · 大小 · 三档」，读数一个字都不丢，只是从常驻可见变成点开可见。
   这里用原生 select：它弹出那层是浏览器自己的控件，不是本插件画的浮层提示条（§4 禁的是后者）。
   max-width:100% 夹一道，长类名不把整行撑破（超宽由控件自己省略号截断）。 */
.so-catbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.so-cat-lb{font-size:11.5px;color:var(--so-t3)}
.so-cat-select{max-width:100%;padding:5px 8px;border:1px solid var(--so-bd);border-radius:8px;background:var(--so-bg);font-size:11.5px;color:var(--so-t1);font-variant-numeric:tabular-nums}
/* 操作条（S19-② 从卡尾移到卡头正下方）：与原型 .tot 同形 —— 卡内一圈 14px 的独立框，
   读数在左、两颗写按钮贴右（.so-grow 靠 margin-left:auto 推过去，同原型 .tot .grow）。
   S20（真机批注「这些不要了」）：条上那三句说明删净，这里只剩「读数 + 按钮」，
   原先给 modeDefault 那句的 flex:1 0 100%（另起一行待在框底）随之删掉。 */
.so-tot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px;padding:12px 14px;border:1px solid var(--so-bd2);border-radius:10px;background:var(--so-soft)}
.so-tot .so-sum{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}
.so-tot .so-grow{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* S12-A 问题①「到底扫了哪些目录」：扫描范围卡里逐条列出内置规则指向的目录。
   只出宿主给的公开字段（n/kind/ageDays/rel），rel 是相对用户目录的段串，页面不拼绝对路径。 */
.so-scope{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:3px 14px;margin-top:10px}
.so-scope-row{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11.5px;color:var(--so-t2)}
.so-scope-row>b{font-weight:500;color:var(--so-t1);flex:0 0 auto}
.so-scope-row .so-path{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.so-scope-row .so-when{flex:0 0 auto;color:var(--so-t3);font-variant-numeric:tabular-nums}
/* S12-③ AI 智能清理：卡头那颗按钮 + 就地展开的建议面板（spec §4 零浮层，所以是卡内块不是弹层）。
   面板只做"推荐 + 并进勾选"，没有任何删除入口；文案里那句"不删除任何东西"是行为，不是修饰。 */
.so-ask-btn{display:inline-flex;align-items:center;gap:8px;flex:0 0 auto}
.so-ai{border-top:1px solid var(--so-bd)}
.so-aihead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--so-t2)}
.so-aihead b{font-size:12.5px;font-weight:600;color:var(--so-t1)}
.so-ai.is-running .so-run-dot{background:var(--so-down);animation:so-pulse .9s ease-in-out infinite}
.so-ailist{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.so-airow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border:1px solid var(--so-bd);border-radius:8px;background:var(--so-bg);font-size:12px;color:var(--so-t2)}
.so-airow .so-ainame{font-weight:500;color:var(--so-t1)}
.so-airow .so-aireason{flex:1 1 100%;color:var(--so-t3);font-size:11.5px;line-height:1.6}
.so-airow>.so-hint{font-variant-numeric:tabular-nums}
/* S12-④ 搜索页写偏好（覆盖目录 / 通路 / 上限）的就地交代行：点一下必须有一句话说清存没存进去，
   零浮层规（spec §4）下它是卡内的一行字，不是弹层，也不会跟着 SSE 帧自己消失。 */
.so-savenote{margin-top:7px;font-size:12px;line-height:1.6}
.so-savenote-ok{color:var(--so-down)}
.so-savenote-bad{color:var(--so-red)}
table.so-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.so-tbl th{background:var(--so-soft);color:var(--so-t3);font-weight:500;font-size:11.5px;text-align:left;padding:7px 10px;border-bottom:1px solid var(--so-bd);white-space:nowrap}
.so-tbl td{padding:8px 10px;border-bottom:1px solid var(--so-bd);vertical-align:middle}
.so-tbl tbody tr:hover td{background:var(--so-hover)}
/* 数值列（PID / CPU% / 大小 / 最后访问 / 修改时间）一律单行：路径列按上面那条 nowrap 撑住最小宽度后，
   自动布局会把富余从数值列抠走，「656 MB」折成两行、「1051 天前」把「前」字甩到下一行（S14，真机截图未决项）。
   中文那两列（命中规则 / 风险说明）仍可折行吸收挤压，所以表格不会因此横向滚动；真会溢出时外层 .so-tblwrap 横向滚。 */
.so-tbl .so-r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.so-tbl .so-c{text-align:center;width:34px}
.so-tbl .so-tr-name{font-weight:500}
.so-check{width:15px;height:15px;border-radius:4px;border:1px solid var(--so-bd2);background:var(--so-bg);display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:11px;line-height:1;color:var(--so-bg)}
.so-check[aria-checked="true"]{background:var(--so-t1);border-color:var(--so-t1)}
.so-check[aria-checked="mixed"]{background:var(--so-soft);border-color:var(--so-bd2);color:var(--so-t2)}
.so-check:disabled{background:var(--so-soft);border-color:var(--so-bd);cursor:not-allowed;color:var(--so-t3)}
.so-logrow{padding:10px 14px;border-bottom:1px solid var(--so-bd);font-size:12.5px}
.so-logrow:last-child{border-bottom:none}
.so-logrow>summary{cursor:pointer;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.so-logrow .so-snap{margin-top:6px;color:var(--so-t2);font-size:12px}
/* S12-① 留痕面板：滚动只发生在这一个限高框内（S10 那条「不要整个屏滚动」的口径同规沿用）。 */
.so-logpanel{max-height:340px;overflow-y:auto;overscroll-behavior:contain;border-top:1px solid var(--so-bd)}
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
.so-switch{width:34px;height:19px;border-radius:10px;background:var(--so-bd2);border:none;position:relative;transition:background .16s;flex:0 0 34px;display:inline-block;padding:0}
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
/* 页头「清理留痕」是个开关而不是动作：展开态必须有视觉差别，否则用户看不出刚点开了什么。 */
.so-btn.is-open{background:var(--so-soft);border-color:var(--so-bd2)}
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
/* S16-④：监控记录限高在卡内滚动（真机批注与 S10-② 清单表同一句：「只在当前框内滚动，不要整页滚动」）。
   29 条记录时整页要滚两屏，页签与卡头都被顶出视野。
   滚动容器**单独套一层**，不加在 .so-tl 身上：.so-tl 的竖线 ::before 是绝对定位、跟着内容一起滚，
   把它自己变成滚动容器就等于把竖线钉在可视框上 —— 滚到第 10 条时竖线还在原地，与圆点脱节。
   限高口径照 .so-tblwrap-plan / .logpanel，contain 防滚轮把外层页面一起带走。 */
.so-tlwrap{max-height:clamp(240px,52vh,480px);overflow:auto;overscroll-behavior:contain}
.so-tl{position:relative;padding-left:16px}
.so-tl::before{content:"";position:absolute;left:4px;top:6px;bottom:6px;width:1px;background:var(--so-bd)}
.so-tl-item{position:relative;padding:7px 0}
.so-tl-item::before{content:"";position:absolute;left:-16px;top:13px;width:7px;height:7px;border-radius:50%;background:var(--so-bg);border:1.5px solid var(--so-bd2)}
.so-tl-item.so-tl-hit::before{border-color:var(--so-up);background:var(--so-up)}
.so-tl-item.so-tl-op::before{border-color:var(--so-blue);background:var(--so-blue)}
.so-tl-item .so-tt{color:var(--so-t2);font-size:12px;font-weight:500}
/* 绝对时刻 + 相对时间并列（S15-②）：只有「21 小时前」看不出到底是哪天炸的，23 条挤在一起更分不清批次。 */
.so-tl-item .so-tt .so-tl-ago{color:var(--so-t3);font-weight:400;margin-left:6px}
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
     * 网速换算的**唯一一处**：字节/秒 → { n: 数值文案, u: 单位 }，**十进制**自适应（B/s / KB/s / MB/s / GB/s）。
     * S16-② 换掉了原来的「固定 v / 1e6 出 MB/s」：真机 latest.netDown 实测 7030 B/s（≈ 7 KB/s），
     * 除以 1e6 再 toFixed(1) 恒等于 "0.0" —— 采集每秒都在动、界面读成不动，这就是用户批的
     * 「网络吞吐数据不变化」。取证见 tmp/probe-net.mjs → tmp/s16-net.txt（series.netDown n=544，间隔中位数 1015ms）。
     * 单位必须跟着数值走：卡面把数字与单位分开渲染（.so-curve-v 里的 small），所以这里交两段，
     * 调用方不许再 split(' ')[0] 然后自己硬写单位 —— 上一版正是那样把 KB/s 标成了 MB/s。
     * **档位与 fmtBytes / capText 不同**：容量走 1024（对齐资源管理器的「属性」页），
     * 速率走 1000（PDH 的 Bytes/sec、网卡与下载器都是十进制口径，pg1-2 钉的 12 500 000 → 12.5 MB/s 就是这条）。
     * 位数口径照 fmtBytes：≥100 取整、≥10 一位、否则两位。
     * L1a 的 v 是字节/秒；原型曲线里的 /8 是按 bit 演示的假数据，运行时代码不许照抄（pg1-2 钉住这条）。
     */
    function rateParts(bytesPerSec) {
      const v = num(bytesPerSec);
      if (v === null) return { n: '—', u: '' };
      if (Math.abs(v) < 1000) return { n: String(Math.round(v)), u: 'B/s' };
      const u = ['KB/s', 'MB/s', 'GB/s'];
      let i = -1;
      let x = v;
      do { x /= 1000; i += 1; } while (x >= 1000 && i < u.length - 1);
      return { n: x >= 100 ? x.toFixed(0) : x.toFixed(x >= 10 ? 1 : 2), u: u[i] };
    }

    /** 网速的一行文案：悬停读数、上行注脚、命中正文共用（单位与数字同源，见 rateParts）。 */
    function fmtRate(bytesPerSec) {
      const p = rateParts(bytesPerSec);
      return p.u ? p.n + ' ' + p.u : p.n;
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

    /**
     * 页签表：label 与已确认原型逐字一致（cf-6）。S15-②：监控记录从监控页底部搬出来独立成页。
     * S16-③ 页签改叫「监控记录」：**只改 label，不改 key** —— `alerts` 是宿主路由、SSE 事件名与
     * 存储域用的键，跟着界面文案一起改会把一次改名扩散成跨半边的重命名（改名不该动数据）。
     */
    const nav = [
      { k: 'monitor', t: '资源监控' },
      { k: 'alerts', t: '监控记录' },
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

    /** 磁盘分档阈值只许一处（S12-A）：监控页的「C 盘可用」格与清理页的概览条共用这一份，改一处就是两处颜色打架。 */
    const DISK_BAND = { warn: 85, crit: 92 };

    /** 四指标行：顺序与 n 逐字固定（pg1-1）；快照没有的数字不显示、更不硬算（pg1-4）。 */
    function mtrRows(snap) {
      const l = (snap && snap.latest) || {};
      const s = (snap && snap.series) || {};
      const cpu = num(l.cpu), mem = num(l.mem);
      const total = num(l.diskTotalGb), free = num(l.diskFreeGb);
      const usedPct = total && free !== null ? Math.round((1 - free / total) * 1000) / 10 : null;
      const net = rateParts(num(l.netDown));   // 数值与单位一起出，见 rateParts（S16-②）
      return [
        { key: 'cpu', n: 'CPU 使用率', v: cpu === null ? '—' : cpu.toFixed(0), u: '%',
          c: `档位 ${snap.cadence} · 峰值 ${fmtPct(peak(s.cpu), 0)} · 阈值线 85%`, pct: cpu, cls: band(cpu, 70, 85) },
        { key: 'mem', n: '内存', v: mem === null ? '—' : mem.toFixed(1), u: '%',
          c: `峰值 ${fmtPct(peak(s.mem), 0)} · 保留 ${snap.keepMinutes}min`, pct: mem, cls: band(mem, 75, 85) },
        { key: 'disk', n: 'C 盘可用', v: free === null ? '—' : free.toFixed(1), u: 'GB',
          c: usedPct === null ? '总容量未知（statfs 未返回）' : `已用 ${usedPct.toFixed(1)}% · 总 ${total.toFixed(1)} GB`,
          pct: usedPct, cls: usedPct === null ? '' : band(usedPct, DISK_BAND.warn, DISK_BAND.crit) },
        { key: 'net', n: '网络吞吐', v: net.n, u: net.u,
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

    /** 曲线点里有效的那批（保序、保 {t,v}）；画线与读数共用同一份来源，免得"读到的点不是画出的点"。 */
    function seriesVals(points) {
      const out = [];
      for (const p of (Array.isArray(points) ? points : [])) if (num(p && p.v) !== null) out.push(p);
      return out;
    }

    /** 第 i 个点（共 n 个）在画布上的坐标；sparkPoints 与悬停读数共用这一处映射。 */
    function pointXY(i, n, v, max, W = CHART_W, H = CHART_H, pad = CHART_PAD) {
      const x = n === 1 ? W - pad : pad + (i * (W - pad * 2)) / (n - 1);
      const y = H - pad - (v / max) * (H - pad * 2);
      return { x, y };
    }

    /** 折线坐标串（SVG polyline 的 points 属性）；无有效点返回 null，由卡面标空态。 */
    function sparkPoints(points, max, W = CHART_W, H = CHART_H, pad = CHART_PAD) {
      const vals = seriesVals(points).map((p) => num(p.v));
      const m = num(max);
      if (!vals.length || m === null) return null;
      return vals.map((v, i) => {
        const q = pointXY(i, vals.length, v, m, W, H, pad);
        return q.x.toFixed(1) + ',' + q.y.toFixed(1);
      }).join(' ');
    }

    /**
     * 鼠标横坐标 → 最近采样点的下标。svg 是 preserveAspectRatio="none" + width:100%，
     * 屏幕横坐标与 viewBox 横坐标线性对应，按比例反解即可；rect 拿不到就返回 null，不猜。
     */
    function hoverIndexAt(clientX, rect, n) {
      const count = num(n);
      const w = rect ? num(rect.width) : null;
      const left = rect ? num(rect.left) : null;
      const x = num(clientX);
      if (count === null || count <= 0 || w === null || w <= 0 || left === null || x === null) return null;
      if (count === 1) return 0;
      const vb = CHART_PAD + ((x - left) / w) * (CHART_W - CHART_PAD * 2);
      const i = Math.round(((vb - CHART_PAD) * (count - 1)) / (CHART_W - CHART_PAD * 2));
      return Math.max(0, Math.min(count - 1, i));
    }

    /** 读数里的时刻：HH:MM:SS（本地时区）。点没带时间戳就只出数值，不编一个时刻。 */
    function clockOf(ms) {
      const v = num(ms);
      if (v === null) return '';
      const d = new Date(v);
      const p2 = (x) => String(x).padStart(2, '0');
      return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    }

    /**
     * 悬停读数的一行文案。口径跟着卡走：C 盘卡的点是**空闲百分比**，按 latest 的总容量换算回
     * GB；总量未知就只说百分比，不硬算（与 mtrRows 的 C 盘格同一口径）。网络卡在该点同时给
     * 下行与上行两个值。
     */
    function tipParts(arg) {
      const c = arg || {};
      const v = num((c.point || {}).v);
      if (v === null) return null;
      let main;
      if (c.k === 'diskFreePct') {
        const totalGb = num(c.totalGb);
        main = totalGb ? `${((v / 100) * totalGb).toFixed(1)} GB（${v.toFixed(1)}%）` : `${v.toFixed(1)}%`;
      } else if (c.k === 'netDown') {
        main = `↓ ${fmtRate(v)}`;
        const v2 = num((c.point2 || {}).v);
        if (v2 !== null) main += ` ↑ ${fmtRate(v2)}`;
      } else {
        main = `${v.toFixed(1)}%`;
      }
      return { v: main, t: clockOf((c.point || {}).t) };
    }

    /** 读数的整行读法（气泡把数值与时刻拆成两段渲染，这里保持一份真相）。 */
    function tipText(arg) {
      const p = tipParts(arg);
      if (!p) return '';
      return p.t ? `${p.v} · ${p.t}` : p.v;
    }

    /**
     * 悬停读数的落位（S15）：svg 横向被拉伸、纵向 1:1（style.height 就是 CHART_H px），
     * 所以圆环与气泡只能按**百分比**横贴、按 px 纵贴。
     * 气泡不做「居中 + 固定夹边」：它有多宽要等文案渲染出来才知道（网络卡那两个速率实测 187px 宽），
     * 夹边值一旦小于半个气泡宽，贴边的点就把气泡裁到卡外（无头实测左端溢出 32.5px）。
     * 改成「点在哪半边，气泡就朝里长」：左半边左边贴该点、右半边右边贴该点，各让开 8px 避开引导线。
     */
    function tipLayout(x, y) {
      const leftPct = Math.round((x / CHART_W) * 1000) / 10;
      const start = leftPct < 50;
      return { leftPct, topPx: Math.round(y), start,
        leftCss: `calc(${leftPct}% ${start ? '+' : '-'} 8px)`,
        transform: start ? 'translateX(0)' : 'translateX(-100%)' };
    }

    /**
     * 时间线一行的正文：hit 报「规则名：数值（口径注）」，op 报当时留下的操作说明。
     * 数值只出**显示位数**（S16-⑤）：命中时存的是采集原值（如 90.53895642516085），照原样念出来
     * 就是一屏噪声；这里只改显示，落盘值不动 —— 记录要能对上当时规则配的阈值，不能反过来改数据。
     */
    function hitText(hh) {
      if (hh.kind === 'op') return hh.text || hh.note || '';
      const name = hh.ruleName || hh.name || (hh.rule && hh.rule.n) || '';
      const v = num(hh.value);
      const vs = v === null ? '' : (hh.metric === 'netDown' || hh.metric === 'netUp' ? fmtRate(v) : fmtPct(v));
      return `${name}：${vs}${hh.note ? '（' + hh.note + '）' : ''}`;
    }

    /** 记录时刻 `MM-DD HH:MM`。相对时间（「21 小时前」）看不出是哪一天炸的，两者并列（S15-②）。 */
    function hitStamp(ms) {
      const v = num(ms);
      if (v === null) return '—';
      const d = new Date(v);
      const p2 = (x) => String(x).padStart(2, '0');
      return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
    }

    /** 就地筛选三档。默认「全部」—— 不许用默认窗口藏记录。 */
    const ALERT_RANGES = [{ v: '', t: '全部' }, { v: '24h', t: '最近 24 小时' }, { v: '7d', t: '最近 7 天' }];
    const ALERT_RANGE_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000 };

    /**
     * 筛选只筛显示、不动数据（与清理页分类条 S12-A 同一口径）。
     * 开了窗口时**没带时间戳的记录进不了窗口** —— 说不出它在哪一天就不把它算进「最近 24 小时」，
     * 卡片头的 `X / Y 条` 把这批差额摆在明面上。
     */
    function hitsInRange(hits, range, now) {
      const list = Array.isArray(hits) ? hits : [];
      const span = ALERT_RANGE_MS[range];
      const t0 = num(now);
      if (!span || t0 === null) return list.slice();
      return list.filter((hh) => { const t = num(hh && hh.t); return t !== null && t0 - t <= span; });
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

    /**
     * 按 key 取采集源那一行（`snap.sources` 里宿主给的原始行，界面不做二次加工）。
     * 找不到就返回 null —— 调用方必须把它当「状态未确认」而不是「未开启」：
     * 拿 null 冒充 off 就是替宿主编一句它没说过的话（spec §7 如实降级）。
     */
    function sourceRow(snap, key) {
      const rows = Array.isArray(snap && snap.sources) ? snap.sources : [];
      return rows.find((r) => r && r.key === key) || null;
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
     * 扫描条读数。分母是宿主扫描器帧自带的 `rulesLen`（本次要扫的类目录数，lib/clean/scanner.js 现算）。
     * 旧宿主没给 `ruleIdx`/`rulesLen` 时 pct 交 **null**：卡面走不定量样式 + 「已用时 N 秒」，
     * 绝不拿命中数除规则数凑百分比（真机 516 项清单头几秒就 96%，那是假进度），
     * 也不画实心 0%（那会被读成"一项都没扫"）。
     */
    function scanCells(state) {
      const st = state && typeof state === 'object' ? state : {};
      const phase = String(st.phase || 'idle');
      const hit = num(st.hit) ?? 0;
      const idx = num(st.ruleIdx);
      const total = num(st.rulesLen) ?? 0;
      const startedAt = num(st.startedAt) ?? 0;
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
        // 分子分母同域（S12-A）：进度条读的是「扫完第几类目录 / 共几类」，来自宿主扫描器帧
        // （lib/clean/scanner.js 的 ruleIdx/rulesLen）。早先拿命中数除规则数，516 项清单在
        // 头几秒就冲到 96%，那是假进度；真完成由 clean:done 帧定（service.js:85）。
        pct = total > 0 && idx !== null ? Math.min(96, Math.round((idx / total) * 100)) : null;
      }
      return {
        cur: String(st.dir || ''),
        walked: (num(st.walked) ?? 0).toLocaleString('en-US'),
        found: hit,
        size: fmtBytes(st.bytes),
        pct,
        // 「正在扫第几类目录」是主流清理工具给的那个数，读得到就说，读不到不编
        ruleText: total > 0 && idx !== null ? `第 ${Math.min(idx, total)} / 共 ${total} 类目录` : '',
        // S10-①：扫描卡右侧读「已用时 N 秒」（宿主 startedAt 现算；帧每 250ms 到一个，读数跟着跳）。
        // 拿不到 ruleIdx/rulesLen 的旧宿主只有这一路可读，所以两个数是并列显示、不互相回落。
        elapsed: phase === 'scanning' && startedAt > 0 ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : null,
        phase: phaseText,
        note: parts.join(' · '),
      };
    }

    /** 判断条目是否被 guard 拒绝。纯渲染：只看服务端有没有给 guardDenied 键，页面不做任何路径裁决。 */
    const deniedOf = (it) => (it && it.guardDenied ? it.guardDenied : null);

    /**
     * 清单行：只从冻结快照取数。风险列三态（S10-④）—— guardDenied→「已拒绝」（红）/
     * riskLevel mid→「有风险」（琥珀）/ 其余→「可清理」（绿）。
     * 早先把 riskWhy 整句塞进 pill、底下再渲染同一句 why，真机上每行同一句出现两遍（截图即此）：
     * pill 只放**短标签**，解释句只出现一次（`why`），一行两行都归位。
     *
     * S11-② 的排序：按等级从「可安全清理」到「有风险」到「已拒绝」，同级保持快照原序（Array.sort 稳定）。
     * 用户原话「可以安全清理得排在最前面，按等级顺序排列」—— 513 项 mid / 3 项 low 的真机清单里，
     * 能放心勾的三项沉在几百行下面，逐屏翻找不到。
     * 排序只动**显示顺序**，快照本体（执行对象唯一数据源）一字不改。
     * 每行自带 `count`：渲染层原来按 `planObj.items[i]` 取文件数，一旦排序那个下标就错位（改这里时必须一起改）。
     */
    const RISK_RANK = { '可清理': 0, '有风险': 1, '已拒绝': 2 };

    function planRows(plan, sel) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      const has = (id) => (sel instanceof Set ? sel.has(id) : Array.isArray(sel) ? sel.includes(id) : false);
      return items.map((it) => {
        const gd = deniedOf(it);
        const mid = !gd && it.riskLevel === 'mid';
        return {
          id: String(it.id),
          path: String(it.path ?? ''),
          sizeText: fmtBytes(it.size),
          ruleName: String(it.ruleName ?? ''),
          accText: fmtAge(Math.max(0, Date.now() - num(it.atime))),
          riskPill: gd ? '已拒绝' : (mid ? '有风险' : '可清理'),
          riskCls: gd ? 'so-pill-red' : (mid ? 'so-pill-amber' : 'so-pill-down'),
          disabled: Boolean(gd),
          // guardDenied.why 原样显示（文案来自宿主 guard 的 why），页面不自造句子
          why: gd ? String(gd.why ?? gd.code ?? '') : (it.riskWhy ? String(it.riskWhy) : ''),
          checked: has(it.id) && !gd,
          count: num(it.count) ?? 0,
        };
      }).sort((a, b) => RISK_RANK[a.riskPill] - RISK_RANK[b.riskPill]);
    }

    /**
     * 「一键安全清理」的目标集合（S11-②）：**未拒且非 mid** —— 也就是清单里标「可清理」的那些。
     * 与表头全选（`selectAllIds`，未拒即可选、含风险项）是两回事，别混用：
     * 这一键走的是永久删除，范围只肯收窄到「风险表里判为 low / 只影响事后分析或需重新下载」的那批。
     */
    function safeCleanIds(plan) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      return items.filter((it) => !deniedOf(it) && it.riskLevel !== 'mid').map((it) => String(it.id));
    }

    /**
     * 执行进度帧（S11-②「清理过程要有动画展」）：把宿主逐条发的 `clean:item` 并进一份运行态。
     * 纯函数、单点口径 —— 计数只认帧里的 `state`，页面不猜「这条大概成功了吧」。
     * 只累加到 total（前端发起时交出去的 id 数）为止：宿主若因重放多打一帧，不把它算进进度。
     */
    function execItem(prev, d) {
      if (!prev || prev.phase !== 'running') return prev;
      const state = String((d && d.state) || '');
      const bucket = state === 'ok' ? 'ok'
        : state === 'skipped' ? 'skipped'
          : state === 'failed' ? 'failed'
            : state.indexOf('rejected') === 0 ? 'rejected' : null;
      if (bucket === null) return prev;
      // 只累加到自己交出去的总数为止：SSE 断线重连会重放帧，多收的一帧不许把进度推过 100%。
      const total = num(prev.total) ?? 0;
      if (total > 0 && prev.done >= total) return prev;
      const done = prev.done + 1;
      return {
        ...prev,
        done,
        [bucket]: prev[bucket] + 1,
        current: String((d && d.path) || ''),
        currentPath: String((d && d.path) || ''),
        results: [{ id: String((d && d.id) || ''), state, path: String((d && d.path) || ''), why: String((d && d.errnoText) || '') }]
          .concat(prev.results).slice(0, 8),
      };
    }

    /** 进度读数：条宽按「已处理/总数」，总数未知（0）时交给不定量动画。 */
    function execCells(run) {
      if (!run) return null;
      const total = num(run.total) ?? 0;
      const pct = run.phase === 'done' ? 100 : (total > 0 ? Math.min(99, Math.round((run.done / total) * 100)) : null);
      return {
        pct,
        line: `第 ${Math.min(run.done + (run.phase === 'running' ? 1 : 0), total) || run.done} / ${total} 项 · 成功 ${run.ok} · 跳过 ${run.skipped} · 失败 ${run.failed} · 拒绝 ${run.rejected}`,
        elapsed: Math.max(0, Math.round((Date.now() - run.startedAt) / 1000)),
      };
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
        // S10-④ 卡头三类计数用：可清理 = 未拒且非 mid（「有风险」只是提示，不是不可清理）
        cleanable: items.filter((it) => !deniedOf(it) && it.riskLevel !== 'mid').length,
        riskySelected: picked.filter((it) => it.riskLevel === 'mid').length,
      };
    }

    /**
     * 表头全选框的目标集合（S10-③ 改口径）：**未拒即可选**，含标风险项。
     * 「有风险」的含义只是「运行中的应用会锁住部分文件，锁住的项会被跳过」——照常可执行，
     * 旧口径把 mid 全跳过，真机上 507 项里 504 项带这个标，全选等于什么都选不上（用户原话：
     * 「哪些能清理，哪些有风险要标注出来，支持一键清理」）。
     */
    function selectAllIds(plan) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      return items.filter((it) => !deniedOf(it)).map((it) => String(it.id));
    }

    /** 表头全选框三态：对目标集合数选中数（some 显示为半选）。 */
    function selectAllState(plan, sel) {
      const target = selectAllIds(plan);
      if (target.length === 0) return 'none';
      const has = (id) => (sel instanceof Set ? sel.has(id) : Array.isArray(sel) ? sel.includes(id) : false);
      const on = target.filter(has).length;
      return on === 0 ? 'none' : (on === target.length ? 'all' : 'some');
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
     * AI 清理建议（S12-③）的三档动作口径。
     * 一张表管三处（pill 文案、pill 颜色、默认是否勾上采纳框）—— 界面不许在别处再抄一份，
     * 否则「建议清理」和「建议先看一眼」会在某个角落被渲染成同一个颜色。
     */
    const AI_ACTION_CELL = {
      clean: { label: '建议清理', cls: 'so-pill-down', pick: true },
      review: { label: '建议先看一眼', cls: 'so-pill-amber', pick: false },
      keep: { label: '建议保留', cls: 'so-pill-gray', pick: false },
    };

    /** 建议列表：只认服务端交回的 recommendations 数组，形状不对就当没有（不猜、不补）。 */
    function aiRecommendations(run) {
      const list = run && run.result && Array.isArray(run.result.recommendations) ? run.result.recommendations : [];
      return list.map((rec) => ({
        group: rec.group,
        ruleName: String(rec.ruleName ?? rec.ruleId ?? ''),
        kind: String(rec.kind ?? ''),
        count: num(rec.count) ?? 0,
        bytesText: fmtBytes(rec.bytes),
        cleanable: num(rec.cleanable) ?? 0,
        risky: num(rec.risky) ?? 0,
        action: String(rec.action ?? ''),
        cell: AI_ACTION_CELL[String(rec.action ?? '')] ?? { label: String(rec.action ?? '未知'), cls: 'so-pill-line', pick: false },
        reason: String(rec.reason ?? ''),
        ids: Array.isArray(rec.ids) ? rec.ids.map(String) : [],
      }));
    }

    /**
     * 采纳集合 = 被勾上的那些分类的 ids 并集。
     * ids 全部来自服务端交回的快照找回结果（lib/clean/ai-advisor.js），页面不做任何路径判定，
     * 也不新增：这里能并进来的东西，勾选框里本来就有。
     */
    function aiAdoptIds(run) {
      const picked = run ? run.picked : null;
      const has = (g) => (picked instanceof Set ? picked.has(g) : Array.isArray(picked) ? picked.includes(g) : false);
      const out = [];
      for (const rec of aiRecommendations(run)) if (has(rec.group)) out.push(...rec.ids);
      return out;
    }

    /**
     * 卡头那颗按钮的读数（三态一表，界面只渲染这里交出的话）。
     * `ready` 还没拿到时**不许**当成"宿主没有模型"：那是"还没问到"，文案必须分清（lib/caps.js 同口径）。
     */
    function aiButton({ ready, run, hasPlan, execBusy }) {
      const phase = run ? run.phase : 'idle';
      if (phase === 'running') return { disabled: true, why: '正在等宿主模型回话（本次判定已发出，不会自动执行任何删除）', label: 'AI 正在判定…' };
      if (!hasPlan) return { disabled: true, why: '先扫描生成清单，AI 才有可判断的分类', label: 'AI 智能清理' };
      // 就绪度没拿到 ≠ 宿主没有模型：那是"还没问到"，两者文案必须分清（lib/caps.js 同一口径）
      if (!ready) return { disabled: true, why: '还没问到宿主模型（进本页时现读一次）', label: 'AI 智能清理' };
      if (ready.available !== true) return { disabled: true, why: String(ready.reason || '宿主未提供模型调用能力'), label: 'AI 智能清理' };
      if (execBusy) return { disabled: true, why: '本次清理正在执行', label: 'AI 智能清理' };
      if (phase === 'error') return { disabled: false, why: '上次征求失败：就地看原因，确认后可再问一次', label: '重新征求 AI 建议' };
      return {
        disabled: false,
        why: `请宿主模型按分类给一份建议：只发类别汇总与文件名（不发完整路径），只推荐；执行仍要你自己点「清理选中」${phase === 'done' ? '（这次会替换面板里那份建议）' : ''}`,
        label: phase === 'done' ? '重新征求 AI 建议' : 'AI 智能清理',
      };
    }

    /**
     * 留痕行读数。beforeFree/afterFree 是宿主 statfs('C:') 的**系统盘可用容量**
     * （lib/clean/service.js:39-46、executor.js:175），不是条目所在盘的容量 —— 文案如实写「系统盘」，
     * 免得用户把 70.4 GB 读成「D 盘还有 70.4 GB」（Task 25 若改用条目盘符口径，这里跟着换）。
     * S12-A 起前后两端走 capText（与概览条、与监控页的 C 盘格同一个 1024 进制口径）：
     * 原来这里除 1e9、监控页除 2^30，同一个数在两处差 7%，用户会以为「释放量对不上」。
     */
    function logRow(log) {
      const lg = log || {};
      return {
        id: String(lg.logId ?? ''),
        modePill: lg.mode === 'move-to-quarantine' ? '隔离到暂存' : (lg.mode ? '永久删除' : ''),
        restorable: lg.mode === 'move-to-quarantine',
        // start 行没有四档计数（lib/clean/log-store.js:122-127）⇒ 计数未确认，不许说成「全 0」
        line: num(lg.ok) === null
          ? '计数未确认：本次执行没写完成档'
          : `成功 ${num(lg.ok)} · 跳过 ${num(lg.skipped) ?? 0} · 失败 ${num(lg.failed) ?? 0} · 拒绝 ${num(lg.rejected) ?? 0}`,
        snapshot: `系统盘可用容量 ${capOrMissing(lg.beforeFree)} → ${capText(lg.afterFree)} · 释放 ${fmtBytes(lg.bytesFreed)}`,
      };
    }

    /**
     * 容量文案（S12-A 的单一口径）：系统盘可用/总容量、快照的 beforeFree/afterFree、
     * 执行收尾的前后对比全走这里，1024 进制并标 GB（与资源管理器、与监控页的 diskFreeGb 同口径）。
     * 不用 fmtBytes：它会自适应到 MB/TB，前后对比的两端落在不同单位上就没法一眼比出增减。
     */
    function capText(bytes) {
      const v = num(bytes);
      return v === null ? '—' : (v / 2 ** 30).toFixed(1) + ' GB';
    }

    /**
     * 快照里的 beforeFree 专用文案：服务端读失败交的是 **0**（lib/clean/service.js 的 readFree），
     * 那与「盘真的空了」在数据上不可分 —— 显示 0.0 GB 会让人以为清理救不了这个盘。
     * 统一说成「未读到」，概览条与留痕两处同口径。
     */
    function capOrMissing(bytes) {
      const v = num(bytes);
      return v && v > 0 ? capText(v) : '未读到';
    }

    /**
     * 清单按「命中规则」分组的读数（S12-A，对齐主流清理工具的分类视图 —— 也顺便回答了
     * 「现在到底扫了哪些目录」：一格就是一条规则覆盖的那批目录，大小降序）。
     * 分组只服务**摘要与筛选**：列表顺序仍由 planRows 的风险等级排序决定。
     * 把同类条目归拢到一起显示会把 S11-② 那批「可清理」重新埋回几百行里，两件口径不能互相覆盖。
     * 每组给：项数 / 合计大小 / 三档计数 / 全部 id（筛选用）/ 未拒 id（「全选本组」只吃这份，
     * guard 拒的项永不进可选集合，与 selectAllIds 同一判据）。
     */
    function categoryGroups(plan, sel) {
      const items = plan && Array.isArray(plan.items) ? plan.items : [];
      const has = (id) => (sel instanceof Set ? sel.has(id) : Array.isArray(sel) ? sel.includes(id) : false);
      const map = new Map();
      for (const it of items) {
        const key = String(it.ruleName ?? '').trim() || '(规则未标注)';
        let g = map.get(key);
        if (!g) {
          // 不带 kind：一条规则一组，组里各条的 kind 可以不同（同一规则既收缓存又收日志），
          // 拿首项的 kind 去标整组是以偏概全；且原型这颗 chip 从来只有「类名 + 计数」，两边同形。
          g = { key, count: 0, bytes: 0, cleanable: 0, risky: 0, rejected: 0, ids: [], selectable: [], selected: 0 };
          map.set(key, g);
        }
        g.count += 1;
        g.bytes += num(it.size) ?? 0;
        g.ids.push(String(it.id));
        if (deniedOf(it)) { g.rejected += 1; continue; }
        if (it.riskLevel === 'mid') g.risky += 1; else g.cleanable += 1;
        g.selectable.push(String(it.id));
        if (has(it.id)) g.selected += 1;
      }
      const out = [...map.values()];
      for (const g of out) {
        g.bytesText = fmtBytes(g.bytes);
        g.allSelected = g.selectable.length > 0 && g.selected === g.selectable.length;
      }
      out.sort((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return out;
    }

    /**
     * 容量概览读数（S12-A）：可用/总容量来自监控快照（lib/collect/service.js 的 latest，GiB 口径的 GB 数），
     * 与监控页的「C 盘可用」格同源，不再从别处取第二个数。
     * 快照还没到位时 free 是 null：如实交 '—' 并给 note，不硬算、不画实心条。
     * beforeFree 的 0 是服务端读失败的形状（lib/clean/service.js 的 readFree 交 0），
     * 那与「盘真的空了」不可分 —— 所以 0 说成「未读到」，绝不显示 0.0 GB 吓人。
     */
    function diskOverview(latest, plan) {
      const l = latest && typeof latest === 'object' ? latest : {};
      const free = num(l.diskFreeGb);
      const total = num(l.diskTotalGb);
      const usedPct = total && free !== null ? Math.round((1 - free / total) * 1000) / 10 : null;
      const bf = plan && typeof plan === 'object' ? num(plan.beforeFree) : null;
      return {
        freeText: free === null ? '—' : free.toFixed(1) + ' GB',
        totalText: total === null || total === 0 ? '—' : total.toFixed(1) + ' GB',
        usedPct,
        // 分档与监控页的 C 盘格完全一致（同一个 band、同样 85/92），两处读数不能一处黄一处绿
        cls: usedPct === null ? '' : band(usedPct, DISK_BAND.warn, DISK_BAND.crit),
        beforeText: capOrMissing(bf),
        note: free === null ? '容量读数还没到：监控采集没给出 C 盘读数时这里不硬算' : '',
      };
    }

    /**
     * 扫描范围的真相读数（S12-A 问题①「现在到底扫了哪些目录」）。
     * 数据只吃宿主 GET /api/rules 的公开字段：`builtin[]` 的 id/n/kind/ageDays/rel/enabled 与 `items[]`。
     * `dir`/`glob` 展开后含本机私有路径、永不出接口（Ruling-106），所以这里能说的只有相对用户目录的 `rel`，
     * 页面也不拼绝对路径 —— 拼出来就是第二份口径，还可能把机器名/盘符焊进文案。
     * `total` 与宿主 `activeRules()`（lib/prefs/rules-store.js:68-71）同式：开启的内置 + 用户自建；
     * 启用/停用只认宿主给的 `enabled` 标记，不在页面重算 `off.indexOf`。
     * 老形状（只给数组 = 纯用户规则、没有内置行）时内置侧为空，读数如实少计，不猜内置条数。
     */
    function scanScope(rules) {
      const row = Array.isArray(rules) ? { items: rules, builtin: [] }
        : (rules && typeof rules === 'object'
          ? { items: Array.isArray(rules.items) ? rules.items : [], builtin: Array.isArray(rules.builtin) ? rules.builtin : [] }
          : { items: [], builtin: [] });
      const on = row.builtin.filter((b) => b && b.enabled !== false);
      return {
        // 宿主只要给了内置行（哪怕全停用）这份读数就是到位的；一条都没给 = 这次没读到
        known: row.builtin.length > 0,
        on: on.map((b) => ({ key: String(b.id ?? b.n ?? ''), n: String(b.n ?? ''), rel: String(b.rel ?? ''), kind: String(b.kind ?? '缓存'), ageDays: num(b.ageDays) })),
        off: row.builtin.filter((b) => b && b.enabled === false).map((b) => ({ key: String(b.id ?? b.n ?? ''), n: String(b.n ?? '') })),
        user: row.items,
        total: on.length + row.items.length,
      };
    }

    /**
     * 扫描范围的一行摘要（S13，用户批注「这些东西放在这里干什么，占地方又没用」）：
     * 卡默认只留这一行，明细点「展开明细」就地摊开 —— 和留痕面板同一套交互，不引浮层。
     * 这里只报**数**；「为什么是 0 条」「没读到」那两句话在 scopeNote 里，两句不重复。
     */
    function scopeSummary(scope) {
      if (!scope.known) return `自建 ${scope.user.length} 条 · 内置规则读数暂未拿到`;
      return `内置启用 ${scope.on.length} 条（共 ${scope.on.length + scope.off.length} 条）· `
        + `自建 ${scope.user.length} 条 · 本次待遍历 ${scope.total} 类目录`
        + (scope.off.length ? ` · 另有 ${scope.off.length} 条已停用` : '');
    }

    /**
     * 摘要行下面那句**收起态也要看得见**的实话（S13）：健康态返回 null，不留一行废话。
     * 「全停用」与「没读到」是两件事，各说各的 —— 前者是用户自己的决定，后者是插件没拿到数据。
     */
    function scopeNote(scope) {
      if (!scope.known) {
        return '规则读数还没拿到：这次没能读到 GET /api/rules 的内置列表，「待遍历几类目录」留空，不猜一个数。';
      }
      if (scope.total === 0) {
        return '本次没有任何启用的规则：内置全部停用、也没有自建规则，扫描不会遍历任何目录（开关在设置页）。';
      }
      return null;
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
      guideOwn: '装 Everything 有两条路：点亮上面的「一键安装 Everything」（本插件代跑 winget，探不到 winget 就不亮），或照下面自己执行。无论走哪条，本插件都不改注册表、也不替你打开 Everything 的 HTTP 服务。',
      // 这一行只补"本机实际用哪个端口"这一件动态事：装完怎么打开 HTTP 服务器 / es.exe 那句
      // 在宿主给的指引三条里（probe.js 的 ADVICE），在这儿重述一遍就是同一句话两张卡（S12-E 截图核对抓到）。
      guidePortA: '本页探测用的是设置页里配的端口 ',
      guidePortB: '；要换端口、或指定 es.exe 的路径，也在设置页的搜索通路里改。',
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
      // S12-④：写偏好后的就地交代（界面不许对"存没存进去"保持沉默）。
      dirBlank: '目录输入是空的：先粘贴绝对路径（如 F:\\dsh-plugins），再点「＋ 添加目录」。',
      dirAdded: '已写入覆盖范围：',
      dirRemoved: '已移出覆盖范围：',
      modeSaved: '通路已存进偏好：',
      limitSaved: '返回上限已存进偏好：',
      writeFail: '没写进库（宿主拒了或读不回来）：下面这几项还是改之前的值，原因见页面上方的接口异常行。',
      saving: '保存中…',
      // S12-⑤：一键安装 Everything（已批口径「走 winget，探不到就不亮按钮」）。亮不起来必须把原因写在按钮旁。
      installBtn: '一键安装 Everything（winget）',
      installAskTitle: '确认安装：',
      installConfirm: '确认安装',
      installCancel: '取消',
      installNotAsked: '还没问到本机有没有 winget（进本页时现读一次），所以这颗按钮先不亮。',
      installBusy: '本次安装正在进行',
      installRunning: '安装中…',
      installRetry: '重试一键安装',
      installAgain: '再次运行一键安装',
      installStarted: '已经交给 winget 了：窗口里可能要你点 UAC 同意（插件不代点）。装完这一侧会自动重新检测。',
      installDone: 'winget 报告安装完成。已按结果重新检测：',
      installNoReprobe: '装完了，但这次重新检测没拿到结果（原因见页面上方的接口异常行）—— 点「重新检测」再问一次。',
      installNeedHttp: '① 已安装已翻绿；② 查询通路还要你在 Everything 里勾选 HTTP 服务器才会绿（本插件不替你打开它）。',
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
     * 「一键安装 Everything」那颗按钮的读数（S12-⑤，已批口径：**走 winget，探不到就不亮按钮**）。
     * 三态必须分清，绝不能糊成一句「不可用」：
     *  · `ready` 为 null ⇒ **还没问到**本机有没有 winget（进本页现读一次），不是"没有"；
     *  · `ready.can !== true` ⇒ 真探不到 ⇒ 按钮亮不起来，原因（宿主 detail 原文）写在按钮旁；
     *  · `job.phase === 'running'` ⇒ 已经有一装在跑 ⇒ 不许再点（宿主那一侧还有第二道 BUSY 闸）。
     * 与 aiButton 同规：纯函数，界面只渲染这里交出的话。
     */
    function installButton({ probe, ready, job, busy }) {
      const p = probe || {};
      if (p.installed === true) return { show: false };
      const label = SEARCH_TXT.installBtn;
      if (job && job.phase === 'running') {
        const secs = job.startedAt ? Math.max(0, Math.round((Date.now() - Number(job.startedAt)) / 1000)) : null;
        return { show: true, disabled: true, why: SEARCH_TXT.installBusy + (secs === null ? '' : `（已经跑了 ${secs} 秒，UAC 窗口可能要你点同意）`), label: SEARCH_TXT.installRunning };
      }
      if (!ready) return { show: true, disabled: true, why: SEARCH_TXT.installNotAsked, label };
      if (ready.can !== true) return { show: true, disabled: true, why: String(ready.detail || '本机没探到 winget'), label };
      if (busy) return { show: true, disabled: true, why: '本页正有一次写入在途', label };
      if (job && job.phase === 'failed') return { show: true, disabled: false, why: `上次没装成：${job.message || 'winget 以非 0 退出'}`, label: SEARCH_TXT.installRetry };
      if (job && job.phase === 'done') return { show: true, disabled: false, why: '上一装报告已完成：再点一次只是让 winget 再确认一遍这个包', label: SEARCH_TXT.installAgain };
      // 命令原文只在宿主那一份（installer.js 的常量）：没拿到就不在界面拼一条"看起来一样"的命令
      const cmd = typeof ready.command === 'string' && ready.command ? ready.command : '';
      return { show: true, disabled: false, why: (cmd ? `会执行：${cmd}。` : '') + '弹出的 UAC 与安装窗口要你自己同意（本插件不代点）', label };
    }

    /**
     * 安装终态那一行的就地交代。done **不等于**「搜索能用了」：Everything 的 HTTP 服务器默认没勾，
     * 所以这句只看重新检测之后的探针脸色写，绝不替 winget 的成功吹成通路的成功。
     */
    function installOutcomeText(job, probed) {
      const j = job || {};
      const tail = j.outTail ? `｜winget 最后几行：${String(j.outTail).replace(/\r?\n/g, ' / ')}` : '';
      if (j.phase === 'failed') return { tone: 'bad', text: `安装没有完成：${j.message || 'winget 以非 0 退出'}${tail}` };
      if (j.phase !== 'done') return null;
      const p = probed || {};
      if (p.installed !== true) {
        return { tone: 'bad', text: SEARCH_TXT.installDone + '① 已安装这一档还没翻绿（' + (probeDetail(p, 'installed') || '没拿到探测结果') + '）：装到哪块盘、或者还要再点一次「重新检测」，都以上面三行为准。' };
      }
      if (p.http !== true && p.es !== true) return { tone: 'ok', text: SEARCH_TXT.installDone + SEARCH_TXT.installNeedHttp };
      if (p.ready !== true) return { tone: 'ok', text: SEARCH_TXT.installDone + '①② 已绿，③ 端到端还没过：以自检那三行为准。' };
      return { tone: 'ok', text: SEARCH_TXT.installDone + '三级自检全绿，「全盘索引」这一档现在可以选了。' };
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

    /**
     * L1b 首轮到齐耗时：2026-10-01 真机复现（`tmp/repro-l1b.mjs A`）`setVisible(true)` 后 **+4.3s** 出第一行，
     * 之后 4.6s / 4.7s 一行 —— 与 §1.2 的「`Start-Sleep 3` + 单轮 1.6–1.9s ⇒ 4.37–4.91s」对得上。
     * 这段空白期界面必须说「正在起第一轮」，说「未开启」是假陈述（S17-① 的「点了没反应」）。
     */
    const PROC_FIRST_ROUND_S = 4.3;

    /** 宿主**永不提供**的能力键：只报事实「宿主不提供」，不给降级 pill，更不给开关（pg4-9）。 */
    const NEVER_PROVIDED = ['notifications', 'autostart'];

    /**
     * 四源行（恰好 L0 / L1a / L1b / L2）：tier 与 desc 逐字取原型 collectRules 的三行 + 新增 L2 行。
     * **开关读宿主源行的 `enabled`（S18-①）**：库里那一行 `prefs.sources` 只装「用户写过的键」，
     * 从没写过的源在浏览器这边读出来就是 `undefined` ⇒ 画成「关」。而宿主的默认是 l0/l1a 常开
     *（`index.js` 的 DEFAULT_CONFIG + `lib/collect/service.js` 的 switches），真机症状正是
     * 「网速采集明明在采，设置页那颗开关说没开」。「一份真相」要求默认值只在宿主侧裁一次，
     * 浏览器不许拿缺键猜一个 `false` 顶上。
     * `l2` 是唯一例外：它是非常驻源、宿主 `sourceRows()` 里没有它那一行（service.js:22 的口径），
     * 默认又是关 ⇒ 读库与读宿主在这里等价，仍读 `prefs.sources.l2`。
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
      /** 宿主给的开关意图；读不到就说读不到（S17 立的规矩：缺东西不许冒充成另一种确定状态）。 */
      const hostSwitch = (key) => {
        const row = sourceRow(snap, key);
        if (!row || typeof row.enabled !== 'boolean') return { unknown: true, text: '开关状态未确认：宿主没给这一源的开关行。' };
        return { on: row.enabled, disabled: false, key };
      };
      return [
        { key: 'l0', name: '实时曲线（CPU / 内存 / 磁盘）', tier: 'L0 · 主进程内',
          desc: '纯 Node os + fs.statfsSync，不起任何子进程；采样档位由监控页顶部「1s / 5s / 暂停」控制',
          cadText: `采样 ${cad} · 保留 ${keep === null ? '—' : keep + 'min'}`, switch: null },
        { key: 'l1a', name: '网速采集', tier: 'L1a · 常驻 typeperf',
          desc: `单进程流式读 stdout，暖身 ${L1A_WARMUP_MS}ms 之后开销可忽略`,
          cadText: '定窗续采', switch: hostSwitch('l1a') },
        { key: 'l1b', name: '进程榜采集', tier: 'L1b · 常驻 PowerShell',
          // 640ms 是 §1.2 实测的单次代价；默认关（spec §1.1 决策 7）由宿主 switches 决定
          desc: '单次 640ms，持续开启代价明显；建议只在需要时开',
          cadText: procSec === null ? '刷新间隔未确认' : `${procSec}s 一次`, switch: hostSwitch('l1b') },
        { key: 'l2', name: '按需扫描 / 搜索', tier: 'L2 · 请求驱动',
          desc: '扫描/搜索请求驱动，不常驻；遍历实测 14.5 万条目 / 7.3s，必须带进度与可停止',
          cadText: '非常驻 · 按需触发', switch: { on: src.l2 === true, disabled: false, key: 'l2' } },
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
    function Seg({ options = [], value, onChange, disabled = false }) {
      return h('span', { className: 'so-seg' }, options.map((o) => h('button', {
        type: 'button',
        key: String(o.v),
        disabled,
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
    // 4) 五个页签组件（S15-② 起：监控记录从监控页底部搬出来独立成页）
    //    导出名与 nav 的 k 一一对应，连接层按 tab 派发。
    // ------------------------------------------------------------

    /**
     * S18-③：进程榜的排序。`k` 直接就是快照行的字段名（cpuPct / ws），
     * 表头文案与 `<td>` 那两列逐字一致，原型 index.html 同口径（两边同改）。
     */
    const PROC_SORT_COLS = [{ k: 'cpuPct', t: 'CPU%' }, { k: 'ws', t: '内存' }];

    /**
     * 点表头 → 下一个排序态（纯函数，排序态本身归容器）：
     * 点另一列 = 换列并回降序（这一榜的默认读法是「大头在上面」）；
     * 点已选中的那一列 = 只翻方向。
     */
    function procSortNext(cur, key) {
      const c = cur || {};
      if (c.k !== key) return { k: key, d: 'desc' };
      return { k: key, d: c.d === 'desc' ? 'asc' : 'desc' };
    }

    /**
     * null（这一轮没读到值的行）永远沉底，不跟方向走：升序时让「—」顶着第一行，
     * 看着既像 0 又像最高，是两种假读数。同值按 PID 定序 —— 否则每帧 SSE 重画，
     * 同一对并列的行会随机换位置，榜会"抖"。
     */
    function procSortedRows(rows, sort) {
      const list = Array.isArray(rows) ? rows.slice() : [];
      const s = sort || { k: 'cpuPct', d: 'desc' };
      const col = PROC_SORT_COLS.some((c) => c.k === s.k) ? s.k : 'cpuPct';
      const dir = s.d === 'asc' ? 1 : -1;
      const tie = (a, b) => (num(a && a.pid) || 0) - (num(b && b.pid) || 0);
      return list.sort((a, b) => {
        const av = num(a && a[col]);
        const bv = num(b && b[col]);
        if (av === null && bv === null) return tie(a, b);
        if (av === null) return 1;
        if (bv === null) return -1;
        return av === bv ? tie(a, b) : (av - bv) * dir;
      });
    }

    /**
     * 监控页（Task 21 完整实现）：快照、link、档位都在 SysopsPage 的连接层里，本组件只吃 props；
     * 换页/重采不打断这里的渲染。唯一的局部态是 `tip` —— 曲线卡上的鼠标悬停读数
     * （纯 UI 态，不进连接层；不悬停时是 null，渲染结果与"页面自身无态"时逐字相同）。
     * 告警**规则**的配置不在这页：阈值告警的开关与新建都在设置页（真机反馈：配置不该长在监控页）；
     * 监控记录的时间线也不在这页了 —— 它在第 2 个页签（S15-②），这页只剩指路文案。
     */
    function MonitorPage({ snap, link, err, onSource, onRestart, onProcToggle, procSort, onProcSort } = {}) {
      const [tip, setTip] = useState(null); // {k, i} —— 哪张曲线卡的第几个点被指着

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
            // stalled 也要有重试：进程榜卡住（15s 没出一行）是这一路最常犯的停法，
            // 而卡片那句「用上方重试」指的就是这颗按钮 —— 指过去没有按钮就是假承诺（S17-① 截图核对抓到）。
            (c.retryOnly || c.state === 'crashed' || c.state === 'stalled') && c.key !== '__link'
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
      const proc = snap.proc || { rows: [], note: '' };
      // 排序态由容器传（S18-③）：默认 CPU 降序，点表头换列/换向；缺省时按 cpuPct 降序，
      // 与容器初值同口径 —— 这样 MonitorPage 单独渲染（测试、真机首帧）也不会画出一个不同顺序的榜。
      const procRows = procSortedRows(proc.rows, procSort);
      /**
       * 进程榜的**状态只认 `sources` 里的 l1b 行**（S17-① 真机）：宿主的 `proc` 帧只带
       * `rows/note/t`，**从不带 `state`**（lib/collect/service.js 的三处 emit），而增量合并
       * `d.state ?? 旧值` 会把首帧的 `off` 一路冻住 —— 榜已经 400 行在手，卡片还写着「未开启」。
       * `sources` 帧是活的（lib/api.js:696 每次 refreshSources 都广播），chip 早就跟着变了，
       * 卡片却读那个冻住的字段，两边就各说一套。
       */
      const procSrc = sourceRow(snap, 'l1b');
      const procSt = procSrc ? String(procSrc.state ?? '') : '';
      const procPill = procSrc ? sourcePill(procSrc).pill : '';

      // 脏点丢弃要报数但不挡曲线（pg1-7）：只列真实计数，不编原因
      const dr = snap.dropped || {};
      const dropParts = [];
      if ((num(dr.bad) || 0) > 0) dropParts.push(`丢弃 ${dr.bad} 个异常点`);
      if ((num(dr.stale) || 0) > 0) dropParts.push(`乱序 ${dr.stale}`);

      // 四张曲线卡：cpu / mem / 网络（下行主线 + 上行灰线）/ C 盘空闲占比。
      // 鼠标悬停：引导线画在本卡 SVG 内，圆环与数值气泡是本卡 `.so-curve` 里的 HTML（S15-①，都不是浮层）。
      const chartCards = ['cpu', 'mem', 'netDown', 'diskFreePct'].map((k) => {
        const def = CHART_DEFS[k] || {};
        const spec = curveSpec(snap, k);
        const vals = seriesVals(spec.points);
        const up = def.second ? curveSpec(snap, def.second) : null;
        const upVals = up ? seriesVals(up.points) : [];
        let max = spec.max;
        let line2 = null;
        if (up) {
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
        // 被指着的那一点：索引越界（换帧后点数变少）就当没指着 —— 不画半个读数
        const hi = tip && tip.k === k && tip.i < vals.length ? tip.i : null;
        let guide = null;
        let hover = null;
        if (hi !== null) {
          const v = num(vals[hi].v);
          if (v !== null && num(max) !== null) {
            const q = pointXY(hi, vals.length, v, max);
            const pos = tipLayout(q.x, q.y);
            const parts = tipParts({ k, point: vals[hi], point2: upVals[hi], totalGb: num(l.diskTotalGb) });
            // 引导线留在 svg 内（要跟着曲线走），圆环与气泡是卡内 HTML（不吃横向拉伸）。
            guide = h('line', {
              key: 'tl', className: 'so-tip-line', vectorEffect: 'non-scaling-stroke', stroke: spec.color,
              x1: q.x.toFixed(1), y1: CHART_PAD, x2: q.x.toFixed(1), y2: CHART_H - CHART_PAD,
            });
            if (parts) hover = [
              h('span', {
                key: 'ring', className: 'so-tip-ring',
                style: { left: pos.leftPct + '%', top: pos.topPx + 'px', borderColor: spec.color },
              }),
              h('span', {
                key: 'box', className: 'so-tip-box',
                style: { left: pos.leftCss, transform: pos.transform },
              }, h('b', null, parts.v), parts.t ? h('span', { className: 'so-tip-t' }, parts.t) : null),
            ];
          }
        }
        return h('div', { className: 'so-card', key: k },
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-curve-cap' }, h('h3', null, `${spec.label} · 最近 ${snap.keepMinutes} 分钟`), h('span', { className: 'so-grow so-num' }, note)),
            h('div', { className: 'so-curve-v so-num' }, value),
            h('div', { className: 'so-curve' },
              h('svg', {
                className: 'so-spark', viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: 'none',
                style: { height: CHART_H + 'px' },
                'aria-label': `${spec.label}曲线，鼠标移上来读该点数值`,
                onMouseMove: (e) => {
                  if (!vals.length) return;
                  const idx = hoverIndexAt(e.clientX, e.currentTarget.getBoundingClientRect(), vals.length);
                  if (idx === null) return;
                  if (!tip || tip.k !== k || tip.i !== idx) setTip({ k, i: idx });
                },
                onMouseLeave: () => { if (tip && tip.k === k) setTip(null); },
              },
                [1, 2, 3].map((q) => h('line', { key: 'g' + q, x1: 0, y1: (CHART_H * q) / 4, x2: CHART_W, y2: (CHART_H * q) / 4, stroke: 'var(--so-bd)', strokeWidth: 1 })),
                thY !== null ? h('line', { key: 'th', x1: 0, y1: thY, x2: CHART_W, y2: thY, stroke: 'var(--so-up)', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.55, vectorEffect: 'non-scaling-stroke' }) : null,
                line1 ? h('polyline', { key: 'p', points: line1, fill: 'none', stroke: spec.color, strokeWidth: 1.6, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }) : h('span', { key: 'e', className: 'so-hint' }, '暂无采样'),
                line2 ? h('polyline', { key: 'p2', points: line2.points, fill: 'none', stroke: line2.color, strokeWidth: 1.4, vectorEffect: 'non-scaling-stroke' }) : null,
                guide),
              hover)));
      });

      /** 一态一句真话：状态没说清就不编一句好听的（S17-①）。 */
      const procSec = num((cfg().defaults || {}).procIntervalSec);
      const procCad = procSec === null ? '刷新间隔未确认' : `每 ${procSec}s 一轮`;
      const procEmptyText = () => {
        if (procSt === '') return '进程榜状态未确认：宿主没给 l1b 这一源行。';
        if (procSt === 'off') return '进程榜采集未开启。';
        if (procSt === 'starting') return `进程榜正在起第一轮：常驻 PowerShell 冷启动，实测约 ${PROC_FIRST_ROUND_S}s 到齐。`;
        if (procSt === 'on') return `进程榜已开启，还没出第一轮数据（${procCad}，实测约 ${PROC_FIRST_ROUND_S}s 一行）。`;
        return `进程榜已停：${procPill || procSt}。恢复请用上方「进程榜」那一行的「重试」。`;
      };

      /**
       * 可排序表头（S18-③）：`aria-sort` 挂在 `<th>`（这是 ARIA 的位置，挂在按钮上读屏不认），
       * 点击落在按钮上；非当前列不画箭头，只靠 hover/焦点态与 title 提示可点。
       */
      const sortTh = (c) => {
        const on = procSort && procSort.k === c.k;
        const asc = on && procSort.d === 'asc';
        return h('th', {
          key: c.k, className: 'so-r so-th-sort',
          'aria-sort': on ? (asc ? 'ascending' : 'descending') : 'none',
        }, h('button', {
          type: 'button', className: 'so-th-btn' + (on ? ' is-on' : ''),
          onClick: () => onProcSort && onProcSort(c.k),
          title: on ? `已按${c.t}${asc ? '升序' : '降序'}，点这里换方向` : `按${c.t}排序（先降序）`,
        }, c.t, on ? h('span', { className: 'so-th-i' }, asc ? '↑' : '↓') : null));
      };

      const procBody = procSt === 'on' && procRows.length
        ? h('div', null,
            h('div', { className: 'so-tblwrap so-tblwrap-proc' },
              h('table', { className: 'so-tbl' },
                h('thead', null, h('tr', null,
                  h('th', null, '进程'), h('th', { className: 'so-r' }, 'PID'),
                  PROC_SORT_COLS.map(sortTh),
                  h('th', null, '来源'))),
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
            procEmptyText(),
            // note 在空态也要露：宿主的「非 JSON 行」「超出 N 行未列出」就挂在这，藏起来等于把线索扔了
            proc.note ? h('div', { className: 'so-hint so-num', style: { marginTop: 6 } }, proc.note) : null,
            procSt === 'off' ? h('div', { className: 'so-hint' }, `单次 Get-CimInstance Win32_Process 实测 640ms，按 5s 刷新会持续占用约一个核心的 13%，所以默认关；开了之后 ${procCad}。`) : null,
            procSt === 'off' ? h('button', { type: 'button', className: 'so-btn so-btn-sm', style: { marginTop: 10 }, onClick: () => onProcToggle && onProcToggle(true) }, '现在开启') : null);

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
          h('div', { className: 'so-card-h' }, h('h2', null, '进程占用榜'), h('span', { className: 'so-hsub' }, '按 PowerShell 周期采集，开销较高，默认关闭 · 点 CPU% / 内存 表头可换排序')),
          h('div', { className: 'so-card-b' }, procBody)));
      /* 监控记录不在这一页（S15-②）：23 条时间线挂在监控页底部，把「看曲线」这一屏顶得只剩半屏，
         它自己也有独立读者（想知道哪天几点炸过几次）⇒ 搬去第 2 个页签 AlertsPage。 */
    }

    /**
     * 监控记录页（S15-② 建页时叫「触发记录」，S16-③ 按真机批注改名；内部键仍是 `alerts`，只改界面文案）：
     * 只读时间线，规则配置在设置页。
     * 与 MonitorPage 同规：自身零 useState（筛选档位是容器传的 UI 态），数据只吃快照的 alerts 分支。
     */
    function AlertsPage({ snap, err, range = '', onRange } = {}) {
      const alerts = (snap && snap.alerts) || {};
      const hits = Array.isArray(alerts.hits) ? alerts.hits : [];
      // 降级信息优先于"空态"：库不可用时显示"还没有监控记录"是误导（spec §7）。
      const hitsError = alerts.hitsError || alerts.errorCode || null;
      const now = Date.now();
      const shown = hitsInRange(hits, range, now);
      const label = (ALERT_RANGES.find((r) => r.v === range) || ALERT_RANGES[0]).t;
      return h('div', { className: 'so-tabpanel' },
        err ? h(Notice, { tone: 'amber' }, `接口异常（${err.code || 'UNKNOWN'}）：${err.message || '未知错误'}`) : null,
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '监控记录'),
            h('span', { className: 'so-hsub' }, '规则在设置页配置 · 本机保留最近 200 条'),
            h('span', { className: 'so-grow' },
              h('span', { className: 'so-hint so-num' }, range ? `${shown.length} / ${hits.length} 条` : `${hits.length} 条`),
              h(Seg, { options: ALERT_RANGES, value: range, onChange: (v) => onRange && onRange(v) }))),
          h('div', { className: 'so-card-b' },
            hitsError
              ? h('div', { className: 'so-empty' },
                  `监控记录落盘不可用：${alerts.hitsError || alerts.errorCode}（规则仍在评估，命中不会写入本机记录）`)
              : null,
            !hitsError && hits.length === 0
              ? h('div', { className: 'so-empty' }, '本机还没有监控记录：规则命中后会出现在这里。')
              : null,
            !hitsError && hits.length > 0 && shown.length === 0
              ? h('div', { className: 'so-empty' },
                  `${label}内没有监控记录。全部 ${hits.length} 条还在本机记录里，切回「全部」就能看见。`)
              : null,
            // S16-④：滚动只在这层框里（真机 29 条把整页顶长）。见 .so-tlwrap 的注释：滚动容器单独套一层。
            shown.length
              ? h('div', { className: 'so-tlwrap' }, h('div', { className: 'so-tl so-timeline' }, shown.map((hh, i) => h('div', {
                  className: 'so-tl-item ' + (hh.kind === 'op' ? 'so-tl-op' : 'so-tl-hit'), key: String(hh.hitId || (hh.t || i)) },
                  h('div', { className: 'so-tt so-num' }, hitStamp(hh.t),
                    h('span', { className: 'so-tl-ago' }, fmtAge(Math.max(0, now - (num(hh.t) || now))))),
                  h('div', { className: 'so-tx' }, hitText(hh))))))
              : null)));
    }

    /**
     * 清理页（Task 22 完整实现）：扫描只读 → 冻结清单 → 勾选 → 执行/隔离 → 留痕。
     * 与 MonitorPage 同规：自身零 useState —— sel/lastSummary/数据全由 SysopsPage 传入，
     * 状态机在宿主侧（lib/clean/service.js 的 state()），页面只做渲染分支：
     * idle（空态卡）/ scanning（进度卡）/ 有清单（清单卡）/ 执行完（失效卡）。
     * stopped/truncated 是附加标记不是独立相位（简报 Step 3）；错误就地落卡（.so-notice-red/amber，无浮层）。
     * 扫描入口不在本页：唯一入口是页头的「开始扫描 / 扫描中… / 重新扫描」（原型口径），
     * 本页只管停止（扫描卡内）与重扫后的展示 —— 空态文案「点击右上角」说的就是那里。
     * 红线：本页**不判断任何路径能不能删** —— guardDenied 只做纯渲染，裁决只有 lib/clean/guard.js。
     */
    function CleanPage(props = {}) {
      const {
        clean = {}, plan = null, logs = [], unfinished = [], quar = null, rules = [],
        prefs = {}, caps = {}, link = 'sse', sel = new Set(), err = null, lastSummary = null,
        exec = null, safeAsk = false, latest = null, catFilter = null,
        logsOpen = false, scopeOpen = false, ai = null, aiRun = null,
        onStopScan, onToggle, onToggleAll, onApply, onQuarantine, onSafeAsk, onSafeCancel, onSafeRun,
        onCatFilter, onSelectGroup, onToggleLogs, onToggleScope, onAiAsk, onAiPick, onAiAdopt, onAiDismiss,
      } = props;

      const st = clean && typeof clean === 'object' ? clean : {};
      const phase = String(st.phase || 'idle');
      const logsArr = Array.isArray(logs) ? logs : [];
      const unfArr = Array.isArray(unfinished) ? unfinished : [];
      const scope = scanScope(rules);
      const sc = scanCells(st);
      const planObj = plan && typeof plan === 'object' && Array.isArray(plan.items) ? plan : null;
      const totals = planObj ? selTotals(planObj, sel) : { n: 0, bytes: 0, bytesText: '—', selectable: [], risky: 0, rejected: 0, cleanable: 0, riskySelected: 0 };
      const rows = planObj ? planRows(planObj, sel) : [];
      const allState = planObj ? selectAllState(planObj, sel) : 'none';
      const allTargetCount = planObj ? selectAllIds(planObj).length : 0;
      // 一键安全清理（S11-②）的范围：清单里标「可清理」的那批（未拒且非 mid），与表头全选不同口径
      const safeIds = planObj ? safeCleanIds(planObj) : [];
      const safeTotals = planObj ? selTotals(planObj, safeIds) : { n: 0, bytesText: '—' };
      // S12-A 概览与分组：可腾出合计 = 「未拒项全选」的大小合计（复用 selTotals，不另算一份字节加法）
      const dv = diskOverview(latest, planObj);
      const planAll = planObj ? selTotals(planObj, selectAllIds(planObj)) : null;
      const groups = planObj ? categoryGroups(planObj, sel) : [];
      // 筛选键必须在当前这批分组里对得上号才算「正在筛选」：换一轮扫描后规则名可能整个变掉，
      // 拿着旧键既筛不出行（visibleIds 退回 null、表里是全量），又会在下面写出
      // 「正在只看「旧类名」：表里 N 行」这种和画面相反的话。
      const curGroup = groups.find((g) => g.key === String(catFilter || '')) || null;
      const filterKey = curGroup ? curGroup.key : '';
      const visibleIds = curGroup ? new Set(curGroup.ids) : null;
      const shownRows = visibleIds ? rows.filter((r) => visibleIds.has(r.id)) : rows;
      const execBusy = Boolean(exec && exec.phase === 'running');
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

      const writeDisabled = totals.selectable.length === 0 || capsRO === true || execBusy;
      const writeWhy = capsRO === true ? '配置只读：宿主未提供 storageDomain'
        : (execBusy ? '本次清理正在执行，逐条结果在下面' : (totals.selectable.length === 0 ? '勾选至少一项后才可执行' : ''));

      /**
       * 执行进度面板（S11-②「清理过程要有动画展」）：数据全部来自宿主的逐条 `clean:item` 帧
       * （lib/clean/executor.js 每处理一条打一帧），页面只做累加与展示，不自报进度。
       * 就地落在清单卡内部，不是浮层（spec §4 的硬约束）；执行中禁用操作条上的两颗写按钮，防二次提交。
       */
      const execPanel = (run) => {
        if (!run) return null;
        const c = execCells(run);
        const running = run.phase === 'running';
        const pillOf = (s) => (s === 'ok' ? ['so-pill-down', '已删']
          : s === 'skipped' ? ['so-pill-amber', '跳过']
            : s === 'failed' ? ['so-pill-red', '失败'] : ['so-pill-red', '拒绝']);
        return h('div', { className: 'so-run ' + (running ? 'is-running' : 'is-done') },
          h('div', { className: 'so-run-h' },
            h('span', { className: 'so-run-dot' }),
            h('b', null, running ? '正在清理' : '本次清理已收尾'),
            h('span', { className: 'so-num' }, c ? c.line : ''),
            h('span', { className: 'so-grow' }),
            h('span', { className: 'so-num so-hint' }, c ? `已用 ${c.elapsed} 秒` : '')),
          h('div', { className: 'so-track' + (c && c.pct === null ? ' is-indeterminate' : ''), style: { marginTop: 6 } },
            c && c.pct !== null ? h('i', { style: { width: Math.max(0, Math.min(100, c.pct)) + '%' } }) : null),
          // S12-A 收尾对比：可用容量前后两端 + 释放量。文案直接取 logRow 的同一份口径
          // （留痕行与这里必须逐字同形，否则用户会以为是两个不同的数）。summary 来自 POST /clean/apply 的响应。
          !running && run.summary && typeof run.summary === 'object'
            ? h('div', { className: 'so-num', style: { marginTop: 6 } }, logRow(run.summary).snapshot)
            : null,
          running && run.currentPath ? h('div', { className: 'so-hint so-path', style: { marginTop: 6 }, title: run.currentPath }, run.currentPath) : null,
          run.results.length > 0
            ? h('ul', { className: 'so-run-list' }, run.results.map((r, i) => h('li', { key: String(r.id) + '-' + i },
                h(Pill, { cls: pillOf(r.state)[0] }, pillOf(r.state)[1]),
                h('span', { className: 'so-path', title: r.path }, r.path),
                r.why ? h('span', { className: 'so-hint' }, r.why) : null)))
            : null,
          running ? h('div', { className: 'so-hint', style: { marginTop: 6 } }, '逐条删除正在进行：被应用锁住的条目会记为「跳过」，不会被强删。') : null);
      };

      /**
       * AI 建议面板（S12-③，审批口径「只推荐 + 就地确认，不自动执行」）：
       * 就地落在清单卡内部（spec §4 零浮层）。每一行只有一个「采纳」勾选框 —— 它把该类条目并进
       * 表里的勾选集合，**不发起任何删除**；动手仍然只有「一键安全清理 / 清理选中」那两条路，
       * 后面还有 guard 与冻结快照两道宿主闸。
       * 清单换过后（本次建议的 planId 与当前快照 planId 不一致）整块不渲染：旧建议不配贴在新清单上。
       */
      const aiPanel = () => {
        if (!aiRun) return null;
        const rp = String(aiRun.phase || 'idle');
        if (rp === 'idle') return null;
        if (!planObj || String(aiRun.planId ?? '') !== String(planObj.planId ?? '')) return null;
        const ready = ai && typeof ai === 'object' ? ai : null;
        const modelText = (o) => {
          const p = String(o?.provider ?? ''), m = String(o?.model ?? o?.modelName ?? '');
          return p || m ? [p || '宿主默认', m || '—'].join(' / ') : '';
        };
        if (rp === 'running') {
          return h('div', { className: 'so-card-b so-ai is-running' },
            h('div', { className: 'so-aihead' },
              h('span', { className: 'so-run-dot' }),
              h('b', null, '正在请宿主模型判定'),
              h('span', { className: 'so-grow' }),
              h('span', { className: 'so-num so-hint' }, modelText(ready))),
            h('div', { className: 'so-hint' }, '本次交给模型的是分类汇总与文件名（不含完整路径、不含你的勾选）。它只给建议，删不删还是你点。'));
        }
        if (rp === 'error') {
          const e = aiRun.error && typeof aiRun.error === 'object' ? aiRun.error : {};
          return h('div', { className: 'so-card-b so-ai is-error' },
            h(Notice, { tone: 'red' }, `征求 AI 建议失败（${String(e.code || 'UNKNOWN')}）：${String(e.message || '未知错误')}`),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: () => { if (onAiAsk) onAiAsk(); } }, '再问一次'),
              h('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: () => { if (onAiDismiss) onAiDismiss(); } }, '收起')));
        }
        const res = aiRun.result && typeof aiRun.result === 'object' ? aiRun.result : {};
        const recs = aiRecommendations(aiRun);
        const picked = aiRun.picked instanceof Set ? aiRun.picked : new Set(Array.isArray(aiRun.picked) ? aiRun.picked : []);
        // stagedN = 采纳框现在圈住多少项（还没并进勾选）；committedN = 已经并进勾选多少项。
        // 两者分开写：把「想采纳」显示成「已采纳」是这一页最不该撒的谎。
        const stagedN = aiAdoptIds(aiRun).length;
        const committedN = num(aiRun.adoptedN) ?? 0;
        const dropN = num(res.dropped?.count ?? res.dropped) ?? 0;
        return h('div', { className: 'so-card-b so-ai is-done' },
          h('div', { className: 'so-aihead' },
            h('b', null, 'AI 建议'),
            h('span', { className: 'so-num so-hint' }, modelText(res)),
            h('span', { className: 'so-num so-hint' }, `判定 ${recs.length} 类`),
            h('span', { className: 'so-grow' }),
            h('span', { className: 'so-num so-hint' }, stamp(res.at))),
          recs.length === 0
            ? h(Notice, { tone: 'amber' }, '模型这次没有给出可用的分类建议（回话里没有能对上清单的行）。清单照旧，可手工勾选后执行。')
            : h('ul', { className: 'so-ailist' }, recs.map((rec, i) => h('li', { key: String(rec.group) + '-' + i, className: 'so-airow' },
              h('button', {
                type: 'button', className: 'so-check', role: 'checkbox',
                'aria-checked': picked.has(rec.group) ? 'true' : 'false',
                disabled: rec.ids.length === 0 || execBusy,
                title: rec.ids.length === 0 ? '这一类没有可勾选的条目（可能全被 guard 拒绝）'
                  : (picked.has(rec.group) ? '取消采纳，把这 ' + rec.ids.length + ' 项从勾选里退回'
                    : `把这一类的 ${rec.ids.length} 项并进勾选（只是勾选，不是删除）`),
                onClick: () => { if (onAiPick) onAiPick(rec.group, !picked.has(rec.group), rec.ids); },
              }, picked.has(rec.group) ? '✓' : ''),
              h(Pill, { cls: rec.cell.cls }, rec.cell.label),
              h('span', { className: 'so-ainame' }, rec.ruleName + (rec.kind ? `（${rec.kind}）` : '')),
              h('span', { className: 'so-num so-hint' },
                `${rec.count} 项 · ${rec.bytesText} · 可清理 ${rec.cleanable}` + (rec.risky ? ` · 有风险 ${rec.risky}` : '')),
              rec.reason ? h('div', { className: 'so-aireason' }, rec.reason) : null))),
          res.note ? h(Notice, { tone: 'amber' }, `本次判定如实交代：${String(res.note)}`) : null,
          dropN > 0 ? h(Notice, { tone: 'amber' }, `模型回话里有 ${dropN} 行对不上清单（分类越界 / 动作不在三档 / 重复），已按不采纳处理。`) : null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
            h('button', {
              type: 'button', className: 'so-btn so-btn-sm so-btn-primary',
              disabled: stagedN === 0 || capsRO === true || execBusy,
              title: capsRO === true ? '配置只读：宿主未提供 storageDomain'
                : (execBusy ? '本次清理正在执行' : (stagedN === 0 ? '先勾上想采纳的分类' : `把已勾分类的 ${stagedN} 项并进清单勾选（不删除任何东西）`)),
              onClick: () => { if (onAiAdopt) onAiAdopt(); },
            }, `采纳 ${stagedN} 项到勾选`),
            h('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: () => { if (onAiDismiss) onAiDismiss(); } }, '收起建议'),
            h('span', { className: 'so-grow' }),
            h('span', { className: 'so-num so-hint' },
              `本次输入 ${num(res.promptChars) ?? 0} 字 · 摘要 ${String(res.promptHash ?? '—')}${res.groupsSent && res.groupsTotal ? ` · 送出 ${res.groupsSent}/${res.groupsTotal} 类` : ''}`)),
          committedN > 0 ? h('div', { className: 'so-hint', style: { marginTop: 4 } },
            `已把 ${committedN} 项并入勾选（建议本身不进留痕，留痕记的是执行）：复核后点上面「清理选中」才会动手。`) : null,
          h('div', { className: 'so-hint', style: { marginTop: 4 } }, '模型只看到分类汇总与文件名，看不到完整路径；它不执行、也不放宽 guard 的任何一条红线。'));
      };

      /**
       * 容量概览条（S12-A，对齐主流清理工具的「先看盘再看清单」）：
       * 三个数三个出处 —— 可用/总量来自监控快照，「扫描那一刻可用」来自冻结快照的 beforeFree，
       * 「本清单可腾出」来自条目大小合计。页面**不做加减**：不推算「清完会有多少」，
       * 那个数只有执行后现读的 afterFree 才算数（见上面的收尾对比与下面的留痕）。
       */
      const diskBar = h('div', { className: 'so-disk' },
        h('span', null, '系统盘 C: 可用'),
        h('b', { className: 'so-num' }, dv.freeText),
        h('span', { className: 'so-num' }, dv.totalText === '—' ? '总容量未知' : `/ 共 ${dv.totalText}`),
        h('div', { className: 'so-track' + (dv.cls ? ' is-' + dv.cls : '') },
          dv.usedPct === null ? null : h('i', { style: { width: Math.max(0, Math.min(100, dv.usedPct)) + '%' } })),
        h('span', { className: 'so-num' }, dv.usedPct === null ? '' : `已用 ${dv.usedPct}%`),
        planObj && planAll ? h('b', { className: 'so-num' }, `本清单可腾出 ${planAll.bytesText}`) : null,
        planObj ? h('span', { className: 'so-num so-hint' }, `扫描那一刻可用 ${dv.beforeText}`) : null,
        dv.note ? h('span', { className: 'so-hint' }, dv.note) : null);

      /**
       * 分类下拉（S19-①，真机批注「这些不要放在这里，放在全部分类那里使用下拉选择」）：
       * 原来六颗 chip 各带一句读数，在 4709 项那一屏摊成五行高，把清单表本身顶到第二屏。
       * 收成一行 ≠ 删掉：每个 option 里仍是「类名 · 项数 · 大小 · 可清理 · 有风险 · 已拒绝」，
       * 读数一字不丢，只是从「常驻可见」变成「点开可见」。
       * 「全选本组」跟着下拉当前那一格走 —— 选「全部分类」时它没有作用对象（整份清单的全选
       * 是表头那颗框），就地禁用并说清为什么，不悄悄改成对全组生效。
       * 点选只**筛选**下面的表：勾选状态一字不动（S12-A 的口径原样搬过来）。
       */
      const catBar = groups.length === 0 ? null : h('div', { className: 'so-card-b so-catbar' },
        h('span', { className: 'so-cat-lb' }, '分类'),
        h('select', {
          className: 'so-cat-select',
          value: filterKey,
          'aria-label': '按分类筛选清单',
          title: '选一个分类只看它，选「全部分类」看全部。筛选只减表里的行，勾选状态一字不动。',
          onChange: (e) => { if (onCatFilter) onCatFilter(e && e.target && e.target.value ? e.target.value : null); },
        },
          h('option', { key: '', value: '' }, `全部分类（${groups.length} 组 · ${planObj.items.length} 项）`),
          groups.map((g) => h('option', { key: g.key, value: g.key },
            `${g.key} · ${g.count} 项 · ${g.bytesText} · 可清理 ${g.cleanable}`
            + (g.risky ? ` · 有风险 ${g.risky}` : '') + (g.rejected ? ` · 已拒绝 ${g.rejected}` : '')))),
        h('button', {
          type: 'button', className: 'so-btn so-btn-sm',
          disabled: !curGroup || curGroup.selectable.length === 0 || capsRO === true || execBusy,
          title: capsRO === true ? '配置只读：宿主未提供 storageDomain'
            : (execBusy ? '本次清理正在执行'
              : (!curGroup ? '先在左边选一个分类，「全选本组」才有作用对象；整份清单的全选用表头那颗框'
                : (curGroup.selectable.length === 0
                  ? `本组 ${curGroup.count} 项都被 guard 拒绝了，没有可勾选项`
                  : `把本组未拒的 ${curGroup.selectable.length} 项加进勾选（已勾 ${curGroup.selected} 项）`))),
          onClick: () => { if (curGroup && onSelectGroup) onSelectGroup(curGroup.selectable); },
        }, !curGroup ? '全选本组' : (curGroup.allSelected ? '本组已全选' : `全选本组 ${curGroup.selectable.length}`)),
        curGroup ? h('span', { className: 'so-hint' },
          `正在只看「${curGroup.key}」：表里 ${shownRows.length} 行，其余 ${planObj.items.length - shownRows.length} 项仍在清单里、勾选状态没变（上方「已选 N 项」与执行按钮吃的都是整份清单的勾选）。`) : null);

      /**
       * 操作条（S19-②，真机批注「不要放在最下面，放在上面」）：清单表在卡内限高滚动，
       * 但它下面还压着这一条 + 暂存区交代，4709 项那一屏要滚到卡尾才够得着「清理选中」。
       * 移到卡头正下方：先看值不值得动手（已选几项 / 预计释放多少），再决定动不动手。
       * S20（真机批注「这些不要了」）：这一条上原来还挂着三句说明 —— 「删除不可恢复，回收站不参与」/
       * 「已默认勾上 N 项…」/「执行方式取自快照 modeDefault…」，全部删净。三句各自都有别的落点兜着：
       * 不可恢复与「跳过」在两颗写按钮的 title（writeWhy / 表头三态框），默认勾选那批的来路在卡头那行
       * 「共 N 项 · 可清理 · 有风险 · 已拒绝」，操作条只留「读数 + 按钮」两样东西。
       */
      const totBar = planObj ? h('div', { className: 'so-tot' },
        h('span', { className: 'so-sum' }, `已选 ${totals.n} 项 · 预计释放 ${totals.bytesText}`),
        totals.riskySelected > 0 ? h('span', { className: 'so-hint' }, `含 ${totals.riskySelected} 项有风险：被应用锁住的文件会被跳过，不会被强删`) : null,
        capsRO === true ? h('span', { className: 'so-hint' }, '配置只读：宿主未提供 storageDomain，两个写按钮已禁用') : null,
        h('span', { className: 'so-grow' },
          h('button', { type: 'button', className: 'so-btn so-btn-sm', disabled: writeDisabled, title: writeWhy,
            onClick: () => onQuarantine && onQuarantine(totals.selectable) }, '隔离到暂存目录'),
          h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-primary', disabled: writeDisabled, title: writeWhy,
            onClick: () => onApply && onApply(totals.selectable, planObj.modeDefault || 'delete-file') }, '清理选中'))) : null;

      // —— 主卡四分支：scanning / 清单 / 失效 / 空态 ——
      let main;
      if (phase === 'scanning') {
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '扫描进度'), h('span', { className: 'so-hsub' }, sc.phase),
            h('span', { className: 'so-grow so-num' }, sc.ruleText),
            h('span', { className: 'so-num' },
              sc.elapsed !== null ? `已用时 ${sc.elapsed} 秒` : (sc.pct === null ? '进度未知' : `${sc.pct}%`))),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-curve-cap' }, h('h3', null, '正在遍历'), h('span', { className: 'so-grow so-path' }, sc.cur || '…')),
            h('div', { className: 'so-hint so-num' }, `已遍历 ${sc.walked} 个条目 · 已发现 ${sc.found} 项 · ${sc.size}`),
            h('div', { className: 'so-track' + (sc.pct === null ? ' is-indeterminate' : ''), style: { marginTop: 8 } },
              h('i', sc.pct === null ? null : { style: { width: Math.max(0, Math.min(100, sc.pct)) + '%' } })),
            h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { type: 'button', className: 'so-btn so-btn-sm', disabled: st.stopped === true, onClick: () => onStopScan && onStopScan() }, '停止扫描'),
              h('span', { className: 'so-hint' }, '扫描可随时中断，中断后已发现的部分仍可继续查看。进度条走的是「扫完几类目录 / 共几类」，不是字节进度，真实完成以扫描结束为准。')),
            sc.note ? h(Notice, { tone: 'amber' }, `本次扫描如实降级：${sc.note}`) : null,
            errForScope ? null : errNotice));
      } else if (planObj) {
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' },
            h('h2', null, '待清理清单'),
            h('span', { className: 'so-hsub' }, `快照生成于 ${stamp(planObj.at)} · 数据在扫描那一刻冻结 · ${sc.phase}`),
            // S10-③/④：两个全选/清空按钮换成表头全选框（用户批注「不要了」+「加一个全选框」），
            // 卡头改报三类计数 —— 「哪些能清理、哪些有风险」在卡头就一眼可答。
            h('span', { className: 'so-grow' },
              h('span', { className: 'so-hint so-num' },
                `共 ${planObj.items.length} 项 · 可清理 ${totals.cleanable} · 有风险 ${totals.risky} · 已拒绝 ${totals.rejected}`)),
            // 一键安全清理（S11-②，用户红框批注「增加一键清理按钮，可安全清理，清理过程要有动画展」）：
            // 只吃「可清理」集合，点下先落一条就地确认行（spec §4 禁浮层，宿主侧还有 guard 与快照两道闸）。
            h('button', {
              type: 'button', className: 'so-btn so-btn-sm so-btn-primary',
              disabled: safeIds.length === 0 || capsRO === true || execBusy,
              title: capsRO === true ? '配置只读：宿主未提供 storageDomain'
                : (execBusy ? '本次清理正在执行' : (safeIds.length === 0 ? '本次清单没有「可清理」档的条目，请勾选项后用上面的「清理选中」' : `只清理标「可清理」的 ${safeIds.length} 项（${safeTotals.bytesText}），有风险与已拒绝的都不动`)),
              onClick: () => { if (onSafeAsk) onSafeAsk(); },
            }, `一键安全清理 ${safeIds.length} 项`),
            // AI 智能清理（S12-③，用户红框批注「增加AI智能清理」）：与面板同吃一份 aiButton 读数；
            // 亮不起来时把原因就地写在按钮旁（spec 的诚实降级：不让人反复点一颗没反应的按钮）。
            (() => {
              const b = aiButton({ ready: ai, run: aiRun, hasPlan: Boolean(planObj), execBusy });
              const quiet = !aiRun || String(aiRun.phase || 'idle') === 'idle';
              return h('span', { className: 'so-ask-btn' },
                (b.disabled && b.why && quiet) ? h('span', { className: 'so-hint' }, b.why) : null,
                h('button', {
                  type: 'button', className: 'so-btn so-btn-sm' + (b.disabled ? '' : ' so-btn-primary'),
                  disabled: b.disabled, title: b.why, onClick: () => { if (onAiAsk) onAiAsk(); },
                }, b.label));
            })()),
          totBar,
          aiPanel(),
          // 就地确认行（不是弹窗）：说清范围、数量、不可恢复，确认后才发 POST
          safeAsk && !execBusy ? h('div', { className: 'so-card-b' },
            h(Notice, { tone: 'amber' },
              `将永久删除 ${safeIds.length} 项「可清理」（预计 ${safeTotals.bytesText}）：只动风险表判为低风险的那些，标「有风险」的 ${totals.risky} 项与「已拒绝」的 ${totals.rejected} 项一概不动；回收站不参与，删掉不可恢复。`),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-primary', onClick: () => { if (onSafeRun) onSafeRun(safeIds, planObj.modeDefault || 'delete-file'); } }, '确认清理'),
              h('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: () => { if (onSafeCancel) onSafeCancel(); } }, '取消'))) : null,
          execPanel(exec),
          unfArr.length ? h('div', { className: 'so-card-b' }, unfArr.map((u) => h(Notice, { key: String(u.logId ?? ''), tone: 'amber' },
            `上次执行未确认完成：留痕 ${String(u.logId ?? '')} 开了头没写完成（模式 ${modeLabel(u.mode)}${unfProgress(u)}）—— 执行对象只认那份冻结清单，请点页头的「清理留痕」展开记录核对磁盘现状。`))) : null,
          sc.note ? h('div', { className: 'so-card-b' }, h(Notice, { tone: 'amber' },
            `这份清单如实降级：${sc.note}${st.stopped === true ? '（扫描是被停止的，未遍历到的目录不在清单里）' : ''}`)) : null,
          catBar,
          h('div', { className: 'so-tblwrap so-tblwrap-plan' },
            h('table', { className: 'so-tbl' },
              h('thead', null, h('tr', null,
                h('th', { className: 'so-c' }, h('button', {
                  type: 'button', className: 'so-check', role: 'checkbox',
                  'aria-checked': allState === 'all' ? 'true' : (allState === 'some' ? 'mixed' : 'false'),
                  disabled: allTargetCount === 0,
                  title: allState === 'all' ? '取消全选'
                    : `全选可执行的 ${allTargetCount} 项${totals.risky > 0 ? `（含 ${totals.risky} 项有风险：被应用锁住的文件会被跳过）` : ''}`,
                  onClick: () => { if (onToggleAll) onToggleAll(); },
                }, allState === 'all' ? '✓' : (allState === 'some' ? '−' : ''))),
                PLAN_COLS.map((c) => h('th', { key: c, className: (c === '大小' || c === '最后访问') ? 'so-r' : '' }, c)))),
              h('tbody', null, shownRows.map((r, i) => h('tr', { key: r.id },
                h('td', { className: 'so-c' }, h('button', {
                  type: 'button', className: 'so-check', role: 'checkbox',
                  'aria-checked': r.checked ? 'true' : 'false', disabled: r.disabled,
                  title: r.disabled ? `guard 拒绝：${r.why}` : (r.why || (r.checked ? '取消勾选' : '勾选此项')),
                  onClick: () => { if (!r.disabled && onToggle) onToggle(r.id, !r.checked); },
                }, r.checked ? '✓' : '')),
                h('td', null, h('div', { className: 'so-path' }, r.path),
                  r.count > 0 ? h('div', { className: 'so-hint' }, `共 ${r.count} 个文件`) : null),
                h('td', { className: 'so-r so-num' }, r.sizeText),
                h('td', null, r.ruleName),
                h('td', { className: 'so-r so-num' }, r.accText),
                h('td', null,
                  h(Pill, { cls: r.riskCls }, r.riskPill),
                  r.why ? h('div', { className: 'so-hint' }, r.why) : null))))),
            ),
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
            // 执行面板留在终态卡上：动画收尾后的最后几条结果要能回看，不能一执行完就凭空消失
            execPanel(exec),
            h('div', { className: 'so-hint', style: { marginTop: 6 } }, '清单是扫描那一刻的冻结快照：执行完就作废，改勾选或再清别的都必须重新扫描（入口在右上角）。'),
            errForScope ? null : errNotice));
      } else {
        // S13（用户批注「占地方又没用」）：空态从 26px 居中的大空白压成一行 —— 一句话把
        // 「去哪儿扫」「扫描危不危险」说完，不再单占半屏。错误条仍在这张卡里，出错不许藏。
        main = h('div', { className: 'so-card' },
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-hint' },
              '尚未扫描。点击右上角', h('b', null, '「开始扫描」'), '生成待清理清单；',
              '扫描是只读的（只统计大小与访问时间），删除只发生在你勾选之后点「清理选中」那一刻。'),
            st.error ? h(Notice, { tone: 'red' }, `扫描失败：${String(st.error)}`) : null,
            errForScope ? null : errNotice));
      }

      // S12-①：留痕从页面底部那张常驻卡改成「页头入口 + 就地展开面板」（用户批注「清理留痕不要放在这里」「放这里，点击弹框滚动查看」）。
      // 展开的是页面里的一个限高滚动框，不是浮层 —— spec §4 的零 toast/modal 没有放宽；滚动只在这一个框内（S10 同规）。
      const logsCard = () => h('div', { className: 'so-card' },
        h('div', { className: 'so-card-h' },
          h('h2', null, '清理留痕'),
          h('span', { className: 'so-hsub' }, '追加式，只读 · 滚动只在这个框内'),
          h('span', { className: 'so-grow so-hint so-num' }, `${logsArr.length} 段记录`),
          h('button', {
            type: 'button', className: 'so-btn so-btn-sm',
            title: '收起这块留痕（入口在页头右上角）',
            onClick: () => { if (onToggleLogs) onToggleLogs(); },
          }, '收起')),
        h('div', { className: 'so-logpanel' }, logsArr.length ? logsArr.map((lg, i) => {
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
        }) : h('div', { className: 'so-empty' }, '还没有清理记录：执行一次清理后会在这里追加一条可展开的记录（追加式，只读）。')));

      return h('div', { className: 'so-tabpanel' },
        logsOpen ? logsCard() : null,
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' },
            h('h2', null, '扫描范围'),
            h('span', { className: 'so-hsub' }, scopeSummary(scope)),
            h('span', { className: 'so-grow' },
              // S12-②：SSE 是健康态，不需要每屏都报一句「推送通道 SSE」（用户批注「这几个不要展示」）。
              // 只有真的掉到轮询/还在重连时才亮 —— 降级必须如实标注，那条约束不动。
              link === 'sse' ? null : h(Pill, { cls: 'so-pill-amber' }, link === 'polling' ? '降级：轮询 2s' : '重连中'),
              // S13（用户批注「占地方又没用，只显示关注的东西」）：明细整块收成上面那一行，
              // 点「展开明细」就地摊开这一块 —— 和留痕面板同一套交互，页面内展开，零浮层（spec §4）。
              h('button', {
                type: 'button', className: 'so-btn so-btn-sm',
                'aria-expanded': scopeOpen ? 'true' : 'false',
                title: scopeOpen ? '收起明细，只留上面那一行摘要'
                  : (scope.total > 0 ? `展开明细：逐条列出这 ${scope.total} 类目录` : '展开明细：查看扫描范围的口径说明'),
                onClick: () => { if (onToggleScope) onToggleScope(); },
              }, scopeOpen ? '收起明细' : '展开明细'))),
          // 摘要那行报数，这句报「数为什么是这样」—— 收起态也留在页面上（诚实降级，不许藏在展开后面）
          scopeNote(scope) ? h('div', { className: 'so-card-b' }, h('div', { className: 'so-hint' }, scopeNote(scope))) : null,
          scopeOpen ? h('div', { className: 'so-card-b' },
            // 「到底扫了哪些目录」逐条列出来（S12-① 的问题①）：一条内置规则一行，路径只出宿主给的 rel
            scope.total > 0 ? h('div', { className: 'so-scope' }, [
              ...scope.on.map((r) => h('div', { key: 'b-' + r.key, className: 'so-scope-row' },
                h('b', null, r.n || r.rel),
                h('span', { className: 'so-path', title: '~/' + r.rel }, '~/' + r.rel),
                h('span', { className: 'so-when' }, r.ageDays === null ? r.kind : `${r.kind} · 满 ${r.ageDays} 天`))),
              ...scope.user.map((r) => h('div', { key: 'u-' + String(r.id ?? r.n), className: 'so-scope-row' },
                h('b', null, String(r.n ?? '自建规则')),
                h('span', { className: 'so-when' }, `${String(r.kind ?? '自定义')} · 路径在宿主侧展开`))),
            ]) : null,
            scope.off.length ? h('div', { className: 'so-hint', style: { marginTop: 7 } },
              `已停用的内置规则 ${scope.off.length} 条、不在本次范围：${scope.off.map((o) => o.n || o.key).join('、')}`) : null,
            h('div', { className: 'so-hint', style: { marginTop: scope.total > 0 || scope.off.length ? 7 : 0 } },
              '「满 N 天」是按最后访问时间算的候选门槛（整条目录树都够老才进清单）；'
              + '本机上不存在的目录会被如实跳过、不编进清单，跳过几条写在扫描结束后的那条提示里。')) : null,
          errForScope ? h('div', { className: 'so-card-b' }, errNotice) : null),
        diskBar,
        main,
        // S12-②：红线那条琥珀提示从「扫描范围」卡里挪到页面最下面（用户批注「放在最下面展示」）。
        // 它是全页唯一的裁决说明，挂在哪张卡上都会被抓成那张卡的私事。
        h(Notice, { tone: 'amber' }, '红线由服务端 guard 单点裁决：系统目录 / 回收站 / Program Files、属主与 ACL、注册表一律不参与清理，客户端不复制也不放宽这套判定。命中红线的条目会被标为「已拒绝」，不进入可选集合。'));
    }

    /**
     * 搜索页（Task 23）：搜索框 → 结果表 → 三级自检 → 引导卡（未就绪时）。
     * 卡序按真机反馈调过：搜索输入区排第一（进页面就能打字），自检/引导是说明区、降到后面；
     * 通路选择（全盘索引 / 限定目录）与覆盖范围仍长在搜索卡里，不另起一张卡。
     * 与 MonitorPage / CleanPage 同规：自身零 useState，数据与写操作全由 useStream 侧传下来。
     */
    function SearchPage(props = {}) {
      const { probe = null, res = null, mode = 'walk', limit = LIMITS[1], q = '', dirs = [], err = null,
        dirsNote = null, saving = false,
        installReady = null, installJob = null, installNote = null, installAsk = false,
        onSearch, onMode, onLimit, onReprobe, onAddDir, onDelDir, onInstallAsk, onInstallCancel, onInstallRun } = props;
      const dirRef = useRef(null);
      const qRef = useRef(null);
      const p = probe || {};
      const ready = p.ready === true;
      const effMode = modeOf(p, mode);
      const why = modeWhy(p);
      const port = num((cfg().defaults || {}).searchPort);
      const adv = advice();
      const cells = probeCells(p);
      const ib = installButton({ probe: p, ready: installReady, job: installJob, busy: saving });
      const degrade = searchDegrade(res);
      const head = res ? resultHead(res) : null;
      const rows = res ? rowCells(res) : [];
      // 目录覆盖范围写 prefs，没有 storageDomain 就写不进去：chips 改只读 + 注明原因（I-6：三页同一个 capsReadOnly 判定）
      const dirsReadOnly = capsReadOnly(cfg().capabilities || {});

      // 卡序（真机反馈「搜索这个位置放得太下了，看不到」）：输入框排第一 —— 进页面第一眼就能打字；
      // 自检与引导是「搜不了或搜得慢时才该看」的说明区，降到结果之后。
      // S12-④：点按钮与按回车走**同一个** submit（两条路必须同规）。清空输入框只在宿主确认写入
      // 之后做 —— 没写进去时把那行字留着，用户看得见自己刚输了什么。
      function submitDir() {
        if (saving) return undefined;
        const raw = dirRef.current && typeof dirRef.current.value === 'string' ? dirRef.current.value : '';
        const r = onAddDir && onAddDir(raw.trim());
        if (!r || typeof r.then !== 'function') return r;
        return r.then((wrote) => {
          // ok=true 才清（含"已经是那一条"）：没写进去/输入为空时把字留着，用户看得见自己输了什么
          if (wrote && wrote.ok && dirRef.current) dirRef.current.value = '';
        });
      }

      const selfCheckCard = h('div', { className: 'so-card' },
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
              h('span', { className: 'so-rt so-num' }, c.mark))))));
      const guideCard = ready ? null : h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, SEARCH_TXT.guideTitle)),
          h('div', { className: 'so-card-b' },
            // S12-⑤（用户批注「自检卡加 Everything 一键安装按钮」）：按钮长在引导卡第一行 ——
            // 这张卡就是"拿不到全盘索引时该看的那张"，把安装入口放在它顶上才不用人往下找。
            // 亮不起来时原因就写在按钮旁边（已批口径：探不到 winget 就不亮按钮），不让人反复点一颗闷按钮。
            ib.show ? h('div', { style: { marginBottom: 10 } },
              h('span', { className: 'so-ask-btn' },
                (ib.disabled && ib.why) ? h('span', { className: 'so-hint' }, ib.why) : null,
                h('button', {
                  type: 'button', className: 'so-btn so-btn-sm' + (ib.disabled ? '' : ' so-btn-primary'),
                  disabled: ib.disabled, title: ib.why,
                  onClick: () => { if (onInstallAsk) onInstallAsk(); },
                }, ib.label)),
              // 就地确认行（不是弹窗）：把**将要执行的那一条命令**原样摆出来，确认才发 POST
              (installAsk && !ib.disabled) ? h('div', { style: { marginTop: 6 } },
                h(Notice, { tone: 'amber' },
                  '将执行：', h('span', { className: 'so-input-mono' }, String((installReady || {}).command || '')),
                  '。这是本插件唯一会改动本机状态的动作之一：只从 winget 官方源装这一个包，UAC 与安装窗口要你自己同意（插件不代点），不写注册表，装完也不替你打开 Everything 的 HTTP 服务器。点「取消」则什么都没发生。'),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  h('button', { type: 'button', className: 'so-btn so-btn-sm so-btn-primary', disabled: saving,
                    onClick: () => { if (onInstallRun) onInstallRun(); } }, SEARCH_TXT.installConfirm),
                  h('button', { type: 'button', className: 'so-btn so-btn-sm', onClick: () => { if (onInstallCancel) onInstallCancel(); } }, SEARCH_TXT.installCancel))) : null) : null,
            // 交代行**不跟着按钮一起收起**：装成功那一瞬 ① 翻绿 ⇒ 按钮整块 hide（pg3-4 ⑥ 的口径），
            // 可「装完了但②还没通」这句恰恰是那时候唯一要看的话 —— 挂在按钮里就会在它该出现的那一刻消失。
            installNote ? h('div', { className: `so-savenote so-savenote-${installNote.tone === 'bad' ? 'bad' : 'ok'}` }, installNote.text) : null,
            h('div', { className: 'so-hint' }, SEARCH_TXT.guideLead),
            h('div', { className: 'so-hint', style: { marginTop: 8 } }, SEARCH_TXT.guideOwn),
            adv.length ? h('div', { className: 'so-snap', style: { marginTop: 8 } },
              adv.map((line, i) => h('div', { key: String(i), className: 'so-input-mono so-num' }, line))) : null,
            h('div', { className: 'so-hint', style: { marginTop: 9 } },
              SEARCH_TXT.guidePortA, h('span', { className: 'so-num' }, port === null ? '—' : String(port)), SEARCH_TXT.guidePortB)));

      return h('div', { className: 'so-tabpanel' },
        err ? h(Notice, { tone: 'amber' }, `接口异常（${err.code || 'UNKNOWN'}）：${err.message || '未知错误'}`) : null,
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '搜索'),
            h('span', { className: 'so-grow' },
              h('span', { className: 'so-seg' },
                h('button', { type: 'button', className: effMode === 'everything' ? 'is-active' : '',
                  'aria-pressed': effMode === 'everything' ? 'true' : 'false',
                  disabled: !ready || saving, title: why || '用 Everything 的全盘索引查询（选完会写进偏好 search.mode）',
                  onClick: () => onMode && onMode('everything') }, '全盘索引'),
                h('button', { type: 'button', className: effMode === 'walk' ? 'is-active' : '',
                  'aria-pressed': effMode === 'walk' ? 'true' : 'false',
                  disabled: saving, title: '只在已选目录里遍历（选完会写进偏好 search.mode）',
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
                disabled: saving, onChange: (v) => onLimit && onLimit(v) }),
              h('span', { className: 'so-hint', style: { marginLeft: 'auto' } }, SEARCH_TXT.tokenHint)),
            effMode === 'walk' ? h(Notice, { tone: 'amber' }, h('span', null, SEARCH_TXT.walkA), h('span', null, SEARCH_TXT.walkB)) : null,
            effMode === 'walk' ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 } },
              (Array.isArray(dirs) ? dirs : []).map((d) => h(Pill, { key: String(d), cls: 'so-pill-line' },
                h('span', { className: 'so-path' }, String(d)),
                dirsReadOnly ? null : h('button', { type: 'button', className: 'so-btn so-btn-quiet so-btn-sm',
                  disabled: saving,
                  title: '把该目录移出覆盖范围', onClick: () => onDelDir && onDelDir(String(d)) }, '×'))),
              dirsReadOnly
                ? h('span', { className: 'so-hint' }, '配置只读：宿主未提供 storageDomain，覆盖范围不可改')
                : h('span', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                    h('input', { className: 'so-input so-input-mono', type: 'text', placeholder: SEARCH_TXT.dirHint, ref: dirRef,
                      disabled: saving, style: { height: 26, width: 260 },
                      onKeyDown: (e) => { if (e && e.key === 'Enter') { e.preventDefault(); submitDir(); } } }),
                    h('button', { type: 'button', className: 'so-btn so-btn-sm', disabled: saving,
                      title: '写进偏好 search.walkDirs：只是把该目录纳入遍历范围，不读也不删任何文件',
                      onClick: submitDir }, saving ? SEARCH_TXT.saving : '＋ 添加目录'))) : null,
            // S12-④：写偏好的交代落在这行 —— 成功说存进了哪一份，失败说没存进去（失败不假装成功）。
            dirsNote ? h('div', { className: `so-savenote so-savenote-${dirsNote.tone === 'bad' ? 'bad' : 'ok'}` }, dirsNote.text) : null)),
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
                : h('div', { className: 'so-empty' }, SEARCH_TXT.emptyNote))),
        selfCheckCard,
        guideCard);
    }
    /**
     * 设置页（Task 24）：四源开关 / 清理规则（含 guard 拒绝的纯渲染）/ 暂存与默认方式 / 搜索通路 / 能力表。
     * 与 MonitorPage / CleanPage / SearchPage 同规：自身零 useState —— prefs / rules / caps / snap 都从容器传下来。
     * 红线：黑名单文案、能力行、档位、默认值全吃注入载荷；guard 拒绝原因只透传宿主给的句子，本页不做任何路径裁决。
     */
    function SettingsPage(props = {}) {
      const {
        prefs = {}, rules = [], userRules = null, caps = {}, capRows = [], snap = null, err = null, saving = false,
        onPatch, onRuleAdd, onRuleToggle, onRuleRemove, onSave, onAlertToggle, onAlertAdd,
      } = props;
      const nameRef = useRef(null);
      const globRef = useRef(null);
      const ageRef = useRef(null);
      const kindRef = useRef(null);
      const portRef = useRef(null);
      const esRef = useRef(null);
      // 阈值告警新建表单（从监控页搬来）：阈值 / 连续次数 / 冷却分钟
      const avRef = useRef(null);
      const acRef = useRef(null);
      const akRef = useRef(null);

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

      // 阈值告警的规则行：置灰只吃宿主算好的 st 三态，页面绝不自己比 source.state（pg1-11）。
      // 从监控页整块搬来（真机反馈：配置不该长在监控页），只有开关回调换成了 onAlertToggle。
      const labelOf = {};
      ((snap && Array.isArray(snap.sources)) ? snap.sources : []).forEach((r0) => { labelOf[r0.key] = r0.label || r0.key; });
      const alertRows = alertRules.map((row) => {
        const rl = (row && row.rule) || {};
        const st = (row && row.st) || {};
        return h('div', { className: 'so-rule', key: String(rl.id ?? rl.n ?? '') },
          h('div', { className: 'so-ri' },
            h('div', { className: 'so-rn' }, String(rl.n || rl.name || rl.id || '')),
            h('div', { className: 'so-rd' + (st.dim ? ' so-rule-dim' : '') }, String(rl.d || `依赖 ${labelOf[rl.dep] || rl.dep || '本机采集'}`))),
          h('span', { className: 'so-rt' + (st.dim ? ' so-rule-dim' : '') }, String(st.st || '')),
          h(Switch, { on: st.on === true, disabled: st.dim === true,
            label: st.on ? '停用规则' : '启用规则',
            onChange: (next) => onAlertToggle && onAlertToggle(rl.id, next) }));
      });
      const readAlertVal = (ref, dft) => { const x = ref && ref.current ? Number(ref.current.value) : NaN; const v = num(x); return v === null || v <= 0 ? dft : v; };
      const saveAlertRule = () => {
        if (!onAlertAdd) return;
        onAlertAdd({ metric: 'cpu', value: readAlertVal(avRef, 85), consecutive: readAlertVal(acRef, 3), cooldownSec: Math.max(60, readAlertVal(akRef, 10) * 60) });
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
                : r.switch.unknown
                  // 宿主没给这一源的开关行：不画一颗看着能点、点了却没人认领的开关（S17 那条「缺东西
                  // 不许冒充确定状态」在设置页的落点），就地一句实话。
                  ? h('span', { className: 'so-hint' }, r.switch.text)
                  : h(Switch, { on: r.switch.on, disabled: r.switch.disabled, label: `切换 ${r.name}`,
                      onChange: (next) => onPatch && onPatch({ sources: { [r.key]: next } }) }))))),
        // —— 阈值告警：规则开关 + 新建（整块从监控页搬来；真机反馈「配置不该长在监控页」） ——
        h('div', { className: 'so-card' },
          h('div', { className: 'so-card-h' }, h('h2', null, '阈值告警'),
            h('span', { className: 'so-hsub' }, '规则在这里配置；命中只落在「监控记录」页时间线，不弹系统浮层')),
          alertRows.length
            ? h('div', { className: 'so-card-b' }, alertRows)
            : h('div', { className: 'so-card-b' }, h('div', { className: 'so-empty' }, '还没有告警规则：在下方新建一条。')),
          h('div', { className: 'so-card-b' },
            h('div', { className: 'so-grid so-g-2' },
              h('div', { className: 'so-field' }, h('label', null, '指标'), h('input', { className: 'so-input', type: 'text', defaultValue: 'CPU 使用率', readOnly: true })),
              h('div', { className: 'so-field' }, h('label', null, '阈值 / 持续'),
                h('input', { ref: avRef, className: 'so-input so-num', type: 'text', defaultValue: '85', style: { width: 64 } }), ' % · 连续',
                h('input', { ref: acRef, className: 'so-input so-num', type: 'text', defaultValue: '3', style: { width: 48 } }), ' 次'),
              h('div', { className: 'so-field' }, h('label', null, '冷却'),
                h('input', { ref: akRef, className: 'so-input so-num', type: 'text', defaultValue: '10', style: { width: 64 } }), ' 分钟内不重复'),
              h('div', { className: 'so-field' }, h('label', null, '提示落点'), h('input', { className: 'so-input', type: 'text', defaultValue: '监控记录页 + 侧边栏蓝点', readOnly: true }))),
            h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', { type: 'button', className: 'so-btn so-btn-primary so-btn-sm', onClick: saveAlertRule }, '保存规则'),
              h('span', { className: 'so-hint' }, '新建规则会插入列表首位，命中后记在「监控记录」页。')))),
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

    const pages = { MonitorPage, AlertsPage, CleanPage, SearchPage, SettingsPage };

    // ------------------------------------------------------------
    // 4b) 连接层 useStream：SSE 主、轮询兜底、可见性驱动（spec §3.1）
    //     增量帧合并：snapshot 整体替换；metrics/proc/sources/alert/clean:*/collect:refresh 局部合并。
    // ------------------------------------------------------------
    /** metrics 帧的 key 里，字段名与 snap.latest 同名的那些（diskFreePct 要换算，单独处理）。 */
    const LATEST_DIRECT = ['cpu', 'mem', 'netDown', 'netUp'];

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
        // 增量点同时也是"当前值"：snapshot 只在连上时推**一帧**（lib/api.js:335），之后每 tick
        // 只有 metrics（spec §3.1 表：只推增量点）。latest 不跟着合，KPI 四格与曲线卡的四个大数字
        // 就永久冻在首帧 —— 曲线在动、数字不动（2026-09-28 真机症状）。
        // diskFreePct 的点是**空闲百分比**，latest 的口径是 GB（lib/collect/service.js 的 latest 注释），
        // 换算用得着总量；分母缺失就保持原值，不硬算。
        if (d.point && typeof d.point.v === 'number') {
          const latest = { ...(base.latest || {}) };
          if (d.key === 'diskFreePct') {
            const total = num(latest.diskTotalGb);
            if (total) latest.diskFreeGb = (d.point.v / 100) * total;
          } else if (LATEST_DIRECT.indexOf(d.key) >= 0) {
            latest[d.key] = d.point.v;
          }
          base.latest = latest;
        }
        return base;
      }
      if (ev === 'proc') {
        // 只合 rows/note：**没有 state 可合** —— 宿主的 proc 帧从不带 state（lib/collect/service.js 三处 emit），
        // 旧写法 `d.state ?? 旧值 ?? 'off'` 把首帧的 off 冻成永久，正是 S17-① 的「榜在手上也写着未开启」。
        // 进程榜状态一律读 sources 的 l1b 行（那里才是活的、且只有一份）。
        base.proc = { rows: d.rows ?? (base.proc && base.proc.rows) ?? [], note: d.note ?? '' };
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
        a.hitsError = (d && d.error) || '监控记录未落盘';
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
      // S11-② 执行进度：`{ids总数, done, ok/skipped/failed/rejected, currentPath, results[], phase}`。
      // 只由本次点击发起的那一批喂（点「清理」时新建），clean:item 帧只累加、不凭空开一批。
      const [cleanExec, setCleanExec] = useState(null);
      const [cleanSafeAsk, setCleanSafeAsk] = useState(false);
      // S12-A：分类筛选态（null=全部，字符串=只看那一组）。
      const [cleanCat, setCleanCat] = useState(null);
      // S12-①：留痕面板的展开态挂在容器上（页面本体零 useState），页头的按钮就是唯一入口。
      const [cleanLogsOpen, setCleanLogsOpen] = useState(false);
      // S13：扫描范围同理——默认只有一行摘要，「展开明细」这颗按钮长在卡头，状态挂在容器上。
      const [cleanScopeOpen, setCleanScopeOpen] = useState(false);
      // S15-②：监控记录页的就地筛选档位（全部 / 24h / 7d）。与上面两处同规 —— 页面自身零 useState，
      // UI 态挂在容器上，切页签再回来保持原档位。
      const [alertsRange, setAlertsRange] = useState('');
      // S18-③：进程榜的排序态（列 + 方向）。默认 CPU 降序 = 原型口径；挂在容器上（MonitorPage
      // 自身零 useState 那条规矩），SSE 帧刷进来也不会把用户点的排序顶掉。
      const [procSort, setProcSort] = useState({ k: 'cpuPct', d: 'desc' });
      const doProcSort = (key) => setProcSort((prev) => procSortNext(prev, key));
      // S12-③ AI 智能清理：就绪度（GET /clean/ai，null = 还没问到）+ 本次征求的状态机
      // `{phase, planId, result, error, picked:Set, adoptedN}`。picked 只是"想采纳哪几类"，
      // adoptedN 才是"已经并进勾选多少项" —— 两段都不碰删除，执行仍然只有 doCleanApply 一条路。
      const [cleanAiReady, setCleanAiReady] = useState(null);
      const [cleanAiRun, setCleanAiRun] = useState(null);
      const cleanAppliedRef = useRef(null);               // 已执行的 planId：不让旧 clean:done 帧把它复活回清单卡
      const cleanPlanGetRef = useRef(null);               // 已按 GET /clean/plan 补拉过的 planId：同一 id 只补一次

      /**
       * 新清单到手 → 默认勾上「可清理」那批（S12-A，对齐主流清理工具：扫完即给出安全默认值，
       * 用户要做的只是复核与取消）。
       * 只对新 planId 做一次（`autoSelRef` 记上一次处理过的 id）：SSE 每帧都可能重带同一份清单，
       * 每次都重置勾选会把用户手动改过的勾选抹掉。有风险 / 已拒绝的一概不勾。
       */
      const cleanAutoSelRef = useRef(null);
      function adoptPlan(next) {
        if (!next || !Array.isArray(next.items)) return;
        if (cleanAutoSelRef.current === next.planId) return;
        cleanAutoSelRef.current = next.planId;
        const ids = safeCleanIds(next);
        setCleanSel(new Set(ids));
        setCleanCat(null);
      }

      /**
       * 清理页辅助数据：留痕 / 未确认完成 / 暂存区 / 规则 / 偏好。
       * SSE 只覆盖扫描进度，这几样必须 GET 现读；任何一路失败都带 source 落可见 notice
       * （rules/prefs 的失败路由到「扫描范围」卡，见 CleanPage 的 errForScope）。
       */
      async function loadCleanAux() {
        const [logs, unf, quar, rules, prefs, aiR] = await Promise.all([
          api('clean/logs', { query: { limit: 50 } }),
          api('clean/unfinished'),
          api('quarantine'),
          api('rules'),
          api('prefs'),
          api('clean/ai'),
        ]);
        const patch = {};
        if (logs.ok) patch.logs = Array.isArray(logs.data) ? logs.data : ((logs.data && logs.data.rows) || []);
        if (unf.ok) patch.unfinished = Array.isArray(unf.data) ? unf.data : [];
        if (quar.ok) patch.quar = quar.data && typeof quar.data === 'object' ? quar.data : null;
        if (rules.ok) patch.rules = rules.data && typeof rules.data === 'object' ? rules.data : null;
        if (prefs.ok) patch.prefs = (prefs.data && prefs.data.prefs) || {};
        setCleanAux((prev) => ({ ...prev, ...patch }));
        // 就绪度不并进上面那条错误循环：它不是用户能改的参数，读失败只让按钮说清"为什么没问到"
        if (aiR.ok) {
          setCleanAiReady(aiR.data && typeof aiR.data === 'object' ? aiR.data : null);
        } else {
          const e = aiR.error || {};
          setCleanAiReady({ available: false, reason: `读取宿主模型就绪度失败（${String(e.code || 'UNKNOWN')}）：${String(e.message || '接口调用失败')}` });
        }
        for (const pair of [['clean/logs', logs], ['clean/unfinished', unf], ['quarantine', quar], ['rules', rules], ['prefs', prefs]]) {
          if (!pair[1].ok) {
            setPageErr({ source: pair[0], ...((pair[1].error) || { code: 'UNKNOWN', message: '接口调用失败' }) });
            break; // 只报第一路：一次刷十几条红条不叫「可见」，叫噪音
          }
        }
      }

      async function doCleanScan() {
        setCleanLast(null);
        // 新一批扫描作废上一次的执行进度：留着会让「正在清理」的动画挂在刚生成的清单卡上（S11-②）
        setCleanExec(null);
        setCleanSafeAsk(false);
        setCleanAiRun(null);   // 上一次的 AI 建议属于上一份清单：新扫描一开始就作废（面板也不会贴在新清单上）
        setCleanCat(null);
        cleanAppliedRef.current = null;
        const r = await post('clean/scan');
        if (!r.ok) return;
        const d = r.data || {};
        if (d.busy) return; // 忙碌回执：扫描中卡已由 snap.clean 呈现，不另起一份
        if (d.plan && Array.isArray(d.plan.items)) { setCleanPlan(d.plan); adoptPlan(d.plan); }
        loadCleanAux();
      }
      const doCleanStop = () => { post('clean/scan/stop'); };
      const doCleanToggle = (id, on) => setCleanSel((prev) => {
        const n = new Set(prev);
        if (on) n.add(id); else n.delete(id);
        return n;
      });
      /** 表头全选框（S10-③）：勾满 → 清空；否则 → 勾满全选目标集合（未拒项，含标风险的）。
       *  目标集合为空（空清单）时不动 —— 点一下「全选」把用户手勾的项清掉是帮倒忙。 */
      const doCleanToggleAll = () => setCleanSel((prev) => {
        const target = cleanPlan ? selectAllIds(cleanPlan) : [];
        if (target.length === 0) return prev;
        return target.every((id) => prev.has(id)) ? new Set() : new Set(target);
      });
      async function doCleanApply(ids, mode) {
        if (!cleanPlan || !Array.isArray(ids) || ids.length === 0) return;
        // 开一批执行态：总数取前端交出去的 id 数（宿主只按这份 id 找回路径），逐条结果由 clean:item 帧填
        setCleanExec({ total: ids.length, done: 0, ok: 0, skipped: 0, failed: 0, rejected: 0, currentPath: '', results: [], phase: 'running', startedAt: Date.now() });
        setCleanSafeAsk(false);
        // 页面唯一的写出口：请求体结构上只有三键（applyBody），路径永不来自前端
        const r = await post('clean/apply', applyBody(cleanPlan.planId, ids, mode));
        if (!r.ok) { setCleanExec((prev) => (prev ? { ...prev, phase: 'done' } : prev)); return; }
        setCleanExec((prev) => (prev ? { ...prev, phase: 'done', summary: r.data || {} } : prev));
        cleanAppliedRef.current = cleanPlan.planId;
        setCleanLast({ planId: cleanPlan.planId, summary: { at: Date.now(), ...(r.data || {}) } });
        setCleanPlan(null);
        setCleanSel(new Set());
        setCleanAiRun(null);   // 清单已执行掉：贴在那份清单上的建议同时作废
        loadCleanAux();
      }
      const doCleanSafeAsk = () => setCleanSafeAsk(true);
      const doCleanSafeCancel = () => setCleanSafeAsk(false);
      const doCleanSafeRun = (ids, mode) => doCleanApply(ids, mode);
      /**
       * 征求 AI 建议（S12-③）。请求体只有 planId —— 前端既不发路径也不发勾选，
       * 模型看到的分类由宿主从冻结快照里现算，回话里的 ids 也是宿主找回的（lib/clean/ai-advisor.js）。
       * 失败不弹页级红条：那是"这次问不出结果"，就地落在 AI 面板里（spec §4 零浮层 + 诚实降级）。
       */
      async function doCleanAiAsk() {
        if (!cleanPlan) return;
        const planId = String(cleanPlan.planId ?? '');
        if (!planId) return;
        setCleanAiRun({ phase: 'running', planId, result: null, error: null, picked: new Set(), adoptedN: 0, startedAt: Date.now() });
        const r = await api('clean/ai-suggest', { method: 'POST', body: { planId } });
        if (!r.ok) {
          const e = r.error || {};
          setCleanAiRun((prev) => (prev && prev.planId === planId
            ? { ...prev, phase: 'error', error: { code: String(e.code || 'UNKNOWN'), message: String(e.message || '接口调用失败') } }
            : prev));
          return;
        }
        setCleanAiRun((prev) => (prev && prev.planId === planId ? { ...prev, phase: 'done', result: r.data || {} } : prev));
      }
      /** 采纳框：只改"想采纳哪几类"，并作废上一次采纳计数（改过之后那个数就不再代表当前勾选）。 */
      const doCleanAiPick = (group, on) => setCleanAiRun((prev) => {
        if (!prev) return prev;
        const n = new Set(prev.picked instanceof Set ? prev.picked : []);
        if (on) n.add(group); else n.delete(group);
        return { ...prev, picked: n, adoptedN: 0 };
      });
      /** 「采纳 N 项到勾选」= 并集，与「全选本组」同口径：不替换、不执行，后面还要用户自己点清理。 */
      function doCleanAiAdopt() {
        const ids = Array.from(new Set(aiAdoptIds(cleanAiRun).map(String)));
        if (ids.length === 0) return;
        setCleanSel((prev) => {
          const n = new Set(prev);
          ids.forEach((id) => n.add(id));
          return n;
        });
        setCleanAiRun((prev) => (prev ? { ...prev, adoptedN: ids.length } : prev));
      }
      const doCleanAiDismiss = () => setCleanAiRun(null);
      /** 分类筛选：只改显示，绝不动勾选集合（把筛选做成"取消其余勾选"是另一种撒谎）。 */
      const doCleanCatFilter = (key) => setCleanCat(key === null || key === undefined ? null : String(key));
      /** 「全选本组」= 并集，不是替换：用户已经勾别的组后再点这里，不该把那一组抹掉。 */
      const doCleanSelectGroup = (ids) => setCleanSel((prev) => {
        const n = new Set(prev);
        (Array.isArray(ids) ? ids : []).forEach((id) => n.add(String(id)));
        return n;
      });

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
          adoptPlan(p);
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
          adoptPlan(d);
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
      // S12-④：写偏好的就地交代 + 在途标记。note 只说**最后一次**写；重读本页（loadSearchAux）就清掉，
      // 不让一句旧交代跟着新读到的数据继续说事。
      const [srchNote, setSrchNote] = useState(null);
      const [srchSaving, setSrchSaving] = useState(false);
      const srchSavingRef = useRef(false);
      // S12-⑤ 一键安装：ready（null = 还没问到）/ 最近一装 / 就地确认行开关 / 就地交代。
      // 与写偏好那份 srchNote 分开两份：一句「存进了哪」与一句「装没装成」不许互相顶掉。
      const [srchInstallReady, setSrchInstallReady] = useState(null);
      const [srchInstall, setSrchInstall] = useState(null);
      const [srchInstallAsk, setSrchInstallAsk] = useState(false);
      const [srchInstallNote, setSrchInstallNote] = useState(null);
      const srchInstallRef = useRef(false);

      /**
       * 从 prefs 的 search 组取界面认得的形态：walkDirs 只认数组，mode 只认 everything/walk 两档。
       * `fallback` 只在**宿主那一格没回显**时顶上（写偏好之后要用本次期望值保住界面）；
       * 读取时不传 ⇒ 库里没这一格就是空/默认，不把「没设过」说成「设成了别的值」。
       */
      function searchFromPrefs(prefsRow, fallback = {}) {
        const s = (prefsRow || {}).search || {};
        return {
          dirs: Array.isArray(s.walkDirs) ? s.walkDirs.map((d) => String(d))
            : (Array.isArray(fallback.dirs) ? fallback.dirs.slice() : []),
          mode: s.mode === undefined || s.mode === null ? (fallback.mode === 'walk' ? 'walk' : 'everything')
            : (s.mode === 'walk' ? 'walk' : 'everything'),
          limit: LIMITS.indexOf(num(s.limit)) >= 0 ? s.limit
            : (LIMITS.indexOf(num(fallback.limit)) >= 0 ? fallback.limit : LIMITS[1]),
        };
      }

      /**
       * 进搜索页现读四样：ProbeResult、prefs.search（覆盖范围与通路参数不在 SSE 帧里），
       * 以及一键安装的「本机能不能装」与「最近一装到哪一步」（S12-⑤）。
       * 任一路失败落可见错误并带 source（约束 4）；探测失败**不改**已有探针数据 ——
       * 拿着 null 探针渲染就是「假装已经探测过」，宁可让页面显示未检测。
       * install 那两路不进 pageErr 循环：宿主半边没这条接口（升级顺序：先重启 dsh web）是**可解释的降级**，
       * 落成就地原因，而不是每进一次本页就顶一条满屏接口异常。
       */
      async function loadSearchAux() {
        const [pr, pf, ir, is] = await Promise.all([
          api('search/probe'), api('prefs'), api('search/install/ready'), api('search/install/state'),
        ]);
        if (pr.ok) setSrchProbe(pr.data && typeof pr.data === 'object' ? pr.data : null);
        if (pf.ok) {
          const got = searchFromPrefs((pf.data || {}).prefs);
          setSrchDirs(got.dirs); setSrchMode(got.mode); setSrchLimit(got.limit);
          setSrchNote(null);   // 重读 succeeded：旧的那句交代不再代表现在
        }
        setSrchInstallReady(ir.ok && ir.data && typeof ir.data === 'object'
          ? ir.data
          : { can: false, detail: installRouteGap(ir) });
        if (is.ok && is.data && is.data.job) setSrchInstall(is.data.job);
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
      /**
       * 安装接口问不通时的**就地**原因（S12-⑤）。两种情形分开写，绝不糊成一句「不可用」：
       *  · 404 / NOT_FOUND ⇒ 宿主半边还没有这条接口（浏览器半边已刷新、dsh web 还没重启）；
       *  · 其余 ⇒ 把宿主的 code 与 message 原文带回来，不翻译第二份。
       */
      function installRouteGap(r) {
        const e = (r && r.error) || {};
        const code = String(e.code || 'UNKNOWN');
        if (code === 'NOT_FOUND' || code === 'HTTP_404' || code === 'METHOD_NOT_ALLOWED' || code === 'HTTP_405') {
          return '宿主半边还没有这条安装接口（浏览器半边刷新即生效，接口要重启 dsh web 才在）：所以这颗按钮亮不起来，请照下面的说明自己装。';
        }
        return `问本机有没有 winget 没问通（${code}）：${e.message || '接口失败'}`;
      }
      /** 就地确认行的开关：只在按钮确实亮着的时候才展开（禁用的那颗点了不许长出确认行）。 */
      function doInstallAsk() {
        const b = installButton({ probe: srchProbe, ready: srchInstallReady, job: srchInstall, busy: srchSaving });
        if (!b.show || b.disabled) return undefined;
        setSrchInstallAsk(true);
        return undefined;
      }
      const doInstallCancel = () => setSrchInstallAsk(false);
      /**
       * 起一装：POST 里**什么字段都不带**（装什么由宿主 installer 的常量单点决定）。
       * 在途锁 srchInstallRef 与写偏好那份同规：双击会把第二发 install 打进同一台 winget，
       * 宿主那一侧还有 BUSY 第二道闸，但界面先不撒这发。
       */
      async function doInstallRun() {
        if (srchInstallRef.current) return { ok: false, skipped: true };
        setSrchInstallAsk(false);
        srchInstallRef.current = true;
        const r = await post('search/install', {});
        srchInstallRef.current = false;
        if (!r.ok) {
          setSrchInstallNote({ tone: 'bad', text: `没有启动安装：${((r.error || {}).message) || '接口调用失败'}` });
          return r;
        }
        const j = (r.data || {}).job || null;
        setSrchInstall(j);
        setSrchInstallNote({ tone: 'ok', text: SEARCH_TXT.installStarted });
        return r;
      }
      /**
       * 宿主的 `search:install` 帧 → 界面。装完那一趟必须**立刻重探**（宿主已经 invalidate 过缓存）：
       * 「winget 退出码 0」与「搜索能用」是两件事，这句交代只能由新的 ProbeResult 来写。
       */
      async function onInstallFrame(frame) {
        const j = (frame || {}).job || null;
        if (!j) return undefined;
        setSrchInstall(j);
        if (j.phase !== 'done' && j.phase !== 'failed') return undefined;
        if (j.phase === 'failed') { setSrchInstallNote(installOutcomeText(j, null)); return j; }
        const pr = await doSearchReprobe();
        setSrchInstallNote(pr.ok ? installOutcomeText(j, pr.data) : { tone: 'bad', text: SEARCH_TXT.installNoReprobe });
        void api('search/install/ready').then((r) => { if (r.ok && r.data && typeof r.data === 'object') setSrchInstallReady(r.data); });
        return j;
      }
      /**
       * 写 search 组（walkDirs / mode / limit 都只走这一条，一份真相）：**不做乐观更新** ——
       * 界面只在宿主确认写入并回显之后才改口（POST /api/prefs 回 readAll，lib/api.js:361），
       * 失败就把「没写进库」落在原地（spec §4 零浮层：一句就地字，不是弹层）。
       * 在途期间 srchSaving 锁住写入口：prefs 是**单行整记录覆盖写**，双击会叠两次覆盖。
       */
      async function saveSearch(patch, okText) {
        if (srchSavingRef.current) return { ok: false, skipped: true };   // 锁着就是没写，不谎报成功
        srchSavingRef.current = true; setSrchSaving(true);
        const r = await writePrefsGroup('search', patch);
        srchSavingRef.current = false; setSrchSaving(false);
        if (!r.ok) { setSrchNote({ tone: 'bad', text: SEARCH_TXT.writeFail }); return r; }
        const got = searchFromPrefs(((r.data || {}).prefs) || {}, { dirs: srchDirs, mode: srchMode, limit: srchLimit });
        setSrchDirs(got.dirs); setSrchMode(got.mode); setSrchLimit(got.limit);
        setSrchNote({ tone: 'ok', text: okText });
        return r;
      }
      const doSearchDirs = (next, okText) => saveSearch({ walkDirs: next }, okText);
      const doSearchAddDir = (d) => {
        const cur = Array.isArray(srchDirs) ? srchDirs : [];
        const v = typeof d === 'string' ? d.trim() : '';
        if (!v) { setSrchNote({ tone: 'bad', text: SEARCH_TXT.dirBlank }); return Promise.resolve({ ok: false }); }
        const at = cur.indexOf(v);
        // 已在覆盖范围里就不写第二次（整行覆盖写只是把同一份数据再抹一遍）—— 但"为什么没动静"必须说出口，
        // 沉默的按钮就是用户报的「点击没反应」。
        if (at >= 0) {
          setSrchNote({ tone: 'ok', text: `第 ${at + 1} 条已经是它了：覆盖范围没变，也不用重复添加。` });
          return Promise.resolve({ ok: true });
        }
        return doSearchDirs(cur.concat([v]), `${SEARCH_TXT.dirAdded}${v}（现共 ${cur.length + 1} 个目录，遍历范围到此为止，不是全盘索引）`);
      };
      const doSearchDelDir = (d) => {
        const cur = Array.isArray(srchDirs) ? srchDirs : [];
        const next = cur.filter((x) => x !== d);
        if (next.length === cur.length) {
          setSrchNote({ tone: 'bad', text: `覆盖范围里没有这一条：${d}` });
          return Promise.resolve({ ok: false });
        }
        return doSearchDirs(next, `${SEARCH_TXT.dirRemoved}${d}（现共 ${next.length} 个目录）`);
      };
      /** 通路与返回上限同样是偏好：不写库的话下次进本页又弹回默认档（S12-④ 的另一半）。 */
      const doSearchMode = (m) => saveSearch({ mode: m },
        `${SEARCH_TXT.modeSaved}${m === 'walk' ? '限定目录' : '全盘索引'} —— 下次进本页仍是这一档（通路未就绪时界面仍按限定目录渲染）。`);
      const doSearchLimit = (v) => saveSearch({ limit: v }, `${SEARCH_TXT.limitSaved}${v} 条`);

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
                // 逐条执行帧不进快照：它属于「这一次点击的执行进度」，浅并进 snap.clean 会把
                // path/id/state 这些键混进扫描状态，扫描卡就分不清自己在读哪一批数据（S11-②）。
                if (ev === 'clean:item') { setCleanExec((prev) => execItem(prev, d)); return; }
                // 一键安装的进度帧（S12-⑤）：不属于任何快照域，跟 clean:item 一样单独走。
                if (ev === 'search:install') { void onInstallFrame(d); return; }
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

      // 进入监控记录页 → 清蓝点（POST alerts/read）；离开页面不清（spec §3.5）。
      // S15-② 时间线搬来这一页，清未读就得跟着搬：留在监控页会变成「读完记录蓝点不灭、
      // 翻到没有记录的监控页反倒灭了」。
      useEffect(() => {
        if (tab !== 'alerts') return undefined;
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

      // 能力降级横幅：只挂**真降级**的行 —— ok:false 且宿主给了具体原因（detail）。
      // 「宿主不提供」这类结构性缺口（notifications / autostart）带不了 detail，归设置页能力表
      // （spec §4.6 指派的位置）；常驻在面板顶部只是噪声，用户第一眼看到的是五行看不懂的话。
      const capGaps = (cfg().capabilityRows || []).filter((r) => r && r.ok === false && r.detail);
      const cadenceOptions = (cfg().cadences || ['1s', '5s', 'paused']).map((v) => ({ v, t: v === 'paused' ? '暂停' : v }));
      // 清理页的扫描入口唯一挂在页头右上角（原型口径）：空态文案写的就是「点击右上角」，
      // 卡里再放一个同名按钮等于两个入口两套状态，真机反馈「右上角哪里有开始扫描」即此。
      const cleanSt = (snap && snap.clean) || {};
      const cleanScanning = String(cleanSt.phase || '') === 'scanning';
      const cleanHasPlan = Boolean(cleanPlan) || Boolean(cleanLast) || String(cleanSt.planId || '') !== '';
      const cleanLogN = Array.isArray(cleanAux.logs) ? cleanAux.logs.length : 0;

      return h('div', { className: 'so-root' },
        h('div', { className: 'so-head' },
          h('div', null,
            h('h1', { className: 'so-title' }, cfg().label || '系统运维'),
            h('p', { className: 'so-sub' }, '本机实时监控 · 两步式 C 盘清理 · 全盘文件搜索')),
          tab === 'monitor' && snap ? h('div', { className: 'so-actions' },
            h(Seg, { options: cadenceOptions, value: snap.cadence, onChange: doCadence })) : null,
          tab === 'clean' ? h('div', { className: 'so-actions' },
            // S12-①：留痕入口改到页头（用户批注「清理留痕放这里，点击弹框滚动查看」）。
            // 点下是就地展开/收起一个限高滚动面板，不是浮层；计数为 0 也照样能点开，
            // 面板里会如实写「还没有清理记录」—— 按钮消失比空面板更难解释。
            h('button', {
              type: 'button', className: 'so-btn so-btn-sm' + (cleanLogsOpen ? ' is-open' : ''),
              'aria-expanded': cleanLogsOpen ? 'true' : 'false',
              title: cleanLogsOpen ? '收起清理留痕' : (cleanLogN === 0 ? '展开清理留痕（还没有记录）' : `展开清理留痕：${cleanLogN} 段追加式记录`),
              onClick: () => setCleanLogsOpen((v) => !v),
            }, cleanLogN === 0 ? '清理留痕' : `清理留痕 ${cleanLogN}`),
            h('button', {
              type: 'button', className: 'so-btn so-btn-primary so-btn-sm', disabled: cleanScanning,
              title: cleanScanning ? '扫描进行中，可随时在下方停止' : '扫描是只读的：只统计大小与访问时间',
              onClick: () => doCleanScan(),
            }, cleanScanning ? '扫描中…' : (cleanHasPlan ? '重新扫描' : '开始扫描'))) : null),
        capGaps.length ? h('div', { className: 'so-capgaps' }, capGaps.map((r) => h(Notice, { key: r.key, tone: 'gray' },
          `${r.label}：${r.detail || r.fallback || '宿主不提供'}`))) : null,
        h('div', { className: 'so-tabs', role: 'tablist' }, nav.map((t) => h('button', {
          type: 'button', key: t.k, role: 'tab', className: 'so-tab',
          'aria-selected': tab === t.k ? 'true' : 'false',
          onClick: () => setTab(t.k),
        }, t.t))),
        tab === 'monitor' && h(pages.MonitorPage, {
          snap, link, err: pageErr,
          onCadence: doCadence, onSource: doSource,
          onRestart: doRestart, onProcToggle: doProcToggle,
          procSort, onProcSort: doProcSort,
        }),
        tab === 'alerts' && h(pages.AlertsPage, {
          snap, err: pageErr, range: alertsRange, onRange: setAlertsRange,
        }),
        tab === 'clean' && h(pages.CleanPage, {
          clean: (snap && snap.clean) || {}, plan: cleanPlan,
          logs: cleanAux.logs, unfinished: cleanAux.unfinished, quar: cleanAux.quar,
          rules: cleanAux.rules, prefs: cleanAux.prefs, caps: cfg().capabilities || {},
          link, sel: cleanSel, err: pageErr,
          latest: (snap && snap.latest) || null, catFilter: cleanCat,
          logsOpen: cleanLogsOpen, scopeOpen: cleanScopeOpen, ai: cleanAiReady, aiRun: cleanAiRun,
          onCatFilter: doCleanCatFilter, onSelectGroup: doCleanSelectGroup,
          onToggleLogs: () => setCleanLogsOpen((v) => !v),
          onToggleScope: () => setCleanScopeOpen((v) => !v),
          onAiAsk: doCleanAiAsk, onAiPick: doCleanAiPick, onAiAdopt: doCleanAiAdopt, onAiDismiss: doCleanAiDismiss,
          lastSummary: cleanLast && cleanLast.summary ? { planId: cleanLast.planId, ...cleanLast.summary } : null,
          exec: cleanExec, safeAsk: cleanSafeAsk,
          onStopScan: doCleanStop, onToggle: doCleanToggle, onToggleAll: doCleanToggleAll,
          onApply: doCleanApply, onQuarantine: (ids) => doCleanApply(ids, 'move-to-quarantine'),
          onSafeAsk: doCleanSafeAsk, onSafeCancel: doCleanSafeCancel, onSafeRun: doCleanSafeRun,
        }),
        tab === 'search' && h(pages.SearchPage, {
          probe: srchProbe, res: srchRes, mode: srchMode, limit: srchLimit, q: srchQ, dirs: srchDirs,
          err: pageErr, dirsNote: srchNote, saving: srchSaving,
          onSearch: doSearch, onMode: doSearchMode, onLimit: doSearchLimit, onReprobe: doSearchReprobe,
          onAddDir: doSearchAddDir, onDelDir: doSearchDelDir,
          installReady: srchInstallReady, installJob: srchInstall, installNote: srchInstallNote, installAsk: srchInstallAsk,
          onInstallAsk: doInstallAsk, onInstallCancel: doInstallCancel, onInstallRun: doInstallRun,
        }),
        tab === 'settings' && h(pages.SettingsPage, {
          prefs: setPrefs || {}, rules: setRules, userRules, caps: cfg().capabilities || {},
          capRows: cfg().capabilityRows || [], snap, err: pageErr, saving: setSaving,
          onPatch: doSettingsPatch, onRuleAdd: doSettingsRuleAdd, onRuleToggle: doSettingsRuleToggle,
          onRuleRemove: doSettingsRuleRemove, onSave: doSettingsSave,
          onAlertToggle: doRuleToggle, onAlertAdd: doRuleAdd,
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
    exports.__test = { cfg, consumeSse, api, fmtBytes, fmtRate, rateParts, fmtPct, fmtAge, stateClass, sourcePill, nav, pages, mergeFrame,
      monitor: { MonitorPage, AlertsPage, mtrRows, srcCells, curveSpec, band, sparkPoints, seriesVals, pointXY, hoverIndexAt, clockOf, tipText, tipParts, tipLayout, hitText, hitStamp, ALERT_RANGES, hitsInRange, PROC_SORT_COLS, procSortNext, procSortedRows },
      clean: { CleanPage, PLAN_COLS, scanCells, planRows, selTotals, selectAllIds, selectAllState, safeCleanIds, execItem, execCells, applyBody, logRow, quarantineText, capText, capOrMissing, categoryGroups, diskOverview, scanScope, scopeSummary, scopeNote, AI_ACTION_CELL, aiRecommendations, aiAdoptIds, aiButton },
      search: { SearchPage, PROBE_ROWS, LIMITS, probeCells, modeOf, resultHead, rowCells, advice, searchQuery, installButton, installOutcomeText },
      settings: { SettingsPage, SOURCE_ROWS, ruleCells, ruleStateText, patchBody, capCells, SAVE_DISABLED, capsReadOnly }, };
    return module.exports;
  },
});
