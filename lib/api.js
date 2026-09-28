/**
 * lib/api.js —— 宿主可见的唯一 HTTP 面：路由表 + SSE hub。
 *
 * 这一层只做三件事：**回环闸门 → 表驱动分派 → 错误码翻译成 HTTP 语义**，
 * 具体每个接口答什么是各 service 的事，本文件不写业务逻辑。
 *
 * 三条红线在路由层的落点（全局约束 5/6/4）：
 *  - `/api/clean/apply` 只把 `{planId, itemIds, mode}` 三个键交给执行器，
 *    前端带来的任何路径字段一概不转（路径永不采信前端）；「能不能删」由
 *    `lib/clean/guard.js` 单点裁决，本层不复制判定、也不放宽。
 *  - 每个 handler 抛出的错误都经 `statusFor(code)` 集中翻译成状态码，
 *    不散落 try/catch，也绝不让任何带 code 的错误静默落回 200。
 *  - 唯一的静默例外是 SSE 帧写失败（客户端已断开）：`hub.broadcast` 里
 *    catch 到 write 抛错就摘掉该连接，不留痕到时间线之外（断开无需解释）。
 */
import { COLLECT_CADENCE } from './prefs/spec.js';

/** 浏览器侧与本层共用的路由前缀；宿主 webServer 按前缀把请求交进来。 */
export const ROUTE_PREFIX = '/sysops';
/** index-inject 全局键：浏览器半边据此拿到 api 基址与能力表。 */
export const GLOBAL_KEY = '__SYSOPS__';

/** `/api/clean/apply` 允许的三种操作（与 guard 的 OPS_ALLOWED 同集合，白名单摘取用）。 */
export const APPLY_MODES = ['delete-file', 'delete-dir', 'move-to-quarantine'];

/* ------------------------------------------------------------------ *
 * 响应 / 请求体
 * ------------------------------------------------------------------ */

/** 成功响应统一形状 `{ ok: true, data }`。 */
export function jsonOk(res, data) {
  return json(res, 200, { ok: true, data });
}

/** 失败响应统一形状 `{ ok: false, error: { code, message } }`。 */
function errBody(code, message) {
  return { ok: false, error: { code, message } };
}

/** 写一个 JSON 响应：设置状态码 + content-type，并 end。返回 true 表示「已应答」。 */
export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
  return true;
}

/**
 * POST 请求体读取（真机路径）：宿主 handler 只收 `(req, res)`，体要自己拼。
 * 测试里体作为第三个参数直接给出，`handler` 会优先用它，不走这里。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    // 已经解析好并挂在 req 上（部分宿主实现会预解析）—— 直接返回
    if (req && typeof req === 'object' && req.__parsedBody && typeof req.__parsedBody === 'object') {
      return resolve(req.__parsedBody);
    }
    if (!req || typeof req.on !== 'function') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BAD_JSON' }));
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', (e) => reject(Object.assign(new Error(String(e?.message ?? e)), { code: 'BAD_JSON' })));
  });
}

/* ------------------------------------------------------------------ *
 * 错误码 → HTTP 状态码（集中一张表，别在 handler 里散落）
 *
 * 两套独立字面值集合（Task 13 F-6 + D5）都在此收敛：
 *   · 偏好侧 `PREFS_*`（lib/prefs/store.js）
 *   · 记录侧 `SYSOPS_RECORDS_*`（lib/kv-records-base.js）与 alerts 自带的 `RECORDS_*`
 *     （lib/alerts/store.js 沿用旧词表，`RECORDS_UNAVAILABLE` ≠ `SYSOPS_RECORDS_UNAVAILABLE`）
 *   · 规则侧 `SYSOPS_RULE_*`（lib/prefs/rules-store.js）
 *   · guard 侧 `GUARD_*`（lib/clean/guard.js，一般以 {allow:false} 返回而非抛，兜底也认）
 * 兜底 500；任何带 code 的错误都不会落回 200。
 * ------------------------------------------------------------------ */
