/**
 * 两段式清理的第二半：执行器（Task 15）。
 *
 * 三条铁律：
 *  1. **路径只从快照来**。入参除 `planId / itemIds / mode` 之外一概不读 —— 前端传来
 *     `path`、`paths` 也不看（ex-3）。id 不在快照里 → `rejected-unknown`，一个文件都不碰（ex-2）。
 *  2. **动手前逐条复核**：realpath 再过一遍 guard（ex-10 junction 逃逸）、re-stat 比快照
 *     （大小偏差 >10% / 目录出现快照之后的新增修改 / 条目消失 → `rejected-snapshot`，
 *     这是「用户没做错事」，不是 failed）。执行链的任何删除动作都绕不开 `lib/clean/guard.js`。
 *  3. **暂存闸门只管 move**：`move-to-quarantine` 在条目循环**之前** `await quarantine.ensureRoot()`，
 *     抛即整批拒（`SYSOPS_QUARANTINE_UNAVAILABLE`）—— Task 14 明写「配置错是整批该停，
 *     不是单条失败」；而 `delete-file` / `delete-dir` 不碰这个闸门，删除不该被暂存配置错拖死（T15-B）。
 *
 * 三档计数：`ok / skipped / failed`，被拒的记 `rejected`。EBUSY/EPERM/ENOTEMPTY 判 skipped
 * 且**只试一次**（`maxRetries: 0` 显式写出 —— `rmSync` 默认会重试，重试只会拉长锁定期）。
 */
import { check, checkOperation } from './guard.js';
import { RECORDS_ERROR } from '../kv-records-base.js';

/** 占用类错误：跳过并说明，不算失败也不重试。 */
const SKIP_ERRNOS = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);
/** re-stat 允许的快照偏差比例（spec §5：>10% 视为「扫的已经不是刚才那份」）。 */
const SIZE_TOLERANCE = 0.1;

