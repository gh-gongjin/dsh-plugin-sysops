/**
 * AI 清理建议（S12-C，用户批注「增加AI智能清理」）。
 *
 * 边界（本轮已批口径之一：AI **只推荐 + 就地确认，不自动执行**）：
 *  - 输入只有**冻结清单**的类别汇总 —— 一条规则 = 一类目录。模型看不到完整路径，也看不到勾选状态：
 *    清单里的路径来自扫描那一刻的快照，把整段本机用户名送进模型换不来任何判定质量
 *    （类别名 + 条目文件名足够回答「这一类现在能不能清」）。
 *  - 输出**只允许找回清单里已有的分类**：模型交回的是**行号**，既不是路径也不是 id；
 *    id 由服务端从同一份快照按行号反查。行号越界 / 动作不在集合 / 重复行 —— 一概丢弃并
 *    如实计数进 `dropped`，不静默（全局约束 4）。
 *  - 本模块**不判断任何路径能不能删**：`lib/clean/guard.js` 仍是唯一裁决者，删除仍走
 *    `POST /api/clean/apply` 的三段闸（planId + itemIds + mode，且只认那份冻结快照）。
 *
 * 宿主 LLM 契约（股票插件已在真机踩过，见 dsh-plugin-stock-analysis/docs/host-capabilities.md §二）：
 *  - `ctx.llm` 只能经 `ctx.inject(['llm'], …)` 拿到（Context 是代理，同步段直接读会抛）；
 *  - provider / model **不写死**：运行时 `listProviders()` + `listModels()` 发现；
 *  - 失败按 `code` 分支，绝不匹配 message 文本；
 *  - `reasoning-delta` 是思考过程，只记字数，绝不累加进正文；
 *  - 一个字的正文都没有 = **失败**（思考型模型把输出预算烧在思考上），不是「降级成功」。
 */

/** 一次交给模型判定的分类行数上限：主流清理工具的分类面板也就这一屏。 */
export const AI_MAX_GROUPS = 24;
/** 每类附给样例的文件数：够模型认出「这是 Cache 还是 CrashReports」，又不吃输入预算。 */
const SAMPLES_PER_GROUP = 4;
/** 理由限长（字符）：超了就截，界面不给模型的话占满一整屏。 */
const REASON_MAX = 80;
/** 模型能交回的动作，封闭集合；集合外的判定按「越界」丢弃并计数。 */
export const AI_ACTIONS = ['clean', 'review', 'keep'];
/** 默认整体超时：比一次正常的深度思考长，比用户愿意等的上限短。 */
export const AI_DEADLINE_MS = 45000;

const DAY = 86400000;

/** 本模块自己的错误码（上游失败码另见 `AI_UPSTREAM`）。 */
export const AI_ERROR = {
  UNAVAILABLE: 'AI_UNAVAILABLE',
  TIMEOUT: 'AI_TIMEOUT',
  NO_OUTPUT: 'AI_NO_OUTPUT',
  BAD_OUTPUT: 'AI_BAD_OUTPUT',
  UPSTREAM: 'AI_UPSTREAM',
};

/** 失败码 → 用户看得懂的中文（与股票插件同一口径：**指出病因 + 下一步**）。 */
const AI_HINT = {
  [AI_ERROR.UNAVAILABLE]: '宿主没有提供模型调用能力（ctx.llm），AI 智能清理不可用：清理仍走人工勾选的两段式确认，功能没有打折。',
  [AI_ERROR.TIMEOUT]: '模型这次超时了，没有产生任何建议：清单没变，可以直接重试一次，或换响应更快的模型。',
  [AI_ERROR.NO_OUTPUT]: '模型这次只有思考、没有产出正文（输出预算被思考占满）：换一个模型再试。',
  [AI_ERROR.BAD_OUTPUT]: '模型的返回不是约定的 JSON，本次判定已全部丢弃：可以重试一次，或换模型。',
  [AI_ERROR.UPSTREAM]: '模型调用失败。',
  NO_ADAPTER: '宿主没有已注册且可用的模型 provider，请在宿主设置里配置模型。',
  MISSING_CREDENTIAL: '模型凭证缺失，请在宿主设置里填写 API Key。',
  INVALID_CREDENTIAL: '模型凭证无效，请检查 API Key。',
  AUTH: '模型鉴权失败，请检查账号或密钥。',
  RATE_LIMIT: '触发模型限流，稍后重试。',
  QUOTA: '模型额度已用尽。',
  ACCOUNT_QUOTA: '账号余额不足。',
  CONTEXT_WINDOW_EXCEEDED: '本次分类太多，超出模型上下文长度：本次只判定体积最大的那几类，或减少启用的清理规则。',
};

