# dsh-plugin-sysops 设计说明

- 日期：2026-09-27
- 状态：第 1～5 节已逐节确认；可点原型已确认（`prototype/index.html`）
- 参照实现：`dsh-plugin-stock-analysis`（代码组织、宿主能力面、视觉与交互规范全部继承）

---

## 0. 一句话

装在 dsh 里的本机系统面板：实时监控 + 两段式 C 盘清理 + 全盘文件搜索，安装后出现在左侧栏，风格与代码设计对齐股票分析插件。

---

## 1. 范围与已锁决策

### 1.1 决策表

| # | 议题 | 选定 | 理由 | 被否掉的方案 |
|---|---|---|---|---|
| 1 | 配置形态 | 通用内核 + 本机配置文件 | 缓存位置因机器/已装应用而异，写死在代码里必然对不上本机 | 内置固定清理表、不可扩展 |
| 2 | 清理交互 | 两段式：扫描 → 冻结清单 → 勾选 → 执行 | 不可逆动作必须让用户看到"具体删哪些"再确认 | 一键直接清（看不到对象） |
| 3 | 文件搜索 | Everything 主源 + 三级探测，探不到降级为限定目录遍历 | 纯 Node 遍历实测 145,369 条目 / 7,335ms，且只覆盖一个目录，全盘不可行 | 自建索引常驻、纯遍历全盘 |
| 4 | 搜索引导 | 探测失败给安装指引（winget 命令 / 官网），**不代装** | 装第三方软件属用户决策，插件只检测与引导 | 静默下载安装 |
| 5 | 监控内容 | 指标曲线 + 进程榜 + 阈值告警 + 触发时间线 | 覆盖"看一眼本机"的真实诉求 | 系统通知中心、结束进程（见 1.3） |
| 6 | 采集架构 | A 分层采集（L0 / L1a / L1b / L2） | 各源代价差两个数量级，统一节奏必出性能问题 | 单一常驻 PowerShell 全包 |
| 7 | 常驻子进程 | 设置页可开可关，默认值全部由实测代价决定 | 用户要能收回资源；默认值不能拍脑袋 | 全部常开、或全部手动才开 |
| 8 | 告警落点 | 插件内时间线 + 侧边栏蓝点 | 宿主不提供系统通知（实测能力面） | 托盘通知开关（会变成永远不响的假开关） |

### 1.2 实测代价（决策依据，验收时须复跑）

**2026-09-28 复跑**（命令 `node scripts/probe-collect.mjs`）。带 ★ 的三行相对计划期值偏差 >20%，已按本次实测改写；容量行只报事实、不参与 20% 判定。

| 动作 | 实测 | 结论 |
|---|---|---|
| `os.cpus()` × 100 | 61ms（单次 0.61ms，逻辑核 16） | L0 以 1s 采样无感，纯 Node，不起子进程 |
| `fs.statfsSync('C:')` | 0.0ms（总 200.0G / 可用 70.5G —— 容量随使用变化，只报事实） | 磁盘容量并入 L0 |
| 网络吞吐冷启动 | `typeperf -sc 1` 1366ms（计划期试的是 `Get-Counter`，1495ms；实现选定 typeperf） | 禁止每次新建进程 |
| ★ `typeperf` 常驻流式 | `-sc 0` 在无控制台管道下出一个样本就退出、不提供无限流式 ⇒ 改为**定窗续采**（每窗 `-sc 30 -si 1`）；`-sc 3` 整窗 3402ms，减掉 3×1s 采样 ⇒ 暖身 ≈402ms/窗（计划期记 218.9ms），摊到 30 样本窗 1.3%；窗口衔接处有约 1 个采样周期空隙 | 网速走 L1a 常驻 |
| `typeperf` 输出编码 | stdout 是 OEM 代码页（中文机器名为 GBK 字节，实测首行 `"(PDH-CSV 4.0)","\\龚进的华为笔记\Network Interface(...)"`）⇒ 解码代价已计入适配器（`decodePd` 用 `TextDecoder('gbk')`，无 ICU 环境留兜底），中文计数器名不再乱码 | 解析层只取实例名与计数器名 |
| ★ `Get-CimInstance Win32_Process` | 冷启动单轮 1475ms（计划期记 640ms）；L1b 常驻循环按 `INTERVAL_SEC = 3` 跑 | 进程榜 L1b 默认关 + 可见性驱动；循环周期 `procIntervalSec` 默认 3s（钳 2~60） |
| ★ Node 遍历 `AppData\Local` | 85,122 条目 / 4,532ms（本次探针根为 `%LOCALAPPDATA%\Temp`，与计划期不同根 ⇒ 条目数不可直接比；**吞吐** 18.8 条/ms 对计划期 19.8 条/ms，差 −5%） | 清理扫描属 L2 请求驱动，必须带进度与可停止 |