const CODE_STATUS = {
  // 存储不可用：界面据此置灰保存按钮（不是崩溃，是降级）
  PREFS_UNAVAILABLE: 501,
  SYSOPS_RECORDS_UNAVAILABLE: 501,
  RECORDS_UNAVAILABLE: 501,
  SYSOPS_RULE_STORE_UNAVAILABLE: 501,
  // 参数 / 数据形状问题：客户端能改
  PREFS_INVALID: 400,
  PREFS_UNKNOWN_KEY: 400,
  SYSOPS_RECORDS_INVALID: 400,
  RECORDS_INVALID: 400,
  SYSOPS_RULE_BAD_RULE: 400,
  BAD_JSON: 400,
  EMPTY_QUERY: 400,
  INVALID_PARAM: 400,
  // 红线拒绝：看得懂的 403
  SYSOPS_RULE_GUARD_DENY: 403,
  FORBIDDEN: 403,
  GUARD_BAD_INPUT: 403, GUARD_FULLWIDTH: 403, GUARD_PREFIX_ESCAPE: 403, GUARD_UNC: 403,
  GUARD_UNEXPANDED_VAR: 403, GUARD_NO_DRIVE: 403, GUARD_SHORT_NAME: 403, GUARD_PARENT_ESCAPE: 403,
  GUARD_REGISTRY: 403, GUARD_SYSTEM_DIR: 403, GUARD_RECYCLE_BIN: 403, GUARD_PROGRAM_FILES: 403,
  GUARD_CASE_VARIANT: 403, GUARD_JUNCTION_ESCAPE: 403, GUARD_GLOB_OVERREACH: 403, GUARD_OPERATION_DENIED: 403,
  // 记录寻址 / 生命周期
  SYSOPS_RULE_UNKNOWN_ID: 404,
  SYSOPS_RECORDS_NOT_FOUND: 404,
  SYSOPS_RECORDS_DUPLICATE: 409,
  PREFS_CLOSED: 503,
  SYSOPS_RECORDS_CLOSED: 503,
  RECORDS_CLOSED: 503,
  // 路由结构码（分派处直接给状态，这里登记以防被 handler 抛出）
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
};

/** code → 状态码；未登记的 code 一律 500，绝不返回 200。 */
export function statusFor(code) {
  return CODE_STATUS[code] ?? 500;
}

/* ------------------------------------------------------------------ *
 * SSE：单条连接 + 广播 hub
 * ------------------------------------------------------------------ */

/**
 * 开一条 SSE 通道。返回 `{ send(event, data), close() }`。
 * - 立即写一帧注释 `: ok`，把任何反代缓冲冲掉；
 * - 每 25s 一帧 `: ping` 心跳（unref，不拖住进程退出）；
 * - `send` 一次写完一整帧，绝不半帧；write 抛错原样冒出去，交 hub 摘牌
 *   （这是全局约束第 4 条「禁止静默 catch」唯一认可的例外：断开无需留痕）；
 * - `close` 幂等：只清心跳，不再写半帧。
 */
export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.write(': ok\n\n');
  const hb = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { closed = true; }
  }, 25000);
  if (typeof hb.unref === 'function') hb.unref();
  return {
    send(event, data) {
      if (closed) return;
      // 不判断 write 的返回值：背压不管，掉帧优于卡住服务端。抛错才说明真断了。
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(hb);
    },
  };
}

/**
 * SSE 连接集合。`onFirst` 在首个连接建立时触发，`onLast` 在最后一个断开时触发
 * —— 装配里它们就是 `collect.setVisible(true/false)`（L1b 只在「有连接 + 可见」时付那一轮成本）。
 */
export function createHub(onFirst, onLast) {
  const clients = new Set();
  const api = {
    add(client) {
      clients.add(client);
      if (clients.size === 1) onFirst?.();
    },
    remove(client) {
      if (!clients.delete(client)) return;
      try { client.close?.(); } catch { /* 关不上的连接已断，无需解释 */ }
      if (clients.size === 0) onLast?.();
    },
    get count() {
      return clients.size;
    },
    broadcast(event, data) {
      for (const c of [...clients]) {
        try {
          c.send(event, data);
        } catch {
          // 唯一静默例外：写失败 = 客户端已断开，摘掉它（close 里清心跳）
          clients.delete(c);
          try { c.close?.(); } catch { /* 同上 */ }
          if (clients.size === 0) onLast?.();
        }
      }
    },
  };
  return api;
}

/* ------------------------------------------------------------------ *
 * 快照组合：采集 8 键 + alerts + clean = 10 键
 * ------------------------------------------------------------------ */

