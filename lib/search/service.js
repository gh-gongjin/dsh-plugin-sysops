/**
 * lib/search/service.js —— 搜索通路选择与诚实降级（Task 17）
 *
 * 选路：mode=walk 直接走遍历（不看探测）；否则 probe → 就绪按 via 走 Everything/es，未就绪降级 walk。
 * 诚实原则：适配器报错时不回吐旧行，只标 stale（「保留上次结果标『陈旧』」是前端行为，宿主只如实说这次没成）；
 * 降级、截断、预算耗尽、跳过目录都在 note 里各写一句，界面直显。
 */
import { DEFAULT_EVERYTHING_PORT } from './probe.js';

/** 来源标签：与原型结果头的出处说明一致 */
export const SOURCE_LABEL = { everything: 'Everything HTTP', es: 'es.exe', walk: '本地遍历' };

/**
 * 归一化：三条通路的行都能喂给同一张表。
 * 未知字段一律 null（界面显示「—」），不许把未知当 0。
 */
export function normalize(raw, source) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const path = typeof r.path === 'string' ? r.path : null;
  let name = typeof r.name === 'string' ? r.name : null;
  let dir = typeof r.dir === 'string' ? r.dir : null;
  if (path) {
    const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    if (name === null) name = idx >= 0 ? path.slice(idx + 1) : path;
    if (dir === null) dir = idx >= 0 ? path.slice(0, idx) : '';
  }
  return {
    name: name ?? null,
    dir: dir ?? null,
    size: typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : null,
    mtime: typeof r.mtime === 'number' && Number.isFinite(r.mtime) ? r.mtime : null,
    source,
    path,
  };
}

export function createSearchService({ probe, getPrefs, adapters, logger, now }) {
  let lastSuccess = null;

  function warn(msg) {
    // 所有失败分支都要有可见记录（全局约束第 4 条：禁止静默 catch）
    if (logger && typeof logger.warn === 'function') logger.warn(msg);
  }

  async function search({ q, mode, limit } = {}) {
    const start = now();
    const s = (getPrefs() || {}).search || {};
    const effMode = mode || s.mode || 'everything';
    const baseLimit = Number.isFinite(s.limit) && s.limit > 0 ? s.limit : 200;
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(1000, Math.max(1, Math.trunc(Number(limit))))
      : Math.min(1000, Math.max(1, Math.trunc(baseLimit)));

    if (!String(q ?? '').trim()) {
      // 空 query 拒：不发请求也不遍历（sv-7）
      return { rows: [], source: null, sourceLabel: '', truncated: false, stale: false, note: '', error: 'EMPTY_QUERY', took: now() - start, limit: lim };
    }

    const walkDirs = Array.isArray(s.walkDirs) ? s.walkDirs : [];
    let choice;
    const noteParts = [];
    if (effMode === 'walk') {
      choice = 'walk';
    } else {
      let probed = null;
      let probeError = null;
      try {
        probed = await probe.probe();
      } catch (error) {
        probeError = error && error.message ? error.message : String(error);
        warn(`搜索通路探测异常：${probeError}`);
      }
      if (probed && probed.ready) {
        choice = probed.via === 'http' ? 'everything' : 'es';
      } else {
        choice = 'walk';
        const badDetails = ((probed && probed.checks) || [])
          .filter((c) => c && !c.ok && (c.key === 'installed' || c.key === 'http' || c.key === 'es'))
          .map((c) => c.detail);
        if (badDetails.length > 0) noteParts.push(`降级为本地遍历（Everything 通路未就绪）：${badDetails.join('；')}`);
        else noteParts.push(`降级为本地遍历（Everything 通路未就绪${probeError ? `，探测异常：${probeError}` : ''}）`);
      }
    }

    const args = choice === 'everything'
      ? { q, limit: lim, port: s.port ?? DEFAULT_EVERYTHING_PORT }
      : choice === 'es'
        ? { q, limit: lim, bin: s.esPath || undefined }
        : { q, limit: lim, dirs: walkDirs };

    let res;
    try {
      res = await adapters[choice](args);
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      warn(`搜索适配器 ${choice} 抛出异常：${msg}`);
      res = { rows: [], error: `搜索执行异常（${choice}）：${msg}` };
    }

    if (res && res.error) {
      warn(`搜索未成功（${choice}）：${res.error}`);
      // 标 stale 而不是回吐旧行：这次就是没成，界面要不要留「上次结果」由前端决定（spec §4.4）
      return {
        rows: [], source: choice, sourceLabel: SOURCE_LABEL[choice],
        truncated: false, stale: true,
        note: lastSuccess ? '本次查询未成功；界面上保留的上次结果为陈旧数据' : '本次查询未成功，暂无可参考的历史结果',
        error: res.error, took: now() - start, limit: lim,
      };
    }

    const rows = ((res && res.rows) || []).map((r) => normalize(r, choice));
    const truncated = choice === 'walk' ? !!(res && res.truncated) : rows.length >= lim;
    if (choice === 'walk') {
      if (res && res.note) noteParts.push(res.note);
      noteParts.push(`覆盖 ${walkDirs.length} 个目录，非全盘索引`);
      if (res && res.timedOut) noteParts.push('遍历预算耗尽，未扫完全部目录');
      if (res && Array.isArray(res.skipped) && res.skipped.length > 0) noteParts.push(`跳过 ${res.skipped.length} 个不可访问路径`);
    }
    if (truncated) noteParts.push(`命中已达上限 ${lim}，结果被截断`);

    const result = {
      rows,
      source: choice,
      sourceLabel: SOURCE_LABEL[choice],
      truncated,
      stale: false,
      note: noteParts.join('；'),
      error: null,
      took: now() - start,
      limit: lim,
    };
    lastSuccess = result;
    return result;
  }

  return { search };
}