> 复跑口径：`scripts/probe-collect.mjs` 是**只报事实**的脚本（不做 20% 判定、不认 `--json`、恒 exit 0），偏差比对靠人工做 —— 上表即 2026-09-28 那次人工比对的产物。

### 1.3 明确不做（红线）

- 不结束 / 不杀任何进程（进程榜只读，理由写进卡片）
- 不改属主、不改 ACL、不碰回收站（`C:\$Recycle.Bin`）
- 不碰 `C:\Windows\*`、`Program Files*`
- 不写注册表（探测只读）
- 不做开机自启常驻（宿主不提供该能力）
- 不代装第三方软件（Everything 只给命令与官网，由用户自己执行）
- 不做顶部浮层提示条（继承股票插件 design-spec §4）

以上收口在 `lib/clean/guard.js` 单点，见 §4.5。

---

## 2. 架构与模块划分

### 2.1 两半插件（继承股票插件）

| 半边 | 文件 | 约束 |
|---|---|---|
| 宿主半边 | `index.js` | **零** `@deepseek-ai/*` import（`link:` 挂载会解析出第二份模块实例）；能力按需探测，不硬 inject（`export const inject = []`） |
| 浏览器半边 | `client.js` | `window.__ModuleLoader__.load({...})` + `require('react')`；零构建；CSS 以字符串注入 |

挂载与注册（与股票插件同形）：

```js
// 宿主半边
export const name = 'sysops';
export const inject = [];
export function apply(ctx, config = {}) { /* 探测 + 建服务 + 注路由 */ }

ctx.inject(['storageDomain'], (c) => { storageFacility = c.storageDomain; });
ctx.inject(['timer'], (c) => { if (typeof c.interval === 'function') intervalFn = c.interval; });
ctx.inject(['webServer'], (c) => c.webServer.register({ kind: 'prefix', path: '/sysops', handler }));
ctx.on('webserver/index-inject', (table) => table.push({ kind: 'global', name: '__sysops__', value: { /* 路由前缀等给浏览器半边 */ } }));
ctx.effect(() => () => { /* 关 domain 句柄 + stop 所有常驻子进程 + stop 定时器 */ }, 'sysops:lifecycle');

// 浏览器半边
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order, label }, Icon));
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, SysopsPage));
```

安装物：`cordis.yml` = `- insert: [{id: sysops, name: dsh-plugin-sysops}]`；`package.json` 零第三方依赖，`exports` 暴露 `.` 与 `./client`。

### 2.2 目录树（沿用 `lib/<域>/{spec,store,service}` 约定）

