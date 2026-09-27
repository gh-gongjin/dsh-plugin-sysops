/**
 * 分层编排：L0 主进程内定时器、L1a/L1b 走 supervisor。
 *
 * cadence 与"暂停"的语义：**暂停 = L0 停 + 依赖它的告警规则不参与评估**
 * （spec §3.5）。这不是隐藏结果，是评估入口的闸门，所以闸门放这里：
 * `snapshot().sources` 里 l0 的 state 是 `off` 时，alerts/service 收到
 * `setCadence` 事件后把该规则整条跳过。
 *
 * 可见性驱动只作用于 L1b：SSE 连接活着 + 页面可见才采（spec §3.1）。
 * 连接的存活由 api.js 的 hub 负责通知（hub 关闭时调 setVisible(false)），
 * 页面可见性由前端 POST /api/collect/visibility 送来 —— 两路都汇到同一个 setVisible。
 */
import os from 'node:os';
import { createRing } from './ring.js';
import { COLLECT_CADENCE, SOURCE_KEYS } from '../prefs/spec.js';

/** 采样节拍表。`'paused'` 故意不在表内 —— 查不到节拍就是"把定时器摘掉"，不需要第四条分支。 */
export const CADENCE_MS = { '1s': 1000, '5s': 5000 };

/**
 * 源名目：界面（Task 21）与 SSE 直接展示，不让前端自己配 key→中文。
 * `l2` 不在这里 —— 它到 Task 14 才有实现，`sourceRows()` 里也就不能凭空多出一行 `off`
 * 冒充"已接线的源"；开关本身仍由 prefs 保存（`SOURCE_KEYS` 认它）。
 */
const SOURCE_LABELS = { l0: '本机基础指标', l1a: '网络吞吐', l1b: '进程榜' };

/** 界面上的"暂停"和存储里的 `paused` 是同一个东西的两种写法（spec §1.1 决策 7 / §3.2）。 */
function cadenceToKey(v) {
  if (v === '暂停' || v === 'paused') return 'paused';
  if (COLLECT_CADENCE.includes(v)) return v;
  throw new Error(`cadence 必须是 ${COLLECT_CADENCE.concat('暂停').join(' | ')} 之一，收到 ${JSON.stringify(v)}`);
}
function cadenceToLabel(k) {
  return k === 'paused' ? '暂停' : k;
}

/**
 * @param getPrefs          读当前偏好（只在构造时读一次：改 keepMinutes 要重建环，归上层重启路径）
 * @param now               时钟注入点。假时钟下不传它，ring 的时间窗永不滚动（svc-6 的 301 就是断这个）
 * @param getIntervalFn     宿主的 `ctx.interval`；返回 null 即退到 `globalThis.setInterval`
 * @param makeSupervisor / makeL0 / makeL1a / makeL1b   四个采集层，全部可注入替身
 */
