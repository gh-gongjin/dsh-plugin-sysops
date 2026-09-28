/**
 * 清理服务（Task 15）：扫描/执行两条链的唯一编排者，也是 Task 14 暂存红线
 * （`forbiddenPrefixes`）在运行时**唯一真实喂入者**（T15-A）。
 *
 * 要点：
 *  - **单飞**：`running` 在 `startScan()` 内同步置位 —— 两次点击不会并行两条遍历
 *    抢 IO、互相覆盖清单（cs-2）。忙碌方拿回 `{ busy: true, state }`，第二个前端也能看到进度。
 *  - **事件族**：`clean:progress` / `clean:done` / `clean:item` / `clean:summary` /
 *    `clean:error`（+ after=log 时一条 `collect:refresh`）全部经 `onEvent` 汇给 api.js。
 *  - **暂存红线**：每次 `apply` / `quarantineStats` **现造** quarantine（prefs 与规则集
 *    在两次调用之间会变）；`rootDir` 取 `prefs.clean.quarantineDir ?? DEFAULT_QUARANTINE(...)`，
 *    `forbiddenPrefixes` 取 `(await ruleStore.activeRules()).map(r => r.dir)` —— 口径单点（cs-8/cs-9）。
 *  - **执行只转发三键**：`{planId, itemIds, mode}`，前端带来的路径字段一概不转（cs-5）。
 *  - `dispose()` 不关仓储：domain 由 `index.js` 统一收口，两处 close 会撞车。
 */
import { expandRule } from './scanner.js';
import { DEFAULT_QUARANTINE } from './quarantine.js';

/** Task 22 扫描条按这十个字段渲染，字段集合固定，不加发明。 */
const initialStates = () => ({
  phase: 'idle', dir: '', walked: 0, hit: 0, bytes: 0,
  stopped: false, truncated: false, skipped: 0, planId: null, error: '',
});

export function createCleanService({
  ruleStore, makeScanner, makeExecutor, makeQuarantine,
  planStore, logStore, getPrefs, fsMod, osMod, pathMod,
  logger, now = () => Date.now(),
} = {}) {
  const stateObj = initialStates();
  const listeners = new Set();
  const emit = (e) => { for (const cb of [...listeners]) cb(e); };
  const warn = (m) => logger?.warn?.(m);

  let running = null;      // 单飞闸门（startScan 同步读写）
  let scannerRef = null;   // 当前 scanner，stopScan 转发用

  /** 现读系统盘可用容量；读不到交 0 进快照（留痕面另有 executor 的 null 口径）。 */
  function readFree() {
    try {
      return fsMod.statfsSync('C:')?.available ?? 0;
    } catch (e) {
      warn(`[sysops] 可用容量读取失败（${e?.code ?? ''} ${e?.message ?? e}），本次按 0 记`);
      return 0;
    }
  }

  /** Task 14 红线的唯一真实喂入点（T15-A）：每次现造，prefs / 规则集都取最新的。 */
  async function buildQuarantine() {
    const prefs = getPrefs?.() ?? {};
    const rootDir = prefs?.clean?.quarantineDir
      ?? DEFAULT_QUARANTINE(pathMod.join(osMod.homedir(), 'AppData', 'Local'));
    const rules = await ruleStore.activeRules();
    const forbiddenPrefixes = rules.map((r) => r.dir);
    return makeQuarantine({ rootDir, fsMod, pathMod, logger, now, forbiddenPrefixes });
  }

  async function runScan() {
    Object.assign(stateObj, initialStates(), { phase: 'scanning' });
    const beforeFree = readFree();
    // scanner 必须在**任何 await 之前**挂上 scannerRef：cs-4 的 stopScan 发生在
    // startScan() 返回后的同一拍里，晚一帧这个 stop 就丢了。
    const scanner = makeScanner({
      fsMod, osMod, now, logger,
      onProgress: (p = {}) => {
        stateObj.dir = String(p.dir ?? stateObj.dir);
        stateObj.walked = Number(p.walked ?? stateObj.walked);
        stateObj.hit = Number(p.hit ?? stateObj.hit);
        stateObj.bytes = Number(p.bytes ?? stateObj.bytes);
        emit({ type: 'clean:progress', dir: stateObj.dir, walked: stateObj.walked, hit: stateObj.hit, bytes: stateObj.bytes });
      },
    });
    scannerRef = scanner;
    try {
      const raw = await ruleStore.activeRules();
      const rules = raw.map((r) => expandRule(r, { home: osMod.homedir() }));
      const result = await scanner.scan(rules);
      stateObj.truncated = !!result.truncated;
      stateObj.skipped = (result.skipped ?? []).length;
      // stopped 不在这里覆写：stopScan 已经置 true，扫描器回报的 stopped=false 只说明
      // 它「自己没察觉」，用户视角的收手必须以 stateObj 为准（cs-4）。
      const saved = await planStore.save(result, { beforeFree, modeDefault: 'delete-file' });
      stateObj.phase = 'ready';
      stateObj.planId = saved.planId;
      emit({ type: 'clean:done', plan: saved });
      return { started: true, plan: saved };
    } catch (e) {
      stateObj.phase = 'idle';
      stateObj.error = String(e?.message ?? e);
      warn(`[sysops] 扫描失败：${stateObj.error}`);
      emit({ type: 'clean:error', where: 'scan', error: stateObj.error });
      return { started: false, error: stateObj.error };
    } finally {
      scannerRef = null;
    }
  }

  function startScan() {
    if (running) {
      // 忙碌回执：不并行第二条遍历，但把当前进度原样回吐（第二个前端也有的渲染）
      return Promise.resolve({ busy: true, state: { ...stateObj } });
    }
    running = runScan().finally(() => { running = null; });
    return running;
  }

  function stopScan() {
    stateObj.stopped = true;
    scannerRef?.stop?.();
  }

  async function apply(args = {}) {
    // 只转发三键（cs-5 用 Object.keys 钉死）—— path / paths 等一律不进门
    const forwarded = { planId: args.planId, itemIds: args.itemIds, mode: args.mode };
    const quarantine = await buildQuarantine();
    const exec = makeExecutor({ fsMod, planStore, logStore, quarantine, logger, now, onEvent: emit });
    const summary = await exec.apply(forwarded);
    if (getPrefs?.()?.clean?.after === 'log' && summary) {
      // after=log：现读执行后可用容量（读不到记 null + warn，不冒充），并推一次曲线刷新
      let afterFree = null;
      try {
        afterFree = fsMod.statfsSync('C:')?.available ?? null;
      } catch (e) {
        warn(`[sysops] after=log 读取执行后容量失败，记 null：${e?.code ?? ''} ${e?.message ?? e}`);
      }
      summary.afterFree = afterFree;
      emit({ type: 'collect:refresh' });
    }
    emit({ type: 'clean:summary', summary });
    return summary;
  }

  return {
    startScan,
    stopScan,
    state: () => ({ ...stateObj }),
    apply,
    plans: (opts) => planStore.list(opts),
    // Ruling-98：按 planId 取回冻结快照实体的薄转发（GET /api/clean/plan 用）。
    // 不新造存储路径、不加工内容：planStore.get 交什么就是什么（找不到交 null，带 code 的域错误原样抛出）。
    plan: (planId) => planStore.get(planId),
    logs: (opts) => logStore.list(opts),
    unfinished: () => logStore.unfinished(),
    async quarantineStats() {
      const q = await buildQuarantine();
      return q.stats();
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      stopScan();
      listeners.clear();
      // 不关仓储：domain 由 index.js 统一收口（两处 close 会撞车）
    },
  };
}