```
dsh-plugin-sysops/
├── index.js  client.js  cordis.yml  package.json
├── lib/
│   ├── kv-schema.js          自造 schema（宿主只调 parse/safeParse，零 instanceof 检查）
│   ├── caps.js               宿主能力探测，结果缓存并对外可查
│   ├── api.js                createApiHandler：前缀内路由表 + openSse
│   ├── collect/
│   │   ├── ring.js           按源分带的环形缓冲（30min，乱序点丢弃并计数）
│   │   ├── l0-node.js        os.cpus/os.totalmem/fs.statfsSync，不起子进程
│   │   ├── l1a-typeperf.js   常驻 typeperf，流式解析 stdout
│   │   ├── l1b-powershell.js 常驻 PowerShell，进程榜
│   │   ├── supervisor.js     子进程注册表 / 退避重启 / 心跳 / kill
│   │   └── service.js        分层编排 + 可见性驱动 + 采样档位
│   ├── alerts/
│   │   ├── rules.js          阈值判定纯函数（连续 N 次、冷却、依赖置灰）
│   │   ├── spec.js store.js  alert-hit 记录（200 条环形裁剪）
│   │   └── service.js        评估编排 + SSE 推送
│   ├── clean/
│   │   ├── guard.js          红线单点：系统目录 / 回收站 / 属主 ACL / 注册表
│   │   ├── rules.js          内置规则库（只读常量，含 glob 与年龄阈值）
│   │   ├── scanner.js        遍历 + 进度 + 可停止
│   │   ├── plan-store.js     记录 clean-plan：清单快照冻结与查询
│   │   ├── executor.js       两段式执行 + 逐条结果
│   │   ├── log-store.js      记录 clean-log：执行留痕（成功/跳过/失败三档）
│   │   ├── quarantine.js     暂存目录（move，EXDEV 回退 copy+delete）
│   │   └── service.js
│   ├── search/
│   │   ├── probe.js          三级探测（已装 / 有通路 / 端到端）
│   │   ├── everything-http.js  HTTP :3417 适配器
│   │   ├── es-exe.js         es.exe 适配器
│   │   ├── walk.js           限定目录遍历适配器
│   │   └── service.js        通路选择 + 结果归一化
│   └── prefs/
│       ├── spec.js store.js  记录 prefs：采集档位、源开关、阈值、限定目录
│       └── rules-store.js    记录 clean-rules：本机清理规则
├── docs/                     本设计说明 + 能力面实测记录
├── prototype/index.html      已确认的可点原型
└── test/                     见 §5
```

### 2.3 单元契约（每个单元答三问）

| 单元 | 做什么 | 怎么被使用 | 依赖谁 |
|---|---|---|---|
| `collect/ring.js` | 定长/定时环形缓冲 | `ring.push({t,v})` / `ring.series(from,to)` | 无（纯函数级） |
| `collect/supervisor.js` | 起 / 停 / 重启 / 报状态 | `sup.start(key, opts)` → 状态机变更事件 | Node `child_process` |
| `alerts/rules.js` | 判"该不该报" | `evaluate(rule, series, now, last) → hit\|null` | 无 IO，可单测 |
| `clean/guard.js` | 判"能不能删" | `check(pathOrGlob) → {allow, code, why}` | 无 IO，唯一裁决点 |
| `clean/plan-store.js` | 冻结清单快照 | `save(plan) → planId` / `get(planId)` | storageDomain |
| `clean/executor.js` | 按快照执行 | `apply(planId, itemIds, mode)` | guard、plan-store、fs |
| `search/service.js` | 选通路并归一化 | `search({q,mode,limit}) → rows[]` | probe + 三适配器 |
| `api.js` | HTTP/SSE 门面 | 前缀 `/sysops/api/*` | 上述所有 service、caps |

---

## 3. 数据流

### 3.1 采集 → 缓冲 → 分发

L0 / L1a / L1b 各写一条带，共用 `collect/ring.js`。出口两条：

| 通路 | 端点 | 载荷 |
|---|---|---|
| SSE 推（主） | `GET /sysops/api/stream` | 每 tick 一帧 `metrics`（只推增量点）+ `sources` 状态 + `alert` |
| 一次性拉（兜底） | `GET /sysops/api/snapshot` | 当前值 + 最近 1800 点（= 30min × 1s），用于首屏、暂停后恢复、断线重连补历史 |

选 SSE 为主的两条理由：① 1s × 4 曲线若走轮询，浏览器每秒要吞一份含 1800 点历史的 JSON；② SSE 断开是**服务端可感知**的，正好用来驱动 L1b 停采（连接活着 + 页面可见才采）。SSE 建不起来（反代缓冲等）退回 2s 轮询，并在采集源条如实标「降级：轮询 2s」。

前端不能用 `EventSource`（只支持 GET 且不便带控制帧），沿用股票插件的 `fetch + ReadableStream` 手工解帧。

### 3.2 配置读写