export function createExecutor({ fsMod, planStore, logStore, quarantine, logger, now = () => Date.now(), onEvent } = {}) {
  const emit = (e) => onEvent?.(e);
  const warn = (m) => logger?.warn?.(m);

  /**
   * 整批拒的形状：error 有值、results 空、四档计数（ok/skipped/failed/rejected）**全为 0**。
   *
   * 契约订正（批 C 修 Important-1，注释与实况对齐，语义一字未改）：本函数以 **resolve 值**带回 code，
   * 而不是抛 —— 所以 api 层不是靠外层 catch 的 `statusFor(e.code)` 接住，而是在
   * `POST /api/clean/apply` 里按「四计数全 0 且 error 是 code 形状」识别整批拒，改走
   * `json(res, statusFor(code), errBody(code, 中文理由))`（Task 18 当时那句「statusFor 查得到」的注释是落空的）。
   * 现况：GUARD_OPERATION_DENIED→403 / SYSOPS_RECORDS_NOT_FOUND→404 / SYSOPS_RECORDS_UNAVAILABLE→501
   * 都在表内，SYSOPS_QUARANTINE_UNAVAILABLE 本次登记为 503（暂存目录不可用属依赖不可用档）。
   * partial 结果（有任何一条被处理）仍是 200 + 三档计数原样透出 —— 那是本执行器的既有语义。
   */
  function rejectedBatch(planId, error, extra = {}) {
    return { planId, logId: null, ok: 0, skipped: 0, failed: 0, rejected: 0,
      bytesFreed: 0, beforeFree: null, afterFree: null, results: [], error, ...extra };
  }

  async function apply(args = {}) {
    // 除这三个键之外不读 args —— ex-3 / cs-5 钉的就是「前端带来的路径字段完全被忽略」
    const { planId, itemIds, mode } = args;

    // 闸门一：操作种类（只允许三个，不给改 ACL / 结束进程 / 写注册表留口）—— 整批不做任何 IO 就返回
    const op = checkOperation(mode);
    if (!op.allow) {
      warn(`[sysops] 执行被拒：${op.why}`);
      return rejectedBatch(planId, op.code);
    }

    // 闸门二：快照必须真的存在（append-only 的那一份），拿不到就整批拒（ex-11）
    let plan;
    try {
      plan = await planStore.get(planId);
    } catch (e) {
      return rejectedBatch(planId, e?.code ?? RECORDS_ERROR.UNAVAILABLE);
    }
    if (!plan) {
      warn(`[sysops] 执行被拒：清单快照 ${planId} 不存在（可能已被裁剪或从未保存）`);
      return rejectedBatch(planId, RECORDS_ERROR.NOT_FOUND);
    }

    // 闸门三（只管 move）：暂存目录配错 = 整批该停，一个条目都不碰（T15-B）
    if (mode === 'move-to-quarantine') {
      try {
        await quarantine.ensureRoot();
      } catch (e) {
        warn(`[sysops] 暂存目录不可用，整批停止：${e?.message ?? e}`);
        return rejectedBatch(planId, 'SYSOPS_QUARANTINE_UNAVAILABLE');
      }
    }

    const index = new Map((plan.items ?? []).map((i) => [i.id, i]));
    // 留痕在动手**之前**落一条 running：进程中途被杀时 `unfinished()` 才查得到（cs-7 的判定面）
    const logRow = await logStore.start({ planId, itemIds: itemIds ?? [], mode });

    const results = [];
    let ok = 0; let skipped = 0; let failed = 0; let rejected = 0; let bytesFreed = 0;

    const push = (r) => {
      results.push(r);
      emit({ type: 'clean:item', id: r.id, state: r.state, errnoText: r.errnoText, path: r.path, dest: r.dest });
    };

    // 逐条**顺序**处理：删除并发只会让文件锁冲突更难查
    for (const id of itemIds ?? []) {
      const item = index.get(id);
      if (!item) {
        rejected += 1;
        push({ id, state: 'rejected-unknown', errnoText: '不在本次清单快照里，拒绝执行（执行对象只认快照交出的路径）', path: '' });
        continue;
      }
      // 1. realpath → guard 复检（junction / symlink 逃逸，ex-10）
      let real;
      try {
        real = fsMod.realpathSync(item.path);
      } catch (e) {
        // fail-closed：取不到真实落点就交空串，由 guard 的 junction 支拒掉，不「跳过这条红线」
        warn(`[sysops] realpath 取不到（${e?.code ?? ''}），按无法核实落点处理：${item.path}`);
        real = '';
      }
      const g = check(item.path, { real });
      if (!g.allow) {
        rejected += 1;
        push({ id, state: 'rejected-snapshot', errnoText: `${g.code} ${g.why}`, path: item.path });
        continue;
      }
      // 2. re-stat 复核快照
      let st;
      try {
        st = fsMod.statSync(item.path);
      } catch (e) {
        rejected += 1;
        const why = e?.code === 'ENOENT'
          ? '条目已不存在（扫描之后它自己消失了，不算失败）'
          : `现状读不到，无法与快照核对：${e?.code ?? ''} ${e?.message ?? ''}`;
        push({ id, state: 'rejected-snapshot', errnoText: why, path: item.path });
        continue;
      }
      if (st.isDirectory()) {
        // 目录条目的快照 size 是**递归求和**，和 stat 的目录记录尺寸根本不是一个口径，
        // 所以目录的闸门是「快照之后有没有新增/修改的子项」（ex-6）；大小偏差只对文件判。
        let dirty = null;
        try {
          for (const name of fsMod.readdirSync(item.path)) {
            let c;
            try { c = fsMod.statSync(fsMod.join(item.path, name)); } catch { continue; } // 子项消失：整删本来就是把它带走
            if (c.mtimeMs > plan.at) { dirty = String(name); break; }
          }
        } catch (e) {
          dirty = `(子项列不出来：${e?.code ?? e?.message ?? ''})`;
        }
        if (dirty) {
          rejected += 1;
          push({ id, state: 'rejected-snapshot', errnoText: `快照之后目录里有新增/修改的条目（${dirty}），请重新扫描`, path: item.path });
          continue;
        }
      } else if (Number(item.size) > 0) {
        const dev = Math.abs(Number(st.size) - Number(item.size)) / Number(item.size);
        if (dev > SIZE_TOLERANCE) {
          rejected += 1;
          push({ id, state: 'rejected-snapshot', errnoText: `与扫描那一刻偏差 ${Math.round(dev * 100)}%，请重新扫描`, path: item.path });
          continue;
        }
      }
      // 3. 按 mode 动手
      try {
        if (mode === 'delete-file') {
          fsMod.unlinkSync(item.path);
          ok += 1; bytesFreed += Number(item.size) || 0;
          push({ id, state: 'ok', errnoText: '', path: item.path });
        } else if (mode === 'delete-dir') {
          fsMod.rmSync(item.path, { recursive: true, maxRetries: 0 }); // maxRetries 显式 0：不重试
          ok += 1; bytesFreed += Number(item.size) || 0;
          push({ id, state: 'ok', errnoText: '', path: item.path });
        } else {
          const r = await quarantine.stash(item.path);
          if (r.ok) {
            ok += 1; // 隔离不释放空间，bytesFreed 只累计删除类（spec §7 的口径）
            push({ id, state: 'ok', errnoText: '', path: item.path, dest: r.dest });
          } else {
            // 隔离失败 = 「什么都没做」（原件必须还在，ex-9b），归 skipped 并带上原因
            skipped += 1;
            push({ id, state: 'skipped', errnoText: `隔离未完成：${r.why}`, path: item.path });
          }
        }
      } catch (e) {
        const code = e?.code ?? '';
        if (SKIP_ERRNOS.has(code)) {
          skipped += 1;
          push({ id, state: 'skipped', errnoText: `${code} ${e?.message ?? ''}（正被占用，跳过且不重试）`, path: item.path });
        } else {
          failed += 1;
          warn(`[sysops] 执行条目 ${item.path} 失败：${code} ${e?.message ?? e}`);
          push({ id, state: 'failed', errnoText: `${code} ${e?.message ?? ''}`, path: item.path });
        }
      }
    }

    // 汇总：afterFree 现读；读不到就 null 并留日志，**不许拿 beforeFree 冒充**
    let afterFree = null;
    try {
      afterFree = fsMod.statfsSync('C:')?.available ?? null;
    } catch (e) {
      warn(`[sysops] 执行后可用容量读取失败，留痕记 null：${e?.code ?? ''} ${e?.message ?? e}`);
    }
    const done = await logStore.finish(logRow.logId, { ok, skipped, failed, rejected, bytesFreed, afterFree });
    return {
      planId, logId: done.logId, ok, skipped, failed, rejected,
      bytesFreed, beforeFree: plan.beforeFree, afterFree, results,
    };
  }

  return { apply };
}