export function createCollectService({
  getPrefs,
  logger = console,
  now = () => Date.now(),
  getIntervalFn = () => null,
  makeSupervisor,
  makeL0,
  makeL1a,
  makeL1b,
  osMod = os,
} = {}) {
  const prefs = (getPrefs && getPrefs()) || {};
  let cadenceKey = cadenceToKey(prefs.collect?.cadence ?? '1s');
  let keepMinutes = Number.isFinite(prefs.collect?.keepMinutes) ? prefs.collect.keepMinutes : 30;
  // 默认值就是 spec §1.2 的成本结论：l0/l1a 常开，l1b/l2 默认关。
  const switches = { l0: true, l1a: true, l1b: false, l2: false, ...(prefs.sources || {}) };

  const listeners = new Set();
  function emit(e) {
    // 一个订阅者抛错不许带走别人（api 的 SSE 写失败正是这种）；但要留痕，否则"没人收到"无从解释
    for (const cb of listeners) {
      try { cb(e); } catch (err) { logger.warn('[collect] 订阅者抛错：', err?.message ?? err); }
    }
  }

  let rings = null;
  function buildRings() {
    // 两个上界都要真承重：条数管内存、时间窗管"用户要的是最近 N 分钟"。
    // `+1` 是窗底含边界保留的那一拍（ring 的裁剪条件是 `t < floor` 才丢）。
    const windowMs = keepMinutes * 60 * 1000;
    const maxPoints = keepMinutes * 60 + 1;
    rings = {
      cpu: createRing({ windowMs, maxPoints, percent: true, now }),
      mem: createRing({ windowMs, maxPoints, percent: true, now }),
      diskFreePct: createRing({ windowMs, maxPoints, percent: true, now }),
      netDown: createRing({ windowMs, maxPoints, now }),
      netUp: createRing({ windowMs, maxPoints, now }),
    };
  }
  buildRings();

  const sup = makeSupervisor ? makeSupervisor({ logger, now }) : null;
  const l0 = makeL0({ osMod, now });

  /**
   * 进程榜是**服务自己的状态**，不是 `l1b.latest()` 的别名（Task 7 I-1 的编排层镜像）：
   * 只有走"l1b 被停下"的那几条路径才清它，界面读到的 rows/t/note 永远来自同一次快照。
   */
  let procRows = [];
  let procNote = '';
  let procT = null;
  let disposed = false;

  /** L1a 的出口：`v` 是字节/秒原值（换算 MB/s 归界面），未登记的指标只记一行日志。 */
  function onPoint(p) {
    const ring = rings[p?.metric];
    if (!ring) { logger.warn('[collect] L1a 送来了未登记的指标：', p?.metric); return; }
    if (ring.push({ t: p.t, v: p.v }) === 'ok') emit({ type: 'metrics', key: p.metric, point: { t: p.t, v: p.v } });
  }

  function clearProc() {
    procRows = [];
    procNote = '';
    procT = null;
    // 只清本地不推事件，SSE 侧的卡片会继续挂着已停源的旧榜 —— 那是最坏的一种静默
    emit({ type: 'proc', rows: procRows, note: procNote, t: procT });
  }

  /** L1b 的出口：`(parsed, line)` 两分支。Task 7 已定"非 JSON 不许静默"，因由挤进 note。 */
  function onRows(parsed, line) {
    if (!parsed) {
      procNote = `非 JSON 行（PowerShell 告警或进度）：${String(line).slice(0, 120)}`;
      logger.warn('[collect] L1b 出一行非 JSON：', procNote);
      // rows / procT 都不动：上一轮成功样本仍是"最后一次成功的轮"，靠 t 让界面自己判陈旧
      emit({ type: 'proc', rows: procRows, note: procNote, t: procT });
      return;
    }
    procRows = parsed.rows ?? [];
    procT = Number(parsed.t);
    // `truncated` 这个键只在真的超上限时才存在（Task 7 交付契约），所以先 `?? 0` 再判
    const truncated = parsed.truncated ?? 0;
    procNote = truncated > 0 ? `进程榜超出 ${truncated} 行未列出（按内存保留最大的一批）` : '';
    emit({ type: 'proc', rows: procRows, note: procNote, t: procT });
  }

  // 出口必须在**构造时**接上：createL1b 不传 onRows 就直接抛，漏接是启动即炸而不是跑起来静默吞榜
  const l1a = makeL1a({ sup, onPoint, logger });
  const l1b = makeL1b({ sup, onRows, logger });

  let lastSample = null;
  let visible = false;
  let l0Handle = null;
  let timerBackend = 'setInterval';
  // 只取一次：宿主没给 interval 就一路用 setInterval，`snapshot().timerBackend` 才不会被切档改口
  const intervalFn = (getIntervalFn && getIntervalFn()) || null;

  function clearL0() {
    if (!l0Handle) return;
    if (l0Handle.kind === 'ctx') l0Handle.h.done = true;   // 句柄由宿主管，置标志让它别再敲
    else globalThis.clearInterval(l0Handle.h);             // 退路上必须显式清，否则留一个野定时器一直吃 CPU
    l0Handle = null;
  }

  let lastCores = osMod.cpus().length;
  function tickL0() {
    // 核数热插拔/改频：两次样本核数不等时 computeCpuPct 返回 NaN ⇒ 曲线**每拍**丢点，
    // 所以基线要复位（台账 Task 5 下游契约②）。只在真的不等时复位 —— 每拍都复位等于没有基线。
    const cores = osMod.cpus().length;
    if (cores !== lastCores) {
      lastCores = cores;
      l0.reset();
      logger.warn('[collect] 核数变化，已复位 cpu 基线：', cores);
    }
    let s = null;
    try {
      s = l0.read();
    } catch (e) {
      logger.warn('[collect] L0 采样抛错：', e?.message ?? e);
      // 抛错也要巡检子进程：statfs 坏掉的这段时间里，l1a/l1b 卡住仍得被心跳看见
    }
    if (sup?.tick) sup.tick();
    if (!s) { refreshSources(); return; }
    lastSample = s;
    const diskTotal = Number(s.diskTotal);
    const pct = Number.isFinite(diskTotal) && diskTotal > 0 ? (s.diskFree / diskTotal) * 100 : NaN;
    // 三个指标分别 push：坏的那一个自己进 dropped.bad，不许连累另外两条曲线
    for (const [k, v] of Object.entries({ cpu: s.cpu, mem: s.mem, diskFreePct: pct })) {
      if (rings[k].push({ t: s.t, v }) === 'ok') emit({ type: 'metrics', key: k, point: { t: s.t, v } });
    }
    refreshSources();
  }

  function armL0() {
    clearL0();
    const ms = CADENCE_MS[cadenceKey];
    if (!ms) return;                       // 暂停 / 未知档位：摘掉定时器就是全部语义
    if (intervalFn) {
      timerBackend = 'ctx.interval';
      l0Handle = { kind: 'ctx', h: intervalFn(() => tickL0(), ms) };
    } else {
      timerBackend = 'setInterval';
      l0Handle = { kind: 'real', h: globalThis.setInterval(() => tickL0(), ms) };
    }
  }

  function sourceRows() {
    const rows = [{
      key: 'l0',
      label: SOURCE_LABELS.l0,
      // dispose 那一条必须单独判：l0 的 state 是按「开关 + 档位」算的，而 dispose 只清了定时器，
      // 不置标志就会对着界面说"主进程还在采样"（真机串跑实测到的正是这个假陈述）。
      state: disposed || !switches.l0 || cadenceKey === 'paused' ? 'off' : 'on',
      detail: disposed
        ? '服务已 dispose（定时器已清，开关与档位不变）'
        : cadenceKey === 'paused'
          ? '已暂停（档位=暂停）'
          : `档位 ${cadenceToLabel(cadenceKey)}，窗口 ${keepMinutes} 分钟`,
      restarts: 0,
      pid: null,
      stderrTail: '',
    }];
    // l1a/l1b 两行的状态原样来自 supervisor（含终态 crashed / exited-max 与 detail），编排层不二次加工
    for (const [key, src] of [['l1a', l1a], ['l1b', l1b]]) {
      const st = (src.state && src.state()) || {};
      rows.push({
        key,
        label: SOURCE_LABELS[key],
        state: st.state ?? 'off',
        detail: st.detail ?? '',
        restarts: st.restarts ?? 0,
        pid: st.pid ?? null,
        stderrTail: st.stderrTail ?? '',
      });
    }
    return rows;
  }

  let lastSourceJson = '';
  function refreshSources() {
    const rows = sourceRows();
    const json = JSON.stringify(rows);
    if (json === lastSourceJson) return rows;   // 1s 一屏重复状态没意义，只有变了才推
    lastSourceJson = json;
    emit({ type: 'sources', rows });
    return rows;
  }

  function start() {
    disposed = false;
    if (switches.l1a) l1a.enable();
    if (switches.l1b && visible) l1b.enable();  // 开关 + 可见性两个条件同时为真才付 L1b 那一轮 1.6–1.9s
    armL0();
    refreshSources();
  }

  async function stop() {
    clearL0();
    try { await l1a.disable(); } catch (e) { logger.warn('[collect] 停 l1a 抛错：', e?.message ?? e); }
    try { await l1b.disable(); } catch (e) { logger.warn('[collect] 停 l1b 抛错：', e?.message ?? e); }
    clearProc();
    refreshSources();
  }

  /** 同步：切档只是换一个定时器句柄，没有子进程要等。非法档位直接抛（svc-2 钉住）。 */
  function setCadence(v) {
    cadenceKey = cadenceToKey(v);
    armL0();
    refreshSources();
  }

  async function setSource(key, on) {
    if (!SOURCE_KEYS.includes(key)) throw new Error(`未知源开关：${JSON.stringify(key)}，可用：${SOURCE_KEYS.join(' | ')}`);
    switches[key] = !!on;
    if (key === 'l0') { if (on) armL0(); else clearL0(); }
    if (key === 'l1a') {
      if (on) l1a.enable();
      else { try { await l1a.disable(); } catch (e) { logger.warn('[collect] 关 l1a 抛错：', e?.message ?? e); } }
    }
    if (key === 'l1b') {
      // 关掉即"这一路已停"，残值不留：界面拿着上一轮旧榜画实时卡片比画不出更糟
      if (on && visible) l1b.enable();
      else { try { await l1b.disable(); } catch (e) { logger.warn('[collect] 关 l1b 抛错：', e?.message ?? e); } clearProc(); }
    }
    if (key === 'l2') logger.warn('[collect] l2 尚未接线（Task 14），开关已记下但没有采集动作');
    refreshSources();
  }

  async function setVisible(v) {
    visible = !!v;
    // 这里**只**动 l1b：l1a 实测成本 <1%，跟着可见性起停会让用户切回页面时白白丢掉一窗暖身
    if (visible && switches.l1b) l1b.enable();
    else { try { await l1b.disable(); } catch (e) { logger.warn('[collect] 不可见时停 l1b 抛错：', e?.message ?? e); } clearProc(); }
    refreshSources();
  }

  function snapshot() {
    const lat = {
      cpu: rings.cpu.latest(),
      mem: rings.mem.latest(),
      diskFreePct: rings.diskFreePct.latest(),
      netDown: rings.netDown.latest(),
      netUp: rings.netUp.latest(),
    };
    const dropped = { stale: 0, bad: 0 };
    for (const r of Object.values(rings)) {
      const s = r.stats();
      dropped.stale += s.droppedStale;
      dropped.bad += s.droppedBad;
    }
    const l1bState = (l1b.state && l1b.state()) || {};
    return {
      cadence: cadenceToLabel(cadenceKey),
      keepMinutes,
      timerBackend,
      series: {
        cpu: rings.cpu.series(),
        mem: rings.mem.series(),
        diskFreePct: rings.diskFreePct.series(),
        netDown: rings.netDown.series(),
        netUp: rings.netUp.series(),
      },
      // latest.* 一律原值口径（百分比 / 字节每秒 / GB 各按各的），换算文案归界面，免得两处口径混着用
      latest: {
        cpu: lat.cpu ? lat.cpu.v : null,
        mem: lat.mem ? lat.mem.v : null,
        diskFreeGb: lastSample ? lastSample.diskFree / 2 ** 30 : null,
        diskTotalGb: lastSample ? lastSample.diskTotal / 2 ** 30 : null,
        netDown: lat.netDown ? lat.netDown.v : null,
        netUp: lat.netUp ? lat.netUp.v : null,
        t: lat.cpu ? lat.cpu.t : null,
      },
      sources: sourceRows(),
      proc: { rows: procRows, state: l1bState.state ?? 'off', note: procNote, t: procT },
      dropped,
    };
  }

  function onEvent(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function dispose() {
    disposed = true;                        // start() 会复位；重复调用只是把同一件事做两遍，不抛
    clearL0();
    try { l1a.disable(); } catch (e) { logger.warn('[collect] dispose 停 l1a 抛错：', e?.message ?? e); }
    try { l1b.disable(); } catch (e) { logger.warn('[collect] dispose 停 l1b 抛错：', e?.message ?? e); }
    if (sup?.dispose) sup.dispose();
    buildRings();                           // 环直接重建：dropped 计数跟着归零，dispose 后不该再报旧账
    clearProc();
  }

  return { start, stop, setCadence, setSource, setVisible, snapshot, sourceRows, procRows: () => procRows, onEvent, dispose };
}