- 五条独立记录，各自带 `v:1` schema 版本：`prefs`（采集档位、各源开关、告警阈值、搜索限定目录）、`clean-rules`（本机清理规则，内置规则不入库）、`clean-plan`（清单快照）、`clean-log`（执行留痕）、`alert-hit`（触发记录）。权威副本在宿主 `storageDomain`，浏览器只是镜像。
- `null` = 从未写入；`[]` = 用户主动清空。两者在 spec 与 UI 上分开呈现。
- 写路径两条：`POST /sysops/api/prefs`（档位、开关、阈值、限定目录）与 `POST /sysops/api/rules/add|remove|toggle`（本机清理规则，**校验阶段就过 guard**，命中红线直接拒绝写入而不是执行期才失败）。两者共用同一套 schema 校验，落库后**返回归一化全量**；前端以返回值重渲染，不回显输入框内容。
- **写接口统一 POST**（计划期实测修正，不是设计变更）：宿主 `webServer` 只在 POST 下稳定给出 body，`PATCH` 拿不到载荷 ⇒ `GET` 只读、写一律 POST。
- **`POST /sysops/api/prefs` 收的是整条 `prefs` 记录**：宿主 `writeMany` 按 key 整行 `put`（未知/空键跳过），所以**差量改也必须读-并-写**，否则会把同一记录里的兄弟分组（`clean` / `sources` / `search` / `alerts`）一起抹掉。

### 3.3 清理（两段式）

```
POST /sysops/api/clean/scan
  → { jobId }
  → SSE: clean:progress { dir, walked, hit, bytes }
  → 完成帧 { planId, items[], totals }
     planId 冻结：清单 + 命中规则 + 执行方式 + 扫描前后 C 盘可用容量

POST /sysops/api/clean/apply  { planId, itemIds, mode }      ← 只收 ID，不收路径
  → 服务端按快照逐项 re-stat；命中任一条件即该项 rejected-snapshot（不删）：
       目录已不存在 / 总大小与快照偏差 > 10% / 快照时间之后有新增或修改的条目
  → SSE: clean:item { id, state: ok|skipped|rejected|failed, errnoText }
  → 汇总帧 + 写 clean-log（成功 N / 跳过 M / 失败 K 三档计数）
```

硬约束：**路径永远来自宿主侧快照，前端传来的任何路径都不采信**。因此"清单上看到 A、实际删的是 B"在结构上不可能，控制台伪造请求同样无效。代价（已确认接受）：改勾选必须先扫描，不能边改边删。

### 3.4 搜索

`GET /sysops/api/search?q&mode&limit` → 按 probe 结论选通路（探测结果缓存 30s）→ Everything HTTP / es.exe / walk → 归一化 `{name, dir, size, mtime, source}`，每条结果自带来源 pill。探测独立成 `GET /sysops/api/search/probe`，返回三级结果与建议动作（对应原型引导卡）；探测结果缓存 30s，改配置后需显式失效，走 `POST /sysops/api/search/reprobe`。

**本机状态（2026-09-27 复核）**：本机未装 Everything（`C:\Program Files\Everything` 不存在、`where es.exe` 无命中、`curl 127.0.0.1:3417` 拒连），故两个 Everything 适配器标「**未在本机验证**」—— 它们的用例是注入假件跑的；`walk` 是当前**唯一**实跑通路。

### 3.5 告警

`alerts/rules.js` 纯函数评估 → 命中写 `alert-hit`（200 条环形裁剪）→ SSE `alert` 帧 → 侧边栏蓝点由未读数驱动，进入监控页即清。依赖的采集源关闭时规则**不参与评估**（不是评估后隐藏结果）。

---

## 4. 错误处理

### 4.1 子进程监督（`collect/supervisor.js`）

注册表 `Map<key, { child, restarts, backoff, lastTick, state }>`，state ∈ `off / starting / on / stalled / crashed / exited-max`。

- **非主动退出** → 退避 1s / 2s / 4s / 8s / 30s，5 次封顶后进 `exited-max`：采集源条标红 + 附最后一段 stderr（截 400 字符）+ 只留「重试」按钮，不再自动重启。
- **心跳**：typeperf 每样本刷 `lastTick`；超过 3× 采样间隔无输出判 `stalled` → kill 并计一次重启（挂着不输出比崩更难发现）。
- **kill 三条路**收敛到同一个 `stop(key)`：关开关、插件 dispose（`ctx.effect` 清理回调）、进程退出（`exit` / `beforeExit` 内同步 kill）。Windows 下 `child.kill()` 对 `shell:true` 不可靠，改用 `taskkill /PID <pid> /T /F`；PID 只取 `spawn` 返回值，绝不接受外部输入拼进命令行。