/** 采集 snapshot 出八键，alerts / clean 由本层补两键（与 rt-1 的键集一致）。 */
async function snapshotOf(deps) {
  const { collect, alerts, clean } = deps;
  const base = collect.snapshot();
  const hits = await alerts.hits({ limit: 50 });
  const st = clean.state();
  // skipped 无上限：这里把可能的巨型数组截成 {count, sample}，避免快照被撑爆（Task 12 遗留顾虑）
  const cleanState = normalizeCleanState(st);
  return {
    ...base,
    alerts: { unread: alerts.unread(), rules: alerts.ruleRows(), hits: hits.rows, hitsError: hits.error ?? null },
    clean: { ...cleanState, plan: st.planId },
  };
}

/**
 * `clean.state().skipped` 在真机上可能是无上限数组（Task 12 遗留：skipped 无上限 + INCOMPLETE 文案 ~150B 预算）。
 * 透出到快照/SSE 前做可见截断：只留条数 + 前 20 条样本，并给一句「已截断」文案，不静默丢。
 */
function normalizeCleanState(st) {
  const out = { ...st };
  if (Array.isArray(st.skipped)) {
    const SAMPLE_MAX = 20;
    out.skipped = {
      count: st.skipped.length,
      sample: st.skipped.slice(0, SAMPLE_MAX),
      truncated: st.skipped.length > SAMPLE_MAX,
      note: st.skipped.length > SAMPLE_MAX ? `跳过项共 ${st.skipped.length} 条，仅列前 ${SAMPLE_MAX} 条` : '',
    };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */

// 每个值是 `{ handler: (deps) => async (req, res, body, url) => boolean }`。
// handler 返回 `sendJson/json` 的 true，或直接不返回（SSE 保持长连接）。
export const ROUTES = {
  'GET /api/snapshot': {
    handler: (deps) => async (req, res) => jsonOk(res, await snapshotOf(deps)),
  },
  'GET /api/stream': {
    handler: (deps) => async (req, res) => {
      const hub = deps.hub;
      const sse = openSse(res);
      const client = { send: sse.send, close: sse.close };
      hub.add(client);
      // 断开清理：真机 Node res 是 EventEmitter；close 时摘牌（末个连接触发 setVisible(false)）
      res.on('close', () => hub.remove(client));
      const snap = await snapshotOf(deps);
      sse.send('snapshot', snap);
      // 不 end：保持长连接
      return true;
    },
  },

  'GET /api/prefs': {
    handler: (deps) => async (req, res) => {
      // 读在无 storageDomain 时仍 200：把 UNAVAILABLE 归一化成「库里没东西」的空形状
      try {
        const all = await deps.prefStore.readAll();
        return jsonOk(res, all);
      } catch (e) {
        if (e?.code === 'PREFS_UNAVAILABLE') return jsonOk(res, { prefs: null, clean_rules: null });
        throw e;
      }
    },
  },
  'POST /api/prefs': {
    handler: (deps) => async (req, res, body) => {
      await deps.prefStore.writeMany(body);
      const all = await deps.prefStore.readAll();
      return jsonOk(res, all);
    },
  },

  'POST /api/collect/cadence': {
    handler: (deps) => async (req, res, body) => {
      if (!COLLECT_CADENCE.includes(body.cadence)) {
        throw Object.assign(new Error(`cadence 必须是 ${COLLECT_CADENCE.join(' | ')} 之一`), { code: 'INVALID_PARAM' });
      }
      await deps.collect.setCadence(body.cadence);
      return jsonOk(res, { cadence: body.cadence });
    },
  },
  'POST /api/collect/source': {
    handler: (deps) => async (req, res, body) => {
      await deps.collect.setSource(body.key, body.on);
      return jsonOk(res, { key: body.key, on: Boolean(body.on) });
    },
  },
  'POST /api/collect/visibility': {
    handler: (deps) => async (req, res, body) => {
      await deps.collect.setVisible(Boolean(body.visible));
      return jsonOk(res, { visible: Boolean(body.visible) });
    },
  },
  'POST /api/collect/restart': {
    handler: (deps) => async (req, res, body) => {
      await deps.collect.restartSource(body.key);
      return jsonOk(res, { key: body.key });
    },
  },

  'GET /api/alerts': {
    handler: (deps) => async (req, res, body, url) => {
      const limit = clampInt(url?.searchParams?.get('limit'), 50, 1, 200);
      const hits = await deps.alerts.hits({ limit });
      return jsonOk(res, { rules: deps.alerts.ruleRows(), unread: deps.alerts.unread(), hits: hits.rows, error: hits.error ?? null });
    },
  },
  'POST /api/alerts/read': {
    handler: (deps) => async (req, res) => {
      deps.alerts.markRead();
      return jsonOk(res, { unread: 0 });
    },
  },

  'POST /api/clean/scan': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.clean.startScan()),
  },
  'POST /api/clean/scan/stop': {
    handler: (deps) => async (req, res) => {
      deps.clean.stopScan();
      return jsonOk(res, normalizeCleanState(deps.clean.state()));
    },
  },
  'GET /api/clean/state': {
    handler: (deps) => async (req, res) => jsonOk(res, normalizeCleanState(deps.clean.state())),
  },
  'POST /api/clean/apply': {
    handler: (deps) => async (req, res, body) => {
      // 红线闸门在前：只摘三键，路径一概不转（全局约束 6）
      if (typeof body.planId !== 'string' || body.planId.trim() === '') {
        throw Object.assign(new Error('apply 缺少 planId'), { code: 'INVALID_PARAM' });
      }
      if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) {
        throw Object.assign(new Error('apply 的 itemIds 必须是非空数组'), { code: 'INVALID_PARAM' });
      }
      if (!APPLY_MODES.includes(body.mode)) {
        throw Object.assign(
          new Error(`mode 必须是允许的操作之一：${APPLY_MODES.join(' | ')}（delete-file / delete-dir / move-to-quarantine）`),
          { code: 'INVALID_PARAM' },
        );
      }
      const forwarded = { planId: body.planId, itemIds: body.itemIds, mode: body.mode };
      return jsonOk(res, await deps.clean.apply(forwarded));
    },
  },
  'GET /api/clean/logs': {
    handler: (deps) => async (req, res, body, url) => {
      const limit = clampInt(url?.searchParams?.get('limit'), 50, 1, 200);
      return jsonOk(res, await deps.clean.logs({ limit }));
    },
  },
  'GET /api/clean/unfinished': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.clean.unfinished()),
  },
  'GET /api/quarantine': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.clean.quarantineStats()),
  },

  'GET /api/rules': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.ruleStore.list()),
  },
  'POST /api/rules/add': {
    handler: (deps) => async (req, res, body) => jsonOk(res, await deps.ruleStore.add(body)),
  },
  'POST /api/rules/remove': {
    handler: (deps) => async (req, res, body) => jsonOk(res, await deps.ruleStore.remove(body.id)),
  },
  'POST /api/rules/toggle': {
    handler: (deps) => async (req, res, body) => jsonOk(res, await deps.ruleStore.toggle(body.id, Boolean(body.on))),
  },

  'GET /api/search': {
    handler: (deps) => async (req, res, body, url) => {
      const q = url?.searchParams?.get('q') ?? '';
      const limit = clampInt(url?.searchParams?.get('limit'), undefined, 1, 1000);
      if (!String(q).trim()) {
        // 空 q 直接 200 + 空结果 + error（不回落到 service，免得把 blank 发进任何适配器）
        return jsonOk(res, {
          rows: [], source: null, sourceLabel: '', truncated: false, stale: false,
          note: '', error: 'EMPTY_QUERY', took: 0, limit: limit ?? 200,
        });
      }
      const arg = { q };
      const mode = url?.searchParams?.get('mode');
      if (mode) arg.mode = mode;
      if (limit !== undefined) arg.limit = limit;
      return jsonOk(res, await deps.search.search(arg));
    },
  },
  'GET /api/search/probe': {
    handler: (deps) => async (req, res) => jsonOk(res, await deps.probe.probe()),
  },
  'POST /api/search/reprobe': {
    handler: (deps) => async (req, res) => {
      deps.probe.invalidate();
      return jsonOk(res, await deps.probe.probe(true));
    },
  },

  'GET /api/caps': {
    handler: (deps) => async (req, res) => {
      const caps = { ...deps.caps.read(), notifications: false, autostart: false };
      return jsonOk(res, caps);
    },
  },
};

