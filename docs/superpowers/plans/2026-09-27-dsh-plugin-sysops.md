# dsh-plugin-sysops 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 dsh 插件 `dsh-plugin-sysops`：本机实时监控 + 两段式 C 盘清理 + 全盘文件搜索，安装后出现在左侧栏，代码组织与视觉规范对齐 `dsh-plugin-stock-analysis`。

**Architecture:** 两半插件。宿主半边 `index.js` 探测能力（`storageDomain` / `timer` / `webServer`）、装配四个服务（采集 / 告警 / 清理 / 搜索）、注册 `/sysops` 前缀路由并以 SSE 推流；浏览器半边 `client.js` 零构建，经 `window.__ModuleLoader__` 加载，用 `require('react')` 渲染四页签并手工解 SSE 帧。"能不能删"单点收口在 `lib/clean/guard.js`；"删哪些"只认宿主侧快照里的 `planId + itemId`。

**Tech Stack:** Node 24 ESM（零第三方依赖，只用 `node:os` / `node:fs` / `node:path` / `node:child_process` / `node:http`）、Windows 采集工具链（`typeperf` / `powershell` / `taskkill` / `reg query`）、React（由宿主提供，经 ModuleLoader 的 `require`）、原生 SVG 画曲线、`node:assert/strict` 自研测试 harness。

**Spec:** `docs/superpowers/specs/2026-09-27-dsh-plugin-sysops-design.md`（已批准）。执行每个任务前读它对应章节；本计划与 spec 冲突时以 spec 为准，但第「计划期实测修正」一节的四条以本节为准并需回写 spec。

---

## Global constraints（每个任务都受约束，逐条来自 spec）

- 宿主半边 `index.js` 与 `lib/**` **零** `@deepseek-ai/*` import（`link:` 挂载会解析出第二份模块实例）。
- 零第三方依赖：`package.json` 不出现 `dependencies` / `devDependencies`，不引测试框架，不引覆盖率工具，**没有 npm script**。
- 测试只用 `node:assert/strict` + 自研 `check(name, fn)`，直跑 `node test/<x>.test.mjs`；真机项由 `SKIP_LOCAL=1` 跳过，跳过要打印 SKIP 且不计入通过数。
- 禁止 `catch {}` 静默：每个 catch 必须产生一个可见状态变化或一条时间线记录。唯一例外是响应写失败（客户端已断开）。
- 红线单点：系统目录 / 回收站 / `Program Files*` / 属主与 ACL / 注册表 —— 只有 `lib/clean/guard.js` 能裁决，其它模块不得自行放宽，也不得绕过它直接操作。
- 路径永不采信前端：`/api/clean/apply` 只收 `planId + itemIds + mode`。
- 不代装第三方软件、不写注册表（探测只读）、不结束任何进程、不做开机自启。
- 视觉与交互全部继承 `dsh-plugin-stock-analysis/docs/design-spec.md`：§5.1 token、§4 全局禁止顶部浮层提示条、三档断点 1080 / 860 / 620、`tabular-nums`、交互一律自研控件（禁原生 `confirm` / 校验气泡 / `<select>`）。
- 所有中文文案与界面用语与已确认原型 `prototype/index.html` 一致；注释与界面文字用中文。
- 写 `.ps1` / `.cmd` 内容要么全 ASCII 要么 UTF-8 带 BOM。
- 验证必须实跑取证：声称"通过"前要有当轮命令输出，不许引用上一轮结果。

---

## 计划期实测修正（2026-09-27 本机现采，四条，执行时按本节写代码并回写 spec）

spec §1.2 / §3.2 / §3.4 有三处假设在本机实测中不成立，一处前提需要补证。全部按本节执行，并在 Task 25 把结论回写 spec 对应小节（spec 明写"偏差 >20% 时更新本文件而不是继续引用旧值"）。

| # | spec 原假设 | 实测事实（同一台机器，2026-09-27） | 计划的处置 |
|---|---|---|---|
| 1 | L1a「常驻 typeperf，流式解析 stdout」 | `typeperf '\Network Interface(*)\Bytes Received/sec' -sc 0` 在 Node 管道（无控制台）下**只出一个样本就以 exit=0 退出**；`-sc 5 -si 1` 正常出 5 个样本、窗口 5375ms、输出 378 字节 | L1a 改为**定窗续采**：每窗 `-sc 30 -si 1`，exit=0 后立刻起下一窗。暖身 219ms / 窗，30s 窗口摊薄后 <1%；supervisor 需支持 `rolling` 语义（见 Task 6） |
| 2 | typeperf 输出可直接按 UTF-8 解析 | 首行是 `"(PDH-CSV 4.0)","\\¹¨½øµÄ»ªÎª±Ê¼Ç\Network Interface(Intel[R] Wi-Fi 6 AX201 160MHz)\Bytes Received/sec",…`，机器名为 GBK 字节；`new TextDecoder('gbk').decode(…)` 在本机 Node 24 可用（实测解出中文） | 解析层统一 `decodePd()`：优先 `TextDecoder('gbk')`，失败回落 `latin1`；机器名前缀用正则丢弃，只取 `Network Interface(<实例>)\<计数器>` |
| 3 | L1b「常驻 PowerShell，进程榜」 | 常驻 `while($true){ Get-CimInstance Win32_Process … Write-Output <json>; Start-Sleep 2 }` 跑通：首行 +1192ms，之后每轮 ≈2.5s，385 进程 / 行 17.7KB；`taskkill /PID /T /F` 能收掉（exit=1） | 保留常驻循环；采样间隔定 3s（不是 1s）；单轮超预算时按 Task 7 的降级规则砍列 |
| 4 | 搜索主源 Everything（HTTP `:3417` / `es.exe`） | `C:\Program Files\Everything` 不存在、`where es.exe` 无命中、`curl http://127.0.0.1:3417/` 拒连（000）——**本机未安装 Everything** | 两个适配器照写（契约来自公开文档），但标注「未在本机验证」；真机用例走 `SKIP_LOCAL`；`walk` 是当前唯一实跑通路，界面默认落降级态 |

> 另有一处接口措辞修正：spec §3.2 写 `PATCH /api/prefs` / `PATCH /api/rules`，而参照插件实测跑通的是 `POST`（宿主是否透传 PATCH 未验证）。**两个写接口一律用 POST**，不保留双方法别名（不为未验证的能力设计接口）。Task 25 回写 spec。

> 清理候选路径存在性（spec §8「逐条实测后才写入」）——2026-09-27 本机 `test -d` 复核，21 项：**存在** `AppData/Local/Temp`、`AppData/Local/Microsoft/Windows/Explorer`、`AppData/Local/npm-cache`、`AppData/Local/pip/Cache`、`AppData/Local/CrashDumps`、`AppData/Local/Packages`、`AppData/Local/Microsoft/Edge/User Data/Default/Cache`、`AppData/Local/Package Cache`、`.cache`、`AppData/Roaming/Code/Cache`、`AppData/Roaming/Tencent/WeChat`、`AppData/Roaming/DingTalk`、`AppData/Local/ms-playwright`；**不存在** `AppData/Local/Google/Chrome/Crashpad`、`AppData/Local/NuGet/v3-cache`、`.npm`、`.pnpm-store`、`AppData/Roaming/npm-cache`、`AppData/Local/Tencent/WeChat Runtime`、`AppData/Local/DingTalk`。内置规则表只收前者（Task 11）。

---

## 文件结构与职责（与 spec §2.2 一致，标 ★ 为本计划新增；唯一有意偏离是 `alerts/spec.js` → `records/spec.js`，见下方说明）

| 文件 | 职责 | 任务 |
|---|---|---|
| `package.json` `cordis.yml` | 零依赖包声明与 bundle patch | 1 |
| `lib/kv-schema.js` | 自造 schema（宿主只调 `parse/safeParse`） | 1 |
| `lib/caps.js` | 宿主能力探测与缓存，供设置页能力表 | 19 |
| `lib/clean/guard.js` | 红线唯一裁决点 + 分支清单 | 2 |
| `lib/prefs/{spec,store}.js` | `prefs` / `clean_rules` 两表（可覆盖语义） | 3 |
| `lib/collect/ring.js` `l0-node.js` | 环形缓冲、L0 纯 Node 采样 | 4 |
| `lib/collect/supervisor.js` | 子进程状态机 / 退避 / 心跳 / rolling | 5 |
| `lib/collect/l1a-typeperf.js` | GBK 解码 + PDH-CSV 解析 + 定窗续采 | 6 |
| `scripts/probe-collect.mjs` ★ | 复跑 spec §1.2 六项实测（验收门禁 5） | 6 |
| `lib/collect/l1b-powershell.js` | 常驻 PowerShell 进程榜 | 7 |
| `lib/collect/service.js` | 分层编排 + 档位 + 可见性驱动 | 8 |
| `lib/records/spec.js` ★（Task 13 由 `lib/alerts/spec.js` 改名） | 三张记录表的单一权威定义（`alert_hit` / `clean_plan` / `clean_log`）—— 三表齐了才看得出它不属于 alerts | 9、13 |
| `lib/alerts/{rules,store,service}.js` | 阈值判定纯函数 + `alert_hit` 读写 + 评估编排 | 9、10 |
| `lib/clean/{rules,scanner,plan-store,executor,log-store,quarantine,service}.js` | 内置库、扫描、快照、执行、留痕、暂存 | 11–15 |
| `lib/prefs/rules-store.js` | 本机清理规则（写入前过 guard） | 11 |
| `lib/search/{probe,everything-http,es-exe,walk,service}.js` | 三级探测 + 三适配器 + 归一化 | 16、17 |
| `lib/api.js` | 路由表 + 事件总线 + `openSse` + 回环校验 | 18 |
| `index.js` | 宿主半边 | 19 |
| `client.js` | 浏览器半边（四页签） | 20–24 |

**测试文件 → 任务映射**（8 个，spec §5 的 7 个 + 为存储层补的 `prefs.test.mjs`）：

| 文件 | 覆盖任务 | 段 |
|---|---|---|
| `test/guard.test.mjs` | 2 | 纯函数（红线矩阵 ≥40 例 + 分支清单 100%） |
| `test/prefs.test.mjs` | 1、3、11 | 纯函数 + 内存桩 |
| `test/collect.test.mjs` | 4、5、6、7、8 | 纯函数 + 假 child（零真进程） |
| `test/alerts.test.mjs` | 9、10 | 纯函数 + 假时钟 |
| `test/clean.test.mjs` | 11–15 | 真机（`%TEMP%` 真目录树，可跳）+ 打桩 |
| `test/search.test.mjs` | 16、17 | 打桩（fixture） |
| `test/plugin.test.mjs` | 18–24 | 加载 + 路由级 |
| `test/host-compat.test.mjs` | 19 | 能力缺失矩阵 |

---

## 测试 harness（所有测试文件共用的固定骨架）

新建任何 `test/*.test.mjs` 都以这段开头（形状抄自 `dsh-plugin-stock-analysis/test/prefs.test.mjs:18-43`，**逐字一致**，不要各自发明）：

```js
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const skip = process.env.SKIP_LOCAL === '1';

function check(name, fn) {
  if (skip && /真机/.test(name)) {
    console.log(`  SKIP  ${name}`);
    return;
  }
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n')[0]}`);
  }
}

async function checkAsync(name, fn) {
  if (skip && /真机/.test(name)) {
    console.log(`  SKIP  ${name}`);
    return;
  }
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split('\n')[0]}`);
  }
}

// 收尾（文件最后一行）
// process.exit(failed ? 1 : 0);  ← 异步用例用 run() 包一层后再 exit；同步文件直接在末尾写：
// console.log(`\n  ${passed}/${passed + failed} 通过`); process.exit(failed ? 1 : 0);
```

用例名里含「真机」三个字的会被 `SKIP_LOCAL=1` 跳过 —— 这是全局约定，写用例时要遵守。

**异步用例必须写成 `await checkAsync('…', async () => { … })`，不能写 `check('…', async () => …)`。** 取证：`check()` 是同步 `try/catch`，收到 async 函数时它拿到的是一个**正在挂起的 Promise** —— `fn()` 在第一个 `await` 处就返回了，`try` 块里一条断言都没执行完，于是立刻计一次 PASS；之后的断言失败变成**没人 catch 的 rejection**，进程退出时才报（且 `passed` 已经虚高）。Task 8 预检实测：`svc-4`/`svc-8` 用 `check()` 挂 async 时，把实现里 `setVisible` 的 `clearProc()` 和 `dispose` 的 `buildRings()` **整行删掉照样 48/48**；换成 `await checkAsync` 后同样两处变异分别红在 svc-4、svc-8。这一条对已写好的 ①~⑤段没有影响（它们全是同步用例），但**任何后续任务的异步用例都按此写**。

**关于 commit 步骤：** 本插件目录**已经是 git 仓库**（2026-09-27 用户授权后在 `F:\dsh-plugins\dsh-plugin-sysops` 单独 `git init`，工作分支 `feat/sysops-impl`，首提交 `60ea399`）。因此每个任务的收尾一律是：**测试全绿 → `git add` 本任务列出的文件 → 用该任务写好的提交信息 commit**。各任务正文里若还残留「无 git：本任务不提交」字样，按本段为准（那是授权前写的），执行时替换为提交。提交只含本任务 Files 里的路径，不许 `git add -A`；`tmp/`、`.superpowers/` 已在 `.gitignore` 里。

**关于 ④~⑦段（Task 21~24）的 Step 3：** 这四段是界面任务，Step 3 给的是**行为契约、文案来源与逐块对应关系**，不贴完整 JSX —— 权威视觉源是已确认的 `prototype/index.html`（spec §6），实现时按对应 `panel-*` 逐块搬、类名前缀改 `so-`、颜色换成 token 的 `var()` 引用。判断这一类步骤是否到位的唯一标准是**该段用例全绿**：用例里写死的每一句文案、每一个类名与 `disabled`，就是 Step 3 没贴出来的那段 JSX 必须产出的东西。

---

## Task 1: 包骨架与 kv-schema 底座

**Files:**
- Create: `package.json`
- Create: `cordis.yml`
- Create: `lib/kv-schema.js`
- Create: `test/prefs.test.mjs`（本任务只写 ①段，Task 3 续写）

**Interfaces:**
- Consumes: 无
- Produces: `lib/kv-schema.js` 导出 `makeSchema` `requiredString` `optionalString` `nullableString` `requiredInt` `optionalInt` `requiredNumber` `optionalNumber` `optionalBool` `requiredBool` `requiredEnum` `optionalEnum` `arrayOfItem` `arrayOf` `record` `domainTable` `defineDomain` `UNIT_NAME_RE` —— **共 18 个**，与参照实现逐字节同源、同名同签名。（本段原先漏列 `nullableString` 并写"16 个"，是照旧快照数的；Task 1 执行时实测参照文件 250 行 18 导出，"逐字节复制"是更硬的约束，故以现值为准 —— 见台账 Ruling-8。）

- [ ] **Step 1: 写失败的测试**

新建 `test/prefs.test.mjs`，先放 harness（见上文），再写 ①段三例：

```js
/* ①段：kv-schema 底座 */
const { defineDomain, domainTable, record, requiredString, optionalInt, optionalString, UNIT_NAME_RE } =
  await import('../lib/kv-schema.js');

check('schema-1 record 丢弃未声明字段（确定性优先）', () => {
  const r = record({ a: requiredString('a'), b: optionalInt('b') });
  const out = r.parse({ a: 'x', b: 1, zz: '脏字段' });
  assert.deepEqual(Object.keys(out).sort(), ['a', 'b']);
});

check('schema-2 空串视为未填，直接拒绝', () => {
  const r = record({ a: requiredString('a') });
  assert.throws(() => r.parse({ a: '   ' }), /a 必填/);
});

check('schema-3 defineDomain 挡下非法 domain 名 / 表名 / 接受 null 的 global', () => {
  assert.throws(() => defineDomain({ name: 'Sysops-Prefs', version: 1, tables: { t: domainTable(record({})) } }),
    /domain 名/);
  assert.throws(() => defineDomain({ name: 'sysops_prefs', version: 1, tables: { 'Bad-Table': domainTable(record({})) } }),
    /表名/);
  // 「接受 null 的 global」必须用一个真能吞下 null 的 schema：record({}) 连 null 都不收（抛「记录 必须是对象」），
  // 守卫永远不会被触发，那条断言就成了假断言。optionalString 才把 null 归一成 undefined。
  assert.throws(() => defineDomain({ name: 'sysops_prefs', version: 1, tables: { t: domainTable(record({})) }, global: { schema: optionalString('g') } }),
    /不能接受 null/);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/prefs.test.mjs`
Expected: 抛 `ERR_MODULE_NOT_FOUND`，信息含 `lib/kv-schema.js`（文件还不存在）。

- [ ] **Step 3: 写最小实现**

- `package.json`：照 `../dsh-plugin-stock-analysis/package.json` 的结构改字面量，零依赖、无 scripts：

```json
{
  "name": "dsh-plugin-sysops",
  "version": "0.1.0",
  "type": "module",
  "description": "DSH 系统运维插件：本机实时监控、两段式 C 盘清理、全盘文件搜索。只读采集 + 显式确认删除，不结束进程、不碰系统目录。",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": { "default": "./client.js" },
    "./package.json": "./package.json"
  },
  "files": ["index.js", "lib", "client.js", "cordis.yml", "README.md", "LICENSE"],
  "keywords": ["dsh", "dsh-plugin", "sysops", "monitor", "disk-clean", "windows"],
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "cordis.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

- `cordis.yml`：

```yaml
# dsh-plugin-sysops —— bundle patch
# 顶层是 patch 条目数组：把本插件插进 profile 的插件树。
#
# 安装后在 profile 的 cordis.patch.yml 里可按 id 覆盖或停用它：
#   - id: sysops
#     disabled: true

- insert:
    - id: sysops
      name: dsh-plugin-sysops
```

- `lib/kv-schema.js`：**逐字节复制** `../dsh-plugin-stock-analysis/lib/kv-schema.js`（250 行 / 18 个导出，含文件头说明），只把文件头第一段里的 `docs/host-capabilities.md 三` 改为 `../dsh-plugin-stock-analysis/docs/host-capabilities.md 三`，其余不动。理由（写进文件头新增的两行注释）：宿主 `storageDomain` 只调 `parse/safeParse` 且零 `instanceof` 检查，官方包不能 import（`link:` 会解析出第二份实例），所以两份实现必须**保持同源**，不要各自漂移。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/prefs.test.mjs`
Expected: `3/3 通过`，退出码 0。

- [ ] **Step 5: 留档**

Run: `node -e "import('./lib/kv-schema.js').then(m=>console.log(Object.keys(m).length))"`
Expected: 打印导出个数（**18**，与上面 Produces 清单逐一对得上；少一个说明复制漏了或多打了），把数字贴进任务汇报。
收尾提交（按上文「关于 commit 步骤」）：`git add package.json cordis.yml lib/kv-schema.js test/prefs.test.mjs`，提交信息 `feat(sysops): 包骨架与 kv-schema 底座`。

---

## Task 2: `lib/clean/guard.js` —— 红线唯一裁决点

**Files:**
- Create: `lib/clean/guard.js`
- Create: `test/guard.test.mjs`

**Interfaces:**
- Consumes: 无 IO，不依赖任何模块
- Produces:
  - `check(raw, opts?) → { allow: boolean, code: string, branch: string, why: string }`，`opts = { real?: string, mode?: 'path'|'glob' }`
  - `checkOperation(op: string) → 同上形状`（`op` ∈ `delete-file` `delete-dir` `move-to-quarantine`，其它一律拒）
  - `BRANCH_IDS: string[]`（分支清单，供测试断言 100% 覆盖）
  - `GUARD_CODE`（错误码常量表）
  - Task 11/12/15 只通过这两个函数问"能不能删"。

- [ ] **Step 1: 写失败的测试**

新建 `test/guard.test.mjs`（harness 见上文）。**用例数与"矩阵例数"是两个口径**：本任务写 19 个 `check()` 用例；spec §5 的「红线矩阵 ≥40 例」按**拒绝断言**计数（`deny()` / `denyOp()` 每调一次算一例），19 个用例里的拒绝断言合计 **61 条**（Task 2 实现期从 53 涨到 61：修复轮补了异盘受保护、drive-relative `..`、未闭合 `%VAR`、注册表内嵌形态等断言，全部补进既有用例体内，用例数仍 19），`guard-19` 把「>= 40」这条口径固化成断言防回归。

> **名字冲突是硬坑**：harness 已经占了 `check(name, fn)` 这个名字，guard 的导出也叫 `check`。所以 import 时**不解构 `check`**，整个模块存进 `Guard`，用例内部一律写 `Guard.check(...)`。若写成 `const { check } = await import(...)`，同一模块作用域里会出现两次声明 → 文件直接 `SyntaxError` 跑不起来（这正是本条要拦住的错）。

```js
const Guard = await import('../lib/clean/guard.js');
// 只解构用例里真用到的两个名字。GUARD_CODE 留给实现与 api.js 用，测试按 branch 断言即可，
// 在测试里再抄一遍 code 只会让"改文案要改两处"复发。
const { checkOperation, BRANCH_IDS } = Guard;

/** 分支命中台账：guard-18 用它断言 16 条红线分支一条都没漏。 */
const seenBranches = new Map(BRANCH_IDS.map((id) => [id, 0]));
let denyAssertions = 0;

const deny = (raw, branch, opts) => {
  assert.ok(seenBranches.has(branch), `用例写了不存在的分支 id：${branch}（BRANCH_IDS 里查不到）`);
  const r = Guard.check(raw, opts);
  assert.equal(r.allow, false, `应拒绝但放行了: ${raw}`);
  assert.equal(r.branch, branch, `${raw} 落错分支：期望 ${branch} 实得 ${r.branch}（${r.code}）`);
  assert.ok(r.why.length > 0, `${raw} 拒绝必须有原因文案`);
  seenBranches.set(branch, seenBranches.get(branch) + 1);
  denyAssertions += 1;
  return r;
};
const allow = (raw, opts) => {
  const r = Guard.check(raw, opts);
  assert.equal(r.allow, true, `应放行但拒绝: ${raw} → ${r.code} ${r.why}`);
  return r;
};

check('guard-01 系统目录：C:\\Windows 三种写法都拒', () => {
  deny('C:\\Windows\\win.ini', 'b-system-dir');
  deny('C:\\Windows', 'b-system-dir');
  deny('c:\\windows\\Temp', 'b-system-dir');
});
check('guard-02 回收站：$Recycle.Bin 与其内层目录都拒', () => {
  deny('C:\\$Recycle.Bin', 'b-recycle-bin');
  deny('C:\\$Recycle.Bin\\S-1-5-21-100', 'b-recycle-bin');
  deny('C:\\Recycler', 'b-recycle-bin');
});
check('guard-03 Program Files：含 (x86) 与子层都拒', () => {
  deny('C:\\Program Files\\App', 'b-program-files');
  deny('C:\\Program Files (x86)\\App', 'b-program-files');
  deny('D:\\Program Files\\x', 'b-program-files');
});
check('guard-04 大小写变体绕过受保护前缀', () => {
  deny('C:\\WiNdOws\\x', 'b-case-variant');
  deny('C:\\PROGRAM FILES\\x', 'b-case-variant');
  deny('C:\\$RECYCLE.BIN\\x', 'b-case-variant');
});
check('guard-05 全角字符伪装（U+FF23 冒盘符 / 全角冒号）', () => {
  deny('\uFF23:\\Windows\\x', 'b-fullwidth');
  deny('C\uFF1A\\Users\\x', 'b-fullwidth');
  deny('C:\\\\Ｕｓｅｒｓ\\a', 'b-fullwidth');
});
check('guard-06 \\?\\ 与 \\.\ 前缀逃逸', () => {
  deny('\\\\?\\C:\\Windows\\x', 'b-prefix-escape');
  deny('\\\\.\\C:\\Users\\a', 'b-prefix-escape');
  deny('\\\\?\\UNC\\server\\share\\x', 'b-prefix-escape');
});
check('guard-07 UNC 路径', () => {
  deny('\\\\fileserver\\c$\\Users', 'b-unc');
  deny('\\\\nas\\share\\cache', 'b-unc');
  deny('\\\\10.0.0.5\\temp', 'b-unc');
});
check('guard-08 8.3 短名', () => {
  deny('C:\\PROGRA~1\\App', 'b-short-name');
  deny('C:\\Users\\gongj\\AppData\\LOCAL~1\\Temp', 'b-short-name');
  deny('C:\\Windows\\SYSWOW~1\\x', 'b-short-name');
});
check('guard-09 .. 逃逸到受保护区', () => {
  deny('C:\\Users\\gongj\\AppData\\..\\..\\Windows\\x', 'b-parent-escape');
  deny('C:\\Users\\gongj\\..\\..\\$Recycle.Bin\\x', 'b-parent-escape');
  deny('..', 'b-parent-escape');
});
check('guard-10 junction 逃逸：raw 干净但 real 落进受保护区', () => {
  deny('C:\\Users\\gongj\\link\\win.ini', 'b-junction-escape',
    { real: 'C:\\Windows\\win.ini' });
  deny('C:\\Users\\gongj\\link\\a', 'b-junction-escape',
    { real: 'C:\\Program Files\\x\\a' });
  deny('C:\\Users\\gongj\\link\\b', 'b-junction-escape',
    { real: 'C:\\$RECYCLE.BIN\\S-1-5-21-1\\b' });
});
check('guard-11 未展开的 %VAR%', () => {
  deny('%LOCALAPPDATA%\\Temp', 'b-unexpanded-var');
  deny('C:\\Users\\%USERNAME%\\AppData\\Local\\Temp', 'b-unexpanded-var');
  deny('C:\\Windows\\%SystemRoot%\\x', 'b-unexpanded-var');
});
check('guard-12 省略盘符 / 相对路径 / 只到盘根', () => {
  deny('Users\\gongj\\AppData\\Local\\Temp', 'b-no-drive');
  deny('.\\AppData\\Local\\Temp', 'b-no-drive');
  deny('/etc/passwd', 'b-no-drive');
  deny('C:\\', 'b-glob-overreach', { mode: 'glob' });
});
check('guard-13 通配越界：盘根 / 一级目录 / ** / 中段星号越到受保护区', () => {
  deny('C:\\*', 'b-glob-overreach', { mode: 'glob' });
  deny('C:\\Users\\*', 'b-glob-overreach', { mode: 'glob' });
  deny('C:\\Users\\gongj\\**\\cache', 'b-glob-overreach', { mode: 'glob' });
  deny('C:\\*\\Windows\\*', 'b-glob-overreach', { mode: 'glob' });
});
check('guard-14 操作白名单：属主 / ACL / 注册表 / 结束进程一律拒', () => {
  // 操作级红线也走台账：denyOp 记 b-operation-denied，否则 grd-98 的 40 例口径会漏掉这五条。
  const denyOp = (op) => {
    const r = checkOperation(op);
    assert.equal(r.allow, false, `操作 ${op} 应被拒绝`);
    assert.equal(r.branch, 'b-operation-denied');
    seenBranches.set('b-operation-denied', seenBranches.get('b-operation-denied') + 1);
    denyAssertions += 1;
  };
  ['delete-file', 'delete-dir', 'move-to-quarantine'].forEach((op) => {
    assert.equal(checkOperation(op).allow, true, `${op} 是唯一允许的三种动作`);
  });
  ['set-owner', 'set-acl', 'registry-write', 'kill-process', 'recursive-force'].forEach(denyOp);
});
check('guard-15 注册表形态路径直接拒（不靠 checkOperation 兜）', () => {
  deny('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'b-registry');
  deny('HKEY_CURRENT_USER\\Software\\x', 'b-registry');
  deny('REG:HKCU\\Software\\x', 'b-registry');
});
check('guard-16 非法输入：非字符串 / 空串 / 超长', () => {
  deny('', 'b-bad-input');
  deny(123, 'b-bad-input');
  deny(null, 'b-bad-input');
  deny('C:\\' + 'x'.repeat(32768), 'b-bad-input');
});
check('guard-17 正常路径必须放行（防过度收紧）', () => {
  allow('C:\\Users\\gongj\\AppData\\Local\\Temp');
  allow('C:\\Users\\gongj\\.cache\\pnpm');
  allow('D:\\备份\\2026Q1');
  allow('C:\\Users\\gongj\\AppData\\Local\\npm-cache\\_cacache', { mode: 'glob' });
  allow('C:\\Users\\gongj\\AppData\\Local\\pip\\Cache\\*', { mode: 'glob' });
  allow('C:\\Users\\gongj\\AppData\\Roaming\\DingTalk\\*\\log', { mode: 'glob' });
});
check('guard-18 分支清单 100% 覆盖（spec §5 验收门禁 2）', () => {
  // 直接读台账，不再另造一份探针清单：另造就会和上面的用例漂移（历史上就漏过 glob 一条）。
  const zero = [...seenBranches].filter(([, n]) => n === 0).map(([id]) => id);
  assert.deepEqual(zero, [], `这些红线分支没被任何用例打到：${zero.join(', ')}`);
  assert.equal(seenBranches.size, 16, 'BRANCH_IDS 应是 16 条；增删分支要同步增删用例');
});
check('guard-19 红线矩阵达到 spec §5 的 ≥40 例口径（按拒绝断言计数）', () => {
  assert.ok(denyAssertions >= 40, `当前只有 ${denyAssertions} 条拒绝断言 —— 补变体，不许改口径`);
});

// 收尾两行之前先把台账打出来：Task 25 的门禁②证据就是这一行，不是人眼数用例。
console.log(`  红线矩阵：拒绝断言 ${denyAssertions} 条 / 分支命中 ${[...seenBranches.values()].filter((n) => n > 0).length}/${BRANCH_IDS.length}`);

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/guard.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND`，指向 `lib/clean/guard.js`。

- [ ] **Step 3: 写实现**

`lib/clean/guard.js` 的判定顺序与分支号（顺序就是优先级，写死，测试按它断言）：

```js
/**
 * 「能不能删」的唯一裁决点。
 *
 * 三条设计约定：
 *  1. **纯字符串判定，零 IO**：`opts.real` 由调用方（扫描器）用 `fs.realpathSync` 取到后传进来。
 *     guard 自己不开文件句柄，才能在测试里逐分支打满。
 *  2. **判定顺序 = 优先级**：形态异常（全角 / 前缀 / UNC / 短名 / %VAR%）先于内容判定，
 *     因为绕过的形状本身就是危险信号，不该被"lowercase 之后不在保护表里"放过去。
 *  3. **拒绝必须说得出原因**：`why` 直接进界面卡片文案，不允许空串。
 */

export const GUARD_CODE = {
  OK: 'OK',
  BAD_INPUT: 'GUARD_BAD_INPUT',
  FULLWIDTH: 'GUARD_FULLWIDTH',
  PREFIX_ESCAPE: 'GUARD_PREFIX_ESCAPE',
  UNC: 'GUARD_UNC',
  UNEXPANDED_VAR: 'GUARD_UNEXPANDED_VAR',
  NO_DRIVE: 'GUARD_NO_DRIVE',
  SHORT_NAME: 'GUARD_SHORT_NAME',
  PARENT_ESCAPE: 'GUARD_PARENT_ESCAPE',
  REGISTRY: 'GUARD_REGISTRY',
  SYSTEM_DIR: 'GUARD_SYSTEM_DIR',
  RECYCLE_BIN: 'GUARD_RECYCLE_BIN',
  PROGRAM_FILES: 'GUARD_PROGRAM_FILES',
  CASE_VARIANT: 'GUARD_CASE_VARIANT',
  JUNCTION_ESCAPE: 'GUARD_JUNCTION_ESCAPE',
  GLOB_OVERREACH: 'GUARD_GLOB_OVERREACH',
  OPERATION_DENIED: 'GUARD_OPERATION_DENIED',
};

/** 分支清单：与 test/guard.test.mjs 的 guard-18 一一对应，加分支必须同时加用例。 */
export const BRANCH_IDS = [
  'b-bad-input', 'b-fullwidth', 'b-prefix-escape', 'b-unc', 'b-unexpanded-var',
  'b-no-drive', 'b-short-name', 'b-parent-escape', 'b-registry', 'b-system-dir',
  'b-recycle-bin', 'b-program-files', 'b-case-variant', 'b-junction-escape',
  'b-glob-overreach', 'b-operation-denied',
];

/** 受保护前缀：canonical（全小写、反斜杠、去掉尾部分隔符）形式。 */
const PROTECTED = [
  { branch: 'b-system-dir', code: GUARD_CODE.SYSTEM_DIR, prefixes: ['c:\\windows', 'windows\\system32'],
    why: (p) => `系统目录禁止操作：${p}` },
  { branch: 'b-recycle-bin', code: GUARD_CODE.RECYCLE_BIN, prefixes: ['c:\\$recycle.bin', 'c:\\recycler'],
    why: (p) => `回收站由系统管理，插件不代清（删了就真没了，且这里没有「还原」）：${p}` },
  { branch: 'b-program-files', code: GUARD_CODE.PROGRAM_FILES, prefixes: ['program files'],
    why: (p) => `已安装程序目录禁止删除：${p}` },
];

const OPS_ALLOWED = new Set(['delete-file', 'delete-dir', 'move-to-quarantine']);

const deny = (branch, code, why) => ({ allow: false, branch, code, why });
const ok = () => ({ allow: true, branch: 'b-allowed', code: GUARD_CODE.OK, why: '' });

const FULLWIDTH_RE = /[\uFF01-\uFF5E\u3000]/;
const VAR_RE = /%[^%\\/:*?"<>|]{1,64}%/;
const SHORT_NAME_RE = /(^|[\\/])[^\\/~]{1,8}~\d{1,2}(\.[^\\/]{1,6})?($|[\\/])/i;
const REGISTRY_RE = /^(reg:)?(hklm|hkey_)/i;

/** 拆成 [盘符, 段数组]；段数组去掉尾部的空段与分隔符。 */
function splitPath(raw) {
  const slashes = raw.replace(/[\\/]+/g, '\\');
  const m = /^([a-zA-Z]):\\?(.*)$/.exec(slashes);
  if (!m) return null;
  return { drive: m[1].toLowerCase(), segments: m[2].split('\\').filter(Boolean) };
}

/** 受保护判定用的规范化串：`c:\windows\win.ini`。盘根段单独比较，避免 `c:\program filesx` 误命中。 */
function canonical(parsed) {
  return parsed.drive + ':\\' + parsed.segments.join('\\');
}

function matchProtected(canonLower) {
  for (const rule of PROTECTED) {
    for (const p of rule.prefixes) {
      // 相对形态（windows\system32）只比较段串
      const target = p.includes(':') ? p : null;
      if (target) {
        if (canonLower === target || canonLower.startsWith(target + '\\')) return rule;
      } else {
        const segs = canonLower.split('\\').slice(1);
        const head = segs.slice(0, p.split('\\').length).join('\\');
        if (head === p || segs[0] === p.split('\\')[0] && p === 'program files') return rule;
      }
    }
  }
  return null;
}

export function check(raw, opts = {}) {
  const mode = opts.mode === 'glob' ? 'glob' : 'path';

  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 32767) {
    return deny('b-bad-input', GUARD_CODE.BAD_INPUT, '路径必须是 1~32767 个字符的非空字符串');
  }
  if (FULLWIDTH_RE.test(raw)) {
    return deny('b-fullwidth', GUARD_CODE.FULLWIDTH, '路径含全角字符，可能是绕过大小的伪装写法：' + raw);
  }
  if (raw.startsWith('\\\\?\\') || raw.startsWith('\\\\.\\')) {
    return deny('b-prefix-escape', GUARD_CODE.PREFIX_ESCAPE, 'Win32 命名空间前缀（\\\\?\\ 或 \\\\.\\）会跳过解析规则，禁止：' + raw);
  }
  if (raw.startsWith('\\\\')) {
    return deny('b-unc', GUARD_CODE.UNC, '不接受网络路径（UNC）：' + raw);
  }
  if (VAR_RE.test(raw)) {
    return deny('b-unexpanded-var', GUARD_CODE.UNEXPANDED_VAR, '路径含未展开的 %变量%，展开结果不可控：' + raw);
  }
  const parsed = splitPath(raw);
  if (!parsed || parsed.segments.length === 0) {
    return deny('b-no-drive', GUARD_CODE.NO_DRIVE, '必须是带盘符的绝对路径（如 C:\\Users\\…）：' + raw);
  }
  if (parsed.segments.some((s) => s === '..' || s === '.')) {
    return deny('b-parent-escape', GUARD_CODE.PARENT_ESCAPE, '路径含 .. / . 段，先解析成绝对路径再送进来：' + raw);
  }
  if (SHORT_NAME_RE.test(raw)) {
    return deny('b-short-name', GUARD_CODE.SHORT_NAME, '不接受 8.3 短文件名（可能指向任意目录）：' + raw);
  }
  if (REGISTRY_RE.test(raw)) {
    return deny('b-registry', GUARD_CODE.REGISTRY, '本插件不碰注册表：' + raw);
  }

  const canonLower = canonical(parsed).toLowerCase();
  const hit = matchProtected(canonLower);
  if (hit) {
    // 大小写变体单独成支：同一条红线，但"为什么被拒"要说得准 —— 界面文案要用它
    const canonicalForm = canonical(parsed);
    if (canonicalForm !== canonLower && /[A-Z]/.test(canonicalForm)) {
      return deny('b-case-variant', GUARD_CODE.CASE_VARIANT,
        `受保护目录（大小写变体一样命中）：${canonicalForm}`);
    }
    return deny(hit.branch, hit.code, hit.why(canonical(parsed)));
  }

  // glob 的越界判定：字面量前缀必须至少到盘下的第三级目录，且星号不得跨过受保护区
  if (mode === 'glob') {
    if (/\*\*/.test(raw)) {
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH, '不接受 ** 递归通配：' + raw);
    }
    const literal = raw.slice(0, raw.indexOf('*'));
    const litParsed = splitPath(literal.replace(/[\\/]$/, ''));
    if (!litParsed || litParsed.segments.length < 3) {
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH,
        `通配的字面量前缀至少要到盘符下第三级目录才允许批量匹配：${raw}`);
    }
    if (matchProtected(literal.toLowerCase())) {
      return deny('b-glob-overreach', GUARD_CODE.GLOB_OVERREACH, '通配前缀落在受保护目录：' + raw);
    }
  }

  // junction / symlink 逃逸：只有调用方交出 realpath 才判得到
  if (opts.real && typeof opts.real === 'string') {
    const r = splitPath(opts.real.replace(/[\\/]+/g, '\\'));
    const realCanon = r ? canonical(r).toLowerCase() : opts.real.toLowerCase();
    if (matchProtected(realCanon)) {
      return deny('b-junction-escape', GUARD_CODE.JUNCTION_ESCAPE,
        `路径字面量看着正常，实际解析到受保护目录：${opts.real}`);
    }
  }

  return ok();
}

export function checkOperation(op) {
  if (OPS_ALLOWED.has(op)) return ok();
  return deny('b-operation-denied', GUARD_CODE.OPERATION_DENIED,
    `操作「${op}」不在允许范围内。本插件只删文件/目录、只搬到暂存区，不改属主、不改 ACL、不写注册表、不结束进程。`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/guard.test.mjs`
Expected: `19/19 通过` + 一行「红线矩阵：拒绝断言 61 条 / 分支命中 16/16」，退出码 0。若 `matchProtected` 对 `program files` 的相对段判定不稳，改 `PROTECTED` 的 `prefixes` 形状而不是放松 guard —— **红线只能收紧不能放宽**，这条也是 review 时的重点。

- [ ] **Step 5: 变异断言（证明用例真的在管事）**

临时把 `SHORT_NAME_RE` 改成 `/(^|[\\/])ZZZ~\d/`（永不命中），跑 `node test/guard.test.mjs`，确认 guard-08 与 guard-18 **同时变红**（台账里 `b-short-name` 掉回 0）；然后改回来再跑一次 `19/19`。把两次输出记进汇报。（断言强度要真跑变异 —— 只看到绿不算证明。）

---

## Task 3: `lib/prefs/{spec,store}.js` —— prefs 与 clean_rules 两张可覆盖记录

**Files:**
- Create: `lib/prefs/spec.js`
- Create: `lib/prefs/store.js`
- Modify: `test/prefs.test.mjs`（在 ①段后插入 ②③段，并把收尾统计挪到文件末尾）

**Interfaces:**
- Consumes: `kv-schema.js` 全部导出
- Produces:
  - `prefsDomain`（`defineDomain` 结果，name `sysops_prefs`，version 1，tables `prefs` / `clean_rules`）、`PREF_KEYS = ['prefs','clean_rules']`、`PREF_ROW_KEY = 'current'`
  - `createPrefStore({ getFacility, logger?, now? })` → `{ available, readAll(), read(key), write(key,value), writeMany(patch), close() }`
  - `PREFS_ERROR`（`UNAVAILABLE` `UNKNOWN_KEY` `INVALID` `CLOSED` 四个稳定 code）
  - `COLLECT_CADENCE = ['1s','5s','paused']`、`SOURCE_KEYS = ['l0','l1a','l1b','l2']`、`SEARCH_MODES = ['everything','es','walk']`（Task 8/11/16/17 引它，不许各自再写一份字面量）

- [ ] **Step 1: 写失败的测试**

在 `test/prefs.test.mjs` 的 ①段之后插入：

```js
/* ②段：prefs domain 声明 */
const { prefsDomain, PREF_KEYS, PREF_ROW_KEY, COLLECT_CADENCE, SOURCE_KEYS } =
  await import('../lib/prefs/spec.js');

check('prefs-1 domain 名合法且两张表', () => {
  assert.equal(prefsDomain.name, 'sysops_prefs');
  assert.equal(prefsDomain.version, 1);
  assert.deepEqual(PREF_KEYS.slice().sort(), ['clean_rules', 'prefs']);
  assert.deepEqual(Object.keys(prefsDomain.tables).sort(), ['clean_rules', 'prefs']);
});

check('prefs-2 prefs 记录：采样档位白名单、源开关三态、脏字段丢弃', () => {
  const t = prefsDomain.tables.prefs.valueSchema;
  const good = t.parse({ collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: false } });
  assert.deepEqual(good.collect, { cadence: '1s', keepMinutes: 30 });
  assert.equal(good.sources.l1b, undefined, '未声明的源不该被凭空补值');
  assert.throws(() => t.parse({ collect: { cadence: '2s' } }), /cadence/);
  assert.throws(() => t.parse({ sources: { l9: true } }), /l9/);
  assert.throws(() => t.parse({ collect: { keepMinutes: 0 } }), /keepMinutes/);
});

check('prefs-3 prefs 记录：告警阈值、搜索通路、限定目录、null 与空数组的区别', () => {
  const t = prefsDomain.tables.prefs.valueSchema;
  const r = t.parse({ search: { walkDirs: [], port: 3417, esPath: 'D:\\tools\\es.exe' }, alerts: { cpu: { value: 85, consecutive: 3, cooldownSec: 600 } } });
  assert.deepEqual(r.search.walkDirs, [], '用户主动清空必须存得下来（不等于从未写入）');
  assert.equal(r.search.port, 3417, 'Task 16/17 与设置页都读这一键，进不了库就是假配置');
  assert.equal(r.search.esPath, 'D:\\tools\\es.exe');
  assert.throws(() => t.parse({ search: { port: 0 } }), /port/);
  assert.throws(() => t.parse({ search: { port: 70000 } }), /port/);
  assert.throws(() => t.parse({ search: { port: '3417' } }), /port/);
  assert.throws(() => t.parse({ alerts: { cpu: { value: '85', consecutive: 3, cooldownSec: 60 } } }), /value/);
  assert.throws(() => t.parse({ alerts: { cpu: { value: 85, consecutive: 0, cooldownSec: 60 } } }), /consecutive/);
  assert.throws(() => t.parse({ alerts: { cpu: { value: 85, consecutive: 1, cooldownSec: 5 } } }), /cooldownSec/);
});

check('prefs-4 clean_rules：本机新增规则的形状，glob 必填、拒绝形状进库', () => {
  const t = prefsDomain.tables.clean_rules.valueSchema;
  const r = t.parse({ items: [{ id: 'u-1', n: '浏览器缓存', glob: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*', ageDays: 7 }], updatedAt: 1 });
  assert.equal(r.items[0].glob, 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*');
  assert.equal(r.items[0].ageDays, 7);
  assert.throws(() => t.parse({ items: [{ id: 'u-1', n: '缺 glob', ageDays: 1 }] }), /glob/);
  assert.throws(() => t.parse({ items: [{ id: 'u-1', n: 'x', glob: 'C:\\a\\b\\*', ageDays: -3 }] }), /ageDays/);
});

/* ③段：store 行为（内存桩） */
const { createPrefStore, PREFS_ERROR } = await import('../lib/prefs/store.js');

function createMemoryFacility() {
  const opened = new Map();
  const disk = new Map(); // 关域再开，数据要还在 —— 桩每次重建空表会把这条测成假的
  return {
    async open(spec) {
      if (opened.has(spec.name)) throw new Error('already-open');
      let tables = disk.get(spec.name);
      if (!tables) {
        tables = new Map(Object.keys(spec.tables).map((n) => [n, new Map()]));
        disk.set(spec.name, tables);
      }
      const domain = {
        close() { opened.delete(spec.name); },
        table(name) {
          const store = tables.get(name);
          if (!store) throw new Error(`未知表 ${name}`);
          return {
            get: (key) => store.get(key),
            keys: () => [...store.keys()][Symbol.iterator](),
            entries: () => [...store.entries()][Symbol.iterator](),
            put: async (key, value) => { store.set(key, spec.tables[name].valueSchema.parse(value)); },
            delete: async (key) => { store.delete(key); },
          };
        },
      };
      opened.set(spec.name, domain);
      return domain;
    },
  };
}

const fresh = (over = {}) => {
  const facility = over.facility === undefined ? createMemoryFacility() : over.facility;
  return createPrefStore({ getFacility: () => facility, now: () => 777, logger: { warn() {} }, ...over });
};

await checkAsync('prefs-5 readAll：从未写入返回 null，而不是 []', async () => {
  const s = fresh();
  const all = await s.readAll();
  assert.deepEqual(all, { prefs: null, clean_rules: null });
});

await checkAsync('prefs-6 write 覆盖同 key（偏好的本职就是要被改）', async () => {
  const s = fresh();
  await s.write('prefs', { collect: { cadence: '1s' } });
  await s.write('prefs', { collect: { cadence: '5s' } });
  const back = await s.read('prefs');
  assert.equal(back.collect.cadence, '5s');
  assert.equal(back.updatedAt, 777, 'updatedAt 由仓储统一加盖');
});

await checkAsync('prefs-7 空数组能存下来，与 null 不是一回事', async () => {
  const s = fresh();
  await s.write('prefs', { search: { walkDirs: [] } });
  const back = await s.read('prefs');
  assert.deepEqual(back.search.walkDirs, []);
});

await checkAsync('prefs-8 未知 key 拒绝；writeMany 跳过未知键但不拖垮整批', async () => {
  const s = fresh();
  await assert.rejects(() => s.write('nope', {}), (e) => e.code === PREFS_ERROR.UNKNOWN_KEY);
  const { written, skipped } = await s.writeMany({ prefs: { collect: { cadence: '1s' } }, nofix: {}, clean_rules: null });
  assert.deepEqual(Object.keys(written), ['prefs']);
  assert.deepEqual(skipped.sort(), ['clean_rules', 'nofix']);
});

await checkAsync('prefs-9 无 storageDomain 是降级不是异常：available=false 且读抛 UNAVAILABLE', async () => {
  const s = fresh({ facility: undefined });
  assert.equal(s.available, false);
  await assert.rejects(() => s.readAll(), (e) => e.code === PREFS_ERROR.UNAVAILABLE);
});

await checkAsync('prefs-10 close() 必须可 await，且 close 后写报 CLOSED', async () => {
  const s = fresh();
  await s.write('prefs', { collect: { cadence: '1s' } });
  await s.close();
  await assert.rejects(() => s.write('prefs', { collect: { cadence: '5s' } }), (e) => e.code === PREFS_ERROR.CLOSED);
});
```

并把文件末尾的统计/exit 两行挪到全部段落之后。

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/prefs.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/prefs/spec.js`。

- [ ] **Step 3: 写实现**

`lib/prefs/spec.js`：

```js
/**
 * 偏好 domain：`prefs`（采集/搜索/告警设置）与 `clean_rules`（用户自建的清理规则）。
 *
 * 为什么不把 clean_plan / clean_log / alert_hit 放进来：那三张是**系统产生的记录**
 * （快照冻结、留痕、触发历史），语义与"用户设的、就是要被覆盖的"不同 ——
 * 混在一个 domain 里只能靠注释区分。参照 `dsh-plugin-stock-analysis` 把
 * append-only 存档与可覆盖偏好拆成两个 domain 的同一个理由。记录域在
 * `lib/clean/plan-store.js` 等文件各自的 spec 里声明（见 Task 13）。
 */
import {
  defineDomain, domainTable, record, arrayOf, arrayOfItem, makeSchema,
  requiredString, optionalString, requiredInt, optionalInt, optionalBool,
} from '../kv-schema.js';

/** 采样档位：与监控页顶部的「1s / 5s / 暂停」三选一，没有第四种。 */
export const COLLECT_CADENCE = ['1s', '5s', 'paused'];
/** 采集源分层，与 spec §1.2 的表一一对应。 */
export const SOURCE_KEYS = ['l0', 'l1a', 'l1b', 'l2'];
/** 搜索通路：everything=全盘索引 / es=命令行 / walk=限定目录遍历（降级）。 */
export const SEARCH_MODES = ['everything', 'es', 'walk'];

const cadence = makeSchema((v) => {
  if (v === undefined || v === null) return undefined;
  if (!COLLECT_CADENCE.includes(v)) throw new Error(`cadence 必须是 ${COLLECT_CADENCE.join(' | ')} 之一，收到 ${JSON.stringify(v)}`);
  return v;
});

/** 源开关用 optionalBool：三态（从未设置 / 开 / 关）比必填布尔诚实 —— 默认值由实测代价给。 */
const boolOf = (label) => optionalBool(label);

const keepMinutes = makeSchema((v) => {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || v < 5 || v > 120) throw new Error(`keepMinutes 必须是 5~120 的整数，收到 ${JSON.stringify(v)}`);
  return v;
});

/** 阈值三元组：越线值 / 连续次数 / 冷却秒。数值范围写死在 schema 里，脏值进不了库也就进不了判定。 */
const threshold = (label, { max, cooldownMin = 60 }) =>
  record(
    {
      value: makeSchema((v) => {
        if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`${label}.value 必须是 0~${max} 的数字`);
        return v;
      }),
      consecutive: makeSchema((v) => {
        if (!Number.isInteger(v) || v < 1 || v > 10) throw new Error(`${label}.consecutive 必须是 1~10 的整数`);
        return v;
      }),
      cooldownSec: makeSchema((v) => {
        if (!Number.isInteger(v) || v < cooldownMin || v > 86400) throw new Error(`${label}.cooldownSec 必须是 ${cooldownMin}~86400 的整数`);
        return v;
      }),
      enabled: optionalBool(`${label}.enabled`),
    },
    label,
  );

export const prefsRecord = record(
  {
    collect: record({ cadence, keepMinutes, procLimit: optionalInt('collect.procLimit') }, 'collect'),
    sources: record(
      SOURCE_KEYS.reduce((acc, k) => ({ ...acc, [k]: boolOf(`sources.${k}`) }), {}),
      'sources',
    ),
    alerts: record(
      {
        cpu: threshold('alerts.cpu', { max: 100 }),
        mem: threshold('alerts.mem', { max: 100 }),
        diskFreePct: threshold('alerts.diskFreePct', { max: 100, cooldownMin: 3600 }),
        netDown: threshold('alerts.netDown', { max: 10_000_000_000, cooldownMin: 60 }),
        procCpu: threshold('alerts.procCpu', { max: 100 }),
      },
      'alerts',
    ),
    search: record(
      {
        mode: makeSchema((v) => {
          if (v === undefined || v === null) return undefined;
          if (!SEARCH_MODES.includes(v)) throw new Error(`search.mode 必须是 ${SEARCH_MODES.join(' | ')} 之一`);
          return v;
        }),
        walkDirs: arrayOfItem('search.walkDirs', requiredString('walkDirs[]')),
        limit: optionalInt('search.limit'),
        /** 这两键是"用户可改"而非"装机配置"：Task 16 探测与 Task 17 搜索都从这里读，
         *  设置页 pg4-8 也渲染它们 —— 少一键，改端口就永远存不进库。 */
        port: makeSchema((v) => {
          if (v === undefined || v === null) return undefined;
          if (!Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`search.port 必须是 1~65535 的整数，收到 ${JSON.stringify(v)}`);
          return v;
        }),
        esPath: optionalString('search.esPath'),
      },
      'search',
    ),
    updatedAt: optionalInt('updatedAt'),
  },
  'prefs',
);

export const cleanRulesRecord = record(
  {
    items: arrayOf('clean_rules.items', {
      id: requiredString('items[].id'),
      n: requiredString('items[].n'),
      glob: requiredString('items[].glob'),
      ageDays: makeSchema((v) => {
        if (!Number.isInteger(v) || v < 0 || v > 3650) throw new Error(`items[].ageDays 必须是 0~3650 的整数`);
        return v;
      }),
      note: optionalString('items[].note'),
    }),
    updatedAt: optionalInt('updatedAt'),
  },
  'clean_rules',
);

export const DOMAIN_NAME = 'sysops_prefs';
export const SCHEMA_VER = 1;
export const PREF_ROW_KEY = 'current';
export const PREF_KEYS = ['prefs', 'clean_rules'];

export const prefsDomain = defineDomain({
  name: DOMAIN_NAME,
  version: SCHEMA_VER,
  tables: {
    prefs: domainTable(prefsRecord),
    clean_rules: domainTable(cleanRulesRecord),
  },
});
```

`lib/prefs/store.js`：**照抄 `../dsh-plugin-stock-analysis/lib/prefs/store.js`（202 行）的骨架**，只改四处，其余逻辑（写队列串行、`ensureDomain` 缓存 promise 且失败可重试、`writeMany` 内不得调 `this.write`、`close()` 必须 await）原样保留：

1. `import` 路径同、但符号引 `./spec.js` 的 `prefsDomain, PREF_KEYS, PREF_ROW_KEY`。
2. `readAll()` 返回形如 `{ prefs: null, clean_rules: null }`。
3. 错误信息里的 `[stock-analysis]` 换成 `[sysops]`。
4. `PREFS_ERROR` 四个 code 字符串保持 `PREFS_UNAVAILABLE` / `PREFS_UNKNOWN_KEY` / `PREFS_INVALID` / `PREFS_CLOSED`（Task 18 的 API 按 code 分支，名字要稳）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/prefs.test.mjs`
Expected: `13/13 通过`（①3 + ②4 + ③6 —— ③段实测只有 prefs-5~10 六条，计划原先写 ③7 是算术笔误，已按落地产物校正），退出码 0。

- [ ] **Step 5: 留档**

Run: `SKIP_LOCAL=1 node test/prefs.test.mjs`（确认无真机用例被误跳），Expected: 仍 `13/13`。
---

## Task 4: `lib/collect/ring.js` + `lib/collect/l0-node.js`

**Files:**
- Create: `lib/collect/ring.js`
- Create: `lib/collect/l0-node.js`
- Create: `test/collect.test.mjs`（本任务写 ①②段，Task 5–8 续写 ③–⑥段）

**Interfaces:**
- Consumes: 无（只用 `node:os` / `node:fs`，且可注入替换）
- Produces:
  - `createRing({ windowMs = 1_800_000, maxPoints = 1800, percent = false, now = Date.now })` → `{ push(point) → 'ok'|'stale'|'bad', series(from?, to?) → [{t,v}], latest() → {t,v}|null, stats() → {points, droppedStale, droppedBad}, clear() }`（`percent: true` 时值域限 0~100，供 cpu/mem 用；字节类指标不传）
  - `computeCpuPct(prev, cur) → number`（0~100，无 prev 时返回 `NaN`）
  - `computeMemPct(total, free) → number`
  - `createL0({ osMod = os, fsMod = fs, drive = 'C:', now = Date.now })` → `{ read() → {t, cpu, mem, diskFree, diskTotal}, reset() }`（`diskFree` / `diskTotal` 为**字节**；`cpu` / `mem` 为 0~100 百分数）

- [ ] **Step 1: 写失败的测试**

`test/collect.test.mjs` 以 harness 开头，然后：

```js
/* ①段：ring 边界 */
const { createRing } = await import('../lib/collect/ring.js');

const clock = () => { let t = 0; return { now: () => t, advance: (ms) => { t += ms; } }; };

check('ring-1 时间窗与条数双上限，先到先裁', () => {
  const c = clock();
  const r = createRing({ windowMs: 1000, maxPoints: 3, now: c.now });
  // `t` 必须是**数值**：`c.now` 是函数引用，`Number.isFinite(point.t)` 会把它判成脏点，
  // 三条上限里的那条"乱序/脏值丢弃"会让本例一个点都存不进去。
  for (let i = 0; i < 3; i++) { c.advance(100); r.push({ t: c.now(), v: i }); }
  assert.equal(r.series().length, 3);
  c.advance(100);
  r.push({ t: c.now(), v: 9 });          // 第 4 点：条数上限裁掉最老
  assert.equal(r.series()[0].v, 1);
  c.advance(5000);
  r.push({ t: c.now(), v: 10 });          // 时间窗外全部过期
  // 时间线：100/200/300 → 400 → 5400。末次 now() 是 5400，不是 5600。
  assert.deepEqual(r.series(), [{ t: 5400, v: 10 }]);
});

check('ring-2 乱序点丢弃并计数（一个倒着走的点会把曲线拉出假尖峰）', () => {
  const r = createRing({ windowMs: 1e6, maxPoints: 10, now: () => 1000 });
  r.push({ t: 3000, v: 1 });
  assert.equal(r.push({ t: 2000, v: 2 }), 'stale');
  assert.equal(r.stats().droppedStale, 1);
  assert.equal(r.series().length, 1);
});

check('ring-3 脏值（NaN / Infinity / 负 / >100 的百分比）拒收并单独计数', () => {
  const r = createRing({ windowMs: 1e6, maxPoints: 10, now: () => 1000, percent: true });
  assert.equal(r.push({ t: 1000, v: NaN }), 'bad');
  assert.equal(r.push({ t: 1001, v: Infinity }), 'bad');
  assert.equal(r.push({ t: 1002, v: -3 }), 'bad');
  assert.equal(r.push({ t: 1003, v: 120 }), 'bad');
  assert.equal(r.push({ t: 1004, v: 88 }), 'ok');
  assert.equal(r.stats().droppedBad, 4);
  assert.deepEqual(r.series(), [{ t: 1004, v: 88 }]);
});

check('ring-4 series(from,to) 取区间；latest 取末点', () => {
  const r = createRing({ windowMs: 1e9, maxPoints: 10, now: () => 0 });
  [1, 2, 3, 4, 5].forEach((t, i) => r.push({ t: t * 100, v: i }));
  assert.deepEqual(r.series(200, 400).map((p) => p.v), [1, 2, 3]);
  assert.deepEqual(r.latest(), { t: 500, v: 4 });
});

/* ②段：L0 纯 Node 采样 */
const { computeCpuPct, computeMemPct, createL0 } = await import('../lib/collect/l0-node.js');

const cpu = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });

check('l0-1 CPU 用差值算，不是瞬时值', () => {
  // 两次样本的**总 ticks 必须增长**：`(10,90)→(30,70)` 总量恒定 100，`totalDelta` 是 0，
  // 那是"CPU 计数器没动"的脏状态（NaN），不是 50%。这里让总增量 40、忙增量 20。
  const pct = computeCpuPct([cpu(10, 90)], [cpu(30, 110)]);   // 忙 +20 / 总 +40 → 50%
  assert.equal(pct, 50);
});

check('l0-2 多核平均；无上一次样本时返回 NaN（ring 会丢并计数）', () => {
  // 核 1：忙 +30 / 总 +40 = 75%；核 2：忙 +30 / 总 +60 = 50%。
  // 按总 ticks 加权是 60/100 = 60%，百分比算术平均是 62.5% —— 断 60 才能钉住"加权"口径。
  assert.equal(computeCpuPct([cpu(10, 90), cpu(50, 50)], [cpu(40, 100), cpu(80, 80)]), 60);
  assert.ok(Number.isNaN(computeCpuPct(null, [cpu(1, 1)])));
  assert.ok(Number.isNaN(computeCpuPct([cpu(10, 90)], [cpu(10, 90)])), '忙闲增量都为 0 时是 0/0，必须当脏值');
});

check('l0-3 内存占用率', () => {
  assert.equal(computeMemPct(16 * 1024 ** 3, 4 * 1024 ** 3), 75);
  assert.ok(Number.isNaN(computeMemPct(0, 0)));
});

check('l0-4 read() 交出字节口径的磁盘与百分数口径的 cpu/mem', () => {
  let n = 0;
  const osMod = {
    // 第二次样本总 ticks 从 100 涨到 120、idle 不涨 → 满负荷 100%。
    // 原先写的 `(20,80)` 总量仍是 100，落到 `totalDelta <= 0` 分支变 NaN。
    cpus: () => (n++ === 0 ? [cpu(10, 90)] : [cpu(30, 90)]),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
  };
  const fsMod = { statfsSync: () => ({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 400 }) };
  const l0 = createL0({ osMod, fsMod, drive: 'C:', now: () => 5000 });
  assert.ok(Number.isNaN(l0.read().cpu), '第一次没有差值基线');
  const p = l0.read();
  assert.deepEqual(p, { t: 5000, cpu: 100, mem: 50, diskFree: 400 * 4096, diskTotal: 1000 * 4096 });
});

check('l0-5 statfsSync 抛错（盘符不存在）时 read 抛出并带盘符名，不返回凑数 0', () => {
  const l0 = createL0({
    osMod: { cpus: () => [cpu(0, 0)], totalmem: 1, freemem: 1 },
    fsMod: { statfsSync: () => { throw new Error('ENOENT'); } },
    drive: 'Z:',
  });
  assert.throws(() => l0.read(), /Z:/);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/collect.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/collect/ring.js`。

- [ ] **Step 3: 写实现**

`lib/collect/ring.js`：

```js
/**
 * 按源分带的环形缓冲。
 *
 * 三条上限各自解决一个真实故障：
 *  - `maxPoints`：内存上界。1800 点 × 4 条曲线 ≈ 100KB，够 30min@1s。
 *  - `windowMs`：时间窗。用户要的是"最近 30 分钟"，不是"我能装多少"。
 *  - 乱序 / 脏值丢弃：**一个假点会在曲线上被读成真实尖峰**（spec §4.2 第四类），
 *    所以宁可不画，也要把丢弃数留着让界面能说"丢了 N 个不可信的点"。
 *
 * `opts.percent` 为真时把值域限制在 0~100（cpu / mem / 可用率），
 * 字节类指标（网速、剩余容量）不传这个选项。
 */
export function createRing({ windowMs = 30 * 60 * 1000, maxPoints = 1800, percent = false, now = () => Date.now() } = {}) {
  let pts = [];
  let droppedStale = 0;
  let droppedBad = 0;

  function prune() {
    const floor = now() - windowMs;
    while (pts.length && pts[0].t < floor) pts.shift();
    while (pts.length > maxPoints) pts.shift();
  }

  return {
    push(point) {
      if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.v)) {
        droppedBad += 1;
        return 'bad';
      }
      if (point.v < 0 || (percent && point.v > 100)) {
        droppedBad += 1;
        return 'bad';
      }
      if (pts.length && point.t <= pts[pts.length - 1].t) {
        droppedStale += 1;
        return 'stale';
      }
      pts.push({ t: point.t, v: point.v });
      prune();
      return 'ok';
    },
    series(from, to) {
      prune();
      if (from === undefined && to === undefined) return pts.slice();
      const lo = from === undefined ? -Infinity : from;
      const hi = to === undefined ? Infinity : to;
      return pts.filter((p) => p.t >= lo && p.t <= hi);
    },
    latest() {
      prune();
      return pts.length ? pts[pts.length - 1] : null;
    },
    stats() {
      prune();
      return { points: pts.length, droppedStale, droppedBad };
    },
    clear() {
      pts = [];
    },
  };
}
```

`lib/collect/l0-node.js`：

```js
/**
 * L0 —— 纯 Node 的低成本采样，**不起子进程**。
 *
 * 实测代价（spec §1.2）：`os.cpus()` 单次 0.7ms、`fs.statfsSync('C:')` 0ms，
 * 所以 1s 档在主进程内跑完全无感。CPU 占用必须用**两次样本的差值**算：
 * `os.cpus().times` 是自启动以来的累计ticks，直接读出来的是"开机至今平均"，
 * 不是"现在多忙"—— 这是这类监控最常见的错法。
 */
import os from 'node:os';
import fs from 'node:fs';

export function computeCpuPct(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length !== cur.length) return NaN;
  let busyDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < cur.length; i += 1) {
    const a = prev[i]?.times;
    const b = cur[i]?.times;
    if (!a || !b) return NaN;
    const idleDelta = b.idle + b.irq - (a.idle + a.irq);
    const total = b.user + b.nice + b.sys + b.idle + b.irq - (a.user + a.nice + a.sys + a.idle + a.irq);
    if (!Number.isFinite(idleDelta) || !Number.isFinite(total) || total <= 0) return NaN;
    busyDelta += total - idleDelta;
    totalDelta += total;
  }
  if (totalDelta <= 0) return NaN;
  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
}

export function computeMemPct(total, free) {
  if (!Number.isFinite(total) || total <= 0) return NaN;
  return Math.min(100, Math.max(0, ((total - free) / total) * 100));
}

export function createL0({ osMod = os, fsMod = fs, drive = 'C:', now = () => Date.now() } = {}) {
  let prevCpus = null;
  return {
    read() {
      const cpus = osMod.cpus();
      const cpu = computeCpuPct(prevCpus, cpus);
      prevCpus = cpus;
      let st;
      try {
        st = fsMod.statfsSync(`${drive}\\`);
      } catch (e) {
        // 盘符不存在 / 权限问题：说清是哪个盘，别让调用方猜（spec §4.7：禁止静默）
        throw new Error(`读取 ${drive} 盘容量失败：${e?.message ?? e}`);
      }
      return {
        t: now(),
        cpu,
        mem: computeMemPct(osMod.totalmem(), osMod.freemem()),
        diskFree: st.bavail * st.bsize,
        diskTotal: st.blocks * st.bsize,
      };
    },
    reset() {
      prevCpus = null;
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/collect.test.mjs`
Expected: `9/9 通过`，退出码 0。

- [ ] **Step 5: 真机自检（不写进测试文件，避免真 IO 进 CI）**

Run:
```bash
node -e "const{createL0}=await import('./lib/collect/l0-node.js');const l=createL0();l.read();setTimeout(()=>{const p=l.read();console.log('cpu',p.cpu.toFixed(1),'mem',p.mem.toFixed(1),'free',(p.diskFree/2**30).toFixed(1),'GB /',(p.diskTotal/2**30).toFixed(1),'GB')},1200)" --input-type=module
```
Expected: 打印本机四个数（参照：spec §1.2 记的 214.7G 总 / 71.9G 可用；数字变了就更新 spec，见门禁 5）。
提交信息草稿：`feat(sysops): 环形缓冲与 L0 纯 Node 采样`

---

## Task 5: `lib/collect/supervisor.js` —— 子进程状态机

**Files:**
- Create: `lib/collect/supervisor.js`
- Modify: `test/collect.test.mjs`（追加 ③段；把末尾两行统计/exit 挪到新段之后）

**Interfaces:**
- Consumes: `child_process.spawn`（生产）、`taskkill`（kill 路径）
- Produces:
  - `SUP_STATE = { OFF:'off', STARTING:'starting', ON:'on', STALLED:'stalled', CRASHED:'crashed', EXITED_MAX:'exited-max' }`
  - `BACKOFF_MS = [1000, 2000, 4000, 8000, 30000]`、`MAX_RESTARTS = 5`、`KILL_ARGS(pid) → string[]`、`defaultKill(pid)`
  - `createSupervisor({ spawnFn, killFn, now, setTimeoutFn, clearTimeoutFn, heartbeatFactor = 3, onChange, logger })` → `{ start(key, spec), stop(key), tick(), state(key), status(), keys(), dispose() }`
  - `start` 的 `spec = { label, cmd, args, intervalMs, rolling?, minWindowMs?, onData(lineBuf) }` —— **`onData` 收到的是"完整一行"的 `Buffer`**（跨 stdout 块拼接、行尾 `\r\n` 已去掉）；**监督者不猜编码**，解码归消费方（Task 6 的 `decodePd(buf)` 用 GBK，Task 7 的 powershell 输出用 UTF-8）
  - Task 6 / 7 / 8 只通过 `start/stop/status/tick` 与子进程打交道，**不各自写重启逻辑**。

- [ ] **Step 1: 写失败的测试（全部用假 child，零真进程）**

```js
/* ③段：supervisor 状态机 */
const { createSupervisor, SUP_STATE, BACKOFF_MS, MAX_RESTARTS, KILL_ARGS } = await import('../lib/collect/supervisor.js');
const { EventEmitter } = await import('node:events');

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { end() {}, write() {} };
  }
}

/** 假环境：手工推进时钟与定时器，退避序列才可断言。 */
function harness() {
  let t = 0;
  let nextPid = 1000;
  const timers = [];
  const kids = [];
  const kills = [];
  const changes = [];
  const sup = createSupervisor({
    spawnFn: (cmd, args, opts) => { const c = new FakeChild(nextPid++); kids.push({ c, cmd, args, opts }); return c; },
    killFn: (pid) => { kills.push(pid); },
    now: () => t,
    setTimeoutFn: (fn, ms) => { const h = { fn, ms, done: false }; timers.push(h); return h; },
    clearTimeoutFn: (h) => { if (h) h.done = true; },
    onChange: (key, s) => changes.push({ key, state: s.state }),
    logger: { warn() {}, info() {} },
  });
  const fire = () => { // 执行所有已排队的定时器（一次一个，便于断言次数）
    const h = timers.find((x) => !x.done);
    if (!h) throw new Error('没有待触发的定时器');
    h.done = true;
    h.fn();
  };
  // `timers` / `pending` 必须暴露给用例：退避序列（sup-3）与"dispose 后无活定时器"（sup-10）
  // 只能从定时器本身读，否则断言就退化成只数长度。
  return { sup, t: () => t, adv: (ms) => { t += ms; }, kids, kills, changes, fire, timers, pending: () => timers.find((x) => !x.done), lastKid: () => kids[kids.length - 1] };
}

check('sup-1 start 进 starting，首块 stdout 后转 on 并刷心跳', () => {
  const h = harness();
  const lines = [];
  h.sup.start('l1a', { label: '网络', cmd: 'typeperf', args: [], intervalMs: 1000, onData: (b) => lines.push(b) });
  assert.equal(h.sup.state('l1a').state, SUP_STATE.STARTING);
  h.lastKid().c.stdout.emit('data', Buffer.from('x\n'));
  const s = h.sup.state('l1a');
  assert.equal(s.state, SUP_STATE.ON);
  assert.equal(s.pid, 1000);
  // 行框定与"交出 Buffer"是 Task 6 的全部前提：typeperf 一行会被拆到多个 stdout 块里，
  // 而 GBK 只能在**字节**上还原 —— 这里若先 toString('latin1')，下游就再也解不出中文计数器名。
  h.lastKid().c.stdout.emit('data', Buffer.from('ab'));
  assert.deepEqual(lines.map((b) => b.toString('latin1')), ['x'], '没遇到换行前不该交出半行');
  h.lastKid().c.stdout.emit('data', Buffer.from('cd\r\nef'));
  assert.equal(Buffer.isBuffer(lines[1]), true, 'onData 必须交出 Buffer，不许在监督者里解码');
  assert.equal(lines[1].toString('latin1'), 'abcd', '跨块要拼成完整一行，并去掉行尾 \\r\\n');
  // 心跳刷点：假时钟起点就是 0，`lastTick >= 0` 是永真式；推进时钟再吐一块才真断得动。
  // 这一块只送来一个换行 —— 顺带钉住"上一块剩下的 `ef` 要等到行边界才被交出"。
  h.adv(1500);
  h.lastKid().c.stdout.emit('data', Buffer.from('\n'));
  assert.equal(h.sup.state('l1a').lastTick, 1500, '每块 stdout 都要刷 lastTick，否则心跳会误杀');
  assert.deepEqual(lines.map((b) => b.toString('latin1')), ['x', 'abcd', 'ef'], '交出顺序与内容要一路可追');
});

check('sup-2 非主动退出每次都进 crashed 并排一次重启，第 6 次失败进 exited-max 且不再自动重启（退避时长序列由 sup-3 断）', () => {
  const h = harness();
  h.sup.start('l1b', { label: '进程', cmd: 'powershell', args: [], intervalMs: 3000, onData() {} });
  for (let i = 0; i < MAX_RESTARTS; i += 1) {
    h.lastKid().c.emit('exit', 1, null);
    assert.equal(h.sup.state('l1b').state, SUP_STATE.CRASHED, `第 ${i + 1} 次退出应为 crashed`);
    assert.equal(h.kills.length, 0, '非主动退出不该再 kill');
    h.fire(); // 触发退避定时器
    assert.equal(h.sup.state('l1b').state, SUP_STATE.STARTING);
  }
  h.lastKid().c.emit('exit', 1, null);
  assert.equal(h.sup.state('l1b').state, SUP_STATE.EXITED_MAX);
  assert.equal(h.sup.state('l1b').restarts, MAX_RESTARTS);
});

check('sup-3 退避序列逐位等于字面量 1/2/4/8/30s', () => {
  // 断言目标是**字面量**，不是实现导出的 `BACKOFF_MS` —— 拿实现自己的常量自比，
  // 把退避改成 `[1000,1000,…]` 也一样绿，等于没断言（Step 5 的变异就是冲这条来的）。
  // 同时把导出的那个 `BACKOFF_MS` 钉在同一个字面量上：Task 8 的界面提示会读它。
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const got = [];
  for (let i = 0; i < MAX_RESTARTS; i += 1) {
    h.lastKid().c.emit('exit', 3, null);
    const p = h.pending();
    got.push(p.ms);
    h.fire();
  }
  assert.deepEqual(got, [1000, 2000, 4000, 8000, 30000]);
  assert.deepEqual(BACKOFF_MS, [1000, 2000, 4000, 8000, 30000]);
});

check('sup-4 stop 幂等：连调两次不抛，且不算崩溃、不再重启', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.sup.stop('k');
  h.sup.stop('k');
  h.sup.stop('不存在的键');
  h.lastKid().c.emit('exit', 0, null);
  assert.equal(h.sup.state('k').state, SUP_STATE.OFF);
  assert.equal(h.timers.length, 0, '主动退出后不该排任何重启定时器');
  // 「幂等」的真正含义在这条上：第二次 stop 不能再 kill 一遍。`stop` 里只要还有一个
  // `await` 在 `reg.delete` 之前，这条就会读出 kills=[1000,1000] 而测试仍全绿。
  assert.deepEqual(h.kills, [1000], '重复 stop 不得重复 kill');
});

check('sup-5 kill 走 taskkill /PID /T /F，PID 只能来自 spawn 返回值', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const kid = h.lastKid();
  h.sup.stop('k');
  assert.deepEqual(h.kills, [kid.c.pid]);
  assert.equal(h.sup.state('k').state, SUP_STATE.OFF);
  // `/T`（连进程树一道杀）是这个用例标题的真实承诺：typeperf / powershell 都会再派生子进程，
  // 只杀父进程会留下一群孤儿继续吃 CPU。参数形状单独断，才不会因为测试注入了 killFn 而落空。
  assert.deepEqual(KILL_ARGS(4321), ['/PID', '4321', '/T', '/F']);
});

check('sup-6 心跳：超过 3× 采样间隔无输出判 stalled，kill 并计一次重启', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.lastKid().c.stdout.emit('data', Buffer.from('a'));
  h.adv(3500);
  h.sup.tick();
  assert.equal(h.sup.state('k').state, SUP_STATE.CRASHED, 'stalled 应转为等待重启');
  assert.equal(h.kills.length, 1, 'stalled 必须真 kill，挂着不输出比崩更难发现');
  assert.equal(h.sup.state('k').restarts, 1);
  // `stalled` 是一闪而过的中间态（随即进 crashed 走退避），但它是 Task 8 的 sourceRow
  // 与 Task 21 采集源条的**红字依据**（`stalled|crashed|exited-max → so-pill-red`）。
  // 实现里只要不赋值这个态，界面就只会显示"崩了"而说不出"是挂着不吐数据" —— 故经 onChange 留痕断。
  assert.ok(h.changes.some((c) => c.state === SUP_STATE.STALLED), '必须真的进入过 stalled，否则该态是死枚举');
});

check('sup-7 rolling：窗口正常结束立即续采，不计入重启次数', () => {
  const h = harness();
  h.sup.start('l1a', { label: '网络', cmd: 'typeperf', args: [], intervalMs: 1000, rolling: true, minWindowMs: 5000, onData() {} });
  h.lastKid().c.stdout.emit('data', Buffer.from('a'));
  h.adv(6000);
  h.lastKid().c.emit('exit', 0, null);
  assert.equal(h.sup.state('l1a').state, SUP_STATE.STARTING, 'rolling 应立刻起下一窗');
  assert.equal(h.kids.length, 2);
  assert.equal(h.sup.state('l1a').restarts, 0);
});

check('sup-8 rolling 短窗连续 3 次进 exited-max（防热循环）', () => {
  const h = harness();
  h.sup.start('l1a', { label: '网络', cmd: 'typeperf', args: [], intervalMs: 1000, rolling: true, minWindowMs: 5000, onData() {} });
  for (let i = 0; i < 3; i += 1) {
    h.lastKid().c.emit('exit', 0, null); // 窗口不足 minWindowMs 就退
  }
  assert.equal(h.sup.state('l1a').state, SUP_STATE.EXITED_MAX);
});

check('sup-9 stderr 只保留末尾 400 字符，供采集源条附因', () => {
  const h = harness();
  h.sup.start('k', { label: 'k', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.lastKid().c.stderr.emit('data', Buffer.from('E'.repeat(600)));
  const tail = h.sup.state('k').stderrTail;
  assert.equal(tail.length, 400);
});

check('sup-10 dispose 停掉所有在跑的 child 并清掉待触发的定时器', () => {
  const h = harness();
  h.sup.start('a', { label: 'a', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.sup.start('b', { label: 'b', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  h.lastKid().c.emit('exit', 1, null);
  h.sup.dispose();
  assert.equal(h.kills.length, 2);
  assert.ok(h.timers.every((x) => x.done), 'dispose 后不能有活的定时器');
  assert.deepEqual(h.sup.status(), []);
});

check('sup-11 status() 每项带 label / state / restarts / pid / detail，界面直接消费', () => {
  const h = harness();
  h.sup.start('l1a', { label: '网络（typeperf）', cmd: 'c', args: [], intervalMs: 1000, onData() {} });
  const row = h.sup.status()[0];
  assert.equal(row.key, 'l1a');
  assert.equal(row.label, '网络（typeperf）');
  assert.equal(row.state, SUP_STATE.STARTING);
  assert.equal(row.detail, '已排 0 次重启');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/collect.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/collect/supervisor.js`。

- [ ] **Step 3: 写实现**

```js
/**
 * 常驻子进程的唯一监督者。
 *
 * 为什么需要 rolling（对应计划期实测修正 #1）：`typeperf -sc 0` 在无控制台的管道里
 * **出一个样本就 exit=0**，根本不存在"无限流式"。所以 L1a 只能定窗续采：
 * 每窗 `-sc N`，窗口正常结束立刻起下一窗。这类"看起来是正常退出"的续接
 * 不能走崩溃退避（否则每窗都白等 1s），但必须防热循环 —— 窗口活不过
 * `minWindowMs` 连续 3 次就判 exited-max。
 *
 * kill 为什么用 taskkill 而不是 child.kill()：Windows 下对 `shell:true` / 孙子进程，
 * `child.kill()` 只打到 shell 本身，typeperf 会变孤儿继续跑。PID 只取 spawn 返回值。
 */
import { spawn, execFile } from 'node:child_process';

export const SUP_STATE = {
  OFF: 'off',
  STARTING: 'starting',
  ON: 'on',
  STALLED: 'stalled',
  CRASHED: 'crashed',
  EXITED_MAX: 'exited-max',
};

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 30000];
export const MAX_RESTARTS = BACKOFF_MS.length;
const STDERR_TAIL = 400;
const SHORT_WINDOW_LIMIT = 3;

/** 默认 kill：taskkill 树杀。pid 由调用方从 spawn 结果提供，绝不接受外部输入。 */
/** `/T` 是必须的：typeperf 与 powershell 都会再派生子进程，只杀父会留下孤儿继续占 CPU。
 *  单独导出是为了让 sup-5 能断参数形状 —— 测试注入 `killFn` 时，`defaultKill` 本体永远不进被测路径。 */
export const KILL_ARGS = (pid) => ['/PID', String(pid), '/T', '/F'];

export function defaultKill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', KILL_ARGS(pid), { windowsHide: true }, (err) => resolve(!err));
  });
}

export function createSupervisor(options = {}) {
  const {
    spawnFn = (cmd, args, opts) => spawn(cmd, args, { windowsHide: true, ...opts }),
    killFn = defaultKill,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    heartbeatFactor = 3,
    onChange = () => {},
    logger = console,
  } = options;

  /** @type {Map<string, any>} */
  const reg = new Map();

  const detail = (rec) =>
    rec.state === SUP_STATE.EXITED_MAX
      ? `已排 ${rec.restarts} 次重启（上限 ${MAX_RESTARTS}），不再自动重启`
      : `已排 ${rec.restarts} 次重启`;

  function snapshot(rec) {
    return {
      key: rec.key,
      label: rec.label,
      state: rec.state,
      restarts: rec.restarts,
      shortWindows: rec.shortWindows,
      pid: rec.child?.pid ?? null,
      lastTick: rec.lastTick,
      stderrTail: rec.stderrTail,
      detail: detail(rec),
    };
  }

  function emit(rec) {
    onChange(rec.key, snapshot(rec));
  }

  function setState(rec, state) {
    rec.state = state;
    emit(rec);
  }

  function launch(rec) {
    rec.stopping = false;
    rec.startedAt = now();
    setState(rec, SUP_STATE.STARTING);
    let child;
    try {
      child = spawnFn(rec.cmd, rec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // spawn 直接抛（命令不存在等）按一次失败退出处理，别把监督者自己搞崩
      rec.lastError = String(e?.message ?? e);
      scheduleRestart(rec);
      return;
    }
    rec.child = child;
    // 行框定在**字节**上做：GBK 的尾字节范围是 0x40~0xFE，绝不会出现 0x0A，所以在解码前按 `\n`
    // 切分是安全的；反过来先 `toString('latin1')` 就把中文计数器名永久解不回来了（Task 6 首当其冲）。
    let acc = Buffer.alloc(0);
    child.stdout?.on('data', (buf) => {
      rec.lastTick = now();
      if (rec.state !== SUP_STATE.ON) setState(rec, SUP_STATE.ON);
      acc = acc.length ? Buffer.concat([acc, buf]) : Buffer.from(buf);
      let i;
      while ((i = acc.indexOf(0x0a)) >= 0) {
        const line = acc.subarray(0, i);
        acc = acc.subarray(i + 1);
        const probe = line.toString('latin1').replace(/\r$/, '');
        if (probe.trim() !== '') rec.onLine(Buffer.from(probe, 'latin1'));
      }
    });
    child.stderr?.on('data', (buf) => {
      const text = buf.toString('latin1');
      rec.stderrTail = (rec.stderrTail + text).slice(-STDERR_TAIL);
    });
    child.on('error', (e) => {
      rec.lastError = String(e?.message ?? e);
      scheduleRestart(rec);
    });
    child.on('exit', (code, sig) => handleExit(rec, code, sig));
  }

  function scheduleRestart(rec) {
    if (rec.timer) clearTimeoutFn(rec.timer);
    if (rec.restarts >= MAX_RESTARTS) {
      setState(rec, SUP_STATE.EXITED_MAX);
      logger.warn?.(`[sysops] 采集子进程 ${rec.label} 重启达上限 ${MAX_RESTARTS} 次，已停止自动重启：${rec.lastError || rec.stderrTail}`);
      return;
    }
    const ms = BACKOFF_MS[rec.restarts];
    rec.restarts += 1;
    setState(rec, SUP_STATE.CRASHED);
    rec.timer = setTimeoutFn(() => {
      rec.timer = null;
      if (!reg.has(rec.key) || rec.stopping) return;
      launch(rec);
    }, ms);
    if (typeof rec.timer?.unref === 'function') rec.timer.unref();
  }

  function handleExit(rec, code, sig) {
    // 自己 kill 掉的子进程一定会补一个 exit 事件。心跳（stalled）那条路此时已经进了
    // crashed + 退避定时器，这个尾巴再走一遍会把"等待重启"覆盖成 off，界面看上去像"被人关了"。
    if (rec.state === SUP_STATE.CRASHED || rec.state === SUP_STATE.EXITED_MAX) return;
    if (rec.stopping) {
      rec.child = null;
      setState(rec, SUP_STATE.OFF);
      return;
    }
    rec.lastExit = { code, sig };
    const voluntary = code === 0;
    const lifetime = now() - rec.startedAt;
    if (rec.rolling && voluntary) {
      if (lifetime >= rec.minWindowMs) {
        rec.shortWindows = 0;
        launch(rec); // 定窗续采：正常结束，立刻接下一窗
        return;
      }
      rec.shortWindows += 1;
      if (rec.shortWindows >= SHORT_WINDOW_LIMIT) {
        setState(rec, SUP_STATE.EXITED_MAX);
        logger.warn?.(`[sysops] 采集子进程 ${rec.label} 连续 ${SHORT_WINDOW_LIMIT} 个窗口活不过 ${rec.minWindowMs}ms，停止续采`);
        return;
      }
      launch(rec);
      return;
    }
    if (voluntary && !rec.rolling) {
      // 不该自己退的东西退了：也计一次重启，否则"静悄悄没数据"最难查
      rec.lastError = rec.lastError || '进程正常退出（非 rolling 模式下视为异常）';
    }
    scheduleRestart(rec);
  }

  function killChild(rec) {
    const pid = rec.child?.pid;
    if (!pid) return false;
    rec.stopping = true;
    // 即发即忘，**不返回 promise**：`stop` / `tick` 里只要留一个 `await`/`.then`，
    // 状态翻转就落在微任务里，sup-5 / sup-6 这种同步用例读到的永远是上一个态。
    // kill 失败不影响状态机（下一次采样没数据仍会被心跳判成 stalled），所以这里不等结果。
    try {
      killFn(pid);
    } catch (e) {
      rec.lastError = `kill ${pid} 失败：${String(e?.message ?? e)}`;
    }
    return true;
  }

  return {
    start(key, spec) {
      const rec = {
        key,
        label: spec.label ?? key,
        cmd: spec.cmd,
        args: spec.args ?? [],
        intervalMs: spec.intervalMs ?? 1000,
        rolling: spec.rolling === true,
        minWindowMs: spec.minWindowMs ?? (spec.intervalMs ?? 1000) * 3,
        onLine: spec.onData ?? (() => {}),
        state: SUP_STATE.OFF,
        restarts: 0,
        shortWindows: 0,
        lastTick: 0,
        startedAt: 0,
        stderrTail: '',
        lastError: '',
        lastExit: null,
        child: null,
        timer: null,
        stopping: false,
      };
      reg.set(key, rec);
      launch(rec);
      return snapshot(rec);
    },
    stop(key) {
      const rec = reg.get(key);
      if (!rec) return null;
      if (rec.timer) { clearTimeoutFn(rec.timer); rec.timer = null; }
      killChild(rec);
      rec.child = null;
      rec.restarts = 0;
      rec.shortWindows = 0;
      setState(rec, SUP_STATE.OFF);
      reg.delete(key);
      return null;
    },
    /** 心跳巡检：由 collect service 的定时器驱动，测试里手工推进时钟。 */
    tick() {
      for (const rec of [...reg.values()]) {
        if (rec.state !== SUP_STATE.ON) continue;
        const limit = heartbeatFactor * rec.intervalMs;
        if (now() - rec.lastTick > limit) {
          rec.lastError = `${Math.round(limit / 1000)}s 无输出，判为卡住`;
          // 全程同步：stalled 只是给界面留的那一态，紧接着就走 crashed + 退避。
          setState(rec, SUP_STATE.STALLED);
          killChild(rec);
          rec.child = null;
          scheduleRestart(rec);
        }
      }
    },
    state(key) {
      const rec = reg.get(key);
      return rec ? snapshot(rec) : { key, label: key, state: SUP_STATE.OFF, restarts: 0, shortWindows: 0, pid: null, lastTick: 0, stderrTail: '', detail: '未开启' };
    },
    status() {
      return [...reg.keys()].map((k) => snapshot(reg.get(k)));
    },
    keys() {
      return [...reg.keys()];
    },
    dispose() {
      for (const rec of reg.values()) {
        if (rec.timer) clearTimeoutFn(rec.timer);
        killChild(rec);
      }
      reg.clear();
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/collect.test.mjs`
Expected: `20/20 通过`（①4 + ②5 + ③11）。③段是 sup-1..sup-11 共 11 例（原 `sup-3` 与 `sup-3b` 合一：前者只断长度、后者拿实现自己的常量自比，两条都不承重，详见 Task 5 预检台账 Ruling-29）。

- [ ] **Step 5: 变异断言**

两条都要跑，输出记进汇报：
1. 把 `BACKOFF_MS` 临时改成 `[1000,1000,1000,1000,1000]` —— `sup-3` 必须变红（两条断言都断字面量，改实现里的常量一定抓得住）；再改回跑绿。
2. 把 `tick()` 里的 `setState(rec, SUP_STATE.STALLED)` 删掉 —— `sup-6` 必须变红（否则 `stalled` 是死枚举，Task 21 的红字没有依据）；再改回跑绿。
提交信息草稿：`feat(sysops): 采集子进程监督器（退避 / 心跳 / rolling 续窗）`

---

## Task 6: `lib/collect/l1a-typeperf.js` + 采集实测探针脚本

**Files:**
- Create: `lib/collect/l1a-typeperf.js`
- Create: `scripts/probe-collect.mjs`
- Create: `test/fixtures/typeperf-multi-instance.txt`
- Modify: `test/collect.test.mjs`（追加 ④段）

**Interfaces:**
- Consumes: `supervisor.start/stop/state`（Task 5）
- Produces:
  - `decodePd(buf) → string`、`splitCsv(line) → string[]`、`parseHeader(text) → {counters:[{index,instance,counter,metric}]}`、`parsePdTime(s) → number`、`parseSampleLine(line, counters) → {t, values:{netDown,netUp}} | null`
  - `COUNTER_ARGS`、`WINDOW_SAMPLES = 30`、`INTERVAL_SEC = 1`
  - `createL1a({ sup, onPoint, intervalSec?, windowSamples? })` → `{ enable(), disable(), state() }`，`onPoint({ metric, t, v })`，`v` 单位是 **字节/秒**

- [ ] **Step 1: 建 fixture（照本机实测的字面形状）**

`test/fixtures/typeperf-multi-instance.txt`（每行一条，含表头 / 正常样本 / 半行断流 / 中文计数器 / `_no data_` 五种形态。表头里的机器名按实测修正 #2 保留 GBK 乱码形态的 ASCII 替身，真实机器名由 `decodePd` 负责）：

```
"(PDH-CSV 4.0)","\\HOSTNAME\Network Interface(Intel[R] Wi-Fi 6 AX201 160MHz)\Bytes Received/sec","\\HOSTNAME\Network Interface(Intel[R] Wi-Fi 6 AX201 160MHz)\Bytes Sent/sec","\\HOSTNAME\Network Interface(\isatap.{ABCDEF})\Bytes Received/sec","\\HOSTNAME\Network Interface(\isatap.{ABCDEF})\Bytes Sent/sec"
"09/27/2026 12:49:41.046","161665.280249","17174.648338","0.000000","0.000000"
"09/27/2026 12:49:42.062","524288.000000","65536.000000","*_no data","*_no data"
"09/27/2026 12:49:43.078","1048576.000000","131072.000000","1.5","2.5"
"09/27/2026 12:49:44.093","2097152.0000
正在退出，请稍候...
命令成功结束。
```

- [ ] **Step 2: 写失败的测试**

```js
/* ④段：typeperf 解析（纯函数，零子进程） */
const fs = await import('node:fs');
const L1A = await import('../lib/collect/l1a-typeperf.js');
const FIX = fs.readFileSync(new URL('./fixtures/typeperf-multi-instance.txt', import.meta.url), 'utf8').split(/\r?\n/);

check('tp-1 splitCsv 认带引号的字段，且不把转义引号当分隔', () => {
  assert.deepEqual(L1A.splitCsv('"a","b,c","d"'), ['a', 'b,c', 'd']);
  assert.deepEqual(L1A.splitCsv('"\\"q\\"",x'), ['"q"', 'x']);
});

check('tp-2 parseHeader 丢机器名前缀，只取实例名与计数器名', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  assert.equal(counters.length, 4);
  assert.equal(counters[0].instance, 'Intel[R] Wi-Fi 6 AX201 160MHz');
  assert.equal(counters[0].counter, 'Bytes Received/sec');
  assert.equal(counters[0].metric, 'netDown');
  assert.equal(counters[1].metric, 'netUp');
  assert.equal(counters[2].instance, '\\isatap.{ABCDEF}');
});

check('tp-3 非表头行返回 null（流式解析会先撞上样本行）', () => {
  assert.equal(L1A.parseHeader(FIX[1]), null);
  assert.equal(L1A.parseHeader('正在退出，请稍候...'), null);
});

check('tp-4 parsePdTime 按本地时间解析 MM/DD/YYYY HH:mm:ss.fff', () => {
  const t = L1A.parsePdTime('09/27/2026 12:49:41.046');
  const d = new Date(t);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 27);
  assert.equal(d.getHours(), 12);
  assert.equal(d.getMinutes(), 49);
  assert.equal(d.getSeconds(), 41);
});

check('tp-5 样本解析：多实例按指标求和（界面要的是本机总吞吐），原始浮点不取整', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  const s = L1A.parseSampleLine(FIX[3], counters);
  // 断言字面量。`v` 是字节/秒的原始浮点，取整只在界面格式化时做。
  // （这里原本写的是 `Math.round(s.values.netDown) === 1048576 + 1.5` —— 左边四舍五入成
  //   1048578、右边是 1048577.5，**恒不相等**，预检实跑 tp-5 直接红。）
  assert.equal(s.values.netDown, 1048577.5);
  assert.equal(s.values.netUp, 131074.5);
});

check('tp-6 *_no data 列不计入和，但其它列照样出数；整行全是 *_no data 则整行不出数', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  const s = L1A.parseSampleLine(FIX[2], counters);
  assert.equal(s.values.netDown, 524288);
  assert.equal(s.values.netUp, 65536);
  // 真机每窗第一行常见形态就是全部 `*_no data`（typeperf 暖身期）。这种行必须整行丢弃：
  // 把它折成 0 会在曲线上画出一个假谷底，而 0 恰好是"没人用网"的意思，最难被发现。
  assert.equal(L1A.parseSampleLine('"09/27/2026 12:49:41.000","*_no data","*_no data","*_no data","*_no data"', counters), null);
});

check('tp-7 半行断流（列数不足 / 引号未闭合）返回 null，不抛、也不补 0', () => {
  const { counters } = L1A.parseHeader(FIX[0]);
  assert.equal(L1A.parseSampleLine(FIX[4], counters), null);
  assert.equal(L1A.parseSampleLine('正在退出，请稍候...', counters), null);
  // 列数不足但每列都有值（截断正好落在两个字段之间）也要判不完整，否则出半个吞吐值。
  assert.equal(L1A.parseSampleLine('"09/27/2026 12:49:44.093","2097152.0000"', counters), null);
});

check('tp-8 decodePd：GBK 字节解出中文，纯 ASCII 不受影响，解出替换符时回落 latin1', () => {
  assert.equal(L1A.decodePd(Buffer.from([0xce, 0xf1, 0xb9, 0xfa])), '务国');
  assert.equal(L1A.decodePd(Buffer.from('"1234.5"', 'latin1')), '"1234.5"');
  // 真机表头实测（计划期修正 #2 复核）：`"(PDH-CSV 4.0)","\\龚进的华为笔记\Network Interface(Intel[R] Wi-Fi 6 AX201 160MHz)\Bytes Received/sec"`
  // —— 机器名是 GBK 字节，其余全是 ASCII，所以"含高位字节就要解、纯 ASCII 不能被动过"是硬要求。
  // 非法 GBK 序列：TextDecoder('gbk') 默认非 fatal，**不抛**而是出 U+FFFD，
  // 所以回落必须靠检测替换符（原实现的 try/catch 是死代码，预检实测 [0x81] → '\uFFFD'）。
  assert.equal(L1A.decodePd(Buffer.from([0x81])), '\x81');
});

check('tp-9 COUNTER_ARGS / 窗口参数是常量，界面文案要用它们而不是再抄一遍', () => {
  assert.deepEqual(L1A.COUNTER_ARGS, [
    '\\Network Interface(*)\\Bytes Received/sec',
    '\\Network Interface(*)\\Bytes Sent/sec',
  ]);
  assert.equal(L1A.WINDOW_SAMPLES, 30);
  assert.equal(L1A.INTERVAL_SEC, 1);
});

check('tp-10 l1a 门面：onData 收 Buffer、解码一次、下游抛错不外抛、disable 清表头', () => {
  // createL1a 是 l1a 唯一有副作用的部分，没有用例就等于"与代码不符的陈述"。
  const started = [];
  const stops = [];
  const sup = {
    start: (key, spec) => started.push({ key, spec }),
    stop: (k) => stops.push(k),
    state: () => ({ state: 'on' }),
  };
  const pts = [];
  const a = L1A.createL1a({
    sup,
    onPoint: (p) => {
      if (p.metric === 'netUp' && p.v === 131074.5) throw new Error('boom-downstream');
      pts.push(p);
    },
  });
  a.enable();
  assert.equal(started[0].key, 'l1a');
  assert.equal(started[0].spec.rolling, true);
  assert.deepEqual(started[0].spec.args.slice(-4), ['-sc', '30', '-si', '1']);
  const feed = (s) => started[0].spec.onData(Buffer.from(s, 'latin1'));
  feed(FIX[0]);
  feed(FIX[3]);            // netDown 已入列，netUp 那一点抛错 —— 必须被吞下，不外抛
  assert.deepEqual(pts.map((p) => p.metric), ['netDown']);
  assert.equal(pts[0].v, 1048577.5);
  feed(FIX[1]);            // 抛错之后的下一行仍要出数，不能整条流哑掉
  assert.deepEqual(pts.map((p) => p.metric), ['netDown', 'netDown', 'netUp']);
  assert.equal(a.state().state, 'on');
  // 这两个数值字段是 l1a 自己扩的（监督者快照里没有），Task 8 的界面直接读它们 ——
  // 没有断言就是"与代码不符的陈述"：吞掉的那次异常必须留痕，没认出表头的行必须能累加。
  assert.equal(a.state().dataErrors, 1);
  assert.match(a.state().detail, /boom-downstream/);
  a.disable();
  assert.deepEqual(stops, ['l1a']);
  feed(FIX[1]);            // disable 后表头必须已清空：不许拿旧 index 去解新列布局
  assert.equal(pts.length, 3);
  assert.equal(a.state().noHeaderRuns, 1);   // 阈值是 5，这里未到，只验计数本身在走
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node test/collect.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/collect/l1a-typeperf.js`（fixture 已存在，不会先报它）。

- [ ] **Step 4: 写实现**

`lib/collect/l1a-typeperf.js` 的导出与判定（关键片段照写，其余按测试补齐）：

```js
/**
 * L1a —— 网络吞吐。常驻 `typeperf` 流式输出，逐行解析 PDH-CSV 4.0。
 *
 * 两个实测坑（计划期修正 #1 / #2）：
 *  - `-sc 0` 在无控制台管道里出一个样本就退出，所以**定窗续采**（每窗 30 个样本），
 *    由 supervisor 的 rolling 语义接下一窗；本机实测暖身 ≈330ms / 窗（2 样本窗 2337–2373ms），
 *    摊薄到 30 样本窗后 <1%。
 *  - 输出是 OEM 代码页（中文机器名为 GBK 字节），`TextDecoder('gbk')` 在本机 Node 24 可用；
 *    机器名前缀反正用不上，直接靠正则只取 `Network Interface(<实例>)\<计数器>`。
 *
 * 多实例（物理网卡 + isatap + loopback）按指标**求和**：界面要的是"本机下行多少"。
 */
```

实现要点（逐段照写，`splitCsv` / `parsePdTime` 按注释里的口径自己补齐）：

```js
export const COUNTER_ARGS = ['\\Network Interface(*)\\Bytes Received/sec', '\\Network Interface(*)\\Bytes Sent/sec'];
export const WINDOW_SAMPLES = 30;
export const INTERVAL_SEC = 1;
const METRIC_BY_COUNTER = { 'bytes received/sec': 'netDown', 'bytes sent/sec': 'netUp' };
const HEADER_PATH_RE = /Network Interface\(([^)]*)\)\\([^"]+?)"?$/i;

export function decodePd(buf) { /* 先 gbk 再 latin1，见下 */ }
export function splitCsv(line) { /* 手写扫描：引号内的逗号不是分隔符，"" 与 \" 都当转义引号 */ }
export function parseHeader(text) {
  if (!text.startsWith('"')) return null;
  const cells = splitCsv(text);
  if (!/^\(PDH-CSV/.test(cells[0] ?? '')) return null;
  const counters = [];
  for (let i = 1; i < cells.length; i += 1) {
    const m = HEADER_PATH_RE.exec(cells[i]);
    if (!m) continue;
    const metric = METRIC_BY_COUNTER[m[2].trim().toLowerCase()];
    counters.push({ index: i, instance: m[1], counter: m[2].trim(), metric: metric ?? null });
  }
  return counters.length ? { counters } : null;
}
export function parsePdTime(s) { /* MM/DD/YYYY HH:mm:ss.fff → new Date(y,mo-1,d,h,mi,sec,ms).getTime() */ }
export function parseSampleLine(line, counters) {
  if (!line.startsWith('"')) return null;
  // 不完整的行整行丢弃（tp-7）。typeperf 每个值都带引号，所以"行尾没有引号"= 半行；
  // 列数下限按**表头最大列号**算，不是 `counters.length` —— 预检原实现只看
  // `Number.isFinite(每列)`，实测把 `"…","2097152.0000` 这种半行当成了有效样本、
  // 悄悄吐出一个只有下行没有上行的"半口吞吐"。
  const need = counters.reduce((m, c) => Math.max(m, c.index + 1), 0);
  const cells = splitCsv(line);
  if (!line.endsWith('"') || cells.length < need) return null;
  const t = parsePdTime(cells[0] ?? '');
  if (!Number.isFinite(t)) return null;
  const sums = {};
  let seen = 0;
  for (const c of counters) {
    if (!c.metric) continue;
    const n = Number(cells[c.index]);
    if (!Number.isFinite(n)) continue;   // *_no data（非数值）→ 跳过该列。速率不会有负数，不设 n<0 分支
    sums[c.metric] = (sums[c.metric] ?? 0) + n;
    seen += 1;
  }
  return seen ? { t, values: sums } : null;        // 一列可用都没有 → 整行 null（不补 0）
}

export function createL1a({ sup, onPoint, intervalSec = INTERVAL_SEC, windowSamples = WINDOW_SAMPLES }) {
  let headers = null;
  return {
    enable() {
      sup.start('l1a', {
        label: '网络吞吐（typeperf 常驻）',
        cmd: 'typeperf',
        args: [...COUNTER_ARGS, '-sc', String(windowSamples), '-si', String(intervalSec)],
        intervalMs: intervalSec * 1000,
        rolling: true,
        minWindowMs: windowSamples * intervalSec * 1000 * 0.5,
        onData: (raw) => {
          // Task 5 交付契约：`raw` 是**一整行的 Buffer**（`\r\n` 已去），解码归消费方。
          // 每行只解一次；GBK 对纯 ASCII 是恒等的，所以不必先判断有没有高位字节。
          const line = decodePd(raw);
          headers = parseHeader(line) ?? headers;
          if (!headers) return;
          const s = parseSampleLine(line, headers.counters);
          if (!s) return;
          for (const [metric, v] of Object.entries(s.values)) onPoint({ metric, t: s.t, v });
        },
      });
    },
    disable() { return sup.stop('l1a'); },
    state: () => sup.state('l1a'),
  };
}
```

`decodePd` 的实现（照写）：

```js
let gbk = null;
try { gbk = new TextDecoder('gbk'); } catch { gbk = null; }   // 本机 Node 24 可用；留兜底给无 ICU 的环境

export function decodePd(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'latin1');
  if (gbk) {
    const s = gbk.decode(b);
    // TextDecoder 默认 fatal:false —— **不会抛**，非法字节出 U+FFFD。
    // 所以回落条件只能是"解出了替换符"（tp-8 用 [0x81] 钉住）；原实现的 try/catch 是死代码。
    // latin1 逐字节映射，永不丢字节，数字与 ASCII 结构都还在。
    if (!s.includes('\uFFFD')) return s;
  }
  return b.toString('latin1');
}
```

> `createL1a.onData` 收到的是 Buffer 完整行（Task 5 在**字节**上框行，见 Ruling-29 ⑥），所以解码必须写在这一层：`const line = decodePd(raw)`，之后 `parseHeader` / `parseSampleLine` 才拿到单行字符串。反过来在监督者里 `toString` 会把 GBK 尾字节变成乱码并把乱码推给 Task 7 的 UTF-8 消费方。

评审返工加四条（tp-10 钉住前两条，后两条靠既有口径）：
1. **`onData` 体必须包 try/catch**：`onPoint` 是调用方给的回调，它抛错会**同步冒出** child stdout 的 `data` 处理器 —— 真机就是 uncaughtException 带崩宿主，而且同一 chunk 里后面的完整行会被丢掉（监督者的 while 被打断）。吞下时把因由留在 l1a 一侧可读（`lastError` 计数或字段，`state()` 里带出去给 Task 8）。
2. **`disable()` 里 `headers = null`**：不清就会在"新表头解析失败"时拿旧 index 去解新列布局，出静音的错值。
3. **`HEADER_PATH_RE` 的实例组用贪婪 `\((.*)\)\\`**：`[^)]*` 遇到实例名里有 `)`（如 `Intel(R) Ethernet Connection (7) I219-V`）会整张表头解析成 null ⇒ 采集静默 0 点。本机 PDH 把 `()` 折成 `[]`，所以这是防御别的机器的；同时"连续若干行都没认出表头"要把因由挤进 `detail`，别只报"重启达上限"。
4. **`""` 空列不许当 0**：`Number('')` 是 0，会画出一个假谷底（tp-6 反对的正是这个）。计入前先判非空。

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/collect.test.mjs`
Expected: `30/30 通过`（①4 ②5 ③11 ④10），退出码 0。

- [ ] **Step 5b: 变异自查（断言强度取证）**

临时改实现三处，每一处都必须有红色用例，然后逐字节还原（`cp` 备份 + `cmp` 校验，别凭记忆改回去）：
1. 删掉 `parseSampleLine` 里的完整性判定（`line.endsWith('"') || cells.length < need`）→ tp-7 必须红（预检原实现就是缺这一步，把半行当成有效样本吐出一个只有下行的"半口吞吐"）。
2. `decodePd` 去掉 U+FFFD 检测、直接返回 GBK 解码结果 → tp-8 第三条必须红。
3. 把 `if (!Number.isFinite(n)) continue;` 换成"当成 0 计入"：`if (!Number.isFinite(n)) { sums[c.metric] = (sums[c.metric] ?? 0) + 0; seen += 1; continue; }` → tp-6 必须红。
   （注意别只改 `sums[...] + (Number.isFinite(n) ? n : 0)` 那一处 —— 前面已经 `continue` 掉了，那种改法是**空变异**，预检实测它 9/9 全绿。）
三条都咬红才算这一步过；任何一条不红，说明断言没承重，先补断言再往下走。预检实测读数：变异 1 → tp-7 红；变异 2 → tp-8 红；变异 3 → tp-6 红。
再加两条针对返工项的变异（tp-10 必须各咬红一次）：
4. 去掉 `onData` 的 try/catch → tp-10 必须红（`onPoint` 抛错冒出 `data` 处理器 = 真机 uncaughtException 带崩宿主）。
5. `disable()` 里去掉 `headers = null` → tp-10 最后一条必须红（旧 index 解新列布局 = 静音错值）。
6. 三个控制器补的断言各自咬红一项（④段计数仍为 10，只往 tp-10 体内加断言）：
   - `dataErrors += 1` 改 `+= 0` → 只有 `dataErrors === 1` 红（实测读数 `0 == 1`）。
   - `noHeaderRuns += 1` 改 `+= 0` → 只有 `noHeaderRuns === 1` 红（实测读数 `0 == 1`）。
   - `if (lastError) reasons.push(...)` 改 `if (false)` → `detail` 那条正则断言红。
   （第 3 项的改法别写成 `lastError = ''` —— 会被 `if (lastError)` 那层守卫吃掉，是**空变异**，实测 30/30 全绿。）

- [ ] **Step 6: 写探针脚本 `scripts/probe-collect.mjs`**

这是验收门禁 5 的执行体（复跑 spec §1.2 的六项实测，另加"首行到达"这条看门狗校准），也是本插件唯一允许 spawn 真进程的非测试文件：

```js
#!/usr/bin/env node
/**
 * 采集代价实测（spec §1.2 的六条 + 计划期修正的两条）。
 * 用法：node scripts/probe-collect.mjs
 * 输出就是一张表；跑完把它和 spec §1.2 对一遍，偏差 >20% 要回写 spec。
 */
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { COUNTER_ARGS, WINDOW_SAMPLES } from '../lib/collect/l1a-typeperf.js';
import { decodePd } from '../lib/collect/l1a-typeperf.js';

const ms = (fn, rounds = 1) => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) fn();
  return Number(process.hrtime.bigint() - t) / 1e6 / rounds;
};
const row = (name, value, note = '') => console.log(`${name.padEnd(34)} ${String(value).padStart(12)}  ${note}`);

console.log('\n== L0 ==');
row('os.cpus() 单次均耗时(ms)', ms(() => os.cpus(), 100).toFixed(2), `逻辑核 ${os.cpus().length}`);
const st = fs.statfsSync('C:\\');
row('fs.statfsSync(C:) 耗时(ms)', ms(() => fs.statfsSync('C:\\'), 20).toFixed(1));
row('C: 总容量(GB)', (st.blocks * st.bsize / 2 ** 30).toFixed(1));
row('C: 可用(GB)', (st.bavail * st.bsize / 2 ** 30).toFixed(1));

console.log('\n== L1a ==');
const cold = spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '1'], { encoding: 'buffer', windowsHide: true });
row('typeperf -sc 1 冷启动(ms)', ms(() => spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '1'], { windowsHide: true }), 1).toFixed(0));
const warm = ms(() => spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '3'], { windowsHide: true }), 1);
row(`typeperf -sc 3 窗口(ms)`, warm.toFixed(0), `每窗暖身 ≈ ${warm.toFixed(0)}ms，-sc ${WINDOW_SAMPLES} 摊薄后 <1%`);
row('typeperf 首行前 60 字符', decodePd(cold.stdout).split(/\r?\n/)[0].slice(0, 60), '机器名为 GBK 字节，解析层只取实例名与计数器名');
const zero = spawnSync('typeperf', [...COUNTER_ARGS, '-sc', '0'], { windowsHide: true, timeout: 8000 });
row('typeperf -sc 0 exitCode', zero.status, '0 且只出一个样本 = 无控制台管道下不提供无限流式（修正 #1）');
// 启动看门狗校准：Task 5 的 STARTING 阈值是 3 × intervalMs = 3000ms。量"进程起来 → stdout 第一行"，
// 超过 1500ms（阈值一半）就得为 l1a 单独放宽 heartbeatFactor，否则慢机器上反复误杀并累计到 exited-max。
const firstLine = await new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn('typeperf', [...COUNTER_ARGS, '-sc', '5', '-si', '1'], { windowsHide: true });
  let acc = Buffer.alloc(0);
  p.stdout.on('data', (b) => {
    acc = Buffer.concat([acc, b]);
    if (acc.indexOf(0x0a) >= 0) { resolve(Date.now() - t0); p.kill(); }
  });
  p.on('exit', () => resolve(-1));   // 没等到行就退了 = 本机这条路不通，如实记 -1
});
row('typeperf 首行到达(ms)', firstLine, '看门狗 3000ms；>1500ms 要为 l1a 放宽');

console.log('\n== L1b ==');
row('Get-CimInstance Win32_Process(ms)',
  ms(() => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process | Measure-Object).Count'], { windowsHide: true }), 1).toFixed(0));

console.log('\n== L2（最贵的一项，约 7s）==');
const root = path.join(os.tmpdir(), 'sysops-probe-walk-' + Date.now());
fs.mkdirSync(root, { recursive: true });
for (let i = 0; i < 400; i++) {
  const d = path.join(root, 'd' + (i % 8));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'f' + i + '.tmp'), 'x'.repeat(1024));
}
let entries = 0;
const walkStart = Date.now();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    entries += 1;
    if (e.isDirectory()) walk(path.join(dir, e.name));
  }
};
walk(path.join(process.env.LOCALAPPDATA, 'Temp'));
row('遍历 %LOCALAPPDATA%\\Temp 条目', entries, `${Date.now() - walkStart}ms`);
fs.rmSync(root, { recursive: true, force: true });
console.log('\n探针结束。偏差 >20% 时更新 docs/superpowers/specs/2026-09-27-dsh-plugin-sysops-design.md §1.2。\n');
```

Run: `node scripts/probe-collect.mjs`
Expected: 打印上表，最后一行"探针结束。"。把这七行读数抄进 Task 25 的验收记录（`node scripts/probe-collect.mjs` 会真起 typeperf / powershell，全程约 20s，属预期）。

- [ ] **Step 7: 真机端到端确认（不写进测试文件）**

Run（临时脚本 `tmp/e2e-l1a.mjs`，跑完删除；**不要**用 `node -e` 走 shell 引号）：
```js
const { createSupervisor } = await import('../lib/collect/supervisor.js');
const { createL1a } = await import('../lib/collect/l1a-typeperf.js');
const sup = createSupervisor({});
const out = [];
const a = createL1a({ sup, onPoint: (p) => out.push(p) });
a.enable();
setTimeout(() => {
  console.log('点数', out.length, out.slice(0, 2), '状态', a.state().state, a.state().detail);
  a.disable();
  sup.dispose();
}, 6000);
```
Expected: 点数 `>= 3`，`metric` 里 `netDown` 与 `netUp` 都有，`v` 是正数，`状态` 为 `on`。若点数为 0，先看 `a.state().stderrTail`（多半是计数器名在本机不存在，此时按 spec §4.2「权限不足 / 计数器名不存在」分支处理，不要改成用别的计数器凑数）。

预检已在本机实测到的事实，照抄进结论、不要重新踩（`node scripts/probe-collect.mjs` 会复现）：
- **英文计数器名在这台中文机器上可用**：`typeperf "\Network Interface(*)\Bytes Received/sec" "\Network Interface(*)\Bytes Sent/sec" -sc 2 -si 1` 连跑 3 次全 `status=0`，样本行如 `"09/27/2026 19:10:14.287","5168.488257","874.133584"`。
- **`-y` 不是必需**（去掉它同样 `status=0`），它只是"退出时不提示"。别把它当成修好的原因。
- **绝对不要用 `typeperf -q "<含 (*) 的路径>"` 排查**：实测以 `0xC0000409` 崩掉 typeperf，并在紧随其后的一次调用里报出 `错误: 没有有效计数器。`（预检第一次就是被这个连带假象骗了一下）。要验证名单用 `typeperf "<单个计数器>" -sc 1 -y`。
- **表头实例数不固定**：本机 `(*)` 只枚举到 1 个活动网卡（列数 3），fixture 是 2 个实例（列数 5）—— 所以 tp-7 的完整性判定必须按**表头最大列号**而不是 `counters.length`。
- 表头机器名真实形态：`"(PDH-CSV 4.0)","\\龚进的华为笔记\Network Interface(Intel[R] Wi-Fi 6 AX201 160MHz)\Bytes Received/sec"`，GBK 字节 + 前置双反斜杠，fixture 与 `HEADER_PATH_RE` 都对得上。
- 每窗 2 样本实测 2337–2373ms ⇒ 暖身 ≈ 330ms、稳态每样本 ≈ 1s，`-sc 30` 的窗口约 30s，`minWindowMs=15s` 有 2 倍余量。
提交信息草稿：`feat(sysops): L1a 网络吞吐采集（定窗续采 + PDH-CSV 解析）与采集实测探针`

---

## Task 7: `lib/collect/l1b-powershell.js` —— 常驻进程榜

**Files:**
- Create: `lib/collect/l1b-powershell.js`
- Modify: `test/collect.test.mjs`（追加 ⑤段）

**Interfaces:**
- Consumes: `supervisor.start/stop/state`。**`onData` 收到的是 Buffer 完整行**（Task 5 Ruling-29 ⑥ 的交付契约），解码归本任务：powershell 的 stdout 在脚本里设了 `[Console]::OutputEncoding=UTF8` 之后是 **UTF-8**（实测前置缺失时是 GBK），所以本文件自己导出 `decodeOut(buf)`，**不得复用 l1a 的 `decodePd`（GBK）**；stderr 恒是 GBK，要给用户看原文时由 Task 8 决定怎么解。
- Produces:
  - `buildLoopScript({ intervalSec, withCpu }) → string`（**语句间用 `;` 分隔**，见下面 Step 5 的真机读数。**不在脚本里裁条数** —— 评审 M-1 的裁定见 Step 3 注：`Get-CimInstance` 不排序，`-First 400` 取的是"任意 400 个"而不是"内存最大的 400 个"，裁条数归解析层）
  - `parseProcLine(text, { procCount, maxRows }) → { t, rows: [{pid, name, ws, cpuPct}], truncated? } | null`（`cpuPct` 已按核数均摊；缺列**或值为 `null`** 时为 `null` 而不是 `0`，Task 9 的 `evaluateProc` 吃的就是这个键。`pid` 取不到数值时为 `null` 而不是 `0` —— 评审 M-2：`|| 0` 会把畸形 pid 折成 0，和真机恒在的 `System Idle Process`（pid 0）撞主键）
  - `decodeOut(buf) → string`（UTF-8；与 `decodePd` 分开的理由写在文件注释里）
  - `INTERVAL_SEC = 3`、`MAX_ROWS = 400`
  - `createL1b({ sup, onRows, intervalSec?, maxRows? })` → `{ enable(), disable(), state(), latest() }`。**`onRows` 是必填**（不是函数就抛，评审 M-3：`onRows?.()` 的可选链会在装配漏传时把整条进程榜静默吞掉）；`enable()` 与 `disable()` 都要把 `latest()` 的缓存清成 `null`（评审 Important-1：源已停或本轮只出了非 JSON 行时，`latest()` 还留着上一轮的残值，消费方无从分辨）。Task 8 必须把 `latest().t` 透到 `snapshot().proc.t`，界面与告警用它判新鲜度。

- [ ] **Step 1: 写失败的测试**

```js
/* ⑤段：PowerShell 常驻进程榜 */
const L1B = await import('../lib/collect/l1b-powershell.js');
const osMod = await import('node:os');   // 顶层 await：check() 的回调是同步的，`await` 写在体内不会生效

const oneRow = (over = {}) => JSON.stringify({
  t: 1760000000000,
  rows: [{ id: 4, n: 'svchost.exe', ws: 1024 ** 2, cpu: 12.5 }, { id: 7, n: 'chrome.exe', ws: 512 * 1024 ** 2 / 1024, cpu: 0 }, ...[over.extra].filter(Boolean)],
});

check('ps-1 buildLoopScript：常驻 while、UTF-8 前置、采样间隔在脚本里写死、不预裁条数', () => {
  const s = L1B.buildLoopScript({ intervalSec: 3, withCpu: true });
  assert.match(s, /\$OutputEncoding=\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/, '不设 UTF-8，中文进程名会变问号');
  // 预检真机读数：语句只用空格拼接 ⇒ powershell exit=1、stdout 0 字节（"表达式或语句中包含意外的标记"）。
  // 这两条把"能跑"钉进用例，而不是留给 Step 5 的肉眼。
  assert.match(s, /::UTF8;/, '语句之间必须有分号');
  assert.doesNotMatch(s, /Write-Output \$/, '$? 是布尔不是那行 JSON');
  assert.match(s, /while\(\$true\)/);
  assert.match(s, /Start-Sleep -Seconds 3/);
  // 评审 M-1 的裁定：`Get-CimInstance Win32_Process` 不排序，脚本里 `-First 400` 取到的是"任意 400 个"，
  // 而 `parseProcLine` 的 truncated 又恒为 0（源已裁）⇒ 进程数 >400 的机器上"内存最大的那些"会无声消失。
  // 裁条数只在解析层做，脚本必须如实把全量吐出来。
  assert.doesNotMatch(s, /Select-Object\s+-First/, '条数上限归解析层，不许在脚本里预裁');
  assert.match(s, /ConvertTo-Json -Compress/);
  assert.match(s, /PercentProcessorTime/, 'withCpu=true 必须取 CPU');
});

check('ps-2 withCpu=false 时不查 Perf 表（CPU 列实测超预算时的降级分支）', () => {
  const s = L1B.buildLoopScript({ intervalSec: 3, withCpu: false });
  assert.doesNotMatch(s, /PercentProcessorTime/);
  assert.match(s, /WorkingSetSize/);
});

check('ps-3 parseProcLine 归一化：id→pid、n→name、ws→字节、cpu→百分数（按核数均摊）', () => {
  const r = L1B.parseProcLine(oneRow(), { procCount: 8 });
  assert.equal(r.t, 1760000000000);
  assert.equal(r.rows.length, 2);
  assert.deepEqual({ ...r.rows[0] }, { pid: 4, name: 'svchost.exe', ws: 1024 ** 2, cpuPct: 1.5625 });
  // 评审 M-2：`Number(x) || 0` 会把取不到的 pid 折成 0，而真机恒有 pid 0 的 System Idle Process
  // （且它的 cpuPct 是聚合值）—— 两者撞主键会让界面把"缺 pid"的行当成 Idle。缺就是 null。
  const bad = L1B.parseProcLine(JSON.stringify({ t: 1, rows: [{ id: 'x', n: 'a.exe', ws: 5 }] }), { procCount: 8 });
  assert.equal(bad.rows[0].pid, null);
  assert.equal(bad.rows[0].ws, 5);
  // 复审 Imp-2：`id` 是 JSON 的 null 或空串时，`Number()` 给出的是 **0**（不是 NaN），会被判成"合法 pid 0"
  // 正好撞上真机恒有的 System Idle Process —— 上面那条 `'x'` 用例挡不住这一形，必须各钉一发。
  const nullId = L1B.parseProcLine(JSON.stringify({ t: 2, rows: [{ id: null, n: 'b.exe', ws: 6 }, { id: '', n: 'c.exe', ws: 7 }] }), { procCount: 8 });
  assert.equal(nullId.rows[0].pid, null, '"id":null 不是 pid 0');
  assert.equal(nullId.rows[1].pid, null, '"id":"" 不是 pid 0');
  assert.deepEqual(nullId.rows.map((x) => x.ws), [6, 7], '畸形 pid 的行不许被丢掉，name/ws 照样带出');
  const real0 = L1B.parseProcLine(JSON.stringify({ t: 3, rows: [{ id: 0, n: 'System Idle Process', ws: 4096, cpu: 800 }] }), { procCount: 8 });
  assert.equal(real0.rows[0].pid, 0, '真的 pid 0 必须是数字 0，与上面的 null 区分开');
});

check('ps-4 CPU 缺列（withCpu=false 或系统未给）时 cpuPct 为 null，不是 0', () => {
  const text = JSON.stringify({ t: 1, rows: [{ id: 9, n: 'a.exe', ws: 10 }] });
  const r = L1B.parseProcLine(text, { procCount: 8 });
  assert.equal(r.rows[0].cpuPct, null);
  assert.equal(r.rows[0].ws, 10);
  // 真机第一轮 391 行里就有 2 行是 `"cpu":null`（进程刚建、还没进 Perf 表）。
  // `Number(null) === 0`，所以这一种必须单独钉：显式的"没测到"不许被折成 0%。
  const n = L1B.parseProcLine(JSON.stringify({ t: 1, rows: [{ id: 9, n: 'a.exe', ws: 10, cpu: null }] }), { procCount: 8 });
  assert.equal(n.rows[0].cpuPct, null);
});

check('ps-5 非 JSON 行（PowerShell 的告警、进度条、空行）返回 null 而不是抛', () => {
  assert.equal(L1B.parseProcLine('Write-Error : 找不到驱动', { procCount: 8 }), null);
  assert.equal(L1B.parseProcLine('', { procCount: 8 }), null);
  assert.equal(L1B.parseProcLine('{"rows":"不是数组"}', { procCount: 8 }), null);
});

check('ps-6 单行超长（实测 391 进程 / 行 21018 字节）不影响解析；超上限时按 ws 降序留前 maxRows 并计数', () => {
  const rows = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, n: 'p' + i, ws: 1024, cpu: 0 }));
  const r = L1B.parseProcLine(JSON.stringify({ t: 5, rows }), { procCount: 8, maxRows: 400 });
  assert.equal(r.rows.length, 400);
  assert.equal(r.truncated, 200);
  // 评审 M-1 的第二半：CIM 不排序，"前 400 个"是任意 400 个，界面要的是内存最大的 400 个。
  // 造一组 ws 递增的：截断后必须留下最大的那些（ws 从 600*1024 往下数 400 个），而不是枚举顺序的前 400。
  const rise = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, n: 'p' + i, ws: (i + 1) * 1024, cpu: 0 }));
  const t = L1B.parseProcLine(JSON.stringify({ t: 6, rows: rise }), { procCount: 8, maxRows: 400 });
  assert.equal(t.rows[0].ws, 600 * 1024, '截断要保留内存最大的一批');
  assert.equal(t.rows.at(-1).ws, 201 * 1024);
  assert.equal(t.truncated, 200);
});

check('ps-7 默认参数与实测一致：sleep 3s，但实际周期 4.37–4.91s ⇒ 心跳基准另算', () => {
  assert.equal(L1B.INTERVAL_SEC, 3);
  assert.equal(L1B.MAX_ROWS, 400);
});

/* 预检裁定：⑤段新增且只新增这一条（台账 Ruling-38）—— createL1b 是 l1b 唯一有副作用的部分，
   而预检实测"喂 Buffer 时每一行都判成非 JSON"，没有门面对象就等于把这条静默断流留在交付里。 */
check('ps-8 l1b 门面：onData 收 Buffer、UTF-8 解码一次、非 JSON 行走 onRows(null, line) 不静默', () => {
  const started = [], stops = [];
  const sup = {
    start: (key, spec) => started.push({ key, spec }),
    stop: (k) => { stops.push(k); return { stopped: true }; },
    state: () => ({ state: 'on' }),
  };
  const got = [];
  const b = L1B.createL1b({ sup, onRows: (parsed, line) => got.push(parsed ? 'rows' : 'noise') });
  b.enable();
  assert.equal(started[0].key, 'l1b');
  assert.deepEqual(started[0].spec.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(started[0].spec.intervalMs, 5000, '心跳按实际周期（sleep 3s + 干活 1.6–1.9s）算，不是 sleep 秒数');
  const feed = (s) => started[0].spec.onData(Buffer.from(s, 'utf8'));
  // 中文进程名过 UTF-8：不加 UTF-8 前置时真机是 GBK 字节（实测 b9a8bdf8），加了才是这里的 UTF-8
  feed(JSON.stringify({ t: 1760000000000, rows: [{ id: 4, n: '龚进.exe', ws: 1024, cpu: 8 }] }));
  assert.deepEqual(got, ['rows']);
  assert.equal(b.latest().rows[0].name, '龚进.exe');
  assert.equal(b.latest().rows[0].cpuPct, 8 / osMod.cpus().length);   // 均摊口径，核数跟随本机而不是写死 8
  feed('Write-Error : 找不到驱动');                                 // 非 JSON 行必须走 (null, line) 分支，不许静默 return
  assert.deepEqual(got, ['rows', 'noise']);
  assert.equal(b.state().state, 'on');
  // 评审 Important-1：残值。源停了或新一轮还没出数时，latest() 不能再把上一轮的 rows 冒充"当前"。
  b.disable();
  assert.deepEqual(stops, ['l1b']);
  assert.equal(b.latest(), null, 'disable 必须清缓存：否则界面拿着已停源的旧进程榜当实时');
  feed(JSON.stringify({ t: 1760000000001, rows: [{ id: 5, n: 'x.exe', ws: 10, cpu: 1 }] }));  // 把缓存重新灌满，好让下一条断言真的承重
  b.enable();
  assert.equal(b.latest(), null, 'enable 之后、首轮到达之前同样不许留旧值');
  // 评审 M-3 的落点（按 Ruling-16 折进本条，不新开 check）：装配漏传 onRows 时，实现里的
  // `onRows?.()` 会把整条进程榜静默吞掉 —— 所以构造入口就要抛，而不是等数据流走空。
  assert.throws(() => L1B.createL1b({ sup }), /onRows/);
  assert.throws(() => L1B.createL1b({ sup, onRows: 1 }), /onRows/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/collect.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/collect/l1b-powershell.js`。

- [ ] **Step 3: 写实现**

```js
/**
 * L1b —— 进程榜。常驻 PowerShell 循环，每轮输出一行 JSON。
 *
 * 实测（三组读数的并集：派单前预检 Ruling-37、实现者一轮、评审一轮；计划期修正 #3 的旧数字已过期）：
 *  - 首行 1777–2246ms（热态连跑），**冷启动单点量到过 3774ms** ⇒ 降级判定按稳态周期，不按单次首行；
 *  - `Start-Sleep 3` + 单轮干活 1.6–1.9s ⇒ **实际周期 4.37–4.91s**，所以心跳基准不能按 3s 算；
 *  - 369–392 进程 / 行 19968–21842 字节、无 BOM（四组读数的并集：预检 / 实现者 / 复审 / 控制器；不是旧记录的 385 / 17.7KB，也别把区间端点当常量用）；
 *  - `taskkill /PID /T /F` 收得掉；stdout 在加 UTF-8 前置后是 UTF-8（不加是 GBK，实测 `b9a8bdf8`），stderr 恒是 GBK。
 * 默认**不开**、由页面可见性驱动（spec §1.2 的结论）。
 */
import os from 'node:os';   // createL1b 里算均摊核数要用（收口那条说的就是它）

export const INTERVAL_SEC = 3;
export const MAX_ROWS = 400;

/**
 * 语句之间**必须用 `;` 分隔**。旧版用 `.join(' ')` 把语句拼成一行，真机读数：
 * `exit=1`、stdout 0 字节、stderr（GBK）"表达式或语句中包含意外的标记"$cores=[Environment]::ProcessorCount""
 * —— 整条采集链路一个字节都不出，而单元测试全绿（测试只正则匹配脚本字符串，不断言 PowerShell 语义）。
 */
export function buildLoopScript({ intervalSec = INTERVAL_SEC, withCpu = true } = {}) {
  // Perf 表提供每进程 CPU 占用（Win32_Process 没有这一列）；关掉时走 withCpu=false 的降级形态
  const cpuMap = withCpu
    ? '$cpu=@{};Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|ForEach-Object{if($null -ne $_.IDProcess){$cpu[[uint32]$_.IDProcess]=$_.PercentProcessorTime}};'
    : '$cpu=@{};';
  return '$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
    + 'while($true){'
    + cpuMap
    // 评审 M-1：这里**不加** `Select-Object -First N`。CIM 不排序，脚本里预裁得到的是"任意 N 个"，
    // 而且解析层的 truncated 会恒为 0（源已被裁平）⇒ 进程数 >400 的机器上内存最大的那批无声消失。
    // 条数上限与截断计数都归 parseProcLine。
    + `$rows=@(Get-CimInstance Win32_Process|ForEach-Object{[pscustomobject]@{id=$_.ProcessId;n=$_.Name;ws=$_.WorkingSetSize;cpu=if($cpu.ContainsKey([uint32]$_.ProcessId)){$cpu[[uint32]$_.ProcessId]}else{$null}}});`
    // 先算 $rows 再单独组装输出：`$?` 是布尔不是那行 JSON，`$rows=@(...), @{...}|ConvertTo-Json` 是把两个对象塞数组过管道
    + '@{t=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();rows=$rows}|ConvertTo-Json -Compress | Write-Output;'
    + `Start-Sleep -Seconds ${intervalSec}}`;
}

export function parseProcLine(text, { procCount = 1, maxRows = Infinity } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null; // PowerShell 的告警与进度文本走这里；调用方负责记一条时间线（spec §4.7）
  }
  if (!obj || !Array.isArray(obj.rows) || !Number.isFinite(Number(obj.t))) return null;
  const cores = Number.isFinite(procCount) && procCount > 0 ? procCount : 1;
  const mapped = obj.rows.map((r) => {
    // 判缺列必须显式认 `null`：真机第一轮 391 行里就有 2 行是 `"cpu":null`（新进程还没进 Perf 表），
    // 而 `Number(null) === 0` —— 不认掉就会把"没测到"折成 0%，Task 9 的 evaluateProc 吃的正是这个键。
    const cell = r?.cpu;
    const raw = cell === null || cell === undefined || cell === '' ? NaN : Number(cell);
    const idRaw = r?.id;
    const idCell = idRaw === null || idRaw === undefined || idRaw === '' ? NaN : Number(idRaw);
    return {
      // 评审 M-2：取不到就是 null。`|| 0` 会把畸形 pid 折成 0，而真机恒有 pid 0 的 System Idle Process
      // （它的 cpuPct 还是 `_Total`/`Idle` 覆盖出来的聚合值）—— 撞在主键上界面就会把缺 pid 的行当 Idle 摆。
      // 复审 Imp-2：判形要**和 cpu 那一列同料**，不能只 `Number(r?.id)` —— `Number(null)` 与 `Number('')` 都是 0，
      // 于是 `"id":null` 的行恰好折进上面那个真 pid 0，正是这条修法要防的事。
      pid: Number.isFinite(idCell) ? idCell : null,
      name: typeof r?.n === 'string' ? r.n : '',
      ws: Number(r?.ws) || 0,
      // PercentProcessorTime 是"所有核合计"口径（可 >100），按核数均摊成单核百分比；缺列为 null 而不是 0
      cpuPct: Number.isFinite(raw) ? raw / cores : null,
    };
  });
  // 评审 M-1：只有**真的超上限**时才排序（按 ws 降序保留最大的一批）。不超上限就不动顺序 ——
  // ps-3 断言的是"原样带出"，界面（Task 21）自己排；这里排序只是为了别让截断丢掉榜尾。
  const overLimit = mapped.length > maxRows;
  const rows = overLimit ? [...mapped].sort((a, b) => b.ws - a.ws).slice(0, maxRows) : mapped;
  return overLimit ? { t: Number(obj.t), rows, truncated: mapped.length - maxRows } : { t: Number(obj.t), rows };
}

/** powershell 的 stdout 解码入口。**不要复用 `decodePd`**（那个是给 typeperf 的 GBK 用的）。 */
export function decodeOut(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return b.toString('utf8');
}

export function createL1b({ sup, onRows, intervalSec = INTERVAL_SEC, maxRows = MAX_ROWS }) {
  // 评审 M-3：装配漏传 onRows 时，下面那两处 `onRows?.()` 会变成 no-op —— 整条进程榜采到了、
  // 解出来了、也存进 latest() 了，但一个订阅者都收不到，且没有任何报错。构造入口就抛。
  if (typeof onRows !== 'function') throw new Error('createL1b 必须传 onRows(parsed, line)，否则进程榜数据全丢且无声');
  let last = null;
  return {
    enable() {
      last = null; // 评审 Important-1：新一轮开始前的旧值不算"当前"
      sup.start('l1b', {
        label: '进程榜（PowerShell 常驻）',
        cmd: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', buildLoopScript({ intervalSec, withCpu: true })],
        // 心跳基准按**实际周期**算，不是 sleep 秒数：实测 `Start-Sleep 3` + 单轮干活 1.6–1.9s ⇒ 4.37–4.91s 一行。
        // 监督者的判定是 `3 × intervalMs` 无数据 ⇒ stalled，取 5000 ⇒ 15s，余量 3 倍多。
        intervalMs: (intervalSec + 2) * 1000,
        onData: (raw) => {
          // Task 5 交付契约：`raw` 是 Buffer 完整行。直接把它交给 parseProcLine 会命中
          // `typeof text !== 'string'` ⇒ **每一行**都判成"非 JSON"，进程榜永远空且不报错。
          const line = decodeOut(raw);
          const parsed = parseProcLine(line, { procCount: os.cpus().length, maxRows });
          if (!parsed) { onRows(null, line); return; }
          last = parsed;
          onRows(parsed, line);
        },
      });
    },
    disable() {
      last = null; // 评审 Important-1：源已停，界面拿上一轮残值画"实时进程榜"是最坏的一种静默
      return sup.stop('l1b');
    },
    state: () => sup.state('l1b'),
    latest: () => last,
  };
}
```

实现时的四处收口（写完立刻处理，否则 Step 4/5 必红）：
- ~~`Write-Output $?` 是错的~~ —— 上面那版已经改对了，但**别改回去**：`$?` 是布尔；`$rows=@(...), @{...}|ConvertTo-Json` 是把两个对象塞进数组再过管道。测试只正则匹配脚本字符串、不断言 PowerShell 语义，所以**必须靠 Step 5 的真机跑**兜：真机原样跑旧版读数 `exit=1 / stdout 0 字节`。
- `createL1b` 用了 `os.cpus()`，文件顶部要 `import os from 'node:os';`。
- 别在 `parseProcLine` 里"顺手"过滤 `pid===0` 或 `System Idle Process`：真机 `Win32_PerfFormattedData_PerfProc_Process` 里 `IDProcess=0` 有**两个**实例（`_Total` 与 `Idle`，哈希表后写覆盖先写），所以 pid 0 那行的 cpu 是聚合值（实测 1442–1560，均摊后每轮 93–98%）。这不是采集层的判断，界面/告警侧（Task 9 / Task 21）才决定怎么摆它 —— 采集层只负责如实带出来并在注释里写明这条不可信读数。
- `buildLoopScript` 的参数表里**没有** `maxRows` 了（裁条数移到解析层）；既有测试 ps-1/ps-2 里那两处 `maxRows: 400` 是多余的键，一并删掉，别留着误导后来人以为脚本会裁。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/collect.test.mjs`
Expected: `38/38 通过`（①4 ②5 ③11 ④10 ⑤8），退出码 0。旁路 `node test/guard.test.mjs` = `19/19`、`node test/prefs.test.mjs` = `13/13` 不得破。

- [ ] **Step 4b: 变异自查（断言强度取证）**

`cp` 备份实现 → 每次只改一个变量 → 跑 → `cp` 还原 → `cmp` 校字节，读数原样抄进报告：
1. 把 `buildLoopScript` 的 `;` 分隔改回空格拼接（还原成预检失败的那一版形状）→ **ps-1 必须红**（`/::UTF8;/`）。
2. 把 `parseProcLine` 的缺列判定改回 `const raw = Number(r?.cpu);` → **ps-4 必须红**（只红第二条 `cpu: null` 断言；第一条"整个键不存在"仍会绿，因为 `Number(undefined)` 是 NaN）。
3. 把 `onData` 里的 `decodeOut(raw)` 换成 `raw` 直接往下传 → **ps-8 必须红**（`typeof text !== 'string'` 命中，真 JSON 被判成 noise —— 这正是预检抓到的缺陷）。
4. 把 `intervalMs` 改回 `(intervalSec + 1) * 1000` → **ps-8 必须红**。
5. 把非 JSON 行改成 `if (!parsed) return;`（静默丢弃）→ **ps-8 必须红**（`got` 少一项）。
   （预检踩过的坑：这一条的 perl 匹配式要写成 `onRows\?\.\(null, line\)` —— 源码里是可选链 `onRows?.`，漏了 `?` 会**一字都没改**却报"7/8 通过"，是空变异。每轮变异前先 `diff` 一下确认字节真的动了。）
五条都咬红才算过；某条不红就是断言没承重，先补断言再往下走。预检实测读数：变异 1 → ps-1 红；变异 2 → ps-4 红；变异 3/4/5 → ps-8 红（各 7/8）。

**fix round 1 追加五条落点（评审 M-1 / M-2 / M-3 / Important-1）。控制器已在仓库外把它们拆成六处改动逐个变异跑过（编号 1–6，对应下面 6–10 的六个改动点）：基线 38/38，1→ps-1、2→ps-4、3→ps-6、4/5/6→ps-8，每次 `37/38`，还原 `cmp` 字节一致：**
6. 在脚本里把 `Select-Object -First 400` 加回去（`Get-CimInstance Win32_Process|Select-Object -First 400|ForEach-Object`）→ **ps-1 必须红**（`doesNotMatch /Select-Object\s+-First/`）。
7. `pid: Number.isFinite(id) ? id : null` 改回 `pid: Number(r?.id) || 0` → **ps-3 必须红**（畸形 id 那两条：`pid` 变 0）。
8. 截断分支的排序摘掉：`overLimit ? mapped.slice(0, maxRows) : mapped` → **ps-6 必须红**（`rows[0].ws` 不再是最大的那条）。
9. 残值清理任一处摘掉：`enable()` 里的 `last = null` 或 `disable()` 里的 `last = null` 改成 `void 0` → **ps-8 必须红**（对应那一条 `latest() === null`）。
10. 构造守卫摘掉（删掉 `if (typeof onRows !== 'function') throw …`）→ **ps-8 必须红**（两条 `assert.throws` 都不抛了）。
   注意 9 和 10 都落在 ps-8：这正常 —— ps-8 是唯一碰门面副作用的一条，别为了"每个变异红不同用例"去拆用例。

- [ ] **Step 5: 真机端到端（含 CPU 列的代价判定）**

写成临时文件 `tmp/e2e-l1b.mjs` 再跑（**不要用 `node -e "…"`**：本机 bash 的双引号会吃掉反斜杠，预检就是这么误判过一次"计数器名不存在"），跑完删除：

```js
import { createSupervisor } from '../lib/collect/supervisor.js';
import { createL1b, buildLoopScript } from '../lib/collect/l1b-powershell.js';

console.log('script len', buildLoopScript({}).length);
const sup = createSupervisor({});
const rows = [], t0 = Date.now();
const a = createL1b({ sup, onRows: (p) => {
  if (p) rows.push({ n: p.rows.length, first: Date.now() - t0, truncated: p.truncated ?? 0, cpuNull: p.rows.filter((r) => r.cpuPct === null).length, top: p.rows.slice(0, 3).map((r) => [r.name, r.cpuPct]) });
  else rows.push('非JSON行');
} });
a.enable();
setTimeout(async () => {
  console.log('轮数', rows.length);
  console.log(rows);
  console.log('state', a.state().state, 'detail', a.state().detail);
  await a.disable();
  sup.dispose();
}, 20000);
```

Run: `node tmp/e2e-l1b.mjs`
Expected 与决策规则（预检实测已把这些数字钉死，记进汇报，不要含糊过去）：
- `script len` 应为 **574**（去掉 `-First` 后从 599 缩短；仍打印 `含 -First？ false`）。
- 20s 内 **轮数 ≥ 4**（实测周期 4.37–4.91s ⇒ 20s 应有 4 轮），每轮 `n` 在 300~420、首行 `first` 在 **1800–2300ms**、`truncated` 本机恒为 **0**（本机 369–392 进程 < 400；若这里出现 >0 说明裁条数被挪回了脚本或 `MAX_ROWS` 被改小）。
- **降级判定按稳态周期，不按单次冷启动首行**（控制器裁定，台账 Ruling-41）：实现者一轮冷启动量到过 3774ms 首行，但同机热态复跑 2090/2108/1798ms、评审两轮 1872/1777ms ⇒ 单点冷启动不构成降级理由。**只有稳态周期 > `intervalSec + 2`（即 5s）连续两轮**才把 `enable()` 里的 `withCpu` 改为 `false`，并在界面进程榜卡片上写「CPU 列在本机实测使单轮耗时 X ms（预算 Y ms），已降级为仅内存列」，同时把告警规则 `procCpu` 置为依赖不满足（Task 9 的 `dependencyGated` 会用到）。开/关 CPU 列的实测差值 ≈1.0s/轮（4.37–4.75s vs 3.4–3.7s），仍在 5s 预算内。
- `cpuNull` 允许 > 0（真机第一轮实测 2 行），但必须是 `null` 而不是 0 —— 若这里出现 `cpuPct === 0` 且原值是 `null`，Step 4b 变异 2 一定没跑到位。
- 若轮数 < 4 或首行 > 3000ms（说明 `Win32_PerfFormattedData_PerfProc_Process` 那一趟把单轮拖长了）：把 `enable()` 里的 `withCpu` 改为 `false`，并在界面进程榜卡片上写「CPU 列在本机实测使单轮耗时 X ms（预算 Y ms），已降级为仅内存列」，同时把告警规则 `procCpu` 置为依赖不满足（Task 9 的 `dependencyGated` 会用到）。
- 若 `rows` 里出现 `'非JSON行'`：确认它来自哪一行并让它进时间线（Task 8 的 `onRows(null, line)` 分支），**不要**改成 `if(!parsed) return;` 静默丢弃。
- 顺手记 `a.state().detail`：powershell 的 **stderr 是 GBK**（预检实测原文"表达式或语句中包含意外的标记"在 latin1 视角下是乱码），Task 8 要把 `stderrTail` 给界面看时必须自己决定解码口径，别在这里改监督者。

提交信息草稿：`feat(sysops): L1b 进程榜常驻采集`

---

## Task 8: `lib/collect/service.js` —— 分层编排 + 档位 + 可见性驱动

**Files:**
- Create: `lib/collect/service.js`
- Modify: `test/collect.test.mjs`（追加 ⑥段）

**Interfaces:**
- Consumes: `createRing`（4）、`createL0`（4）、`createSupervisor`（5）、`createL1a`（6）、`createL1b`（7）、`PREF_KEYS`/`COLLECT_CADENCE`/`SOURCE_KEYS`（3）
- Produces:
  - `createCollectService({ getPrefs, logger, now, getIntervalFn, makeSupervisor, makeL0, makeL1a, makeL1b, osMod })` → 
    `{ start(), stop(), setCadence(v), setSource(key, on), setVisible(v), snapshot(), sourceRows(), procRows(), onEvent(cb) → unsub, dispose() }`
  - `snapshot() → { cadence, keepMinutes, timerBackend, series: {cpu, mem, diskFreePct, netDown, netUp}, latest: {cpu, mem, diskFreeGb, diskTotalGb, netDown, netUp, t}, sources: [row], proc: {rows, state, note, t}, dropped: {stale, bad} }`。**`proc.t` 是 Task 7 §Produces 点名要透传的字段**（PowerShell 侧那一轮的 UTC ms，界面/告警用它算新鲜度）：成功解析一轮才写，其余时刻为 `null` —— 不写它，Task 7 的 I-1 修法（`latest()` 只交当前轮）在编排层就没有落点。`timerBackend` 的取值是 `'ctx.interval' | 'setInterval' | null`，**没挂表的时候是 `null`**（暂停 / dispose / 从未 start），界面按 null 显示"未运行"，不许报一个没发生过的后端。`proc.rows` 与 `procRows()` 返回的是**服务内部数组本体**（不复制，一轮 ~380 行不便宜）：调用方要排序/截取必须先 `slice()` —— 走 HTTP/SSE 出去的本来就是序列化副本，只有服务端内部调用（Task 18/21）需要守这条，原地 `sort()` 会改到服务状态。
  - `sourceRow = { key, label, state: 'on'|'off'|'starting'|'stalled'|'crashed'|'exited-max'|'unavailable', detail, restarts, pid, stderrTail }`
  - `onEvent` 的事件：`{type:'metrics', key, point}` / `{type:'sources', rows}` / `{type:'proc', rows, note, t}`。**`proc` 事件带全三件**（与 Step 3 的残值契约同口径：停采时推 `{rows:[], note:'', t:null}`）—— 原先这里只写 `rows`，与 Step 3 自相矛盾（评审 M-5）；Task 18 序列化成 SSE 时按这一行写文档，别拿窄口径当契约。

- [ ] **Step 1: 写失败的测试（假采样器 + 假时钟 + 假 supervisor）**

```js
/* ⑥段：collect service 编排 */
const { createCollectService } = await import('../lib/collect/service.js');

function fakeWorld(over = {}) {
  let t = 0;
  const timers = [];
  const events = [];
  const started = [];
  const stopped = [];
  const l0Reads = [];
  const caps = {};                    // 服务传给工厂的出口（onPoint / onRows）落在这里，用例才有东西可断
  const warns = [];                   // logger.warn 的落点：svc-8 要断"rejection 被就地接住且留了痕"，空桩就看不见
  let coreCount = over.cores ?? 8;    // svc-1 要在跑的过程中改核数（热插拔基线复位那条契约）
  let resetCount = 0;
  // 宿主文档口径：`ctx.interval(fn, ms)` 返回的是 **disposer 函数**
  // （`dsh-plugin-stock-analysis/docs/host-capabilities.md:244-251`；参照实现
  // `dsh-plugin-stock-analysis/lib/monitor/service.js:393` 也是把返回值直接当停止函数存成 `stopFn`）。
  // 原样桩返回的是可变句柄对象、服务靠 `h.done = true` 停 —— 那等于往函数对象上挂一个没人读的
  // property：真宿主的定时器照敲，暂停/切档/dispose 全都停不下来。桩改成
  // 「返回 disposer，disposer 被调用才置 done」，"服务有没有真的调用 disposer" 才是用例能断的事实
  // （Task 8 评审变异 C7：摘掉停止调用，原样 48 条照样全绿）。
  const intervalFn = (fn, ms) => { const h = { fn, ms, done: false }; timers.push(h); return () => { h.done = true; }; };
  // svc-7 走的是 `globalThis.setInterval` 回退分支。**不打桩真的话，`w.timers` 恒是空数组**
  // —— 预检变异取证：把实现里的 `globalThis.clearInterval(l0Handle.h)` 整行删掉，原样用例仍 PASS（空断言）。
  const realSI = globalThis.setInterval, realCI = globalThis.clearInterval;
  const si = [];
  if (over.noTimer) {
    globalThis.setInterval = (fn, ms) => { const h = { fn, ms, live: true }; si.push(h); return h; };
    globalThis.clearInterval = (h) => { if (h && 'live' in h) h.live = false; };
  }
  const sup = {
    start: (key, spec) => { started.push(key); return { key, state: 'starting', restarts: 0, detail: '' }; },
    stop: async (key) => { stopped.push(key); return null; },
    state: (key) => ({ key, state: over.supState ?? 'on', restarts: 0, pid: 1, lastTick: 0, stderrTail: '', detail: '' }),
    status: () => over.supStatus ?? [],
    tick: () => {},
    // 标志必须挂在**桩对象自己**上。原先写 `over.supDisposed = true`，而 `over` 没暴露给用例，
    // svc-8 的 `w.sup.supDisposed` 就永远取不到 —— 探针实测是硬失败（`undefined`），不是空断言。
    supDisposed: false,
    dispose() { this.supDisposed = true; },
  };
  const svc = createCollectService({
    getPrefs: () => over.prefs ?? { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: false } },
    // warns 落盘：svc-8 要断"dispose 里 disable 的 rejection 被就地接住**且留了痕**"，空桩看不见接住动作。
    logger: { warn: (...a) => { warns.push(a.map((x) => String(x?.message ?? x)).join(' ')); }, info() {} },
    now: () => t,
    getIntervalFn: () => (over.noTimer ? null : intervalFn),
    osMod: { cpus: () => Array.from({ length: coreCount }, () => 0) },
    makeSupervisor: () => sup,
    makeL0: () => ({
      // cpu 必须**始终落在 0~100**：percent ring 见到 >100 判 bad 直接丢（真实现也是如此）。
      // 预检取证：原样写 `cpu: 10 + i` 时第 91 拍起全是 bad，svc-6 的点数上限断言永远填不满，
      // 于是那条断言只在数一个早就被丢弃的环 —— 断的是替身的形状，不是服务的行为。
      read: () => { const i = l0Reads.length; l0Reads.push(1); return over.l0?.(i) ?? { t, cpu: 10 + (i % 80), mem: 50, diskFree: 70 * 2 ** 30, diskTotal: 200 * 2 ** 30 }; },
      reset: () => { l0Reads.length = 0; resetCount += 1; },
    }),
    makeL1a: ({ sup: s, onPoint }) => { caps.onPoint = onPoint; return { enable: () => s.start('l1a'), disable: () => s.stop('l1a'), state: () => sup.state('l1a') }; },
    makeL1b: ({ sup: s, onRows }) => { caps.onRows = onRows; return { enable: () => s.start('l1b'), disable: () => s.stop('l1b'), state: () => sup.state('l1b'), latest: () => over.procRows ?? null }; },
  });
  svc.onEvent((e) => events.push(e));
  // fire 是"重复敲同一个活着定时器"，不是"消耗一个定时器"：`h.done` 只由服务在 clearL0 时置。
  // 预检取证：原样 `h.done = true; h.fn();` 时 svc-6 的 400 次循环实际只跑了一拍（第 2 次起 find 不到句柄），
  // 而把 windowMs/maxPoints 改成 1e12/1e9 那条仍 PASS —— 断言完全空转。
  return { svc, caps, si, warns, t: () => t, clock: () => t, reads: () => l0Reads.length, resets: () => resetCount, setCores: (n) => { coreCount = n; },
    adv: (ms) => { t += ms; }, events, started, stopped, timers, sup,
    fire: (n = 1) => { const h = timers.find((x) => !x.done); if (!h) return; for (let i = 0; i < n; i++) h.fn(); },
    restore: () => { globalThis.setInterval = realSI; globalThis.clearInterval = realCI; } };
}

check('svc-1 start 后 L0 按档位跑，L1a/L1b 的出口被接上且点真的进环并 emit metrics', () => {
  const w = fakeWorld();
  w.svc.start();
  assert.ok(w.started.includes('l1a'), 'l1a 默认开（实测 <1% 代价），应被 start');
  assert.equal(w.svc.snapshot().cadence, '1s');
  // 这两条是预检补的：原用例断一个 `type==='l1a-enable'` 的事件，而 `fakeWorld` 里**没有任何代码会 emit 它**
  // —— 工厂收到的 `onPoint` 被塞进返回对象当属性，`events` 又没暴露给工厂，所以那条断言是硬失败（不是空断言，是根本不可能成立）。
  // 换成真口径：断服务确实把出口函数传给了工厂，再手工灌一个点，验它落进对应的 ring 并推了事件。
  assert.equal(typeof w.caps.onPoint, 'function', '服务必须把 onPoint 传给 createL1a');
  assert.equal(typeof w.caps.onRows, 'function', '服务必须把 onRows 传给 createL1b（Task 7 已定为不传就抛，漏接=静默吞榜）');
  w.adv(1000); w.fire();                       // 先敲一拍 L0，让假时钟走到 1000（ring 只收严格递增的 t）
  const before = w.events.length;
  w.caps.onPoint({ metric: 'netDown', t: w.clock(), v: 2 * 1024 * 1024 });
  const s = w.svc.snapshot();
  assert.equal(s.series.netDown.at(-1).v, 2 * 1024 * 1024, 'L1a 的点必须落进 netDown ring（字节/秒原值，不做 /8）');
  assert.equal(s.latest.netDown, 2 * 1024 * 1024, 'latest.netDown 与 ring 同口径，界面自己换算 MB/s');
  assert.equal(w.events.length, before + 1, '写点成功必须 emit');
  assert.equal(w.events.at(-1).type, 'metrics');
  assert.equal(w.events.at(-1).key, 'netDown');
  // 非 JSON 行不许静默（Task 7 下游契约）：走 (null, line) 分支必须在 snapshot 里留痕
  w.caps.onRows(null, 'Write-Error : 表达式或语句中包含意外的标记');
  assert.notEqual(w.svc.snapshot().proc.note, '', '非 JSON 行要留下可见的因由，不能只丢');
  // 非 JSON 轮**没有**可信的轮次时间戳：`proc.t` 只在解析成功时写。界面按 `proc.t` 判新鲜度，
  // 把它折成 0 或留着上一轮的值都会让"多久没出数"这个数算错。
  assert.equal(w.svc.snapshot().proc.t, null, '整轮非 JSON 时 proc.t 必须是 null，不是 0 也不是残值');
  // 台账 Task 5 下游契约②：核数变了要复位 cpu 基线，否则 `computeCpuPct` 在两次样本核数不等时返回 NaN
  // ⇒ 曲线**成片**丢点（每拍都丢）。两条一起断，才挡住"每拍都 reset"这个反向的错。
  const r0 = w.resets();
  w.adv(1000); w.fire();
  assert.equal(w.resets(), r0, '核数没变不许复位');
  w.setCores(4);
  w.adv(1000); w.fire();
  assert.equal(w.resets(), r0 + 1, '核数变化必须调 l0.reset()');
  // sources 只在**内容变了**时推（Task 18 的 SSE 靠这条减负，否则 1s 推一屏同样的三行）。
  // 到这里 l0 的档位/窗口、l1a/l1b 的 supervisor 状态全程没变过 ⇒ 除了 start() 那一屏，一条都不许多推。
  // 评审变异 C8：摘掉 `refreshSources()` 的去重提前 return，48 条全绿 —— 这个承诺原先无人承重。
  assert.equal(w.events.filter((e) => e.type === 'sources').length, 1,
    `状态没变时每拍 refreshSources 不许重复推 sources（实得 ${w.events.filter((e) => e.type === 'sources').length} 屏，只有 start 该推 1 屏）`);
});

check('svc-2 档位切 5s / 暂停：源状态与 cadence 同步变，并 emit sources', () => {
  const w = fakeWorld();
  w.svc.start();
  w.svc.setCadence('5s');
  assert.equal(w.svc.snapshot().cadence, '5s');
  // 切档时旧定时器必须被**停掉**，不是只在服务这边换个引用：宿主句柄是 disposer 函数
  // （`docs/host-capabilities.md:244`），不调它就没有任何动作发生 ⇒ 新旧两拍一起敲。
  assert.ok(w.timers[0].done, 'setCadence 必须调用宿主句柄的 disposer，否则旧定时器还在敲（会出现双档并跑）');
  w.svc.setCadence('暂停');
  const s = w.svc.snapshot();
  assert.equal(s.cadence, '暂停');
  assert.equal(s.sources.find((r) => r.key === 'l0').state, 'off');
  assert.equal(s.timerBackend, null, '暂停=没挂任何表，不许继续报上一个后端（参照实现 stop() 就把它置回 null）');
  assert.ok(w.events.some((e) => e.type === 'sources'), '切档必须有 sources 事件（界面要立刻改文案）');
  assert.throws(() => w.svc.setCadence('2s'), /cadence/);
});

check('svc-3 脏点不写 ring，只进 dropped 计数（一个假点会被读成真实尖峰）', () => {
  const w = fakeWorld({ l0: (i) => (i === 1 ? { t: 0, cpu: NaN, mem: 50, diskFree: 1, diskTotal: 2 } : undefined) });
  w.svc.start();
  const before = w.svc.snapshot().dropped.bad;
  // 手工推两拍：第一拍正常、第二拍 cpu 是 NaN
  w.fire(2);
  // **必须 `+ 1` 而不是 `>= before`**：原样写 `>=` 时 `before` 是 0，断言永真，
  // 预检变异取证 —— 把实现里的 `droppedBad` 计数整段删掉，原样用例照样 PASS（空断言）。
  assert.equal(w.svc.snapshot().dropped.bad, before + 1, 'NaN 点必须计数一次，且只计那一个指标');
  assert.ok(w.svc.snapshot().series.cpu.length <= 1, '脏点不许写进 cpu ring');
});

await checkAsync('svc-4 L1b 默认关；只有「开 + 页面可见」才启动，不可见时停采并清残值', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s' }, sources: { l0: true, l1a: true, l1b: true } } });
  w.svc.start();
  assert.ok(!w.started.includes('l1b'), '默认不可见时不起 L1b（实测单轮 1.6–1.9s 的代价不能白付）');
  await w.svc.setVisible(true);
  assert.ok(w.started.includes('l1b'), '可见 + 开关为真 才起');
  // Task 7 的 I-1 在编排层的镜像：`latest()` 现在 disable 就返 null，服务侧的 proc.rows 也必须跟着清，
  // 否则界面拿着"已停源的上一轮进程榜"画实时卡片 —— 这是最坏的一种静默。
  w.caps.onRows({ t: 5, rows: [{ pid: 1, name: 'a.exe', ws: 1024, cpuPct: 1 }] });
  assert.equal(w.svc.snapshot().proc.rows.length, 1);
  assert.equal(w.svc.snapshot().proc.t, 5, '成功轮的 t 必须透到 snapshot().proc.t（Task 7 §Produces 点名的字段）');
  await w.svc.setVisible(false);
  assert.ok(w.stopped.includes('l1b'), '页面切走要停采');
  assert.deepEqual(w.svc.snapshot().proc.rows, [], '停采必须清进程榜残值');
  assert.equal(w.svc.snapshot().proc.t, null, '残值清理要连 t 一起清，否则界面拿到"带新鲜时间戳的空榜"或反过来');
  assert.ok(w.events.some((e) => e.type === 'proc' && e.rows.length === 0), '清空也要推 proc 事件，否则 SSE 侧留着旧榜');
});

await checkAsync('svc-5 supervisor 终态原样透传进 sources，且 L1a 不随页面可见性停采', async () => {
  const w = fakeWorld({ supState: 'exited-max' });
  w.svc.start();
  await w.svc.setVisible(true);
  const row = w.svc.snapshot().sources.find((r) => r.key === 'l1a');
  assert.equal(row.state, 'exited-max', 'supervisor 的终态要原样透传，界面按四类分支给文案');
  // 用例标题原本写"网络计数器名缺失时 state 为 unavailable"，但体内断的是 exited-max，
  // 而 `unavailable` 这个态在本文件里从来没有实现会置它（Task 6 的 l1a 只经 supervisor 置态）——
  // 标题改成断言的真实口径。计数器名缺失的真机文案归 Task 21（台账：typeperf 以 exit=4026531842 退出且错误走 stdout）。
  await w.svc.setVisible(false);
  assert.ok(!w.stopped.includes('l1a'), 'L1a 成本实测 <1%，不随可见性起停（只有 L1b 受闸门）');
  assert.ok(w.stopped.includes('l1b'), '同一动作里 L1b 必须被停');
});

check('svc-6 snapshot 的点位数上限 = keepMinutes×60+1（1s 档，含边界一拍）', () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 5 } } });
  w.svc.start();
  for (let i = 0; i < 400; i++) { w.adv(1000); w.fire(); }
  assert.ok(w.reads() >= 400, `400 次 fire 必须真的采了 400 拍（读到 ${w.reads()} 次）—— 这条钉住 fire() 是"重复敲同一个活着的定时器"，不是消耗句柄`);
  const s = w.svc.snapshot();
  // **断精确值而不是 `<= 301`**：`<=` 在 windowMs/maxPoints 被改成天文数字时照样绿（预检变异取证：
  // 把 ring 的 windowMs 改 1e12、maxPoints 改 1e9，原样用例仍 PASS —— 因为 fire() 只跑了一拍，环里只有 1 个点）。
  // 5min 窗 + `maxPoints = keepMinutes*60 + 1` ⇒ 400 拍里只剩最后 301 个（窗底含边界保留）。
  assert.equal(s.series.cpu.length, 301, `5min 窗 @1s 上限 301，实得 ${s.series.cpu.length}`);
  assert.equal(s.keepMinutes, 5);
});

check('svc-7 宿主无 timer 时退 setInterval，并在 snapshot.timerBackend 如实标', () => {
  const w = fakeWorld({ noTimer: true });
  w.svc.start();
  assert.equal(w.svc.snapshot().timerBackend, 'setInterval');
  assert.equal(w.si.length, 1, `回退分支必须真的挂上一个 setInterval（实得 ${w.si.length} 个）`);
  assert.equal(w.timers.length, 0, '宿主给了 null 就不许再走 ctx.interval 那条路');
  w.svc.dispose();
  // 原来这条断 `w.timers.every(...)`，但 noTimer 分支下 `timers` 恒是空数组，`.every()` 真空通过
  // —— 预检变异取证：删掉实现里的 `globalThis.clearInterval(l0Handle.h)`，原样用例照样 PASS。
  // 现在打桩真的 setInterval/clearInterval（fakeWorld 里装、本条末尾还原），断**那个句柄**被置死。
  assert.ok(w.si.every((h) => h.live === false), '退 setInterval 必须显式 clearInterval，否则留野定时器');
  w.restore();
});

await checkAsync('svc-8 dispose：停 L0 定时器、停所有子进程、清 ring；重复调用不抛', async () => {
  // l1b 开关这里**必须为真**：残值/闸门那几条断的是"迟到的 setVisible 会把 l1b 复活"，
  // 而 setVisible 只在「开关 + 可见」两个条件都成立时才动 l1b —— 用默认 prefs（l1b:false）
  // 的话那条闸门删掉也没人看得见（fix round 变异取证：C10b 摘掉 setVisible 闸门照样 48/48 全绿）。
  // start() 时 visible 仍是 false，所以 l1b 并没有被起，`started` 的增量仍然只归 dispose 后的复活路径。
  const w = fakeWorld({ prefs: { collect: { cadence: '1s', keepMinutes: 30 }, sources: { l0: true, l1a: true, l1b: true } } });
  w.svc.start();
  w.adv(1000); w.fire();
  assert.ok(w.svc.snapshot().series.cpu.length >= 1, '前置条件：ring 里得先有点，否则下面"清 ring"那条是空的');
  w.svc.dispose();
  w.svc.dispose();
  assert.ok(w.stopped.includes('l1a'));
  assert.ok(w.sup.supDisposed, 'supervisor 要 dispose');
  assert.equal(w.svc.snapshot().series.cpu.length, 0, 'dispose 要清 ring（标题主张，原来没有断言承重）');
  assert.deepEqual(w.svc.snapshot().proc.rows, [], 'dispose 也要清进程榜');
  // 真机串跑实测：dispose 后 sources 是 `l0:on,l1a:off,l1b:off` —— l0 那行按「开关+档位」算，
  // 而 dispose 只清了定时器。这一条把它钉成 off，否则界面/日志会以为主进程还在采样。
  const l0row = w.svc.snapshot().sources.find((r) => r.key === 'l0');
  assert.equal(l0row.state, 'off', 'dispose 后 l0 行不许再报 on');
  assert.match(l0row.detail, /dispose/, 'detail 要说清是 dispose 停的，不是用户把档位调成暂停');
  // dispose 走的是 push 通道那半：Task 18 的 SSE 只按事件更新采集源条、不轮询 snapshot，
  // dispose 不补推一屏，订阅者手里的 l0 行就永远停在 on —— 正是上面那条 off 想拦的假陈述，只是换了通道。
  const lastSrc = w.events.filter((e) => e.type === 'sources').at(-1);
  assert.equal(lastSrc?.rows?.find((r) => r.key === 'l0')?.state, 'off',
    'dispose 末尾必须 refreshSources()：事件通道的终态也要是 off');
  assert.ok(w.timers.every((h) => h.done), 'dispose 必须调用宿主句柄的 disposer（不调就停不下来）');
  assert.equal(w.svc.snapshot().timerBackend, null, 'dispose 后不许继续报上一个定时器后端');
  // dispose 会重建 ring、清进程榜，磁盘那两格取自 lastSample 而不是 ring ⇒ 不清就是"半新半旧"的快照
  assert.equal(w.svc.snapshot().latest.diskFreeGb, null, 'dispose 后 latest.diskFreeGb 不许留旧账（与"不报旧账"一致）');
  assert.equal(w.svc.snapshot().latest.diskTotalGb, null, '同上，diskTotalGb 也是 lastSample 的残值');
  // dispose 之后一条**迟到的** visibility POST / 开关写入（页面切换与卸载竞态，Task 18 完全可能送慢一拍）
  // 会把已 dispose 的服务背后的子进程再拉起来：界面说服务已死、系统里却多一个活的采集进程。
  const startedN = w.started.length;
  await w.svc.setVisible(true);
  await w.svc.setSource('l1a', true);
  w.svc.setCadence('5s');
  assert.equal(w.started.length, startedN, 'dispose 后 setVisible/setSource 不许复活子进程');
  assert.equal(w.timers.length, 1, 'dispose 后 setCadence 不许重挂定时器（重挂了 l0 行仍报 off，就是自相矛盾）');
  // dispose 里 `disable()` 的 rejection 必须**就地接住**：裸 `try { l1a.disable() } catch` 抓不到 promise
  // 拒绝，而 Node ≥15 默认 `--unhandled-rejections=throw` 会直接**打死宿主进程** —— Task 19 就是把 dispose
  // 挂在插件卸载钩子上。默认桩的 `stop` 永不 reject，所以摘掉 `.catch` 也全绿（fix round 变异 C11 取证），
  // 这里现场换一个会 reject 的 `sup.stop` 再 dispose 一拍。装探针这件事本身也让 Node 不再当场杀进程，
  // 于是断言看得见"有没有被甩出来"，而不是整轮测试直接崩。
  const thrown = [];
  const probe = (reason) => thrown.push(reason);
  process.on('unhandledRejection', probe);
  w.sup.stop = async () => { throw new Error('模拟杀进程失败'); };
  w.svc.dispose();
  await new Promise((r) => setTimeout(r, 0));   // rejection 在微任务检查点上报，必须让出一拍才收得到
  process.off('unhandledRejection', probe);
  assert.deepEqual(thrown.map((e) => String(e?.message ?? e)), [],
    `dispose 不许把 disable 的 rejection 甩给宿主（甩出来 ${thrown.length} 条）`);
  assert.ok(w.warns.some((m) => /dispose 停 l1a 抛错/.test(m)) && w.warns.some((m) => /dispose 停 l1b 抛错/.test(m)),
    `接住的两条都要留痕，实得 warn：${JSON.stringify(w.warns)}`);
});

await checkAsync('svc-9 setSource(key,on) 改开关会立即起/停对应源', async () => {
  const w = fakeWorld({ prefs: { collect: { cadence: '1s' }, sources: { l0: true, l1a: false, l1b: false } } });
  w.svc.start();
  assert.ok(!w.started.includes('l1a'), '配置里 l1a=false 就不该起');
  await w.svc.setSource('l1a', true);
  assert.ok(w.started.includes('l1a'));
  await w.svc.setSource('l1a', false);
  assert.ok(w.stopped.includes('l1a'));
});

check('svc-10 diskFreePct 序列 = 可用/总容量，单位与 diskFreeGb 分两处口径不混用', () => {
  const w = fakeWorld();
  w.svc.start();
  w.adv(1000); w.fire();
  const s = w.svc.snapshot();
  assert.equal(Math.round(s.latest.diskFreeGb * 10) / 10, 70);
  assert.equal(Math.round(s.latest.diskTotalGb * 10) / 10, 200);
  assert.equal(Math.round(s.series.diskFreePct.at(-1).v * 10) / 10, 35);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/collect.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/collect/service.js`。

- [ ] **Step 3: 写实现**

关键约定（实现要照这几条，不要自由发挥）：

```js
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
```

- 内部状态：`const rings = { cpu: createRing({percent:true}), mem: ..., diskFreePct: ..., netDown: createRing({}), netUp: ... }`。`diskFreePct` 由 L0 的字节换算：`(diskFree / diskTotal) * 100`；字节原值另存在 `latest`（不进 ring）。
- `netDown/netUp` 由 L1a 的 `onPoint({metric,t,v})` 写入对应 ring，`v` 是**字节/秒**；界面换算 MB/s = `v / 1e6`（原型里的 `/8` 是按 bit 演示的假数据，Task 21 统一改文案）。
- L0 定时：`intervalFn ?? setInterval` 二选一，`setCadence` 与 `dispose` 都要显式清；`timerBackend` 取 `'ctx.interval' | 'setInterval' | null` 并如实进 snapshot。
  - **宿主句柄形状（Task 8 评审 M-1 的实底，别照字面往句柄上挂属性）**：`ctx.interval(cb, ms)` 返回的是 **disposer 函数**（依据：同宿主参照实现 `dsh-plugin-stock-analysis/lib/monitor/service.js:393` 把返回值存成 `stopFn`、`stop()` 里 `stopFn()`；文档 `dsh-plugin-stock-analysis/docs/host-capabilities.md:244-251` 写明「返回 disposer」）。所以 `armL0()` 要归一化成一个停止函数存着：
    ```js
    // 存 stop 而不是存宿主返回值：清表这个动作必须真的发生一次，
    // 而不是往一个函数对象上挂没人读的 property（那样暂停/切档/dispose 全都停不下来）。
    const h = intervalFn(() => tickL0(), ms);
    const stop = typeof h === 'function' ? h : (h && typeof h.dispose === 'function' ? () => h.dispose() : null);
    if (!stop) logger.warn('[collect] 宿主 ctx.interval 没返回可停的句柄（要 disposer 函数或 .dispose()），本档定时器不受本服务控制');
    l0Handle = { kind: 'ctx', stop };
    ```
    `clearL0()` 的 ctx 分支就是 `l0Handle.stop?.()`。**不许**写 `l0Handle.h.done = true`。退路分支不变（`globalThis.clearInterval(h)`，svc-7 已断）。
  - `timerBackend` 初值是 `null`，`clearL0()` 里也置回 `null` —— 没挂表的时候报一个没发生过的后端就是假陈述（参照实现 `monitor/service.js:416` 同款）。svc-2（暂停档）与 svc-8（dispose 后）各断一条。
- 采样节拍表：`CADENCE_MS = { '1s': 1000, '5s': 5000 }`，`'暂停'` 不在表内 → 停定时器。`COLLECT_CADENCE` 的中文"暂停"是界面文案，服务内部用 `'paused'`，**两者之间要有 `cadenceToKey()` / `cadenceToLabel()` 一对换算**（spec §1.1 决策 7 的档位语义与 §3.2 的存储值都用 `COLLECT_CADENCE` 的字面量，Task 3 已定为 `'1s'|'5s'|'paused'`）。测试里 `setCadence('暂停')` 必须等价于 `'paused'`（界面直接送中文过来），换算函数入口处做 `const key = v === '暂停' ? 'paused' : v`，非法值抛错（svc-2 已断言）。
- `setVisible(v)` / `setSource(key, on)` 是 async（内部要 await `sup.stop`）。
- `onEvent(cb)` 返回注销函数；事件写在这里，**不要**在 service 里 import api.js（单向依赖：api 订阅 service）。
- 每一拍 L0 之后跑 `sup.tick()`（心跳巡检），并把 `sourceRows()` 变化 emit 成 `sources` 事件 —— 只在内容变化时 emit（对比 `JSON.stringify`），避免 1s 推一屏重复状态。
- ring 的两个上界都要真承重：`windowMs = keepMinutes * 60 * 1000`，**`maxPoints = keepMinutes * 60 + 1`**（+1 是窗底含边界保留的那一拍，`ring.js` 的裁剪是 `t < floor` 才丢），且 `createRing` 必须收服务的 `now`，否则假时钟下永不裁剪。svc-6 断的是**精确 301**，不是 `<=`。
- **核数热插拔/改频要复位基线**（台账 Task 5 下游契约②）：`computeCpuPct` 在两次样本核数不等时返回 NaN ⇒ 连续丢点。每拍 L0 前比对 `osMod.cpus().length` 与上一次的缓存值，不等就调 `l0.reset()` 并 `logger.warn` 记一行。
- **进程榜残值（Task 7 I-1 在编排层的镜像）**：`procRows` 是服务自己的状态，不是 `l1b.latest()` 的别名。凡 l1b 被停下的路径（`setVisible(false)` / `setSource('l1b',false)` / `stop()` / `dispose()`）都必须 `procRows = []`、`procNote = ''`、**`procT = null`**，并 emit `{type:'proc', rows: [], note:'', t: null}` —— 只清本地不推事件，SSE 侧的卡片会继续挂着已停源的旧榜。`procT` 只在 `onRows(parsed, line)` 解析成功时取 `parsed.t`（PowerShell 侧 UTC）；非 JSON 轮**不**更新它，也不清空它（上一轮仍是"最后一次成功的轮"，靠 `t` 让界面自己判陈旧）。
- **`dispose()` 之后 `sources` 里 `l0` 那一行不许再报 `on`。** 取证：真机串跑（Step 5）里 `dispose()` 后 `snapshot().sources` 是 `l0:on,l1a:off,l1b:off` —— 因为 l0 那行的 `state` 是按「开关 + 档位」算的，而 `dispose()` 只 `clearL0()`，没动开关。界面/日志读到这一行会以为主进程定时器还活着，这正是要拦的"与代码不符的陈述"。修法：加一个 `disposed` 标志，`dispose()` 置真、`start()` 置假，`sourceRows()` 里 l0 行按 `disposed ? 'off' : …` 判，`detail` 写「服务已 dispose」。l1a/l1b 两行不用管 —— 它们的状态来自 supervisor，源真停了自然变 off。
- **`dispose()` 的三条收口（Task 8 评审 Imp-1/2/3，三条都是 svc-8 现在承重的路径）**：
  1. **`disable()` 的 rejection 必须就地接住，`dispose()` 的签名保持同步。** `lib/collect/service.js` 里 `stop()` / `setSource()` / `setVisible()` 三处都是 `await … disable()` + `catch`，只有 `dispose()` 写成同步 `try { l1a.disable(); } catch` —— 而 disable 是 promise 语义（supervisor 桩就是 async），`try` 抓不到 rejection。评审最小复现（把 `sup.stop` 做成 `async () => { throw }` 并挂 `process.on('unhandledRejection')` 探针）实测打出 **2 条 UNHANDLED_REJECTION**；Node ≥15 默认 `--unhandled-rejections=throw` 会**终结宿主进程**，而 Task 19 就是把 dispose 挂在插件卸载钩子上。当下 `supervisor.stop` 恰好是同步函数所以炸不响，不能作为依据。
     ```js
     // 同步签名（Task 19 的卸载钩子不必 await）+ 两种错误形状都接住：
     function disableQuietly(key, src) {
       try {
         const p = src.disable();
         if (p && typeof p.catch === 'function') {
           p.catch((e) => logger.warn(`[collect] dispose 停 ${key} 抛错：`, e?.message ?? e));
         }
       } catch (e) { logger.warn(`[collect] dispose 停 ${key} 抛错：`, e?.message ?? e); }
     }
     ```
  2. **末尾补 `refreshSources()`。** `dispose()` 里没有它（`stop()` 里有），于是 push 通道永远停在 dispose 前的旧状态：Task 18 的 SSE 只按 `sources` 事件更新采集源条、不轮询 `snapshot()`，订阅者手里的 l0 行就停在 `on` —— 和上一条 `disposed` 标志要拦的是同一句假陈述，只是换了通道。svc-8 断「最后一条 `sources` 事件的 l0 行是 off」。
  3. **`disposed` 闸门要覆盖 `setCadence` / `setSource` / `setVisible` 三个入口**，不是评审提的两个。判据是"入口能不能造成**已死服务**的副作用"：`setVisible(true)`/`setSource(key,true)` 会 `enable()` 复活子进程，`setCadence` 会重挂定时器（而 l0 行因 `disposed` 仍报 off ⇒ 界面说停了、背后在跑，正是 self-contradiction）。三个入口开头一律：
     ```js
     if (disposed) { logger.warn(`[collect] 服务已 dispose，忽略 ${调用名}`); return; }   // async 的两个 return 就是 resolve(undefined)
     ```
     `start()` 仍然把 `disposed` 置假并正常工作（任务书认可"重新 start = 复活"），闸门只拦 start 之外的三个入口。svc-8 用 `w.started.length` 与 `w.timers.length` 两条钉住。
  4. 顺手收：`dispose()` 里 `lastSample = null`（否则 `latest.diskFreeGb/diskTotalGb` 留着旧账，而 ring 已重建、`latest.t` 已是 null —— 半新半旧的快照最难查），以及 `timerBackend` 随 `clearL0()` 置回 `null`。
- **`procT` 要过 `Number.isFinite` 闸门**：`onRows` 是对外接缝，`Number(parsed.t)` 出 NaN 会伪装成"非 null 的 t"，界面按它算"多久没出数"就永远算错。写 `procT = Number.isFinite(Number(parsed.t)) ? Number(parsed.t) : null`。（现栈不可达 —— Task 7 的 `parseProcLine` 已保证 finite，这里是接缝防御，不是补 bug。）
- `onPoint`/`onRows` 是**构造时**由服务传给 `makeL1a` / `makeL1b` 的出口（Task 7 已把 `createL1b` 改成不传 `onRows` 就抛，所以漏接是启动即炸，不是跑起来静默吞榜）。`onPoint` 收到未登记的 `metric` 时 `logger.warn` 并丢弃，**不许**新建 ring。
- `snapshot()` 里 `latest.*` 是**原值**（字节/秒、GB、百分数各按各自口径），换算文案归界面；`sources` 每次现取（supervisor 的 `state()` 很便宜），`l0` 那一行的 `state` 由开关 + 档位算，不来自 supervisor。

预检取证（这一段是计划自审 + 候选实现实跑写进来的，实现者不必再推）：⑥段最初在候选实现上是 `47/48` —— svc-1 断的 `l1a-enable` 事件在 `fakeWorld` 里**没有任何代码会产生**（工厂收到的 `onPoint` 被当返回对象属性回吐，`events` 又没暴露给工厂），属于硬失败而非空断言。随后一轮**变异电池**（每次只摘实现里一处，跑全量，还原，`cmp` 校字节）又挖出四类问题，全部已在本 Step 的用例文本里修好，**不许**为了让实现过得把断言改回去：

| 变异（摘掉实现里的哪一处） | 修前 | 修后红在 |
|---|---|---|
| M1 `makeL1a({sup, onPoint})` 不传 `onPoint` | 已红 | svc-1 |
| M2 脏点在进 ring 前 `continue` 掉（`dropped.bad` 永不涨） | 已红 | svc-3 |
| M3 只把 `maxPoints` 放大到天文数字 | **全绿** | 仍全绿 —— 见下方"双 knob 遮蔽" |
| M4 只把 `windowMs` 放大到 `1e12` | **全绿** | 仍全绿 —— 同上 |
| M3+M4 两条**同时**改 | 未测过 | svc-6 红（`series.cpu.length` 不再是 301） |
| M5 回退分支漏 `globalThis.clearInterval` | 已红（原为全绿，因 `timers` 恒空） | svc-7 |
| M6 `setVisible(false)` 少 `clearProc()` | **全绿** | svc-4 |
| M7 `dispose()` 少 `buildRings()` | **全绿** | svc-8 |
| M8 每拍都 `l0.reset()` | 已红 | svc-1 / svc-3 / svc-6 |
| M9 核数变化不 `reset()` | 已红 | svc-1 |
| N1 成功轮不记 `proc.t` | — | svc-4 |
| N2 停采只清 rows 不清 `proc.t` | — | svc-4 |
| N3 非 JSON 轮也写一个 `proc.t` | — | svc-1 |
| N4 `dispose()` 不置 `disposed` 标志（l0 行仍报 `on`） | — | svc-8 |
| C7 `clearL0()` 的 ctx 分支不调宿主 disposer（只往句柄上挂 `done`） | **全绿**（Task 8 独立评审实跑，48/48） | svc-2 / svc-8（fix round 新断；桩同时改成"返回 disposer"） |
| C8 `refreshSources()` 去掉 `lastSourceJson` 去重 | **全绿**（同上） | svc-1（fix round 新断 `sources` 恰好 1 屏） |
| C9 `dispose()` 末尾不 `refreshSources()` | — | svc-8（断最后一条 `sources` 事件的 l0 行是 off） |
| C10 `setCadence` / `setSource` / `setVisible` 不判 `disposed` | — | svc-8（断 `started.length` 不增、`timers.length` 恒 1）。**注意 svc-8 的 prefs 里 l1b 必须为真**，否则 `setVisible` 那条闸门摘掉照样全绿（fix round 变异 C10b 第一轮实测） |
| C11 `dispose()` 里 disable 的 rejection 没人接 | **全绿**（Task 8 独立评审实跑） | svc-8 的 `unhandledRejection` 探针（现场把 `sup.stop` 换成会 reject 的实现再 dispose 一拍）。原先 `fakeWorld` 的桩永不 reject，所以这条抓不到；评审的最小复现（`sup.stop = async () => { throw }` + 进程级探针）实测甩出 2 条 |

**M6/M7 为什么原本逃逸 —— 这是 harness 级的坑，不是本任务独有：** 那两条用例写成了 `check('…', async () => {…})`。`check()` 是同步 `try/catch`，拿到的是挂起中的 Promise：第一个 `await` 之前一条断言都没跑完，就先记了 PASS；后面的断言失败变成无人 catch 的 rejection。改成 `await checkAsync(...)` 后两处变异各红一条。**本文件 ①~⑤ 段全是同步用例，不受影响。**

**双 knob 遮蔽（M3/M4）是 ring 的固有性质，不是用例缺陷：** `createRing` 同时按 `windowMs` 和 `maxPoints` 裁，`keepMinutes×60+1` 这个条数上限与 `keepMinutes` 这个时间窗互为备份，单改其一时另一个仍在生效。svc-6 因此**只能**在两条同时失效时才红 —— 它已经用「断精确值 301 而不是 `<= 301`」把可断的部分钉死了，这里如实记下这个上界，别让后来的实现者以为还有更强的断言可加。

**fix round 1 的取证（2026-09-27，控制器在仓库外沙箱实跑，实现者照此实现即可，不必重推）：**
- 新 ⑥段 打在已交付的实现（`db2b360`）上是 **46/48**，红在 svc-2（`timerBackend` 应为 null、旧句柄的 disposer 必须被调）与 svc-8（dispose 的终态屏 / 闸门 / 残值 / rejection 探针）—— 先红后绿这一步已经具备，**不许**为了让旧实现过而回退断言。
- 候选实现（上面 Step 3 的八处修法）在同一份新 ⑥段 上 **48/48 通过**。
- fix round 的变异电池 8 条**全部有用例承重**（每轮 `cmp` 校字节动过、跑完还原并 `cmp` 校一致）：C7 不调 disposer → svc-2/svc-8 红；C8 失去重 → svc-1 红；C9 dispose 不补推 → svc-8 红；C10a `setCadence` 无闸门 → svc-8 红；C10b `setVisible` 无闸门 → svc-8 红（**前提**是该用例 prefs 里 l1b 为真，第一轮取证时 prefs 用默认值，这条摘掉照样 48/48 全绿）；C11 rejection 没人接 → svc-8 红；C12 不清 `lastSample` → svc-8 红；C13 `clearL0` 不置 `timerBackend = null` → svc-2/svc-8 红。
- 真机串跑（`node tmp/e2e-svc.mjs`，12 s，真起 typeperf + powershell）判定线全达标，`dispose 推了几屏 sources 1`、`最后一屏 l0 off`、`dispose 后 timerBackend null`、`dispose 后 latest.diskFreeGb null`、`dispose 后再 setVisible(true) 的 l1b off`，`warn日志条数 0`，跑完 `tasklist` 无 typeperf 残留、无本任务派生的 powershell 残留。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/collect.test.mjs`
Expected: `48/48 通过`（①4 ②5 ③11 ④10 ⑤8 ⑥10），退出码 0。

- [ ] **Step 5: 真机串跑（唯一一次真链路验证）**

**写法约定：** 这段脚本必须落成文件 `tmp/e2e-svc.mjs` 再 `node tmp/e2e-svc.mjs` 跑。**不要**用 `node --input-type=module -e "…"` 内联：本机 bash 会吃掉 `\\` 转义，且内联版**漏了 `makeL1b: createL1b`**（原稿只传了 `makeL0` / `makeL1a`），进程榜那条腿根本不接，`snapshot().proc.rows` 恒空 —— 串跑就等于没验。`tmp/` 已在 `.gitignore` 里，脚本不进提交。

脚本全文（相对路径按 `tmp/` 下一层写，实测跑通）：

```js
// tmp/e2e-svc.mjs —— Task 8 真机串跑：L0/L1a/L1b + supervisor 全装配。
const { createSupervisor } = await import('../lib/collect/supervisor.js');
const { createL0 } = await import('../lib/collect/l0-node.js');
const { createL1a } = await import('../lib/collect/l1a-typeperf.js');
const { createL1b } = await import('../lib/collect/l1b-powershell.js');
const { createCollectService } = await import('../lib/collect/service.js');
const osMod = (await import('node:os')).default;

const logs = [];
const logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => logs.push('warn: ' + a.map((x) => String(x?.message ?? x)).join(' ')),
};

const svc = createCollectService({
  getPrefs: () => ({ collect: { cadence: '1s', keepMinutes: 5 }, sources: { l0: true, l1a: true, l1b: true } }),
  getIntervalFn: () => null,
  logger,
  makeSupervisor: createSupervisor,
  makeL0: createL0,
  makeL1a: createL1a,
  makeL1b: createL1b,
  osMod,
});

const events = { metrics: 0, proc: 0, sources: 0, other: 0 };
let lastSources = null;
svc.onEvent((e) => {
  if (e.type === 'metrics') events.metrics += 1;
  else if (e.type === 'proc') events.proc += 1;
  else if (e.type === 'sources') { events.sources += 1; lastSources = e.rows; }
  else events.other += 1;
});

svc.start();
await svc.setVisible(true);

await new Promise((r) => setTimeout(r, 12000));

const s = svc.snapshot();
console.log('cpu点数', s.series.cpu.length,
  '| mem最新', s.latest.mem?.toFixed?.(1),
  '| 盘可用%', s.series.diskFreePct.at(-1)?.v?.toFixed?.(1),
  '| net点数', s.series.netDown.length,
  '| net最新B/s', s.latest.netDown?.toFixed?.(1),
  '| 源', s.sources.map((r) => `${r.key}:${r.state}`).join(','),
  '| 丢弃', JSON.stringify(s.dropped),
  '| 进程榜行数', s.proc.rows.length,
  '| proc.state', s.proc.state,
  '| proc.t', s.proc.t,
  '| note', JSON.stringify(s.proc.note.slice(0, 60)));
console.log('事件计数', JSON.stringify(events), '| timerBackend', s.timerBackend,
  '| proc.t 距今 ms', s.proc.t === null ? 'null' : Math.round(Date.now() - s.proc.t));
for (const r of s.sources) console.log('  源明细', r.key, r.state, '|', r.detail, '| restarts', r.restarts, '| pid', r.pid, '| stderr', JSON.stringify((r.stderrTail || '').slice(-80)));
console.log('warn日志条数', logs.length, logs.slice(0, 5).join(' ;; '));

await svc.setVisible(false);
const evBefore = { ...events };   // 取样点必须在 dispose 前一行：setVisible(false) 自己也会推一屏，混进来就没法断"dispose 推了几屏"
svc.dispose();
console.log('dispose 后 sources', svc.snapshot().sources.map((r) => `${r.key}:${r.state}`).join(','));
console.log('dispose 后进程榜行数', svc.snapshot().proc.rows.length, '| note', JSON.stringify(svc.snapshot().proc.note));
// dispose 的通道收口三条（Step 3 的 Imp-1/2/3）：事件终态、未挂表、迟到请求不复活
console.log('dispose 推了几屏 sources', events.sources - evBefore.sources,
  '| 最后一屏 l0', lastSources?.find((r) => r.key === 'l0')?.state,
  '| dispose 后 timerBackend', svc.snapshot().timerBackend,
  '| dispose 后 latest.diskFreeGb', svc.snapshot().latest.diskFreeGb);
await svc.setVisible(true);                       // 模拟一条比卸载晚到的 visibility POST
console.log('dispose 后再 setVisible(true) 的 l1b', svc.snapshot().sources.find((r) => r.key === 'l1b').state);
process.exit(0);
```

Run: `node tmp/e2e-svc.mjs`

Expected（**这是候选实现在本机连跑 5 组的实测区间，不是猜的**）：

| 打印项 | 实测 5 组 | 判定线 |
|---|---|---|
| `cpu点数` | 9 / 10 / 10 / 10 / 10 | `>= 9`（12 s @1s 档 ≈ 11 拍，扣首拍无基线） |
| `mem最新` | 74.3–74.9 | 只要 `0<v<100`（数值随负载动，不是判定项） |
| `盘可用%` | 33.8（五组同值） | 只要 `0<v<100` |
| `net点数` | 10（五组同值） | `>= 8` |
| `net最新B/s` | 2.0e4–1.8e5 | 不判定（空闲流量） |
| `源` | `l0:on,l1a:on,l1b:on` | 三行必须全 `on` |
| `丢弃` | `{"stale":0,"bad":1}` ×4、`{"stale":0,"bad":2}` ×1 | `stale === 0` 且 `bad <= 2`。`bad` 的来源是**首拍 `computeCpuPct` 没有前一次样本**（返回 NaN，percent ring 判脏），这是设计行为不是缺陷；再多就是真丢点了 |
| `进程榜行数` | 374 / 374 / 375 / 375 / 380 | `>= 350`（Task 7 实测满榜 369–392，`MAX_ROWS` 之前） |
| `proc.t` / `proc.t 距今 ms` | 例如 `1790516791685` / `1406` | `proc.t` 非 `null`，且距今 `< 8000`（一轮 ≈ 4.4–4.9 s，脚本直接打印差值） |
| `note` | `""` | 空串。非空说明降级或截断，先读它再改代码 |
| `事件计数` | `metrics 51–52`、`proc 2–3`、`sources 4` | `proc >= 1`（真收到过榜）、`other === 0` |
| `timerBackend` | `setInterval` | 必须是它（本脚本传 `getIntervalFn: () => null`） |
| `warn日志条数` | 0 | 必须 0（有 warn 说明某一轮走了非 JSON 分支） |
| `dispose 后 sources` | `l0:off,l1a:off,l1b:off` | **l0 必须是 off**（Step 3 的 `disposed` 标志；此前实测报 `l0:on` 而定时器已经清了） |
| `dispose 后进程榜行数` | 0 | 必须 0（残值清理） |
| `dispose 推了几屏 sources` | 1（fix round 真机 2 组都是 1；取样点必须先移到 `setVisible(false)` 之后 —— 放错位置会把"关 l1b"那一屏算进来，实测读到 2） | 必须 `1`（Imp-2：dispose 末尾补 `refreshSources()`，on→off 内容变了就必推）。`0` 就是 SSE 侧永远停在 on |
| `最后一屏 l0` | `off` | 必须 `off`（push 通道的终态） |
| `dispose 后 timerBackend` | `null` | 必须 `null`（没挂表还报 `setInterval` 就是报一个没发生过的后端） |
| `dispose 后 latest.diskFreeGb` | `null` | 必须 `null`（`lastSample` 也要清，半新半旧的快照最难查） |
| `dispose 后再 setVisible(true) 的 l1b` | `off` | 必须 `off`（Imp-3 闸门：迟到的可见性请求不许把已 dispose 的服务背后的 powershell 再拉起来） |

**后五行是评审 fix round 新加的打印**，读数是 2026-09-27 在候选实现（含 Imp-1/2/3 + M-1~M-4 修法）上真机重跑得到的；前十四行的 5 组区间来自 fix round 之前的同一脚本，`proc.t 距今 ms` 那一列 fix round 实测 1019 ms。

任何一项不达标**先查 `源明细` 里的 `stderrTail` / `detail` 再改代码**，不许放宽判定线。`l1b` 那一行 `state` 仍为 `on` 但 `note` 有说明，是 Task 7 Step 5 降级分支的形态；本机已裁定 `withCpu=true` 不降级（稳态周期 4.37–4.91 s < 预算 5 s），所以这里 `note` 应当为空。

提交信息草稿：`feat(sysops): 采集分层编排（档位 / 可见性 / 脏点闸门）`

---

## Task 9: `lib/alerts/rules.js` + `alert_hit` 记录

**Files:**
- Create: `lib/alerts/rules.js`
- Create: `lib/alerts/spec.js`（Task 13 起已 `git mv` 为 `lib/records/spec.js` —— 本任务原文按当时路径照写，重跑本任务时 import 用改名后的路径）
- Create: `lib/alerts/store.js`
- Create: `test/_helpers.mjs`（把 `test/prefs.test.mjs:121-150` 的 `createMemoryFacility` **原样搬过来**并 `export`；那是全仓库唯一的内存桩，两处共用只能有一处真相）
- Modify: `test/prefs.test.mjs`（删掉本地定义，改成 `import { createMemoryFacility } from './_helpers.mjs';`。**用例条数与断言一字不动**：搬完 `prefs 13/13` 必须照旧绿，`grep -c "^check(\|^await checkAsync(" test/prefs.test.mjs` 的数字不许变）
- Modify: `test/alerts.test.mjs`（本任务建文件，Step 1 写 ①②段，Step 5 追加 ③段）

**Interfaces:**
- Consumes: `kv-schema.js`、Task 3 的 `SOURCE_KEYS`
- Produces:
  - `DEFAULT_RULES`（5 条，与已确认原型逐字一致，见下）、`ruleState(rule, srcStates) → { dim, on, st }`
    —— **两个参数**：原稿第三个 `now` 从头到尾没人读，是死重量，别照抄（Ruling-53）
  - `evaluate(rule, points, now, lastHitAt) → { ruleId, name, metric, t, value, note } | null`（纯函数，无 IO）
    —— **`name` 是落库必填**（`alert_hit.name` 是 `requiredString`），返回形状里不许只带 `ruleId`
  - `evaluateProc(rule, rows, now, lastHitAt = null) → 同上形状 | null`（吃 Task 7 的 `rows` 而不是时序点）
    —— **必须排除 `pid === 0` 那一行**：它是 `_Total`/`Idle` 覆盖出来的聚合值，Task 7 真机实测 90–102%，
    不排除则 r5 天天命中 `System Idle Process`（Ruling-54，落点见 Step 3）
  - `alertsDomain`（name `sysops_records`，version 1，tables `clean_plan` / `clean_log` / `alert_hit`；本任务只声明 `alert_hit` 所需字段，Task 13 补另两张表时对 `spec.js` 做**追加**式修改）
  - `RECORDS_ERROR = { UNAVAILABLE: 'RECORDS_UNAVAILABLE', INVALID: 'RECORDS_INVALID', CLOSED: 'RECORDS_CLOSED' }`
    （与 `PREFS_ERROR` 同形：Task 18 按 `e.code` 分支，裸 Error 接不住）
  - `createAlertHitStore({ getFacility, logger })` →（**没有 `now`**：行的 `t` 由 `evaluate`/`evaluateProc` 一侧给，
    store 拿着也只是死重量）
    `{ available, list({limit} = {}) → rows, append(hit) → row, close() }`
    —— 200 条上限**按 `Number(v.t)` 数值排序裁剪，不许按 key 字典序**：`hitKey` 的时间前缀在假时钟下
    `h-9-r1 > h-1000-r1`，按字典序会把最新那条裁掉（Ruling-55，hit-2 就是钉这个的）；
    `close()` 是**终态**（`available` 转 false、再写抛 `RECORDS_CLOSED`，与 `lib/prefs/store.js:74-101` 同形，
    本任务不加 `open()` —— 复活靠换新实例，hit-5 钉"记录在宿主域里不在实例内存里"）
  - `ALERT_METRICS = ['cpu','mem','diskFreePct','netDown','procCpu']`

- [ ] **Step 1: 写失败的测试**

`test/alerts.test.mjs`（harness 同上）：

```js
/* ①段：规则形状与置灰 */
const R = await import('../lib/alerts/rules.js');

const SRC = { l0: 'on', l1a: 'on', l1b: 'on', l2: 'on' };

check('rule-1 内置 5 条规则，与原型文案逐字一致', () => {
  assert.equal(R.DEFAULT_RULES.length, 5);
  assert.deepEqual(R.DEFAULT_RULES.map((r) => r.n), [
    'CPU ≥ 85% 连续 3 次',
    '内存占用率 ≥ 90%',
    'C 盘可用 < 15%',
    '下行持续 > 20 MB/s 满 1 分钟',
    '单进程 CPU > 60%',
  ]);
  assert.deepEqual(R.DEFAULT_RULES.map((r) => r.dep), ['l0', 'l0', 'l0', 'l1a', 'l1b']);
});

check('rule-2 依赖源关闭 → dim，且 st 说清是依赖问题不是用户关的', () => {
  const r = R.ruleState(R.DEFAULT_RULES[3], { ...SRC, l1a: 'off' });
  assert.equal(r.dim, true);
  assert.equal(r.on, false);
  assert.equal(r.st, '依赖的采集已关闭');
});

check('rule-3 用户关 → 不 dim，st 为「已暂停」', () => {
  const r = R.ruleState({ ...R.DEFAULT_RULES[4], userOff: true }, SRC);
  assert.equal(r.dim, false);
  assert.equal(r.st, '已暂停');
});

/* ②段：evaluate 阈值判定（假时钟，零 IO） */
const pts = (t0, step, vals) => vals.map((v, i) => ({ t: t0 + i * step, v }));
const cpuRule = R.DEFAULT_RULES[0]; // ≥85 连续 3 次，冷却 600s

check('rule-4 连续 N 次才报，差一次不报', () => {
  // 原稿这里写的是 [90, 91, 88] 却期望 null —— 三个点全 ≥85，`tail.every(breach)` 为真，
  // 按 Step 3 的实现必然报。沙箱取证（p9probe）：原稿 9/10，红就在 rule-4。
  // "差一次"要的是**尾部窗口里有一次不达标**，不是"数值看着不一样"。
  assert.equal(R.evaluate(cpuRule, pts(0, 1000, [90, 91, 30]), 3000, null), null, '第 3 次掉到阈值下 ⇒ 连续不成立');
  assert.equal(R.evaluate(cpuRule, pts(0, 1000, [90, 90, 90, 30, 30]), 5000, null), null,
    '约定 1：连续 N 次看的是尾部 N 个点，不是历史上累计出现过 N 次');
  const hit = R.evaluate(cpuRule, pts(0, 1000, [90, 91, 92]), 3000, null);
  assert.equal(hit.ruleId, 'r1');
  assert.equal(hit.value, 92);
  assert.equal(hit.name, 'CPU ≥ 85% 连续 3 次', 'name 是 alert_hit 的必填列，漏了它落库才炸');
  assert.equal(hit.t, 2000, '触发时刻是最后一个样本的时间，不是 now');
});

check('rule-5 冷却窗口内不重复报（异动是事件不是状态）', () => {
  const s = pts(0, 1000, [90, 91, 92]);
  assert.ok(R.evaluate(cpuRule, s, 3000, null));
  assert.equal(R.evaluate(cpuRule, s, 3000, 2500), null, '2.5s 前刚报过，600s 冷却内');
  assert.ok(R.evaluate(cpuRule, s, 3000, 2500 - 600_000), '冷却过了要能再报');
});

check('rule-6 方向：C 盘是「低于」阈值，网速是「高于」', () => {
  const disk = R.DEFAULT_RULES[2]; // <15%，cooldown 86400
  assert.ok(R.evaluate(disk, pts(0, 1000, [10]), 1000, null));
  assert.equal(R.evaluate(disk, pts(0, 1000, [40]), 1000, null), null);
  const net = R.DEFAULT_RULES[3]; // >20MB/s 满 1 分钟 = 60 个 1s 点
  assert.equal(R.evaluate(net, pts(0, 1000, Array(59).fill(30e6)), 59_000, null), null);
  assert.ok(R.evaluate(net, pts(0, 1000, Array(60).fill(30e6)), 60_000, null));
});

check('rule-7 点序不按时间递增时不评估（脏 ring 不该触发告警）', () => {
  assert.equal(R.evaluate(cpuRule, [{ t: 5000, v: 99 }, { t: 3000, v: 99 }, { t: 4000, v: 99 }], 9000, null), null);
});

check('rule-8 空点/样本不足/consecutive 大于点数 → 不报也不抛', () => {
  assert.equal(R.evaluate(cpuRule, [], 1000, null), null);
  assert.equal(R.evaluate({ ...cpuRule, consecutive: 99 }, pts(0, 1000, [99, 99, 99]), 3000, null), null);
});

check('rule-9 procCpu 是「单进程」判定：吃 rows 而不是时序点', () => {
  const r = R.DEFAULT_RULES[4];
  const rows = [{ pid: 1, name: 'a', cpuPct: 70 }, { pid: 2, name: 'b', cpuPct: 10 }];
  const hit = R.evaluateProc(r, rows, 8000);
  assert.equal(hit.note, 'a');
  assert.equal(hit.value, 70);
  assert.equal(R.evaluateProc(r, [{ pid: 2, name: 'b', cpuPct: 10 }], 8000), null);
  assert.equal(R.evaluateProc(r, [{ pid: 3, name: 'c', cpuPct: null }], 8000), null, 'CPU 列降级后不得凭 null 判定');
  // Task 7 的下游契约："pid 0 是聚合值行"这个排除动作归消费侧，落点就是这里。
  assert.equal(R.evaluateProc(r, [{ pid: 0, name: 'System Idle Process', cpuPct: 95 }], 8000), null,
    'pid 0 的 cpuPct 是 _Total/Idle 覆盖出的聚合值（真机 90–102%），不许报成"某进程吃满 60%"');
  const after = R.evaluateProc(r, [{ pid: 0, name: 'Idle', cpuPct: 95 }, { pid: 7, name: 'x', cpuPct: 80 }], 8000);
  assert.equal(after.note, 'x', '排除 pid 0 之后要继续扫下一行，不能整轮作废');
  assert.equal(after.value, 80);
  assert.equal(R.evaluateProc(r, [{ pid: null, name: 'y', cpuPct: 90 }], 8000).value, 90,
    'pid 为 null 是"读不到 pid 的真进程"（Task 7 契约 number|null），不许当聚合行误伤');
});

check('rule-10 ALERT_METRICS 与 prefs.alerts 的五个键一致（Task 3 与这里只能有一处真相）', () => {
  assert.deepEqual(R.ALERT_METRICS.slice().sort(), ['cpu', 'diskFreePct', 'mem', 'netDown', 'procCpu']);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/alerts.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/alerts/rules.js`。

- [ ] **Step 3: 写实现**

`lib/alerts/rules.js`：

```js
/**
 * 阈值判定：纯函数，零 IO。
 *
 * 三条容易写错的约定：
 *  1. **连续 N 次**看的是尾部 N 个点，不是"历史上出现过 N 次"。
 *  2. **冷却**用最近一次触发时间比较，触发时刻取样本时间而不是 now ——
 *     否则 SSE 延迟会让同一次尖峰报两遍。
 *  3. 依赖的采集源关了 → **不参与评估**（不是评估完再隐藏），闸门由 ruleState 给，
 *     service 里先问 ruleState 再 evaluate。
 */
import { SOURCE_KEYS } from '../prefs/spec.js';

export const ALERT_METRICS = ['cpu', 'mem', 'diskFreePct', 'netDown', 'procCpu'];

/** 与已确认原型 prototype/index.html 的 rules 数组逐字对应；改文案要同步原型。 */
export const DEFAULT_RULES = [
  { id: 'r1', n: 'CPU ≥ 85% 连续 3 次', d: '冷却 10 分钟 · 落点：监控页时间线', dep: 'l0', metric: 'cpu', op: 'gte', value: 85, consecutive: 3, cooldownMs: 10 * 60_000 },
  { id: 'r2', n: '内存占用率 ≥ 90%', d: '冷却 15 分钟', dep: 'l0', metric: 'mem', op: 'gte', value: 90, consecutive: 1, cooldownMs: 15 * 60_000 },
  { id: 'r3', n: 'C 盘可用 < 15%', d: '冷却 24 小时 · 每次开机后首次必报', dep: 'l0', metric: 'diskFreePct', op: 'lte', value: 15, consecutive: 1, cooldownMs: 24 * 60 * 60_000 },
  { id: 'r4', n: '下行持续 > 20 MB/s 满 1 分钟', d: '依赖常驻 typeperf', dep: 'l1a', metric: 'netDown', op: 'gte', value: 20e6, consecutive: 60, cooldownMs: 10 * 60_000 },
  { id: 'r5', n: '单进程 CPU > 60%', d: '依赖进程榜采集（PowerShell）', dep: 'l1b', metric: 'procCpu', op: 'gte', value: 60, consecutive: 1, cooldownMs: 10 * 60_000, userOff: true },
];

const STATE_ON = 'on';

export function ruleState(rule, srcStates) {
  const src = srcStates?.[rule.dep];
  const dim = !SOURCE_KEYS.includes(rule.dep) || src !== STATE_ON;
  return { dim, on: !dim && rule.userOff !== true, st: dim ? '依赖的采集已关闭' : (rule.userOff ? '已暂停' : '监控中') };
}

function tailAscending(points, n) {
  if (!Array.isArray(points) || points.length < n) return null;
  const tail = points.slice(-n);
  for (let i = 1; i < tail.length; i += 1) {
    if (!(tail[i].t > tail[i - 1].t)) return null; // 点序异常直接不评估（rule-7）
  }
  return tail;
}

const breach = (rule, v) => (rule.op === 'lte' ? v < rule.value : v >= rule.value);

export function evaluate(rule, points, now, lastHitAt) {
  const tail = tailAscending(points, rule.consecutive);
  if (!tail) return null;
  if (Number.isFinite(lastHitAt) && now - lastHitAt < rule.cooldownMs) return null;
  if (!tail.every((p) => breach(rule, p.v))) return null;
  const last = tail[tail.length - 1];
  return {
    ruleId: rule.id,
    name: rule.n,
    metric: rule.metric,
    t: last.t,
    value: last.v,
    note: rule.d,
  };
}

/** 进程榜不是时序点而是"某一轮的 rows"，判定单独一个入口，别硬塞进 evaluate。 */
export function evaluateProc(rule, rows, now, lastHitAt = null) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (Number.isFinite(lastHitAt) && now - lastHitAt < rule.cooldownMs) return null;
  // 只按 pid 排除，不按名字：pid 0 那行的 Name 取决于 _Total 与 Idle 谁后写进哈希表。
  // pid 为 null 的行照判 —— 那是读不到 pid 的真进程，不是聚合值。
  const hit = rows.find((r) => r.pid !== 0 && Number.isFinite(r.cpuPct) && breach(rule, r.cpuPct));
  if (!hit) return null;
  return { ruleId: rule.id, name: rule.n, metric: rule.metric, t: now, value: hit.cpuPct, note: hit.name };
}
```

`lib/alerts/spec.js` —— 记录域 `sysops_records`（三张表，本任务只填 `alert_hit`，Task 13 追加两张）：

```js
/**
 * 系统产生的记录：告警触发历史 / 清理清单快照 / 清理执行留痕。
 * 与 `sysops_prefs` 分 domain 的理由同参照实现：这些不是"用户设的、要被覆盖的"，
 * 而是**事实**，写进去就不能改（除裁剪最旧）。
 */
// 只 import 用得着的：requiredInt / optionalNumber / optionalInt 是 Task 13 那两张表的事，现在引了就是死引用
import { defineDomain, domainTable, record, requiredString, requiredNumber, optionalString } from '../kv-schema.js';

export const RECORD_DOMAIN = 'sysops_records';
export const RECORD_VER = 1;
/** 触发历史裁剪上限（spec §3.5）。 */
export const ALERT_HIT_MAX = 200;

const alertHit = record({
  hitId: requiredString('alert_hit.hitId'),
  ruleId: requiredString('alert_hit.ruleId'),
  name: requiredString('alert_hit.name'),
  metric: requiredString('alert_hit.metric'),
  t: requiredNumber('alert_hit.t'),
  value: requiredNumber('alert_hit.value'),
  note: optionalString('alert_hit.note'),
}, 'alert_hit');

export const alertsDomain = defineDomain({
  name: RECORD_DOMAIN,
  version: RECORD_VER,
  tables: {
    alert_hit: domainTable(alertHit),
    // clean_plan / clean_log 在 Task 13 追加到这里（同一个 domain，避免 open 两次）
  },
});

/**
 * 行 key：`h-<触发毫秒>-<规则id>`，同一规则同一毫秒不会重复。
 * **但别拿它排序**：字典序只在毫秒位数相同（真机 13 位）时等于时间序，假时钟下 `h-9-r1 > h-1000-r1`。
 * 裁剪与 list 一律按 `Number(v.t)` 数值排（Ruling-55，hit-2 钉这条）。
 */
export const hitKey = (hit) => `h-${hit.t}-${hit.ruleId}`;
```

`lib/alerts/store.js` —— `createAlertHitStore`：**骨架照抄 `lib/prefs/store.js:74-101`**（`assertUsable` 判 closed 与无设施、`ensureDomain` 缓存 open 的 promise 且失败时清缓存允许下次重试），不要重新发明；记录侧特有的部分逐条如下：

- 导出 `RECORDS_ERROR = { UNAVAILABLE: 'RECORDS_UNAVAILABLE', INVALID: 'RECORDS_INVALID', CLOSED: 'RECORDS_CLOSED' }`，
  错误对象与 `PrefStoreError` 同形（`e.code` + 中文 `e.message`）—— Task 18 只按 `code` 分支，裸 Error 接不住。
- `append(hit)`（async）：`assertUsable` → **put 之前**用 `alertsDomain.tables.alert_hit.valueSchema.parse` 校验，
  失败包成 `RECORDS_INVALID` 且 message 点名 `alert_hit.<字段>` → `hitId = hitKey(hit)` →
  `put(hitId, { ...hit, hitId })` → 裁剪 → **返回落库行**（含 `hitId`，界面拿它当 key）。
- 裁剪：`entries()` 全读，按 `Number(v.t)` **数值升序**，超出 `ALERT_HIT_MAX` 的最旧部分逐条 `delete(key)`。
  原稿写的"按 key 字典序（时间前缀=字典序）"是错的，见上面 `hitKey` 那段注释。
- `list({ limit = 50 } = {})`（async）：按 `Number(v.t)` 倒序，`t` 相同再按 `hitId` 倒序，`slice(0, limit)`。
- `get available()` 与 `async close()` 跟 prefs 的两半**逐字同形**：`available` 探测的是"有设施且没 close 过"，
  `close()` 是终态（置 closed、清 `opening`/`handle` 缓存、`await` 底层 close）。**本任务不加 `open()`**：
  复活靠换新实例，hit-5 就是钉"记录在宿主域里、不在 store 实例的内存里"。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/alerts.test.mjs`
Expected: `10/10 通过`，退出码 0。

- [ ] **Step 5: store 的内存桩用例（加进同一文件的 ③段）**

`test/_helpers.mjs` 导出 `createMemoryFacility()`（从 `test/prefs.test.mjs:121-150` 原样搬，`test/prefs.test.mjs` 改成 import；
`prefs 13/13` 与它的 `check(` 计数 7+6=13 一字不动）。③段整段代码如下 —— 五例全是异步，**必须 `await checkAsync`**
（Ruling-43：`check()` 挂 async 会在第一个 await 前就记 PASS，await 之后的断言永不承重）：

```js
/* ③段：alert_hit 仓储（内存桩，零真 IO） */
const { createAlertHitStore, RECORDS_ERROR } = await import('../lib/alerts/store.js');
const { ALERT_HIT_MAX, hitKey } = await import('../lib/alerts/spec.js');
const { createMemoryFacility } = await import('./_helpers.mjs');

const N = { info() {}, warn() {} };
// 判键不判值：`mkStore({ facility: undefined })` 要的就是"宿主没给 storageDomain"，
// 而默认形参会把 undefined 吃掉换成新桩 —— 沙箱现采：那种写法下 hit-3 第一条断言必红（available 反而是 true）。
// 与 test/prefs.test.mjs:153 的 `fresh(over)` 同一手法。
const mkStore = (over = {}) => {
  const facility = 'facility' in over ? over.facility : createMemoryFacility();
  return { facility, st: createAlertHitStore({ getFacility: () => facility, logger: N }) };
};
const hitRow = (t, ruleId = 'r1') => ({
  ruleId,
  name: 'CPU ≥ 85% 连续 3 次',
  metric: 'cpu',
  t,
  value: 90,
  note: '冷却 10 分钟 · 落点：监控页时间线',
});

await checkAsync('hit-1 append 后 list 倒序返回，且落库行带 hitId', async () => {
  const { st } = mkStore();
  assert.equal(st.available, true, '有设施就该报可用');
  await st.append(hitRow(1000));
  await st.append(hitRow(3000));
  await st.append(hitRow(2000));
  const rows = await st.list({ limit: 10 });
  assert.deepEqual(rows.map((r) => r.t), [3000, 2000, 1000], '倒序 = 新的在前');
  assert.equal(rows[0].hitId, hitKey(hitRow(3000)), 'hitId 由 hitKey 生成，界面拿它当 key');
  assert.equal(rows[0].name, 'CPU ≥ 85% 连续 3 次', 'name 是必填列，evaluate 那边漏了这里就会炸');
});

await checkAsync('hit-2 写满 201 条时最旧一条被裁掉，list 长度恒 ≤200', async () => {
  const { st } = mkStore();
  // t 故意跨位数（9 → 209）：按 key 字典序裁剪会把 t=209 之外判错方向，
  // `h-9-r1` 字典序大于 `h-10-r1` —— 这条用例就是逼实现按 Number(t) 排。
  for (let i = 0; i < ALERT_HIT_MAX + 1; i += 1) await st.append(hitRow(9 + i));
  const rows = await st.list({ limit: 500 });
  assert.equal(rows.length, ALERT_HIT_MAX, `上限 ${ALERT_HIT_MAX} 条，多一条都得裁`);
  assert.equal(rows[0].t, 209, '最新的那条必须留着');
  assert.equal(rows[rows.length - 1].t, 10, 't=9 是最旧的，必须被裁掉');
  assert.ok(!rows.some((r) => r.t === 9), '被裁的行不许还在');
});

await checkAsync('hit-3 无 facility 是降级不是异常：available=false 且读写抛 RECORDS_UNAVAILABLE', async () => {
  const { st } = mkStore({ facility: undefined });
  assert.equal(st.available, false);
  await assert.rejects(() => st.append(hitRow(1000)), { code: RECORDS_ERROR.UNAVAILABLE });
  await assert.rejects(() => st.list(), { code: RECORDS_ERROR.UNAVAILABLE });
  // 给了设施但 open 失败：available 仍 true（它探测的是"宿主给没给设施"），但读抛带 code 的错误且保留原始 message
  const w = mkStore({ facility: { open: () => Promise.reject(new Error('already open')) } });
  assert.equal(w.st.available, true);
  await assert.rejects(() => w.st.list(), { code: RECORDS_ERROR.UNAVAILABLE, message: /already open/ });
  // open 失败不许被缓存成坏 promise：下次调用要重开一次（与 prefs 的 `opening = null` 同形）
  let tries = 0;
  const flaky = { open: () => { tries += 1; return Promise.reject(new Error('第 ' + tries + ' 次 open 失败')); } };
  const f = mkStore({ facility: flaky }).st;
  await assert.rejects(() => f.list(), { code: RECORDS_ERROR.UNAVAILABLE });
  await assert.rejects(() => f.list(), { code: RECORDS_ERROR.UNAVAILABLE });
  assert.equal(tries, 2, '两次读各敲一次 open —— 缓存住失败会让仓储永久瘫着');
});

await checkAsync('hit-4 脏记录（缺 ruleId）被 schema 挡在门外，抛错信息点名 alert_hit.ruleId', async () => {
  const { st } = mkStore();
  const dirty = hitRow(1000);
  delete dirty.ruleId;
  await assert.rejects(
    () => st.append(dirty),
    (e) => e.code === RECORDS_ERROR.INVALID && /alert_hit\.ruleId/.test(e.message),
    '脏行必须落成带 code 的 INVALID，裸 Error 会让 Task 18 落进 default 分支',
  );
  assert.equal((await st.list({ limit: 10 })).length, 0, '被挡在门外的行不许留半条');
});

await checkAsync('hit-5 close() 是终态；换实例复用同一域仍读得到关前的行', async () => {
  const w = mkStore();
  await w.st.append(hitRow(1000));
  await w.st.close();
  assert.equal(w.st.available, false, '与 prefs 同形：close 过的实例不再报可用');
  await assert.rejects(() => w.st.append(hitRow(2000)), { code: RECORDS_ERROR.CLOSED });
  const again = createAlertHitStore({ getFacility: () => w.facility, logger: N });
  assert.equal(again.available, true);
  assert.deepEqual((await again.list({ limit: 10 })).map((r) => r.t), [1000],
    '记录在宿主域里，不在 store 实例的内存里 —— 换实例不许把历史丢掉');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

Run: `node test/alerts.test.mjs` → Expected: `15/15 通过`，退出码 0（①3 + ②7 + ③5）。
Run: `node test/prefs.test.mjs` → Expected: `13/13 通过`（搬走桩之后不许变）。

**变异自证（写进报告，不许只说"覆盖到了"）**：① 把裁剪的排序键从 `Number(v.t)` 换成 `key` ⇒ hit-2 必须红；
② 把 `assertUsable` 里 `closed` 那段摘掉 ⇒ hit-5 红；③ 把 `ensureDomain` 的失败清缓存（`opening = null`）摘掉 ⇒
hit-3 最后一段红；④ 把 `append` 里的 `parse` 挪到 `put` 之后（或直接删掉）⇒ hit-4 红。四条各自 `git checkout --` 还原并 `git status --short` 证净。

提交信息草稿：`feat(sysops): 告警阈值判定与触发历史（200 条环形裁剪）`

## Task 10: `lib/alerts/service.js` —— 评估编排 + 未读计数

**Files:**
- Create: `lib/alerts/service.js`
- Modify: `lib/alerts/rules.js`（追加导出 `mergeRules`，不改已有函数体）
- Modify: `test/alerts.test.mjs`（追加 ④段 `merge-*` 4 例、⑤段 `alert-*` 10 例；把末尾统计/exit 两行挪到最后）
  > **执行后回填（2026-09-27 Task 10 修复轮）**：⑤段实际落地 **14 例**（`alert-1..alert-14`）。修复轮按评审 I-1..I-4 新增 `alert-11`（监听器抛错隔离）、`alert-12`（proc 冷却）、`alert-13`（`hits()` 透传顺序与 limit），控制器又按「一个用例只测一个行为」把降级分支从 `alert-13` 拆成独立的 `alert-14`。门禁随之从 `29/29` 变 **`33/33`**，下游任务的旁路读数一律以 33 为准。

**Interfaces:**
- Consumes: `DEFAULT_RULES` / `ruleState(rule, srcStates) → {dim,on,st}`（两参，Task 9 已收敛）/ `evaluate` / `evaluateProc`（Task 9）、`createAlertHitStore`（Task 9）、`collect.snapshot()` / `collect.onEvent(cb) → unsub`（Task 8）、`prefs.alerts`（Task 3 的 `threshold` 形状）
- Produces:
  - `mergeRules(builtin, prefsAlerts) → rule[]`（纯函数：把用户阈值覆盖进内置规则，`enabled:false` 映射为 `userOff:true`，**不修改入参数组**）
  - `createAlertService({ collect, hitStore, getRulePrefs, logger, now })` → `{ start(), hits({limit}), unread(), markRead(), ruleRows(), onEvent(cb) → unsub, dispose() }`
  - `ruleRows() → { rule, st: {dim,on,st} }[]`，界面「阈值告警」卡直接吃它（原型 `renderRules` 的数据源）
  - 事件只有两种：`{type:'alert', hit}` / `{type:'alert-store', error: string}`。
    规则表变化**不推事件** —— `ruleRows()` 是拉取式（阈值只在 `getRulePrefs()` 里变，
    界面每次渲染现问一次），原计划这里写的 `alert-rules` 是死契约，删（Ruling-57）。
  - **闸门只认 `ruleState(...).on`**：`on` 同时吃掉"依赖源没开"与"用户关掉"两条分支，
    `dim` 单条判据不够（Ruling-58）。

- [ ] **Step 1: 写失败的测试（④段：mergeRules）**

```js
/* ④段：prefs 阈值覆盖内置规则 */
check('merge-1 覆盖数值与冷却，冷却按秒换算成毫秒', () => {
  const out = R.mergeRules(R.DEFAULT_RULES, { cpu: { value: 95, consecutive: 5, cooldownSec: 120 } });
  const cpu = out.find((r) => r.metric === 'cpu');
  assert.equal(cpu.value, 95);
  assert.equal(cpu.consecutive, 5);
  assert.equal(cpu.cooldownMs, 120_000);
  assert.equal(out.find((r) => r.metric === 'mem').value, 90, '未覆盖的规则原样保留');
});

check('merge-2 enabled:false 映射为 userOff（置灰分支与依赖分支是两回事）', () => {
  const out = R.mergeRules(R.DEFAULT_RULES, { procCpu: { value: 60, consecutive: 1, cooldownSec: 600, enabled: false } });
  assert.equal(out.find((r) => r.metric === 'procCpu').userOff, true);
});

check('merge-3 不修改入参（DEFAULT_RULES 是常量表，改一次就污染全局）', () => {
  const before = JSON.stringify(R.DEFAULT_RULES);
  R.mergeRules(R.DEFAULT_RULES, { cpu: { value: 1, consecutive: 1, cooldownSec: 60 } });
  assert.equal(JSON.stringify(R.DEFAULT_RULES), before);
});

check('merge-4 未知指标键忽略但可被发现；缺字段的覆盖不半套生效', () => {
  const out = R.mergeRules(R.DEFAULT_RULES, { gpu: { value: 1 }, mem: { value: 70 } });
  assert.equal(out.find((r) => r.metric === 'mem').value, 70);
  assert.equal(out.find((r) => r.metric === 'mem').consecutive, 1, 'consecutive 未覆盖时保留内置值');
  assert.equal(out.length, R.DEFAULT_RULES.length);
});
```

- [ ] **Step 2: 写失败的测试（⑤段：service 编排）**

```js
/* ⑤段：告警服务（假 collect + 假 hitStore + 假时钟） */
const { createAlertService } = await import('../lib/alerts/service.js');

/**
 * 假世界三条约定，缺一条就会把编排测成假绿：
 *  1. **每个采样点自带 1 秒推进**。`evaluate` 前面有 Task 9 的点序闸门
 *     （`tail[i].t > tail[i-1].t` 严格递增），时钟不推进 ⇒ 三点同 `t` ⇒ 永远不报，
 *     alert-1/2/6/8 全部只是"没测到"而不是"测错了"。
 *  2. **订阅者存成数组**。`dispose()` 走的是 unsub 路径，桩里只留一个 `_cb` 的话
 *     退订与重复订阅都看不见（`start()` 两次也只是覆盖同一个变量）。
 *  3. **落库是异步的**，`alert-store` 失败事件要等一回合才到 listeners，
 *     所以需要 `tick()`；成功分支不用（假 `append` 体里没有 await，push 在同步段就跑完了）。
 */
function alertWorld(over = {}) {
  let t = 0;
  const events = [];
  const appended = [];
  const cbs = [];
  const srcStates = over.srcStates ?? { l0: 'on', l1a: 'on', l1b: 'on' };
  const series = { cpu: [], mem: [], diskFreePct: [], netDown: [], netUp: [], ...over.series };
  const collect = {
    snapshot: () => ({
      series,
      latest: {},
      cadence: over.cadence ?? '1s',
      sources: Object.entries(srcStates).map(([key, state]) => ({ key, state })),
      proc: { rows: over.procRows ?? [] },
    }),
    onEvent: (cb) => {
      cbs.push(cb);
      return () => { const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1); };
    },
  };
  const hitStore = over.noStore ? null : {
    available: true,
    append: async (h) => { if (over.storeFails) throw new Error('disk full'); appended.push(h); return h; },
    list: async ({ limit } = {}) => appended.slice(-limit).reverse(),
  };
  const svc = createAlertService({
    collect,
    hitStore,
    getRulePrefs: () => over.alertPrefs,
    now: () => t,
    logger: { warn(msg) { events.push({ type: 'log', msg }); } },
  });
  svc.onEvent((e) => events.push(e));
  svc.start();
  const adv = (ms) => { t += ms; };
  const fire = (ev) => cbs.slice().forEach((cb) => cb(ev));
  const emitPoint = (key, v) => { t += 1000; series[key].push({ t, v }); fire({ type: 'metrics', key, point: { t, v } }); };
  const emitProc = (rows) => { over.procRows = rows; fire({ type: 'proc', rows }); };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return { svc, adv, t: () => t, events, appended, cbs, emitPoint, emitProc, tick, series, srcStates };
}

await checkAsync('alert-1 CPU 连续 3 次越线 → emit alert 且落库一次', async () => {
  const w = alertWorld();
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91);
  assert.equal(w.events.filter((e) => e.type === 'alert').length, 0, '两次不够，别提前报');
  w.emitPoint('cpu', 92);
  await w.tick(); // record 的尾巴（append 之后）是异步的，不 settle 就数不清几次
  const hit = w.events.find((e) => e.type === 'alert').hit;
  assert.equal(hit.ruleId, 'r1');
  assert.equal(w.appended.length, 1);
  assert.equal(w.events.filter((e) => e.type === 'alert').length, 1, '一次命中只能有一条 alert');
});

await checkAsync('alert-2 冷却内再越线不重复报（时间线会被同一次尖峰刷屏）', async () => {
  const w = alertWorld();
  for (const v of [90, 91, 92]) w.emitPoint('cpu', v);
  w.adv(1000);
  w.emitPoint('cpu', 99);
  await w.tick();
  assert.equal(w.appended.length, 1, `冷却 10 分钟，第二次不该落库，实得 ${w.appended.length}`);
});

await checkAsync('alert-3 依赖源关了 → 整条规则不评估（不是评估后隐藏）', async () => {
  const w = alertWorld({ srcStates: { l0: 'on', l1a: 'off', l1b: 'on' } });
  for (let i = 0; i < 70; i++) { w.adv(1000); w.emitPoint('netDown', 30e6); }
  assert.equal(w.appended.length, 0);
  assert.equal(w.svc.ruleRows().find((r) => r.rule.id === 'r4').st.dim, true);
});

await checkAsync('alert-4 档位暂停 = l0 源 off → cpu/mem/磁盘三条一起置灰', async () => {
  const w = alertWorld({ srcStates: { l0: 'off', l1a: 'on', l1b: 'on' } });
  w.emitPoint('cpu', 99);
  const rows = w.svc.ruleRows();
  assert.deepEqual(rows.filter((r) => r.rule.dep === 'l0').map((r) => r.st.dim), [true, true, true]);
  assert.equal(w.appended.length, 0);
});

await checkAsync('alert-5 用户关掉规则 → 不报，但 st 是「已暂停」不是「依赖关闭」', async () => {
  const w = alertWorld({ alertPrefs: { mem: { value: 90, consecutive: 1, cooldownSec: 900, enabled: false } } });
  w.emitPoint('mem', 99);
  assert.equal(w.appended.length, 0);
  assert.equal(w.svc.ruleRows().find((r) => r.rule.id === 'r2').st.st, '已暂停');
});

await checkAsync('alert-6 未读计数：命中 +1，markRead 归零（驱动侧边栏蓝点）', async () => {
  const w = alertWorld();
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  await w.tick(); // 只能在 record 全落定后断言，否则"命中 +1 且只 +1"是撞对的
  assert.equal(w.svc.unread(), 1);
  w.svc.markRead();
  assert.equal(w.svc.unread(), 0);
});

await checkAsync('alert-7 procCpu 走 rows 判定，命中后 note 是进程名', async () => {
  const w = alertWorld({ alertPrefs: { procCpu: { value: 60, consecutive: 1, cooldownSec: 600, enabled: true } } });
  w.emitProc([{ pid: 1, name: 'render.exe', ws: 1, cpuPct: 88 }]);
  const hit = w.appended[0];
  assert.equal(hit.metric, 'procCpu');
  assert.equal(hit.note, 'render.exe');
});

await checkAsync('alert-8 落库失败不静默：转成 alert-store 事件 + logger.warn', async () => {
  const w = alertWorld({ storeFails: true });
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  await w.tick(); // append 的 rejection 在下一个微任务回合才落到 catch，不等就永远看不到这条事件
  const e = w.events.find((x) => x.type === 'alert-store');
  assert.ok(e, '必须有一条可见的失败事件');
  assert.match(e.error, /disk full/);
  assert.ok(w.events.some((x) => x.type === 'log'));
  assert.equal(w.svc.unread(), 1, '落库失败不影响未读计数');
});

await checkAsync('alert-9 宿主没给 storageDomain：仍评估仍计未读，但写与读都是可见的降级', async () => {
  const w = alertWorld({ noStore: true });
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91); w.emitPoint('cpu', 92);
  assert.equal(w.appended.length, 0);
  assert.equal(w.svc.unread(), 1, '没库也要报到人前');
  const e = w.events.find((x) => x.type === 'alert-store');
  assert.ok(e && /storageDomain/.test(e.error), '不可用必须是事件，不是沉默');
  assert.ok(w.events.some((x) => x.type === 'log'));
  const r = await w.svc.hits({ limit: 10 });
  assert.deepEqual(r, { rows: [], error: 'storageDomain 不可用' });
});

await checkAsync('alert-10 dispose 退订：之后的采样点不再产生任何事件，start() 两次也只订阅一次', async () => {
  const w = alertWorld();
  w.svc.start(); // 重复 start 必须被去重，否则一次尖峰会报两遍
  assert.equal(w.cbs.length, 1, `start() 两次不该留两条订阅，实有 ${w.cbs.length}`);
  w.emitPoint('cpu', 90); w.emitPoint('cpu', 91);
  w.svc.dispose();
  assert.equal(w.cbs.length, 0, 'dispose 必须真的从桩里退订');
  w.emitPoint('cpu', 92);
  assert.equal(w.appended.length, 0, 'dispose 后必须退订');
  assert.equal(w.svc.unread(), 0);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node test/alerts.test.mjs`
Expected: 先打 19 行结果（`rule-*`/`hit-*` 15 行 PASS + `merge-1..4` 4 行 FAIL，`R.mergeRules is not a function`），随后 ⑤段 的顶层 `await import('../lib/alerts/service.js')` 甩 `ERR_MODULE_NOT_FOUND` 结束进程 —— 因此**没有统计行**，退出码非 0。两种红都算失败确认到位。

- [ ] **Step 4: 写实现**

`lib/alerts/rules.js` 追加（放在 `evaluateProc` 之后）：

```js
/**
 * 用户阈值覆盖内置规则。
 *
 * 为什么用「覆盖」而不是「替换整张表」：内置规则的形状（op / metric / dep / 文案）
 * 与代码绑定 —— 让用户能改出一张不认识的规则表，等于把 ruleState 的依赖闸门变成可绕过的装饰。
 * 能被用户改的只有三个数 + 一个开关。
 */
export function mergeRules(builtin, prefsAlerts) {
  const over = prefsAlerts && typeof prefsAlerts === 'object' ? prefsAlerts : {};
  return builtin.map((rule) => {
    const o = over[rule.metric];
    if (!o) return { ...rule };
    const merged = { ...rule };
    if (Number.isFinite(o.value)) merged.value = o.value;
    if (Number.isInteger(o.consecutive) && o.consecutive >= 1) merged.consecutive = o.consecutive;
    if (Number.isInteger(o.cooldownSec) && o.cooldownSec >= 60) merged.cooldownMs = o.cooldownSec * 1000;
    if (o.enabled === false) merged.userOff = true;
    if (o.enabled === true) merged.userOff = false;
    return merged;
  });
}
```

`lib/alerts/service.js`：

```js
/**
 * 告警编排：订阅采集事件 → 闸门 → 纯函数判定 → 落库 + 推流 + 未读。
 *
 * 四条约定：
 *  1. **闸门在前，判定在后**（spec §3.5）：闸门读 `ruleState(...).on`，它一次覆盖
 *     "依赖源不是 on"与"用户把这条规则关了"两种不报的情形。只看 `dim` 的话，
 *     关了开关的规则照样会天天往时间线里写记录（alert-5 钉死）。
 *  2. 采集服务是上游，本服务只订阅它的事件（单向依赖，service.js 不 import api.js）。
 *  3. 一轮事件只取一次 `snapshot()`：状态与 series 必须来自同一帧，
 *     否则真机上是两次采样之间的撕裂视图，判定结果无法复现。
 *  4. 落库失败必须变成一条可见事件（spec §4.7 禁止静默 catch），并且不影响后续判定。
 */
import { DEFAULT_RULES, mergeRules, ruleState, evaluate, evaluateProc } from './rules.js';

export function createAlertService({ collect, hitStore, getRulePrefs, logger, now }) {
  const lastHitAt = new Map();
  const listeners = new Set();
  let unsub = null;
  let unreadCount = 0;

  const emit = (e) => listeners.forEach((cb) => cb(e));
  const rules = () => mergeRules(DEFAULT_RULES, getRulePrefs?.());
  const srcStates = (snap) => (snap?.sources ?? []).reduce((acc, r) => ({ ...acc, [r.key]: r.state }), {});

  async function record(hit) {
    lastHitAt.set(hit.ruleId, hit.t);
    unreadCount += 1;
    emit({ type: 'alert', hit });
    if (!hitStore?.available) {
      emit({ type: 'alert-store', error: 'storageDomain 不可用，触发记录未落盘' });
      logger?.warn?.(`[sysops] 告警落库跳过：存储不可用（${hit.ruleId}）`);
      return;
    }
    try {
      await hitStore.append(hit);
    } catch (e) {
      emit({ type: 'alert-store', error: String(e?.message ?? e) });
      logger?.warn?.(`[sysops] 告警落库失败：${e?.message ?? e}`);
    }
  }

  function onCollectEvent(ev) {
    if (ev?.type !== 'metrics' && ev?.type !== 'proc') return;
    const snap = collect.snapshot();
    const states = srcStates(snap);
    for (const rule of rules()) {
      if (rule.metric !== (ev.type === 'proc' ? 'procCpu' : ev.key)) continue;
      if (!ruleState(rule, states).on) continue;
      const hit = ev.type === 'proc'
        ? evaluateProc(rule, ev.rows, now(), lastHitAt.get(rule.id) ?? null)
        : evaluate(rule, snap.series?.[rule.metric], now(), lastHitAt.get(rule.id) ?? null);
      if (hit) void record(hit);
    }
  }

  return {
    start() {
      if (unsub) return;
      unsub = collect.onEvent(onCollectEvent);
    },
    ruleRows() {
      const states = srcStates(collect.snapshot());
      return rules().map((rule) => ({ rule, st: ruleState(rule, states) }));
    },
    async hits({ limit = 50 } = {}) {
      if (!hitStore?.available) return { rows: [], error: 'storageDomain 不可用' };
      return { rows: await hitStore.list({ limit }), error: null };
    },
    unread: () => unreadCount,
    markRead: () => { unreadCount = 0; },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    dispose() {
      if (unsub) { unsub(); unsub = null; }
      listeners.clear();
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/alerts.test.mjs`
Expected: `33/33 通过`（①②③段 15 条 = `rule-1..10` + `hit-1..5`，加 ④段 4 条 `merge-*`、⑤段 **14** 条 `alert-*`（原稿 10，修复轮 +3、控制器拆例 +1，见 Ruling-70 上方回填）），退出码 0。
`SKIP_LOCAL=1 node test/alerts.test.mjs` 同样 `33/33`（本文件无真机用例）。

**必须自证的四条变异**（改一行、跑一次、`git checkout` 还原；报告里要贴每条的红点用例名）：
1. 闸门 `!ruleState(rule, states).on` 换成 `.dim` → 红在 `alert-5`（用户关掉的规则仍在报）。
2. `unreadCount += 1` 从 `emit` 前挪到 `await hitStore.append(hit)` 之后 → 红在 `alert-6`（落定后数到 2）与 `alert-8`/`alert-9`（落库没成功就不计未读）。
   **这条依赖 alert-1/2/6 里的 `await w.tick()`**：不 settle 的话"命中 +1 且只 +1"是撞对的，变异跑不红（预检现采）。
3. `start()` 去掉 `if (unsub) return;` → 红在 `alert-10`（`cbs.length` 变 2）。
4. `dispose()` 去掉 `listeners.clear()`（只留 unsub）→ 这条**不该红**，也不该由本任务补测试：退订已经切断了唯一事件源，`listeners` 留着只是内存。反过来若去掉 `unsub()` 只清 listeners → 必须红在 `alert-10`（`appended` 变 1），这一条要跑。

旁路不许漂：`node test/collect.test.mjs` → `48/48`，`node test/prefs.test.mjs` → `13/13`，`node test/guard.test.mjs` → `19/19`。
提交信息草稿：`feat(sysops): 告警评估编排（on 闸门 + 未读计数 + 落库失败可见）`

---

## Task 11: `lib/clean/rules.js`（内置库）+ `lib/prefs/rules-store.js`

**Files:**
- Create: `lib/clean/rules.js`
- Create: `lib/prefs/rules-store.js`
- Modify: `lib/prefs/spec.js`（`cleanRulesRecord` 追加 `off` 字段，`items[]` 追加 `kind`）
- Modify: `test/prefs.test.mjs`（追加 ④段；②段 `prefs-4` 的正面夹具补一个 `kind` —— 见 Step 3 末尾的说明）

**Interfaces:**
- Consumes: `check`（Task 2）、`createPrefStore` / `cleanRulesRecord`（Task 3）
- Produces:
  - `BUILTIN_RULES: rule[]`（只收本机存在性复核**实测存在**的 12 条路径，2026-09-27 现采；`windows-err` 已因 `WER` 用户目录不存在剔除），`rule = { id, n, kind, dir, glob, ageDays, note, readonly: true, rel }` —— `dir`/`glob` 是**加载时按 `os.homedir()` 展开好的绝对路径**，Task 12 的 scanner 直接用，不再自己拼
  - `DEFAULT_OFF = ['packages-cache', 'playwright-browsers']`（首次读取即生效的默认关闭集，`rules-8/9/10` 的条数断言都要减去它）
  - `enabledBuiltin(offIds) → rule[]`、`RULE_KINDS = ['缓存','日志','旧版本','崩溃转储']`
  - `createRuleStore({ prefStore, logger? })` → `{ list(), userRules(), activeRules(), add(rule), remove(id), toggle(id, on) , error }`；**四个写口一律返回 `prefStore.write()` 的落库结果**（行级 `updatedAt` 由 prefs 盖，未声明字段已被 schema 丢弃 —— 返回入参等于对调用方撒谎）；**`add()` 还拒绝「用户规则 id 撞内置 id」**（`RULE_ERROR.BAD_RULE`）—— `toggle` 按内置 id 寻址、`remove` 按 `items` 寻址，撞名会让一条规则同时存在于两个寻址空间（评审 F-1，`rules-11` 钉住）
  - `RULE_ERROR`（`GUARD_DENY` `UNKNOWN_ID` `BAD_RULE` `STORE_UNAVAILABLE`）
  - `cleanRulesRecord` 的 `items[]` 必须**声明 `kind`**（`requiredString`），否则 `arrayOf` 会把它静默丢掉 ⇒ 规则存进去、读出来就没有分类，而 `validate()` 又要求 `kind` 非空 —— 那条规则会在**每次 `activeRules()` 读取时抛错**，比写不进去更糟

- [ ] **Step 1: 写失败的测试（④段，接进 `test/prefs.test.mjs`）**

```js
/* ④段：内置规则库 + 本机规则仓储 */
const CR = await import('../lib/clean/rules.js');
const { createRuleStore, RULE_ERROR } = await import('../lib/prefs/rules-store.js');

check('rules-1 内置库只收本机实测存在的路径（凭印象列路径 = 清单永远 0 命中）', () => {
  assert.equal(CR.BUILTIN_RULES.length, 12); // WER 实测不存在，见 Step 3 下方的现采说明
  for (const r of CR.BUILTIN_RULES) {
    assert.ok(/^[a-z0-9._-]+$/.test(r.id), `规则 id 非法：${r.id}`);
    assert.ok(CR.RULE_KINDS.includes(r.kind), `${r.id} 的 kind 不在表内：${r.kind}`);
    assert.ok(r.readonly === true, '内置规则不可被用户改');
    assert.ok(r.ageDays >= 0);
  }
  // 明确排除：实测不存在的 7 条不能混进来
  const banned = ['Crashpad', 'NuGet', '.npm', '.pnpm-store', 'WeChat Runtime'];
  for (const b of banned) {
    assert.ok(!CR.BUILTIN_RULES.some((r) => r.dir.includes(b) || r.glob.includes(b)), `实测不存在的路径进了内置库：${b}`);
  }
  // DEFAULT_OFF 里的 id 必须真实存在：拼错一个字母 = 那条默认关永远关不上，且不会有任何报错
  for (const id of CR.DEFAULT_OFF) {
    assert.ok(CR.BUILTIN_RULES.some((r) => r.id === id), `DEFAULT_OFF 引用了不存在的内置规则 id：${id}`);
  }
});

check('rules-2 每条内置规则的字面量与 glob 都能过 guard（自产规则先过红线）', () => {
  const { check } = guardMod;
  for (const r of CR.BUILTIN_RULES) {
    const a = check(r.dir, { mode: 'path' });
    assert.equal(a.allow, true, `${r.id} 的 dir 被 guard 拒了：${a.code} ${a.why}`);
    const b = check(r.glob, { mode: 'glob' });
    assert.equal(b.allow, true, `${r.id} 的 glob 被 guard 拒了：${b.code} ${b.why}`);
  }
});

check('rules-3 enabledBuiltin 按 offIds 过滤，内置开关不改动常量表', () => {
  const before = CR.BUILTIN_RULES.length;
  const on = CR.enabledBuiltin([CR.BUILTIN_RULES[0].id]);
  assert.equal(on.length, before - 1);
  assert.equal(CR.BUILTIN_RULES.length, before);
});

check('rules-4 clean_rules 记录形状：off 是内置规则 id 数组，脏形状进不了库', () => {
  const t = prefsMod.cleanRulesRecord;
  const r = t.parse({ items: [], off: ['temp-user', 'npm-cache'], updatedAt: 1 });
  assert.deepEqual(r.off, ['temp-user', 'npm-cache']);
  assert.throws(() => t.parse({ items: [], off: 'temp-user' }), /off/);
  assert.throws(() => t.parse({ items: [], off: [1] }), /off/);
  // kind 必须在 schema 里声明：arrayOf 会丢未声明字段，丢了以后 validate() 会在每次读规则时抛错
  const one = t.parse({ items: [{ id: 'u-1', n: 'x', glob: 'C:\\x\\*', ageDays: 1, kind: '缓存' }], off: [], updatedAt: 1 });
  assert.equal(one.items[0].kind, '缓存', 'kind 没存住 = 被 arrayOf 静默丢字段');
  assert.throws(() => t.parse({ items: [{ id: 'u-1', n: 'x', glob: 'C:\\x\\*', ageDays: 1 }], off: [], updatedAt: 1 }), /kind/);
});

const userRule = (over = {}) => ({
  id: 'u-1', n: 'pnpm 未引用包', glob: 'C:\\Users\\gongj\\AppData\\Local\\pnpm\\store\\*',
  ageDays: 30, kind: '缓存', ...over,
});

const ruleWorld = (over = {}) => {
  // **判键在不在，不判值**：`ruleWorld({ facility: undefined })` 要的就是"宿主没有 storageDomain"，
  // 写成 `over.facility === undefined ? 内存桩 : over.facility` 会把它当成"没传"而塞进内存桩，
  // rules-10 就什么也没测到（③段 prefs-9 踩过同一处，注释在 `test/prefs.test.mjs:122-127`）。
  const facility = 'facility' in over ? over.facility : createMemoryFacility();
  const prefStore = createPrefStore({ getFacility: () => facility, now: () => 1000, logger: { warn() {} } });
  return { prefStore, store: createRuleStore({ prefStore, logger: { warn() {} } }) };
};

await checkAsync('rules-5 新增本机规则：合法 glob 入库，返回归一化全量', async () => {
  const w = ruleWorld();
  const out = await w.store.add(userRule());
  assert.equal(out.items.length, 1);
  // updatedAt 是**行级**戳（record 只有行级），由 prefStore.write 盖；断成 items[0].updatedAt 会永远 undefined
  assert.equal(out.updatedAt, 1000);
  assert.equal(out.items[0].kind, '缓存', '走完整写-读一轮回来看 kind 存没存住');
});

await checkAsync('rules-6 命中红线的规则在**写入阶段**就被拒（不是执行阶段才失败）', async () => {
  const w = ruleWorld();
  for (const bad of [
    'C:\\Windows\\Temp\\*',
    'C:\\$Recycle.Bin\\S-1-5-21\\*',
    'C:\\Program Files\\SomeApp\\*',
    'C:\\Users\\gongj\\AppData\\Local\\Temp\\..\\..\\..\\*',
    'C:\\Users\\gongj\\AppData\\Local\\**',
  ]) {
    await assert.rejects(
      () => w.store.add(userRule({ glob: bad })),
      (e) => e.code === RULE_ERROR.GUARD_DENY && e.why.length > 0,
      `应拒绝写入：${bad}`,
    );
  }
  const all = await w.store.list();
  assert.equal(all.items.length, 0, '被拒的规则不得留半条');
});

await checkAsync('rules-7 展开名不采信：规则里的 glob 必须已展开成绝对路径', async () => {
  const w = ruleWorld();
  await assert.rejects(() => w.store.add(userRule({ glob: '%LOCALAPPDATA%\\pnpm\\*' })), (e) => e.code === RULE_ERROR.GUARD_DENY);
});

await checkAsync('rules-8 activeRules = 开启的内置 + 用户规则，按 guard 过滤后才交给扫描器', async () => {
  const w = ruleWorld();
  await w.store.add(userRule());
  const rows = await w.store.activeRules();
  // 从未写入过 ⇒ off 取 DEFAULT_OFF，所以「开着的内置」是 12 - DEFAULT_OFF.length，不是 12
  assert.equal(rows.filter((r) => r.readonly).length, CR.BUILTIN_RULES.length - CR.DEFAULT_OFF.length);
  assert.equal(rows.filter((r) => !r.readonly).length, 1);
  assert.ok(rows.every((r) => r.glob && r.ageDays >= 0));
});

await checkAsync('rules-9 toggle 内置规则写入 off；remove 删用户规则，未知 id 报 UNKNOWN_ID', async () => {
  const w = ruleWorld();
  await w.store.add(userRule());
  const first = CR.BUILTIN_RULES[0].id;
  // 本例假设"首条内置规则默认是开的"；哪天它进了 DEFAULT_OFF，关-开两步就变成空操作而仍然全绿
  assert.ok(!CR.DEFAULT_OFF.includes(first), `首条内置规则 ${first} 已默认关闭，本例失效`);
  await w.store.toggle(first, false);
  let all = await w.store.list();
  // 从未写入时 off 以 DEFAULT_OFF 打底，所以断"包含"而不是断"等于那一条"
  assert.deepEqual([...all.off].sort(), [...CR.DEFAULT_OFF, first].sort());
  await w.store.toggle(first, true);
  assert.deepEqual([...(await w.store.list()).off].sort(), [...CR.DEFAULT_OFF].sort());
  await w.store.remove('u-1');
  assert.equal((await w.store.list()).items.length, 0);
  await assert.rejects(() => w.store.remove('u-404'), (e) => e.code === RULE_ERROR.UNKNOWN_ID);
});

await checkAsync('rules-10 存储不可用时 error 有值、activeRules 只剩内置（清理页仍可用，但看不到本机规则）', async () => {
  const w = ruleWorld({ facility: undefined });
  const rows = await w.store.activeRules();
  // 同样减去默认关那两条：无库时读到的 off 就是 DEFAULT_OFF，不是空数组
  assert.equal(rows.length, CR.BUILTIN_RULES.length - CR.DEFAULT_OFF.length);
  assert.equal(w.store.error, RULE_ERROR.STORE_UNAVAILABLE);
});

await checkAsync('rules-11 用户规则不许占用内置 id（撞名会拆成两个寻址空间：toggle 关内置、清单里却留着同 id 的用户条目）', async () => {
  const w = ruleWorld();
  const builtinId = CR.BUILTIN_RULES[0].id;
  // 只换 id，glob 仍是合法的 pnpm store —— 红必须归因到撞名检查，不能是 guard 先拒
  await assert.rejects(() => w.store.add(userRule({ id: builtinId })), (e) => e.code === RULE_ERROR.BAD_RULE);
  assert.equal((await w.store.userRules()).some((r) => r.id === builtinId), false, '撞名的用户规则不能落库');
});
```

（④段用到的 `guardMod` / `prefsMod` 在段首补两行 import：`const guardMod = await import('../lib/clean/guard.js');` 与 `const prefsMod = await import('../lib/prefs/spec.js');` —— 现有 ②段是按名字解构导入的，这里要整模块句柄给循环里用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/prefs.test.mjs`
Expected: `rules-1` 起 `ERR_MODULE_NOT_FOUND` 指向 `lib/clean/rules.js`。

- [ ] **Step 3: 写实现**

`lib/clean/rules.js` —— 12 条全部来自本机存在性复核（2026-09-27 现采，见 Step 3 末尾的读数块；`windows-err` 因 `WER` 用户目录不存在已剔除），仓库里只存**相对用户目录的段串 `rel`**（不把机器名焊进代码），但**导出的 rule 对象必须带加载时展开好的 `dir` / `glob`**：rules-1/2/8/10 与 `activeRules()` 的 guard 复检都要读 `r.dir` / `r.glob`，只给 `rel` 会让四条用例一起红（预检实测：原稿 ④段 10 例红 6 例，其中 4 例死在这里），Task 12 的 scanner 也不必再展开一遍：

```js
import os from 'node:os';
import path from 'node:path';

export const RULE_KINDS = ['缓存', '日志', '旧版本', '崩溃转储'];

const HOME = os.homedir();

/** `rel` 用 `/` 分隔、相对 `os.homedir()`；`dir`/`glob` 是加载时展开出来的本机绝对路径。 */
const mk = (id, n, kind, rel, ageDays, note) => {
  const dir = path.join(HOME, ...rel.split('/'));
  return { id, n, kind, readonly: true, ageDays, note, rel, dir, glob: path.join(dir, '*') };
};

export const BUILTIN_RULES = [
  mk('temp-user', '用户临时目录', '缓存', 'AppData/Local/Temp', 3, '系统与应用共用，正在占用的文件会被跳过'),
  mk('win-explorer', '资源管理器缩略图与图标缓存', '缓存', 'AppData/Local/Microsoft/Windows/Explorer', 7, '重建缓存的代价是下次开文件夹慢一点'),
  mk('edge-cache', 'Edge 浏览器缓存', '缓存', 'AppData/Local/Microsoft/Edge/User Data/Default/Cache', 14, '不含登录态与密码；正在运行的 Edge 会锁住部分文件'),
  mk('vscode-cache', 'VS Code 缓存', '缓存', 'AppData/Roaming/Code/Cache', 14, '不含扩展与配置'),
  mk('npm-cache', 'npm 下载缓存', '缓存', 'AppData/Local/npm-cache', 30, '清掉后首个 `npm i` 需重新下载'),
  mk('pip-cache', 'pip 下载缓存', '缓存', 'AppData/Local/pip/Cache', 30, ' Wheels 会重新下载'),
  mk('crash-dumps', '崩溃转储', '崩溃转储', 'AppData/Local/CrashDumps', 7, '只影响事后分析，除非正要查崩溃'),
  mk('packages-cache', 'UWP 包缓存', '缓存', 'AppData/Local/Packages', 60, '范围较大，默认关闭；展开后逐项看命中量再勾'),
  mk('local-cache', '通用 .cache 目录', '缓存', '.cache', 30, '开发工具通用缓存'),
  mk('wechat-cache', '微信文件缓存', '缓存', 'AppData/Roaming/Tencent/WeChat', 30, '含图片视频缓存，聊天记录不在此目录'),
  mk('dingtalk-cache', '钉钉缓存', '缓存', 'AppData/Roaming/DingTalk', 30, '含图片与文件缓存，不含登录态'),
  mk('playwright-browsers', 'Playwright 浏览器缓存', '旧版本', 'AppData/Local/ms-playwright', 90, '删掉后跑 `npx playwright install` 需重新下载'),
];

/** 高范围或低频收益的规则默认关：off 由 clean_rules.off 数组持久化。 */
export const DEFAULT_OFF = ['packages-cache', 'playwright-browsers'];

export function enabledBuiltin(offIds = []) {
  const set = new Set(Array.isArray(offIds) ? offIds : []);
  return BUILTIN_RULES.filter((r) => !set.has(r.id)).map((r) => ({ ...r }));
}
```

> **两处与「实测修正」的差异，执行时必须照下面写并在代码注释里保留：**
>
> 1. **`windows-err`（`AppData/Local/Microsoft/Windows/WER`）不入内置库 —— 实测不存在。** 2026-09-27 现采（`node tmp/t11wer.mjs`，读数 `tmp/t11-wer.txt`）：`WER`、`WER/ReportQueue`、`WER/ReportArchive` 三条全 `ENOENT`；Windows 的错误报告实际落在 `C:/ProgramData/Microsoft/Windows/WER`，那是**系统存储、不在用户目录下**，既违反"内置库只存相对 `os.homedir()` 的段串"这条约束，也踩红线附近的应用能力（属主与 ACL）。所以 `BUILTIN_RULES` 是 **12 条**，`rules-1` 的条数断言写 12。**条数跟着实测走，不许反过来改实测。** 剔除后内置库里暂时没有 `日志` 类规则，`RULE_KINDS` 仍保留四类 —— 它是**用户自建规则**的分类表（Task 22 清理页的分类筛选按它渲染），不是内置库的投影，不要因为"没人用"就删。
> 2. **`Package Cache` 不入内置库（判定，不是漏收）**：`C:/ProgramData/Package Cache` 实测存在，但它是 Windows Installer 的包缓存，删掉会让已装程序的 repair / 卸载失败 —— 红线之外还要留出修复能力。`rules-1` 的 `banned` 列表按上面第 1 条同步（`Crashpad` / `NuGet` / `.npm` / `.pnpm-store` / `WeChat Runtime` 五条实测不存在，不得混进来）。
>
> 其余 12 条实测存在（`tmp/t11-wer.txt` 同轮读数）：`Temp` 6524 条目、`Explorer` 33 条目（抽样 79 MB）、`CrashDumps` 3 文件（抽样 141 MB）、`ms-playwright` / `Packages` / `.cache` / `WeChat` / `Edge/.../Cache` / `Code/Cache` / `pip/Cache` 均存在。**注意**：多条规则在 depth-1 只有子目录没有文件（缓存目录普遍套一层，如 `Edge/.../Cache/Cache_Data`）—— 这是常态，不是误收；深度遍历与"目录算不算命中"由 Task 12 的 scanner 裁决，本任务只保证路径存在且过 guard。

`lib/prefs/rules-store.js`：

```js
/**
 * 本机清理规则的读写口。
 *
 * 与偏好仓储（store.js）的分工：store 管"怎么存"，这里管"存之前先过 guard"。
 * 校验阶段就拒绝（spec §4.5），因为让用户存进去一条永远删不掉的规则，
 * 比拒绝写入难得查得多。
 */
import { check } from '../clean/guard.js';
import { BUILTIN_RULES, DEFAULT_OFF, enabledBuiltin } from '../clean/rules.js';

export const RULE_ERROR = {
  GUARD_DENY: 'SYSOPS_RULE_GUARD_DENY',
  UNKNOWN_ID: 'SYSOPS_RULE_UNKNOWN_ID',
  BAD_RULE: 'SYSOPS_RULE_BAD_RULE',
  STORE_UNAVAILABLE: 'SYSOPS_RULE_STORE_UNAVAILABLE',
};

const err = (code, why) => Object.assign(new Error(why), { code, why });

export function createRuleStore({ prefStore, logger }) {
  /** 从未写入 / 存储不可用时的空行形状。**只能有一处定义** —— 见 Step 6 的 V5。 */
  const emptyRow = () => ({ items: [], off: DEFAULT_OFF.slice(), updatedAt: 0 });

  const read = async () => {
    if (!prefStore?.available) return null;
    try {
      const row = await prefStore.read('clean_rules');
      return row ?? emptyRow();
    } catch (e) {
      logger?.warn?.(`[sysops] 本机清理规则读取失败：${e.message}`);
      return null;
    }
  };

  const write = async (next) => {
    if (!prefStore?.available) throw err(RULE_ERROR.STORE_UNAVAILABLE, 'storageDomain 不可用，规则只能只读');
    // 必须返回 prefStore 落库后那一份，不是手里的 `next`：行级 `updatedAt` 由 prefStore 盖，
    // 且未声明字段已被 schema 丢弃 —— 返回入参会让调用方以为自己的对象原样存住了。
    return prefStore.write('clean_rules', next);
  };

  const validate = (r) => {
    if (!r || typeof r !== 'object') throw err(RULE_ERROR.BAD_RULE, '规则必须是对象');
    for (const k of ['id', 'n', 'glob', 'kind']) {
      if (typeof r[k] !== 'string' || r[k].trim() === '') throw err(RULE_ERROR.BAD_RULE, `规则.${k} 必须是非空字符串`);
    }
    if (!Number.isInteger(r.ageDays) || r.ageDays < 0) throw err(RULE_ERROR.BAD_RULE, '规则.ageDays 必须是 ≥0 的整数');
    const g = check(r.glob, { mode: 'glob' });
    if (!g.allow) throw err(RULE_ERROR.GUARD_DENY, g.why);
    return r;
  };

  return {
    get error() {
      return prefStore?.available ? null : RULE_ERROR.STORE_UNAVAILABLE;
    },
    async list() {
      return (await read()) ?? emptyRow();
    },
    async userRules() {
      return (await this.list()).items;
    },
    async activeRules() {
      const row = await this.list();
      return [...enabledBuiltin(row.off), ...row.items].map((r) => validate(r) && r);
    },
    async add(rule) {
      validate(rule);
      // 内置 id 是 `toggle` 的寻址空间，用户规则的 `items` 是 `remove` 的寻址空间 —— 两者撞名时
      // `toggle(id,false)` 关的是内置、`activeRules()` 里却还留着同 id 的用户条目，Task 15/22 按 id 对账会双计。
      if (BUILTIN_RULES.some((r) => r.id === rule.id)) throw err(RULE_ERROR.BAD_RULE, `规则 id ${rule.id} 是内置规则 id，用户规则请另取 id（内置规则用 toggle 开关）`);
      const row = await this.list();
      if (row.items.some((x) => x.id === rule.id)) throw err(RULE_ERROR.BAD_RULE, `规则 id 重复：${rule.id}`);
      return write({ ...row, items: [...row.items, rule] });
    },
    async remove(id) {
      const row = await this.list();
      if (!row.items.some((x) => x.id === id)) throw err(RULE_ERROR.UNKNOWN_ID, `没有 id 为 ${id} 的本机规则（内置规则请用开关停用）`);
      return write({ ...row, items: row.items.filter((x) => x.id !== id) });
    },
    async toggle(id, on) {
      const row = await this.list();
      if (!BUILTIN_RULES.some((r) => r.id === id)) throw err(RULE_ERROR.UNKNOWN_ID, `${id} 不是内置规则，删除请用 remove()`);
      const off = new Set(row.off);
      if (on) off.delete(id); else off.add(id);
      return write({ ...row, off: [...off] });
    },
  };
}
```

`lib/prefs/spec.js` 的 `cleanRulesRecord` 改两处（`arrayOfItem` / `requiredString` / `optionalString` 该文件已经 import 了，不用新增引入）：

1. 追加一行 `off: arrayOfItem('clean_rules.off', requiredString('off[]'))`，并在 `cleanRulesRecord` 的注释里写明「`off` 只装内置规则 id」。
2. `items` 的 item schema 里追加 `kind: requiredString('items[].kind')`（放在 `ageDays` 之后、`note` 之前）。**这条不是可选的润色**：`arrayOf` 逐元素走 item schema，未声明的字段会被**静默丢弃**（`lib/kv-schema.js:199-221`）—— 不声明 `kind`，规则写进去再读出来就没有分类，而 `rules-store.js` 的 `validate()` 要求 `kind` 非空 ⇒ 每次 `activeRules()` 都抛 `BAD_RULE`，**清理页整页打不开**。用 `required` 而不是 `optional`：写入口已经强制非空，schema 与校验器必须同一口径；`optional` 只会把"漏了 kind"推迟到读取阶段炸。

`rules-4` 钉 schema 层的 kind 往返与缺失拒绝，`rules-5` 钉走完整写-读一轮回来的 kind —— 两条都要，只留一条时"删掉 kind 声明"这种破坏只会红一处，容易被当成偶发。

3. **连带改动：`test/prefs.test.mjs` 的 `prefs-4`（②段，Task 3 已评审通过）正面夹具要补 `kind`。** 它第 112 行 parse 的 item 只有 `id/n/glob/ageDays` —— 写它的时候 `kind` 还不在形状里。加了必填 `kind` 之后这条会红在 `items[].kind 必填`。**改夹具，不改断言**：`{ id: 'u-1', n: '浏览器缓存', glob: '…\\Temp\\*', ageDays: 7, kind: '缓存' }`，三条拒绝路径（缺 glob / ageDays 越界）与 `assert.equal` 全部原样保留。这是 schema 演进的必然连带，不是"顺手重构已评审测试" —— 报告里要单独点名这条改了什么、为什么。

- [ ] **Step 4: 跑测试确认通过（WER 现采已在计划期完成，不必再测）**

控制器 2026-09-27 已现采完存在性复核（`node tmp/t11wer.mjs` → `tmp/t11-wer.txt`）：`WER` / `WER/ReportQueue` / `WER/ReportArchive` 全 `ENOENT`，其余 12 条目录全部存在。结论已经写进 Step 3 的常量表与 `rules-1` 断言，**执行者不要再"按结果决定是否收 `windows-err`"** —— 那条已经不在表里了。换机器或换用户时（`os.homedir()` 不同）才需要重跑 Step 5 的探针，并同样遵守"条数跟着实测走"。

Run: `node test/prefs.test.mjs`
Expected: `24/24 通过`（①3 ②4 ③6 ④11），退出码 0。
旁路不许漂（同一轮现跑，不许引用上一轮）：`node test/alerts.test.mjs` → **33/33**；`node test/guard.test.mjs` → **19/19**；`SKIP_LOCAL=1 node test/collect.test.mjs` → **48/48**。

- [ ] **Step 5: 真机复核内置规则确实命中条目（不是只存在目录）**

**禁止 `node -e "…"`**（本机 bash 会吃掉路径里的反斜杠转义，探针脚本已在 `tmp/t11probe.mjs` 落好，直接跑）：

```bash
node tmp/t11probe.mjs > tmp/t11-probe.txt 2>&1
```
再 `Read tmp/t11-probe.txt`。期望逐条对上（2026-09-27 本机读数）：
- **12 条全部"存在"，输出里没有任何 `ENOENT`**。出现 `ENOENT` = 存在性复核过期，当场按「现采优先」修正常量表并同步 `rules-1` 的条数断言。
- 输出第一行是 `规则条数 12  默认关 packages-cache,playwright-browsers` —— 条数与默认关集要当轮打印出来，别靠记忆。
- **depth1文件 为 0 的条目是常态**（缓存目录普遍套一层子目录，如 `Edge/.../Cache/Cache_Data`）：`edge-cache` / `vscode-cache` / `pip-cache` / `packages-cache` / `local-cache` / `wechat-cache` / `playwright-browsers` 这 7 条本机就是 0。汇报里点名即可，**不要**因此删规则，也**不要**在 `rules-N` 里断"每条都至少有一个文件"（那会把 Task 12 的递归遍历契约提前焊死）。
- 大条目两条可对照：`temp-user` 数千条目、`win-explorer` 与 `crash-dumps` 有实测 MB 量级。
- 末尾"排除判定"块：`Package Cache` 显示"存在"是**预期**（判定为不入库），其余显示 `ENOENT`。

- [ ] **Step 6: 变异自证（五次「破坏 → 跑红 → 还原 → 重跑全绿」，写入交付报告）**

每条都要有当轮 `git diff --numstat` 证明确实动了字节，还原后 `git status --short -- lib test` 必须净。**红点归因是控制器预检实测的，照抄不算取证** —— 自己要跑出同一红点才算过。

| 编号 | 破坏 | 预期红在 | 为什么这条值得破坏 |
|---|---|---|---|
| V1 | `mk()` 里不再生成 `glob`（只留 `dir`） | `rules-2` | 内置库若不加载时展开，`activeRules()` 的 guard 复检与 Task 12 扫描器都会拿到 `undefined` |
| V2 | `write()` 里**保留落库**、只把返回值换成入参：`await prefStore.write('clean_rules', next); return next;` | `rules-5`（只有 `out.updatedAt` 那一条断言抓到） | 落库那份与入参那份的差别只剩行级戳与被丢字段 —— 断言必须钉到这一格，否则"返回自己的对象"这种撒谎没人管 |
| V3 | `validate()` 去掉 `check(r.glob, { mode: 'glob' })` | `rules-6` **+** `rules-7` | 红线唯一裁决点：存进去一条永远执行不了的规则，比拒绝写入难查得多（`rules-7` 的未展开 `%LOCALAPPDATA%` 同属 guard 职责） |
| V4 | `items` schema 删掉 `kind` 声明 | `rules-4` + `rules-5` **+** `rules-8` | `arrayOf` 静默丢未声明字段 ⇒ 读回来没分类 ⇒ `validate()` 每次读都抛 ⇒ **`activeRules()` 直接 reject，清理页整页打不开**（`rules-8` 红就是这条链的实测证据） |
| V5 | `emptyRow()` 的 `off` 换成 `[]` | `rules-8` + `rules-9` + `rules-10` | 默认关（`Packages` 147 子目录、`ms-playwright` 重装代价大）没有打底就等于没实现 |
| V6（评审 F-1 连带） | 删掉 `add()` 里「用户规则 id 撞内置 id」那一行拒绝 | **只红 `rules-11`** | 两个寻址空间撞名 ⇒ `toggle` 关内置、清单留同 id 用户条目，Task 15/22 按 id 对账双计 |

**V2 与 V5 的写法是实测修出来的，别退回直觉版本：**
- V2 最初写成 `return next;`（把 `prefStore.write` 整个删掉）→ 红 `rules-5`+`rules-8`+`rules-9`，看着很承重，其实测的是"不写库"。**必须** `await` 掉真实写入再换返回值，才只剩 `updatedAt` 那一格差异。
- 空行形状原先在 `read()` 和 `list()` 各写了一份字面量 ⇒ V5 只改 `read()` 时 `rules-10` **不红**（无库路径走的是 `list()` 那份默认）。这就是"同一默认值两处定义"可以让一半默认行为无声失效的活证 —— 所以 `emptyRow()` 单点定义，两处引用。
- V4 与 V2 的红点都含 `rules-5`，**这是实测事实，不是笔误** —— 别为了"每条变异红点互不相同"去改断言。

提交信息草稿：`feat(sysops): 内置清理规则库与本机规则仓储（写入前过 guard）`

## Task 12: `lib/clean/scanner.js` —— 只读遍历 + 进度 + 可停止

**Files:**
- Create: `lib/clean/scanner.js`
- Create: `test/clean.test.mjs`（本任务建文件，写 ①段）

**Interfaces:**
- Consumes: `check`（Task 2，**同步**函数）、Task 11 已经展开好的 `dir` / `glob`（内置库带绝对 `dir`+`glob`；**本机规则只有 `glob`，没有 `dir`** —— `cleanRulesRecord.items[]` 的形状是 id/n/glob/kind/ageDays/note，`activeRules()` 的断言只钉 `r.glob && r.ageDays>=0`）、注入的 `fsMod`
- Produces:
  - `expandRule(rule, { home }) → {…rule, dir, pattern}`（`dir` 的取值优先级写死：**`rule.dir` > `path.dirname(rule.glob)` > `path.join(home, rel)`**；`pattern` 优先 `rule.pattern`，否则取 `glob` 最后一个 `\` 之后的段，段里没有 `*`/`?` 时取 `'*'`）
  - `globToRegExp(pattern) → RegExp`（只支持单层 `*` / `?`，`**` 直接抛 —— guard 已拒，这里是第二道）
  - `riskOf(rule) → { level: 'low'|'mid', why }`
  - `createScanner({ fsMod, logger, now, onProgress, progressIntervalMs = 250, maxEntries = 200000, maxDepth = 12 })` → `{ scan(rules, opts?) → Promise<ScanResult>, stop() }`（**没有 `osMod`** —— 见 Ruling-69 的 C8）
  - `ScanResult = { items: [item], totals: { n, bytes }, walked, hit, skipped: [{dir, code, why}], stopped: boolean, truncated: boolean, at }`
  - `item = { id, ruleId, ruleName, kind, path, size, count, atime, mtime, risk: {level, why} }`（**清单快照的唯一数据源**，Task 13 冻结它，Task 15 只按 `item.id` 找回路径）

> **Ruling-69（控制器预检裁定，2026-09-27 现采 `node tmp/t12probe.mjs` → `tmp/t12-probe.txt`）** —— 这一段的原稿与 Task 11（Ruling-66 的 D1）正面撞车，下面每一处改动都标了理由，执行者**按改后的写，别按直觉改回去**：
>
> - **C1 展开责任归属**：原稿 `expandRule` 无条件用 `path.join(home, rel)` 重算 `dir`，而 Task 11 导出的内置 rule **已经带绝对 `dir`**（重算会把 `os.homedir()` 的机器名再焊一遍，且 `rel` 在 cln-6 那种夹具里被故意置 `undefined`）；本机规则反过来**只有 `glob` 没有 `dir`**。所以取值顺序必须是 `dir` > `dirname(glob)` > `join(home, rel)`。现采：`path.dirname('C:\Users\gongj\AppData\Local\pnpm\store\*')` → `C:\Users\gongj\AppData\Local\pnpm\store`，送 `check(…, {mode:'path'})` = `allow=true`。
> - **C2 guard 调用形态**：Task 2 的导出是**同步** `check(raw, opts)`，原稿的 `await guardCheck(...)` 那个名字不存在、`await` 是噪音。改成 `check(rule.dir, { mode: 'path' })`。现采：`C:\Windows\Temp`（正反斜杠都一样）→ `code=GUARD_SYSTEM_DIR` / `branch=b-system-dir`，所以 cln-6 的 `/GUARD/` 断言成立。**glob 的 `mode:'glob'` 复检不在本任务** —— Task 11 的 `validate()` 与 `activeRules()` 已经过那道，扫描器只补 `dir`，不要写出第二套红线口径。
> - **C5 `atime` 口径由 cln-2 钉死**：条目 `atime` = 条目内文件 `atimeMs` 的**最大值**（=最近一次被动过），判定 `atime <= now - ageDays*DAY`。这不是"二选一"：**按 min 取值会让 cln-2 直接红**（`mixed` 的 `min=ago(40)` 能过 3 天线，而 cln-2 要求 `mixed` 不命中）。所以"整条都够老"= 条目内**最新**那个文件也够老。原稿 cln-3 断的 `ago(30)` 是 min，笔误，已改成 `ago(20)`。
> - **C7 假时钟必须能推进**：冻结 `now: () => NOW` 下第一次 `NOW-0>=1000` 成立、之后 `lastEmit=NOW` 让 `NOW-NOW=0>=1000` 永假 ⇒ 恒 1 帧。原断言 `>0 && <60` 只挡得住"每条目都推"，挡不住"推一帧就不推了"。改成 `world()` 收 `opts.now` + 用例里每条 `every` 推进 1ms，下界提到 `>= 2`：不节流=3000 帧（红），只推一次=1 帧（红），双向都堵。
> - **C8 删 `osMod`**：C1 之后 scanner 内部没有任何地方读 `os.homedir()`（内置带绝对 `dir`，本机规则走 `dirname(glob)`）。留着就是"看起来可注入、其实是死参"。`expandRule` 的 `{ home }` 参数**保留**（`rel` 兜底路径的唯一 home 来源，cln-1 就在测这条兜底）。
> - **C10 `expandRule` 用 `node:path` 而不是注入的 `fsMod.join`**：它是模块级函数，拿不到 `createScanner` 的注入参数；cln-1 期望的带反斜杠 `dir` 正是 win32 `path.join` 的结果。
> - **C11 形状错误不另立分支**：`dir` 既缺 `dir` 又缺 `glob` 又缺 `rel` 时送 `check(undefined,…)` → 现采 `code=GUARD_BAD_INPUT`（空串同），已经被 `skipped` 的 `/GUARD/` 通道接住。为它加 `code:'RULE_SHAPE'` 是第三条闸口，不写。


- [ ] **Step 1: 写失败的测试**

`test/clean.test.mjs`（harness 见上文，段①用假文件系统，零真 IO）：

```js
const SC = await import('../lib/clean/scanner.js');

/** 假 FS：tree 是 { 绝对路径: {size?, children?: {名: {size, atimeMs, mtimeMs}}} }，扁平化更好写。 */
function fakeFs(entries, opts = {}) {
  // entries: [{ path, size, atimeMs, mtimeMs, dir? }]
  const map = new Map(entries.map((e) => [e.path.replace(/[\\/]+$/, ''), e]));
  const join = (...a) => a.join('/').replace(/\/+/g, '/');
  const denied = new Set(opts.denied ?? []);
  return {
    join,
    readdirSync(dir, { withFileTypes } = {}) {
      const key = dir.replace(/[\\/]+$/, '');
      if (denied.has(key)) throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' });
      const out = [];
      for (const [p, e] of map) {
        if (p === key || !p.startsWith(key + '/')) continue;
        const rest = p.slice(key.length + 1);
        if (!rest.includes('/')) {
          out.push({ name: rest, isDirectory: () => e.dir === true, isFile: () => e.dir !== true });
        } else if (!out.some((x) => x.name === rest.split('/')[0])) {
          const name = rest.split('/')[0];
          out.push({ name, isDirectory: () => true, isFile: () => false });
        }
      }
      if (!out.length && !map.has(key)) throw Object.assign(new Error('找不到路径'), { code: 'ENOENT' });
      return out;
    },
    statSync(p) {
      const key = p.replace(/[\\/]+$/, '');
      const e = map.get(key);
      if (!e) throw Object.assign(new Error('找不到路径'), { code: 'ENOENT' });
      if (denied.has(key)) throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' });
      return { size: e.size ?? 0, atimeMs: e.atimeMs ?? 0, mtimeMs: e.mtimeMs ?? 0, isFile: () => e.dir !== true, isDirectory: () => e.dir === true };
    },
    __map: map,
  };
}

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const ago = (d) => NOW - d * DAY;

const rule = (over = {}) => ({
  id: 'temp-user', n: '用户临时目录', kind: '缓存', ageDays: 3, readonly: true,
  rel: 'AppData/Local/Temp', dir: 'C:/Users/gongj/AppData/Local/Temp', pattern: '*', ...over,
});

const tree = (over = {}) => ([
  { path: 'C:/Users/gongj/AppData/Local/Temp', dir: true },
  { path: 'C:/Users/gongj/AppData/Local/Temp/old.log', size: 1000, atimeMs: ago(10), mtimeMs: ago(10) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/fresh.log', size: 2000, atimeMs: ago(1), mtimeMs: ago(1) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir', dir: true },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir/a.bin', size: 4096, atimeMs: ago(20), mtimeMs: ago(20) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir/sub', dir: true, ...over.subDir },
  { path: 'C:/Users/gongj/AppData/Local/Temp/olddir/sub/b.bin', size: 1024, atimeMs: ago(30), mtimeMs: ago(30) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/mixed', dir: true },
  { path: 'C:/Users/gongj/AppData/Local/Temp/mixed/x.bin', size: 10, atimeMs: ago(40), mtimeMs: ago(40) },
  { path: 'C:/Users/gongj/AppData/Local/Temp/mixed/y.bin', size: 10, atimeMs: ago(2), mtimeMs: ago(2) },
]);

function world(entries, opts = {}) {
  const progress = [];
  const log = [];
  const sc = SC.createScanner({
    fsMod: fakeFs(entries, opts),
    now: opts.now ?? (() => NOW),
    logger: { warn: (m) => log.push(m) },
    onProgress: (p) => progress.push(p),
    ...opts.scanner,
  });
  return { sc, progress, log };
}

await checkAsync('cln-1 展开规则的三级取值：dir 原样 > glob 字面量前缀 > rel+home 兜底', () => {
  // 优先级链的每一级都要钉：内置库走第一级（Task 11 已展开好），本机规则只有 glob 走第二级，
  // 第三级是给"仓库外手写的规则形状"兜底（cln-真机-1 不走它，所以链必须在这里断全）。
  const builtin = SC.expandRule({ id: 'b', n: 'B', kind: '缓存', ageDays: 3, dir: 'C:/Users/gongj/AppData/Local/Temp', glob: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\*', rel: '这条不该被用' }, {});
  assert.equal(builtin.dir, 'C:/Users/gongj/AppData/Local/Temp', '已展开好的 dir 不许被 rel 重算覆盖');
  assert.equal(builtin.pattern, '*');
  const user = SC.expandRule({ id: 'x', n: 'X', kind: '缓存', ageDays: 7, glob: 'C:\\Users\\gongj\\AppData\\Local\\npm-cache\\*' }, { home: 'C:\\Users\\gongj' });
  assert.equal(user.dir, 'C:\\Users\\gongj\\AppData\\Local\\npm-cache', '本机规则只有 glob：dir 由 glob 的字面量前缀推');
  assert.equal(user.pattern, '*');
  const rel = SC.expandRule({ id: 'y', n: 'Y', kind: '缓存', ageDays: 7, rel: 'AppData/Local/pip/Cache' }, { home: 'C:\\Users\\gongj' });
  assert.equal(rel.dir, 'C:\\Users\\gongj\\AppData\\Local\\pip\\Cache');
  assert.equal(rel.pattern, '*', '没有通配段时 pattern 兜成 *');
});

await checkAsync('cln-2 只有整条都够老才算候选（半新半旧不整删）', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule()]);
  const ids = res.items.map((i) => i.path.replace(/\\/g, '/'));
  assert.ok(ids.includes('C:/Users/gongj/AppData/Local/Temp/old.log'));
  assert.ok(ids.some((p) => p.endsWith('/olddir')), 'olddir 内全是 20~30 天前的，应命中');
  assert.ok(!ids.some((p) => p.endsWith('/mixed')), 'mixed 里有 2 天前的文件 → 整条不报');
  assert.ok(!ids.some((p) => p.endsWith('fresh.log')));
});

await checkAsync('cln-3 条目大小 = 递归求和，count = 文件数', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule()]);
  const olddir = res.items.find((i) => i.path.replace(/\\/g, '/').endsWith('/olddir'));
  assert.equal(olddir.size, 5120);
  assert.equal(olddir.count, 2);
  assert.equal(olddir.atime, ago(20), 'atime 取条目内最大值=最近一次动过（保守口径；原稿这里的 ago(30) 是 min，与 cln-2 的 mixed 断言互斥 —— 见 Ruling-69 C5）');
});

await checkAsync('cln-4 totals 与 items 一致；walked 统计所有 stat 过的条目', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule()]);
  assert.equal(res.totals.n, res.items.length);
  assert.equal(res.totals.bytes, res.items.reduce((a, b) => a + b.size, 0));
  assert.ok(res.walked >= 10, `walked=${res.walked}`);
});

await checkAsync('cln-5 拒绝访问的目录记进 skipped 且写日志，不静默', async () => {
  const w = world(tree(), { denied: ['C:/Users/gongj/AppData/Local/Temp/olddir/sub'] });
  const res = await w.sc.scan([rule()]);
  assert.ok(res.skipped.length >= 1);
  assert.equal(res.skipped[0].code, 'EPERM');
  assert.ok(w.log.length >= 1, '每个 catch 都要留下可见痕迹（spec §4.7）');
});

await checkAsync('cln-6 命中红线的规则目录直接跳过（第二道闸，不依赖扫描器自觉）', async () => {
  const w = world(tree());
  const res = await w.sc.scan([rule({ dir: 'C:\\Windows\\Temp', rel: undefined })]);
  assert.equal(res.items.length, 0);
  assert.ok(res.skipped.some((s) => /GUARD/.test(s.code)), `实际 skipped=${JSON.stringify(res.skipped)}`);
});

await checkAsync('cln-7 stop() 中途收手：stopped=true，已发现的部分仍然返回（可继续查看）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 50; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}.log`, size: 10, atimeMs: ago(9), mtimeMs: ago(9) });
  const w = world(entries);
  const p = w.sc.scan([rule()], { every: () => w.sc.stop() });
  const res = await p;
  assert.equal(res.stopped, true);
  assert.ok(res.items.length < 50, '真停住了，不是跑完才标 stopped');
});

await checkAsync('cln-8 onProgress 按时间片节流（1s 推 60 帧会把 SSE 挤爆）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 3000; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}`, size: 1, atimeMs: ago(9), mtimeMs: ago(9) });
  let t = NOW;
  const w = world(entries, { now: () => t, scanner: { progressIntervalMs: 1000 } });
  // 假时钟必须能推进：每条条目 +1ms ⇒ 3000 条走完是 3000ms，1000ms 一片 ⇒ 约 3 帧。
  // 冻结时钟下第一次 NOW-0>=1000 成立、之后 lastEmit=NOW 让 NOW-NOW=0>=1000 永假 ⇒ 恒 1 帧，
  // 于是"推一帧就死"的错实现也能过 >0 的下界（Ruling-69 C7）。下界提到 >=2 才是双向堵：
  // 不节流 = 3000 帧（红），只推一次 = 1 帧（红）。
  await w.sc.scan([rule()], { every: () => { t += 1; } });
  assert.ok(w.progress.length >= 2 && w.progress.length < 60, `进度帧数=${w.progress.length}，应远小于条目数且不止一帧`);
  assert.deepEqual(Object.keys(w.progress[0]).sort(), ['bytes', 'dir', 'hit', 'walked']);
});

await checkAsync('cln-9 maxEntries 触顶时 truncated=true 并写日志（把上限当成完整结果是不诚实）', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }];
  for (let i = 0; i < 20; i++) entries.push({ path: `C:/Users/gongj/AppData/Local/Temp/f${i}`, size: 1, atimeMs: ago(9), mtimeMs: ago(9) });
  const w = world(entries, { scanner: { maxEntries: 8 } });
  const res = await w.sc.scan([rule()]);
  assert.equal(res.truncated, true);
  assert.ok(w.log.some((m) => /截断|上限/.test(m)), '必须留下被截断的痕迹');
});

await checkAsync('cln-9b maxDepth 越深的目录不再下探，计入 skipped 而不是漏掉无声', async () => {
  const entries = [{ path: 'C:/Users/gongj/AppData/Local/Temp', dir: true }, { path: 'C:/Users/gongj/AppData/Local/Temp/d', dir: true }, { path: 'C:/Users/gongj/AppData/Local/Temp/d/e', dir: true }, { path: 'C:/Users/gongj/AppData/Local/Temp/d/e/f.bin', size: 5, atimeMs: ago(90), mtimeMs: ago(90) }];
  const w = world(entries, { scanner: { maxDepth: 1 } });
  const res = await w.sc.scan([rule()]);
  assert.ok(res.skipped.some((s) => s.code === 'DEPTH'), JSON.stringify(res.skipped));
});

await checkAsync('cln-10 riskOf：浏览器/IM 缓存标 mid 并说明会被锁，转储类标 low', () => {
  assert.equal(SC.riskOf({ id: 'edge-cache', kind: '缓存' }).level, 'mid');
  assert.equal(SC.riskOf({ id: 'crash-dumps', kind: '崩溃转储' }).level, 'low');
  assert.ok(SC.riskOf({ id: 'edge-cache', kind: '缓存' }).why.length > 0);
});

await checkAsync('cln-真机-1 真遍历 %TEMP%：Task 11 的规则原样送进扫描器，walked>0', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { BUILTIN_RULES } = await import('../lib/clean/rules.js');
  const sc = SC.createScanner({
    fsMod: { readdirSync: fs.readdirSync, statSync: fs.statSync, join: path.join },
    now: () => Date.now(), logger: { warn() {} }, onProgress() {},
  });
  const temp = BUILTIN_RULES.find((r) => r.id === 'temp-user');
  assert.ok(temp, '内置库里没有 temp-user —— 这条真机例钉的就是 Task 11 → Task 12 的交接面');
  // **原样送，不再 expandRule 一遍、不把 glob 重拼成 rel+'/\*'**（原稿那么写正好把 C1 的撞车藏掉了）。
  // ageDays 覆盖成 0 只为了保证有候选，不改 dir / glob。
  const r = await sc.scan([{ ...temp, ageDays: 0 }]);
  assert.ok(r.walked > 0, `本机 %TEMP% 遍历条目数为 0，说明假 FS 掩盖了真错：${JSON.stringify(r.skipped)}`);
  assert.equal(r.skipped.some((s) => /GUARD/.test(s.code)), false, 'Task 11 过了红线的规则，不该被扫描器的第二道闸拦住（两道闸的口径必须一致）');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/clean.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/clean/scanner.js`。

- [ ] **Step 3: 写实现**

要点（实现按这几条，别自由发挥）：

- `expandRule`：按 Interfaces 里写死的三级取值 —— `dir = rule.dir ?? (rule.glob ? path.dirname(rule.glob) : rule.rel ? path.join(String(home ?? ''), ...String(rule.rel).split('/')) : undefined)`（**每一步都不许抛**：`home` 缺省时拼出的是相对串，交给 guard 以 `GUARD_NO_DRIVE` 拒，比在这里 `TypeError` 好查）。`pattern = rule.pattern ?? (有 glob 时取 glob 最后一个 `\` 之后的段，段里没有 `*`/`?` 则取 `'*'`；无 glob 无 pattern 也取 `'*'`)`。**这里用 `node:path` 的 `join`/`dirname`，不是注入的 `fsMod.join`**（模块级函数拿不到注入参数；Ruling-69 C10），win32 下 `path.join`/`dirname` 出来带反斜杠，cln-1 断的就是这个。
- `globToRegExp`：逐字符转义除 `*` `?`，`*` → `[^\\/]*`，`?` → `[^\\/]`，整体 `^…$` + `i`；含 `**` 抛 `Error('不接受 **')`。
- `scan(rules, { every })`：`for (const raw of rules)` 外层；先 `const rule = expandRule(raw, {})`（**传 `{}` 不是笔误** —— Task 11 的规则到这里都该有 `dir` 或 `glob`；真两个都没有，`path.join(undefined,…)` 出来的串会被 `check` 以 `GUARD_BAD_INPUT` 拒，正好落进同一道 skipped 通道，不另立形状错误分支，见 Ruling-69 C11），再 `const g = check(rule.dir, { mode: 'path' })` —— **同步调用、没有 `await`，导出名是 `check` 不是 `guardCheck`**（原稿那句 `await guardCheck(...)` 两头都不对）；这是 Task 11 之外的**第二道**闸，cln-6 靠它；不通过 → `skipped.push({dir: rule.dir, code: g.code, why: g.why})` 并 `logger.warn`。**glob 的 `mode:'glob'` 复检不在这里**：Task 11 的 `validate()` 与 `activeRules()` 已经过了，红线只有一套口径。
- 遍历用显式栈（不用递归函数，深目录不吃栈）：栈元素 `{ path, depth }`。对规则目录的**第一层条目**建一个 candidate：`{ path, size, count, newest }`；层内更深的路径只累加不单独成条（cln-2/3 的语义）。
- `every?.()` 在每个条目处理完后调用（cln-7 用它注入 `stop()`）；`this.stopped` 为真时 break 双层循环。
- 时间片进度：`if (now() - lastEmit >= progressIntervalMs) { onProgress({ dir, walked, hit, bytes }); lastEmit = now(); }`。
- `maxEntries`：`walked >= maxEntries` 时 `truncated = true`、`logger.warn('…达到条目上限…')`、停止下探但仍返回已收集结果。
- `maxDepth`：超深度的目录 push 到 `skipped`，`code: 'DEPTH'`。
- `atime` 口径：candidate 的 `atime` = 条目内文件 `atimeMs` 的**最大值**（最近一次被动过），判定用 `atime <= now - ageDays*DAY`。cln-3 断言的就是这个保守口径。
- `riskOf(rule)`：`id` 含 `edge`/`wechat`/`dingtalk`/`vscode`/`packages` 或 `kind==='缓存'` → `mid`，`why` 用「运行中的应用会锁住部分文件，锁住的项会被跳过」；`崩溃转储`/`旧版本` → `low`，`why` 用「只影响事后分析或需重新下载」。`why` 直接进清单「风险」列。**两张表都不命中的（用户自建规则的 kind/id 五花八门）默认 `mid`**，`why` 用「不在风险表内，请按目录用途自行确认」—— 不要默认 `low`：`low` 那句「只影响事后分析或需重新下载」对任意目录是一个做不了保证的假承诺，宁可多提示一次。
- `item.id`：`<ruleId>-<base64url(path 小写)>`（用 `Buffer.from(p).toString('base64url')`，Task 13/15 只把它当不透明串）。
- 目录 `ENOENT`（规则目录本身不存在）→ `skipped` 记 `ENOENT` 并继续下一条规则，**不抛**：本机没装 Edge 不是错误。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/clean.test.mjs`
Expected: `12/12 通过`，退出码 0。
Run: `SKIP_LOCAL=1 node test/clean.test.mjs`
Expected: `11/11 通过` + 1 行 `SKIP cln-真机-1`。

> **执行后回填（2026-09-28 Task 12 修复轮，Ruling-77）**：评审 F-1 判为数据丢失级 ——
> 深度截断 / `stop()` / `maxEntries` 触顶时**没走完**的条目会带着半截的 `size/count/newest` 进 `items`，
> 而下游 `delete-dir` 是递归删目录，re-stat 闸门兜不住「扫描前就存在、因而没被看见」的新文件。
> 修复给候选加内部字段 `partial`/`pending`，定稿前先判不完整 ⇒ 只进 `skipped`（`code: 'INCOMPLETE'`），
> **不往 `items` 加字段**（Task 13 的 `record()` 会静默丢未声明字段）。
> 新增 `cln-9c`、`cln-5b`，并在 `cln-7` 里补断言（不新建用例，Ruling-77 第 3 点）：`pending` 判据的证人是
> 「第一层放一个目录候选 + 第 2 次回调才 `stop()`」这组夹具，外加**同夹具不收手的对照跑** ——
> 没有对照就分不清「判据拿掉了它」还是「本来就不进清单」（Ruling-79）。
> 门禁随之变：`node test/clean.test.mjs` ⇒ **`14/14`**（①13 + 真机 1），`SKIP_LOCAL=1` ⇒ **`13/13` + 1 行 SKIP**。
> 下游任务书里的 clean 读数一律以 **①=13（含真机 1 = 14）** 为基数，不要照抄本文件里更早的 ①11/①12。
>
> **执行后回填 2（Ruling-81，提交 `64a7907`）**：修复轮复评（`task-12-rereview.md`）指出 `pending` 在 `stack.pop()`
> 瞬间销账，所以「`stop()` / `maxEntries` 正好打断某个候选**自己那一层目录**的兄弟条目遍历」这一格仍会以半截视图
> 进 `items`（探针 `tmp/t12rr-probe.txt` 双案例）。补口 = 在 `for` 末尾的 `if (done())` 分支里给 `node.cand` 补标
> `partial`，并新增 `cln-7c` 一条用例（含三向对照：危害对照「走完本不该报」+ 防空证对照「整条够老且走完必进清单」
> + `pending` 专属证人「收手发生在进度回调里的那一格」）。
> 门禁再随之变：`node test/clean.test.mjs` ⇒ **`15/15`**（①14 + 真机 1），`SKIP_LOCAL=1` ⇒ **`14/14` + 1 行 SKIP**。
> 下游 clean 读数基数改为 **①=14（含真机 1 = 15）**；上面 ①=13 那句作废。变异归因：W1 四红、W2 只红 `cln-9c`、
> **W3 只红 `cln-7c` 的首条 pending 专属断言**、**W4 只红 `cln-7c` 的 F-R1 断言**（电池 `tmp/t12r-w.mjs` → `tmp/t12r-w2.txt`）。

- [ ] **Step 5: 真机耗时实测（spec §1.2 的 7.3s 结论要跟着走）**

**必须落成文件再跑，不许用 `node -e` / `node --input-type=module -e` 内联**：本机 bash 会吃脚本里的 `\` 转义（这是本仓库执行至今的硬约束），原稿那版还有个 `path=path0=await import(...)` 笔误，内联跑一次就炸一次。写 `tmp/t12perf.mjs`（`tmp/` 已在 `.gitignore` 里，不提交）：

```js
/* Task 12 Step 5：真机耗时实测。放在 tmp/ 下，所以 import 用 ../lib/... */
const fs = await import('node:fs');
const path = await import('node:path');
const SC = await import('../lib/clean/scanner.js');
const { BUILTIN_RULES } = await import('../lib/clean/rules.js');

const ids = ['temp-user', 'npm-cache', 'pip-cache', 'edge-cache'];
const rules = BUILTIN_RULES.filter((r) => ids.includes(r.id));
if (rules.length !== ids.length) {
  throw new Error(`内置库里缺规则：期望 ${ids.join(',')}，实得 ${rules.map((r) => r.id).join(',')}`);
}

const t0 = Date.now();
const sc = SC.createScanner({
  fsMod: { readdirSync: fs.readdirSync, statSync: fs.statSync, join: path.join },
  now: () => Date.now(),
  logger: { warn: (m) => console.error('WARN', m) },
  onProgress: () => {},
});
const res = await sc.scan(rules);   // **原样送**：不 expandRule、不把 glob 重拼成 rel+'/*'
console.log('规则', rules.map((r) => r.id).join(','));
console.log('耗时ms', Date.now() - t0, 'walked', res.walked, 'items', res.totals.n,
  'bytes', Math.round(res.totals.bytes / 2 ** 20) + 'MB',
  'skipped', res.skipped.length, 'truncated', res.truncated, 'stopped', res.stopped);
for (const s of res.skipped) console.log('SKIP', s.code, s.dir, s.why);
```

Run: `node tmp/t12perf.mjs > tmp/t12-perf.txt 2>&1`（中文经 cp936 控制台会乱码，读 `tmp/t12-perf.txt`）
Expected: 退出码 0；`walked` 与耗时同量级合理 —— 同机现采的参照量级在 `tmp/t11-probe.txt`（`temp-user` 一层 6524 条目、`npm-cache` / `pip-cache` / `edge-cache` 各 2 条），4 条规则的遍历量应在几千到几万级。两条分支都写死：**耗时 > 60s** ⇒ 把 `maxEntries` 默认值降到 100000 并在扫描条上显示「已达遍历上限」，不许让它跑到天荒地老；**出现 `GUARD_*` 的 SKIP** ⇒ 说明扫描器这道闸与 Task 11 那道口径不一致（`cln-真机-1` 会先红在这里），改的是扫描器的取值，**不是**内置库的路径。把 `tmp/t12-perf.txt` 的实际读数写进汇报。

提交信息草稿：`feat(sysops): 清理扫描器（整条够老才算候选 + 可停止 + 进度节流）`

---

## Task 13: `lib/records/spec.js` + `plan-store.js` + `log-store.js`

**Files:**
- Rename: `lib/alerts/spec.js` → `lib/records/spec.js`（三张表齐了才看得出它不属于 alerts；`lib/alerts/store.js` 与 `test/alerts.test.mjs` 的 import 同步改）
- Modify: `lib/records/spec.js`（追加 `clean_plan` / `clean_log` 两表）
- Create: `lib/kv-records-base.js`（四段共用骨架工厂 + **按设施去重的域打开登记表与引用计数关闭** —— 见下方 Ruling-63 与 Ruling-71 T13-D，第三/第四份复制禁止）
- Modify: `lib/alerts/store.js`（**只改一处**：`ensureDomain()` 里那发 `facility.open(alertsDomain)` 改为经 `kv-records-base.js` 的登记表取 handle，`close()` 改为 `release()`。骨架、错误词表、写队列一律不动 —— Ruling-63 禁的是整体迁移，不是这一行的撞车修复）
- Create: `lib/clean/plan-store.js`
- Create: `lib/clean/log-store.js`
- Modify: `test/clean.test.mjs`（追加 ②段）

**Interfaces:**
- Consumes: `kv-schema.js`、Task 9 的 `alertsDomain`（改名后为 `recordsDomain`）、`RECORD_DOMAIN` / `RECORD_VER` / `ALERT_HIT_MAX` / `hitKey`、Task 12 的 `item` 形状
- Produces:
  - `recordsDomain`（原 `alertsDomain`，三表齐）、`PLAN_KEEP = 20`、`LOG_KEEP = 100`、`planKey(planId)`、`logKey(logId)`
  - `createPlanStore({ getFacility, logger, now, newId })` → `{ available, save(scanResult, meta) → plan, get(planId), list({limit}), close() }`
  - plan 形状：`{ planId, at, beforeFree, afterFree, modeDefault, rulesUsed: [{id,n,kind}], items: [item…], totals }`
  - `createLogStore({ getFacility, logger, now })` → `{ available, start({planId, itemIds, mode}) → log, finish(logId, {ok, skipped, failed, rejected, bytesFreed, afterFree}) → log, list({limit}), unfinished() → log[], close() }`
  - `RECORDS_ERROR`（`UNAVAILABLE` `DUPLICATE` `NOT_FOUND` `CLOSED`，与 `PREFS_ERROR` 同名同形）

- [ ] **Step 0: 预检裁定（控制器 2026-09-27 实测，执行者照此实现，不要再自行发明）**

> **Ruling-71（Task 13 预检：四处 plan defect，其中 T13-D 会让真机上线必炸）**
>
> **T13-D（Critical，先说最重的）**：三张表在**同一个 domain** `sysops_records` 里，于是这个域有**三个 open 者** —— Task 9 的 `createAlertHitStore`（已交付，`lib/alerts/store.js:70` 自己缓存一个 `opening`）、本任务的 `createPlanStore`、`createLogStore`。而宿主契约写明「**domain 名是排他的**，重复 open 报 `already-open`」（`dsh-plugin-stock-analysis/docs/host-capabilities.md:153`、`:211`）。参照实现躲开这一劫是因为它三个域各一仓储（`stock_analysis` / `_prefs` / `_live`），**「每个仓储各缓存一个 promise」的前提是每个仓储开的是不同的域** —— 本任务三仓储同域，那个写法直接失效。
> 现采证据（`node tmp/t13dprobe.mjs` → `tmp/t13d-probe.txt`）：同一 memory facility 上建两个各自缓存 open 的仓储，第一个 `append` OK，第二个 `append` **THREW `RECORDS_UNAVAILABLE | 告警记录域 open 失败：already-open`**。这不是测试桩的怪癖，是照真实现写的桩（`test/_helpers.mjs:13`）。
> **裁定：`lib/kv-records-base.js` 必须自带「按设施去重的域打开登记表 + 引用计数关闭」，并且 `lib/alerts/store.js` 的 `ensureDomain` 改为经由该登记表取 handle（一处 import + 一处调用，不是整体迁移）。** 具体契约：
> - 模块级 `WeakMap<facility, Map<domainName, entry>>`，`entry = { promise, handle, refs, closing }`。用 WeakMap 是为了测试里每例新建一个设施时不留强引用（否则每跑一例泄漏一个域）。
> - `acquire(facility, domain, { logger, labels })`：首个调用者真正 `facility.open(domain)` 并存 promise；后来者 `await` 同一个 promise 且 `refs += 1`。**open 失败必须清掉 entry**（保留原骨架「失败可重试」的语义），并把错误映射成带 `code` 的 `UNAVAILABLE`。
> - `release(facility, domain)`：`refs -= 1`；**只有降到 0 才真正 `await handle.close()`**。这解决关闭侧的对称问题 —— 若 `planStore.close()` 直接关域，还活着的 `logStore` 与告警仓储会拿到一个失效 handle。
> - 每个仓储实例仍保有自己的 `closed` 终态标志与写队列：**「close 后自己写报 `CLOSED`」是每仓储的语义，「关掉域」是登记表的语义**，两者不许混。Ruling-63 说的「不迁移 `lib/prefs/store.js` / `lib/alerts/store.js`」指的是不把它们的骨架重写成 base 的薄包（各有已钉死的变异级测试），把 `ensureDomain` 里那一发 `facility.open()` 改成经登记表**不在禁止范围内**，且是必需的。
> - 新增 `rec-10` 把这条钉住（见 Step 2 的用例文本）。
>
> **T13-A（Critical）**：Task 12 产出的 item 是**嵌套** `risk: { level, why }`（line 4052 的 `item = { …, risk: {level, why} }`），而本任务 `cleanItem` schema 声明的是**扁平** `riskLevel` / `riskWhy`，Task 15/22 消费的也是扁平名（`:4886`、`:6859`）。`record()` 会**静默丢弃未声明字段**（`lib/kv-schema.js:199-221`），`riskLevel` 又是 `requiredString` ⇒ `save` 若把 `scanResult.items` 原样塞进 parse，**每条快照写入都抛 `RECORDS_INVALID`**。更坏的是原稿 ②段夹具直接写了扁平形状，测试全绿而真机必炸。裁定：`save` 内做**一次显式投影**（`riskLevel: it.risk.level`、`riskWhy: it.risk.why`，其余字段白名单逐个取，不许 `...it` 展开），并把 `itemFixture()` 改成**嵌套形状**（与扫描器真产物一致）—— 夹具的形状必须是上游的真形状，否则 ②段测的是想象。
>
> **T13-B（Important）**：Step 4 写「裁剪到 `PLAN_KEEP`（按 `planId` 内含的时间前缀排序，字典序=时间序）」，与已签收的 **Ruling-55** 直接冲突（`lib/alerts/store.js` 的 `trim` 注释：`hitKey` 的时间前缀只在毫秒位数相同时才等于时间序，假时钟下 `h-9 > h-10` ⇒ 会裁掉最新那条）。本任务的 `newId` 默认虽是 `p-<now>-<4位随机>`，但 `rec-5` 注入的是 `p-1..p-21`，字典序把 `p-10` 排在 `p-2` 前面。裁定：`trim` 一律按 **`Number(v.at)` 数值升序**、同值再按 key 的 `localeCompare` 兜底（与 `lib/alerts/store.js` 的 `trim` 逐字同式），并在注释里点名 Ruling-55；`recWorld` 的 `now` 必须是**会走的时钟**（见 Step 2），不能像原稿那样冻结在 5000 —— 冻结时钟下「数值升序」与「字典序」两种实现给出同一个被删项，变异证不出差别。
>
> **T13-E（Important，预检时发现的新项）**：`rec-5` 断 `list[0].planId === ids[1]`，注释写「最旧的 p-1 应被挤掉」—— 但 Interfaces 与 `hits()` 的既定契约都是 **`list()` 时间倒序**（alert-13 已把「倒序是 store 的契约、service 不重排」钉死）。倒序下剩余 20 条的 `list[0]` 是**最新**的 `ids[20]`，`ids[1]` 在最末。原稿这条断言与自家契约相反。裁定：改断言为 `list[0] === ids[20]` 且 `list[PLAN_KEEP-1] === ids[1]`，并保留 `get(ids[0]) === null`（那才是「挤掉最旧」的直接证据）。
>
> **T13-C（Minor）**：本任务的旁路读数 `alerts 29/29` 已过期，Task 10 修复轮后是 **33/33**（三处已同步改）。
>
> 计数随之变：②段 `rec-1..rec-9` + 新增 `rec-10` = **10** 例 ⇒ 门禁 `25/25`（①14 + 真机 1 + ②10 —— ① 段基数已由 Task 12 两轮修复抬到 14：Ruling-77/79 从 11 抬到 13，Ruling-81 再加 `cln-7c`，见 Task 12 Step 4 上方的两段回填），`SKIP_LOCAL=1` 下 `24/24` + 1 行 SKIP。


- [ ] **Step 1: 建 records 域（改名 + 追加两表）**

`lib/records/spec.js` 在三表声明处追加：

```js
const cleanItem = record({
  id: requiredString('clean_plan.items[].id'),
  ruleId: requiredString('clean_plan.items[].ruleId'),
  ruleName: requiredString('clean_plan.items[].ruleName'),
  kind: requiredString('clean_plan.items[].kind'),
  path: requiredString('clean_plan.items[].path'),
  size: requiredNumber('clean_plan.items[].size'),
  count: requiredInt('clean_plan.items[].count'),
  atime: requiredNumber('clean_plan.items[].atime'),
  mtime: requiredNumber('clean_plan.items[].mtime'),
  riskLevel: requiredString('clean_plan.items[].riskLevel'),
  riskWhy: optionalString('clean_plan.items[].riskWhy'),
}, 'clean_plan.items[]');

const cleanPlan = record({
  planId: requiredString('clean_plan.planId'),
  at: requiredNumber('clean_plan.at'),
  beforeFree: requiredNumber('clean_plan.beforeFree'),
  afterFree: optionalNumber('clean_plan.afterFree'),
  modeDefault: requiredString('clean_plan.modeDefault'),
  rulesUsed: arrayOf('clean_plan.rulesUsed', { id: requiredString('rulesUsed[].id'), n: requiredString('rulesUsed[].n'), kind: requiredString('rulesUsed[].kind') }),
  items: arrayOf('clean_plan.items', cleanItem, { required: true }),
  totals: record({ n: requiredInt('totals.n'), bytes: requiredNumber('totals.bytes') }, 'totals'),
}, 'clean_plan');

const cleanLog = record({
  logId: requiredString('clean_log.logId'),
  planId: requiredString('clean_log.planId'),
  startedAt: requiredNumber('clean_log.startedAt'),
  finishedAt: optionalNumber('clean_log.finishedAt'),
  mode: requiredString('clean_log.mode'),
  itemIds: arrayOf('clean_log.itemIds', requiredString('itemIds[]')),
  ok: optionalInt('clean_log.ok'),
  skipped: optionalInt('clean_log.skipped'),
  failed: optionalInt('clean_log.failed'),
  rejected: optionalInt('clean_log.rejected'),
  bytesFreed: optionalNumber('clean_log.bytesFreed'),
  afterFree: optionalNumber('clean_log.afterFree'),
  note: optionalString('clean_log.note'),
  detail: optionalString('clean_log.detail'),
}, 'clean_log');
```

并把 `tables` 补齐为 `{ alert_hit, clean_plan, clean_log }`。**改名要一起做的四处**（漏一处就是运行时炸）：`export const alertsDomain` → `export const recordsDomain`；`lib/alerts/store.js` 的 import；`test/alerts.test.mjs` 的 import 与用例里出现的 `alertsDomain`；`docs` 里对该域的引用。

- [ ] **Step 2: 写失败的测试（②段）**

```js
/* ②段：清单快照与执行留痕 */
const { recordsDomain, PLAN_KEEP, LOG_KEEP } = await import('../lib/records/spec.js');
const { createPlanStore } = await import('../lib/clean/plan-store.js');
const { createLogStore, RECORDS_ERROR } = await import('../lib/clean/log-store.js');

// 形状必须是 Task 12 扫描器的**真产物**：risk 是嵌套的 {level, why}。
// 扁平的 riskLevel/riskWhy 是 plan-store 投影**之后**的样子（Ruling-71 T13-A）——
// 夹具若直接写扁平，「save 不拍平 ⇒ 每条快照写入抛 RECORDS_INVALID」这个缺陷永远测不到。
const itemFixture = (over = {}) => ({
  id: 'temp-user-aG9tZQ', ruleId: 'temp-user', ruleName: '用户临时目录', kind: '缓存',
  path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log', size: 1000, count: 1,
  atime: 1, mtime: 1, risk: { level: 'mid', why: '应用可能锁文件' }, ...over,
});

function recWorld(over = {}) {
  const facility = over.facility === undefined ? createMemoryFacility() : over.facility;
  let n = 0;
  // 时钟必须会走（Ruling-71 T13-B）：冻结在 5000 时「按 at 数值升序」与「按 planId 字典序」
  // 删掉的是同一条，rec-5 证不出裁剪究竟看了哪个字段。
  const planStore = createPlanStore({ getFacility: () => facility, logger: { warn() {} }, now: (() => { let at = 4000; return () => (at += 1000); })(), newId: () => `p-${++n}` });
  const logStore = createLogStore({ getFacility: () => facility, logger: { warn() {} }, now: () => 6000 });
  return { facility, planStore, logStore, n: () => n };
}

const scanFixture = (items = [itemFixture()]) => ({
  items, totals: { n: items.length, bytes: items.reduce((a, b) => a + b.size, 0) },
  walked: 100, hit: items.length, skipped: [], stopped: false, truncated: false, at: 5000,
});

check('rec-1 records 域三张表，domain 名不变（已有落盘数据）', () => {
  assert.equal(recordsDomain.name, 'sysops_records');
  assert.deepEqual(Object.keys(recordsDomain.tables).sort(), ['alert_hit', 'clean_log', 'clean_plan']);
});

check('rec-2 clean_plan schema：riskWhy 可缺，path 必须是字符串', () => {
  const t = recordsDomain.tables.clean_plan.valueSchema;
  assert.doesNotThrow(() => t.parse({ planId: 'p-1', at: 1, beforeFree: 1, modeDefault: 'delete-file', rulesUsed: [], items: [{ ...itemFixture(), riskWhy: undefined }], totals: { n: 1, bytes: 1 } }));
  assert.throws(() => t.parse({ planId: 'p-1', at: 1, beforeFree: 1, modeDefault: 'delete-file', rulesUsed: [], items: [{ ...itemFixture(), path: 123 }], totals: { n: 1, bytes: 1 } }), /path/);
});

await checkAsync('rec-3 save 冻结快照：读回的路径与条数与扫描结果逐字一致', async () => {
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 70 * 2 ** 30, modeDefault: 'delete-file' });
  assert.equal(plan.items.length, 1);
  const back = await w.planStore.get(plan.planId);
  assert.equal(back.items[0].path, 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log');
  assert.equal(back.beforeFree, 70 * 2 ** 30);
  assert.equal(back.rulesUsed.length, 1, 'rulesUsed 由 items 反推，界面「命中规则」列要用');
  // 投影必须真的发生：写进去的是嵌套 risk，读回来必须是扁平名（Task 15/22 只认扁平名）
  assert.equal(back.items[0].riskLevel, 'mid', 'save 没把嵌套 risk 拍平 ⇒ 读回来根本没有这个字段');
  assert.equal(back.items[0].riskWhy, '应用可能锁文件');
  assert.equal('risk' in back.items[0], false, 'record() 静默丢弃未声明字段，读回来不该再有 risk');
});

await checkAsync('rec-4 快照 append-only：同 planId 再写必须抛（清单不可被改写）', async () => {
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  await assert.rejects(
    () => w.planStore.save({ ...scanFixture(), items: [] }, { beforeFree: 1, modeDefault: 'delete-file', planId: plan.planId }),
    (e) => e.code === RECORDS_ERROR.DUPLICATE,
  );
});

await checkAsync('rec-5 快照只留最近 20 段，第 21 段挤掉最旧', async () => {
  const w = recWorld();
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push((await w.planStore.save(scanFixture(), { beforeFree: i, modeDefault: 'delete-file' })).planId);
  const list = await w.planStore.list({ limit: 50 });
  assert.equal(list.length, PLAN_KEEP);
  // list() 是**时间倒序**（与 hits() 同契约，alert-13 已把「倒序是 store 的契约」钉死）：
  // 原稿在这里断 list[0] === ids[1]，把自家契约写反了 —— 见 Ruling-71 T13-E。
  assert.equal(list[0].planId, ids[20], '倒序：第一条必须是最新的 p-21');
  assert.equal(list[PLAN_KEEP - 1].planId, ids[1], '倒序：末条是剩余 20 条里最旧的 p-2');
});

await checkAsync('rec-6 log.start 立刻落一条 running 记录（中断后能查出「未确认完成」）', async () => {
  const w = recWorld();
  const log = await w.logStore.start({ planId: 'p-1', itemIds: ['a'], mode: 'delete-file' });
  assert.equal(log.finishedAt, undefined);
  assert.equal((await w.logStore.unfinished()).length, 1);
});

await checkAsync('rec-7 finish 补齐三档计数并写 afterFree；重复 finish 只保留第一次的完成时间', async () => {
  const w = recWorld();
  const log = await w.logStore.start({ planId: 'p-1', itemIds: ['a', 'b'], mode: 'delete-file' });
  const done = await w.logStore.finish(log.logId, { ok: 1, skipped: 1, failed: 0, rejected: 0, bytesFreed: 512, afterFree: 71 * 2 ** 30 });
  assert.equal(done.ok, 1);
  assert.equal(done.finishedAt, 6000);
  assert.equal((await w.logStore.unfinished()).length, 0);
  const again = await w.logStore.finish(log.logId, { ok: 9, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1, afterFree: 1 });
  assert.equal(again.ok, 1, '留痕不能被第二次 finish 改写（append-only 语义）');
});

await checkAsync('rec-8 log 缺失 logId 报 NOT_FOUND；无 facility 报 UNAVAILABLE', async () => {
  const w = recWorld();
  await assert.rejects(() => w.logStore.finish('nope', { ok: 0, skipped: 0, failed: 0, rejected: 0, bytesFreed: 0, afterFree: 0 }), (e) => e.code === RECORDS_ERROR.NOT_FOUND);
  const v = recWorld({ facility: undefined });
  assert.equal(v.planStore.available, false);
  await assert.rejects(() => v.logStore.start({ planId: 'p', itemIds: [], mode: 'delete-file' }), (e) => e.code === RECORDS_ERROR.UNAVAILABLE);
});

await checkAsync('rec-9 close() 可 await；close 后写报 CLOSED；跨 open 快照仍在', async () => {
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  await w.planStore.close();
  await assert.rejects(() => w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' }), (e) => e.code === RECORDS_ERROR.CLOSED);
  const w2 = recWorld({ facility: w.facility });
  assert.equal((await w2.planStore.get(plan.planId)).planId, plan.planId);
});

await checkAsync('rec-10 同一设施上多个仓储共用一个域：各自读写都可用，关一个不带走别人', async () => {
  // Ruling-71 T13-D：sysops_records 里有三张表 = 三个 open 者（alert_hit 的 Task 9 仓储 + 本任务的两个），
  // 而宿主契约写明「domain 名是排他的，重复 open 报 already-open」。没有登记表，Task 19 装配现场必炸。
  const w = recWorld();
  const plan = await w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' });
  const log = await w.logStore.start({ planId: plan.planId, itemIds: ['a'], mode: 'delete-file' });
  assert.equal(plan.planId, 'p-1', 'planStore 先 open 并持有域');
  assert.equal(typeof log.logId, 'string', 'logStore 复用的是登记表里那个 handle —— 它若自己 open 会在这里抛 UNAVAILABLE');
  assert.equal((await w.logStore.unfinished()).length, 1);
  assert.equal((await w.planStore.get(plan.planId)).planId, plan.planId, '两个仓储各自读写，互不干扰');
  // 引用计数：还剩 logStore 持有，域必须活着 ⇒ planStore 自己进终态，但不许把域一起关掉
  await w.planStore.close();
  await assert.rejects(() => w.planStore.save(scanFixture(), { beforeFree: 1, modeDefault: 'delete-file' }),
    (e) => e.code === RECORDS_ERROR.CLOSED, 'close 是该仓储的终态，与域是否关闭无关');
  const done = await w.logStore.finish(log.logId, { ok: 1, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1, afterFree: 2 });
  assert.equal(done.ok, 1, 'planStore 关了不许把域关掉，否则这里报 UNAVAILABLE');
  // 最后一个持有者关掉后名字释放：新实例复用同一设施能重新 open，且读到旧行
  await w.logStore.close();
  const w3 = recWorld({ facility: w.facility });
  assert.equal((await w3.planStore.get(plan.planId)).planId, plan.planId, '关干净后重开，数据必须还在（介质权威）');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node test/clean.test.mjs`
Expected: `rec-1` FAIL（`lib/alerts/spec.js` 已被改名 → `ERR_MODULE_NOT_FOUND`）或 schema 缺表报错。改名后 alerts 测试必须同步变绿：Run `node test/alerts.test.mjs` Expected `33/33`。

- [ ] **Step 4: 写实现**

两个仓储共用同一套骨架（`ensureDomain` 缓存 promise + 写队列串行 + 裁剪），与参照实现的差别是 **`put` 前先 `get` 查重**（`DUPLICATE`）：

> **Ruling-63（Task 9 评审连带，约束本任务）**：`lib/alerts/store.js` 与 `lib/prefs/store.js` 的近逐字双份是任务书明文「骨架照抄」的产物，评审定为 plan-mandated、Task 9 已签收。**本任务不得再抄出第三、第四份**：把四段共用骨架（`facilityOf` / `assertUsable` / `ensureDomain` / `available` + `close`）抽成 `lib/kv-records-base.js` 工厂，由参数注入 `domain`、表名、错误类与中文文案；`plan-store.js` / `log-store.js` 各薄包一层，各自真正独有的 `save/get/list/trim/查重` 留在自己文件里。
> **不迁移** `lib/prefs/store.js` 与 `lib/alerts/store.js`：两者各有已钉死的变异级测试与不同错误词表，为 DRY 去重写已交付的采集/告警主路径不划算。四份是否最终归一，交全分支大评审定。

```js
/**
 * 清单快照仓储（append-only）。
 *
 * 为什么快照要整份存而不是只存 itemIds：Task 15 的 re-stat 判定要拿
 * 「快照那一刻的 size / mtime / atime」跟现状比 —— 现状会自己变，历史不存下来就没法比。
 * 为什么同 planId 再写要抛错：清单一旦展示给用户，改内容不改 id 会让
 * 「看到 A 删 B」重新变得可能，那正是两段式要消灭的东西。
 */
```

- `createPlanStore.save(scanResult, meta)`：`planId = meta.planId ?? newId()`（`newId` 注入，默认 `p-<now>-<4 位随机>`）；`rulesUsed` 由 `items` 去重反推；写前 `domain.table('clean_plan').get(key)`，存在则抛 `DUPLICATE`；写完裁剪到 `PLAN_KEEP`（**按 `Number(v.at)` 数值升序删最旧，同值再按 key 的 `localeCompare` 兜底 —— 与 `lib/alerts/store.js` 的 `trim` 逐字同式，理由见 Ruling-55；禁止按 `planId` 字典序**，注入的 `p-1..p-21` 下字典序会把 `p-10` 排在 `p-2` 前）。
- `save` 必须对 items 做**一次显式投影**（Ruling-71 T13-A）：逐字段白名单取出 `id/ruleId/ruleName/kind/path/size/count/atime/mtime`，再加 `riskLevel: it.risk.level`、`riskWhy: it.risk.why`，**不许 `...it` 展开** —— `record()` 会静默丢弃未声明的 `risk` 而 `riskLevel` 是必填，展开写法每条都抛 `RECORDS_INVALID`。
- `get(planId)` → 快照行或 `null`；`list({limit})` → 时间倒序。
- `createLogStore`：`start()` put 一条无 `finishedAt` 的记录；`finish()` 先 `get`，若已有 `finishedAt` → **原样返回旧行并 `logger.warn`**（rec-7 断言），否则写补齐后的行；`unfinished()` = 全表里 `finishedAt` 为空的行（Task 15 重启后据此提示）。裁剪到 `LOG_KEEP`。
- `RECORDS_ERROR` 四个 code 的字面值：`SYSOPS_RECORDS_UNAVAILABLE` / `…_DUPLICATE` / `…_NOT_FOUND` / `…_CLOSED`（Task 18 按 code 分支）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/clean.test.mjs`
Expected: `25/25 通过`（①14 + 真机 1 + ②10 —— SKIP_LOCAL 下 24/24 + 1 SKIP）
Run: `SKIP_LOCAL=1 node test/clean.test.mjs` → `24/24 通过` + 1 行 `SKIP cln-真机-1`
Run: `node test/alerts.test.mjs` → `33/33 通过`（改名回归）
提交信息草稿：`refactor(sysops): 记录域改名 records 并加清单快照/执行留痕仓储`

---

## Task 14: `lib/clean/quarantine.js` + prefs 的 `clean` 组

**Files:**
- Create: `lib/clean/quarantine.js`
- Modify: `lib/prefs/spec.js`（`prefsRecord` 追加 `clean` 组）
- Modify: `test/prefs.test.mjs`（追加 ⑤段）
- Modify: `test/clean.test.mjs`（追加 ③段）

**Interfaces:**
- Consumes: `check`（Task 2）、注入的 `fsMod`、`prefs.clean`
- Produces:
  - `DEFAULT_QUARANTINE = (appData) => join(appData, 'dsh-plugin-sysops', 'quarantine')` —— 用 `node:path` 的 `join`，**不要字符串直拼**（T14-G：直拼遇到带尾分隔符的入参会多一个反斜杠，`prefq-4` 会红）
  - `dayDir(now, rootDir) → string`（`<root>\<YYYY-MM-DD>`，取**本地**日期）
  - `createQuarantine({ rootDir, fsMod, pathMod, logger, now, forbiddenPrefixes })` → `{ ensureRoot(), stash(absPath) → { ok, dest, method, why? }, stats() → { dirs, files, bytes, oldest }, rootDir() }`
  - **`forbiddenPrefixes: string[]`（缺省 `[]`）由调用方负责喂**：Task 15 传「`activeRules()` 里各条的 `dir` 集」，本任务的测试夹具（`quarWorld`）传 `%LOCALAPPDATA%\Temp` 那条。除调用方之外没有任何人执行这条红线 —— 派单时若发现 `forbiddenPrefixes` 没有真实喂入者，就是 Task 15 的漏。
  - **`stash()` 内部 `await ensureRoot()`，配置错时抛异常而不是返回 `{ ok:false }` —— 这是有意的**：暂存目录配错属于「整批该停」，不是单个条目失败。Task 15 必须在批次外层 catch，不要放进条目循环。
  - prefs `clean` 组：`{ quarantineDir, keepDays, after }`，`after ∈ ['none','log']`

- [ ] **Step 0: 预检裁定（Ruling-72，控制器 2026-09-28 现采，执行者照此实现，不要再自行发明）**

现采证据：`node tmp/t14probe.mjs` → `tmp/t14-probe.txt`（`check()` 为**同步**，五条形制路径逐条裁决）：
- `...\AppData\Local\dsh-plugin-sysops\quarantine` → `allow=true`（合法暂存）
- `C:\Windows\q` → `allow=false code=GUARD_SYSTEM_DIR`，`why` 含「系统目录禁止操作」
- `AppData\q` → `GUARD_NO_DRIVE`，`why` 含「盘符」
- `%LOCALAPPDATA%\q` → `GUARD_UNEXPANDED_VAR`，`why` 含「%变量%」
- `...\AppData\Local\Temp\q` → **`allow=true`**（Temp 本来就是可清理区，guard 没错 —— 这条是 T14-B 的依据）

| 编号 | 问题 | 裁定（已落进下面的 Step 1/2/3 代码） |
|---|---|---|
| **T14-B**（Critical） | `q-6` 按原稿不可能变绿：`quarWorld` 从不传 `forbiddenPrefixes`（缺省 `[]`），而另一条拒绝路径 `check(rootDir)` 现采对 `Temp\q` 是 `allow=true` ⇒ `ensureRoot()` 不抛，`assert.rejects` 必红 | `quarWorld` 默认传 `forbiddenPrefixes: [TEMP_PREFIX]`（q-1..q-5 同用，顺带让正向路径也走一遍），`q-6` 只换 `rootDir` |
| **T14-C**（Critical） | `stash()` 里 `isDir` 的 IIFE 短路失效：`statSync` 抛错时 IIFE 返回**对象**并赋给 `isDir`，代码继续走 `freeDest()` / `renameSync()`。真机上「源已被别的程序删掉」是最常见的条目级失败 ⇒ 误判成 `method:'move'`；同盘 rename 先抛 EXDEV 时又因对象为真值误报「目录跨卷复制未实现」。原稿 ③段没有任何「源不存在」用例 | 拆成显式 `try/catch` + 提前 `return { ok:false, dest:'', method:'none', why }`；新增 `q-8 源不存在` 用例钉住 |
| **T14-D**（Important） | `stats()` 零覆盖，且假 FS 让它恒为 0：`quarFs.readdirSync` 用 `d.startsWith(p + '/')` 做前缀匹配，桩里路径全是反斜杠 ⇒ 恒返回 `[]`。照原稿补测试会得到「files 恒 0」的**假绿** | 先修桩（前缀与切分都用反斜杠，并同时枚举 `files` 的直接子项），再加 `q-9` 覆盖 `{dirs, files, bytes, oldest}` —— `oldest` 是 Task 24 设置页 keepDays 到期提醒的唯一数据源 |
| **T14-E**（Important） | Step 5 原稿双重违规：① 用 `node --input-type=module -e "…"`（本仓库硬约束禁止）；② 里面全是字面 `\` 路径 —— 已实测证明「写成文件」也不够：工具调用层把 `\` 折半一次，JS 再把 `\U` 当转义吃掉，第一轮探针实际输入是 `C:Usersgongj…` 这种畸形串，guard 对它返回 `allow=true`，差点据此裁定「红线漏判」 | Step 5 落 `tmp/t14probe.mjs`，**脚本里的反斜杠一律 `String.fromCharCode(92)` 拼接**，并打印「段数」自证输入形状；暂存根放进仓库 `tmp/` 下、由脚本自己 `rmSync(recursive, force)`（自己造的临时物自己清） |
| **T14-F**（Minor） | `freeDest` 生成的是 `2-name` **前缀**，文件头注释写「加 `-2` / `-3` 后缀」 | 注释跟代码（前缀对 `basename` 稳定，行为不变）；用例标题同改为「加序号前缀」 |
| **T14-G**（Minor） | `DEFAULT_QUARANTINE` 实现直拼且形参改名，`prefq-4` 拿 `path.join` 对比 ⇒ 入参带尾分隔符时多一个反斜杠，断言红 | 实现改用 `node:path` 的 `join`，形参名回到 `appData` |
| **T14-H**（Minor，时区耦合） | `dayDir` 取**本地**日期，原稿夹具喂 `new Date('2026-09-27T10:00:00Z')`：本机 +08 同日所以 `q-1` 的 `/2026-09-27/` 成立，换 UTC 负偏移机器会红。`q-7` 原稿的 `new Date('2026-09-07T23:30:00+08:00')` 同病（+14 机器上本地是 09-08） | 两处夹具都改本地构造：`now` 用 `new Date(2026, 8, 27, 10, 0, 0)`、`q-7` 用 `new Date(2026, 8, 7, 23, 30, 0)`，断言不动 —— 测试与所在时区解耦 |
| **T14-I**（计数） | Step 4 原稿期望 `28/28 (①12 ②9 ③7)`：②9 已被 Task 13 的 `rec-10` 变成 ②10；③段随 T14-C/D 加 `q-8`、`q-9` ⇒ ③=9；①段又随 Task 12 两轮修复（Ruling-77/79 加 `cln-9c`/`cln-5b`，Ruling-81 加 `cln-7c`）由 12 变 **15（含真机）** | 新期望 **`34/34`**（①14 + 真机 1 + ②10 + ③9），`SKIP_LOCAL=1` 下 `33/33` + 1 行 SKIP。prefs 侧 ⑤4 ⇒ **`28/28`**（①3 ②4 ③6 ④11 ⑤4，与 Task 11 闭环后的 `24/24` 衔接） |

**另记（已落进 Step 1）**：`prefq-1` 里 `assert.throws(…, /guard|受保护/)` 这条**必然命中** —— spec 抛的 message 前缀就含「未通过 guard」，与路径是否真被拒无关；哪天 `check()` 不再拒系统目录，这条仍然绿。收紧为 `/系统目录|b-system-dir/`。另外两条（`/盘符/`、`/变量/`）现采已证实各自 code 的 `why` 里有对应词，保留。

- [ ] **Step 1: 写失败的测试（prefs ⑤段：暂存目录配置的形状）**

```js
/* ⑤段：clean 组（暂存目录 / 保留天数 / 清理后动作） */
const path0 = await import('node:path');
// 这里不 import guard —— ⑤段断的是 schema 的拒绝形状，guard 是在 spec.js 里被调的，
// 断言收紧到 /系统目录/ 之后，命中的是 guard 产出在 message 里的那句 `why`。

check('prefq-1 quarantineDir 必须是 guard 放行的绝对路径，且不能落在被清理目录内部', () => {
  const t = prefsMod.prefsRecord;
  const okDir = 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine';
  assert.equal(t.parse({ clean: { quarantineDir: okDir } }).clean.quarantineDir, okDir);
  assert.throws(() => t.parse({ clean: { quarantineDir: 'C:\\Windows\\q' } }), /系统目录|b-system-dir/);
  assert.throws(() => t.parse({ clean: { quarantineDir: 'AppData\\q' } }), /盘符/);
  assert.throws(() => t.parse({ clean: { quarantineDir: '%LOCALAPPDATA%\\q' } }), /变量/);
});

check('prefq-2 keepDays 7~365；到期只提醒不自动删（spec §8 的判定）', () => {
  const t = prefsMod.prefsRecord;
  assert.equal(t.parse({ clean: { keepDays: 7 } }).clean.keepDays, 7);
  assert.throws(() => t.parse({ clean: { keepDays: 6 } }), /keepDays/);
  assert.throws(() => t.parse({ clean: { keepDays: 400 } }), /keepDays/);
});

check('prefq-3 after 只有两个取值，未知值拒绝', () => {
  const t = prefsMod.prefsRecord;
  assert.equal(t.parse({ clean: { after: 'log' } }).clean.after, 'log');
  assert.throws(() => t.parse({ clean: { after: 'reboot' } }), /after/);
});

check('prefq-4 默认暂存路径在 %LOCALAPPDATA% 下（不落进被清理目录）', () => {
  const d = Q.DEFAULT_QUARANTINE('C:\\Users\\gongj\\AppData\\Local');
  assert.equal(d, path0.join('C:\\Users\\gongj\\AppData\\Local', 'dsh-plugin-sysops', 'quarantine'));
  // T14-G：宿主很可能给带尾分隔符的 %LOCALAPPDATA%。字符串直拼在这里会多出一个反斜杠，
  // 而这一行也是 Step 6 的 V4（把 join 换回直拼）唯一的红点来源 —— 少了它 V4 无人可抓。
  assert.equal(Q.DEFAULT_QUARANTINE('C:\\Users\\gongj\\AppData\\Local\\'), d, '尾分隔符不得改变结果');
  const { BUILTIN_RULES } = QruleMod;
  for (const r of BUILTIN_RULES) {
    assert.ok(!d.toLowerCase().includes(r.rel.toLowerCase().replace(/\//g, '\\').toLowerCase()), `暂存目录落在内置规则 ${r.id} 内部，会被自己清掉`);
  }
});
```

（段首补 `const Q = await import('../lib/clean/quarantine.js');` 与 `const QruleMod = await import('../lib/clean/rules.js');`。`prefq-1` 用到的 guard 校验在 spec 里做，见 Step 3 第 3 点。）

- [ ] **Step 2: 写失败的测试（clean ③段：stash 行为）**

```js
/* ③段：暂存目录（假 FS + 真 EXDEV 模拟） */
function quarFs(over = {}) {
  const files = new Map(Object.entries(over.files ?? {}));
  const dirs = new Set(over.dirs ?? []);
  return {
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    statSync: (p) => {
      if (over.isDir?.has?.(p) || dirs.has(p)) return { isFile: () => false, isDirectory: () => true, size: 0, mtimeMs: 0 };
      const f = files.get(p);
      if (!f) throw Object.assign(new Error('找不到'), { code: 'ENOENT' });
      return { isFile: () => true, isDirectory: () => false, size: f.size ?? 10, mtimeMs: 0 };
    },
    renameSync: (a, b) => {
      if (over.exdev) throw Object.assign(new Error('跨卷'), { code: 'EXDEV' });
      if (over.renameFails) throw Object.assign(new Error('被占用'), { code: 'EBUSY' });
      if (!files.has(a)) throw Object.assign(new Error('找不到'), { code: 'ENOENT' });
      files.set(b, files.get(a)); files.delete(a);
    },
    copyFileSync: (a, b) => { if (!files.has(a)) throw Object.assign(new Error('找不到'), { code: 'ENOENT' }); files.set(b, files.get(a)); },
    unlinkSync: (p) => { if (over.unlinkFails) throw Object.assign(new Error('被占用'), { code: 'EPERM' }); files.delete(p); },
    rmSync: (p) => { if (over.rmFails) throw Object.assign(new Error('非空'), { code: 'ENOTEMPTY' }); dirs.delete(p); },
    readSync: () => [],
    // 桩里所有路径都是反斜杠 ⇒ 前缀与切分都必须用反斜杠。原稿写 `p + '/'` 会让
    // stats() 恒拿到 `[]`（假绿），见 Step 0 的 T14-D。
    readdirSync: (p) => {
      const pre = `${p}\\`;
      const names = new Set();
      for (const d of dirs) if (d.startsWith(pre)) names.add(d.slice(pre.length).split('\\')[0]);
      for (const f of files.keys()) if (f.startsWith(pre)) names.add(f.slice(pre.length).split('\\')[0]);
      return [...names].filter(Boolean);
    },
    join: (...a) => a.join('\\'),
    __files: files, __dirs: dirs,
  };
}

const QU = await import('../lib/clean/quarantine.js');

// T14-B：`forbiddenPrefixes` 只能由调用方喂 —— 现采证明 guard 对 Temp 是 allow=true（Temp 本来就是可清理区），
// 不传这条则 q-6 永远绿不了，「暂存目录不得落在被清理路径内」这条红线也就没有任何执行者。
// 缺省传 Temp：q-1..q-5 的**源**在 Temp 下（源不受这条管），rootDir 在插件目录下 ⇒ 正反两条路径都被走过。
const TEMP_PREFIX = 'C:\\Users\\gongj\\AppData\\Local\\Temp';
const QUAR_ROOT = 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine';

function quarWorld(over = {}) {
  const fsMod = over.fsMod ?? quarFs({ files: { 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log': { size: 1000 } }, isDir: new Set() });
  const log = [];
  const q = QU.createQuarantine({
    rootDir: QUAR_ROOT,
    fsMod, pathMod: { join: (...a) => a.join('\\'), basename: (p) => p.split('\\').pop() },
    logger: { warn: (m) => log.push(m) },
    // T14-H：本地构造。喂 ISO 的 Z 串时，UTC 负偏移机器上 `dayDir` 的本地日期会跨到前一天 ⇒ 测试与所在时区解耦。
    now: () => new Date(2026, 8, 27, 10, 0, 0).getTime(),
    forbiddenPrefixes: [TEMP_PREFIX],
    ...over.q,
  });
  return { q, fsMod, log };
}

await checkAsync('q-1 同盘 move 成功：落到日期子目录，源消失', async () => {
  const w = quarWorld();
  const r = await w.q.stash('C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log');
  assert.equal(r.ok, true);
  assert.equal(r.method, 'move');
  assert.match(r.dest, /quarantine\\2026-09-27\\/);
  assert.equal(w.fsMod.__files.has('C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log'), false);
});

await checkAsync('q-2 EXDEV 回退 copy+delete，且先复制成功再删源', async () => {
  const w = quarWorld({ fsMod: quarFs({ files: { 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log': { size: 1000 } }, exdev: true }) });
  const r = await w.q.stash('C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log');
  assert.equal(r.method, 'copy-delete');
  assert.equal(r.ok, true);
  assert.equal(w.fsMod.__files.has(r.dest), true, '目标必须写成功');
});

await checkAsync('q-3 回退路径里 delete 失败：保留原件、报因，不算成功也不静默', async () => {
  const w = quarWorld({ fsMod: quarFs({ files: { 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log': { size: 1000 } }, exdev: true, unlinkFails: true }) });
  const r = await w.q.stash('C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log');
  assert.equal(r.ok, false);
  assert.match(r.why, /EPERM|被占用/);
  assert.equal(w.fsMod.__files.has('C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log'), true, '源文件必须还在');
  assert.ok(w.log.length >= 1);
});

await checkAsync('q-4 rename 被 EBUSY 挡住：method 保持 move 但 ok=false，原因进 why', async () => {
  const w = quarWorld({ fsMod: quarFs({ files: { 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log': {} }, renameFails: true }) });
  const r = await w.q.stash('C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log');
  assert.equal(r.ok, false);
  assert.match(r.why, /EBUSY|被占用/);
});

await checkAsync('q-5 目标名撞车时加序号前缀，绝不覆盖已暂存件', async () => {
  const fsMod = quarFs({
    files: {
      'C:\\Users\\gongj\\AppData\\Local\\Temp\\a\\old.log': { size: 11 },
      'C:\\Users\\gongj\\AppData\\Local\\Temp\\b\\old.log': { size: 22 },
    },
  });
  const w = quarWorld({ fsMod });
  const r1 = await w.q.stash('C:\\Users\\gongj\\AppData\\Local\\Temp\\a\\old.log');
  const r2 = await w.q.stash('C:\\Users\\gongj\\AppData\\Local\\Temp\\b\\old.log');
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.notEqual(r1.dest, r2.dest, '同名条目必须落在不同路径，否则第二件会盖掉第一件');
  assert.match(r2.dest, /\\2-old\.log$/, '撞名时加的是 2- **前缀**（T14-F：注释和标题都跟代码，不跟直觉）');
  assert.equal(fsMod.__files.get(r1.dest).size, 11, '第一件不得被覆盖');
  assert.equal(fsMod.__files.get(r2.dest).size, 22);
});

await checkAsync('q-6 暂存目录自身落在被清理路径下 → ensureRoot 拒绝并说清原因', async () => {
  // 只换 rootDir，forbiddenPrefixes 沿用 quarWorld 缺省（T14-B）。
  // 现采：guard 对 `…\Temp\q` 是 allow=true，所以这里的红必须归因到 forbiddenPrefixes 那道检查，不是 guard 先拒。
  const w = quarWorld({ q: { rootDir: `${TEMP_PREFIX}\\q` } });
  await assert.rejects(() => w.q.ensureRoot(), /暂存目录|不能被清理/);
});

await checkAsync('q-8 源条目已被别的程序删掉：条目级失败、说清原因，绝不走进 rename', async () => {
  // T14-C：原稿的 isDir IIFE 在 statSync 抛错时返回**对象**并继续往下跑，
  // 于是「源不存在」会被报成 method:'move'（同盘）或「目录跨卷复制未实现」（EXDEV）。
  const w = quarWorld({ fsMod: quarFs({ files: {} }) });
  const r = await w.q.stash(`${TEMP_PREFIX}\\gone.log`);
  assert.equal(r.ok, false);
  assert.equal(r.method, 'none', '不能报成 move —— 那是「已经搬走了」的意思');
  assert.equal(r.dest, '');
  assert.match(r.why, /ENOENT|找不到/);
});

await checkAsync('q-9 stats 汇总天数/件数/字节/最早日期（Task 24 的 keepDays 到期提醒只吃这四个数）', async () => {
  const fsMod = quarFs({
    files: {
      `${TEMP_PREFIX}\\a\\old.log`: { size: 11 },
      `${TEMP_PREFIX}\\b\\old.log`: { size: 22 },
    },
  });
  // 手动造一个更早的日期目录：oldest 必须取到它，而不是只回「今天」
  fsMod.mkdirSync(`${QUAR_ROOT}\\2026-09-26`);
  fsMod.__files.set(`${QUAR_ROOT}\\2026-09-26\\earlier.bin`, { size: 5 });
  const w = quarWorld({ fsMod });
  assert.equal((await w.q.stash(`${TEMP_PREFIX}\\a\\old.log`)).ok, true);
  assert.equal((await w.q.stash(`${TEMP_PREFIX}\\b\\old.log`)).ok, true);
  assert.deepEqual(await w.q.stats(), { dirs: 2, files: 3, bytes: 38, oldest: '2026-09-26' });
});

check('q-7 dayDir 用本地日期且补零', () => {
  // T14-H：夹具本地构造，断言「按本地字段取值 + 月/日补零」，与所在时区无关。
  assert.equal(QU.dayDir(new Date(2026, 8, 7, 23, 30, 0).getTime(), 'R'), 'R\\2026-09-07');
});
```

- [ ] **Step 3: 写实现**

`lib/clean/quarantine.js`：

```js
/**
 * 暂存目录：「隔离」这条路径的落点。
 *
 * 三条要点：
 *  1. **绝不覆盖**：目标重名时在名字前加 `2-` / `3-` **前缀**，撞到底（99 次）也宁可失败。
 *  2. **EXDEV 回退先写后删**（spec §4.3）：复制失败 → 原件不动；复制成功但删源失败
 *     → 返回 ok:false 并说明「副本已在暂存区，原件未删」，让用户自己决定。
 *  3. **暂存目录不能落在被清理路径里**，否则第二次扫描会清掉第一次的后悔药。
 *     这条靠 `forbiddenPrefixes`，由调用方喂（Task 15 传 active rules 的 `dir` 集）；
 *     guard 对 Temp 一类可清理区是放行的，它管不了这个。
 */
import { join } from 'node:path';
import { check } from './guard.js';

// T14-G：必须用 path.join —— 字符串直拼遇到带尾分隔符的 appData 会多出一个反斜杠，
// 而 `prefq-4` 是拿 `path.join` 的结果对比的。
export const DEFAULT_QUARANTINE = (appData) => join(appData, 'dsh-plugin-sysops', 'quarantine');

export function dayDir(now, rootDir) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${rootDir}\\${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function createQuarantine({ rootDir, fsMod, pathMod, logger, now, forbiddenPrefixes = [] }) {
  const log = (m) => logger?.warn?.(`[sysops] ${m}`);

  async function ensureRoot() {
    const g = check(rootDir);
    if (!g.allow) throw new Error(`暂存目录不合法：${g.why}`);
    for (const p of forbiddenPrefixes) {
      if (rootDir.toLowerCase().startsWith(p.toLowerCase())) {
        throw new Error(`暂存目录落在被清理路径 ${p} 内部，会被自己清掉，请改设置里的暂存目录`);
      }
    }
    if (!fsMod.existsSync(rootDir)) fsMod.mkdirSync(rootDir, { recursive: true });
    return rootDir;
  }

  function freeDest(dir, base) {
    let dest = `${dir}\\${base}`;
    for (let i = 2; fsMod.existsSync(dest) && i < 100; i += 1) dest = `${dir}\\${i}-${base}`;
    if (fsMod.existsSync(dest)) throw new Error(`暂存目录里 ${base} 的重名条目过多，停止以免覆盖`);
    return dest;
  }

  async function stash(absPath) {
    const g = check(absPath);
    if (!g.allow) return { ok: false, dest: '', method: 'none', why: g.why };
    // 配置错 → 抛异常（不是 {ok:false}）：整批该停。Task 15 在批次外层 catch。
    await ensureRoot();
    const dir = dayDir(now(), rootDir);
    if (!fsMod.existsSync(dir)) fsMod.mkdirSync(dir, { recursive: true });
    const base = pathMod.basename(absPath);
    // T14-C：这里是显式 try/catch + 提前 return。原稿把一个 IIFE 的返回值（抛错时是**对象**）
    // 赋给 isDir 再往下走，于是「源已被别的程序删掉」这个真机上最常见的条目级失败，
    // 会被报成 method:'move'（同盘 rename 抛 ENOENT）或「目录跨卷复制未实现」（先抛 EXDEV 时）。
    let isDir;
    try {
      isDir = fsMod.statSync(absPath).isDirectory();
    } catch (e) {
      return { ok: false, dest: '', method: 'none', why: `${base} 读不到：${e.code ?? e.message}` };
    }
    let dest;
    try { dest = freeDest(dir, base); } catch (e) { return { ok: false, dest: '', method: 'none', why: e.message }; }
    try {
      fsMod.renameSync(absPath, dest);
      return { ok: true, dest, method: 'move', why: '' };
    } catch (e) {
      if (e.code !== 'EXDEV') {
        log(`隔离 ${absPath} 移动失败：${e.code ?? ''} ${e.message}`);
        return { ok: false, dest: '', method: 'move', why: `${e.code ?? ''} ${e.message}` };
      }
    }
    // 跨卷回退：先复制到暂存区，成功后再删源
    try {
      if (isDir) throw new Error('目录跨卷复制未实现，请改用「直接删除」或把暂存目录放到同一盘');
      fsMod.copyFileSync(absPath, dest);
    } catch (e) {
      log(`跨卷复制失败，原件保留：${e.message}`);
      return { ok: false, dest: '', method: 'copy-delete', why: `复制失败，原件未动：${e.message}` };
    }
    try {
      fsMod.unlinkSync(absPath);
    } catch (e) {
      log(`副本已写入 ${dest} 但源删除失败：${e.code ?? ''} ${e.message}`);
      return { ok: false, dest, method: 'copy-delete', why: `副本已在暂存区，源删除失败（${e.code ?? e.message}）—— 需手动确认后再删源` };
    }
    return { ok: true, dest, method: 'copy-delete', why: '' };
  }

  async function stats() {
    const days = fsMod.existsSync(rootDir) ? fsMod.readdirSync(rootDir) : [];
    let files = 0; let bytes = 0; let oldest = null;
    for (const d of days) {
      const full = `${rootDir}\\${d}`;
      if (!fsMod.statSync(full).isDirectory()) continue;
      if (!oldest || d < oldest) oldest = d;
      for (const f of fsMod.readdirSync(full)) {
        files += 1;
        try { bytes += fsMod.statSync(`${full}\\${f}`).size; } catch (e) { log(`暂存件 ${f} 统计失败：${e.code ?? e.message}`); }
      }
    }
    return { dirs: days.length, files, bytes, oldest };
  }

  return { ensureRoot, stash, stats, rootDir: () => rootDir };
}
```

`lib/prefs/spec.js` 的 `prefsRecord` 追加 `clean` 组（`quarantineDir` 校验用 `check()`，抛的 message 是 `clean.quarantineDir 未通过 guard：${g.why}` —— `prefq-1` 的四条断言分别靠 `g.why` 里现采证实存在的「系统目录禁止操作」「盘符」「%变量%」措辞匹配，所以**别只留「未通过 guard」前缀**，`why` 必须原样带上）：

```js
/**
 * 暂存目录：路径先过 guard，再拒绝落在内置清理规则覆盖的目录里。
 * 校验放 schema 里是有意的 —— 仓储写不进去，界面就红不了，比运行到 stash 才发现早得多。
 */
clean: record({
  quarantineDir: makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.trim() === '') throw new Error('clean.quarantineDir 必须是非空字符串');
    const g = check(v);
    if (!g.allow) throw new Error(`clean.quarantineDir 未通过 guard：${g.why}`);
    return v;
  }),
  keepDays: makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || v < 7 || v > 365) throw new Error('clean.keepDays 必须是 7~365 的整数');
    return v;
  }),
  after: makeSchema((v) => {
    if (v === undefined || v === null) return undefined;
    if (!AFTER_CHOICES.includes(v)) throw new Error(`clean.after 必须是 ${AFTER_CHOICES.join(' | ')} 之一`);
    return v;
  }),
}, 'clean'),
```

顶部加 `export const AFTER_CHOICES = ['none', 'log'];` 与 `import { check } from '../clean/guard.js';`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/prefs.test.mjs` → `28/28 通过`（①3 ②4 ③6 ④11 ⑤4）
Run: `node test/clean.test.mjs` → `34/34 通过`（①14 + 真机 1 + ②10 + ③9 —— T14-I；②10 是 Task 13 的 `rec-10`，别照抄本任务书里更早的 ②9；①14 是 Task 12 两轮修复新增的 `cln-9c`/`cln-5b`/`cln-7c`）
Run: `SKIP_LOCAL=1 node test/clean.test.mjs` → `33/33 通过` + 1 行 `SKIP cln-真机-1`
Run: `node test/alerts.test.mjs` → `33/33 通过`；`node test/guard.test.mjs` → `19/19 通过`；`node test/collect.test.mjs` → `48/48 通过`

- [ ] **Step 5: 真机验一次「同盘 move + stats 非零」（T14-E）**

**禁止** `node --input-type=module -e "…"`（本仓库硬约束）。落 `tmp/t14probe.mjs` 再 `node tmp/t14probe.mjs > tmp/t14-probe.txt 2>&1`，然后 Read 那个文件（控制台 cp936 会把中文打成乱码）。
脚本里**所有反斜杠一律 `String.fromCharCode(92)` 拼**，并在开头打印一次「段数」自证输入形状。现采（控制器 2026-09-28，`node tmp/t14g.mjs` → `tmp/t14g.txt`）三条：
- 仓库内**绝对 F: 路径** → `allow=true`（探针可以落在 `tmp/` 下）；
- **相对路径** → `GUARD_NO_DRIVE`「必须是带盘符的绝对路径」⇒ `rootDir` 与源路径都必须先 `path.resolve` 再交给 `createQuarantine` / `stash`；
- **折半畸形串** `C:Usersgongjtmp…` → `allow=true`（本轮真踩过：`\` 在派单途中被折半、JS 又把 `\U` 当转义吃掉，guard 对那个畸形串是放行的 ⇒ 段数自证必须在 `resolve` **之后**打印，落在 5 段才算输入形状对）。

暂存根放仓库 `tmp/sysops-q-root`（`tmp/` 在 `.gitignore` 内），由脚本自己 `rmSync(..., { recursive: true, force: true })` 收尾 —— 自己造的临时物自己清。

```js
// tmp/t14probe.mjs —— 真机同盘 move + stats 非零；不碰用户数据区
import fs from 'node:fs';
import path from 'node:path';
const B = String.fromCharCode(92);            // 反斜杠唯一来源，别在字面量里写 \\
const SRC = path.resolve(['tmp', 'sysops-q-src.txt'].join(B));
const ROOT = path.resolve(['tmp', 'sysops-q-root'].join(B));
// 自证输入形状（resolve 之后）：盘符 + 4 段 = 5；被折半/转义吃掉时会退化
console.log('输入形状', SRC.split(B).filter(Boolean).length, JSON.stringify(SRC.split(B).filter(Boolean)));
console.log('abs?', path.isAbsolute(SRC), path.isAbsolute(ROOT));

const Q = await import('../lib/clean/quarantine.js');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.writeFileSync(SRC, 'probe');
const q = Q.createQuarantine({
  rootDir: ROOT,
  fsMod: { existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, statSync: fs.statSync,
    renameSync: fs.renameSync, copyFileSync: fs.copyFileSync, unlinkSync: fs.unlinkSync,
    rmSync: fs.rmSync, readdirSync: fs.readdirSync },
  pathMod: { basename: path.basename, join: path.join },
  logger: { warn: (m) => console.log('WARN', m) },
  now: () => Date.now(),
  forbiddenPrefixes: [path.resolve(['tmp', 'sysops-q-forbidden'].join(B))],   // 正向路径：不命中也要求解过
});
const r = await q.stash(SRC);
console.log('stash →', r.ok, r.method, r.dest);
console.log('源还在？', fs.existsSync(SRC));
console.log('stats →', await q.stats());
console.log('二次 stash 同一个已消失的源 →', await q.stash(SRC));   // T14-C 的真机对账
fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(SRC, { force: true });
```

Expected 六行：`输入形状 5 ["F:","dsh-plugins","dsh-plugin-sysops","tmp","sysops-q-src.txt"]`；`abs? true true`；`stash → true move`（dest 在 `<ROOT>\<本地当天日期>\` 下）；`源还在？ false`；`stats → { dirs: 1, files: 1, bytes: 5, oldest: <本地当天> }`；末行 `ok:false method:'none'` —— **源不存在必须报 `none`，不得报 `move`**（T14-C）。
`tmp/` 由脚本自己清干净；跑完 `git status --short` 必须仍是净的。

- [ ] **Step 6: 变异自证（六次「破坏 → 跑红 → 还原 → 重跑全绿」，写入交付报告）**

前置（Task 11 实测教训）：`lib/clean/quarantine.js` 是本任务新建的**未跟踪文件**，`git diff --numstat` 对未跟踪内容恒为空、取不到证 ⇒ 电池开始前先 `git add` 本任务那四个文件，此后 numstat 是「工作区 vs 暂存区」，变异非空 / 还原为空才可验证。**提交前终检 `git status --short -- lib test` 必须只剩这四条已暂存记录。**
每条都要当轮跑出**同一个红点**（下面写的红点是控制器预检推断，照抄不算取证），还原后 `node test/clean.test.mjs` 与 `node test/prefs.test.mjs` 都要回到 `31/31`、`28/28`。

| 编号 | 破坏 | 预期红在 | 为什么值得破坏 |
|---|---|---|---|
| V1 | `stash()` 里 `isDir` 的显式 try/catch 换回原稿形状（IIFE 抛错时 `return { ok:false, … }` 那个**对象**赋给 `isDir`，代码继续走 `freeDest` / `renameSync`） | **只红 `q-8`**：`method` 报成 `move` | 真机上最常见的条目级失败就是「源已被别的程序删掉」。红点必须证明 `method:'none'` 这一格有断言承重 —— 否则 Task 15 的三档计数会把「没搬走」算进「已隔离」 |
| V2 | 删掉 `ensureRoot()` 里 `for (const p of forbiddenPrefixes) …` 那一段 | **只红 `q-6`** | 现采证明 guard 对 `Temp\q` 是 `allow=true`，这条红线**只有** `forbiddenPrefixes` 在执行；删了它「第二次扫描清掉第一次的后悔药」无人可挡 |
| V3 | `quarFs` 的 `readdirSync` 前缀匹配换回 `p + '/'`（反斜杠桩配斜杠前缀） | **只红 `q-9`**（`files`/`bytes` 归 0、`oldest` 变 `null` ⇒ `deepEqual` 红） | 证桩修不是白改：`stats()` 在原稿下恒为 0，任何照原稿补的测试都是**假绿** |
| V4 | `DEFAULT_QUARANTINE` 改回 `` `${appData}\\dsh-plugin-sysops\\quarantine` `` 字符串直拼 | `prefq-4` 里尾分隔符那一行 | 宿主给的 `%LOCALAPPDATA%` 常带尾分隔符 ⇒ 双反斜杠路径进 guard、进设置页显示，`join` 的归一化是唯一的抓网 |
| V5 | copy-delete 分支里去掉 `unlinkSync` 的 catch（删源失败也照样 `return { ok:true … }`） | **红 `q-3`**（`q-2` 仍绿） | 「副本已在暂存区、原件未删，需手动确认」这句话只有 `q-3` 在钉；静默吞掉等于告诉用户搬完了 |
| V6 | spec 的 `keepDays` 去掉上界（保留 `v < 7` 那条） | **只红 `prefq-2`** | spec §8 定的是「到期只提醒、不自动删」，保留期无上界 = 用户可以把暂存件设成永久而无人提醒 |

**红点必须是「只红它该红的那条」**：V1/V2/V3/V6 如果出现额外红点，先判是否同因（同一处字节被两条断言读到），同因可接受并在报告里写清；如果是断言之间互相兜底，就要在报告里说明哪条是主力。

提交信息草稿：`feat(sysops): 暂存目录（EXDEV 回退先写后删 + 暂存位置红线校验）`

## Task 15: `lib/clean/executor.js` + `lib/clean/service.js` —— 两段式的第二半

**Files:**
- Create: `lib/clean/executor.js`
- Create: `lib/clean/service.js`
- Modify: `test/clean.test.mjs`（追加 ④段 executor、⑤段 service；统计/exit 挪到末尾）

**Interfaces:**
- Consumes: `check` / `checkOperation`（Task 2）、`createPlanStore` / `createLogStore`（Task 13）、`createQuarantine`（Task 14）、`createScanner`（Task 12）、`createRuleStore`（Task 11）、`prefs.clean.after`
- Produces:
  - `createExecutor({ fsMod, planStore, logStore, quarantine, logger, now, onEvent })` → `{ apply({ planId, itemIds, mode }) → Promise<Summary> }`
  - `Summary = { planId, logId, ok, skipped, failed, rejected, bytesFreed, beforeFree, afterFree, results: [item result] }`，整批拒时另有 **`error`**（`GUARD_OPERATION_DENIED` / `SYSOPS_RECORDS_NOT_FOUND` / `SYSOPS_QUARANTINE_UNAVAILABLE`，见 T15-B/T15-E —— Task 18 的 `statusFor(code)` 要能查到这三条）
  - item result：`{ id, state: 'ok'|'skipped'|'rejected-snapshot'|'rejected-unknown'|'failed', errnoText, dest?, path }`
  - `createCleanService({ ruleStore, makeScanner, makeExecutor, makeQuarantine, planStore, logStore, getPrefs, fsMod, osMod, pathMod, logger, now })` → `{ startScan(), stopScan(), state(), apply({planId,itemIds,mode}), plans({limit}), logs({limit}), unfinished(), quarantineStats(), onEvent(cb) → unsub, dispose() }`
  - **`makeQuarantine({ rootDir, fsMod, pathMod, logger, now, forbiddenPrefixes })` 是 Task 14 那条红线的唯一真实喂入者**（T15-A）：`rootDir` 取 `prefs.clean.quarantineDir ?? DEFAULT_QUARANTINE(join(osMod.homedir(), 'AppData', 'Local'))`，`forbiddenPrefixes` 取 `(await ruleStore.activeRules()).map((r) => r.dir)`。
  - 事件：`{type:'clean:progress', …}` / `{type:'clean:done', plan}` / `{type:'clean:item', …}` / `{type:'clean:summary', summary}` / `{type:'clean:error', where, error}`

- [ ] **Step 0: 预检裁定（Ruling-76，控制器 2026-09-28 现采，执行者照此实现，不要再自行发明）**

| 编号 | 问题 | 裁定（已落进下面的 Step 1/2/4/5/6 代码） |
|---|---|---|
| **T15-A**（Critical） | **Task 14 的暂存红线没有任何构造者。** `createQuarantine` 在 Consumes 里列着，但 `createCleanService` 的参数表里根本没有 quarantine；Step 4 的 service 要点通篇不提它。`quarantineStats()` 同样无人实现其来源。⇒ 「暂存目录不得落在被清理路径内」这条只活在 Task 14 的测试里（Ruling-72 的「另记」预言的正是这个），`prefs.clean.quarantineDir` 存进去后运行时没人读 | service 加 `makeQuarantine` 工厂参数，**每次 `apply` / `quarantineStats` 现造**（prefs 与规则集都会在两次调用之间变）：`rootDir = getPrefs().clean?.quarantineDir ?? DEFAULT_QUARANTINE(join(osMod.homedir(),'AppData','Local'))`，`forbiddenPrefixes = (await ruleStore.activeRules()).map(r => r.dir)`。新增 **`cs-8`** 断这两样真的传进去了 |
| **T15-B**（Critical） | **`stash()` 的抛异常没人接。** Task 14 Interfaces 明写「配置错整批停 ⇒ 批次外层 catch」，而 Step 4 的条目循环里 `await quarantine.stash(path)` 抛出的话会一路穿透 `apply()` → HTTP 层 500，用户看到的是「服务器错误」而不是「暂存目录配错了」 | executor 在 `mode === 'move-to-quarantine'` 时**先于条目循环** `await quarantine.ensureRoot()` 并 try/catch ⇒ 抛即整批返回 `{ error:'SYSOPS_QUARANTINE_UNAVAILABLE', ok:0, skipped:0, failed:0, rejected:0, results:[] }` 且**一个条目都不碰**。`delete-file` / `delete-dir` **不得**调 `ensureRoot()`（删除模式不该被暂存配置错拖死）。新增 **`ex-12`** 钉住这两半 |
| **T15-C**（计数） | Step 5 期望 `46/46（①12 ②9 ③7 ④11 ⑤7）`、`SKIP_LOCAL 40/40` —— ②9/③7 是 Task 13/14 闭环前的旧账（②已随 `rec-10` 变 10、③已随 `q-8`/`q-9` 变 9、①已随 Task 12 两轮修复变 14+真机 1 = 15），且本任务自己还要加 `ex-9b`/`ex-12`/`cs-8`/`cs-9` | 新期望 **`56/56`**（①14 + 真机 1 = 15，加 ②10 + ③9 + ④13 + ⑤9），`SKIP_LOCAL=1` ⇒ **`55/55` + 1 行 SKIP**。两行草稿读数（46、40）都是错的，一并作废；④/⑤ 以本任务书逐段清点为准，派单前控制器会再核对一次 |
| **T15-D**（Critical，硬约束） | Step 6 用 `node --input-type=module -e "…"`，里面还全是字面 `\` 与 `'C:\\\\*'` 这种双层转义 —— 与本仓库硬约束冲突（同 T14-E），且派单途中 `\` 会再折半一次 | 落 `tmp/t15e2e.mjs`，反斜杠一律 `String.fromCharCode(92)`，打印段数自证。**样本根从 `%TEMP%` 挪进仓库 `tmp/sysops-clean-e2e`**：这是全仓库唯一真删文件的用例，自建自删的目录比动用户真实 Temp 更守得住「不碰范围外之物」；现采（`tmp/t14g.txt`）证明 guard 对仓库内绝对 F: 路径 `allow=true`，红线不受影响 |
| **T15-E**（Important） | `Summary` 类型里没有 `error` 键，而 ex-4 断 `sum.error === 'GUARD_OPERATION_DENIED'`、ex-11 断 `sum.error === 'SYSOPS_RECORDS_NOT_FOUND'`；Task 18 的 `statusFor(code)` 按 code 分支 | 三个整批拒的 code 写进 Produces（Interfaces 已改），Task 18 派单时把这三条一起给它 |
| **T15-F**（Important） | `cs-4` 标题写「state.stopped 标出」，断言却是 `svc.__stopped` —— 那是**桩自己**在 `stop()` 里挂到 `svc` 上的属性，与 service 的 `state().stopped` 无半点关系；Task 22 的扫描条吃的正是 `state().stopped` | 桩改成往 `stoppedCalls` 里记一笔，断 `stoppedCalls.length === 1` **且** `svc.state().stopped === true` |
| **T15-G**（Minor） | `ex-9` 一条用例里同时验「stash 成功带 dest」与「stash 失败判 skipped + why」两个分支（违反本仓库「一个用例一个分支」） | 拆成 `ex-9`（成功，断 `dest` 与 `state:'ok'`）与 `ex-9b`（失败，断 `skipped` + `errnoText` 含原因 + **源文件仍在**） |
| **T15-H**（Minor） | Step 4 引用的用例名 `csb-7` 不存在（⑤段是 `cs-1..cs-7`）；`ex-8` 一条用例 for 循环三种 errno —— 这是**同一个分支的三种拼写**，与 T15-G 不同，保留 | `csb-7` 改 `cs-7`；`ex-8` 不动，但每轮要多断一句 `sum.skipped === 1`，免得循环里第二次迭代继承了第一次的计数 |

现采补证（本轮 `node tmp/t14g.mjs` → `tmp/t14g.txt`）：`check()` 对仓库内绝对 F: 路径 `allow=true`、对相对路径 `GUARD_NO_DRIVE`、对折半畸形串 `allow=true` ⇒ 凡探针脚本，路径先 `path.resolve` 再交给 guard。另：`GUARD_CODE.OPERATION_DENIED` 的字面量现采为 `GUARD_OPERATION_DENIED`（`lib/clean/guard.js:37`），ex-4 的断言串成立；`RECORDS_ERROR.NOT_FOUND` 的字面值由 Task 13 定为 `SYSOPS_RECORDS_NOT_FOUND`（计划 `:4606`），ex-11 同串。

- [ ] **Step 1: 写失败的测试（④段 executor）**

```js
/* ④段：执行器（假 FS + 真快照仓储，路径只从快照来） */
const EX = await import('../lib/clean/executor.js');

const PLAN_ITEM = (over = {}) => ({
  id: 'temp-user-aG9tZQ', ruleId: 'temp-user', ruleName: '用户临时目录', kind: '缓存',
  path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log', size: 1000, count: 1,
  atime: 1, mtime: 1, riskLevel: 'mid', ...over,
});

/** 假 FS：条目按快照里的 items 建，偏差/新增/占用都通过 over 注入。 */
function exFs(items, over = {}) {
  const files = new Map();
  const dirs = new Set();
  for (const it of items) {
    if (it.dir === true) dirs.add(it.path);
    else files.set(it.path, { size: it.size, mtimeMs: it.mtime });
  }
  const boom = (code) => { throw Object.assign(new Error('被占用'), { code }); };
  const statOf = (p) => {
    if (files.has(p)) { const f = files.get(p); return { isFile: () => true, isDirectory: () => false, size: over.currentSize ?? f.size, mtimeMs: f.mtimeMs }; }
    if (dirs.has(p)) { const it = items.find((x) => x.path === p); return { isFile: () => false, isDirectory: () => true, size: it.size, mtimeMs: it.mtime }; }
    if (over.dirChildren?.length) return { isFile: () => true, isDirectory: () => false, size: 1, mtimeMs: over.childrenMtimeMs ?? 1 };
    throw Object.assign(new Error('找不到'), { code: 'ENOENT' });
  };
  return {
    files, dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    statSync: (p) => { if (over.errno) boom(over.errno); return statOf(p); },
    unlinkSync: (p) => { if (over.unlinkErrno) boom(over.unlinkErrno); files.delete(p); },
    rmSync: (p) => { if (over.rmErrno) boom(over.rmErrno); files.delete(p); dirs.delete(p); },
    readdirSync: () => over.dirChildren ?? [],
    realpathSync: (p) => p,
    join: (a, b) => `${a}\\${b}`,
    statfsSync: () => ({ available: over.afterFree ?? 71 * 2 ** 30 }),
  };
}

function exWorld(items, over = {}) {
  const fsMod = over.fsMod ?? exFs(items, over);
  const facility = createMemoryFacility();
  const planStore = createPlanStore({ getFacility: () => facility, logger: { warn() {} }, now: () => 5000, newId: () => 'p-1' });
  const logStore = createLogStore({ getFacility: () => facility, logger: { warn() {} }, now: () => 8000 });
  const events = [];
  // T15-B：executor 在 move 模式下会**先**调 ensureRoot()（整批闸门），桩必须供得上这个方法；
  // 缺了它，exWorld 造的默认桩会让 ex-1/9/9b 在闸门处 TypeError —— 红得毫无意义。
  const quarantine = over.quarantine ?? {
    ensureRoot: async () => 'Q',
    stash: async (p) => ({ ok: true, dest: 'Q\\' + p.split('\\').pop(), method: 'move', why: '' }),
    stats: async () => ({ dirs: 0, files: 0, bytes: 0, oldest: null }),
  };
  const exec = EX.createExecutor({
    fsMod, planStore, logStore, quarantine,
    logger: { warn: (m) => events.push({ type: 'log', m }) },
    now: () => 9000,
    onEvent: (e) => events.push(e),
  });
  return { fsMod, files: fsMod.files, dirs: fsMod.dirs, facility, planStore, logStore, exec, events, quarantine };
}

/** executor 只认快照，所以测试要先真存一份。 */
async function seeded(items, over = {}) {
  const w = exWorld(items, over);
  await w.planStore.save(
    { items, totals: { n: items.length, bytes: items.reduce((a, b) => a + b.size, 0) }, walked: 9, hit: items.length, skipped: [], stopped: false, truncated: false, at: 5000 },
    { beforeFree: 70 * 2 ** 30, modeDefault: items[0]?.dir === true ? 'delete-dir' : 'delete-file' },
  );
  return w;
}

await checkAsync('ex-1 正常删一项：state=ok、写留痕、afterFree 更新', async () => {
  const w = await seeded([PLAN_ITEM()]);
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(sum.ok, 1);
  assert.equal(sum.results[0].state, 'ok');
  assert.equal(w.files.has(PLAN_ITEM().path), false, '文件应被删');
  assert.equal(sum.bytesFreed, 1000);
  const logs = await w.logStore.list({ limit: 5 });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].finishedAt, 'finish 落库时必须盖完成时间');
});

await checkAsync('ex-2 伪造 itemId 直接拒，且一个文件都不碰（spec §5 的红线用例）', async () => {
  const w = await seeded([PLAN_ITEM()]);
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['evil-id'], mode: 'delete-file' });
  assert.equal(sum.rejected, 1);
  assert.equal(sum.results[0].state, 'rejected-unknown');
  assert.equal(w.files.has(PLAN_ITEM().path), true, '不在快照里的 id 不得引发任何删除');
});

await checkAsync('ex-3 前端传来的路径字段完全被忽略（只按 id 找）', async () => {
  const w = await seeded([PLAN_ITEM()]);
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file', path: 'C:\\Windows\\win.ini', paths: ['C:\\Windows'] });
  assert.equal(sum.ok, 1);
  assert.equal(sum.results[0].path, PLAN_ITEM().path, '执行对象必须来自快照');
});

await checkAsync('ex-4 未知 mode 拒（只允许三个操作，不给改 ACL/结束进程留口）', async () => {
  const w = await seeded([PLAN_ITEM()]);
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'takeown' });
  assert.equal(sum.error, 'GUARD_OPERATION_DENIED');
  assert.equal(sum.ok, 0);
});

await checkAsync('ex-5 re-stat：大小偏差 >10% → rejected-snapshot 不删', async () => {
  const w = await seeded([PLAN_ITEM()], { currentSize: 5000 });
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(sum.results[0].state, 'rejected-snapshot');
  assert.match(sum.results[0].errnoText, /偏差|重新扫描/);
  assert.equal(w.files.has(PLAN_ITEM().path), true);
});

await checkAsync('ex-6 re-stat：快照之后有新增/修改的条目 → rejected-snapshot', async () => {
  const dir = 'C:\\Users\\gongj\\AppData\\Local\\Temp\\olddir';
  const w = await seeded([PLAN_ITEM({ path: dir, size: 1000, count: 2, dir: true })], { dirChildren: ['new.bin'], childrenMtimeMs: 9999 });
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-dir' });
  assert.equal(sum.results[0].state, 'rejected-snapshot');
  assert.match(sum.results[0].errnoText, /新增|修改/);
});

await checkAsync('ex-7 目录已消失 → rejected-snapshot（不是 failed，用户没做错事）', async () => {
  const w = await seeded([PLAN_ITEM()]);
  w.files.delete(PLAN_ITEM().path);
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(sum.results[0].state, 'rejected-snapshot');
});

await checkAsync('ex-8 EBUSY/EPERM/ENOTEMPTY → skipped 且只试一次（重试只会拉长锁定期）', async () => {
  for (const errno of ['EBUSY', 'EPERM', 'ENOTEMPTY']) {
    const w = await seeded([PLAN_ITEM()], { unlinkErrno: errno, rmErrno: errno });
    const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
    assert.equal(sum.results[0].state, 'skipped', `${errno} 应判为 skipped`);
    assert.match(sum.results[0].errnoText, new RegExp(errno));
    assert.equal(sum.failed, 0);
    assert.equal(sum.skipped, 1, `${errno}：循环到第二种 errno 时计数不得从上一轮继承（T15-H）`);
  }
});

await checkAsync('ex-9 move-to-quarantine 走 quarantine.stash 并落 dest', async () => {
  const w = await seeded([PLAN_ITEM()]);
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'move-to-quarantine' });
  assert.equal(sum.results[0].state, 'ok');
  assert.match(sum.results[0].dest, /^Q\\/);
});

await checkAsync('ex-9b stash 返回 ok:false → skipped + 原因，且原件不得消失（T15-G：失败分支独立成例）', async () => {
  const w = await seeded([PLAN_ITEM({ id: 'x-2', path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\b.log' })],
    { quarantine: { stash: async () => ({ ok: false, dest: '', method: 'move', why: 'EPERM 被占用' }), ensureRoot: async () => 'Q' } });
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['x-2'], mode: 'move-to-quarantine' });
  assert.equal(sum.results[0].state, 'skipped');
  assert.match(sum.results[0].errnoText, /被占用/);
  assert.equal(w.files.has('C:\\Users\\gongj\\AppData\\Local\\Temp\\b.log'), true, '隔离失败等于「什么都没做」，原件必须在');
});

await checkAsync('ex-10 realpath 落到受保护目录 → rejected-snapshot + guard 原因（junction 逃逸）', async () => {
  const w = await seeded([PLAN_ITEM()]);
  w.fsMod.realpathSync = () => 'C:\\Windows\\evil';
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(sum.results[0].state, 'rejected-snapshot');
  assert.match(sum.results[0].errnoText, /GUARD|受保护/);
});

await checkAsync('ex-11 快照不存在 → 整批拒并留一条错误，不抛给 HTTP 层', async () => {
  const w = await seeded([PLAN_ITEM()]);
  const sum = await w.exec.apply({ planId: 'p-nope', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(sum.error, 'SYSOPS_RECORDS_NOT_FOUND');
  assert.equal(sum.results.length, 0);
});

await checkAsync('ex-12a 暂存目录配错（ensureRoot 抛）+ move 模式 → 整批拒、一个条目都不碰（T15-B：批次外层 catch）', async () => {
  const w = await seeded([PLAN_ITEM()], {
    quarantine: { ensureRoot: async () => { throw new Error('暂存目录落在被清理路径 C:\\Users\\gongj\\AppData\\Local\\Temp 内部'); }, stash: async () => ({ ok: true, dest: 'X', method: 'move', why: '' }) },
  });
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'move-to-quarantine' });
  assert.equal(sum.error, 'SYSOPS_QUARANTINE_UNAVAILABLE');
  assert.equal(sum.ok, 0);
  assert.equal(sum.results.length, 0, '闸门之后一条都不该跑 —— 逐条 catch 会把「整批停」降级成「逐条失败」');
  assert.equal(w.files.has(PLAN_ITEM().path), true, '源文件必须还完整存在');
});

await checkAsync('ex-12b 同一个配错的暂存目录，delete-file 模式不受牵连（闸门只管 move）', async () => {
  const w = await seeded([PLAN_ITEM()], {
    quarantine: { ensureRoot: async () => { throw new Error('暂存目录不合法'); }, stash: async () => ({ ok: true, dest: 'X', method: 'move', why: '' }) },
  });
  const sum = await w.exec.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(sum.error, undefined, '删除模式不该被暂存配置错拖死');
  assert.equal(sum.ok, 1);
});
```

- [ ] **Step 2: 写失败的测试（⑤段 service 编排）**

```js
/* ⑤段：清理服务（一次只允许一个扫描；进度与完成事件汇给 api.js） */
const CS = await import('../lib/clean/service.js');

function csWorld(over = {}) {
  const events = [];
  const execArgs = [];
  const stoppedCalls = [];      // T15-F：cs-4 要断「stopScan 真转给了 scanner」，不能靠桩往 svc 上挂属性
  const quarArgs = [];          // T15-A：makeQuarantine 收到的实参是这条红线唯一的可观测点
  const facility = createMemoryFacility();
  const prefStore = createPrefStore({ getFacility: () => facility, logger: { warn() {} }, now: () => 1000 });
  const ruleStore = createRuleStore({ prefStore, logger: { warn() {} } });
  const planStore = createPlanStore({ getFacility: () => facility, logger: { warn() {} }, now: () => 5000, newId: () => over.planId ?? 'p-1' });
  const logStore = createLogStore({ getFacility: () => facility, logger: { warn() {} }, now: () => 8000 });
  const scannerCalls = [];
  let scanResolve = null;
  const svc = CS.createCleanService({
    ruleStore,
    makeScanner: ({ onProgress }) => ({
      scan: async (rules) => {
        scannerCalls.push({ n: rules.length });
        over.progress?.forEach(() => onProgress({ dir: 'x', walked: 1, hit: 0, bytes: 0 }));
        await new Promise((r) => { scanResolve = r; setTimeout(r, 0); });
        if (over.scanThrows) throw new Error('遍历炸了');
        return over.scanResult ?? { items: [PLAN_ITEM()], totals: { n: 1, bytes: 1000 }, walked: 10, hit: 1, skipped: [], stopped: false, truncated: false, at: 5000 };
      },
      stop: () => { stoppedCalls.push(1); if (scanResolve) scanResolve(); },
    }),
    // T15-A：service 必须自己造 quarantine 并把 rootDir / forbiddenPrefixes 喂进去。
    // 桩只记实参、返回一个够用的假对象，断言全部打在 quarArgs 上。
    makeQuarantine: (a) => {
      quarArgs.push(a);
      return {
        ensureRoot: async () => a.rootDir,
        stash: async (p) => ({ ok: true, dest: 'Q\\' + p.split('\\').pop(), method: 'move', why: '' }),
        stats: async () => ({ dirs: 2, files: 3, bytes: 38, oldest: '2026-09-26' }),
      };
    },
    makeExecutor: ({ onEvent }) => ({
      apply: async (args) => {
        execArgs.push(args);
        onEvent({ type: 'clean:item', id: args.itemIds[0], state: 'ok', errnoText: '', path: 'x' });
        return over.summary ?? { planId: args.planId, logId: 'l-1', ok: 1, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1000, beforeFree: 1, afterFree: 2, results: [] };
      },
    }),
    planStore, logStore,
    getPrefs: () => ({ clean: { after: over.after ?? 'log', keepDays: 7, ...(over.quarantineDir ? { quarantineDir: over.quarantineDir } : {}) } }),
    fsMod: { statfsSync: () => ({ available: 60 * 2 ** 30 }) },
    osMod: { homedir: () => 'C:\\Users\\gongj' },
    pathMod: { join: (...a) => a.join('\\') },
    logger: { warn: (m) => events.push({ type: 'log', m }) },
    now: () => 5000,
  });
  svc.onEvent((e) => events.push(e));
  return { svc, events, execArgs, scannerCalls, stoppedCalls, quarArgs, facility, planStore, logStore, ruleStore };
}

await checkAsync('cs-1 startScan → 事件流有 progress 与 done，state 落 ready 且带 planId', async () => {
  const w = csWorld();
  await w.svc.startScan();
  assert.equal(w.svc.state().phase, 'ready');
  assert.equal(w.svc.state().planId, 'p-1');
  assert.ok(w.events.some((e) => e.type === 'clean:done'));
});

await checkAsync('cs-2 扫描期间再点「开始扫描」不并行（两条遍历抢 IO 且清单会互相覆盖）', async () => {
  const w = csWorld({ progress: [null] });
  const a = w.svc.startScan();
  const b = await w.svc.startScan();
  assert.equal(b.busy, true, '第二次要给出忙碌回执');
  await a;
  assert.equal(w.scannerCalls.length, 1);
});

await checkAsync('cs-3 扫描抛错：clean:error 可见 + state.phase 回 idle + error 有文案（不静默）', async () => {
  const w = csWorld({ scanThrows: true });
  await w.svc.startScan();
  assert.ok(w.events.some((e) => e.type === 'clean:error' && /遍历炸了/.test(e.error)));
  assert.equal(w.svc.state().phase, 'idle');
  assert.match(w.svc.state().error, /遍历炸了/);
});

await checkAsync('cs-4 stopScan 转成 scanner.stop()，state.stopped 标出（清单仍可查看已发现部分）', async () => {
  const w = csWorld();
  const p = w.svc.startScan();
  w.svc.stopScan();
  await p;
  // T15-F：断的是「真转给了 scanner」+「Task 22 渲染用的 state().stopped」，
  // 原稿断的 svc.__stopped 是桩自己挂上去的属性，跟 service 的 state 没半点关系。
  assert.equal(w.stoppedCalls.length, 1);
  assert.equal(w.svc.state().stopped, true);
});

await checkAsync('cs-5 apply 只把 planId+itemIds+mode 交给 executor，前端带来的路径字段一概不转', async () => {
  const w = csWorld();
  await w.svc.startScan();
  await w.svc.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file', path: 'C:\\Windows\\x', paths: ['C:\\Windows'] });
  assert.equal(w.execArgs.length, 1);
  assert.deepEqual(Object.keys(w.execArgs[0]).sort(), ['itemIds', 'mode', 'planId']);
});

await checkAsync('cs-6 after=log 时带执行后可用容量并通知采集重读；after=none 两者都不做', async () => {
  const a = csWorld({ after: 'log' });
  await a.svc.startScan();
  const s1 = await a.svc.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(s1.afterFree, 60 * 2 ** 30, 'after=log 时用 statfsSync 现读（world 里给的是 60GB）');
  assert.ok(a.events.some((e) => e.type === 'collect:refresh'), 'after=log 要推一次曲线刷新');
  const b = csWorld({ after: 'none' });
  await b.svc.startScan();
  const s2 = await b.svc.apply({ planId: 'p-1', itemIds: ['temp-user-aG9tZQ'], mode: 'delete-file' });
  assert.equal(s2.afterFree, 2, 'after=none 不现读，沿用执行器汇总里的值');
  assert.ok(b.events.some((e) => e.type === 'clean:summary'), '留痕与汇总恒定写（spec §7）');
  assert.ok(!b.events.some((e) => e.type === 'collect:refresh'));
});

await checkAsync('cs-7 unfinished() 透出未确认完成的留痕（重启后界面提示指向它）', async () => {
  const w = csWorld();
  await w.logStore.start({ planId: 'p-0', itemIds: ['a'], mode: 'delete-file' });
  const rows = await w.svc.unfinished();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].planId, 'p-0');
});

await checkAsync('cs-8 makeQuarantine 收到 prefs 的 quarantineDir 与「当前 active rules 的 dir 集」—— Task 14 那条红线的唯一真实喂入者（T15-A）', async () => {
  const qd = 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine';
  const w = csWorld({ quarantineDir: qd });
  const s = await w.svc.quarantineStats();
  assert.deepEqual(s, { dirs: 2, files: 3, bytes: 38, oldest: '2026-09-26' }, 'stats() 原样透出，界面才有 keepDays 到期提醒的数据');
  assert.equal(w.quarArgs.length, 1);
  assert.equal(w.quarArgs[0].rootDir, qd, 'prefs 设了就必须用 prefs 的');
  const rules = await w.ruleStore.activeRules();
  assert.deepEqual(w.quarArgs[0].forbiddenPrefixes, rules.map((r) => r.dir), '被清理路径集必须来自 activeRules()，写死一份等于两处口径');
  assert.ok(w.quarArgs[0].forbiddenPrefixes.length > 0, '内置库有 10 条 active，空集就是没喂');
  // 口径单点的证据：默认关的两条不在 activeRules 里 ⇒ 也不该出现在 forbidden 集里。
  // 只断 `rules.map(r=>r.dir)` 与本表达式相等是套套逻辑，这一条才是「两处口径」的抓网。
  const { BUILTIN_RULES, DEFAULT_OFF } = QruleMod;
  assert.equal(w.quarArgs[0].forbiddenPrefixes.length, BUILTIN_RULES.length - DEFAULT_OFF.length);
});

await checkAsync('cs-9 prefs 没设 quarantineDir 时回落到 %LOCALAPPDATA% 下的内置默认（界面与执行器不能两套默认）', async () => {
  const w = csWorld();                       // getPrefs 里没有 quarantineDir
  await w.svc.quarantineStats();
  // QUAR_ROOT 与 csWorld 的 homedir('C:\\Users\\gongj') 拼出来的回落值同源：都走 DEFAULT_QUARANTINE
  assert.equal(w.quarArgs[0].rootDir, QU.DEFAULT_QUARANTINE('C:\\Users\\gongj\\AppData\\Local'));
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node test/clean.test.mjs`
Expected: `ex-1` 起 `ERR_MODULE_NOT_FOUND` 指向 `lib/clean/executor.js`。

- [ ] **Step 4: 写实现**

`lib/clean/executor.js` 要点：

- **入参闸门在前**：`const op = checkOperation(mode); if (!op.allow) return { error: op.code, ok: 0, … }`（ex-4）。整批不做任何 IO 就返回。
- 快照：`const plan = await planStore.get(planId)`，缺 → `{ error: RECORDS_ERROR.NOT_FOUND … }`（ex-11）；`index = new Map(plan.items.map(i => [i.id, i]))`。
- `itemIds` 里不认识的 id → `rejected-unknown`（ex-2）。**除 `planId/itemIds/mode` 之外的字段一概不读**（ex-3、cs-5）。
- 逐条顺序处理（不并发，删除并发只会让文件锁冲突更难查）：
  1. `realpathSync` → `check(path, { real })`，不通过 → `rejected-snapshot` + `errnoText = g.why`（ex-10）。
  2. re-stat：`ENOENT` → `rejected-snapshot`（ex-7）；`plan` 记录的 size 与实际偏差 `> 0.1` → `rejected-snapshot` 并说明「与扫描那一刻偏差 X%，请重新扫描」（ex-5）；目录还多出 `mtimeMs > plan.at` 的子项 → `rejected-snapshot`（ex-6）。
  3. 按 mode 动手：`delete-file` → `unlinkSync`；`delete-dir` → `rmSync(p, { recursive: true, maxRetries: 0 })`；`move-to-quarantine` → `await quarantine.stash(path)`，`ok:false` → `skipped` + `why`（ex-9）。
  4. `EBUSY/EPERM/ENOTEMPTY` → `skipped`，其它 errno → `failed`（ex-8）。**不重试**：`maxRetries: 0` 显式写出来，`rmSync` 默认会重试。
  5. 每条 `onEvent({ type:'clean:item', id, state, errnoText, path, dest })`。
- 汇总：`logStore.start()` 在动手前调（这样中断能留下 `running` 行 → ex-1/csb-7 的 unfinished 判定成立）；`logStore.finish()` 在所有条目跑完后调，带三档计数、`bytesFreed`、`afterFree`（`fsMod.statfsSync('C:')` 换算，取不到就 `null` 并 `logger.warn`，不许拿旧值冒充）。
- `bytesFreed` 只累加 `state==='ok'` 且 mode 为删除类的 `plan` 记录的 size（快照值，不是现值 —— 与 §7「留痕冻结快照」一致）。

`lib/clean/service.js` 要点：

- 单飞：`let running = null`；`startScan()` 时若 `running` 存在 → 返回 `{ busy: true }`（cs-2）并把当前进度原样回吐，让第二个前端连上也能看到进度。
- 规则来源：`await ruleStore.activeRules()` → `rules.map(r => expandRule(r, { home: osMod.homedir() }))`（Task 12），扫描器由 `makeScanner({ fsMod, osMod, now, logger, onProgress })` 造，`onProgress` 里转发 `clean:progress` 事件并更新 `state`。
- `beforeFree`：扫描开始时读一次 `statfsSync`，随快照存进 `planStore.save(scan, { beforeFree, modeDefault })`；`modeDefault` 取 `prefs.clean.after` 无关，用 `'delete-file'`（界面可切）。
- `apply(args)`：只把 `{planId, itemIds, mode}` 三键传给 executor（cs-5 用 `Object.keys` 断言这一点）；`after === 'log'` 时汇总里带执行后 `afterFree` 并 `onEvent({type:'collect:refresh'})` 让 api 转告采集服务重读磁盘（`after === 'none'` 不刷）。
- `state()` 字段固定：`{ phase, dir, walked, hit, bytes, stopped, truncated, skipped, planId, error }` —— Task 22 的扫描条按它渲染。
- `dispose()`：`stopScan()` + 清 listeners；不 dispose 仓储（domain 由 `index.js` 统一关，避免两处 close 撞车）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node test/clean.test.mjs`
Expected: `56/56 通过`（①15 + ②10 + ③9 + ④13 + ⑤9 = 56，与 T15-C 同行内算式一致）
> 逐段清点（Task 12 两轮修复后的实际落地数，别照抄本任务书更早的草稿）：①段 15 条 = `cln-1..10` + `cln-9b` + `cln-9c` + `cln-5b` + `cln-7c` + `cln-真机-1`；
> ②段 10 条 = `rec-1..rec-10`（Task 13 闭环数，`25/25` 已现证）；③段 9 条 = `q-1..q-7` + `q-8` + `q-9`（T14-C/D）；
> ④段 13 条、⑤段 9 条由本任务自己新增（`ex-9b`/`ex-12`/`cs-8`/`cs-9` 等），**以 Step 1-3 实际写出的 `await checkAsync(` 计数为准**。
> 旧草稿的 `46/46`、`45/45 + 1 SKIP`、`40/40` 三行全部作废。
Run: `SKIP_LOCAL=1 node test/clean.test.mjs` → `55/55 通过` + 1 行 `SKIP cln-真机-1`
Run: `node test/alerts.test.mjs` → `33/33`；`node test/guard.test.mjs` → `19/19`；`SKIP_LOCAL=1 node test/collect.test.mjs` → `48/48`；`node test/prefs.test.mjs` → `28/28`

- [ ] **Step 6: 真机端到端（按 T15-D 落文件、样本根挪进仓库 tmp，spec §5 要求）**

**不许再用 `node --input-type=module -e "…"`**：那一版整段是字面 `\` 与 `'C:\\\\*'` 的双层转义，派单途中 `\` 还会再折半一次，路径会静默变形。
把脚本落成 `tmp/t15e2e.mjs` 再 `node tmp/t15e2e.mjs`，反斜杠一律 `String.fromCharCode(92)`，并把输入形状自证（段数）打印出来。
样本根**不是** `%TEMP%`，而是仓库内 `tmp/sysops-clean-e2e`（自建自删，绝不动用户真实 Temp；guard 对仓库内 F: 绝对路径 `allow=true`，现证见 `tmp/t14g.txt`）：

```js
// tmp/t15e2e.mjs —— Task 15 真机端到端：扫描 + 执行 + 留痕，全在仓库 tmp 里自建自删
const fs = await import('node:fs');
const path = await import('node:path');
const B = String.fromCharCode(92);            // 反斜杠不许写字面量：见 T15-D / 本仓库硬约束
const root = path.resolve('tmp', 'sysops-clean-e2e');
console.log('样本根', root, '| 反斜杠段数', root.split(B).length, '| 正斜杠段数', root.split('/').length);

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'old'), { recursive: true });
fs.writeFileSync(path.join(root, 'old', 'a.txt'), 'hello');
fs.mkdirSync(path.join(root, 'keep'), { recursive: true });
fs.writeFileSync(path.join(root, 'keep', 'b.txt'), 'fresh');
const old = new Date(Date.now() - 40 * 864e5);
for (const p of ['old', path.join('old', 'a.txt')]) fs.utimesSync(path.join(root, p), old, old);

const SC = await import('./lib/clean/scanner.js');
const EX = await import('./lib/clean/executor.js');   // 与 Step 4 的导出名对齐
const sc = SC.createScanner({
  fsMod: { readdirSync: fs.readdirSync, statSync: fs.statSync, join: path.join },
  osMod: { homedir: () => root }, now: () => Date.now(), logger: { warn: console.error }, onProgress() {},
});
const res = await sc.scan([SC.expandRule({ id: 'e2e', n: '端到端样本', kind: '缓存', ageDays: 7, dir: root, pattern: '*' }, { home: root })]);
console.log('命中', res.totals.n, 'bytes', res.totals.bytes, 'items', res.items.map((i) => i.path));

const facility = { /* 用 test/clean.test.mjs 里同一份内存设施桩，别在这里另写一套 */ };
const planStore = (await import('./lib/clean/plan-store.js')).createPlanStore({ getFacility: () => facility, now: () => Date.now(), newId: () => 'p-e2e', logger: { warn: console.error } });
const logStore = (await import('./lib/clean/log-store.js')).createLogStore({ getFacility: () => facility, now: () => Date.now(), logger: { warn: console.error } });
await planStore.save(res, { beforeFree: 1, modeDefault: 'delete-dir' });
const ex = EX.createExecutor({ fsMod: { ...fs, realpathSync: fs.realpathSync }, planStore, logStore, logger: { warn: console.error } });
await ex.run('p-e2e', res.items.map((i) => i.id));   // 与 Step 4 的执行入口签名对齐

// 断言（不是打印）：够老的整条消失、够新的原样还在、留痕里有对应记录；任何一条不过就非零退出。
const fail = [];
if (fs.existsSync(path.join(root, 'old'))) fail.push('old 没被删掉');
if (!fs.existsSync(path.join(root, 'keep'))) fail.push('keep 被误删（够新的条目必须原样保留）');
// 第三条断言按 Step 4 的留痕形状补：logStore 里必须有一条指向 p-e2e 与 root/old 的成功记录。
console.log(fail.length ? 'FAIL ' + fail.join('；') : '端到端 PASS');
process.exitCode = fail.length ? 1 : 0;
```

Run: `node tmp/t15e2e.mjs` → Expected: 退出码 0，且输出里 `端到端 PASS`。
**这块留了三处必须与 Step 4 对齐的签名**（`facility` 桩、`ex.run` 入口、留痕断言）：实现先落地、脚本照实现补全，
不许反过来为了让脚本好写而改 Step 4 的公共 API，也不许把断言降级成只打印（本仓库硬约束：禁止仅打印不断言）。
收尾：`fs.rmSync(root, { recursive: true, force: true })` 由脚本自己负责，跑完不在仓库里留样本目录。

提交信息草稿：`feat(sysops): 两段式执行器与清理服务（快照 re-stat 闸门 + 三档计数）`

---

## Task 16: `lib/search/probe.js` —— 三级探测

**Files:**
- Create: `lib/search/probe.js`
- Create: `test/search.test.mjs`（①段）

**Interfaces:**
- Consumes: 注入的 `fsMod` / `httpMod`（`node:http`/`fetch`）/ `execFileMod`、`prefs.search`（Task 3）
- Produces:
  - `PROBE_LEVELS = ['installed', 'channel', 'e2e']`
  - `DEFAULT_EVERYTHING_PORT = 3417`、`CACHE_TTL_MS = 30_000`
  - `ADVICE`（三条安装指引文案，与原型 `guideCard` 逐字一致）
  - `createProbe({ fsMod, requestFn, execFileMod, getPrefs, now, ttlMs?, httpTimeoutMs?, esTimeoutMs? })` → `{ probe(force?), invalidate(), last() }`
  - `ProbeResult = { at, installed, http, es, e2e, ready, via: 'http'|'es'|null, degraded: boolean, level: 'installed'|'channel'|'e2e'|null, checks: [{ key, label, ok, detail }], advice: string[] }`

- [ ] **Step 1: 写失败的测试**

```js
const PB = await import('../lib/search/probe.js');

function probeWorld(over = {}) {
  let t = 0;
  const calls = [];
  const probe = PB.createProbe({
    fsMod: { existsSync: (p) => (over.installedPaths ?? []).some((x) => p.toLowerCase() === x.toLowerCase()) },
    requestFn: async (url, opts = {}) => {
      calls.push({ url, method: opts.method ?? 'GET' });
      if (over.httpThrows) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (over.httpStatus === 403) return { status: 403, body: '' };
      if (over.httpStatus === 500) return { status: 500, body: 'boom' };
      return { status: 200, body: over.httpBody ?? '{"results":[],"total":0}' };
    },
    execFileMod: async (cmd, args) => {
      calls.push({ cmd, args });
      if (over.esThrows) throw Object.assign(new Error('找不到 es.exe'), { code: 'ENOENT' });
      return { stdout: over.esStdout ?? 'C:\\a.txt\nC:\\b.txt\n' };
    },
    getPrefs: () => ({ search: { mode: over.mode ?? 'everything', port: over.port, esPath: over.esPath, walkDirs: over.walkDirs ?? [] } }),
    now: () => t,
    advance: (ms) => { t += ms; },
    calls,
  });
  return { probe, calls, adv: (ms) => { t += ms; } };
}

check('pb-1 三级常量与原型自检卡的三行一致', () => {
  assert.deepEqual(PB.PROBE_LEVELS, ['installed', 'channel', 'e2e']);
  assert.equal(PB.DEFAULT_EVERYTHING_PORT, 3417);
  assert.equal(PB.ADVICE.length, 3, '安装指引三条：winget / 官网 / 勾选 HTTP 服务器');
  assert.ok(PB.ADVICE[0].includes('winget install voidtools.Everything'));
  assert.ok(PB.ADVICE[1].includes('voidtools.com/downloads'));
  assert.ok(PB.ADVICE[2].includes('HTTP 服务器'));
});

await checkAsync('pb-2 全绿：installed + channel(http) + e2e 都过 → ready，via=http', async () => {
  const w = probeWorld({ installedPaths: ['C:\\Program Files\\Everything\\Everything.exe'] });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, true);
  assert.equal(r.http, true);
  assert.equal(r.e2e, true);
  assert.equal(r.ready, true);
  assert.equal(r.via, 'http');
  assert.equal(r.degraded, false);
  assert.equal(r.level, 'e2e');
});

await checkAsync('pb-3 未安装：三级全否，advice 给全三条并 degraded', async () => {
  const w = probeWorld({ installedPaths: [], httpThrows: true, esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, false);
  assert.equal(r.ready, false);
  assert.equal(r.degraded, true);
  assert.equal(r.level, null);
  assert.equal(r.advice.length, 3);
  assert.ok(r.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0), '每一级都要说清卡在哪');
});

await checkAsync('pb-4 装了但 HTTP 403 → channel 否、e2e 否，advice 只剩「勾选 HTTP 服务器」一条', async () => {
  const w = probeWorld({ installedPaths: ['C:\\Program Files\\Everything\\Everything.exe'], httpStatus: 403, esThrows: true });
  const r = await w.probe.probe(true);
  assert.equal(r.installed, true);
  assert.equal(r.http, false);
  assert.equal(r.level, 'installed');
  assert.equal(r.advice.length, 1);
  assert.match(r.advice[0], /HTTP 服务器/);
});

await checkAsync('pb-5 只有 es.exe 可用：via=es（installed 靠 es 命中也算）', async () => {
  const w = probeWorld({ installedPaths: [], esThrows: false });
  const r = await w.probe.probe(true);
  assert.equal(r.es, true);
  assert.equal(r.via, 'es');
  assert.equal(r.installed, true, 'es.exe 在 PATH 里同样算「已装」');
});

await checkAsync('pb-6 探测结果缓存 30s：期间重复 probe 不再发请求，过期后重探', async () => {
  const w = probeWorld();
  await w.probe.probe(true);
  const n1 = w.calls.length;
  await w.probe.probe();
  assert.equal(w.calls.length, n1, '缓存内不得重探');
  w.adv(31_000);
  await w.probe.probe();
  assert.ok(w.calls.length > n1);
});

await checkAsync('pb-7 invalidate()（界面的「重新检测」）强制绕开缓存', async () => {
  const w = probeWorld();
  await w.probe.probe();
  const n1 = w.calls.length;
  w.probe.invalidate();
  await w.probe.probe();
  assert.ok(w.calls.length > n1);
});

await checkAsync('pb-8 walkDirs 为空时即使 Everything 不可用也不谎称就绪；degraded 附带覆盖范围说明', async () => {
  const w = probeWorld({ installedPaths: [], httpThrows: true, esThrows: true, walkDirs: [] });
  const r = await w.probe.probe(true);
  assert.equal(r.ready, false);
  assert.match(r.checks.find((c) => c.key === 'walk').detail, /未选目录|限定目录/);
});

await checkAsync('pb-9 端口取自 prefs.search.port，未配置时用 3417', async () => {
  const w = probeWorld({ port: 4321 });
  await w.probe.probe(true);
  assert.ok(w.calls.some((c) => c.url && String(c.url).includes(':4321')), JSON.stringify(w.calls));
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/search.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/search/probe.js`。

- [ ] **Step 3: 写实现**

- `probe(force)`：`if (!force && cached && now() - cached.at < ttlMs) return cached;`
- 第一级 `installed`：`fsMod.existsSync('C:\\Program Files\\Everything\\Everything.exe')` 或第二级 es 探测成功（pb-5）。**只读**，不启动任何进程（spec §1.3）。
- 第二级 `channel`：并行两路，各自超时（`httpTimeoutMs` 默认 1500、`esTimeoutMs` 默认 3000）：
  - `http`：`requestFn('http://127.0.0.1:' + port + '/fq/?search=' + encodeURIComponent('a') + '&count=1')` → `status === 200` 才算通；403/500/抛错都算不通，但 `detail` 要分别写「HTTP 403，需在 Everything 里勾选 工具 → 选项 → HTTP 服务器」/「连接被拒（Everything 未运行或未开 HTTP）」，界面按 `detail` 直显（pb-4）。
  - `es`：`execFileMod(bin ?? 'es.exe', ['-max-count', '1', 'a'])`，成功且有输出算通。`bin` 取 `prefs.search.esPath`，留空走 PATH。
- 第三级 `e2e`：只有 `channel` 通了才跑，用一次真查询（`http` 走 `/fq/?search=sysops-probe-&count=1`，`es` 走 `es.exe -max-count 1 sysops-probe-`），**返回结构可解析**才算 e2e（不是"有结果"，空结果也算通 —— 探针词本来就搜不到）。
- `advice` 取舍：`!installed` → 三条全给；`installed && !channel` → 只给第三条（pb-4）；`installed && channel && !e2e` → 给「查询接口能连上但返回无法解析，试试重启 Everything」。
- `checks` 固定四行（`installed` / `http` / `es` / `walk`），`walk` 那行说覆盖几个目录（pb-8）—— 原型 `probeSteps` 就是这四行。
- 全抛错都不许冒到调用方：`probe()` 的每个 await 包 try/catch，catch 里写 `detail`（这是"探测失败"这一等第的输出，不是静默）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/search.test.mjs` → `9/9 通过`
Run: `SKIP_LOCAL=1 node test/search.test.mjs` → `9/9 通过`

- [ ] **Step 5: 真机探测（本机按实测修正 #4 应为未安装）**

**不许内联**（T14-E 同口径硬约束），落 `tmp/t16probe.mjs`：

```js
/* Task 16 Step 5：真机探测。跑法：node tmp/t16probe.mjs > tmp/t16-probe.txt 2>&1，然后 Read 那个文件。 */
const fsMod = await import('node:fs');
const cp = await import('node:child_process');
const util = await import('node:util');
const execFile = util.promisify(cp.execFile);
const PB = await import('./lib/search/probe.js');

const p = PB.createProbe({
  fsMod: { existsSync: (s) => fsMod.existsSync(s) },
  requestFn: async (url, opts = {}) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 1500) });
    return { status: r.status, body: await r.text() };
  },
  // 原稿这里写的是 require('node:child_process') —— ESM 里没有 require，内联版一跑就抛，
  // 而 probe 的 catch 会把它打成「es 不通」的 detail，读数看着正常、其实那条腿从未真跑过。
  execFileMod: async (cmd, args) => {
    const { stdout } = await execFile(cmd, args, { timeout: 3000, windowsHide: true });
    return { stdout };
  },
  getPrefs: () => ({ search: { mode: 'everything', port: PB.DEFAULT_EVERYTHING_PORT, esPath: '', walkDirs: [] } }),
  now: () => Date.now(),
});

const r = await p.probe(true);
const row = (c) => `${c.key}=${c.ok ? 'OK' : c.detail}`;
console.log(JSON.stringify({ installed: r.installed, http: r.http, es: r.es, e2e: r.e2e, ready: r.ready, via: r.via, level: r.level, degraded: r.degraded }));
console.log(r.checks.map(row).join(' | '));
console.log('advice 条数', r.advice.length);
```

Run: `node tmp/t16probe.mjs > tmp/t16-probe.txt 2>&1` 然后 Read `tmp/t16-probe.txt`（控制台 cp936 会把中文打成乱码）。
Expected（2026-09-27 实测修正 #4）：`installed:false, http:false, es:false, ready:false, level:null`，四行 checks 各有 detail。若本机后来装了 Everything，把这条真机结果与修正 #4 一起回写 spec（Task 25）。
提交信息草稿：`feat(sysops): Everything 三级探测（缓存 30s + 逐级原因）`

## Task 17: 三个搜索适配器 + `lib/search/service.js`

**Files:**
- Create: `lib/search/everything-http.js`
- Create: `lib/search/es-exe.js`
- Create: `lib/search/walk.js`
- Create: `lib/search/service.js`
- Modify: `test/search.test.mjs`（追加 ②③④⑤段；统计/exit 挪到末尾）

**Interfaces:**
- Consumes: `createProbe` / `DEFAULT_EVERYTHING_PORT`（Task 16）、`SEARCH_MODES`（Task 3）、`prefs.search`
- Produces:
  - `buildUrl({ q, limit, port, offset = 0 })`、`parseEverythingJson(text) → row[]`、`searchEverything({ q, limit, port, requestFn, timeoutMs = 4000 }) → { rows, status?, error? }`
  - `buildArgs({ q, limit })`、`parseEsOutput(text) → row[]`、`searchEs({ q, limit, bin, execFileMod, timeoutMs = 4000 }) → { rows, error? }`
  - `tokensOf(q) → string[]`（空格分词）、`matchName(name, tokens) → boolean`（大小写敏感，全部词都要命中）
  - `walkSearch({ q, limit, dirs, fsMod, pathMod, now, budgetMs = 4000, shouldStop }) → { rows, walked, truncated, timedOut, skipped }`
  - `normalize(raw, source) → { name, dir, size, mtime, source, path }`、`SOURCE_LABEL = { everything: 'Everything HTTP', es: 'es.exe', walk: '本地遍历' }`
  - `createSearchService({ probe, getPrefs, adapters, logger, now })` → `{ search({ q, mode?, limit? }) → Promise<Result> }`
  - `Result = { rows, source, sourceLabel, truncated, stale, note, error, took, limit }`

- [ ] **Step 1: 写失败的测试**

```js
/* ②段：Everything HTTP */
const EH = await import('../lib/search/everything-http.js');

const everythingBody = (n = 2) => JSON.stringify({
  results: Array.from({ length: n }, (_, i) => ({ name: `report ${i}.pdf`, path: `C:\\docs\\report ${i}.pdf`, size: 1024 * (i + 1), date_modified: 1760000000 })),
  total: 1000,
});

check('sh-1 buildUrl：/fq/ 端点、count 带上限、query 走 URL 编码', () => {
  const u = EH.buildUrl({ q: 'report .pdf', limit: 200, port: 3417 });
  assert.match(u, /^http:\/\/127\.0\.0\.1:3417\/fq\/\?/);
  assert.match(u, /search=report%20\.pdf|search=report\+%2E%20pdf|%20/);
  assert.match(u, /count=200/);
});

check('sh-2 parseEverythingJson：缺字段的行为 null 而不是 0（不许把未知当"没有"）', () => {
  const rows = EH.parseEverythingJson(JSON.stringify({ results: [{ name: 'a', path: 'C:\\a' }, { name: 'b', path: 'C:\\b', size: 5, date_modified: 1 }] }));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].size, null);
  assert.equal(rows[1].size, 5);
});

check('sh-3 畸形 JSON / results 不是数组 → 返回空数组并交调用方记错误', () => {
  assert.deepEqual(EH.parseEverythingJson('<html>500</html>'), []);
  assert.deepEqual(EH.parseEverythingJson('{"results":"x"}'), []);
});

await checkAsync('sh-4 403 单独成错并给出可执行指引（spec §4.4）', async () => {
  const r = await EH.searchEverything({ q: 'a', limit: 10, port: 3417, requestFn: async () => ({ status: 403, body: '' }) });
  assert.equal(r.rows.length, 0);
  assert.equal(r.status, 403);
  assert.match(r.error, /HTTP 服务器/);
});

await checkAsync('sh-5 超时：4s 到点取消请求，error 里点名 timeout', async () => {
  const r = await EH.searchEverything({
    q: 'a', limit: 10, port: 3417, timeoutMs: 20,
    requestFn: (_u, { signal } = {}) => new Promise((_res, rej) => { signal?.addEventListener?.('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
  });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /超时|timeout|abort/i);
});

await checkAsync('sh-6 正常返回：行数、路径、来源都归一化好', async () => {
  const r = await EH.searchEverything({ q: 'report', limit: 10, port: 3417, requestFn: async () => ({ status: 200, body: everythingBody(3) }) });
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].name, 'report 0.pdf');
});

/* ③段：es.exe */
const ES = await import('../lib/search/es-exe.js');

check('se-1 buildArgs：空 query 直接拒（es.exe 无参会吐全库）', () => {
  assert.throws(() => ES.buildArgs({ q: '  ', limit: 10 }), /query|关键字/);
  const a = ES.buildArgs({ q: 'report .pdf', limit: 50 });
  assert.deepEqual(a.slice(0, 4), ['-max-count', '50', '-sort', 'path']);
  assert.equal(a[4], 'report .pdf');
});

check('se-2 parseEsOutput：每行一条完整路径，空行与表头丢弃', () => {
  const rows = ES.parseEsOutput('C:\\a.txt\r\n\r\nC:\\b c.md\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].path, 'C:\\b c.md');
  assert.equal(rows[1].name, 'b c.md');
});

await checkAsync('se-3 es.exe 不存在（ENOENT）→ error 说清未找到，不抛', async () => {
  const r = await ES.searchEs({ q: 'a', limit: 10, execFileMod: async () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /es\.exe|未找到/);
});

/* ④段：walk（本机唯一实跑通路） */
const WK = await import('../lib/search/walk.js');

check('wk-1 空格分词=同时满足，大小写敏感（与原型「支持空格分词」文案一致）', () => {
  assert.deepEqual(WK.tokensOf('东财 数据源'), ['东财', '数据源']);
  assert.equal(WK.matchName('东财数据源.csv', ['东财', '数据源']), true);
  assert.equal(WK.matchName('数据源东财.csv', ['东财', '数据源']), true, '词序无关');
  assert.equal(WK.matchName('Report.pdf', ['report']), true, 'Everything 默认大小写不敏感，walk 要跟它一致');
  assert.equal(WK.matchName('a.txt', ['b']), false);
});

function walkFs(files, opts = {}) {
  const map = new Map(Object.entries(files));
  return {
    readdirSync: (dir) => {
      if (opts.denied && dir.startsWith(opts.denied)) throw Object.assign(new Error('拒绝访问'), { code: 'EPERM' });
      const out = [];
      for (const p of map.keys()) {
        if (!p.startsWith(dir + '\\')) continue;
        const rest = p.slice(dir.length + 1);
        if (!rest.includes('\\')) out.push(rest);
        else if (!out.some((x) => x.split('\\')[0] === rest.split('\\')[0])) out.push(rest.split('\\')[0] + '\\');
      }
      return out.map((n) => ({ name: n.replace(/\\$/, ''), isDirectory: () => n.endsWith('\\'), isFile: () => !n.endsWith('\\') }));
    },
    statSync: (p) => { const f = map.get(p); if (!f) throw Object.assign(new Error('无'), { code: 'ENOENT' }); return { isFile: () => true, isDirectory: () => false, size: f.size ?? 1, mtimeMs: f.mtime ?? 1 }; },
    join: (a, b) => `${a}\\${b}`,
  };
}

await checkAsync('wk-2 命中集与 Everything 同形状（name/dir/size/mtime/path），只差 source', async () => {
  const r = await WK.walkSearch({
    q: 'report pdf', limit: 10, dirs: ['C:\\Users\\gongj\\AppData\\Local'],
    fsMod: walkFs({ 'C:\\Users\\gongj\\AppData\\Local\\report a.pdf': { size: 11 }, 'C:\\Users\\gongj\\AppData\\Local\\sub\\report b.pdf': { size: 22 }, 'C:\\Users\\gongj\\AppData\\Local\\other.txt': { size: 3 } }),
    pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() }, now: () => 1000,
  });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].dir, 'C:\\Users\\gongj\\AppData\\Local');
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['dir', 'mtime', 'name', 'path', 'size', 'source']);
});

await checkAsync('wk-3 无 dirs 时不假装能搜：返回空 + note 点名未选目录', async () => {
  const r = await WK.walkSearch({ q: 'a', limit: 10, dirs: [], fsMod: walkFs({}), pathMod: { join: (a, b) => a + b, basename: (p) => p }, now: () => 1 });
  assert.equal(r.rows.length, 0);
  assert.match(r.note, /未选目录|设置/);
});

await checkAsync('wk-4 预算耗尽/超 limit：timedOut 与 truncated 分开标（两种"不全"原因不同）', async () => {
  const files = {};
  for (let i = 0; i < 500; i++) files[`C:\\d\\report ${i}.pdf`] = { size: i };
  const fsMod = walkFs(files);
  const r = await WK.walkSearch({ q: 'report', limit: 50, dirs: ['C:\\d'], fsMod, pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() }, now: () => 1, budgetMs: 1 });
  assert.equal(r.timedOut, true);
  assert.equal(r.truncated, false, '预算先到就不算截断');
  const r2 = await WK.walkSearch({ q: 'report', limit: 50, dirs: ['C:\\d'], fsMod, pathMod: { join: (a, b) => `${a}\\${b}`, basename: (p) => p.split('\\').pop() }, now: () => 1, budgetMs: 1e9 });
  assert.equal(r2.truncated, true);
  assert.equal(r2.rows.length, 50);
});

/* ⑤段：service 选路与诚实降级 */
const SS = await import('../lib/search/service.js');

function svWorld(probeResult, over = {}) {
  const calls = [];
  const adapters = {
    everything: async (a) => { calls.push(['everything', a]); return over.everything ?? { rows: [{ name: 'a', path: 'C:\\a', size: 1, mtime: 1 }], error: null } },
    es: async (a) => { calls.push(['es', a]); return over.es ?? { rows: [{ name: 'b', path: 'C:\\b' }], error: null } },
    walk: async (a) => { calls.push(['walk', a]); return over.walk ?? { rows: [{ name: 'c', path: 'C:\\c', size: 3 }], truncated: false, timedOut: false, skipped: [], note: '' } },
  };
  const svc = SS.createSearchService({
    probe: { probe: async () => probeResult, invalidate: () => {} },
    getPrefs: () => ({ search: { mode: over.mode ?? 'everything', walkDirs: over.walkDirs ?? ['C:\\Users\\gongj\\AppData\\Local'], limit: over.limit, port: 3417, esPath: '' } }),
    adapters, logger: { warn() {} }, now: () => 1000,
  });
  return { svc, calls };
}

const READY = { ready: true, via: 'http', degraded: false, checks: [], advice: [] };

await checkAsync('sv-1 探测就绪 → 走 Everything，source 与 sourceLabel 一起返回', async () => {
  const w = svWorld(READY);
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'everything');
  assert.equal(r.sourceLabel, 'Everything HTTP');
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0][0], 'everything');
});

await checkAsync('sv-2 探测不通 → 自动降级 walk，note 说清缺哪一级', async () => {
  const w = svWorld({ ready: false, via: null, degraded: true, level: 'installed', checks: [{ key: 'http', ok: false, detail: '未开 HTTP 服务' }], advice: [] });
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'walk');
  assert.match(r.note, /未开 HTTP 服务|降级/);
});

await checkAsync('sv-3 用户显式选 walk（mode=walk）时不看探测结果', async () => {
  const w = svWorld(READY, { mode: 'walk' });
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'walk');
  assert.equal(w.calls.length, 1);
});

await checkAsync('sv-4 via=es 走 es.exe（两条通路只通一条时不误判为降级）', async () => {
  const w = svWorld({ ready: true, via: 'es', degraded: false, checks: [], advice: [] });
  const r = await w.svc.search({ q: 'a' });
  assert.equal(r.source, 'es');
  assert.equal(r.sourceLabel, 'es.exe');
});

await checkAsync('sv-5 适配器报错：保留上次结果并标 stale（不拿旧结果冒充新查）', async () => {
  const w = svWorld(READY);
  await w.svc.search({ q: 'first' });
  const bad = SS.createSearchService({
    probe: { probe: async () => READY }, getPrefs: () => ({ search: { mode: 'everything', walkDirs: [], port: 3417 } }),
    adapters: { everything: async () => ({ rows: [], error: 'HTTP 403' }) }, logger: { warn() {} }, now: () => 2000,
  });
  const r = await bad.search({ q: 'a' });
  assert.equal(r.rows.length, 0);
  assert.match(r.error, /403/);
  const r2 = await bad.search({ q: 'b' });
  assert.ok(typeof r2.stale === 'boolean');
});

await checkAsync('sv-6 归一化一致：三条通路的行都能喂给同一张表', async () => {
  const norm = SS.normalize({ name: 'x', path: 'C:\\d\\x', size: null, mtime: null }, 'everything');
  assert.equal(norm.dir, 'C:\\d');
  assert.equal(norm.source, 'everything');
  assert.equal(norm.size, null, '未知大小保持 null，界面显示「—」而不是 0 B');
});

await checkAsync('sv-7 空 query 拒（不发请求也不遍历）', async () => {
  const w = svWorld(READY);
  const r = await w.svc.search({ q: '   ' });
  assert.equal(r.error, 'EMPTY_QUERY');
  assert.equal(w.calls.length, 0);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/search.test.mjs`
Expected: ②段起 `ERR_MODULE_NOT_FOUND` 指向 `lib/search/everything-http.js`。

- [ ] **Step 3: 写实现**

- `everything-http.js`：`buildUrl` 用 `http://127.0.0.1:<port>/fq/?search=<enc>&count=<n>&offset=<o>&sort=path&ascending=1`；`requestFn` 由调用方注入（生产用 `fetch` + `AbortSignal.timeout`），`status!==200` 全部转 `{rows: [], status, error}`，其中 403 的 `error` 用原型 `walkNotice`/引导卡的措辞「Everything 的 HTTP 服务未开启：在 Everything 里勾选 工具 → 选项 → HTTP 服务器（默认端口 3417）」。**本机未装 Everything（实测修正 #4）→ 本适配器标「未在本机验证」**。
- `es-exe.js`：`execFileMod(bin ?? 'es.exe', buildArgs(...))`，`bin` 走配置且**不拼进 shell 字符串**（`execFile` 而非 `exec`，避免命令注入）；输出按 `\r?\n` 切。同样标「未在本机验证」。
- `walk.js`：显式栈遍历 `dirs`，`budgetMs` 内每 200 条目检查一次 `now() - start > budgetMs`；`EPERM/ENOENT` 记 `skipped` 并继续（与 Task 12 同一口径）；命中即 push 归一化行（`source: 'walk'`），够 `limit` 后停止下探并 `truncated = true`；`dirs` 为空 → 直接返回 `note: '未选目录：到设置页 → 搜索通路 里添加要覆盖的目录'`。
- `service.js`：
  - `search({q, mode, limit})`：`q` 空 → `{ error: 'EMPTY_QUERY' }`（sv-7）；`limit` 夹在 `1..1000`，默认取 `prefs.search.limit ?? 200`（与原型上限档位一致）。
  - 选路：`mode === 'walk'` 直接走 walk；否则 `await probe.probe()` → `ready ? (via === 'http' ? everything : es) : walk`。
  - `note` 组装：降级时把 `checks` 里失败那级的 `detail` 拼进来；walk 结果带「覆盖 N 个目录，非全盘索引」；`truncated`/`timedOut` 各一句。
  - 缓存 `last` 结果，出错时返回 `{ rows: [], error, stale: true, note }` —— **标 stale 而不是回吐旧行**，界面「上次结果」由前端决定要不要留（spec §4.4「保留上次结果标『陈旧』」是前端行为，宿主只负责如实说这次没成）。
  - `took` 用注入的 `now()` 差值，随结果返回，界面显示在结果头部。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/search.test.mjs`
Expected: `26/26 通过`（①9 ②6 ③3 ④4 ⑤7 — 减去与①重叠 3 条命名重号，见下方提示）
> 命名核对：①段是 `pb-*`（9 条），②`sh-1..6`（6），③`se-1..3`（3），④`wk-1..4`（4），⑤`sv-1..7`（7）→ **合计 29 条**。Step 4 期望写 `29/29 通过`；上面那行"26"是草稿数，执行时以 29 为准（若实得不同，按实际条数核对，不要为了凑数删用例）。

- [ ] **Step 5: 真机 walk 实测（与 spec §1.2 的 7.3s 对齐）**

**不许内联**（T14-E 同口径硬约束），落 `tmp/t17walk.mjs`：

```js
/* Task 17 Step 5：真机 walk 实测。跑法：node tmp/t17walk.mjs > tmp/t17-walk.txt 2>&1，然后 Read 那个文件。 */
const fsMod = await import('node:fs');
const path = await import('node:path');
const osMod = await import('node:os');
const WK = await import('./lib/search/walk.js');

const B = String.fromCharCode(92);
const dir = path.join(osMod.homedir(), 'AppData', 'Local');
// 输入形状自证（T14-E）：路径由系统拼出、段数对得上，才说明「遍历的确实是这个目录」而不是畸形串
const segs = dir.split(B).filter(Boolean);
console.log('dir=', dir, '| 段数=', segs.length, '| 逐段=', segs.join(' > '));

const t0 = Date.now();
const r = await WK.walkSearch({
  q: 'report',
  limit: 50,
  dirs: [dir],
  fsMod: { readdirSync: (p) => fsMod.readdirSync(p), statSync: (p) => fsMod.statSync(p), join: path.join },
  pathMod: { join: path.join, basename: path.basename },
  now: () => Date.now(),
  budgetMs: 20000,
});
console.log('耗时', Date.now() - t0, 'ms | 命中', r.rows.length, '| walked', r.walked, '| truncated', r.truncated, '| timedOut', r.timedOut, '| skipped', r.skipped.length);
```

Run: `node tmp/t17walk.mjs > tmp/t17-walk.txt 2>&1` 然后 Read `tmp/t17-walk.txt`。
Expected: 不抛；`walked` 量级与 spec 的 14.5 万同数量级；`timedOut` 视本机而定，为 true 时说明预算生效（把结论写进 Task 25 的实测复跑表）。
提交信息草稿：`feat(sysops): 搜索三适配器与通路选择（含诚实降级文案）`

---

## Task 18: `lib/api.js` —— 路由表 + SSE hub

**Files:**
- Create: `lib/api.js`
- Create: `test/plugin.test.mjs`（①段：路由级）

**Interfaces:**
- Consumes: 四个 service（collect / alerts / clean / search）、`createPrefStore`、`createRuleStore`、`caps`（Task 19 提供，本任务只按接口形状用）
- Produces:
  - `ROUTE_PREFIX = '/sysops'`、`GLOBAL_KEY = '__SYSOPS__'`
  - `ROUTES: { 'METHOD /path': { handler, needsStorage?, needsWebServer? } }`（导出用于测试遍历）
  - `openSse(res) → { send(event, data), close() }`
  - `createHub(onFirstConnect, onLastDisconnect) → { add(client), remove(client), count, broadcast(event, data) }`
  - `createApiHandler({ collect, alerts, clean, search, prefStore, ruleStore, caps, logger, now })` → `async handler(req, res, url)`（`url` 为前缀内路径）
  - `json(res, status, body)`、`readBody(req) → Promise<object>`
  - 错误响应统一 `{ ok: false, error: { code, message } }`，成功 `{ ok: true, data }`

- [ ] **Step 1: 写失败的测试**

```js
/* ①段：路由级（假 req/res，四个 service 全打桩） */
const API = await import('../lib/api.js');

function makeRes() {
  return {
    statusCode: 0, headers: null, body: '', chunks: [], finished: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; },
    setHeader(k, v) { this.headers = { ...(this.headers ?? {}), [k]: v }; },
    end(b) { this.body = b ?? ''; this.finished = true; },
    write(c) { this.chunks.push(c); return true; },
    on() {}, once() {}, removeAllListeners() {}, emit() {},
  };
}

function apiWorld(over = {}) {
  const events = [];
  const calls = [];
  const collect = {
    snapshot: () => ({ cadence: '1s', keepMinutes: 30, timerBackend: 'setInterval', series: { cpu: [{ t: 1, v: 2 }] }, latest: { cpu: 2, mem: 50, diskFreeGb: 70, diskTotalGb: 200, netDown: 0, netUp: 0, t: 1 }, sources: [{ key: 'l0', label: '实时曲线', state: 'on', detail: '', restarts: 0, pid: null, stderrTail: '' }], proc: { rows: [], state: 'off', note: '' }, dropped: { stale: 0, bad: 0 } }),
    sourceRows: () => [], procRows: () => [], setCadence: async (v) => { calls.push(['setCadence', v]); }, setSource: async (k, o) => { calls.push(['setSource', k, o]); }, setVisible: async (v) => { calls.push(['setVisible', v]); }, restartSource: async (k) => { calls.push(['restart', k]); },
    onEvent: (cb) => { collect._cb = cb; return () => { collect._cb = null; }; }, dispose: () => {},
  };
  const alerts = { ruleRows: () => [{ rule: { id: 'r1' }, st: { dim: false, on: true, st: '监控中' } }], hits: async ({ limit } = {}) => ({ rows: [{ hitId: 'h-1' }], error: null }), unread: () => 3, markRead: () => { calls.push(['markRead']); }, onEvent: () => () => {}, dispose: () => {} };
  const clean = { startScan: async () => { calls.push(['scan']); return { busy: false }; }, stopScan: () => { calls.push(['scanStop']); }, state: () => ({ phase: 'idle', dir: '', walked: 0, hit: 0, bytes: 0, stopped: false, truncated: false, skipped: [], planId: null, error: '' }), apply: async (a) => { calls.push(['apply', a]); return { ok: 1, skipped: 0, failed: 0, rejected: 0 }; }, plans: async () => [], logs: async () => [], unfinished: async () => [], quarantineStats: async () => ({ dirs: 0, files: 0, bytes: 0, oldest: null }), onEvent: () => () => {}, dispose: () => {} };
  const search = { search: async (a) => { calls.push(['search', a]); return { rows: [], source: 'walk', sourceLabel: '本地遍历', note: '', error: null, took: 5, truncated: false, stale: false, limit: 200 }; } };
  const probe = { probe: async () => ({ ready: false, via: null, degraded: true, level: null, checks: [], advice: ['x'] }), invalidate: () => { calls.push(['invalidate']); } };
  const prefsMod = {
    readAll: async () => ({ prefs: { collect: { cadence: '1s' } }, clean_rules: null }),
    writeMany: async (p) => { calls.push(['writeMany', p]); if (over.prefsFails) throw Object.assign(new Error('没有 storageDomain'), { code: 'PREFS_UNAVAILABLE' }); return { written: p, skipped: [] }; },
    available: over.noStorage === true ? false : true,
  };
  const ruleStore = { add: async (r) => { calls.push(['ruleAdd', r]); throw Object.assign(new Error('回收站不碰'), { code: 'SYSOPS_RULE_GUARD_DENY', why: '回收站不碰' }); }, remove: async () => ({}), toggle: async () => ({}), list: async () => ({ items: [], off: [] }), error: null };
  const handler = API.createApiHandler({ collect, alerts, clean: { ...clean, probe }, search, prefStore: prefsMod, ruleStore, caps: over.caps ?? { read: () => ({ storageDomain: prefsMod.available, timer: false, webServer: true, notifications: false, autostart: false }) }, logger: { warn: (m) => events.push(m) }, now: () => 1000 });
  const run = async (method, path, { body, query } = {}) => {
    const res = makeRes();
    const url = new URL(`http://127.0.0.1${path}`);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    await handler({ method, url, headers: { host: '127.0.0.1:4321', 'x-forwarded-for': over.xff }, socket: { remoteAddress: '127.0.0.1' } }, res, body === undefined ? {} : body);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, res };
  };
  return { run, calls, events, collect, alerts, clean, search, handler };
}

await checkAsync('rt-1 GET /api/snapshot 返回采集快照全字段', async () => {
  const w = apiWorld();
  const r = await w.run('GET', '/api/snapshot');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.deepEqual(Object.keys(r.json.data).sort(), ['alerts', 'cadence', 'clean', 'dropped', 'keepMinutes', 'latest', 'proc', 'series', 'sources', 'timerBackend']);
});

await checkAsync('rt-2 GET /api/stream 走 SSE：先一帧 snapshot，再广播 service 事件', async () => {
  const w = apiWorld();
  const res = makeRes();
  await w.handler({ method: 'GET', url: new URL('http://127.0.0.1/api/stream'), headers: { host: '127.0.0.1:4321' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.match(res.chunks.join(''), /^event: snapshot\ndata: /m);
  w.collect._cb({ type: 'metrics', key: 'cpu', point: { t: 2, v: 3 } });
  assert.match(res.chunks.join(''), /event: metrics/);
  res.emit('close');
  assert.equal(res.chunks.at(-1).includes('event:'), true, '关闭前不留半帧');
});

await checkAsync('rt-3 首个 SSE 连接起来 → collect.setVisible(true)；最后一个断开 → false', async () => {
  const w = apiWorld();
  const a = makeRes(); const b = makeRes();
  await w.handler({ method: 'GET', url: new URL('http://127.0.0.1/api/stream'), headers: {}, socket: { remoteAddress: '127.0.0.1' } }, a);
  assert.deepEqual(w.calls.at(-1), ['setVisible', true]);
  await w.handler({ method: 'GET', url: new URL('http://127.0.0.1/api/stream'), headers: {}, socket: { remoteAddress: '127.0.0.1' } }, b);
  assert.equal(w.calls.filter((c) => c[0] === 'setVisible' && c[1] === true).length, 1, '第二个连接不该重复触发');
  a.emit('close'); b.emit('close');
  assert.deepEqual(w.calls.at(-1), ['setVisible', false]);
});

await checkAsync('rt-4 POST /api/prefs 落 writeMany 并返回归一化全量（不回显输入）', async () => {
  const w = apiWorld();
  const r = await w.run('POST', '/api/prefs', { body: { prefs: { collect: { cadence: '5s' } } } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(w.calls.find((c) => c[0] === 'writeMany')[1], { prefs: { collect: { cadence: '5s' } } });
  assert.ok(r.json.data.prefs, '响应必须是库里的样子');
});

await checkAsync('rt-5 写接口只认 POST：GET /api/prefs 只读，PATCH/PUT /api/prefs 一律 405', async () => {
  const w = apiWorld();
  assert.equal((await w.run('GET', '/api/prefs')).status, 200);
  for (const m of ['PATCH', 'PUT']) {
    const r = await w.run(m, '/api/prefs', { body: {} });
    assert.equal(r.status, 405, `${m} 应 405`);
    assert.match(r.json.error.message, /POST/);
  }
});

await checkAsync('rt-6 POST /api/clean/apply 只把三个键交给 clean.apply，多余字段丢掉', async () => {
  const w = apiWorld();
  await w.run('POST', '/api/clean/apply', { body: { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file', path: 'C:\\Windows\\x' } });
  assert.deepEqual(w.calls.find((c) => c[0] === 'apply')[1], { planId: 'p-1', itemIds: ['i-1'], mode: 'delete-file' });
});

await checkAsync('rt-7 apply 缺 planId 或 itemIds 空数组 → 400，且不落到执行器', async () => {
  const w = apiWorld();
  const r1 = await w.run('POST', '/api/clean/apply', { body: { itemIds: ['i'], mode: 'delete-file' } });
  assert.equal(r1.status, 400);
  const r2 = await w.run('POST', '/api/clean/apply', { body: { planId: 'p', itemIds: [], mode: 'delete-file' } });
  assert.equal(r2.status, 400);
  assert.equal(w.calls.filter((c) => c[0] === 'apply').length, 0);
});

await checkAsync('rt-8 mode 不在三个操作白名单里 → 400 并点名允许值', async () => {
  const w = apiWorld();
  const r = await w.run('POST', '/api/clean/apply', { body: { planId: 'p', itemIds: ['i'], mode: 'takeown' } });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /delete-file.*delete-dir.*move-to-quarantine|允许/);
});

await checkAsync('rt-9 无 storageDomain：读仍 200，写返回 501 且 code 稳定（界面按它置灰保存按钮）', async () => {
  const w = apiWorld({ noStorage: true, prefsFails: true });
  assert.equal((await w.run('GET', '/api/prefs')).status, 200);
  const r = await w.run('POST', '/api/prefs', { body: { prefs: {} } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'PREFS_UNAVAILABLE');
});

await checkAsync('rt-10 guard 拒绝写规则 → 403 + 原文案（不是 500，用户要看得懂为什么）', async () => {
  const w = apiWorld();
  const r = await w.run('POST', '/api/rules/add', { body: { id: 'u-9', n: '回收站', glob: 'C:\\$Recycle.Bin\\*', ageDays: 1, kind: '缓存' } });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /回收站不碰/);
});

await checkAsync('rt-11 未知路由 404；GET /api/collect/restart（应为 POST）405', async () => {
  const w = apiWorld();
  assert.equal((await w.run('GET', '/api/nope')).status, 404);
  assert.equal((await w.run('GET', '/api/collect/source')).status, 405);
});

await checkAsync('rt-12 非回环来源的请求一律 403（本插件能删文件，不接受远程驱动）', async () => {
  const w = apiWorld({ xff: '10.1.2.3' });
  const r = await w.run('POST', '/api/clean/scan', { body: {} });
  assert.equal(r.status, 403);
  assert.match(r.json.error.message, /回环|本机/);
});

await checkAsync('rt-13 GET /api/search 参数夹取：limit>1000 收到 1000，空 q 直接 200 + 空结果 + error', async () => {
  const w = apiWorld();
  await w.run('GET', '/api/search', { query: { q: 'a', limit: '99999' } });
  assert.equal(w.calls.find((c) => c[0] === 'search')[1].limit, 1000);
  const r = await w.run('GET', '/api/search', { query: { q: '  ' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.error, 'EMPTY_QUERY');
});

await checkAsync('rt-14 ROUTES 覆盖 spec §3 的每个端点，且写端点全是 POST', async () => {
  const keys = Object.keys(API.ROUTES);
  for (const need of ['GET /api/snapshot', 'GET /api/stream', 'GET /api/prefs', 'POST /api/prefs', 'POST /api/collect/cadence',
    'POST /api/collect/source', 'POST /api/collect/visibility', 'POST /api/collect/restart', 'GET /api/alerts', 'POST /api/alerts/read',
    'POST /api/clean/scan', 'POST /api/clean/scan/stop', 'GET /api/clean/state', 'POST /api/clean/apply', 'GET /api/clean/logs',
    'GET /api/clean/unfinished', 'GET /api/rules', 'POST /api/rules/add', 'POST /api/rules/remove', 'POST /api/rules/toggle',
    'GET /api/search', 'GET /api/search/probe', 'POST /api/search/reprobe', 'GET /api/caps', 'GET /api/quarantine']) {
    assert.ok(keys.includes(need), `缺路由 ${need}`);
  }
  for (const k of keys) {
    const [m] = k.split(' ');
    assert.ok(['GET', 'POST'].includes(m), `路由方法只能是 GET/POST，实得 ${k}`);
  }
});

await checkAsync('rt-15 每个 handler 抛错都会变 500 + logger.warn（禁止半截响应）', async () => {
  const w = apiWorld();
  w.search.search = async () => { throw new Error('适配器炸了'); };
  const r = await w.run('GET', '/api/search', { query: { q: 'a' } });
  assert.equal(r.status, 500);
  assert.match(r.json.error.message, /适配器炸了/);
  assert.ok(w.events.some((m) => /适配器炸了/.test(m)));
  assert.equal(r.res.finished, true);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/plugin.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `lib/api.js`。

- [ ] **Step 3: 写实现**

- 表驱动：`const ROUTES = { 'GET /api/snapshot': (deps) => async () => json(res, 200, { ok: true, data: snapshotOf(deps) }), … }`，`handler(req, res, url)` 里 `const key = req.method + ' ' + url.pathname`；**命中不了就先分辨 404 与 405**（rt-11：同 path 其它方法存在 → 405，否则 404）。
- 回环闸门（rt-12）：`remoteAddress` 必须是 `127.x` / `::1`，且 `x-forwarded-for` 一旦存在就要求每一跳都是回环，否则 403。理由写进注释：这个插件能删文件，不接受经反代转发进来的远程驱动。
- `snapshotOf(deps)` = `{ …collect.snapshot(), alerts: { unread, rules: alerts.ruleRows(), hits: 最近 50 条 }, clean: { state, plan: 最近一次 planId } }`，键名与 rt-1 断言里那 10 个键一致：Task 8 的 `snapshot()` 出八个（`cadence keepMinutes timerBackend series latest sources proc dropped`），`alerts` 与 `clean` 由本任务补两个。
- `openSse(res)`：`writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'})`，立即写一次 `: ok\n\n` 注释帧；`send(event, data)` 写 `event: <name>\ndata: <json>\n\n`；每 25s 写 `: ping\n\n` 心跳（防反代掐）；`close()` 幂等。
- `createHub(onFirst, onLast)`：`Set` 管理连接数，`add` 时 `count===1` → `onFirst()`；`remove` 时 `count===0` → `onLast()`。`onFirst/onLast` 就是 `collect.setVisible(true/false)`（rt-3）。`res.on('close')` 里 `remove`。
- service 事件 → SSE 帧一一对应：`metrics` / `sources` / `proc` / `alert` / `clean:progress` / `clean:item` / `clean:done` / `clean:summary` / `clean:error` / `collect:refresh`。`broadcast` 时对每个 client 的 `write` 返回值不做判断（背压不管，掉帧优于卡住服务端），但 `write` 抛错要 `remove(client)`（这是"响应写失败"这一唯一例外的落点）。
- 写接口统一走 `readBody(req)`：`JSON.parse` 失败 → 400 `{code:'BAD_JSON'}`；`body` 只取声明过的键（rt-6 由 api 层做白名单摘取，executor 里再兜一层）。
- 错误映射：`PREFS_UNAVAILABLE` / `SYSOPS_RECORDS_UNAVAILABLE` → 501；`SYSOPS_RULE_GUARD_DENY` → 403；`PREFS_INVALID` / `BAD_JSON` / 参数校验失败 → 400；其它 → 500。集中一张 `statusFor(code)` 表，别在 handler 里散落 try/catch。
- `GET /api/caps` 返回 `caps.read()`，并把 `notifications/autostart` 恒置 `false`（spec §4.6 的「宿主不提供」两行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `15/15 通过`，退出码 0。
提交信息草稿：`feat(sysops): HTTP/SSE 门面（回环闸门 + hub 驱动可见性 + 错误码映射）`

---

## Task 19: `lib/caps.js` + `index.js` —— 宿主半边与能力探测

**Files:**
- Create: `lib/caps.js`
- Create: `index.js`
- Create: `test/host-compat.test.mjs`
- Modify: `test/plugin.test.mjs`（追加 ②段：宿主半边加载；统计/exit 挪到文件末尾）
- Modify: `test/plugin.test.mjs` 的 ①段 `apiWorld`（**一处**：`clean: { ...clean, probe }` 改为 `clean, probe` 两个独立 dep —— probe 属搜索域，不该混进 clean 的桩里；Task 18 的实现说明同步按独立 dep 写）

**Interfaces:**
- Consumes: 前 18 个任务的全部产物（四个 service、五个 store、`createApiHandler` / `ROUTE_PREFIX` / `GLOBAL_KEY`）、宿主 `ctx.inject(['storageDomain'|'timer'|'webServer'])`、`ctx.on('webserver/index-inject')`、`ctx.effect`
- Produces:
  - `CAP_KEYS = ['storageDomain','timer','webServer','notifications','autostart']`
  - `NEVER_PROVIDED = ['notifications','autostart']`（宿主不提供，**不是"没探到"**）
  - `CAP_ROWS`（`{ key, label, fallback }`，五行，中文文案照 spec §4.6 表逐字）
  - `createCaps({ logger })` → `{ mark(key, ok, detail?), read() → {key:bool}, rows() → [{key,label,ok,detail,fallback}], get webServer/storage/timer }`
  - `index.js`：`export const name = 'sysops'`、`export const inject = []`、`DEFAULT_CONFIG`、`resolveConfig(raw)`、`apply(ctx, config)`
  - 交给浏览器半边的注入载荷（完整键名见 Step「装配约定」第 9 条，**以那一条为准**）：`{ panelId, label, panelOrder, routePrefix, api, capabilities, capabilityRows, cadences, sourceKeys, defaults, redlines, searchAdvice, builtAt }`

- [ ] **Step 1: 写失败的测试（`test/host-compat.test.mjs` ①段：能力缺失矩阵）**

```js
/* ①段：假宿主 ctx —— 缺哪项能力就把哪项摘掉 */
const HOST = await import('../index.js');
const { createCaps, NEVER_PROVIDED, CAP_KEYS } = await import('../lib/caps.js');

/** 假 storageDomain 设施：open 返回带 table() 的句柄，句柄按表名给 Map。 */
function makeFacility(over = {}) {
  const tables = new Map();
  const opened = [];
  return {
    opened,
    async open(spec) {
      if (over.openFails) throw new Error('already-open');
      opened.push(spec.name);
      const handles = {};
      return {
        spec,
        table: (name) => (handles[name] ??= {
          _m: tables.get(name) ?? new Map(),
          async get(key) { return this._m.get(key) ?? null; },
          async put(key, value) { this._m.set(key, JSON.parse(JSON.stringify(value ?? null))); tables.set(name, this._m); return value; },
          async delete(key) { this._m.delete(key); },
          async entries() { return [...this._m.entries()].map(([k, v]) => ({ key: k, value: v }))[Symbol.iterator](); },
          async keys() { return [...this._m.keys()][Symbol.iterator](); },
          async close() { this.closed = true; },
        }),
        async close() { this.closed = true; },
      };
    },
  };
}

/** 假宿主 ctx。桩必须覆盖插件真正用到的能力，少一个方法就会把正常插件报成失败。 */
function makeHost(over = {}) {
  const seen = { registered: [], events: {}, effects: [], logs: [], warns: [], intervals: [], timers: [] };
  const facility = over.noStorage ? null : makeFacility({ openFails: over.openFails });
  const services = {
    storageDomain: facility ?? undefined,
    webServer: over.noWeb ? undefined : {
      register: (opts) => { seen.registered.push(opts); return () => { opts.unregistered = true; }; },
    },
    timer: over.noTimer ? undefined : {
      interval: (fn, ms) => { const h = { fn, ms, stopped: false }; seen.intervals.push(h); return { stop: () => { h.stopped = true; } }; },
    },
  };
  const base = {
    logger: { info: (m) => seen.logs.push(String(m)), warn: (m) => seen.warns.push(String(m)), error: (m) => seen.warns.push(String(m)) },
    on: (evt, fn) => { seen.events[evt] = fn; },
    inject: (names, fn) => {
      const svc = {};
      for (const n of names) { if (!services[n]) return; svc[n] = services[n]; }
      fn({ ...svc, logger: base.logger, effect: (f) => { const d = f(); seen.effects.push(typeof d === 'function'); return typeof d === 'function' ? d : () => {}; } });
    },
    effect: (f, id) => { seen.effects.push(id); const d = f(); return typeof d === 'function' ? d : () => {}; },
  };
  // 模拟 Cordis 的 Context 代理：读未 inject 的属性直接抛（正是它抓出过 ctx.config 的真实 bug）
  const ctx = new Proxy(base, {
    get(t, prop, recv) {
      if (prop === 'config') throw new Error('cannot get property "config" without inject');
      if (prop === 'storageDomain' || prop === 'webServer' || prop === 'timer') throw new Error(`cannot get property "${String(prop)}" without inject`);
      return Reflect.get(t, prop, recv);
    },
  });
  const injectTable = () => { const table = []; seen.events['webserver/index-inject']?.(table); return table; };
  const route = () => seen.registered[0] ?? null;
  return { ctx, seen, facility, injectTable, route };
}

/** 直接打真路由（不经过 apiWorld 的桩 service），断言宿主半边的装配结果。 */
async function callRoute(w, method, path, body) {
  const r = w.route();
  assert(r, '未注册路由');
  const chunks = [];
  const res = {
    statusCode: 0, headers: null, chunks, body: '',
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    setHeader(k, v) { this.headers = { ...(this.headers ?? {}), [k]: v }; },
    write(c) { chunks.push(String(c)); return true; },
    end(t) { if (t !== undefined) this.body = String(t); },
    on() {}, once() {}, removeAllListeners() {}, emit() {}, destroy() {},
  };
  const url = new URL(`http://127.0.0.1:4321${path}`);
  await r.handler({ method, url, headers: { host: '127.0.0.1:4321' }, socket: { remoteAddress: '127.0.0.1' }, on(ev, fn) { (this._l ??= {})[ev] = fn; }, destroy() {} }, res, body ?? {});
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}

check('hc-1 createCaps：五项键齐，缺省全 false（未探测不等于有）', () => {
  const c = createCaps({ logger: { warn() {} } });
  assert.deepEqual(Object.keys(c.read()).sort(), CAP_KEYS.slice().sort());
  for (const k of CAP_KEYS) assert.equal(c.read()[k], false, `${k} 未 mark 前必须是 false`);
  assert.equal(c.rows().length, 5);
});

check('hc-2 caps.mark 把 notifications 改成 true 要抛（宿主不提供不是没探到）', () => {
  const c = createCaps({ logger: { warn() {} } });
  assert.throws(() => c.mark('notifications', true), /不提供|不许/);
  assert.throws(() => c.mark('autostart', true), /不提供|不许/);
  assert.equal(NEVER_PROVIDED.length, 2);
});

check('hc-3 全能力齐：mark 之后三项 true，另两项恒 false 且带「宿主不提供」文案', () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const value = w.injectTable().find((r) => r.name === '__SYSOPS__')?.value;
  assert(value, '没推 index-inject 载荷');
  assert.equal(value.capabilities.storageDomain, true);
  assert.equal(value.capabilities.timer, true);
  assert.equal(value.capabilities.webServer, true);
  assert.equal(value.capabilities.notifications, false);
  assert.equal(value.capabilities.autostart, false);
  assert.equal(value.routePrefix, '/sysops');
});

await checkAsync('hc-4 无 storageDomain：加载不抛、写 prefs 返回 501、能力行有中文原因', async () => {
  const w = makeHost({ noStorage: true });
  HOST.apply(w.ctx, {});
  const rows = w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities;
  assert.equal(rows.storageDomain, false);
  const r = await callRoute(w, 'POST', '/sysops/api/prefs', { prefs: { collect: { cadence: '5s' } } });
  assert.equal(r.status, 501);
  assert.equal(r.json.error.code, 'PREFS_UNAVAILABLE');
  assert.ok(w.seen.warns.some((m) => /storageDomain|存储/.test(m)), '缺能力必须 warn 一条，不能静默');
});

check('hc-5 无 webServer：一条路由都不注册（点开空白页比看不到入口更糟）', () => {
  const w = makeHost({ noWeb: true });
  HOST.apply(w.ctx, {});
  assert.equal(w.seen.registered.length, 0);
  assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.webServer, false);
});

check('hc-6 无 timer：退 setInterval 且 dispose 后定时器清干净（不留野定时器）', () => {
  const created = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false }; created.push(h); return h; };
  globalThis.clearInterval = (h) => { if (h && typeof h === 'object') h.cleared = true; };
  let dispose;
  try {
    const w = makeHost({ noTimer: true });
    HOST.apply(w.ctx, {});
    assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.timer, false);
    assert.equal(HOST.__peek?.('timerBackend') ?? 'setInterval', 'setInterval');
    const eff = w.seen.effects.filter((x) => typeof x === 'function');
    assert.ok(eff.length >= 1, 'ctx.effect 没登记清理回调');
    dispose = () => w.ctx.effect(() => () => {}, 'probe');
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
  assert.ok(created.length > 0, '无 timer 时应退到 setInterval（本用例已打桩捕获）');
  assert.ok(created.every((h) => h.cleared), 'dispose 后仍有未清理的 setInterval：' + created.filter((h) => !h.cleared).length);
});

check('hc-7 storage 的 open 失败也只降级不抛（already-open 之类的宿主错误）', () => {
  const w = makeHost({ openFails: true });
  HOST.apply(w.ctx, {});
  assert.equal(w.injectTable().find((r) => r.name === '__SYSOPS__').value.capabilities.storageDomain, false);
});

check('hc-8 配置只从第二个参数取（Proxy 桩读 ctx.config 会抛）', () => {
  const w = makeHost();
  assert.doesNotThrow(() => HOST.apply(w.ctx, { panelOrder: 30, cadence: 'nope' }));
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

> hc-6 的最后两条断言依赖 `apply()` 返回（或在 `ctx.effect` 回调里登记）**同步执行**的清理函数，且清理里必须先 `collect.dispose()`。桩把 `setInterval` 换掉是为了看见真实退路；`created.every(cleared)` 这条就是 spec §4.6「退 `setInterval` 但必须显式 `stop()`」的取证，**不许**用 `assert.ok(true)` 占位。

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/host-compat.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` 指向 `index.js`（或 `lib/caps.js`）。

- [ ] **Step 3: 写实现**

`lib/caps.js`（全文照下面写，注意"未探测 = false"和"不提供"两种语义分开）：

```js
/**
 * 宿主能力探测结果登记表。
 *
 * 三种状态必须分清，否则设置页的能力表会说假话：
 *   · 没探测过 → false（**不等于**宿主没有；启动早期就是这个值）
 *   · 探测过且缺 → false + detail 说清缺了什么、界面因此降级成什么样
 *   · 宿主架构上不提供（notifications / autostart）→ 恒 false，mark(true) 直接抛
 * 最后一种要拦着：留一个能拨但拨了没用的开关，比没有开关更糟（spec §1.1 决策 8）。
 */
export const CAP_KEYS = ['storageDomain', 'timer', 'webServer', 'notifications', 'autostart'];

/** 宿主不提供 —— 不是"还没探到"，永远不该被标成 true。 */
export const NEVER_PROVIDED = ['notifications', 'autostart'];

/** 中文文案逐字取自 spec §4.6 的表；改这里要同步改 spec。 */
export const CAP_ROWS = [
  { key: 'storageDomain', label: '宿主存储 storageDomain', fallback: '配置转只读，写接口返回 501，保存按钮置灰并注明原因' },
  { key: 'timer', label: '宿主定时器 ctx.interval', fallback: '退到 setInterval，插件卸载时显式 stop；这行降级如实标出来' },
  { key: 'webServer', label: '宿主 Web 服务', fallback: '不注册侧边栏入口（点开空白页比看不到入口更糟）' },
  { key: 'notifications', label: '系统通知', fallback: '宿主不提供：告警只落插件内时间线 + 侧边栏蓝点，UI 不留开关' },
  { key: 'autostart', label: '开机自启常驻', fallback: '宿主不提供：不做常驻，UI 不留开关' },
];

export function createCaps({ logger } = {}) {
  const found = Object.fromEntries(CAP_KEYS.map((k) => [k, false]));
  const detail = {};
  return {
    mark(key, ok, why = '') {
      if (!CAP_KEYS.includes(key)) throw new Error(`未知能力键：${key}`);
      if (NEVER_PROVIDED.includes(key) && ok) {
        // 拦下来而不是忽略：某天真接了通知，也要显式改 NEVER_PROVIDED 才会亮
        throw new Error(`宿主不提供 ${key}，不许 mark(true)`);
      }
      if (!NEVER_PROVIDED.includes(key)) found[key] = Boolean(ok);
      if (why) detail[key] = why;
      if (!found[key] && !NEVER_PROVIDED.includes(key)) {
        logger?.warn?.(`[sysops] 宿主缺少 ${key}：${CAP_ROWS.find((r) => r.key === key).fallback}`);
      }
    },
    read: () => ({ ...found }),
    rows: () => CAP_ROWS.map((r) => ({ ...r, ok: found[r.key], detail: detail[r.key] ?? '' })),
    get storageDomain() { return found.storageDomain; },
    get timer() { return found.timer; },
    get webServer() { return found.webServer; },
  };
}
```

`index.js` 的装配约定（**不要**写成一个大函数体，按下列顺序分节，每节一条注释说为什么）：

1. 顶部注释块：为什么零 `@deepseek-ai/*` import（`link:` 挂载解析出第二份实例）、为什么 `inject = []`（能力按需探测）、本插件对系统的读写边界（只读采集 + 只删用户勾选的项）。
2. `import` 十九个模块；`ROUTE_PREFIX` / `GLOBAL_KEY` **从 `lib/api.js` 引**，不在这里再写一遍字面量（Task 18 已导出，两处定义迟早分叉）。
3. `DEFAULT_CONFIG`：`{ panelId:'sysops', panelOrder:12, label:'系统运维', cadence:'1s', keepMinutes:30, sources:{ l0:true, l1a:true, l1b:false }, procIntervalSec:3, procMaxRows:400, quarantineDir:'', keepDays:7, after:'log', searchPort:3417, esPath:'', walkDirs:[] }`。`panelOrder:12` 排在股票插件（10）下方。`resolveConfig(raw)` 逐键钳制：`cadence` 不在 `COLLECT_CADENCE` 内回落 `'1s'`；`keepMinutes` 钳 5~120；`procIntervalSec` 钳 2~60；`panelOrder` 非有限数回落 12；`sources` 只认 `SOURCE_KEYS` 四键（脏键丢弃而不是照收）。
4. **prefs 视图（同步读）**：`collect/alerts/clean/search` 的 `getPrefs` 都是同步调用，而 `prefStore.readAll()` 是异步 —— 所以在 `apply` 里维护 `let view = mergePrefs(DEFAULT_CONFIG, null)`，并提供
   ```js
   async function reloadPrefs() { const all = await prefStore.readAll().catch(() => null); view = mergePrefs(DEFAULT_CONFIG, all?.prefs ?? null); }
   const getPrefs = () => view;
   ```
   启动时 `reloadPrefs()`（宿主 open 是异步的，`ctx.effect` 的回调里 `void reloadPrefs()`），并在下面的 `prefsFacade` 写完后**立刻重读**，界面改档位才会在下一拍生效。
5. `prefsFacade`（这是本任务的关键收口，别把裸 store 交给 api）：
   ```js
   const prefsFacade = {
     get available() { return prefStore.available; },
     readAll: () => prefStore.readAll(),
     async writeMany(patch) { const out = await prefStore.writeMany(patch); await reloadPrefs(); await syncRuntime(); return out; },
     close: () => prefStore.close(),
   };
   ```
   `syncRuntime()` 把 view 里的变化推给运行时：`collect.setCadence(view.collect.cadence, { persist:false })`、按 `view.sources` 逐项 `collect.setSource(k, on, { persist:false })`。
   `setCadence/setSource` 第二参数是"别再写库"的闸门 —— 没有它就会出现「写 prefs → 回写 prefs」的循环。Task 8 的实现里这两个方法本就只做运行时动作，所以这里传参只是把意图写明；**如果 Task 8 的实现里已经落库，就删掉本步骤的 `writeMany` 重复写**（两处写一处，别双写）。
6. `collectForApi`：`{ ...collect, setCadence: async (v) => { await collect.setCadence(v); await prefsFacade.writeMany({ prefs: { collect: { cadence: v } } }); }, setSource: async (k, on) => { await collect.setSource(k, on); await prefsFacade.writeMany({ prefs: { sources: { [k]: on } } }); } }` —— 界面只调 service，档位与开关因此**必然落库**（spec §3.2），且落库路径只有这一条。
7. `createApiHandler({ collect: collectForApi, alerts, clean, search, probe, prefStore: prefsFacade, ruleStore, caps, logger: ctx.logger, now: () => Date.now() })`。
8. 生命周期：
   ```js
   ctx.effect(() => () => {
     // 顺序有讲究：先断推流与常驻子进程，再关存储句柄（关晚了写会撞 CLOSED）
     collect.dispose(); alerts.dispose(); clean.dispose(); sup?.dispose?.();
     for (const s of [prefStore, ruleStore, hitStore, planStore, logStore]) {
       Promise.resolve(s.close?.()).catch((e) => ctx.logger?.warn?.(`[sysops] 关闭存储句柄失败：${e?.message ?? e}`));
     }
   }, 'sysops:lifecycle');
   ```
   `hc-6` 断言的就是这里：退回的 `setInterval` 句柄必须被 `collect.dispose()` 清掉。
9. `ctx.on('webserver/index-inject', ...)` 推 `{ kind:'global', name: GLOBAL_KEY, value }`，`value` 含 `panelId/label/panelOrder/routePrefix/api: ROUTE_PREFIX + '/api'`、`capabilities: caps.read()`、`capabilityRows: caps.rows()`、`cadences: COLLECT_CADENCE`、`sourceKeys: SOURCE_KEYS`、`defaults`（`{ procIntervalSec, procMaxRows, keepMinutes, searchPort, quarantineDir }` —— `searchPort` 与 `quarantineDir` 必须在里面：前者是 Task 23 `probeHint` 的端口号来源，漏了就是界面写死 3417 的假象；后者取 Task 14 `createQuarantine` 的**内置默认绝对路径**（宿主展开 `%LOCALAPPDATA%` 后给值），因为 prefs 的 schema 明令拒绝未展开的 `%...%` 形式（`prefq-1`），用户没设过时 prefs 里就是 `undefined`，界面没有这个回落就会渲染出字面量 `undefined`）、`redlines`（`BRANCH_IDS` 里 `b-system-dir/b-recycle-bin/b-program-files/b-registry` 四条对应的中文说明，设置页红线 notice 直接吃它，**不再在 client.js 里抄一份**）、`searchAdvice`（`ADVICE` 三条，搜索页引导卡吃它）。
10. 常驻子进程与"不代装软件"的红线：这里**只 spawn `typeperf` / `powershell`**，绝不 spawn 安装器；`everything` 只走 HTTP 与 `execFile('es.exe')`。文件头注释写明。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/host-compat.test.mjs`
Expected: `8/8 通过`，退出码 0。

- [ ] **Step 5: 追加 `test/plugin.test.mjs` ②段（宿主半边加载）**

```js
/* ②段：宿主半边加载与合规 */
const path = await import('node:path');
const fs = await import('node:fs');
const url = await import('node:url');
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const HOST = await import('../index.js');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/gm, '$1');

check('hx-1 name 与 inject：零硬 inject（缺能力不该阻塞加载）', () => {
  assert.equal(HOST.name, 'sysops');
  assert.deepEqual(HOST.inject, []);
});

check('hx-2 全仓零 @deepseek-ai import（含 lib 递归，注释不算）', () => {
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'docs' && e.name !== 'test') walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      const s = stripComments(fs.readFileSync(p, 'utf8'));
      if (/@deepseek-ai\//.test(s)) bad.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepEqual(bad, [], '这些文件 import 了宿主内部包：' + bad.join(', '));
});

check('hx-3 package.json 零依赖、无 scripts、exports 两路齐', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.ok(pkg.exports['.'] && pkg.exports['./client'], 'exports 缺 . 或 ./client');
});

check('hx-4 路由注册在前缀 /sysops 上（kind:prefix）', () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const r = w.route();
  assert.ok(r, '未注册路由');
  assert.equal(r.kind, 'prefix');
  assert.equal(r.path, '/sysops');
  assert.equal(typeof r.handler, 'function');
});

check('hx-5 注入载荷里 routePrefix 与 client 约定同源，且不含任何本机私有路径', () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const v = w.injectTable().find((x) => x.name === '__SYSOPS__').value;
  assert.equal(v.routePrefix, '/sysops');
  assert.equal(v.panelId, 'sysops');
  assert.equal(v.label, '系统运维');
  assert.ok(v.panelOrder > 0, 'order 必须落在内置「插件」项下方');
  const s = JSON.stringify(v);
  assert.ok(!/C:\\\\Users\\\\|gongj/i.test(s), '注入载荷带了本机私有路径/用户名：' + s.slice(0, 200));
});

await checkAsync('hx-6 cadence 写接口 → 落到 prefs 且 collect 收到（一次点击两处都动）', async () => {
  const w = makeHost();
  HOST.apply(w.ctx, {});
  const r = await callRoute(w, 'POST', '/sysops/api/collect/cadence', { cadence: '5s' });
  assert.equal(r.status, 200);
  const got = await callRoute(w, 'GET', '/sysops/api/prefs');
  assert.equal(got.json.data.prefs.collect.cadence, '5s');
});

check('hx-7 l1b 默认关（实测代价决定默认值，spec §1.1 决策 7）', () => {
  assert.equal(HOST.DEFAULT_CONFIG.sources.l1b, false);
  assert.equal(HOST.DEFAULT_CONFIG.sources.l0, true);
  assert.equal(HOST.DEFAULT_CONFIG.sources.l1a, true);
});

check('hx-8 无原生弹窗与浮层依赖：宿主半边不出现 alert(/confirm( 调用', () => {
  const s = stripComments(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'));
  assert.doesNotMatch(s, /\balert\s*\(|\bconfirm\s*\(/);
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `23/23 通过`（①15 ②8）。若 ①段因 `probe` 独立 dep 的改动而挂，改的是桩与实现说明，**不是**把 probe 塞回 clean。
提交信息草稿：`feat(sysops): 宿主半边与能力探测（缺能力只降级不阻塞）`

---

## Task 20: `client.js` —— 浏览器半边骨架（ModuleLoader / 样式 / SSE / 页签）

**Files:**
- Create: `client.js`
- Create: `test/render-fixtures.mjs`（桩 React + 节点树遍历夹具，③段起所有页面用例共用）
- Modify: `test/plugin.test.mjs`（追加 ③段；统计/exit 挪到文件末尾）

**Interfaces:**
- Consumes: Task 19 的注入载荷（`globalThis.__SYSOPS__`）、宿主 `ctx.slots`、宿主 React（`require('react')`）
- Produces:
  - `window.__ModuleLoader__.load({ id: 'dsh-plugin-sysops', factory })`
  - factory 导出 `{ apply, inject: ['slots'], PANEL_ID, SysopsPanelIcon, SysopsPage, __test }`
  - `__test = { cfg, consumeSse, api, fmtBytes, fmtRate, fmtPct, fmtAge, stateClass, sourcePill, nav, pages }`（测试入口，页面代码本身也从这里取，避免"测的是一份、跑的是另一份"）。`pages = { MonitorPage, CleanPage, SearchPage, SettingsPage }` 在 Task 20 先导出**能跑的空骨架**，Task 21~24 逐个换实现而不动导出名。
  - 四个页签组件占位在本任务建好（`Monitor/Clean/Search/Settings` 先渲染骨架），Task 21~24 逐个填肉

- [ ] **Step 1a: 建共用渲染夹具 `test/render-fixtures.mjs`**

Task 20 的 ③段与 Task 21~24 的页面用例都要「把组件函数跑一遍、再遍历返回的节点树找文案与类名」，这份夹具先建好，四个任务共用一份而不是各自复制。**形状逐字照 `dsh-plugin-stock-analysis/test/plugin.test.mjs:654-697`（桩 React）与 `:781-830`（`walk`）**，只有名字与注释按本插件改；`clientPayload()` 是本计划新增的第四件导出，股票插件没有对应物 —— 理由是 ④~⑦段要共享同一份宿主注入载荷，四个任务各写一份 `globalThis.__SYSOPS__` 必然写出互相矛盾的字段（这次 pre-flight 就抓到 `defaults` 少一键、`sources` 挂错层级两处）：

```js
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
    createElement(type, props, ...children) { return { type, props: props || {}, children }; },
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
  else walk(props.children, out, depth + 1);
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
```

> `useState` 不持久化 → 任何"点一下按钮状态变了没有"的断言都不许写；页面用例只断言**给定 props 下渲染出的文案与类名**，状态机本身由 service 层的测试（Task 8/10/15/17）覆盖。也因此 ④~⑦段的页面组件**自身不持 `useState`**（选择集、页签、快照都从 `SysopsPage` 以 props 传进来），测试才能直接 `Page(props)` 调用。

- [ ] **Step 1b: 写失败的测试（③段：浏览器半边骨架）**

③段开头补一行 `import { makeStubReact } from './render-fixtures.mjs';`（与文件顶部的 harness import 放在一起）。

```js
/* ③段：浏览器半边加载骨架 */
// 四个页签的视图助手容器。ESM 顶层是严格模式，④~⑦段直接 `MON = …` 会抛
// ReferenceError，所以在本段（第一个被追加进来的段）就把四个名字声明好。
let MON = null, CLEAN = null, SRCH = null, SET = null;
let loadedClient = null;
globalThis.window = { __ModuleLoader__: { load: (def) => { loadedClient = def; } } };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild() {} },
};
await import('../client.js');

check('cf-1 经 ModuleLoader 注册且 id 是包名', () => {
  assert(loadedClient, '未调用 window.__ModuleLoader__.load');
  assert.equal(loadedClient.id, 'dsh-plugin-sysops');
});

const ReactStub = makeStubReact();
const CLIENT = loadedClient.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('意外的 require: ' + name);
});

check('cf-2 导出形状：apply / inject(slots) / 两个组件 / __test', () => {
  assert.equal(typeof CLIENT.apply, 'function');
  assert.deepEqual(CLIENT.inject, ['slots']);
  assert.equal(typeof CLIENT.SysopsPanelIcon, 'function');
  assert.equal(typeof CLIENT.SysopsPage, 'function');
  assert.equal(typeof CLIENT.__test.consumeSse, 'function');
});

function clientCtx() {
  const reg = [];
  return {
    effects: [],
    slots: {
      inject: (name, cb) => { reg.push({ phase: 'inject', name }); return cb(); },
      register: (opts, comp) => { reg.push({ phase: 'register', opts, comp }); return () => {}; },
    },
    effect(f, id) { this.effects.push(id); const d = f(); return typeof d === 'function' ? d : () => {}; },
    reg,
  };
}

check('cf-3 没有宿主载荷（缺 webServer）→ 一个 slot 都不注册', () => {
  delete globalThis.__SYSOPS__;
  const c = clientCtx();
  CLIENT.apply(c);
  assert.equal(c.reg.filter((r) => r.phase === 'register').length, 0, JSON.stringify(c.reg));
});

check('cf-4 有载荷：侧边栏 id 与主面板 key 一致、order 跟随宿主', () => {
  globalThis.__SYSOPS__ = { panelId: 'sysops', label: '系统运维', panelOrder: 12, routePrefix: '/sysops', api: '/sysops/api', capabilities: { storageDomain: true, timer: true, webServer: true }, cadences: ['1s', '5s', 'paused'], sourceKeys: ['l0', 'l1a', 'l1b', 'l2'], redlines: [], searchAdvice: [], defaults: {} };
  const c = clientCtx();
  CLIENT.apply(c);
  const nav = c.reg.find((r) => r.opts?.name === 'sidebar.panellist');
  const page = c.reg.find((r) => r.opts?.name === 'main');
  assert.ok(nav && page, '缺注册');
  assert.equal(nav.opts.id, page.opts.key);
  assert.equal(nav.opts.id, 'sysops');
  assert.equal(nav.opts.order, 12, 'order 必须吃注入载荷而不是写死');
  assert.equal(nav.opts.label(), '系统运维');
  assert.deepEqual(c.reg.filter((r) => r.phase === 'inject').map((r) => r.name), ['sidebar.panellist', 'main']);
});

check('cf-5 样式随 ctx.effect 挂载并可回收；颜色全走宿主 token 的 var()', () => {
  const c = clientCtx();
  CLIENT.apply(c);
  assert.ok(c.effects.some((id) => /sysops/.test(String(id))), JSON.stringify(c.effects));
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.match(code, /--dsw-alias-bg-base/);
  assert.match(code, /--dsw-alias-label-primary/);
});

check('cf-6 四页签 label 与已确认原型逐字一致', () => {
  const tabs = CLIENT.__test.nav.map((t) => t.t);
  assert.deepEqual(tabs, ['资源监控', 'C 盘清理', '文件搜索', '设置']);
});

await checkAsync('cf-7 consumeSse：跨 chunk 的半帧不炸、注释帧跳过、坏 JSON 只跳过该帧', async () => {
  const frames = [];
  const enc = new TextEncoder();
  const body = {
    async getReader() {
      const parts = ['event: metrics\ndata: {"a":1}\n', '\nevent: : ping\n\n', ': ok\n\n', 'event: bad\ndata: {oops\n\n', 'event: metrics\ndata: {"b":2}\n\n'];
      let i = 0;
      return { async read() { return i < parts.length ? { done: false, value: enc.encode(parts[i++]) } : { done: true }; } };
    },
  };
  await CLIENT.__test.consumeSse({ body }, (ev, d) => frames.push([ev, d]));
  assert.deepEqual(frames.filter((f) => f[0] === 'metrics').map((f) => f[0] + ':' + JSON.stringify(f[1])), ['metrics:{"a":1}', 'metrics:{"b":2}']);
  assert.equal(frames.length, 2, '注释帧与坏帧不该产出：' + JSON.stringify(frames));
});

await checkAsync('cf-8 api()：GET 走查询串、POST 走 JSON，路径一律以 routePrefix 开头', async () => {
  const seen = [];
  globalThis.fetch = async (u, init = {}) => { seen.push([u, init.method ?? 'GET']); return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }), headers: { get: () => 'application/json' } }; };
  await CLIENT.__test.api('snapshot');
  await CLIENT.__test.api('clean/apply', { method: 'POST', body: { planId: 'p' } });
  assert.equal(seen[0][0], '/sysops/api/snapshot');
  assert.equal(seen[1][1], 'POST');
  assert.ok(seen.every(([u]) => u.startsWith('/sysops/api/')), JSON.stringify(seen));
});

await checkAsync('cf-9 请求失败必须变成可见状态：api() 抛错时返回 error 对象而不是静默', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 501, json: async () => ({ ok: false, error: { code: 'PREFS_UNAVAILABLE', message: '没有 storageDomain' } }) });
  const r = await CLIENT.__test.api('prefs');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PREFS_UNAVAILABLE');
});

check('cf-10 禁止 EventSource（宿主前缀要 POST/带控制帧，且它不便断线重连补历史）', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /new EventSource/);
});

check('cf-11 交互全自研：源码里不出现 confirm( / alert( / <select', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /\bconfirm\s*\(|\balert\s*\(/);
  assert.doesNotMatch(code, /['"]select['"]/);
  assert.doesNotMatch(code, /<select/i);
});

check('cf-12 无顶部浮层：CSS 与组件里都没有 toast/notice-bar 类实现（spec §4.7 就地落卡）', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.doesNotMatch(code, /toast|Toast|notice-bar|noticeBar|position:fixed[^]*top:\s*\d/, '出现浮层实现');
});

console.log(`\n  ${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/plugin.test.mjs`
Expected: `ERR_MODULE_NOT_FOUND` / 未定义 `client.js`（③段起全红，①②段仍绿）。

- [ ] **Step 3: 写实现**

`client.js` 的骨架约定（形状照 `../dsh-plugin-stock-analysis/client.js`，**逐节对应**：文件头注释 → `__ModuleLoader__.load` → `require('react')` → 0) 配置 → 1) 样式 → 2) 工具 → 3) 组件 → 4) 页签 → 5) apply）：

- **0) 配置**：`const GLOBAL_KEY='__SYSOPS__'`（与 `lib/api.js` 的导出**同值**，`hx-5`/`cf-8` 会同时盯住两处；测试里 `rt`/`hx` 断言 `API.GLOBAL_KEY === '__SYSOPS__'`，本文件断言读同一个键，Task 25 复跑时两边一起验）、`const cfg = () => globalThis[GLOBAL_KEY] || {}`、`const PANEL_ID = cfg().panelId || 'sysops'`（**只有这一项**在模块求值时定死，因为它同时是 `factory` 的导出与 slot 的 id，必须稳定）、`PANEL_ORDER = Number(cfg().panelOrder) || 12`、`API_BASE = cfg().api || '/sysops/api'`。
  - **载荷一律经 `cfg()` 现取，不许在模块顶层做整体快照。** 理由：宿主半边的 `index-inject` 与 `apply` 的先后不受本文件控制，③段之前的用例（cf-3）也是在**无载荷**状态下 import 的；页面要读的 `capabilityRows` / `redlines` / `searchAdvice` / `defaults` / `cadences` 若在顶层 `const CFG = globalThis[GLOBAL_KEY] || {}` 定死，就会永远读到空对象，设置页的能力表与红线 notice 会静默空掉。`api()` 与 `useStream()` 内部同样用 `cfg().api || '/sysops/api'`。
  - 因此 `apply(ctx)` 首行是 `if (!cfg().routePrefix) { return; }`（见下条），`cf-4` 之后 ④~⑦ 段可以在渲染前改写 `globalThis.__SYSOPS__` 并立刻生效。
- **`apply(ctx)` 第一件事**：`if (!CFG.routePrefix) { return; }` —— 宿主没给路由前缀（多半是没 `webServer`）就不注册入口。这条**必须有注释**：点开空白页比看不到入口更糟（spec §4.6）。cf-3 断言它。
- **1) 样式**：`STYLE_ID='dsh-plugin-sysops:style'`，`injectStyle()` 与股票插件同形（已存在则返回空清理函数）。CSS 变量**必须**先读宿主 token 再用原型值兜底，命名 `--so-*`：
  ```css
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
    box-sizing:border-box;padding:22px 28px 40px;max-width:1180px;color:var(--so-t1);font-size:13px;line-height:1.6;
  }
  .so-root *{box-sizing:border-box}
  .so-num,.so-root .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
  ```
  其余组件类（`.so-card/.so-card-h/.so-pill/.so-tbl/.so-notice/.so-seg/.so-switch/.so-empty/.so-path/.so-timeline/.so-spark`）从 `prototype/index.html` 的 `<style>` 逐条搬，前缀改 `so-`，**颜色一律换成上面这些变量的 `var()` 引用**（原型里 `#eef3fe` 之类要落成 `color-mix(in srgb,var(--so-blue) 10%,transparent)`，别把十六进制留在语义位）。断点三档 `1080 / 860 / 620` 照原型的 `@media` 搬；侧边栏 200px→56px 属宿主，不在本文件里做。
- **2) 工具（`__test` 出口）**：
  - `consumeSse(res, onEvent)`：抄股票插件的实现（`getReader` + `TextDecoder` + `\n\n` 分帧 + `event:`/`data:` 前缀 + `JSON.parse` 失败 `continue`）。注释保留理由：`EventSource` 只支持 GET，本插件有 POST/SSE 双工控制帧。cf-7 断言半帧/注释帧/坏帧三种情况。
  - `api(name, { method='GET', body, query } = {})`：`fetch(API_BASE + '/' + name + qs, {...})`，**返回解析后的 envelope 而不是抛**：`{ ok, data, error }`（cf-9）。理由：spec §4.7 禁止静默失败，界面要拿 `error.code` 就地渲染在触发它的那张卡上；抛了就得每张卡写 try/catch，早晚有人 `catch {}`。网络层真抛（断网）时返回 `{ ok:false, error:{ code:'NETWORK', message } }`。
  - `fmtBytes(n)`（null/undefined → `'—'`；1024 进制；单位 `B/KB/MB/GB/TB`）、`fmtRate(bytesPerSec)`（**`v / 1e6` 出 MB/s**，注释写明：L1a 的 `v` 是字节/秒；原型曲线里的 `/8` 是按 bit 演示的假数据，运行时代码不许照抄 —— 这条同时被 `pg1-*` 用例盯住）、`fmtPct(v, digits=1)`、`fmtAge(ms)`（"x 分钟前 / x 小时前 / x 天前"）、`stateClass(state)`（`on→''`、`off→so-pill-gray`、`stalled|crashed|exited-max→so-pill-red`、`starting→so-pill-blue`、`unavailable→so-pill-gray`）。
  - `nav = [{k:'monitor',t:'资源监控'},{k:'clean',t:'C 盘清理'},{k:'search',t:'文件搜索'},{k:'settings',t:'设置'}]`。
- **3) `SysopsPanelIcon({ size, active, unread })`**：20px 线性图标（原型侧边栏那颗），`stroke='currentColor'`；`unread > 0` 时在右上角画一个 `r=3` 的蓝点（`fill: var(--so-blue)`）—— **蓝点是侧边栏唯一允许的提示**（spec §1.1 决策 8），且 `unread` 来自未读告警数而不是拍脑袋。
- **4) 连接层 `useStream(setSnapshot)`**（放在 `SysopsPage` 里）：
  - 起 `fetch(GET /sysops/api/stream)` → `consumeSse` 逐帧 `setState`；`snapshot` 帧整体替换，`metrics/proc/sources/alert/clean:*/collect:refresh` 帧局部合并。
  - 断线重连：退避 1s/2s/4s/8s/30s 封顶，状态存 `link = 'sse'|'reconnecting'|'polling'`，采集源条右侧显示 `降级：轮询 2s`（spec §3.1）。
  - 轮询兜底：`link==='polling'` 时 2s 一次 `api('snapshot')`；`document.hidden` 时停轮询并 `POST /sysops/api/collect/visibility {visible:false}`，`visibilitychange` 回来再补一次（这就是驱动 L1b 停采的那一路，见 spec §3.1 选 SSE 的理由 ②）。
  - **进入监控页 → `POST /api/alerts/read`**（清蓝点），离开页面不清（spec §3.5）。
- **5) `SysopsPage`**：页头（`系统运维` + 副标题「本机实时监控 · 两步式 C 盘清理 · 全盘文件搜索」）→ 顶部一行**宿主能力缺什么就在页头下面挂一条灰 notice**（`capabilityRows` 里 `ok===false` 的行，含"宿主不提供"两行；这是就地落在页面上，不是浮层）→ `nav` 页签条 → 四个页签组件（本任务先渲染 `.so-empty` 占位，写清楚"本页签内容随 Task 21~24 填充"是**不行的**：Task 20 交付时四个页签都要有能跑的骨架，至少分别是空态卡、扫描按钮（禁用 + 原因）、搜索框、设置表单壳）→ 页脚 disclaimer（原型 `.disclaimer` 全文逐字）。
- 全文件零 `@deepseek-ai/*`、零第三方 import；`require(...)` 只允许 `'react'`（`hx-2` 递归扫全仓，client.js 也在内）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `35/35 通过`（①15 ②8 ③12）。

Run: `SKIP_LOCAL=1 node test/plugin.test.mjs`
Expected: 同样 `35/35`（本文件无真机用例）。
提交信息草稿：`feat(sysops): 浏览器半边骨架（ModuleLoader / token 样式 / SSE 消费与轮询兜底）`

---

## Task 21: 监控页（四指标 / 采集源条 / 曲线 / 进程榜 / 告警与时间线）

**Files:**
- Modify: `client.js`（把 Task 20 的 `MonitorPage` 空骨架换成完整实现；新增 `__test.monitor` 视图助手出口；`__test` 里追加 `monitor` 键，其余键名不动）
- Modify: `test/plugin.test.mjs`（追加 ④段；统计/exit 仍在文件末尾）

**Interfaces:**
- Consumes: Task 18 的 `snapshotOf()` 载荷（`GET /api/snapshot` 与 SSE 首帧同一个形状）与 SSE 增量帧（`metrics` / `sources` / `proc` / `alert`）、Task 19 载荷的 `cadences` / `defaults`、Task 20 的 `useStream()` 与 `fmtBytes` / `fmtRate` / `fmtPct` / `fmtAge` / `stateClass`
- Produces（都在 `client.js`，经 `__test.monitor` 暴露）：
  - `MonitorPage({ snap, link, onCadence, onSource, onRuleToggle, onRuleAdd, onRestart, onProcToggle, err })`（**自身零 `useState`**，见夹具说明）
  - `mtrRows(snap) → [{ key, n, v, u, c, pct, cls }]`（**恰好四行**，顺序与 `n` 逐字固定：`CPU 使用率 / 内存 / C 盘可用 / 网络吞吐`）
  - `srcCells(snap, link) → [{ key, name, state, detail, cls, pill }]`（`pill` 是四类状态文案之一，见 Step 3 表）
  - `curveSpec(snap, key) → { points, max, threshold, color }`（喂给 Task 20 的 `sparkPoints`；C 盘卡另带 `thresholdGb`）
  - `band(v, warn, crit) → '' | 'warn' | 'crit'`

  进程榜、规则表、触发时间线**只在 `MonitorPage` 内部成块渲染，不单独导出助手** —— 它们的断言全部走 `walk(MON.MonitorPage(...))`（`pg1-9`~`pg1-12`），多一套出口只会让"测的与跑的"再度分叉。

- [ ] **Step 1: 写失败的测试（④段：监控页）**

在 ③段之后、文件末尾统计之前追加。渲染前必须先把完整载荷写回 `globalThis.__SYSOPS__`（Task 20 已把 `cfg()` 改成现取，所以这一步在 ④段才有效）—— 用夹具里的 `clientPayload()`，④~⑦段共享同一份，不许在本段手写第二份字面量。

```js
/* ④段：监控页 —— 纯函数级视图助手 + 组件渲染遍历 */
const { walk, render, clientPayload } = await import('./render-fixtures.mjs');
MON = CLIENT.__test.monitor;
globalThis.__SYSOPS__ = clientPayload();

/** 快照夹具：形状与 Task 18 的 snapshotOf() 逐键一致，不许多造字段。 */
function SNAP(over = {}) {
  return {
    cadence: '1s', keepMinutes: 30, timerBackend: 'ctx.interval',
    series: {
      cpu: [{ t: 1, v: 20 }, { t: 2, v: 42 }, { t: 3, v: 91 }],
      mem: [{ t: 1, v: 70 }, { t: 2, v: 79 }],
      diskFreePct: [{ t: 1, v: 33.5 }],
      netDown: [{ t: 1, v: 12_500_000 }],
      netUp: [{ t: 1, v: 2_400_000 }],
    },
    latest: { cpu: 42.3, mem: 71.5, diskFreeGb: 71.9, diskTotalGb: 214.7, netDown: 12_500_000, netUp: 2_400_000, t: 3 },
    sources: [
      { key: 'l0', label: '实时曲线', state: 'on', detail: '1s · 主进程内', restarts: 0, pid: null, stderrTail: '' },
      { key: 'l1a', label: '网速采集', state: 'on', detail: 'typeperf 运行中', restarts: 0, pid: 19304, stderrTail: '' },
      { key: 'l1b', label: '进程榜', state: 'off', detail: '已关闭', restarts: 0, pid: null, stderrTail: '' },
      { key: 'l2', label: '按需扫描', state: 'on', detail: '请求驱动', restarts: 0, pid: null, stderrTail: '' },
    ],
    proc: { rows: [], state: 'off', note: '' },
    dropped: { stale: 0, bad: 0 },
    alerts: { unread: 0, rules: [], hits: [] },
    clean: { state: { phase: 'idle' }, plan: null },
    ...over,
  };
}
const RULE = (id, n, dep, st, over = {}) => ({ rule: { id, n, dep, ...over }, st });

check('pg1-1 四指标行序与名称逐字固定，网速按 字节/秒 ÷ 1e6 出 MB/s', () => {
  const rows = MON.mtrRows(SNAP());
  assert.deepEqual(rows.map((r) => r.n), ['CPU 使用率', '内存', 'C 盘可用', '网络吞吐']);
  assert.equal(rows[3].v, '12.5');
  assert.equal(rows[3].u, 'MB/s');
  assert.match(rows[3].c, /上行 2\.4 MB\/s/);
});

check('pg1-2 禁止照抄原型的 /8：12 500 000 字节/秒 必须是 12.5 MB/s 而不是 1.6', () => {
  assert.equal(MON.mtrRows(SNAP()).find((r) => r.n === '网络吞吐').v, '12.5', '原型曲线的 /8 是 bit 口径演示值');
  assert.equal(CLIENT.__test.fmtRate(12_500_000), '12.5 MB/s');
});

check('pg1-3 内存/CPU 分档：>70 warn、>85 crit；边界值 85 不算 crit', () => {
  const r = MON.mtrRows(SNAP({ latest: { cpu: 85, mem: 71.5, diskFreeGb: 71.9, diskTotalGb: 214.7, netDown: 0, netUp: 0, t: 3 } }));
  assert.equal(r[0].cls, 'warn', '85 是"≥"阈值，进度条该 warn 而不是 crit');
  const r2 = MON.mtrRows(SNAP({ latest: { cpu: 85.6, mem: 96, diskFreeGb: 71.9, diskTotalGb: 214.7, netDown: 0, netUp: 0, t: 3 } }));
  assert.equal(r2[0].cls, 'crit');
  assert.equal(r2[1].cls, 'crit');
});

check('pg1-4 C 盘行的 pct 是"已用"而不是"可用"，且 total 缺失时不硬算', () => {
  const d = MON.mtrRows(SNAP()).find((r) => r.n === 'C 盘可用');
  assert.equal(d.pct, 66.5, '214.7 总 / 71.9 可用 → 已用 66.5%');
  assert.match(d.c, /已用 66\.5%/);
  const d2 = MON.mtrRows(SNAP({ latest: { cpu: 1, mem: 1, diskFreeGb: 71.9, diskTotalGb: 0, netDown: 0, netUp: 0, t: 3 } })).find((r) => r.n === 'C 盘可用');
  assert.equal(d2.pct, null, '总容量缺失时进度条宁可不画');
});

check('pg1-5 采集源条四类状态文案各不相同（spec §4.2 四分清）', () => {
  const cell = (state, extra = {}) => MON.srcCells(SNAP({ sources: [{ key: 'l1a', label: '网速采集', state, detail: '', restarts: 0, pid: null, stderrTail: '', ...extra }] }), 'sse')[0];
  assert.equal(cell('off').pill, '未开启');
  assert.match(cell('crashed').pill, /进程已退出/);
  assert.equal(cell('unavailable').pill, '权限不足/计数器缺失');
  assert.equal(cell('on').pill, '运行中');
});

check('pg1-6 exited-max 行必须带退避次数与 stderr 尾巴，并且不再自动重启', () => {
  const c = MON.srcCells(SNAP({ sources: [{ key: 'l1a', label: '网速采集', state: 'exited-max', detail: '', restarts: 5, pid: null, stderrTail: 'ERROR: 无法访问' }] }), 'sse')[0];
  assert.match(c.pill, /已退出 5 次/);
  assert.match(c.detail, /ERROR: 无法访问/);
  assert.equal(c.retryOnly, true, '5 次封顶后只留「重试」按钮');
});

check('pg1-7 数据异常计数在曲线上可见（脏点丢弃不画点，但要报数）', () => {
  const out = walk(MON.MonitorPage({ snap: SNAP({ dropped: { stale: 2, bad: 7 } }), link: 'sse' }));
  assert.ok(out.texts.some((t) => /丢弃 7 个异常点/.test(t)), JSON.stringify(out.texts.filter((t) => /丢弃/.test(t))));
  assert.ok(out.texts.some((t) => /乱序 2/.test(t)));
});

check('pg1-8 阈值线只画在有阈值的卡上：CPU 85、C 盘 32 GB，网速卡没有', () => {
  assert.equal(MON.curveSpec(SNAP(), 'cpu').threshold, 85);
  assert.equal(MON.curveSpec(SNAP(), 'diskFreePct').thresholdGb, 32);
  assert.equal(MON.curveSpec(SNAP(), 'netDown').threshold, null);
});

check('pg1-9 进程榜关闭时把实测代价与默认关的理由写在空态里', () => {
  const out = walk(MON.MonitorPage({ snap: SNAP(), link: 'sse' }));
  assert.ok(out.has('640ms'));
  assert.ok(out.has('13%'));
  assert.ok(out.has('现在开启'));
  assert.ok(!out.has('Chrome.exe'), '未开启就不该渲染榜单行');
});

check('pg1-10 进程榜开启：表头四列 + 按 cpuPct 排序 + 「不结束进程」的理由卡', () => {
  const rows = [
    { pid: 7412, name: 'idea64.exe', ws: 4.1e9, cpuPct: 11.2 },
    { pid: 11384, name: 'Chrome.exe', ws: 2.4e9, cpuPct: 92.4 },
  ];
  const out = walk(MON.MonitorPage({ snap: SNAP({ proc: { rows, state: 'on', note: '上限 400 行 · 已截断' } }), link: 'sse' }));
  assert.ok(out.has('PID') && out.has('CPU%') && out.has('内存') && out.has('来源'));
  assert.ok(out.texts.indexOf('Chrome.exe') < out.texts.indexOf('idea64.exe'), '必须按 CPU 降序');
  assert.ok(out.has('本插件不提供「结束进程」'), out.texts.join('|'));
  assert.ok(out.has('已截断'));
});

check('pg1-11 规则置灰吃宿主的 st 三态，页面绝不自己比 source.state', () => {
  const snap = SNAP({ alerts: { unread: 0, rules: [RULE('r4', '下行持续 > 20 MB/s 满 1 分钟', 'l1a', { dim: true, on: false, st: '依赖的采集已关闭' }), RULE('r5', '单进程 CPU > 60%', 'l1b', { dim: false, on: false, st: '已暂停' }), RULE('r1', 'CPU ≥ 85% 连续 3 次', 'l0', { dim: false, on: true, st: '监控中' })], hits: [] } });
  const out = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(out.has('依赖的采集已关闭') && out.has('已暂停') && out.has('监控中'));
  assert.equal(out.classHas('so-rule-dim'), true);
  const src = CLIENT.__test.monitor.srcCells(snap, 'sse');
  assert.equal(src.find((c) => c.key === 'l1a').state, 'on', '置灰只跟随 st，不跟随本行 state 的直觉');
});

check('pg1-12 触发时间线两类行（hit 带数值、op 带操作），且标出 200 条上限', () => {
  const snap = SNAP({ alerts: { unread: 2, rules: [], hits: [
    { hitId: 'h-1', t: 1_700_000_000_000, kind: 'hit', ruleName: 'CPU ≥ 85% 连续 3 次', metric: 'cpu', value: 92.4, note: '连续 3 次' },
    { hitId: 'h-2', t: 1_700_000_000_000, kind: 'op', text: '你将实时曲线采样档位切为 5s' },
  ] } } });
  const out = walk(MON.MonitorPage({ snap, link: 'sse' }));
  assert.ok(out.has('92.4'));
  assert.ok(out.has('CPU ≥ 85% 连续 3 次'));
  assert.ok(out.has('你将实时曲线采样档位切为 5s'));
  assert.ok(out.has('本机保留最近 200 条'));
});

check('pg1-13 侧边栏蓝点只由未读数驱动：0 不画，>0 画', () => {
  const zero = walk(CLIENT.SysopsPanelIcon({ size: 20, active: false, unread: 0 }));
  const three = walk(CLIENT.SysopsPanelIcon({ size: 20, active: false, unread: 3 }));
  assert.equal(zero.classes.filter((c) => /unread/.test(c)).length, 0);
  assert.equal(three.classes.filter((c) => /unread/.test(c)).length, 1);
});

check('pg1-14 推送降级必须在采集源条上如实标出来（sse / reconnecting / polling 三态）', () => {
  const t = (link) => walk(MON.MonitorPage({ snap: SNAP(), link })).texts.join('|');
  assert.ok(!/降级/.test(t('sse')));
  assert.match(t('reconnecting'), /重连中/);
  assert.match(t('polling'), /降级：轮询 2s/);
});

check('pg1-15 数据红线：client.js 源码里不出现原型的演示数字与"系统通知"开关', () => {
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  for (const lit of ['71.9', '214.7', '11.4', '22:41', 'Chrome.exe', '84.1 万']) {
    assert.ok(!code.includes(lit), `源码里出现了写死的演示值 ${lit}`);
  }
  assert.doesNotMatch(code, /系统通知/, '宿主不提供系统通知 → UI 上不留开关（spec §1.1 决策 8）');
});

check('pg1-16 快照缺失（首个 snapshot 帧未到）时渲染骨架而不是崩溃', () => {
  const out = walk(MON.MonitorPage({ snap: null, link: 'sse' }));
  assert.ok(out.has('等待首帧数据'), out.texts.join('|'));
  assert.ok(!out.has('NaN'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/plugin.test.mjs`
Expected: ④段全红（`__test.monitor` 尚未导出，`Cannot read properties of undefined (reading 'mtrRows')`），①②③段仍 `35/35` 绿。

- [ ] **Step 3: 写实现（视图助手，逐条对应上面的用例）**

四个视图助手都是**纯函数**，`MonitorPage` 只做编排 —— 这样用例不必依赖桩 React 的状态就能断言，页面本身也走同一份，杜绝"测的是一份、跑的是另一份"。

```js
/* ---- 监控页视图助手（纯函数，经 __test.monitor 暴露） ---- */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const peak = (pts) => { const a = (pts || []).map((p) => num(p && p.v)).filter((v) => v !== null); return a.length ? Math.max(...a) : null; };
/** warn/crit 分档。边界值归 warn：85 是"≥ 才触发"的阈值，进度条不该在等于阈值时就报红。 */
function band(v, warn, crit) { const x = num(v); if (x === null) return ''; if (x > crit) return 'crit'; if (x > warn) return 'warn'; return ''; }

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
```

- `fmtRate(bytesPerSec)` 在 Task 20 定为 `v / 1e6` + `' MB/s'`。**`mtrRows` 的网络行取 `fmtRate(...).split(' ')[0]` 只为了把数字与单位拆给两个 `<span>`**；单位串仍来自 `fmtRate`，不要再在别处写第二份换算。
- **`pct` 与文案共用同一个已四舍五入到 0.1 的数字**（`(1 - free/total)*100` 在 214.7 / 71.9 下是 `66.506…`，`pg1-4` 断言的是 `66.5`）。进度条宽度和"已用 x%"必须读同一个值，别一处 `toFixed` 一处原值——那样"看着 66.5%、条按 66.506% 画"迟早会在别的机器上对不上。
- **快照没有的数字一律不显示。** `latest` 里没有内存总量，所以内存行是「71.5 %」而不是原型里的「11.4 / 16 GB」；`pg1-15` 就是钉这条。要补总量得先扩 `lib/collect/l0-node.js` 的 `os.totalmem()` 字段并同步 Task 4/8 的断言，**不许在界面侧编**。
- `srcCells(snap, link)` 四类文案（与 spec §4.2 一一对应，颜色/类名不同）：

| `state` | `pill` 文案 | 类名 | 附注 |
|---|---|---|---|
| `off` | `未开启` | `so-pill-gray` | — |
| `starting` | `启动中` | `so-pill-blue` | — |
| `on` | `运行中` | `so-pill-on` | 心跳正常 |
| `stalled` | `超时无输出` | `so-pill-red` | 附 `3× 采样间隔` |
| `crashed` | `进程已退出` | `so-pill-red` | 附 `restarts` 与退避中 |
| `exited-max` | `已退出 5 次` | `so-pill-red` | `retryOnly: true`，附 `stderrTail`（≤400 字符） |
| `unavailable` | `权限不足/计数器缺失` | `so-pill-gray` | 说明缺哪个计数器名 |
| 任意 + `dropped.bad > 0` | 曲线卡上另出「丢弃 7 个异常点 · 乱序 2」 | — | 脏点不进 ring（Task 4） |

`link !== 'sse'` 时在源条尾部追加一格：`reconnecting → 「重连中」`、`polling → 「降级：轮询 2s」`（spec §3.1）。

- `MonitorPage` 的 JSX 结构照原型 `panel-monitor` 逐块搬：`.so-mtr-strip`（四卡，含 `.so-track` 进度条，`cls` 决定 `is-warn/is-crit`）→ `.so-srcs`（采集源条）→ `.so-charts`（四张 SVG 曲线卡，`curveSpec` 出 `points/max/threshold`，阈值线画虚线；C 盘卡的阈值用 `thresholdGb: 32` 换算到 `max` 轴）→ 进程榜卡 → 阈值告警卡（规则表 + 新建规则框）→ 触发记录卡（`.so-timeline`）。
- 页头右侧的档位 seg 吃 Task 19 的 `cadences`（`['1s','5s','paused']` → 显示 `1s / 5s / 暂停`），**当前档位取 `snap.cadence` 而不是本地默认**；切换调 `onCadence(v)` → `POST /sysops/api/collect/cadence`。
- 规则表的开关点击调 `onRuleToggle(id, on)`；`st.dim` 为真时 `disabled` + `aria-disabled`，并在行右侧把 `st` 文案染成琥珀色（原型 `.rt` 内联样式的等价类 `so-rule-dim`）。
- 「新建规则」展开框的四个字段与提示落点文案照原型 `ruleAddBox` 逐字，保存调 `onRuleAdd({ metric:'cpu', value, consecutive, cooldownSec })` → `POST /sysops/api/prefs`；**界面上不出现"系统通知"字样**（宿主不提供，`pg1-15` 钉住）。
- `snap` 为 `null`（首帧未到）时整页只渲染四张骨架卡 + 文案「等待首帧数据」，所有数值位显示 `—`；**不许出现 `NaN`**（`pg1-16`），因此每个助手入口处都过一次 `num()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `51/51 通过`（①15 ②8 ③12 ④16 — 本段无真机用例）。
Run: `SKIP_LOCAL=1 node test/plugin.test.mjs`
Expected: 同样 `51/51`。
提交信息草稿：`feat(sysops): 监控页（四指标 / 采集源条四分清 / 曲线 / 进程榜 / 告警时间线）`

---

## Task 22: 清理页（扫描范围 → 进度 → 冻结清单 → 勾选 → 执行/隔离 → 留痕）

**Files:**
- Modify: `client.js`（`CleanPage` 实现 + `__test.clean` 出口）
- Modify: `test/plugin.test.mjs`（追加 ⑤段）

**Interfaces:**
- Consumes: `GET /api/clean/state`、`GET /api/snapshot` 里的 `clean` 键、SSE 的 `clean:progress` / `clean:done` / `clean:item` / `clean:summary` / `clean:error` 帧、`GET /api/clean/logs`、`GET /api/clean/unfinished`、`GET /api/quarantine`、`GET /api/rules`（Task 18 全有）；Task 15 的 `plan` / `Summary` / item result 形状
- Produces（`__test.clean`）：
  - `CleanPage({ clean, plan, logs, unfinished, quar, rules, prefs, caps, link, sel, err, onScan, onStopScan, onToggle, onSelectAll, onSelectNone, onApply, onQuarantine })`
  - `PLAN_COLS = ['路径 / 内容', '大小', '命中规则', '最后访问', '风险']`（表头逐字，第一列是复选框占位）
  - `scanCells(state) → { cur, walked, found, size, pct, phase, note }`
  - `planRows(plan, sel) → [{ id, path, sizeText, ruleName, accText, riskPill, disabled, why }]`
  - `selTotals(plan, sel) → { n, bytes, bytesText, selectable, risky, rejected }`
  - `selectAllIds(plan) → id[]`（未拒 + `riskLevel==='low'`，与原型 `btnSelAll` 同规则）
  - `applyBody(planId, ids, mode) → { planId, itemIds, mode }`（**结构上就没有 path 键**）
  - `logRow(log) → { id, modePill, restorable, line, snapshot }`
  - `quarantineText(prefs) → string`（渲染 prefs 实配暂存目录）

- [ ] **Step 1: 写失败的测试（⑤段：清理页）**

```js
/* ⑤段：清理页 —— 两段式的界面侧 */
CLEAN = CLIENT.__test.clean;

const IDLE = { phase: 'idle', dir: '', walked: 0, hit: 0, bytes: 0, stopped: false, truncated: false, skipped: [], planId: null, error: '' };
const SCAN = { phase: 'scanning', dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp', walked: 118_400, hit: 6, bytes: 2.4e9, stopped: false, truncated: false, skipped: [{ dir: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\locked', code: 'EPERM', why: '拒绝访问' }], planId: null, error: '' };
const ITEM = (over = {}) => ({ id: 'temp-user-aG9tZQ', ruleId: 'temp-user', ruleName: '用户临时目录', kind: '缓存',
  path: 'C:\\Users\\gongj\\AppData\\Local\\Temp\\old.log', size: 656 * 2 ** 20, count: 14, atime: 1, mtime: 1,
  riskLevel: 'low', riskWhy: '', ...over });
const PLAN = (items) => ({ planId: 'plan-1', at: 1_700_000_000_000, beforeFree: 70.4e9, afterFree: null, modeDefault: 'delete-file',
  rulesUsed: [{ id: 'temp-user', n: '用户临时目录', kind: '缓存' }], items, totals: { n: items.length, bytes: items.reduce((a, i) => a + i.size, 0) } });

check('pg2-1 未扫描时的空态：说清扫描是只读的、删除只发生在勾选之后', () => {
  const out = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: { dirs: 0, files: 0, bytes: 0, oldest: null }, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('尚未扫描'));
  assert.ok(out.has('扫描是只读的'));
  assert.ok(!out.has('路径 / 内容'), '未扫描不该出现清单表');
});

check('pg2-2 扫描中：当前目录 / 已遍历 / 已发现 + 大小 / 进度条 / 停止按钮', () => {
  const c = CLEAN.scanCells(SCAN);
  assert.equal(c.walked, '118,400');
  assert.equal(c.found, 6);
  assert.match(c.size, /GB/);
  assert.ok(Number(c.pct) >= 0 && Number(c.pct) <= 100);
  const out = walk(CLEAN.CleanPage({ clean: SCAN, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('停止扫描'));
  assert.ok(out.has('中断后已发现的部分仍可继续查看'));
});

check('pg2-3 清单表头五列逐字，且第一列是复选框占位', () => {
  assert.deepEqual(CLEAN.PLAN_COLS, ['路径 / 内容', '大小', '命中规则', '最后访问', '风险']);
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  for (const col of CLEAN.PLAN_COLS) assert.ok(out.has(col), `缺表头 ${col}`);
});

check('pg2-4 被 guard 拒绝的项：复选框禁用 + 「已拒绝」+ 原因，且不进可选集合', () => {
  const items = [ITEM(), ITEM({ id: 'x1', path: 'C:\\Windows\\Temp', ruleName: '系统临时目录', guardDenied: { code: 'b-system-dir', why: '命中不可移除黑名单：C:\\Windows\\*' } })];
  const rows = CLEAN.planRows(PLAN(items), new Set(['temp-user-aG9tZQ', 'x1']));
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].riskPill, '已拒绝');
  assert.match(rows[1].why, /不可移除黑名单/);
  const t = CLEAN.selTotals(PLAN(items), new Set(['temp-user-aG9tZQ', 'x1']));
  assert.equal(t.n, 1, '勾了也没用：被拒项不计入可选集合');
});

check('pg2-5 标风险的项可以被勾选，但「全选可清理项」跳过它并说明跳了几项', () => {
  const items = [ITEM(), ITEM({ id: 'r1', riskLevel: 'mid', riskWhy: '微信正在运行' }), ITEM({ id: 'x1', guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } })];
  const t = CLEAN.selTotals(PLAN(items), CLEAN.selectAllIds(PLAN(items)));
  assert.equal(t.n, 1, '默认全选 = 低风险且未被拒的 1 项');
  assert.equal(t.risky, 1);
  assert.equal(t.rejected, 1);
});

check('pg2-6 未勾选时两个动作按钮都禁用，并给出原因而不是静默变灰', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  const del = out.buttons.find((b) => b.text.includes('清理选中'));
  const quar = out.buttons.find((b) => b.text.includes('隔离到暂存目录'));
  assert.equal(del.disabled, true);
  assert.equal(quar.disabled, true);
  assert.ok(out.has('勾选至少一项'));
});

check('pg2-7 已选统计：项数 + 预计释放 + 「删除不可恢复，回收站不参与」', () => {
  const plan = PLAN([ITEM(), ITEM({ id: 'b', size: 1.24 * 2 ** 30 })]);
  const t = CLEAN.selTotals(plan, new Set(['temp-user-aG9tZQ', 'b']));
  assert.equal(t.n, 2);
  assert.match(t.bytesText, /GB/);
  assert.ok(t.bytes > 1.8e9 && t.bytes < 1.9e9, String(t.bytes));
});

check('pg2-8 请求体结构上不含路径：applyBody 只出三键（与宿主 rt-6 同一条红线的界面侧）', () => {
  const b = CLEAN.applyBody('plan-1', ['a', 'b'], 'delete-file');
  assert.deepEqual(Object.keys(b).sort(), ['itemIds', 'mode', 'planId']);
  assert.ok(!/path/i.test(JSON.stringify(b)));
});

check('pg2-9 暂存目录显示 prefs 的实配值，不照抄原型的演示路径', () => {
  // 夹具必须是**展开后的绝对路径**：Task 14 的 `prefq-1` 让 prefs schema 直接拒掉未展开的 `%LOCALAPPDATA%\q`，
  // 所以库里永远不可能出现 `%` 形 —— 拿它当 prefs 值是假夹具（界面无条件渲染 prefs 实配值）。
  const txt = CLEAN.quarantineText({ clean: { quarantineDir: 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine', keepDays: 7 } });
  assert.ok(txt.includes('dsh-plugin-sysops\\quarantine'), txt);
  assert.ok(!txt.includes('.dsh-quarantine'), '原型里那串是演示值：' + txt);
  assert.match(txt, /保留 7 天|7 天/);
  assert.match(txt, /插件不会自动删/);
});

check('pg2-10 留痕：三档计数逐条可见，可展开看冻结快照与前后容量', () => {
  const logs = [{ logId: 'CLN-2609-0003', planId: 'plan-9', startedAt: 1, finishedAt: 2, mode: 'delete-file', itemIds: ['a'],
    ok: 5, skipped: 1, failed: 0, rejected: 2, bytesFreed: 3.12e9, beforeFree: 70.4e9, afterFree: 73.5e9, error: '' }];
  const r = CLEAN.logRow(logs[0]);
  assert.match(r.line, /成功 5 · 跳过 1 · 失败 0/);
  assert.equal(r.modePill, '永久删除');
  assert.match(r.snapshot, /70\.4 GB → 73\.5 GB/);
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs, unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('清理留痕'));
  assert.ok(out.has('追加式，只读'));
});

check('pg2-11 上次执行未确认完成要在清单顶部提示，并指向留痕（spec §4.3）', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: 'plan-1' }, plan: PLAN([ITEM()]), logs: [],
    unfinished: [{ logId: 'CLN-2609-0004', startedAt: 1, mode: 'delete-file', done: 3, total: 6 }], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: null }));
  assert.ok(out.has('上次执行未确认完成'));
  assert.ok(out.has('CLN-2609-0004'));
});

check('pg2-12 执行完清单即失效：盖执行时间戳并要重新扫描（改勾选必须先重扫的代价）', () => {
  const out = walk(CLEAN.CleanPage({ clean: { ...IDLE, phase: 'done', planId: null }, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(),
    err: null, lastSummary: { planId: 'plan-1', ok: 2, skipped: 0, failed: 0, rejected: 0, bytesFreed: 1.9e9, at: 1_700_000_090_000 } }));
  assert.ok(out.has('清单已失效'));
  assert.ok(out.has('重新扫描'));
});

check('pg2-13 写接口错误就地落 notice：501 与 403 两种原因文案不同，都不弹浮层', () => {
  const e1 = { source: 'clean/apply', status: 501, code: 'PREFS_UNAVAILABLE', message: '没有 storageDomain' };
  const o1 = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: { storageDomain: false }, link: 'sse', sel: new Set(), err: e1 }));
  assert.ok(o1.has('配置只读'));
  assert.ok(o1.classHas('so-notice-red'));
  const e2 = { source: 'rules/add', status: 403, code: 'SYSOPS_RULE_GUARD_DENY', message: '回收站一律不参与' };
  const o2 = walk(CLEAN.CleanPage({ clean: IDLE, plan: null, logs: [], unfinished: [], quar: {}, rules: [], prefs: {}, caps: {}, link: 'sse', sel: new Set(), err: e2 }));
  assert.ok(o2.has('回收站一律不参与'));
  assert.ok(!/position:fixed/.test(JSON.stringify(o2.classes)), '不许出现浮层');
});

check('pg2-14 扫描被截断/有目录读不动时必须说明（spec §7 如实降级）', () => {
  const c = CLEAN.scanCells({ ...SCAN, truncated: true, skipped: [{ dir: 'D:\\locked', code: 'EPERM', why: '拒绝访问' }], stopped: true });
  assert.match(c.phase, /已停止/);
  assert.match(c.note, /条目数达上限/);
  assert.match(c.note, /1 个目录读不动/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/plugin.test.mjs`
Expected: ⑤段全红（`__test.clean` 未导出），①~④段仍 `51/51` 绿。

- [ ] **Step 3: 写实现**

- 状态机在宿主侧（Task 15 的 `clean.service.state()`），页面**只做四种相位的渲染分支**：`idle`（空态卡）/ `scanning`（进度卡）/ `done`（清单卡）/ `error`（清单卡 + 红 notice）。`stopped`/`truncated` 是附加标记而不是独立相位。
- `scanCells(state)`：`walked` 用 `toLocaleString('en-US')` 出千分位（`pg2-2` 断言 `'118,400'`）；`pct` 由 `state.hit` 与已启用规则数之比给出**上限 96% 的估算进度**，注释必须写明"这是覆盖度估算，不是字节进度"，真完成由 `clean:done` 帧定；`truncated` 时附「条目数达上限 200 000，清单不完整」，`skipped.length` 时附「N 个目录读不动」，`stopped` 时 `phase` 文案切「已停止」。
- `planRows(plan, sel)` 的 `accText` 用 `fmtAge(now - atime)`（Task 20），`riskPill` 三态：`guardDenied → '已拒绝'`、`riskLevel==='mid' → riskWhy`、否则 `'无'`；`guardDenied.why` 原样显示（文案来自宿主 `check()` 的 `why`，**页面不自己造句**）。
- `selTotals` 的可选集合定义：`!guardDenied && sel.has(id)`；`risky`/`rejected` 计数用来渲染 `pg2-5`/`pg2-6` 的说明文字。`selectAllIds(plan)` = 未拒 + `riskLevel==='low'` 的 id 列表（与原型 `btnSelAll` 同规则），并让「全选已跳过 N 项标风险的（应用正在运行）」这句话由 `risky` 驱动。
- `applyBody` 是**唯一**构造执行请求的地方，签名 `applyBody(planId, ids, mode)`；`mode` 只能取宿主 `MODES` 三值（Task 15），页面不引入第四种。注释写死理由：路径永远来自宿主侧快照，前端连路径都不发（spec §3.3）。
- `quarantineText(prefs)` 直接渲染 `prefs.clean.quarantineDir` 与 `keepDays`；**prefs 没设过时回落到 `cfg().defaults.quarantineDir`**（Task 19 载荷里宿主展开好的绝对路径），两条都没有才渲染「尚未设置暂存目录」—— 一律不许渲染出字面量 `undefined`（`optionalString` 与 `prefq-1` 的语义决定了"空"在服务端就是 `undefined`，不是 `''`）。**这里收口计划期发现的口径冲突**：原型 `.dsh-quarantine\2026-09-27\` 是演示串，运行时的权威值来自 prefs（展开由宿主做：Task 14 的 `prefq-1` 规定 prefs 只收展开后的绝对路径，未展开的 `%...%` 形在 schema 层就被拒；Task 19 把内置默认以展开态放进 `defaults.quarantineDir`）。Task 25 回写 spec §8 未决项时把这条记为已定。
- 按钮禁用必须带原因：`sel.size === 0 → 「勾选至少一项」`、`caps.storageDomain === false → 「配置只读：宿主未提供 storageDomain」` 且两个写按钮 `disabled`。
- 所有错误渲染在触发它的那张卡内部（`.so-notice-red` / `.so-notice-amber`），**无浮层**（cf-12 与 `pg2-13` 双钉）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `65/65 通过`（①15 ②8 ③12 ④16 ⑤14 — 其中 `pg2-14` 依赖本段新增的 `scanCells.note`）。
Run: `SKIP_LOCAL=1 node test/plugin.test.mjs`
Expected: 同样 `65/65`。
提交信息草稿：`feat(sysops): 清理页（两段式清单 / guard 拒绝可见 / 留痕三档计数）`

---

## Task 23: 搜索页（三级自检 → 引导卡 → 通路选择 → 结果表）

**Files:**
- Modify: `client.js`（`SearchPage` 实现 + `__test.search` 出口）
- Modify: `test/plugin.test.mjs`（追加 ⑥段）

**Interfaces:**
- Consumes: `GET /api/search`（Task 17 的 `Result` 形状）、`GET /api/search/probe` 与 `POST /api/search/reprobe`（Task 16 的 `ProbeResult`）、Task 19 载荷的 `searchAdvice`（= `ADVICE` 三条）、`SOURCE_LABEL`（Task 17）
- Produces（`__test.search`）：
  - `SearchPage({ probe, res, mode, limit, q, dirs, err, onSearch, onMode, onLimit, onReprobe, onAddDir, onDelDir })`
  - `PROBE_ROWS = ['① 已安装 Everything', '② 有查询通路', '③ 端到端可用']`（自检三行标题逐字）
  - `probeCells(probe) → [{ title, pill, pillCls, detail, mark }]`（`mark ∈ '✓'|'!'|'·'`，第三级在前两级未全过时是 `'·'`+`未执行`，**不是** `!`）
  - `modeOf(probe, wanted) → 'everything' | 'walk'`（通路未就绪时强行回落 `walk`，并给出 `why`）
  - `resultHead(res) → { sub, sourcePill, hitText }`
  - `rowCells(res) → [{ name, dir, sizeText, mtimeText, sourcePill } ]`
  - `advice() → string[]`（**无参**，只从 `cfg().searchAdvice` 现取，不自己写第二条文案）
  - `searchQuery({ q, mode, limit }) → { q, mode, limit } | null`（空 q 返回 `null` = 不发请求）
  - `LIMITS = [50, 200, 1000]`（上限三档，逐字与原型 seg 一致）

- [ ] **Step 1: 写失败的测试（⑥段：搜索页）**

```js
/* ⑥段：搜索页 —— 通路自检与诚实降级 */
SRCH = CLIENT.__test.search;

const PROBE = (over = {}) => ({ at: 1, installed: false, http: false, es: false, e2e: false, ready: false, via: null,
  degraded: true, level: null,
  checks: [
    { key: 'installed', label: '已安装 Everything', ok: false, detail: '注册表卸载键 + 常见安装路径 + 服务/进程名三处取证：均未命中' },
    { key: 'channel', label: '有查询通路', ok: false, detail: 'HTTP 3417 与 es.exe 两条都没有' },
    { key: 'e2e', label: '端到端可用', ok: false, detail: '未执行' },
  ], advice: ['winget install voidtools.Everything', 'https://www.voidtools.com/downloads/', '勾选 工具 → 选项 → HTTP 服务器（默认端口 3417）'], ...over });
const RES = (over = {}) => ({ rows: [], source: 'walk', sourceLabel: '本地遍历', truncated: false, stale: false, note: '', error: null, took: 7300, limit: 200, ...over });
const PAGE = (over = {}) => walk(SRCH.SearchPage({ probe: PROBE(), res: null, mode: 'walk', limit: 200, q: '', dirs: [], err: null,
  onSearch() {}, onMode() {}, onLimit() {}, onReprobe() {}, onAddDir() {}, onDelDir() {}, ...over }));

check('pg3-1 自检三行标题逐字，且卡在哪一级就标在哪一级', () => {
  assert.deepEqual(SRCH.PROBE_ROWS, ['① 已安装 Everything', '② 有查询通路', '③ 端到端可用']);
  const c = SRCH.probeCells(PROBE());
  assert.deepEqual(c.map((x) => x.title), SRCH.PROBE_ROWS);
  assert.equal(c[0].mark, '!');
  assert.equal(c[2].mark, '·', '前两级没过时第三级是"未执行"而不是失败');
  assert.equal(c[2].pill, '未执行');
});

check('pg3-2 三级全绿才收引导卡', () => {
  const off = PAGE({});
  assert.ok(off.has('如何拿到全盘秒级搜索'));
  const on = PAGE({ probe: PROBE({ installed: true, http: true, e2e: true, ready: true, via: 'http', degraded: false, level: 'e2e' }) });
  assert.ok(!on.has('如何拿到全盘秒级搜索'), '通路就绪后引导卡该收起来');
});

check('pg3-3 指引三条只从注入载荷的 searchAdvice 取（文案单源，不在 client 再抄一份）', () => {
  globalThis.__SYSOPS__.searchAdvice = ['A1 winget install voidtools.Everything', 'A2 https://www.voidtools.com/downloads/', 'A3 工具 → 选项 → HTTP 服务器'];
  assert.deepEqual(SRCH.advice(), ['A1 winget install voidtools.Everything', 'A2 https://www.voidtools.com/downloads/', 'A3 工具 → 选项 → HTTP 服务器']);
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.ok(!code.includes('voidtools.com'), 'client.js 里不该出现第二份安装指引文案');
  delete globalThis.__SYSOPS__.searchAdvice;
});

check('pg3-4 明说不代装：引导卡里有"由你自己执行"与三条边界（不装程序 / 不改注册表 / 不开服务）', () => {
  const out = PAGE({});
  assert.ok(out.has('由你自己执行'));
  assert.ok(out.has('不会替你装程序'));
  assert.ok(out.has('不会改注册表'));
  assert.ok(out.has('不会替你打开 HTTP 服务'));
});

check('pg3-5 通路未就绪：默认模式落 walk，全盘索引按钮标不可选并给原因', () => {
  assert.equal(SRCH.modeOf(PROBE(), 'everything'), 'walk');
  assert.equal(SRCH.modeOf(PROBE({ installed: true, es: true, e2e: true, ready: true, via: 'es', degraded: false }), 'everything'), 'everything');
  const out = PAGE({});
  const b = out.buttons.find((x) => x.text.includes('全盘索引'));
  assert.equal(b.disabled, true);
  assert.ok(out.has('通路未就绪'));
});

check('pg3-6 walk 模式必须写明覆盖范围与实测代价（14.5 万条目 / 7.3s）', () => {
  const out = PAGE({ mode: 'walk', dirs: ['C:\\Users\\gongj\\Documents', 'F:\\dsh-plugins'] });
  assert.ok(out.has('仅覆盖下面已选目录'));
  assert.ok(out.has('14.5 万'));
  assert.ok(out.has('7.3s'));
  assert.ok(out.has('C:\\Users\\gongj\\Documents'), '目录 chips 要渲染出来');
});

check('pg3-7 结果头三个字段：范围说明、来源 pill、命中数与上限', () => {
  const h = SRCH.resultHead(RES({ source: 'walk', sourceLabel: '本地遍历', rows: new Array(3).fill({}), limit: 200 }));
  assert.equal(h.sourcePill, '本地遍历');
  assert.match(h.hitText, /命中 3 项/);
  assert.match(h.hitText, /上限 200/);
  assert.match(h.sub, /限定目录/);
  const h2 = SRCH.resultHead(RES({ source: 'http', sourceLabel: 'Everything HTTP', rows: new Array(5).fill({}), limit: 50, truncated: true, total: 841_000 }));
  assert.equal(h2.sourcePill, 'Everything HTTP');
  assert.match(h2.hitText, /已截断/);
});

check('pg3-8 每条结果自带来源 pill，缺字段显示 — 而不是 0', () => {
  const rows = SRCH.rowCells(RES({ source: 'es', sourceLabel: 'es.exe', rows: [
    { name: 'client.js', dir: 'F:\\dsh-plugins\\dsh-plugin-stock-analysis', size: 214 * 1024, mtime: 1_700_000_000_000, source: 'es', path: 'F:\\a' },
    { name: 'x.txt', dir: 'F:\\', size: null, mtime: null, source: 'es', path: 'F:\\b' },
  ] }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.sourcePill), ['es.exe', 'es.exe']);
  assert.equal(rows[1].sizeText, '—', '未知大小不许显示成 0 B');
  assert.equal(rows[1].mtimeText, '—');
});

check('pg3-9 降级四类文案各不相同：未就绪 / 403 / 超时保留陈旧 / 空结果', () => {
  const e403 = PAGE({ res: RES({ error: 'HTTP_403', rows: [] }) });
  assert.ok(e403.has('工具 → 选项 → HTTP 服务器'), '403 要给可执行指引（spec §4.4）');
  const stale = PAGE({ res: RES({ stale: true, error: 'TIMEOUT', rows: [{}] }) });
  assert.ok(stale.has('陈旧'));
  assert.ok(stale.has('超时 4s 已取消'));
  const empty = PAGE({ res: RES({ rows: [], error: null }), q: 'zzz' });
  assert.ok(empty.has('空格 = 同时满足'), '空结果要教分词规则');
  const ready = PAGE({ probe: PROBE({ installed: true, http: true, e2e: true, ready: true, via: 'http', degraded: false, level: 'e2e' }), res: null });
  assert.ok(ready.has('输入关键字'), '就绪态该是搜索框而不是引导');
});

check('pg3-10 上限三档 50/200/1000，切档只改 limit 不自动重发', () => {
  assert.deepEqual(SRCH.LIMITS, [50, 200, 1000]);
  let fired = 0;
  const out = walk(SRCH.SearchPage({ probe: PROBE(), res: RES({ rows: [{}] }), mode: 'walk', limit: 200, q: 'a', dirs: [], err: null,
    onSearch() { fired += 1; }, onMode() {}, onLimit() {}, onReprobe() {}, onAddDir() {}, onDelDir() {} }));
  assert.equal(out.buttons.filter((b) => /^\d+$/.test(b.text)).length, 3);
  assert.equal(fired, 0, '渲染阶段不许触发请求');
});

check('pg3-11 空查询不发请求（searchQuery 返回 null），带查询时三键齐', () => {
  assert.equal(SRCH.searchQuery({ q: '   ', mode: 'walk', limit: 200 }), null);
  assert.deepEqual(SRCH.searchQuery({ q: 'report .pdf', mode: 'walk', limit: 50 }), { q: 'report .pdf', mode: 'walk', limit: 50 });
});

check('pg3-12 「打开位置」只定位不执行：说明文案在场，且没有"打开文件/运行"字样', () => {
  const out = PAGE({ res: RES({ rows: [{ name: 'a.txt', dir: 'F:\\', size: 1, mtime: 1, source: 'walk', path: 'F:\\a.txt' }] }) });
  assert.ok(out.has('不替你打开文件'));
  assert.ok(out.has('不执行任何程序'));
  assert.ok(!out.has('运行'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/plugin.test.mjs`
Expected: ⑥段全红（`__test.search` 未导出），①~⑤段仍 `65/65` 绿。

- [ ] **Step 3: 写实现**

- `probeCells(probe)` 的 `pill` 三态逐字：`installed → 已装 / 未探到`、`channel → HTTP 3417 / es.exe / 两条都没有`、`e2e → 试查询 {took}ms / 未执行`；`detail` 直接吃 `probe.checks[].detail`（宿主 `probe.js` 已经写好取证口径，界面不重述）。
- `modeOf(probe, wanted)`：`probe.ready !== true` 时**无条件**返回 `'walk'`，并把 `why = '通路未就绪 —— 暂不可选'` 挂到「全盘索引」按钮的 `title` 与 `disabled` 上。理由注释：允许点一个必然失败的按钮，比直接降级更糟。
- `advice()` 不带参数、内部 `cfg().searchAdvice || []`（Task 20 的懒取约定）。`pg3-3` 先往载荷里塞三条假文案再断言返回值逐条相等，同时用静态扫描钉住 client.js 不出现第二份 `voidtools.com` —— 两条合起来才封住"宿主没给载荷时界面自己编指引"。注意 `PROBE()` 夹具里那条 `advice` 是**故意留的诱饵**：`advice()` 读了 `probe.advice` 就会让 `pg3-3` 红。
- 结果表列：`名称 / 所在目录 / 大小 / 修改时间 / 操作`，`大小` 用 `fmtBytes`、`修改时间` 用 `fmtAge` 或 `new Date(mtime).toLocaleString('zh-CN', { hour12: false })`（**跟随当前 locale 由宿主 token 决定，不写死 `en-US`**）。
- `stale === true` 时整个结果卡顶部一条 `so-notice-amber`：「上次结果 · 超时 4s 已取消 · 显示为陈旧」；`truncated === true` 时在 `hitText` 末尾追加「已截断」（spec §4.4 的"命中超 limit 截断并标注"）。
- 目录 chips（walk 模式的覆盖范围）来自 `prefs.search.walkDirs`，增删调 `onAddDir/onDelDir` → `POST /sysops/api/prefs`；**没有 storageDomain 时 chips 只读 + 灰**（与 pg4-11 同一闸门）。
- 页头右侧的通路提示行（原型 `probeHint`）文案：就绪 → `当前通路：Everything HTTP :3417 · 全盘索引` / `es.exe · 全盘索引`；未就绪 → `当前通路：未就绪 → 已降级为限定目录`。端口号取 `cfg().defaults.searchPort`（Task 19 载荷），不写死 3417。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `77/77 通过`（①15 ②8 ③12 ④16 ⑤14 ⑥12）。
Run: `SKIP_LOCAL=1 node test/plugin.test.mjs`
Expected: 同样 `77/77`（本文件始终无真机用例；Everything 相关真机用例在 `test/search.test.mjs`，本机未装 → 那边 SKIP）。
提交信息草稿：`feat(sysops): 搜索页（三级自检 / 引导卡文案单源 / 每条结果带来源 pill）`

---

## Task 24: 设置页（四源开关 / 清理规则 + guard / 暂存 / 搜索通路 / 能力表）

**Files:**
- Modify: `client.js`（`SettingsPage` 实现 + `__test.settings` 出口）
- Modify: `test/plugin.test.mjs`（追加 ⑦段）

**Interfaces:**
- Consumes: `GET /api/prefs` 与 `POST /api/prefs`（patch 语义，Task 3 的 `normalize` 返回归一化全量）、`GET /api/rules` + `POST /api/rules/{add,remove,toggle}`、`GET /api/caps`（Task 19 的 `caps.rows()`）、Task 19 载荷的 `redlines` / `capabilityRows` / `cadences` / `defaults`、Task 21 的规则置灰同源数据（`snap.alerts.rules`）
- Produces（`__test.settings`）：
  - `SettingsPage({ prefs, rules, caps, capRows, snap, err, saving, onPatch, onRuleAdd, onRuleToggle, onRuleRemove, onSave })`（`capRows` 由 `SysopsPage` 把 `cfg().capabilityRows` 传下来 —— 页面不自己读全局，测试才能塞假能力表）
  - `SOURCE_ROWS(prefs, snap) → [{ key, name, tier, desc, cadText, switch: null | { on, disabled, key } }]`（恰好四行：L0 / L1a / L1b / L2；源开关读 **`prefs.sources`**，与 Task 3 的 `prefsRecord` 同级，**不在 `prefs.collect` 里**；**L0 的 `switch` 是 `null`**，档位入口只在监控页那一处）
  - `ruleCells(rules) → [{ n, glob, ageText, kind, pill, blocked, on, denyWhy }]`（`pill ∈ '内置'|'本机'`；`denyWhy` 原样透传宿主 `guardDenied.why`）
  - `ruleStateText(v) → string`（`null` / `[]` / 数组三态，见 Step 3 末条）
  - `patchBody(patch) → { prefs: patch }`（**只发差量**，服务端 normalize 后回全量）
  - `capCells(rows) → [{ label, value, cls, detail, hasSwitch }]`
  - `SAVE_DISABLED(prefs, caps, err) → { disabled, why }`

  **不设 `guardDenyText(err)`**：拒绝原因由宿主 `rules-store` 在校验时写进 `guardDenied.why` 与 403 响应体，页面只渲染服务端给的句子。客户端再映射一遍 `code → 中文`，就等于把 guard 的文案裁决权从 `lib/clean/guard.js` 挪出第二份（spec §4.5 的单点要求）。

- [ ] **Step 1: 写失败的测试（⑦段：设置页）**

```js
/* ⑦段：设置页 —— 开关、规则、能力表与只读闸门 */
SET = CLIENT.__test.settings;

/** 逐键照 Task 3 `prefsRecord`（含 Task 12 追加的 `clean` 组）：`sources` 与 `collect` **同级**。
 *  `procIntervalSec` / `procMaxRows` 不在这里 —— 它们是宿主配置（Task 19 载荷 `defaults`），不是用户偏好；
 *  界面要显示就经 `cfg().defaults` 取，塞进 prefs 夹具会让设置页读一个服务端永不返回的字段。
 *  两处夹具必须与 Task 3 / Task 14 的归一语义一致，否则设置页会被假夹具带偏：
 *  ① `quarantineDir` 只能是**展开后的绝对路径**（`prefq-1` 在 schema 层就拒 `%...%`，库里永不出现未展开形）；
 *  ② `esPath` 是 `optionalString`，空串会被归一成 `undefined`，所以 normalize 之后的夹具里是 `undefined` 而不是 `''`
 *     —— `pg4-8` 正是靠这条验输入框不渲染出字面量 `undefined`。 */
const PREFS = (over = {}) => ({ collect: { cadence: '1s', keepMinutes: 30 },
  sources: { l0: true, l1a: true, l1b: false, l2: true },
  clean: { quarantineDir: 'C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine', keepDays: 7, after: 'log' },
  search: { mode: 'everything', port: 3417, esPath: undefined, walkDirs: [], limit: 200 },
  alerts: {}, ...over });
const CAPS_OK = { storageDomain: true, timer: true, webServer: true, notifications: false, autostart: false };
const CAP_ROWS = [
  { key: 'storageDomain', label: 'storageDomain（持久化）', ok: true, detail: '', fallback: '' },
  { key: 'timer', label: 'timer（ctx.interval）', ok: true, detail: '', fallback: '' },
  { key: 'webServer', label: 'webServer（路由 + index-inject）', ok: true, detail: '', fallback: '' },
  { key: 'notifications', label: '系统通知（托盘）', ok: false, detail: '', fallback: '宿主不提供' },
  { key: 'autostart', label: '开机自启常驻', ok: false, detail: '', fallback: '宿主不提供' },
];
const PAGE = (over = {}) => walk(SET.SettingsPage({ prefs: PREFS(), rules: [], caps: CAPS_OK, capRows: CAP_ROWS, snap: null, err: null, saving: false,
  onPatch() {}, onRuleAdd() {}, onRuleToggle() {}, onRuleRemove() {}, onSave() {}, ...over }));

check('pg4-1 四源行齐（L0/L1a/L1b/L2），每行带层级 pill 与代价说明', () => {
  const rows = SET.SOURCE_ROWS(PREFS(), null);
  assert.deepEqual(rows.map((r) => r.key), ['l0', 'l1a', 'l1b', 'l2']);
  assert.ok(rows[0].tier.includes('L0') && rows[1].tier.includes('L1a') && rows[2].tier.includes('L1b') && rows[3].tier.includes('L2'));
  assert.ok(rows[0].desc.includes('不起任何子进程'));
  assert.ok(rows[1].desc.includes('暖身') && rows[1].desc.includes('219ms'));
  assert.ok(rows[2].desc.includes('640ms'));
});

check('pg4-2 L0 没有开关（档位由监控页控），L1b 默认关', () => {
  const rows = SET.SOURCE_ROWS(PREFS(), null);
  assert.equal(rows[0].switch, null, 'L0 的开关是档位 seg，不在这里重复一个入口');
  assert.equal(rows[2].switch.on, false, '实测代价决定默认关（spec §1.1 决策 7）');
  assert.equal(rows[1].switch.on, true);
});

check('pg4-3 关掉某一源 → 依赖它的规则在设置页也标不可用（与监控页同一个 st）', () => {
  const snap = { alerts: { rules: [{ rule: { id: 'r4', n: '下行持续 > 20 MB/s 满 1 分钟', dep: 'l1a' }, st: { dim: true, on: false, st: '依赖的采集已关闭' } }] } };
  const out = PAGE({ snap });
  assert.ok(out.has('依赖的采集已关闭'));
  assert.ok(out.has('关掉某一源，依赖它的告警规则会就地标为不可用'));
});

check('pg4-4 规则行 pill 分内置/本机，guard 拒绝项标「已被 guard 拒绝」且开关禁用', () => {
  const rules = [
    { id: 'temp-user', n: 'AI 助手临时目录 scoped_dir*', glob: '%TEMP%\\scoped_dir*', ageDays: 0, kind: '临时目录', builtin: true, enabled: true },
    { id: 'u-pnpm', n: 'pnpm 未引用包', glob: '%LocalAppData%\\pnpm-store\\**', ageDays: 30, kind: '缓存', builtin: false, enabled: true },
    { id: 'u-bin', n: '回收站', glob: 'C:\\$Recycle.Bin\\*', ageDays: 1, kind: '缓存', builtin: false, enabled: false, guardDenied: { code: 'b-recycle-bin', why: '回收站一律不参与' } },
  ];
  const cells = SET.ruleCells(rules);
  assert.deepEqual(cells.map((c) => c.pill), ['内置', '本机', '本机']);
  assert.equal(cells[2].blocked, true);
  assert.ok(cells[2].denyWhy.includes('回收站一律不参与'));
  const out = PAGE({ rules });
  assert.ok(out.has('已被 guard 拒绝'));
  assert.ok(out.classHas('so-rule-dim'));
});

check('pg4-5 黑名单 notice 逐字吃注入载荷的 redlines（单源，不抄第二份）', () => {
  globalThis.__SYSOPS__.redlines = ['不碰回收站（2026-09-13 曾因按普通目录处理导致属主与 ACL 被改坏）', '不碰 C:\\Windows\\*', '不碰 Program Files', '不动注册表'];
  const out = PAGE({});
  for (const line of globalThis.__SYSOPS__.redlines) assert.ok(out.has(line.slice(0, 8)), `缺红线 ${line}`);
  assert.ok(out.has('不可移除的黑名单'));
  const code = stripComments(fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8'));
  assert.ok(!code.includes('takeown'), 'client.js 不该自带第二份红线文案（含事故日期那种长句）');
  delete globalThis.__SYSOPS__.redlines;
});

check('pg4-6 新增规则的拒绝文案就地落，不弹浮层', () => {
  const out = PAGE({ err: { source: 'rules/add', status: 403, code: 'SYSOPS_RULE_GUARD_DENY', message: '已拒绝写入：该 glob 命中红线（系统目录 / 回收站）。guard 在校验阶段就拦下，不会进入规则库。' } });
  assert.ok(out.has('已拒绝写入'));
  assert.ok(out.classHas('so-notice-red'));
  assert.ok(out.buttons.filter((b) => b.text.includes('保存并启用')).length === 1, '新增按钮只有一个');
});

check('pg4-7 暂存目录渲染 prefs 实配值 + 到期提醒不自动删 + after 两档', () => {
  const out = PAGE({});
  assert.ok(out.has('C:\\Users\\gongj\\AppData\\Local\\dsh-plugin-sysops\\quarantine'), '显示 prefs 的实配值（prefs 里只会是展开后的绝对路径，`prefq-1` 已拒未展开形）');
  assert.ok(!out.has('%LOCALAPPDATA%'), '界面不得把 `%...%` 当可配置值展示：prefs schema 里它不可能存在');
  assert.ok(out.has('到期提醒，不自动删'));
  assert.ok(out.has('什么都不做') && out.has('写一条留痕并刷新曲线'));
});

check('pg4-8 搜索通路两字段 + 降级说明（不静默换源）', () => {
  const out = PAGE({});
  assert.ok(out.has('HTTP 端口'));
  assert.ok(out.has('es.exe 路径'));
  assert.ok(out.has('不静默换源'));
  assert.ok(out.has('拿旧结果冒充') === false || out.has('不拿旧结果冒充'));
});

check('pg4-9 能力表五行齐，「宿主不提供」的两行没有开关', () => {
  const cells = SET.capCells(CAP_ROWS);
  assert.equal(cells.length, 5);
  assert.deepEqual(cells.map((c) => c.hasSwitch), [false, false, false, false, false], '能力表只报事实，给开关就是假开关');
  assert.ok(cells[3].value === '宿主不提供' && cells[4].value === '宿主不提供');
  assert.ok(cells[0].value === '提供');
});

check('pg4-10 timer 降级那行必须把"退到 setInterval 且必须显式 stop"说出来', () => {
  const rows = CAP_ROWS.map((r) => (r.key === 'timer' ? { ...r, ok: false, detail: '宿主无 ctx.interval，已退到 setInterval', fallback: '已降级' } : r));
  const cells = SET.capCells(rows);
  assert.match(cells[1].value, /已降级/);
  assert.match(cells[1].detail, /setInterval/);
});

check('pg4-11 无 storageDomain：保存按钮禁用 + 原因，且 501 的 code 翻成中文而不是抛', () => {
  const s = SET.SAVE_DISABLED(PREFS(), { ...CAPS_OK, storageDomain: false }, null);
  assert.equal(s.disabled, true);
  assert.match(s.why, /配置只读|未提供 storageDomain/);
  const out = PAGE({ caps: { ...CAPS_OK, storageDomain: false }, err: { source: 'prefs', status: 501, code: 'PREFS_UNAVAILABLE', message: '没有 storageDomain' } });
  const b = out.buttons.find((x) => x.text.includes('保存设置'));
  assert.equal(b.disabled, true);
  assert.ok(out.has('501') || out.has('只读'));
});

check('pg4-12 保存只发差量：patchBody 包一层 prefs，不整包回传', () => {
  assert.deepEqual(SET.patchBody({ collect: { cadence: '5s' } }), { prefs: { collect: { cadence: '5s' } } });
  assert.ok(!('clean' in JSON.parse(JSON.stringify(SET.patchBody({ collect: { cadence: '5s' } }))).prefs));
});

check('pg4-13 规则三态区分 null（从未写入）与 []（用户清空）', () => {
  assert.match(SET.ruleStateText(null), /尚未配置|未写入/);
  assert.match(SET.ruleStateText([]), /已全部清空/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test/plugin.test.mjs`
Expected: ⑦段全红（`__test.settings` 未导出），①~⑥段仍 `77/77` 绿。

- [ ] **Step 3: 写实现**

- `SOURCE_ROWS(prefs, snap)` 的四行文案（`desc`）逐字取原型的 `collectRules` 三行 + 新增 L2 行：L0 `纯 Node os + fs.statfsSync，不起任何子进程；采样档位由监控页顶部「1s / 5s / 暂停」控制`、L1a `单进程流式读 stdout，暖身 219ms 之后开销可忽略`（219ms 是 Task 6 实测值，写成常量并注明"来自 §1.2 实测，改值须同步 spec"）、L1b `单次 640ms，持续开启代价明显；建议只在需要时开`、L2 `扫描/搜索请求驱动，不常驻；遍历实测 14.5 万条目 / 7.3s，必须带进度与可停止`。
- **L1b 的刷新间隔显示 `cfg().defaults.procIntervalSec` 秒一次**，不是原型的「10 秒」—— 计划期实测修正 #3 定为 3s，Task 8 已按 3s 实现；界面若还写 10s 就是与实现矛盾的假数字（`pg4-1`/Task 25 一起盯）。
- 规则区的 `guardDenied` 由宿主 `rules-store` 写入时附（Task 11），页面只是渲染；`blocked` 行的开关 `disabled` 且点击后回 `false`（与原型 `renderCleanRules` 同行为）。
- `SAVE_DISABLED` 的三个来源要按优先级：`caps.storageDomain === false` → 「配置只读：宿主未提供 storageDomain」；`err.code === 'PREFS_UNAVAILABLE'` → 「上一次保存失败（501），原因同上」；`saving === true` → 「保存中…」。禁用了就一定有 `why` 显示在旁边，**不允许只变灰**。
- `capCells(rows)` 直接吃 `cfg().capabilityRows`（= Task 19 `caps.rows()`）；`ok === true` → `提供`（绿 pill），`ok === false && NEVER_PROVIDED` → `宿主不提供`（灰 pill），其余 `ok === false` → `fallback` 文案 + 「已降级」（琥珀 pill）。**能力表五行一律不给开关**（`pg4-9`）。
- `ruleStateText(v)`：`null` → 「本机尚未写入清理规则，当前只用内置库」；`[]` → 「本机规则已全部清空」；数组 → 「本机规则 N 条」。三态分开是 spec §3.2 的硬要求（`null` ≠ `[]`）。
- 表单控件全部自研：档位/after 用 `.so-seg`，数值输入用 `<input class="so-input">` + 提交时 `clamp`（钳制范围与 Task 19 的 `resolveConfig`、Task 3 的 schema 区间一致，**界面钳一次是为了不出现"填 9999 保存成功但实际跑 120"的错觉**，宿主仍要再钳一次）。`pg4-*` 不测交互（桩 React 不持久化状态），钳制的真断言在 `test/prefs.test.mjs`（Task 3）。
- 搜索通路两字段（`pg4-8`）的**取值来源分两层，别混**：当前生效值读 `prefs.search.port` / `prefs.search.esPath`（用户设过的，Task 3 已把这两键收进 schema），占位与回落读 `cfg().defaults.searchPort`（Task 19 载荷）。保存走 `patchBody({ search: { port, esPath } })`。
- **`esPath` 输入框的 value 必须写 `prefs.search.esPath ?? ''`**：`optionalString` 把空串归一成 `undefined`（"不留空壳字段"），服务端 normalize 后这个键很可能是 `undefined` 而不是 `''`；直接塞进受控 input 会渲染出字面量 `undefined`，用户清空一次路径就变成了字符串 `"undefined"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node test/plugin.test.mjs`
Expected: `90/90 通过`（①15 ②8 ③12 ④16 ⑤14 ⑥12 ⑦13）。
Run: `SKIP_LOCAL=1 node test/plugin.test.mjs`
Expected: 同样 `90/90`。
提交信息草稿：`feat(sysops): 设置页（四源开关 / 规则与 guard 拒绝 / 能力表五行 / 只读闸门）`

---

## Task 25: 验收门禁五条 + 回写 spec

**Files:**
- Read（只核对不改动）: `test/*.test.mjs` 全部 8 个、`lib/clean/guard.js` 的 `BRANCH_IDS`
- Modify: `docs/superpowers/specs/2026-09-27-dsh-plugin-sysops-design.md`（§1.2 实测值、§3.2 写接口方法、§3.4 搜索端点、§8 未决项收口）
- Create: `tmp/preview.html`（离线预览页，只为门禁 ③④ 取证；`tmp/` 是兄弟插件的既有惯例，不进 `package.json` 也不被 `exports` 暴露）
- Create: `tmp/react.js`、`tmp/react-dom.js`（从 `../dsh-plugin-stock-analysis/tmp/` 复制，MIT 许可，仅离线预览用）

**Interfaces:**
- Consumes: 全部前 24 个任务的产物
- Produces: 无新代码接口 —— 本任务只产**证据**（测试输出、分支清单核对、console 计数、三档截图、实测复跑偏差表）与 spec 回写

- [ ] **Step 1: 门禁 ① —— 全部测试 0 fail，逐项打印 PASS 计数**

Run（依次，逐条留输出）：
```
node test/guard.test.mjs
node test/prefs.test.mjs
node test/collect.test.mjs
node test/alerts.test.mjs
node test/clean.test.mjs
node test/search.test.mjs
node test/plugin.test.mjs
node test/host-compat.test.mjs
SKIP_LOCAL=1 node test/clean.test.mjs
SKIP_LOCAL=1 node test/search.test.mjs
```
Expected：
- `plugin.test.mjs` `90/90`（①15 rt ②8 hx ③12 cf ④16 pg1 ⑤14 pg2 ⑥12 pg3 ⑦13 pg4）
- `host-compat.test.mjs` `8/8`（hc-1..hc-8）
- `collect.test.mjs` `48/48`、`alerts.test.mjs` `33/33`、`clean.test.mjs` `56/56`（含 1 条真机 —— ①=14 是 Task 12 两轮修复后的基数：`cln-5b`/`cln-9c`/`cln-7c`；原稿的 46/46 作废）、`search.test.mjs` `26/26`、`prefs.test.mjs` `24/24`（①3 ②4 ③6 ④11）、`guard.test.mjs` `19/19`（另需打印「拒绝断言 61 条 / 分支命中 16/16」，见 Step 2）
- `SKIP_LOCAL=1` 两行：`clean` → `55/55 + 1 SKIP`，`search` → Everything 相关真机用例 SKIP、walk 通路仍实跑
- **任何一条 FAIL 都不算过**；出现"用例静默通过"（断言对象为空数组的 `.some()`）要按 Step 3 的变异法回查。

- [ ] **Step 2: 门禁 ② —— guard 分支清单 100% 打勾（核对，不新写代码）**

Task 2 的 `guard-18` / `guard-19` 已经把两条口径变成断言了，本步只负责**取证**：

Run: `node test/guard.test.mjs`
Expected 末两行：
```
  红线矩阵：拒绝断言 61 条 / 分支命中 16/16
  19/19 通过
```
`19/19` 里的 `guard-18` 读的是 `seenBranches` 台账（用例里每条 `deny()` / `denyOp()` 命中一条分支就 +1），`guard-19` 读 `denyAssertions`（spec §5 的「≥40 例」按拒绝断言计，不按 `check()` 用例名计）。**这两条挂了只能补用例，不许改 `BRANCH_IDS` 或把 40 调小** —— 台账与清单不同步本身就是红线漂移的信号。

把这一行原样贴进汇报，作为门禁②的证据；它就是本仓库"覆盖率"的替代品（spec §5：自研 harness 与 `node --test --experimental-test-coverage` 不兼容，引工具即破坏零依赖）。

- [ ] **Step 3: 变异抽查（证明断言真的在管事，而不是恒真）**

对最容易退化成空断言的四条各做一次变异，跑完立刻改回：
1. `client.js` 的 `fmtRate` 改成 `v / 8e6` → `pg1-1`/`pg1-2` 必须 FAIL
2. `clean/guard.js` 的 `PROTECTED` 去掉 `b-recycle-bin` 整条规则 → `test/guard.test.mjs` 的 `guard-02` FAIL（4 条 deny 全红），台账里 `b-recycle-bin` 掉到 0 → `guard-18` 同步 FAIL；拒绝断言 61 → 57 仍 ≥40，所以 `guard-19` 该继续绿 —— 它管的是量，`guard-18` 管的才是覆盖面（执行时以实测差值为准，别照抄 57）
3. `lib/api.js` 的回环闸门 `return true` → `rt-12` 必须 FAIL
4. `client.js` 的 `apply` 首行去掉 `if (!cfg().routePrefix) return;` → `cf-3` 必须 FAIL

Expected: 四次变异**都**产生 FAIL；任何一次全绿说明对应用例是假断言，要重写而不是继续。

- [ ] **Step 4: 门禁 ③ —— 四页签实测 0 console error**

`tmp/preview.html` 的构造（形状照 `../dsh-plugin-stock-analysis/tmp/dom.html`）：
1. `<style>` 内联宿主 token 的 `:root` 变量（从 `prototype/index.html` 的 `:root` 逐条搬，`--dsw-alias-*` 全套）；
2. `<script src="./react.js">`、`<script src="./react-dom.js">`；
3. 一段桩：`globalThis.__SYSOPS__ = { ... }` —— **键集合照 `test/render-fixtures.mjs` 的 `clientPayload()` 逐键抄**（这里不能 import 那个 `.mjs`，浏览器半边是普通 `<script>`），值把两份演示用文案补上：`redlines` 四条、`searchAdvice` 三条、`capabilityRows` 五行。`routePrefix` 必须是 `/sysops`，给空会让 Task 20 的 `apply` 首行直接 return，预览页一片空白。
4. `globalThis.window.__ModuleLoader__ = { load: (d) => { const C = d.factory((n) => n === 'react' ? globalThis.React : (()=>{throw new Error(n)})()); window.__C = C; } }`；
5. `<script src="../client.js">`，随后 `C.apply(ctx)`，`ctx` 是最小宿主桩：`{ effect: (f) => f(), slots: { inject: (n, cb) => cb(), register: (o, Comp) => { document.getElementById('root').replaceChildren(ReactDOM.createElement(Comp, {})); return () => {}; } } }`；
6. 桩 `globalThis.fetch`：`/sysops/api/stream` 返回一个每 900ms 推一帧 `metrics` 的 `ReadableStream`，`snapshot/prefs/rules/search/search/probe/clean/state/clean/logs/quarantine` 返回内置 fixture JSON（数值用 Task 8/15/16/17 测试里的同一份夹具，**不要另编一套**）。

Run: `python -m http.server 4322 --bind 127.0.0.1`（后台，目录 `dsh-plugin-sysops`），再用 Playwright 依次点四个页签。

Expected: `browser_console_messages` 全程 `0 error`、`0 warning`（`Warning: Each child in a list should have a unique "key"` 也算不过）；四个页签各自的截图与 DOM 快照留档。

- [ ] **Step 5: 门禁 ④ —— 三档断点截图核对**

同一预览页，`browser_resize` 到 `1080×800`、`860×800`、`620×900` 三档，每档四个页签各截一张（共 12 张），核对：
- 指标条 4 → 2×2 → 1 列；曲线卡同样塌缩；
- `860` 档起侧边栏（宿主那 56px 收窄是宿主行为，预览页用原型侧栏模拟）不挤压主区；
- `620` 档清单表**横向滚动而不是压扁**（原型 `.tbl-wrap{overflow:auto}`），暂存目录/路径列不换行；
- 无元素溢出视口：`document.documentElement.scrollWidth <= innerWidth + 1` 在 12 张图对应的 12 次 `evaluate` 里全部成立。

Expected: 12 张图人工核对通过 + 溢出断言 12/12 成立。截图落在 `tmp/`（自己的临时取证，可清理）。

- [ ] **Step 6: 门禁 ⑤ —— 复跑 §1.2 六条实测，偏差 >20% 就更新 spec 而不是继续引用旧值**

Run: `node scripts/probe-collect.mjs --json`（Task 6 建的本机实测探针；它会复跑 `os.cpus()`×100、`fs.statfsSync('C:')`、typeperf 定窗续采一窗、L1b 单轮与常驻一轮、`Get-CimInstance` 单次、`AppData\Local` 遍历）

Expected：输出六行 `{ name, value, unit, specValue, driftPct }`，脚本内建判定：`|driftPct| > 20` 时以退出码 1 结束并打印需要改的 spec 行号。
- 磁盘总/可用容量本就随使用变化，探针按「容量行只报事实、不参与 20% 判定」处理（脚本里 `volume: true` 跳过 drift 判定），其余五条严格判。
- 全绿才可结束本步骤；有任何一条超差，**改 spec §1.2 的数字并附测量日期**，同时检查依赖它的默认值（L1b 3s 间隔、`keepMinutes:30`）是否要跟着改。

- [ ] **Step 7: 回写 spec（四处，逐条）**

1. **§1.2 实测代价表**：`typeperf -sc 3（常驻流式）` 一行改为定窗续采实况 ——「`-sc 0` 单样本即退出，改为每窗 `-sc 30 -si 1` 续采；暖身 218.9ms，窗口衔接处有约 1 个采样周期空隙」；新增一行「`Get-Counter -ComputerName .` 输出为 GBK 码页 → 解码代价已计入适配器，中文计数器名不再乱码」；`Get-CimInstance` 行的结论从「5s 刷新」改为「常驻单轮 ≈2.5s，故 `procIntervalSec` 默认 3s」。
2. **§3.2 配置读写**：`PATCH /sysops/api/prefs`、`PATCH /sysops/api/rules` 两处方法名改为 `POST /sysops/api/prefs`、`POST /sysops/api/rules/add|toggle|remove`，并补一句理由：「宿主 webServer 只在 POST 下稳定给出 body，写接口统一 POST，GET 只读」（这是计划期实测修正，不是设计变更）。
3. **§3.4 搜索**：`GET /sysops/api/search?q&mode&limit` 保留，补 `POST /sysops/api/search/reprobe`（缓存 30s，改配置后需显式失效）；并加一行状态说明：「本机未装 Everything（`C:\Program Files\Everything` 不存在、`where es.exe` 无命中、`curl 127.0.0.1:3417` 拒连），故两个 Everything 适配器标『未在本机验证』，`walk` 是当前唯一实跑通路」。
4. **§8 未决项表**：三行全部收口 —— 内置清理规则「已定：只收本机实测存在的路径，共 12 条（2026-09-27 复核把 `WER` 剔了，见 Task 11 Step 3 的现采块）」；暂存目录「已定：默认落点 `%LOCALAPPDATA%\dsh-plugin-sysops\quarantine`（由宿主展开成绝对路径后放进 Task 19 载荷 `defaults`；prefs 只存展开后的绝对路径，`prefq-1` 拒未展开形），界面渲染 prefs 实配值、无实配时回落 `defaults`，原型里的 `C:\Users\gongj\.dsh-quarantine\2026-09-27\` 是演示串」；曲线保留窗口「已定：30min，ring 内存实测 4 源 × 1800 点 < 1MB」；末行 spec 位置「保留在 `docs/superpowers/specs/`，不与兄弟插件的 `docs/design-spec.md` 统一」。

- [ ] **Step 8: 收尾（本工作区不是 git 仓库）**

`F:\dsh-plugins` 下 `git rev-parse` 返回 `fatal: not a git repository`（2026-09-27 实测），因此**不执行 commit**。交付物为：
- 全部源码与测试（Step 1 的输出留档）
- 按任务汇总的提交信息草稿（Task 1~24 各一条，已在各任务 Step 末尾写好），汇总贴给用户以便其 `git init` 后按序提交
- 本任务的四类证据：测试 PASS 计数、guard 分支清单核对、四页签 console 计数、三档断点 12 张截图 + §1.2 复跑偏差表

清理：`tmp/preview.html` 与三张档截图属本任务的取证临时物，用户确认后可删；`tmp/react.js` / `tmp/react-dom.js` 若用户要长期保留离线预览能力则留下，否则一并删。**未经确认不删任何东西。**