### 4.2 采集异常四分清

未开启 / 进程已退出 / 权限不足（计数器名不存在或拒绝访问）/ 数据异常（NaN、负值、>100%）。四类文案与颜色各不相同；第四类的脏点**丢弃不写入 ring** 并单独计数——一个假点会在曲线上被读成真实尖峰。

### 4.3 清理错误

- `EBUSY / EPERM / ENOTEMPTY` → 该项 `skipped` 并写原因，**不重试**（重试只会拉长文件锁定期）。
- 快照 re-stat 不过（判定条件见 §3.3，单点定义）→ `rejected-snapshot`，提示重新扫描。
- 部分失败 → 汇总明确"成功 N / 跳过 M / 失败 K"，三档计数一并进留痕。
- 执行中断（关插件 / 断连）→ 已删项不回滚；重启后按快照提示「上次执行未确认完成」并指向该条留痕。
- 暂存目录跨卷 `move` 报 `EXDEV` → 回退 copy + delete 且**先写成功再删源**，失败保留原件并报因；暂存目录本身在扫描范围之外，永不被自己清掉。

### 4.4 搜索错误

未就绪 → 降级并说明缺哪一级；HTTP 403 → 指向「工具 → 选项 → HTTP 服务器」；超时 4s → 取消并保留上次结果标「陈旧」；命中超 limit → 截断并标注。

### 4.5 guard 单点（红线唯一裁决处）

`clean/guard.js` 是"能不能删"的**唯一**判定入口，扫描、新增规则、执行三处都问它，任何模块不得自行放宽：