/** 把字符串/数字钳成 [min,max] 整数；无法解析用 dflt。 */
function clampInt(raw, dflt, min, max) {
  if (raw === undefined || raw === null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 某 path 上被登记的方法集合（405 判定用）。 */
function methodsForPath(path) {
  const out = [];
  for (const key of Object.keys(ROUTES)) {
    const [m, p] = key.split(' ');
    if (p === path) out.push(m);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 回环闸门
 * ------------------------------------------------------------------ */

function isLoopIp(ip) {
  const s = String(ip ?? '').replace(/^\[|\]$/g, '');
  return /^127\./.test(s) || s === '::1' || s.toLowerCase() === 'localhost';
}

/**
 * 本插件能删本机文件，绝不接受经反代转发进来的远程驱动：
 * `remoteAddress` 必须是回环，且 `x-forwarded-for` 一旦存在就要求每一跳都是回环。
 */
export function isLoopback(req) {
  const ip = req?.socket?.remoteAddress ?? '';
  if (!isLoopIp(ip)) return false;
  const xff = req?.headers?.['x-forwarded-for'];
  if (xff) {
    for (const hop of String(xff).split(',')) {
      if (!isLoopIp(hop.trim())) return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * URL 归一：测试传 URL 对象，真机传字符串
 * ------------------------------------------------------------------ */
function toUrl(raw) {
  if (raw instanceof URL) return raw;
  if (raw && typeof raw === 'object' && typeof raw.pathname === 'string') return raw;
  return new URL(String(raw ?? '/'), 'http://127.0.0.1');
}
function stripPrefix(pathname) {
  if (pathname.startsWith(ROUTE_PREFIX)) {
    const rest = pathname.slice(ROUTE_PREFIX.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/* ------------------------------------------------------------------ *
 * handler 装配
 * ------------------------------------------------------------------ */

/**
 * 造路由 handler。deps 里 `collect` 需带 setVisible，`probe` 为独立 dep（属搜索域，不塞进 clean）。
 * 三个 service 的事件各订阅一次 → 汇进同一个 hub 广播成 SSE 帧。
 */
export function createApiHandler(deps) {
  const { collect, alerts, clean, logger } = deps;
  const hub = createHub(
    () => collect?.setVisible?.(true),
    () => collect?.setVisible?.(false),
  );
  const d = { ...deps, hub };

  // service 事件 → SSE 帧（一一对应，事件名 = type）
  const unsubscribers = [];
  for (const svc of [collect, alerts, clean]) {
    if (svc && typeof svc.onEvent === 'function') {
      unsubscribers.push(svc.onEvent((ev) => {
        if (ev && typeof ev.type === 'string') hub.broadcast(ev.type, normalizeCleanEvent(ev));
      }));
    }
  }

  async function handler(req, res, bodyArg) {
    const url = toUrl(req.url);
    const path = stripPrefix(url.pathname);
    const method = req.method ?? 'GET';

    if (!isLoopback(req)) {
      return json(res, 403, errBody('FORBIDDEN', '本插件可删除本机文件，仅接受来自本机回环（127.0.0.1 / ::1）的请求，不接受远程或反代转发驱动'));
    }

    const key = `${method} ${path}`;
    const entry = ROUTES[key];
    if (!entry) {
      const allowed = methodsForPath(path);
      if (allowed.length) {
        return json(res, 405, errBody('METHOD_NOT_ALLOWED', `请求方法 ${method} 不被允许，${path} 仅支持 ${allowed.join(' | ')}（写操作用 POST）`));
      }
      return json(res, 404, errBody('NOT_FOUND', `未知路由 ${method} ${path}`));
    }

    try {
      // 测试把已解析的体作为第三参给出；真机只收 (req,res)，体走 readBody(req)
      const body = bodyArg && typeof bodyArg === 'object' && typeof bodyArg.pathname !== 'string'
        ? bodyArg
        : await readBody(req);
      return await entry.handler(d)(req, res, body, url);
    } catch (e) {
      const code = e?.code ?? 'INTERNAL';
      const status = statusFor(code);
      // 每个抛错都留 warn（禁止静默 catch，全局约束 4）
      logger?.warn?.(`[sysops] 接口异常 ${key}（${code}）：${e?.message ?? e}`);
      return json(res, status, errBody(code, e?.message ?? String(e)));
    }
  }

  handler.dispose = () => {
    for (const u of unsubscribers) { try { u?.(); } catch { /* 订阅者已散，无需解释 */ } }
    unsubscribers.length = 0;
  };
  return handler;
}

/** SSE 的 clean 事件里也可能带巨型 skipped 数组，同快照口径截断。 */
function normalizeCleanEvent(ev) {
  if (ev.type === 'clean:summary' && ev.summary && Array.isArray(ev.summary.skipped)) {
    return { ...ev, summary: normalizeCleanState(ev.summary) };
  }
  return ev;
}