export function describeAiFailure(code, rawMessage) {
  const hint = AI_HINT[code] ?? `${AI_HINT[AI_ERROR.UPSTREAM]}（${code}）`;
  return rawMessage ? `${hint} 原始信息：${rawMessage}` : hint;
}

function aiError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * FNV-1a 32 位 → 16 进制。**不是**加密摘要：只需要「同一输入必得同一串」，
 * 用来把本次 prompt 与存档/日志对上，不引 node:crypto（本模块零依赖，连内置包都不必多带）。
 */
function promptHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000000) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, '0')}`;
}

/** 路径 → 末段名字（只取文件名/目录名，**不带盘符与父路径**）。 */
function baseName(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(无名)';
}

/** 字节 → MB（一位小数，模型侧口径；界面口径仍是 client 的 fmtBytes，两处各管各的用途）。 */
const toMb = (bytes) => (Number(bytes) / 1048576).toFixed(1);
const toGb = (bytes) => (Number(bytes) / 1073741824).toFixed(2);

/**
 * 冻结快照的 items → 按规则（= 一类目录）汇总。
 * 行号在这里定：排序 + 截断**之后**才编号，模型看到的行号与服务端反查的行号才是同一个。
 */
function groupByRule(items, refAt) {
  const map = new Map();
  for (const it of items) {
    const key = String(it.ruleId ?? '');
    let g = map.get(key);
    if (!g) {
      g = { ruleId: key, ruleName: String(it.ruleName ?? key), kind: String(it.kind ?? ''), ids: [], count: 0, bytes: 0, cleanable: 0, risky: 0, minAgeDays: null, maxAgeDays: null, samples: [] };
      map.set(key, g);
    }
    g.ids.push(String(it.id));
    g.count += 1;
    g.bytes += Number(it.size) || 0;
    // 风险三态在快照里是扁平 riskLevel（mid=有风险，其余按可清理报给模型；已拒绝的不是快照字段，guard 在闸那侧）
    if (it.riskLevel === 'mid') g.risky += 1; else g.cleanable += 1;
    const acc = Number(it.atime);
    if (Number.isFinite(acc) && acc > 0) {
      const days = Math.max(0, Math.floor((refAt - acc) / DAY));
      g.minAgeDays = g.minAgeDays === null ? days : Math.min(g.minAgeDays, days);
      g.maxAgeDays = g.maxAgeDays === null ? days : Math.max(g.maxAgeDays, days);
    }
    if (g.samples.length < SAMPLES_PER_GROUP) g.samples.push(baseName(it.path));
  }
  return [...map.values()];
}

function renderGroupLine(g, idx) {
  const age = g.minAgeDays === null ? '年龄未知' : `${g.minAgeDays}~${g.maxAgeDays} 天未访问`;
  return `${idx}. ${g.ruleName} | ${g.kind || '目录'} | ${g.count} 项 | ${toMb(g.bytes)} MB | ${age}`
    + ` | 可清理 ${g.cleanable} / 有风险 ${g.risky} | 样例: ${g.samples.join(', ')}`;
}

/** 从模型正文里取第一个 `{` 到最后一个 `}`：思考型模型爱套 markdown 围栏，围栏本身不是错误。 */
function extractJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * @param options.getLlm 惰性取宿主 ctx.llm 的函数（**不要直接读 ctx 属性**，Context 是代理）
 * @param options.planStore Task 13 的快照仓储（唯一输入来源）
 * @param options.logger 留痕：所有降级都 warn 一行，不静默
 * @param options.now 注入时钟
 * @param options.deadlineMs 本次调用的整体超时
 */
export function createAiAdvisor({ getLlm, planStore, logger, now = () => Date.now(), deadlineMs = AI_DEADLINE_MS } = {}) {
  let discovered = null;   // 宿主模型清单在进程内不会变，发现一次就够

  const readLlm = () => {
    try {
      return typeof getLlm === 'function' ? getLlm() : undefined;
    } catch {
      // 注入回调还没跑 / fiber 已销毁：一律当「暂时没有」，不抛（describe 会如实报不可用）
      return undefined;
    }
  };
  const usableLlm = () => {
    const llm = readLlm();
    return llm && typeof llm.stream === 'function' ? llm : null;
  };

  function listProviders() {
    const llm = usableLlm();
    if (!llm || typeof llm.listProviders !== 'function') return [];
    try {
      return (llm.listProviders() ?? []).map((p) => ({ id: p?.id ?? String(p), name: p?.name ?? p?.id ?? String(p) }));
    } catch (e) {
      logger?.warn?.(`[sysops] 读取宿主模型 provider 清单失败（按不可用处理）：${e?.code ?? ''} ${e?.message ?? e}`);
      return [];
    }
  }

  async function listModels(providerId) {
    const llm = usableLlm();
    if (!llm || typeof llm.listModels !== 'function') return [];
    try {
      const models = (await llm.listModels(providerId)) ?? [];
      return models.map((m) => ({ provider: m.provider ?? providerId, id: m.id, name: m.name ?? m.id }));
    } catch (e) {
      logger?.warn?.(`[sysops] 读取 provider ${providerId} 的模型清单失败（回落该 provider 默认模型）：${e?.message ?? e}`);
      return [];
    }
  }

  /** 配置里没写模型这一说：本插件**只走运行时发现**，用户换模型不用改插件。 */
  async function resolveModel() {
    if (discovered) return discovered;
    for (const p of listProviders()) {
      const models = await listModels(p.id);
      if (models.length) {
        discovered = { provider: p.id, model: models[0].id, modelName: models[0].name, source: 'discovered' };
        return discovered;
      }
      if (p.id) {
        // 适配器不给清单 ≠ 不能用：让宿主按该 provider 的默认模型解析
        discovered = { provider: p.id, model: undefined, source: 'provider-default' };
        return discovered;
      }
    }
    return null;
  }

  /** 就绪度现答（`GET /api/clean/ai`）：能力快照可能过期，界面进页时必须问一次。 */
  async function describe() {
    const llm = usableLlm();
    if (!llm) {
      return { available: false, provider: null, model: null, reason: AI_HINT[AI_ERROR.UNAVAILABLE] };
    }
    const resolved = await resolveModel();
    if (!resolved?.provider) {
      return { available: false, provider: null, model: null, reason: AI_HINT.NO_ADAPTER };
    }
    return {
      available: true,
      provider: resolved.provider,
      model: resolved.model ?? null,
      modelName: resolved.modelName ?? null,
      source: resolved.source,
      reason: '',
    };
  }

  /** 把 llm 的流收成正文（reasoning 只计字数）。抛错交上层按 code 归一。 */
  async function collectText(llm, options) {
    const ctrl = new AbortController();
    let timedOut = false;
    // 这个计时器是本次调用**唯一的收手保证**，所以刻意不 unref：
    // unref 之后「进程恰好空闲 ⇒ 计时器不跑 ⇒ 请求永远挂着」这条路是可能发生的，
    // 而挂着的正是我们自己许下的超时。（生产里 dsh web 本来就把事件循环撑着，行为不变。）
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, deadlineMs);
    let text = '';
    let reasoningChars = 0;
    let finishKind = 'unknown';
    let failure = null;
    try {
      for await (const chunk of llm.stream({ ...options, signal: ctrl.signal })) {
        switch (chunk?.type) {
          case 'text-delta':
            text += chunk.text ?? '';
            break;
          case 'reasoning-delta':
            // 只数字，不进正文：把它当正文累积会把「没有产出」伪装成成功
            reasoningChars += (chunk.text ?? '').length;
            break;
          case 'finish': {
            const reason = chunk.reason ?? {};
            finishKind = reason.kind ?? 'unknown';
            if (reason.kind === 'error') failure = reason.failure ?? null;
            else if (reason.kind === 'aborted') failure = { code: 'ABORTED', message: '已取消' };
            break;
          }
          default:
            break;
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw aiError(AI_ERROR.TIMEOUT, describeAiFailure(AI_ERROR.TIMEOUT));
    if (failure) {
      const code = failure.code ?? failure.name ?? 'UNKNOWN';
      throw aiError(AI_ERROR.UPSTREAM, describeAiFailure(code, failure.message), { upstreamCode: code });
    }
    return { text, reasoningChars, finishKind };
  }

  /**
   * 对一份冻结清单要一次建议。
   *
   * @param planId **唯一**入参：路径 / id / 勾选状态一概不从调用方来（全局约束 6）
   * @returns `{ planId, recommendations, dropped, missing, note, model, provider, params, promptHash }`
   */
  async function suggest(planId) {
    const id = String(planId ?? '').trim();
    if (!id) throw aiError('INVALID_PARAM', 'AI 建议缺少 planId：只对已经冻结的那份清单征求建议');

    const llm = usableLlm();
    if (!llm) throw aiError(AI_ERROR.UNAVAILABLE, describeAiFailure(AI_ERROR.UNAVAILABLE));
    const resolved = await resolveModel();
    if (!resolved?.provider) throw aiError(AI_ERROR.UNAVAILABLE, describeAiFailure('NO_ADAPTER'));

    const plan = await planStore.get(id);
    if (!plan || !Array.isArray(plan.items)) {
      throw aiError('SYSOPS_RECORDS_NOT_FOUND', `清单快照 ${id} 不存在（可能已被裁剪或从未保存），请先重新扫描`);
    }
    const items = plan.items;
    if (items.length === 0) {
      return { planId: id, at: now(), recommendations: [], dropped: { count: 0 }, missing: 0, groupsSent: 0, groupsTotal: 0, note: '这份清单是空的，没有可判断的分类。' };
    }

    const refAt = Number(plan.at) || now();
    const all = groupByRule(items, refAt);
    // 体积最大的先问：截断时留下的是「最值得清的那批」，而不是 Map 插入顺序的前 N 条
    const ranked = [...all].sort((a, b) => b.bytes - a.bytes);
    const sent = ranked.slice(0, AI_MAX_GROUPS);
    const truncated = ranked.length - sent.length;

    const totalBytes = items.reduce((a, i) => a + (Number(i.size) || 0), 0);
    const beforeFree = Number(plan.beforeFree);
    const freeText = Number.isFinite(beforeFree) && beforeFree > 0 ? `${toGb(beforeFree)} GB` : '未知';
    const table = sent.map((g, i) => renderGroupLine(g, i)).join('\n');
    const system = '你是 Windows 磁盘清理助手，为一个「两段式清理器」给出分类级别的建议。'
      + '你只能对给出的每个编号分类做判定：不许新增目录、不许改写名称、不许推测编号之外的内容。'
      + '「能不能删」由服务端红线闸门单点裁决，你的输出只是建议，用户必须自己确认。'
      + '只输出一个 JSON 对象，不要解释文字，不要 markdown 代码块。';
    const user = `系统盘 C: 扫描那一刻可用约 ${freeText}；本次清单共 ${items.length} 项、合计约 ${toMb(totalBytes)} MB。\n\n`
      + `分类（编号从 0 开始；字段依次是：名称 | 类型 | 条目数 | 合计大小 | 最老~最新条目的未访问年龄 | 风险标记 | 样例文件名）：\n${table}\n\n`
      + `请对**每一个编号**分类各给一条判定，输出形状：\n`
      + `{"recommendations":[{"group":0,"action":"clean","reason":"不超过 40 字的中文依据，说清是看年龄、大小还是类型"}]}\n`
      + `action 只能是 clean（现在清风险低）、review（建议用户自己看一眼）、keep（建议保留）。`;
    const prompt = `${system}\n\n${user}`;

    const params = { provider: resolved.provider, model: resolved.model ?? '(宿主默认)', temperature: 0.2 };
    const options = {
      provider: resolved.provider,
      system,
      temperature: params.temperature,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    };
    if (resolved.model) options.model = resolved.model;
    // 不写 maxTokens：宿主契约里「不传 = 不设上限」。写死了就是把长答案拦腰截停，
    // 而截断在 JSON 契约上表现为「解析失败」，用户会以为是插件的锅。

    const { text, reasoningChars, finishKind } = await collectText(llm, options);
    if (!text.trim()) {
      logger?.warn?.(`[sysops] AI 清理建议无正文（planId=${id}，思考 ${reasoningChars} 字，终止 ${finishKind}）`);
      throw aiError(AI_ERROR.NO_OUTPUT, describeAiFailure(AI_ERROR.NO_OUTPUT), { reasoningChars, finishKind });
    }
    const raw = extractJson(text);
    if (!raw || !Array.isArray(raw.recommendations)) {
      logger?.warn?.(`[sysops] AI 清理建议返回无法解析（planId=${id}，正文 ${text.length} 字，已全部丢弃）`);
      throw aiError(AI_ERROR.BAD_OUTPUT, describeAiFailure(AI_ERROR.BAD_OUTPUT), { outputChars: text.length });
    }

    const seen = new Set();
    const recommendations = [];
    let dropped = 0;
    for (const rec of raw.recommendations) {
      const idx = Number(rec?.group);
      const action = String(rec?.action ?? '');
      // 三条闸：行号必须在发出去的那几行里、动作必须在封闭集合里、同一行只认第一次
      if (!Number.isInteger(idx) || idx < 0 || idx >= sent.length || !AI_ACTIONS.includes(action) || seen.has(idx)) {
        dropped += 1;
        continue;
      }
      seen.add(idx);
      const g = sent[idx];
      recommendations.push({
        group: idx,
        ruleId: g.ruleId,
        ruleName: g.ruleName,
        kind: g.kind,
        count: g.count,
        bytes: g.bytes,
        cleanable: g.cleanable,
        risky: g.risky,
        action,
        reason: String(rec.reason ?? '').trim().slice(0, REASON_MAX),
        // ids 全部来自这份冻结快照，行号只是找回它们的地址：模型无法凭此删任何东西
        ids: g.ids,
      });
    }
    recommendations.sort((a, b) => a.group - b.group);

    const missing = sent.length - seen.size;
    let note = '';
    if (truncated > 0) note = `清单分类超过 ${AI_MAX_GROUPS} 行，本次只把体积最大的 ${sent.length} 类交给模型（其余 ${truncated} 类未征求，仍在清单里可手动勾选）。`;
    if (missing > 0) note += `${note ? ' ' : ''}模型漏判了 ${missing} 个分类，那些分类保持原样。`;
    if (dropped > 0) note += `${note ? ' ' : ''}另有 ${dropped} 条判定越界（行号不在发出去的清单里 / 动作不认识 / 重复），已丢弃。`;
    if (dropped > 0 || missing > 0 || truncated > 0) {
      logger?.warn?.(`[sysops] AI 清理建议如实降级（planId=${id}）：越界丢弃 ${dropped} 条 · 漏判 ${missing} 类 · 未送出 ${truncated} 类`);
    }

    return {
      planId: id,
      at: now(),
      provider: params.provider,
      model: params.model,
      params,
      promptHash: promptHash(prompt),
      promptChars: prompt.length,
      reasoningChars,
      finishKind,
      groupsSent: sent.length,
      groupsTotal: ranked.length,
      recommendations,
      dropped: { count: dropped },
      missing,
      note,
    };
  }

  return {
    get available() { return Boolean(usableLlm()); },
    describe,
    suggest,
    listProviders,
    listModels,
    resolveModel,
  };
}