- 命中即拒：`C:\Windows\*`、`C:\$Recycle.Bin*`、`Program Files*`、属主/ACL 变更、注册表路径
- 同时拒绕过形态：`\\?\` 前缀、UNC、8.3 短文件名、`..` 与 junction 逃逸、大小写与全角变体、未展开的 `%VAR%`、省略盘符
- 新增规则在**校验阶段**就拒写入（原型已演示该文案），而不是执行阶段才失败

### 4.6 宿主能力缺失（诚实降级）

`caps` 启动探测一次并缓存，结果在设置页能力表可见：

| 缺什么 | 表现 |
|---|---|
| `storageDomain` | 配置转只读，写接口返回 501，保存按钮置灰并注明原因 |
| `webServer` | 不注册侧边栏入口（点开空白页比看不到入口更糟） |
| `timer` | 退 `setInterval`，但必须显式 `stop()`，能力表如实标这行降级 |
| 系统通知 / 开机自启 | 能力表标「宿主不提供」，UI 上不留开关 |

### 4.7 两条硬规则

1. 错误就地落在触发它的那张卡（行内 notice），**不做顶部浮层**（股票插件 design-spec §4）。
2. 禁止 `catch {}`：每个 catch 必须产生一个可见状态变化或一条时间线记录。唯一例外是响应写失败（客户端已断开，无处可报）。

---

## 5. 测试

沿用股票插件的零依赖约定：`node:assert/strict` + 自研 `check(name, fn)`，`node test/<x>.test.mjs` 直跑，无测试框架、无 npm script；真机项由 `SKIP_LOCAL=1` 跳过。分「纯函数 / 打桩编排 / 真机」三段。

| 文件 | 覆盖 | 段 |
|---|---|---|
| `test/guard.test.mjs` | 红线矩阵 ≥40 例：`C:\Windows\*`、`$Recycle.Bin`、`Program Files*`、`\\?\`、UNC、8.3 短名、`..` 与 junction 逃逸、大小写/全角、未展开 `%VAR%`、省略盘符、通配越界 | 纯函数 |
| `test/collect.test.mjs` | ring 边界（覆盖、乱序、裁剪）；typeperf 输出 fixture（表头、多实例、中文计数器、半行断流）；PowerShell 进程榜 JSON 解析；supervisor 用假 child（EventEmitter）驱动退避序列、5 次封顶、stall 判定、`stop` 幂等 | 纯函数 + 打桩（零真进程） |
| `test/alerts.test.mjs` | 阈值穿越、连续 N 次、冷却窗口、依赖关闭后不评估 | 纯函数 + 假时钟 |
| `test/clean.test.mjs` | 在 `%TEMP%\sysops-test-<rand>` 真建目录树（只读文件、深路径、>1000 文件）真遍历比对与真删；**伪造 itemId / 伪造路径必须被拒**；EXDEV 回退用打桩 | 真机（可跳）+ 打桩 |
| `test/search.test.mjs` | probe 三级 8 种组合 → 通路选择；Everything HTTP 响应 fixture（403、超时、畸形 JSON）；walk 与 Everything 归一化一致 | 打桩 |
| `test/prefs.test.mjs` | 五条独立记录的 schema 与读写语义（`schema-*` / `prefs-*` / `rules-*` / `prefq-*`）：未声明字段丢弃、`null` 与 `[]` 分开、`writeMany` 跳过未知键但不拖垮整批、内置库只收本机实测存在的路径且自产规则先过 guard、命中红线的规则在**写入阶段**就被拒、`prefq-1` 拒未展开的 `%VAR%` | 纯函数 |
| `test/plugin.test.mjs` | 加载级（宿主半边）：`inject` 打桩、路由表与写端点全 POST、侧边栏与主面板注册参数、**回环闸门**（非回环一律 403）、无原生 `confirm/alert` 调用、源码静态扫零 `@deepseek-ai/*` import | 加载 |
| `test/client.test.mjs` | 加载级（浏览器半边）：`__ModuleLoader__` 协议加载、四页签骨架与页签齐全、**无顶部浮层**、无原生 `confirm/alert/select`；四页的纯函数与渲染用例按 `pg1`（监控）/`pg2`（清理）/`pg3`（搜索）/`pg4`（设置）分段，外加 `cn-*` 走真实 `fetch` 与 SSE 打桩的端到端接线证人 | 加载 + 打桩 |
| `test/host-compat.test.mjs` | 无 `storageDomain` / 无 `webServer` / 无 `timer` 三种组合下加载不抛、状态如实报 | 加载 |

**覆盖率**：本仓库不产百分比数字（自研 harness 与 `node --test --experimental-test-coverage` 不兼容，引工具即破坏零依赖）。替代做法：`guard.js` 维护一份**分支清单**，每条红线一个用例 ID，人工核对是否全部打勾。guard 是唯一要求分支全覆盖的模块——它是这台机器上不可逆动作的单点。

**验收门禁**：

1. 全部 `test/*.test.mjs` 0 fail，逐项打印 PASS 计数
2. guard 分支清单 100% 打勾
3. 原型四页签实测 0 console error（本轮已达成，实现后复跑）
4. 三档断点（1080 / 860 / 620）截图核对
5. §1.2 的六条实测命令复跑，偏差 >20% 时更新本文件而不是继续引用旧值

---

## 6. 视觉与交互（全部继承，不另立）

- 设计 token、卡片样式、`tabular-nums`、侧边栏 200px→56px（≤860px）：见 `dsh-plugin-stock-analysis/docs/design-spec.md` §5.1
- §4 全局禁止顶部浮层提示条：无落点就不做提示
- 三档断点 1080 / 860 / 620
- 交互一律自研系统风格控件，禁用原生 `confirm` / 校验气泡 / `<select>`
- 已确认可点原型：`dsh-plugin-sysops/prototype/index.html`（四页签，含 L0 档位 ↔ 告警规则置灰、两段式清理留痕、搜索降级计数、guard 拒绝演示）

---

## 7. 数据红线（继承股票插件 §7）

禁编造 · 可追溯 · 如实降级 · 量级自检 · 留痕可复现。落到本插件：

- 清理留痕冻结的是**清单快照**（命中规则 + 执行方式 + 前后容量差 + 三档计数），不是"大概清了多少"
- 每个搜索结果显示来源 pill（Everything HTTP / es.exe / 本地遍历）
- 采集源状态条常显，降级（轮询、限定目录、宿主不提供通知）必须看得见

---

## 8. 未决项（实现阶段处理，不阻塞本设计）

**实现期已全部收口**（2026-09-28）：

| 项 | 决定 | 依据 |
|---|---|---|
| 内置清理规则清单 | **已定：12 条**。只收本机实测存在、且不踩红线的路径，禁止凭印象列 | `lib/clean/rules.js` 的 `BUILTIN_RULES` 实测 `length === 12`（`temp-user` / `win-explorer` / `edge-cache` / `vscode-cache` / `npm-cache` / `pip-cache` / `crash-dumps` / `packages-cache` / `local-cache` / `wechat-cache` / `dingtalk-cache` / `playwright-browsers`）；2026-09-27 复核把 `WER` 剔了 —— 现采 `AppData/Local/Microsoft/Windows/WER` 三条全 ENOENT，Windows 错误报告实际落在 `C:/ProgramData/Microsoft/Windows/WER`（见该文件头部注释与 Task 11 Step 3 的现采块） |
| 暂存目录位置 | **已定：默认落点 `%LOCALAPPDATA%\dsh-plugin-sysops\quarantine`** | `DEFAULT_QUARANTINE(appData)` 由宿主展开成绝对路径后放进 Task 19 载荷 `defaults`；prefs 只存展开后的绝对路径（`prefq-1` 拒未展开的 `%...%` 形），界面渲染 prefs 实配值、无实配时回落 `defaults`。原型里的 `C:\Users\gongj\.dsh-quarantine\2026-09-27\` 是演示串 |
| 曲线保留窗口默认值 | **已定：30min**（`keepMinutes` 默认 30，钳 5~120） | ring 上界由 `maxPoints = 1800` 定（30min @1s），4 源 × 1800 点按该文件自述量级 ≈100KB，远低于 1MB —— 这是按 `maxPoints` 推的上界，不是压测读数 |
| spec 文档位置 | **已定：保留在 `docs/superpowers/specs/`** | 不与兄弟插件的 `docs/design-spec.md` 统一（superpowers 约定优先） |

### 8.1 遗留与已知限制（2026-09-28 Task 25 收尾裁定）

全分支大评审与后续验证代理累计提出的 backlog，逐条给"改 / 不改 + 理由"。**已改的**是代码或注释（见
`git log 98780a8..HEAD`），下表是**裁定不改**的项 —— 刻意保留，理由如下，供后续判断时不再重复讨论。

| # | 项 | 不改的理由 |
|---|---|---|
| L-1 | 测试夹具里的 `C:\Users\gongj\` 用户名（全仓约 120 处） | 这是全仓统一的夹具约定，不是泄漏；`test/host-compat.test.mjs:290` 刻意用 `/C:\\Users\\|gongj/i` 当"注入载荷不得回显本机路径/用户名"的金丝雀断言。单改一个文件只会让两处口径分叉，收益纯属 cosmetics |
| L-2 | `index.js` 的 `teardown()` 只 `close()` 不置空 storage facility 句柄 | 置空会破坏 ⚠️-1 的"同一 `getFacility` 实例"硬约束：宿主 `close()` 后同轮 `reopen()` 必须仍拿到同域，置空即断链。关闭已逐句留痕（不静默），句柄泄漏面为 0（进程退出即回收） |
| L-3 | `beforeFree` / `afterFree` 恒为系统盘（不随清理目标盘变化） | 清理目标盘就是系统盘（内置 12 条规则全在 `C:`），`diskFreeGb` 也只报系统盘 —— 两处同源，不存在"报了别的盘"的错位。真做多盘需先扩采集口径，属新功能不属修复 |
| L-4 | `skipped` / `INCOMPLETE` 明细的 SSE 载荷 ~150B/条的预算 | 预算是按单帧上限推的，超出即截断并在界面上标注"明细已截断"。为不完整的条目留全量明细会把 SSE 帧挤爆，反而伤主路径 |
| L-5 | 跨边常量（`redlines` / `searchAdvice` / `defaults`）靠真机注入，测试用桩值 | 这些常量的权威生成方在宿主半边（`lib/clean/rules.js` + `lib/prefs/spec.js`），跨半边只能靠宿主载荷传递。桩值已由 `host-compat` 与 `plugin` 两侧钉住形状；真值注入链需真宿主，见 §8.2 |
| L-6 | `GET /api/clean/plan` 不分页 | 清单快照本就按 `PLAN_KEEP=20` 段上限裁剪，单段条目数受 `maxEntries` 约束；加页参数是给一个不会长的列表加机器 |
| L-7 | SSE 坏帧只跳过、不累计 UI 计数器 | `cf-7` 已把"坏帧只跳过该帧"定为设计契约（一帧坏不该污染整条流的状态），加计数器与之冲突，且无用户可见价值 |
| L-8 | SSE 断流后降级轮询，永不自动回切 SSE | 回切需要可测的假时钟与"连续 N 次轮询成功"阈值，当前测试栈给不出廉价可信的时钟；按 Ruling-109 判例，收尾期加未证行为风险大于收益。用户可手动切回 |
| L-9 | `client.js` 的 `guardDenied` 分支在生产链路无生产者 | 已如实改写注释（原注释声称"读 `cfg().builtinRules`"是假的）。保留分支是为了**页面永不自己裁决红线**（约束 5 单点）：真实拒绝路径是写入阶段 403 与扫描产物 `skipped`。见 Ruling-94 |
| L-10 | 搜索的只读遍历不过 `guard` | `guard` 管的是不可逆动作（删除 / 改属主 / 改 ACL），只读遍历不在其列；对只读加闸会让"搜一下 `C:\Windows` 里那个 dll"直接失败。已在 `lib/search/walk.js` 头部写明这是刻意为之 |
| L-11 | 曲线卡窗口按 `keepMinutes`（默认 30min）渲染，而非原型写的"最近 24 小时" | 环形缓冲只留 `keepMinutes`（钳 5~120），写 24h 就是界面撒谎。原型那句是演示数据，约束 9 的"标题逐字照原型"只约束**卡名** |
| L-12 | `SKIP_LOCAL=1` 对 `test/search.test.mjs` 无效 | 该文件没有用例名含"真机"，`checkAsync` 的 skip 判定按名匹配故不命中。这是正确行为（它本就不做真机 IO），已在 spec 与台账写明，不假造一条 SKIP 记录 |
| L-13 | `test/render-fixtures.mjs` 桩 React 与 25-C 真 React 预览页之间存在骨架渲染的 cosmetics 差异 | 桩只执行组件函数取文本/类名，不跑 React 的布局与告警链路；差异仅限骨架网格的空白填充，功能断言两侧一致 |
| L-14 | 插件清单里的 `needsStorage` / `needsWebServer` **声明机制缺失**（计划文本有、实现与 spec 都没有） | 最终评审 Minor-1/2 的抱怨是"既没落地也没登记"。裁定**登记但不补机器**：声明机制是宿主契约面（宿主按声明决定是否注入 storage facility / web server），本插件已在运行时按"能力缺失就降级"处理（`PREFS_UNAVAILABLE` 501、`needsStorage` 分支置灰），加一份静态声明是给一个当前无消费者的字段加机器。**登记在此，后续若宿主引入该契约，按此条补** |
| L-15 | `alerts.hitsError` 的清除只走 `snapshot` 整体替换（无专用恢复帧） | Ruling-115：SSE 长连且无重连/回可见/轮询时，落盘降级横幅可能比实际恢复多留一会儿（假阴性）。横幅是**保守提示**（"命中不会写入本机记录"），多留不产生错误动作，任一 `snapshot` 轮次即自愈；要做到"恢复即时可见"需新增 `alert-store-ok` 帧或让服务端周期重发快照，属新机制而非缺陷修复面 |

### 8.2 只能人工在真机 dsh 里补验的两条（本机无宿主，禁用替身冒充）

| 项 | 现状 | 补验方式 |
|---|---|---|
| ⚠️-1 存储域 `close()` → 同轮 `reopen()` 的毫秒时序 | `host-compat.test.mjs` 的 `hx-9` 在无宿主时如实 SKIP | 在真宿主里连续 `close()` 后立即 `reopen()`，断言 `getFacility` 仍返回**同一实例**（不是"同域的新实例"） |
| F-7 真实 profile 的 `sysops_records` 对账 | 当前对账读数 `0→0` 是**空证**（profile 里本就没有历史数据） | 按 `task-1819-review.md` §3.9 的五步流程，在已有落盘数据的 profile 上跑一次读-写-读对账 |
