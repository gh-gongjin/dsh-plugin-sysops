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

`alerts/rules.js` 纯函数评估 → 命中写 `alert-hit`（200 条环形裁剪）→ SSE `alert` 帧 → 侧边栏蓝点由未读数驱动，进入**触发记录**页即清（S15-②：时间线搬到了第 2 个页签，清未读跟着搬）。依赖的采集源关闭时规则**不参与评估**（不是评估后隐藏结果）。

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
| spec 文档位置 | **已定：`docs/design-spec.md`**（2026-09-30 迁移） | 与兄弟插件 `dsh-plugin-stock-analysis` 的 `docs/design-spec.md` 统一，不再使用 superpowers 目录约定 |

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

### 8.3 真机两症状的根因修复（2026-09-28，R-1~R-6）

**症状（用户在真机 dsh web 里截的图）**：① 面板顶部常驻五行"能力缺口"提示；② 资源监控页 CPU/内存/C 盘可用/网络吞吐全 `—`、空态停在"等待首帧数据"、页脚"推送通道 降级：轮询 2s"。

**单一根因（一个时序错误解释两个症状）**：Cordis 4.x 的 `ctx.inject(deps, cb)` 等价于 `ctx.plugin({ inject, apply: cb })`
（`@deepseek-ai/cordis/src/registry.ts:300`），即 **cb 跑在独立 fiber 上、不在 `apply` 的同步段执行**，依赖不可满足时 cb 永不执行。
而 `index.js` 在 apply 顶层同步读三个注入变量并据此**一次性锁死**能力位：

- `caps.mark('webServer', Boolean(webServer))` ⇒ 恒 `false` ⇒ 第 12 节的 `if (caps.webServer)` 闸掉**整块路由注册** ⇒ `/sysops/api/*` 全 404 ⇒ 页面取不到数据（症状②）；叠加 `client.js` 的 `capGaps` 只过滤 `ok === false` ⇒ 五行常驻横幅（症状①）。

**取证**：`tmp/probe-inject-order.txt`（真 cordis：`A_syncRead:false` / `A_setImmediate:true`）；`tmp/repro-storage-open.txt`（两阶段均 `capsSnapshotAtApply:false`）；
真机 `curl`：`/sysops/api/snapshot`=404 而 `/stock-analysis/api/health`=200（同宿主同机制，工作参照 `dsh-plugin-stock-analysis` 恰好在**注入回调内部**写能力位与注册路由）；
`test/host-compat.test.mjs` 的假宿主 `inject` 曾**同步调用**回调 —— 这就是"真机必炸、测试全绿"的假绿来源（Ruling-91 同族：替身冒充通过）。

**修法（R-1~R-6，全部落地并逐条变异证明）**：

| # | 改动 | 位置 |
|---|---|---|
| R-1 | 能力位改**现取现算**：新增 `syncCaps()`，在各注入回调与 `index-inject` 载荷构建前调用；删除 apply 顶层的同步 `mark` 快照 | `index.js` §2/§11/§12 |
| R-2 | 路由注册**移进** `ctx.inject(['webServer'], cb)`（配 `ctx.effect` 收口）；拿不到 webServer 时 `index-inject` 载荷**一条都不推**（还原 §4.6"不注册侧边栏入口"） | `index.js` §11/§12 |
| R-3 | 面板顶部横幅只显示**带非空 `detail` 的真降级行**；结构性"宿主不提供"（notifications / autostart）只留在设置页能力表 | `client.js` `capGaps` |
| R-4 | 测试桩 `inject` 改为**延后执行**（`setTimeout 0`，还原 cordis 语义），并把涉及时序的断言改成 flush 后断言；新增 `hc-10`（锁根因）、`hc-11`（留痕去重） | `test/host-compat.test.mjs` |
| R-5 | `intervalFn` 改**晚绑定**（`armL0()` 内每次现取），并在 timer 注入回调里重挂 L0 —— 否则能力位说 `timer:true`、运行时快照说 `setInterval`，同页自相矛盾 | `lib/collect/service.js`、`index.js` §11 |
| R-6 | `caps.mark` 的降级留痕**同一能力只打一次**（载荷每次构建都会重算，不去重即刷屏）；能力恢复时清掉陈旧 `detail` | `lib/caps.js` |

**验证读数（同一轮现采）**：

- 全套 9 个测试文件 exit 0：`guard 19 · prefs 29 · collect 48 · alerts 34 · clean 61 · search 30 · plugin 37 · host-compat 22 · client 106`（host-compat 20→22 为新增 hc-10/hc-11）。
- **变异电池 6 条**（每条都在 `cp` 字节级还原后 `sha256` 相等）：MUT-A（载荷/回调去掉 `syncCaps`）→ hc-3、hc-10 红；MUT-B（回调内不注册路由）→ hc-4、hc-10、hx-4、hx-6/6b/6c 红；MUT-C（`if (!webServer) return` 改 `false`）→ hc-5 红；MUT-D（caps 去掉留痕去重）→ 仅 hc-11 红；MUT-E2（`intervalFn` 回到构造时只取一次）→ 仅 hc-10 红、collect 48/48 仍绿（证明该断言为本轮新增且独有）；MUT-F（client 过滤回 `ok === false`）→ pg4-17 红。
- **真 cordis 独立复现**（`tmp/probe-sysops-apply.mjs`，不写任何注入语义替身）：`GET /sysops/api/snapshot` → **200**，`cadence:"1s"`、`timerBackend:"ctx.interval"`、`cpuPoints:2`、`mem:84.45644819834567`、`diskFreeGb:72.24`；`capabilities` 三项全 `true`、`degradedRows` 为空、`registeredRoutes[0] = {kind:'prefix', path:'/sysops'}`。

**残余真机步骤（不能由本机代替，Ruling-91）**：插件以 `link:` 挂在 `web` profile 下，**需用户重启自己的 dsh web** 才加载新代码；
重启后 `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/sysops/api/snapshot` 应为 **200**（修复前实测 404），面板顶部五行横幅应消失、监控页应出真实曲线。

**✅ 已在真机复核（2026-09-28，用户重启后）**：`curl` → `/sysops/api/snapshot` = **200**（修复前 404）；用户截图显示顶部五行横幅已消失、监控页四项出真实数值与曲线。
症状①与症状②的"无数据/无入口"部分均已消除，同一张截图暴露的另两处见 §8.4。

### 8.4 真机第三/四症状的根因修复（2026-09-28，R-7~R-8）

**症状（用户在同一张真机截图上圈的第二批）**：③ 监控页四格 KPI（CPU / 内存 / C 盘可用 / 网络吞吐）与四张曲线卡的大数字**不随实时数据变化**（曲线在爬、数字不动）；④ **整个面板页面无法滚动**，底部"进程占用榜"卡被视口下沿切断。

**症状③根因**：`GET /api/stream` 只在连上时推**一帧** `snapshot`（`lib/api.js:335`），之后每 tick 只推 `metrics` **增量点**（spec §3.1 表即如此规定）。
而 KPI 四格与曲线卡的大数字都读 `snap.latest`（`mtrRows` 在 `client.js:401`、曲线卡值在 `client.js:1162-1166`）——
旧 `mergeFrame` 只把增量点并进 `series`、**不碰 `latest`**，于是曲线（吃 `series`）在动、数字（吃 `latest`）永久冻在首帧。

- 真机取证（同轮现采）：`curl /sysops/api/snapshot` → `latest.cpu = 24.01`、`series.cpu` 已 416 点；而页面停在首帧的 `8%`。服务端**每次 GET 都现算**，前端却只在首帧取过一次。
- `latest.netDown/netUp` 恒为 `null` 属**正常**：网络源 `l1a` 默认关（`sources` 里 `l1a.state = off`），故该格显示 `—`，与本缺陷无关。

**症状④根因**：宿主主列 `.centerCol` 是 `overflow:hidden`（`dsh-client-ui-layout/AppFrame.module.css`：`.pI_x6G_centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden}`），
而 `.so-root` **没有任何高度上限与溢出声明** ⇒ 超高内容被裁到视口高，且自身不构成滚动容器 ⇒ 滚不动。
同仓 `dsh-plugin-stock-analysis/client.js:264-266` 早为同一件事加了兜底（注释原文："宿主 centerCol 是 overflow:hidden，插件内容超高会被直接裁掉"），本项目漏了这一条。

**修法（R-7~R-8）**：

| # | 改动 | 位置 |
|---|---|---|
| R-7 | `mergeFrame` 的 `metrics` 分支**同时合并 `latest`**：`cpu/mem/netDown/netUp` 同名直写；`diskFreePct` 点按 `总量 × 空闲%` 换算回 `diskFreeGb`（`latest` 的口径是 GB），**总量缺失时保持原值不硬算**；白名单外的 key 不写入。一处修复同时治 KPI 四格与曲线卡四个大数字 | `client.js` `mergeFrame` |
| R-8 | `.so-root` 补 `max-height:100vh;overflow-y:auto` —— 滚动归插件自己管，与 `.sa-root` 同款 | `client.js` CSS |

**验证读数（同一轮现采）**：

- 9 个测试文件全 exit 0：`guard 19 · prefs 29 · collect 48 · alerts 34 · clean 61 · search 30 · plugin 37 · host-compat 22 · client 109`（client 106→109，新增 pg1-20/21/22）。
- **变异电池 4 条**（逐条单独跑、`cp` 字节级还原后 `sha256` 与前值相等 `63dbc092d27c142e`）：`MUT-G`（从不合并 `latest`）→ pg1-20 + pg1-21 红；`MUT-H`（disk 去掉总量保护、无条件硬算）→ **仅** pg1-21 红；`MUT-I`（去掉同名白名单）→ **仅** pg1-20 红；`MUT-J`（去掉滚动兜底）→ **仅** pg1-22 红。
- **真浏览器对照实测**（`tmp/scroll-live.txt`；Playwright/Chromium，宿主同款 `.centerCol` 容器 + 逐字 `.so-root` 块，同一元素注入前后各量一次）：修复前 `overflow-y:visible`、`clientHeight = scrollHeight = 3062`、置 `scrollTop = 400` 读回 **0**、宿主 `overflow-y:hidden` 把内容裁到 800px；
  修复后 `overflow-y:auto`、`clientHeight = 800 / scrollHeight = 3062`、置 `scrollTop = 400` 读回 **400**。即"滚不动 → 真能滚"在真布局引擎里闭环。

**残余真机步骤（不能由本机代替，Ruling-91）**：本轮改的是浏览器半边（`client.js`），仍以 `link:` 挂载，**需用户再重启一次 dsh web**；
重启后应有：KPI 四格与曲线卡大数字随时间变动（CPU 几秒内即跳到下一个采样值），滚轮可滚到底看到"进程占用榜"全文。

### 8.5 真机第五/六/七症状的处置（2026-09-28，S5~S7）

**症状（用户第三批真机截图，三条各自带箭头与红框）**：

| # | 用户原话 | 圈定范围 | 性质 |
|---|---|---|---|
| S5 | 「这个不应该放在设置里面吗，为什么放在系统监控这」 | 监控页的「阈值告警」整块（五行规则开关 + 新建规则表单：指标 / 阈值·连续 / 冷却 / 提示落点 / 保存规则） | 分层错位：**配置**长在了**看板**上 |
| S6 | 「鼠标移到曲线上要能显示对应数值」 | 曲线卡（CPU 曲线卡） | 能力缺失：曲线只有走势、读不出点值 |
| S7 | 「鼠标移上去怎么变黑色了」 | C 盘清理页「开始扫描」按钮 | 回归 Bug：CSS 特异性压倒控件常态样式 |

**S5 —— 配置从监控页搬到设置页。**
监控页的定位是**只读看板**，规则的新增/开关属"设置"。改法：把「阈值告警」整块（规则开关列表 + 新建规则表单）迁到设置页成为独立卡；监控页只保留只读的「触发记录」，卡头写明「规则在设置页配置 · 本机保留最近 200 条」。
容器接线把告警与清理规则的通道**严格分开**：设置页的告警开关/新建走 `onAlertToggle` / `onAlertAdd`（复用 `doRuleToggle` / `doRuleAdd`，写 `prefs.alerts`），清理规则仍走 `onRuleToggle` / `onRuleAdd` —— pg4-3b 钉住"点停用规则只落 `alertToggles`、不落 `cleanToggles`"，pg1-11b 钉住"监控页不再有保存规则按钮与阈值/持续/提示落点，但仍有触发记录且明确指路设置页"。

**S6 —— 曲线悬停读数画在卡内 SVG 里。**
§4 禁令禁止顶部浮层提示条与原生 `title`，所以读数不能外挂；做法是把它画进**本卡 SVG**：竖虚线 + 圆点 + 一行 `值 · HH:MM:SS`（贴左右边缘换 `text-anchor` 免得被裁）。
逻辑抽成纯函数层便于双层测试（纯函数级 + 活体桩真交互级）：

| 函数 | 职责 |
|---|---|
| `seriesVals` | 挑出有效点（`v` 非 null），**画线与读数共用同一份来源** —— 免得"读到的点不是画出的点" |
| `pointXY` | 第 i 点 → 画布坐标的**唯一**映射（`sparkPoints` 与悬停读数都走这里） |
| `hoverIndexAt` | 屏幕横坐标按 `preserveAspectRatio="none"` 的比例反解成下标；`rect` 拿不到就返回 `null`，**不猜** |
| `clockOf` / `tipAnchor` | 时刻格式化 / 贴边换文字锚点 |
| `tipText` | 文案口径**跟卡走**：C 盘卡的点是**空闲占比** ⇒ 按 `latest.diskTotalGb` 折回 GB，总量未知只报百分比；网络卡在该点同时给下行与上行 |

换帧后点数变少导致的索引越界按"没指着"处理（不画半个读数）。

**S7 根因 —— CSS 特异性，不是样式写漏；而第一版修法把症状加重了。**
`.so-root button{…}` 的特异性是 **(0,1,1)**，高于 `.so-btn` / `.so-btn-primary` / `.so-btn-sm` / `.so-check` / `.so-tab` 各自的 **(0,1,0)**。这条"给裸 button 清零"的规则里写下的**任何**属性都会把控件类的**常态**值整块吃掉，只剩 `:hover` 那一档 **(0,2,0)** 还生效 —— 与初次真机症状逐字吻合：primary 按钮平时看不出是按钮，鼠标一移上去突然变深色。

**第一版修法（只从清零规则里删掉 `background`，留下 `color:inherit`）不完整且更糟**：`color:inherit` 仍在 (0,1,1)，继续压掉 `.so-btn-primary{color:var(--so-bg)}` ⇒ 深色底 + 继承来的深色字 = **纯黑块、文字不可见**（用户二次真机截图 +「怎么直接变黑色了，你改了测过没有」）。同一根因还一直压着 `.so-btn-sm{font-size:12px}` 与 `.so-check{font-size:11px}`。

**根治修法**：这条清零规则**自身特异性必须低于一切控件类**，故整条降为 **`:where(.so-root) button{font:inherit;color:inherit;cursor:pointer}`**（`:where()` 贡献 0 特异性 ⇒ 整条 (0,0,1)），让 `.so-btn` / `.so-btn-primary` / `.so-btn-sm` / `.so-check` / `.so-tab` 在 `background`、`color`、`font-size`、`border`、`padding` 上**全属性**胜出。`:where()` 的运行时支持有保障：本表已在用 `color-mix()`（Chromium ≥111），`:where()` 自 Chrome 88 起可用。

**取证教训（机制层面，必须记）**：第一版的两处取证**同时漏掉 `color` 这一维** —— 浏览器探针只量了 `backgroundColor` / `border` / `padding`，`pg1-27` 也只断言"清零规则不含 `background`/`border`/`padding`"，于是"深底叠深色字"整类缺陷无人拦。教训：**量常态样式必须把 `color` 与 `background` 成对量，并断言二者不同（可读）**，不能只量底。

**验证读数（同一轮现采）**：

- 9 个测试文件全 exit 0，合计 **397/397**：`guard 19 · prefs 29 · collect 48 · alerts 34 · clean 61 · search 30 · plugin 37 · host-compat 22 · client 117`（client 109 → 117；S7 复发时 `pg1-27` 被**加强**但条数不变）。
- **S5 变异电池 4 条**（`tmp/mut_s5.mjs`，逐条独立改写 → 跑测试 → `cp` 字节级还原后比 sha，全部回到基值 `e49179a26736`）：`M1`（告警开关串到清理通道）→ **仅** pg4-3b 红；`M2`（冷却分钟未换算成秒）→ **仅** pg4-3b 红；`M3`（监控页不再指路设置页）→ **仅** pg1-11b 红；`M4`（设置页不渲染告警规则行）→ pg1-11 + pg4-3 + pg4-3b 红。
- **S6/S7 变异电池 10 条**（`tmp/mut_s67.mjs`，同法，还原后 sha 全部回到 `e49179a26736`）：`M1`（`seriesVals` 不再剔除脏点）→ pg1-23 红；`M2`（`hoverIndexAt` 去掉上下界钳制）→ pg1-24 红；`M3`（C 盘卡不再折回 GB）→ pg1-25 红；`M4`（`clockOf` 用纪元时刻）→ pg1-25 + pg1-26 红；`M5`（悬停竖线类名写错）→ cn-3b 红；`M6`（清零规则里塞回 `background`）→ pg1-27 红；`M7`（`.so-switch` 丢掉自己的 `border:none`）→ pg1-27 红；**`M8`（`:where()` 退回裸 `.so-root` ⇒ 真机黑块复现）→ pg1-27 红**；**`M9`（`.so-btn-primary` 丢掉自己的 `color` ⇒ 黑块那一维）→ pg1-27 红**；**`M10`（`.so-btn-sm` 丢掉自己的 `font-size`）→ pg1-27 红**。10/10 命中、无一条 SKIP。
- **真浏览器对照实测**（Playwright/Chromium，`tmp/gen_s7_check3.mjs` → `s7-check3.cjs`）。CSS **逐字从 `client.js` 的 CSS 模板串抽取**（白名单只取 `.so-root*` / `:where(.so-root) button` / `.so-btn*` / `.so-check*` / `.so-switch*` / `.so-tab*` 相关规则），同一批元素在"**修复前版本**（清零规则退回裸 `.so-root button`，即真机黑块现场）"与"当前版本（`:where(.so-root) button`）"各量一次 `getComputedStyle`，**本次 `bg` 与 `fg` 成对回读**：

  | 元素 | 修复前 bg / fg | 修复后 bg / fg |
  |---|---|---|
  | `.so-btn.so-btn-primary`（开始扫描） | `rgb(26,26,26)` / `rgb(26,26,26)` ← **黑块** | `rgb(26,26,26)` / `rgb(255,255,255)` ✔ 白字 |
  | `.so-btn.so-btn-sm.so-btn-primary`（保存规则） | `rgb(26,26,26)` / `rgb(26,26,26)` ← **黑块** | `rgb(26,26,26)` / `rgb(255,255,255)` ✔ |
  | `.so-btn.so-btn-sm`（停止扫描）字号 | `13px`（`font:inherit` 吃掉 12px） | `12px` ✔ |
  | `.so-check[aria-checked="true"]`（已勾选） | `rgb(26,26,26)` / `rgb(26,26,26)` ← **黑块** | `rgb(26,26,26)` / `rgb(255,255,255)` ✔ |
  | `.so-check`（未勾选）字号 | `13px` | `11px` ✔ |
  | `.so-tab`（资源监控）字色 | `rgb(26,26,26)`（黑，应为灰） | `rgb(107,107,112)` = `--so-t2` ✔ |
  | `.so-btn-primary:hover` | `rgb(26,26,26)` / `rgb(26,26,26)` ← **黑块** | `rgb(26,26,26)` / `rgb(255,255,255)` ✔ |

  修复前"文字色 == 底色"的元素集为 `{开始扫描, 保存规则, 已勾选复选, primary:hover}` —— **与用户截图的纯黑块逐个对上**；修复后该集合只剩未勾选的复选框（内容为空、`.so-check{color:var(--so-bg)}` 属设计如此，非缺陷）。

**残余真机步骤（Ruling-91）**：本轮仍只改浏览器半边，需用户重启 dsh web 后复核四项：#44（KPI 数字每秒跳 + 可滚到底）与 S5（监控页无配置、设置页有）、S6（曲线悬停出读数）、S7（**「开始扫描」常态是深底白字、文字看得见**，且 `.so-btn-sm` 字号回到 12px）。
**未提交**（本地改动不主动提交，等用户真机复核通过后与 #44 合并为一次提交）。

### 8.6 真机第八批症状的处置（2026-09-28，S8-①②③）

**症状（用户第四批真机截图，三张各带红圈箭头）**：

| # | 用户原话 | 圈定范围 | 性质 |
|---|---|---|---|
| S8-① | 「这两个边框高度不一样」 | 监控页「CPU 使用率 · 最近 30 分钟」与「内存占用率 · 最近 30 分钟」两张曲线卡（箭头指两卡顶角） | 回归 Bug：卡间距规则的相邻兄弟选择器漏进网格 |
| S8-② | 「右上角哪里有开始扫描」 | C 盘清理页空态卡（文案说「点击右上角」） | 文案与落点错位：入口长在卡里居中 |
| S8-③ | 「搜索这个位置放得太下了，看不到，应该放在最上面」 | 文件搜索页「搜索」卡（排在自检卡 + 引导卡之后） | 信息层级错位：能干活的地方在第三屏 |

**S8-① 根因 —— 间距方案自己出的错（不是样式写漏）。**
`.so-card+.so-card{margin-top:14px}`（相邻兄弟选择器）撞上 `.so-charts{display:grid;...gap:14px}`：网格里的第 2/4 张卡**也是兄弟关系**，于是同排右侧那张被 margin 压下 14px，又被 `align-items:stretch` 的默认拉伸按外边距盒高度算 → **同时压矮 14px**，与真机"右侧卡更矮且更低"逐字吻合。
同一个规则的第二个失效模式：卡前面不是卡时（曲线网格、提示行）它给不出间距 —— 实测修复前 `.so-charts` 底 783 = 下一张卡顶 783，**贴边 0 间隔**（用户截图里"进程占用榜"紧贴曲线网格）。

**修法（一条规则同时治两种失效）**：间距只挂**面板的直接子级** —— `client.js` 改 `.so-tabpanel>*+.so-card{margin-top:14px}`（网格子级不在选择器里），原型 `index.html` 同步改 `.tab-panel > * + .card{margin-top:14px}`，并顺手删掉原型里那条为掩盖此 bug 而写的行内 `style="margin-top:14px"`。**原型是 spec，两边必须同改**（原型有同一个毛病）。

**S8-② 修法 —— 照原型口径把入口移到页头。**
原型 `mainActions.clean` 本来就把「开始扫描」画在页头 `pageActions`（`prototype/index.html:1425-1444` 的 `mainActions` / `activate()`），是 `client.js` 自己多长了两颗卡内按钮（空态卡居中一颗、清单失效卡一颗），于是**两个入口两套状态**：空态那颗还在「开始扫描 / 重新扫描」之间自己切标签。改法：SysopsPage 的 `.so-head` 为清理页签渲染 `.so-actions`（「开始扫描 / 扫描中…（禁用）/ 重新扫描」，标签由 `snap.clean.phase` 与 `cleanPlan|cleanLast|planId` 决定），删掉两颗卡内按钮与 `onScan` 入参，失效卡文案补「（入口在右上角）」。**空态文案一字未改** —— 改的是落点，不是把话说圆。

**S8-③ 修法 —— 卡序即规格。**
SearchPage 的返回改为「搜索 → 结果/空态 → 自检 → 引导」，自检卡与引导卡提为 `selfCheckCard` / `guideCard` 两个 const（就绪时引导卡照旧收起）；原型搜索面板整块同步搬移（`tmp/mv-search-block.mjs`，逐字搬移不重打）。页头那行「当前通路… 查看自检」保留：自检跳到 `#probeCard`，现在它是"搜不动时去看"的地方，符合新的层级。

**验证读数（同一轮现采）**：

- 9 个测试文件全 exit 0，合计 **401/401**：`guard 19 · prefs 29 · collect 48 · alerts 34 · clean 61 · search 30 · plugin 37 · host-compat 22 · client 121`（client 117 → 121，新增 `pg1-28`（卡间距源码不变式，含原型半边）/ `pg2-27`（四分支都无卡内扫描按钮）/ `pg3-16`（卡序）/ `cn-14`（页头按钮真接线三态））。
- **S8 变异电池 6 条**（`tmp/mut_s8.mjs`，逐条独立改写 → 跑测试 → 字节级还原后比 sha，全部回到基值 `client 16ca447a878b / proto 5346c6952dc3`；锚点命中逐条硬校验 =1，行尾按目标文件归一 —— client.js 是 CRLF、原型是 LF）：`M1`（间距退回相邻兄弟）→ pg1-28 红；`M2`（卡里塞回扫描按钮）→ pg2-27 + cn-14 红；`M3`（页头不留入口）→ cn-14 红；`M4`（自检卡又排到搜索卡前）→ pg3-16 + cn-8 红；`M5`（页头标签不随状态走）→ cn-14 红；`M6`（原型规则退回 `.card + .card`）→ pg1-28 红。6/6 命中、无一条 SKIP。
- **真浏览器对照实测**（headless Chrome + CDP，零依赖驱动 `tmp/cdp-lib.mjs`；`tmp/verify-s8.mjs` 走 `tmp/preview.html` 并按 `?mode=` 打补丁造态，`tmp/s8-before.txt` / `tmp/s8-after.txt` 为前后两份原始读数，`tmp/s8-*.png` 五张截图）：

  **① 监控页四张曲线卡（1440×1200）**

  | 卡 | 修复前 top / h / marginTop | 修复后 top / h / marginTop |
  |---|---|---|
  | CPU 使用率 | 377 / **196** / 0px | 377 / 182 / 0px |
  | 内存占用率 | **391** / **182** / **14px** | 377 / 182 / 0px |
  | 网络吞吐 | 601 / 182 / 14px | 573 / 182 / 0px |
  | C 盘可用空间 | 601 / 182 / 14px | 573 / 182 / 0px |

  同排两卡 top 与 h 全部相等（修复前 CPU 与内存差 14px 的错位消失）；`.so-charts` 之后那张卡：修复前 top 783 == 网格底 783（**贴边**，marginTop 0px），修复后 top 769 == 网格底 755 + **14px**（间距回到规则里）。

  **② 清理页**

  | 读数 | 修复前 | 修复后 |
  |---|---|---|
  | `.so-head .so-actions` | `null`（页头没有动作区） | top 38 / left 1300 / right 1368 / h 26 |
  | 「开始扫描」位置 | top 455 / left 776（卡内居中）· `inHead=false` | top 38 / left 1300 · `inHead=true` |
  | `.so-tabpanel` 内按钮数 | 1（就是那颗卡内按钮） | **0** |
  | 扫描中页头按钮 | 无 | 「扫描中…」`disabled=true` |

  **③ 搜索页（未就绪）卡序与搜索框位置**

  | 位 | 修复前 | 修复后 |
  |---|---|---|
  | 0 | Everything 接入自检（top 165） | **搜索（top 165）** |
  | 1 | 如何拿到全盘秒级搜索（496） | 结果空态（467） |
  | 2 | 搜索（**726**） | Everything 接入自检（587） |
  | 3 | 结果空态（1028） | 如何拿到全盘秒级搜索（918） |
  | 搜索框距页顶 | **840** | **279** |

  就绪态同向：搜索卡 165（原 424）、搜索框 252（原 511）。
- **原型半边同样量过**（`tmp/verify-s8-proto.mjs`）：四张曲线卡 top 364/364/560/560、h 全 182、marginTop 全 0px，网格后那张卡 top 756 = 网格底 742 + 14px。
- **React 告警清扫**（`tmp/verify-s8-console.mjs`，四个页签各真渲染一遍并收 `Runtime.consoleAPICalled` / `Log.entryAdded` / `Runtime.exceptionThrown`）：`NO-WARNINGS`。

**残余真机步骤**：本轮三处**全在浏览器半边**（`client.js` + 原型文档），刷新页面即可生效；但工作区里仍压着前几轮的宿主半边改动（`index.js` / `lib/caps.js` / `lib/collect/service.js`），合起来以「**重启 dsh web + 刷新页面**」为准。复核点：① 监控页四张曲线卡顶边齐平、边框等高，「进程占用榜」与曲线网格之间有空隙；② 清理页空态说的「右上角」真有一颗「开始扫描」，扫描中点它变灰并写「扫描中…」；③ 搜索页第一屏就是搜索框与结果区，自检/引导退到结果之后。
**未提交**（本地改动不主动提交，等用户真机复核通过后与 #44 / S5~S7 合并为一次提交）。

### 8.7 真机第九批：点「开始扫描」报「fsMod.join is not a function」（2026-09-28，S9-①②）

**症状（用户原话：「点击开始扫描报错」）**：清理页点页头那颗「开始扫描」，卡里红条写「扫描失败：fsMod.join is not a function」。

**根因 —— 假 FS 桩比宿主多带一个键，等于替宿主圆谎。**
宿主接线（`index.js:347/349`）交的是 `fsMod: node:fs` + `pathMod: node:path`，而 `node:fs` 上**没有** `join`；偏偏 `lib/clean/scanner.js:213` 与 `lib/clean/executor.js:132` 写的是 `fsMod.join(...)` —— 拼路径的函数从错的模块上取。整条链上的假桩都"顺手"补过这个键（`test/clean.test.mjs` 的 `fakeFs` / `exFs`，以及 `cln-真机-1` 里手搓的 `{ readdirSync, statSync, join: path.join }`），于是假用例与那条"真机例"全绿、**只有真机炸** —— 桩比宿主能多，是所有"测试全绿但真机报错"的共同形状。

**同一错误假设的第二个口岸（真机上更重：它不报错）。**
`executor.js` 里那句 join 原本写在 `try { c = fsMod.statSync(fsMod.join(...)) } catch { continue }` **之内**：join 一抛就被这个 catch 吃掉，`dirty` 恒为 `null` ⇒「快照之后目录里有新增/修改的子项」这道闸门**静默失效**（探针读数：`state=ok`、目录被真删、一句提示都没有）。用户这次只看到扫描报错，是因为执行还没跑到 —— 而它本会以"看起来正常"的样子删掉有新增内容的目录。

**修法 —— join 只能来自 pathMod，且拼路径不许再躲进 catch。**
1. `createScanner` / `createExecutor` 收 `pathMod` 形参，拼路径一律 `pathMod.join(...)`；`lib/clean/service.js` 把 `pathMod` 一并转交两个工厂（顺手删掉发给 scanner 的死参 `osMod` —— Ruling-69 C8 本就写明扫描器不读它）。
2. executor 的 `join` 提到内层 `try` **之外**：那个 catch 只接「子项消失」这类条目级错事；拼路径一炸必须当场抛（fail-loud），不许降级成"闸门看起来过了"。
3. 假桩去掉 `join`（`fakeFs` / `exFs` 都不再有它），`cln-真机-1` 的装配口径改成与 `index.js` **逐字同形** —— 桩不许再比宿主能多。原型与浏览器半边本轮零改动（症状在宿主装配，不在界面）。

**验证读数（同一轮现采）：**

- 探针 `tmp/probe-cleanjoin.mjs`（前后两份原始读数 `tmp/s9-before.txt` / `tmp/s9-after.txt`），三种口径：
  - **修前**（只传 fsMod = 旧接线）：`scanner.verdict=THROW · TypeError: fsMod.join is not a function`（7ms 即抛）；executor `verdict=OK · state=ok · dirStillThere=false` —— **静默把目录删了**。
  - **修后 A 口径**（故意仍不喂 pathMod）：scanner 当场抛 `TypeError: Cannot read properties of undefined (reading 'join')`（不再是"某函数不存在"的糊话）；executor `state=rejected-snapshot · dirStillThere=true`（fail-closed，不再静默）。
  - **修后 B 口径**（真实接线 `fsMod: fs + pathMod: path`）：scanner `OK · walked 112853 · items 507 · skipped 23 · truncated false · 10641ms`（12 条内置规则全量真扫）；executor 两种判词都对 —— `plan.at` 在过去 → `rejected-snapshot（child.bin）`、在未来 → `ok` 且目录消失。
- 9 个测试文件全 exit 0，合计 **404/404**：`guard 19 · prefs 29 · collect 48 · alerts 34 · clean 63 · search 30 · plugin 37 · host-compat 23 · client 121`。新增/加强：`cln-12`（源码锁：`lib/` 与 `index.js` 不许再出现 `fsMod.join(` 调用形状，并复核"node:fs 上没有 join"这条立论）、`cs-11`（service 把 `fsMod` + `pathMod` 一并转交 scanner/executor）、`hc-12`（真机端到端：`POST /sysops/api/clean/scan` 用真实装配真扫自建临时目录 —— 修前它的回执正是 `{started:false, error:'fsMod.join is not a function'}`）、`cln-真机-1` 改同形口径、`ex-6` 加"指名道姓说出是哪个子项脏"的断言（把 fail-closed 分支与真脏分支分开）。
- **S9 变异电池 6 条**（`tmp/mut_s9.mjs`：逐条独立改写 → 跑测试 → 字节级还原比 sha，四文件全部回到基值 `scanner 407ddedbe064 / executor 3b501914b783 / service c40b455f38fa / index 4fbaa848f867`；锚点命中逐条硬校验 =1、行尾按 CRLF 归一）：`M1`（scanner 退回 `fsMod.join`）→ `cln-真机-1` + `cln-12` 红；`M2`（executor 退回 `fsMod.join`、hoist 保留）→ `ex-6` + `cln-12` 红；`M3`（executor 退回"join 躲进 try"的老写法）→ `ex-6` 红；`M4`/`M5`（service 不转交 `pathMod` 给 scanner / executor）→ `cs-11` 红；`M6`（`index.js` 不喂 `pathMod`，接线断在最上游）→ `hc-12` 红。6/6 命中，无一条 SKIP。

**残余真机步骤**：本轮改动**全在宿主半边** ⇒ 要**再重启一次 dsh web**（连同 S5~S8 压着的宿主改动一起），刷新页面后在 C 盘清理页点「开始扫描」：预期十来秒内出清单（探针全量扫描 10641ms / 507 项），红条「扫描失败」消失。清单条数随本机缓存新旧而变、为空也属正常，但**不许**再出现任何 `fsMod.join` 字样。
**未提交**（等用户真机复核通过后，与 #44 / S5~S8 合并为一次提交）。

### 8.8 真机第十批：点扫描没进度 / 标注与一键清理（2026-09-28，S10-①②③④）

**症状（用户第五批真机截图两张 + 一行原话「点击开始扫描为什么都没有扫描进度显示，点了没反应，半天才出来结果；哪些能清理，哪些有风险要标注出来，支持一键清理」，图上另有两条批注）**：

| # | 用户原话 / 批注 | 圈定范围 | 性质 |
|---|---|---|---|
| S10-① | 「点击开始扫描为什么都没有扫描进度显示，点了没反应，半天才出来结果」 | 清理页页头「开始扫描」按钮 | 反馈缺失：真机全量扫描 10.6s，期间界面一个字节都不翻 |
| S10-② | 「滚动只在这个框内，不要整个屏滚动」 | 待清理清单表外框 | 整屏被表撑高：表头与页头一起滚出视野，框形同虚设 |
| S10-③ | 「加一个全选框」+ 圈掉两颗按钮写「不要了」 | 清单卡底部「全选可清理项 / 清空选择」 | 一键清理不可达：旧全选口径在真机 507 项里只选得上 3 项 |
| S10-④ | 「哪些能清理，哪些有风险要标注出来」 | 风险列 | 标注不可读：同一句解释在路径格与风险格各印一遍 |

**S10-① 根因 —— 扫描帧不带相位，浅并之后页面手里的相位永远停在点扫描前那一份。**
宿主 `runScan()` 在整段扫描期间没碰过 `stateObj.phase`，发出的 `clean:progress` 帧只有计数器（键即 `[type,dir,walked,hit,bytes]`）；而客户端 `mergeFrame` 对 `clean:*` 帧是**浅并**（键在才覆盖，见 `client.js:1885/1941`）——帧里没有 `phase` 键，页面手里的 `clean.phase` 就一直等于点扫描前那份快照里的 `idle`，于是空态卡「尚未扫描」挂着不动、页头按钮不翻「扫描中…」，直到十来秒后 `POST /clean/scan` 返回、新快照里才有 `phase:'ready'`。**用户看到的「点了没反应」和「半天才出来结果」是同一件事的两端**：进度一直在走，是帧没说。

**修法 —— 相位由帧带货，开扫先发一帧。**
1. 宿主 `lib/clean/service.js`：`runScan()` 一进门就把 stateObj 置 `{ phase:'scanning', startedAt: now() }` 并**立刻 `emitProgress()` 发首帧**（不等第一条规则的第一批条目，`walked=0` 也发）；`clean:progress` / `clean:done` / `clean:error` 三族帧全部带 `phase` + `stopped`，progress 帧另带 `startedAt`。
2. 客户端 `client.js`：扫描卡右上传「已用时 N 秒」（`startedAt` 现算，帧每 250ms 来一跳）；`startedAt` 缺位时退回覆盖度百分比 / 「进度未知」——不编数（覆盖度百分比在 0 条自建规则时本来就算不出来，正是真机读数）。
3. 原型 `prototype/index.html` 同步：模拟 ticker 也把 `scanElapsed` 读成「N 秒」，两边同口径。

**S10-② 修法**：清单表容器限高 + 表头吸顶 —— `client.js` 加 `.so-tblwrap-plan{max-height:clamp(240px,52vh,480px);overflow:auto}` 与 `.so-tblwrap-plan .so-tbl thead th{position:sticky;top:0;z-index:1}`；原型 `.tbl-wrap-plan` 同规则。整屏高度从此与清单行数无关。

**S10-③ 修法 —— 两个按钮按批注删除，换成表头一颗三态全选框；全选口径改成「未拒即可选」。**
旧口径 `!denied && riskLevel==='low'` 在真机 507 项里只覆盖 3 项（504 项带 mid 标），「一键清理」实际点不动。新口径：**目标集合 = 未拒项（含 mid）**——「有风险」的含义只是「运行中的应用会锁住部分文件，锁住的项会被跳过」，照常可执行（执行侧本就 fail-closed/跳过）。表头框 `aria-checked` 走 none/some/all 三态，title 如实报目标集合与风险项数（`全选可执行的 N 项（含 M 项有风险：被应用锁住的文件会被跳过）` / 勾满后 `取消全选`）；清单为空时禁用。卡头同步加一行 `共 N 项 · 可清理 X · 有风险 Y · 已拒绝 Z`。原型、客户端、测试三处同改。

**S10-④ 修法 —— 风险列三态标签，解释句只出现一次。**
风险列渲染 `已拒绝`（红）/`有风险`（琥珀）/`可清理`（绿）三态 pill，解释句（`riskWhy` / guard 拒绝理由）只在风险格印一句；路径格里那条同句渲染删除——真机截图里的重复正是它。

**验证读数（同一轮现采）：**

- 探针 `tmp/probe-s10.mjs`（前后两份原始读数 `tmp/s10-before.txt` / `tmp/s10-after.txt`；全真装配：真 `index.js` + 真 clean service/scanner + 真 fs，开真 SSE 流，客户端同款浅并口径 + 真 CleanPage 渲染）：

  | 读数 | 修复前 | 修复后 |
  |---|---|---|
  | 首帧 `clean:progress` 到达 | +14ms，键 `[type,dir,walked,hit,bytes]` | **+0ms 开扫即发**，键 `[type,phase,stopped,startedAt,dir,walked,hit,bytes]` |
  | 带 `phase` 的 `clean:*` 帧 | **0/2** | **3/3**（progress×2 + done） |
  | 页面手里的 `clean.phase`（第一帧落地时） | `idle` | `scanning` |
  | CleanPage 渲染分支 | 空态卡「尚未扫描」 | **扫描进度卡** |
  | 页头按钮文案 | 「开始扫描 / 重新扫描」 | **「扫描中…」（禁用）** |

- 9 个测试文件全 exit 0，合计 **412/412**：`alerts 34 · clean 64 · client 127 · collect 48 · guard 19 · host-compat 24 · plugin 37 · prefs 29 · search 30`（client 121→127，新增 `pg2-28`~`pg2-33`；clean 新增 `cs-12`；host-compat 新增 `hc-13`）。`SKIP_LOCAL=1`：clean 63/63（`cln-真机-1` SKIP）、host-compat 22/22（`hx-9` + `hc-12` SKIP）。
- **真浏览器对照实测**（headless Chrome + CDP 零依赖驱动，`tmp/verify-s10.mjs` 走 `tmp/preview.html?mode=s10-plan|s10-scanning` 造 26 行清单态；截图 `tmp/s10-{plan,plan-some,plan-all,scanning,proto-scanning,proto-plan}.png`）：

  | 读数 | 值 |
  |---|---|
  | 清单表容器 | clientH **468** / scrollH **1674**（26 行）、overflow auto、max-height 468px、表头 `position:sticky`；滚 220px 后表头距框顶仍 **0px** |
  | 整屏高度 | docScrollH **900 == innerH 900**（表不再撑高整屏） |
  | 表头全选框三态 | `false/空` → 点一下 `true/✓`（25 项）→ `false/空`（0 项）→ 点一行 `mixed/−`（1 项）；title `全选可执行的 25 项（含 6 项有风险：被应用锁住的文件会被跳过）` → `取消全选` |
  | 计数行 | `共 26 项 · 可清理 19 · 有风险 6 · 已拒绝 1` |
  | 风险列 | 19×可清理 / 6×有风险 / 1×已拒绝；6 条 mid 的解释句逐行恰好出现 **1 次** |
  | 全选后页脚 | `已选 25 项 · 预计释放 6.57 GB` + `含 6 项有风险：被应用锁住的文件会被跳过，不会被强删`；「清理选中」`disabled=false`（一键清理可达） |
  | 扫描卡 | 右上 **`已用时 8 秒`**（夹具 `startedAt=now-7000`）、`已遍历 52,000 个条目 · 已发现 3 项 · 1.02 GB`、页头按钮「扫描中…」、**无**「尚未扫描」卡 |
  | 原型页 | 扫描条 `0 秒 → 1 秒` 跳动；清单 `共 11 项 · 可清理 8 · 有风险 1 · 已拒绝 2` + `已全选 9 项（含 1 项有风险…）`；表头三态勾满 9 项；限高 468px 卡内滚动；旧按钮 id（`btnSelAll` / `btnSelNone`）**全无** |

- **S10 变异电池 9 条**（`tmp/s10-mutate.mjs`：逐条独立改写 → 跑测试 → 字节级还原后比 sha，服务端两文件全部回到基值 `lib/clean/service.js 55e6ef4a5b83182d` / `client.js 71a5bc0211c44a1d`；锚点命中逐条硬校验 =1、行尾按 CRLF 归一）：`m1`（帧去掉 phase）→ `cs-12` + `hc-13` 红；`m2`（不发首帧）→ `cs-12` 红；`m3`（done 帧去掉 phase）→ `cs-12` + `hc-13` 红；`m4`（全选口径退回「只选低风险」）→ `pg2-5` + `pg2-28` + `pg2-29` 红；`m5`（pill 里又塞回整句）→ `pg2-31` 红；`m6`（容器撤销限高）→ `pg2-32` 红；`m7`（三态撤销）→ `pg2-28` 红；`m8`（耗时读数撤销）→ `pg2-30` 红；`m9`（表头不吸顶）→ `pg2-32` 红。**9/9 命中、无一条 SKIP**；还原逐条报「字节级一致 ✓」，事后无 `.bak` 残留、基值 sha 复核一致。

**残余真机步骤**：本轮 ① 的修点在**宿主半边**（`lib/clean/service.js` 的扫描帧）⇒ 要**重启 dsh web**（连同 S9 起压着的宿主改动一起）；②③④ 在浏览器半边，刷新页面即可。合起来以「**重启 dsh web + 刷新页面**」为准。真机复核点：① 点「开始扫描」后**立刻**（不是十来秒后）空态卡翻成「扫描进度」并开始跳「已用时 N 秒」，页头按钮变灰写「扫描中…」；② 清单表在自己的框里滚、表头贴框顶，整屏高度不随清单增长；③ 表头一颗三态全选框，勾满后页脚提示「含 N 项有风险…」且「清理选中」可用；④ 风险列每条只有一枚标签（可清理/有风险/已拒绝），解释句一句话只出现一次。
**未提交**（本地改动不主动提交，等用户真机复核通过后与 #44 / S5~S9 合并为一次提交）。
### 8.9 真机第十一批：扫描仍无进度 / 排序与一键安全清理 / Everything 检不到（2026-09-29，S11-①②③）

**症状（用户第六批真机截图两张 + 三条编号原话，图上另有两条红框批注）**：

| # | 用户原话 / 批注 | 圈定范围 | 性质 |
|---|---|---|---|
| S11-① | 「现在点击开始扫描，还是没有扫描进度展示效果」 | 清理页扫描卡 | §8.8 的修法只解决了一半：帧说了，但**宿主没机会说** |
| S11-② | 「可以安全清理得排在最前面，按等级顺序排列」+ 批注「增加一键清理按钮，可安全清理，清理过程要有动画展」 | 待清理清单排序 / 卡头动作 / 执行反馈 | 清单按扫描顺序铺（真机 513 项里前 20 行全是「有风险」），一键口径与执行过程都没有 |
| S11-③ | 「文件搜索有问题」+ 批注「已安装为什么还是检测不到」 | 搜索页自检卡 | ①未探到已安装 / ②两条通路都没有（HTTP 404）/ ③未执行 —— 三级全红，而 Everything 实际在跑 |

**S11-① 根因 —— `async scan()` 里一个 `await` 都没有，整段遍历跑在同一个宏任务里。**
§8.8 给帧带上了 `phase`，但宿主是单线程：`runScan()` 从第一条规则到最后一条规则之间不交还事件循环，dsh 的 HTTP 响应（含 SSE `emit`）就排不出去。真机口径下这一堵就是十来秒 —— 于是「首帧 +6ms」这种在**进程内**看到的漂亮读数，浏览器端一个字节都收不到，直到 `/clean/scan` 返回才一次性刷出来。判别手段是**宏任务金丝雀**：扫描期间挂一个 50ms 的 `setInterval`，它跑掉的次数就是「事件循环有没有被交还」的直接证据（进程内给帧打时间戳会骗人，因为 `emit` 只是把数据写进缓冲区）。

**修法 —— 协作让出，两处。**
1. `lib/clean/scanner.js`：遍历循环每 `DEFAULT_YIELD_EVERY = 200` 个条目 `await tick()` 一次（`tick` = `setTimeout(0)` 的封装，测试可注入）。
2. `lib/clean/executor.js`：**每条**条目动手前先让出一次 —— 逐条 `clean:item` 帧要一条一条到界面，才有「清理过程」可看（S11-② 的动画依赖这一条）。
3. 两处都不改判定口径：guard 仍是唯一裁决者，冻结快照仍是唯一执行对象。

**S11-② 修法 —— 排序 + 一键安全清理 + 就地确认行 + 执行面板（四件，全在浏览器半边；面板的帧来自宿主 executor 的逐条 `clean:item`）。**
1. 排序：`RISK_RANK = { 可清理:0, 有风险:1, 已拒绝:2 }`，`planRows()` 出表后按它排；**只排显示行，不动 `plan.items`**（清单是扫描那一刻的冻结快照，执行对象按 id 取，重排快照会让「勾了什么」与「留痕里写了什么」对不上）。
2. 一键安全清理的口径与 §8.8 表头全选**故意不同**：`safeCleanIds()` = `!denied && riskLevel !== 'mid'`（只挑「可清理」），而全选是「未拒即可选」。前者是「闭眼点它不用看第二眼」，后者是「我要一次清干净，接受被锁的跳过」——两个诉求两颗入口，混成一个就有一个是错的。
3. 就地确认行（spec §4 禁浮层）：卡头按钮点开的是卡片内的一行说明 + 「确认清理 / 取消」，写明项数、预计释放、以及「有风险 N 项与已拒绝 M 项一概不动」。
4. 执行面板：`.so-run` 落在清单卡内，头部一颗呼吸点（`is-running` 时 `animation: so-pulse .9s`）+ 「正在清理 第 N / M 项 · 成功/跳过/失败/拒绝」+ 进度条（`.so-track>i{transition:width .25s}`，宽度按已处理数算，未收尾封顶 99%）+ 逐条结果列表（最新在上，最多留 8 条）。收尾后面板**留在「清单已失效」卡上**，不消失 —— 用户点完最后一下要看得见它做成了什么。执行期间三颗写入按钮（一键 / 隔离 / 清理选中）全部禁用，理由写在 title 里。

**S11-③ 根因 —— 两条独立错误叠在一起。**
1. 安装探测把 `C:\Program Files\Everything\Everything.exe` 写死：本机 Everything 装在别处（且便携版合法）⇒ ① 恒红。改为**基址取环境变量**（`%ProgramFiles%` / `%ProgramFiles(x)%` / `%LocalAppData%` 等，不焊死盘符）+ PATH + 设置页指定路径三处任一命中，并且**HTTP 端口在应答即算已装**（服务在跑就是装了的最好证据）。
2. 查询走 `/fq/`：本机这台 Everything 的 HTTP 服务器对该路径直接回 **404 text/html**（`tmp/s11-everything.txt` 存了两条原始应答的对照：`/fq/` → 404，根路径 + `json=1` → 200 JSON）。真实体形状也不是早期文档猜的样子：`{ totalResults, results:[{ type, name, path, size, date_modified }] }`，其中 `path` 是**父目录**、`size` 是**十进制字符串**（文件夹为空串）、`date_modified` 是 **FILETIME 字符串**（1601 起 100ns 刻度）⇒ 原来的 `Number.isFinite(r.size)` 一律 false，界面就成了「搜到了但什么都没有」。
3. 修法：URL 改根路径 + `json=1&path_column=1&size_column=1&date_modified_column=1&sort=path`；`toSize()` 收字符串字节；`toMtimeMs()` 靠量级区分 FILETIME / unix 秒（`ft/10000 − 11644473600000`）；`joinFull()` 把 `path + name` 拼回全路径再交给 `normalize()` 拆。缺字段一律记 `null`，不把「未知」当「0 B」。

**验证读数（同一轮现采）：**

- 探针 `tmp/probe-s11-stream.mjs`（真 fs + 真 scanner，宏任务金丝雀 50ms）：

  | 读数 | 让出前（`yieldEvery=MAX_SAFE_INTEGER`） | 让出后（默认 200） |
  |---|---|---|
  | 扫描耗时 | 7361ms | 6282ms |
  | 进度帧 | 30 帧，首帧 +6ms / 末帧 +7256ms | 26 帧，首帧 +3ms / 末帧 +6253ms |
  | 金丝雀跑掉次数 | **0 次** | **113 次** |
  | 最长空档 | 0ms（一次堵到底） | **64ms** |

- 探针 `tmp/probe-s11-everything.mjs`（本机真读数，`tmp/s11-everything-live.txt`）：三级探测 `installed=true http=true es=false e2e=true ready=true via=http level=e2e`；①「未在常见路径找到 Everything.exe，但 :3417 的查询服务在应答 ⇒ Everything 正在运行」，②「HTTP 200：查询服务可达」，③ 真查 `win.ini` 两行带 size 与折算后的 mtime（`92 B · 2022-05-07T05:22:32`）。
- 9 个测试文件全 exit 0，合计 **429/429**：`alerts 34 · clean 66 · client 135 · collect 48 · guard 19 · host-compat 24 · plugin 37 · prefs 29 · search 37`（client 127→135 是 `pg2-34`~`pg2-41` 八条：排序、一键口径、面板逐条、进度封顶、按钮闸门、确认行、终态面板、动画源码锁；clean 64→66 是 `cln-13` / `ex-13` 两条让出证人；search 30→37 覆盖 URL、size 字符串、FILETIME、`path` 拼接与 installed 判据这五处口径——具体哪条咬住哪处，见下面变异电池 `m3`~`m8`）。`SKIP_LOCAL=1`：422（clean 65、client 134、host-compat 22、search 34 —— 点名真机的用例按约定 SKIP）。
- **真浏览器对照实测**（headless Chrome + CDP 零依赖，`tmp/verify-s11.mjs` 走 `tmp/preview.html?mode=s11-plan|s11-scanning`；预览桩这一轮开了 `__pushFrame` / `__releaseApply` 两个口子，好让「逐条来帧」和「整批回包」的真时序能演出来。截图 `tmp/s11-{plan-sorted,safe-ask,run-anim,run-done,scanning,search,proto-run}.png`）：

  | 读数 | 值 |
  |---|---|
  | 清单排序 | 26 行 pill 序列 = 17×可清理 → 8×有风险 → 1×已拒绝；`可清理全在前段` ✓、`风险段在拒绝段之前` ✓；卡头计数 `共 26 项 · 可清理 17 · 有风险 8 · 已拒绝 1`；快照本身未重排（`plan.items[0].id` 仍是原首项）；表仍在自己框里滚（clientH 468 / scrollH 1981） |
  | 一键安全清理 | 卡头 `一键安全清理 17 项`，title `只清理标「可清理」的 17 项（3.74 GB），有风险与已拒绝的都不动`；点开后确认行在**清单卡内**（`insidePlanCard=true`、`position:fixed` 祖先 **null**），文案 `将永久删除 17 项「可清理」（预计 3.74 GB）…标「有风险」的 8 项与「已拒绝」的 1 项一概不动；回收站不参与，删掉不可恢复` |
  | 执行面板逐条 | 点「确认清理」→ `第 1 / 17 项 · 成功 0`（条宽 0px）→ 帧 1 到 `第 2 / 17 · 成功 1`（**同一帧之后 180ms 条宽 29px → 66px**，过渡的实证）→ 帧 2 `第 3 / 17 · 成功 2`（132px）→ 帧 3 `第 4 / 17 · 成功 2 跳过 1`（197px，EBUSY 那条记「跳过」并列在最新一行）→ 帧 4 `第 5 / 17 · 成功 3`（263px） |
  | 执行期闸门 | `一键安全清理` / `隔离到暂存目录` / `清理选中` 三颗 `disabled=true`（原因在 title）；POST body 只带 17 个「可清理」id，`mode:'delete-file'` |
  | 收尾 | `so-run is-done`，头 `本次清理已收尾 第 5 / 17 项 · 成功 3 · 跳过 1 · 失败 0 · 拒绝 1 · 已用 2 秒`（`rejected-snapshot` 那条进「拒绝」桶），面板留在 `清单已失效` 卡上，`清理留痕` 卡随后 |
  | 扫描卡（S11-①） | 三条 `clean:progress` 帧逐条落地：`已遍历 1,200 … 305 MB / 已用时 8 秒` → `48,400 … 1.02 GB / 9 秒` → `96,800 … 1.77 GB / 12 秒`，当前目录三跳（Temp → pnpm\store → Code\Cache），页头按钮「扫描中…」、**无**「尚未扫描」卡 |
  | 搜索页（S11-③） | 自检卡三枚 pill `已装 / HTTP 3417 / 试查询通过`；真跑一次 `win.ini`：结果表 4 行，`92 B · 2022/5/7 13:22:32`、`214 KB · 2023/11/14 02:26:40`，缺字段的行显示 `—` 而不是 `0 B`，来源 pill `来源：Everything HTTP` |
  | 原型页 | 11 行 pill = 8×可清理 → 1×有风险 → 2×已拒绝；`一键安全清理 8 项`（5.23 GB）+ 就地确认行；面板 `正在清理 第 3 / 8 项` → `card-body run-panel is-done`，戳 `清理已执行 · 清单已失效，请重新扫描（22:41:13）` |

- **截图核对时抓到的一处自伤**：`.so-run` 面板底色取 `--so-soft`，里面的 `.so-track` 槽也取 `--so-soft` ⇒ 槽不存在，截图里只剩一条实心黑线（看不出走了多少）。改 `.so-run .so-track{height:4px;background:var(--so-bd2)}`（原型 `.run-panel .track` 同改），并把它写进 `pg2-41` 的源码锁 + 变异体 `s11-m19`。
- **S11 变异电池 19 条**（`tmp/s11-mutate.mjs`，逐条 apply → 跑对应测试 → restore 比 sha）：`m1` scanner 不让出 → `cln-13` 红；`m2` executor 不让出 → `ex-13` 红；`m3` URL 退回 `/fq/` → `sh-1` 红（连带 3 条）；`m4` 十进制 size 当数字 → `sh-2` 红；`m5` FILETIME 不折算 → `sh-2` 红；`m6` `path` 当全路径 → 2 条红；`m7` installed 不看 HTTP 应答 → `pb-10` 红；`m8` 候选路径写死 C 盘 → `pb-11` 红；`m9` 不排序 → `pg2-34` 红；`m10` 一键口径放宽到含 mid → `pg2-35` 红（3 条）；`m11` 行内 count 丢失 → `pg2-34` 红；`m12` 面板不封顶 total → `pg2-36` 红；`m13` 结果列表不截断 → `pg2-36` 红；`m14` 进度不封顶 99% → `pg2-37` 红；`m15` 一键按钮不加闸门 → `pg2-38` 红；`m16` 确认行执行中还能再点 → `pg2-39` 红；`m17` 终态卡不留面板 → `pg2-40` 红；`m18` 动画 CSS 撤掉 → `pg2-41` 红；`m19` 槽与面板同色 → `pg2-41` 红。**19/19 命中、0 条 SKIP**，还原逐条「字节级一致 ✓」，事后无 `s11-mut-*.bak` 残留，全量复核 429/429。

**残余真机步骤**：S11-① 的修点在**宿主半边**（`lib/clean/scanner.js` / `lib/clean/executor.js` 的让出）⇒ 要**重启 dsh web**（连同 S9~S10 压着的宿主改动一起）；②③ 的界面半边刷新页面即可，③ 的探测与解析在宿主半边、同批重启。真机复核点：① 点「开始扫描」后扫描卡的「已遍历 N 个条目 / 已用时 N 秒」应**持续跳动**（不是十来秒后一次到位）；② 清单里「可清理」排在最前，卡头「一键安全清理 N 项」点开是卡内确认行，确认后进度条逐条走、逐条结果往上顶，收尾面板留在「清单已失效」卡上；③ 搜索页自检三级全绿（①「未在常见路径找到但端口在应答」也算已装），搜 `win.ini` 出得来大小与修改时间。
**未提交**（本地改动不主动提交，等用户真机复核通过后与 #44 / S5~S10 合并为一次提交）。

### 8.10 真机第十二批 S12-④：搜索页「＋ 添加目录」点了没反应（2026-09-29）

**症状（用户第五处截图标记）**：「搜索这个位置放得太下了」那一页上，限定目录的「＋ 添加目录」**点下去什么也没发生** —— 没有 chip、没有说明、没有异常。

**根因（四处叠在一起，全在浏览器半边 `client.js`）**：

| # | 位置 | 病灶 |
|---|---|---|
| 1 | `doSearchAddDir` 的重复分支 | 命中重复时 `return { ok:true, data:null }` **静默**返回，界面一句话都不说 ⇒ 看起来就是「没反应」 |
| 2 | 那颗按钮的 `onClick` | 把 `onAddDir` 返回的 Promise **丢掉不接**：既不等宿主确认，也不清空输入框，更没有失败分支 |
| 3 | `onMode` / `onLimit` | 只 `setSrchMode` / `setSrchLimit` 改本地 state，**从不写 prefs** ⇒ 下次进本页又弹回默认档（同一处病灶的另一半） |
| 4 | 读回宿主回显那行 | 写成 `Array.isArray(...).walkDirs` —— 恒 `undefined`，等于从来没吃过后端返回的那一份 |

**修法 —— 一处出口，不做乐观更新。**
1. `saveSearch(patch, okText)` 是搜索页写 `search` 组的**唯一出口**（walkDirs / mode / limit 三条都走它，一份真相）：`writePrefsGroup('search', patch)` → 失败就把 `没写进库（宿主拒了或读不回来）…` 落在原地；成功才吃 `r.data.prefs` 回显重画。
2. `searchFromPrefs(prefsRow, fallback)` 逐字段回落：只有宿主回显里**缺**这个字段才用界面现值，缺什么说什么，不整组替换。
3. **不乐观更新**：写成功之前 chip 不许多也不许少；写失败时通路段仍亮在原来那一档（`cn-21` 的失败路断言）。
4. 就地交代行 `.so-savenote`（spec §4 零浮层）：成功说「存进了哪一份」（`已写入覆盖范围：X（现共 N 个目录…）` / `通路已存进偏好：…` / `返回上限已存进偏好：N 条`），不写库的两条路也各有话说 —— 空输入 `目录输入是空的：先粘贴绝对路径…`、重复 `第 N 条已经是它了：覆盖范围没变，也不用重复添加。`
5. 点按钮与按回车走**同一个** `submitDir`；输入框只在宿主确认写入之后清空（没写进去时那行字留在框里，用户看得见自己刚输了什么）。
6. 在途锁两把：`srchSavingRef`（同步，挡同一拍的第二次提交）+ `saving` props（渲染期禁用按钮/输入框/chip 的 ×，按钮就地改口「保存中…」）。prefs 是**单行整记录覆盖写**，双击叠两笔就是第二次覆盖 —— 这把闸必须有证人。
7. 原型 `prototype/index.html` 同批改：原来那颗「＋ 添加目录」是 `renderDirs()` 拼出来的**虚线假 chip**（没有输入框、没有 handler）。现在换成真 `#dirInput` + `#btnAddDir` + `#dirNote` 交代行，文案与时机逐句对齐 `client.js`，宿主那一次整行写用 320ms 本地模拟；`syncControls()` 成为控件 active/disabled/title 的唯一出口，`currentMode()` 改成「偏好档 + 通路就绪」的 effective 档（与 `modeOf` 同规）。

**验证读数（同一轮现采）：**

- 9 个测试文件全 exit 0，`SKIP_LOCAL=1` 下合计 **467**：`client 157（1 条 SKIP：pg3-16 点名真机） · clean 81 · collect 48 · alerts 34 · search 34 · plugin 40 · prefs 29 · host-compat 25 · guard 19`。新增三条真接线用例：`cn-20`（一次点击一次写 / 空输入与重复都有话说 / 回车同规 / 整行写没抹掉 collect·clean·alerts）、`cn-21`（通路 + 上限各一笔写；宿主回 500 时界面一格不改口，「没写进库」与「接口异常」同时可见，成功那句不许说出口）、`cn-22`（同一拍连点两下只落一笔；跨渲染的第二次提交被禁用挡下，按钮标「保存中…」，被锁掉那条不许出现在覆盖范围里）。
- **真浏览器对照实测**（headless Chrome + CDP，`tmp/verify-s12d.mjs`，截图 `tmp/s12d-1-preview-add.png` / `s12d-2-proto-add.png` / `s12d-3-proto-note.png`）：

  | 读数 | 真 client（预览页，fetch 桩） | 原型页 |
  |---|---|---|
  | 进页初始 | 通路 pill 在「全盘索引」，覆盖范围行不出现（探针 ready + `search.mode=everything`） | 探针未就绪 ⇒ effective 档落「限定目录」，「全盘索引」`disabled=true` + title `通路未就绪 —— 暂不可选` |
  | 切「限定目录」 | 一次 POST，回显后 chip 长出，交代行 `通路已存进偏好：限定目录 —— 下次进本页仍是这一档…` | 同文案（`is-ok`），`dirs 5 → 5` |
  | 空输入点按钮 | `posts() 增量 = 0`，交代行 `目录输入是空的…`（`so-savenote-bad`） | 同文案（`is-bad`），输入框不动 |
  | 重复目录 | `posts() 增量 = 0`，`第 1 条已经是它了…`，输入框清空 | 同文案，`dirs` 不变 |
  | 新目录 | 一次 POST；库里 `walkDirs=[原…, F:\dsh-plugins\docs]`，**同批写回的 collect / clean / sources / alerts 逐组幸存**；chip 立刻长；输入框清空 | 在飞读数：按钮 `保存中…` + `disabled=true`、输入框 `disabled=true` 且**原文还在**；落定后 `dirs 5→6`、输入框清空 |
  | 回车提交 | 与点按钮同规：`posts()` +1、`dirs` +1、`已写入覆盖范围：C:\Users\gongj\Downloads（现共 3 个目录…）` | 同规：`dirs 6→7` |
  | 上限 50 | 一次 POST，`search.limit=50`，交代行 `返回上限已存进偏好：50 条` | 同文案，seg 的 `is-active` 落到 50，结果表头「上限 50」 |
  | 移出目录 | `已移出覆盖范围：…（现共 2 个目录）`，`dirs -1` | 同文案，`dirs 7→6` |
  | 持久化 | 切到「资源监控」再回「文件搜索」：通路仍是限定目录、上限仍是 50、覆盖范围仍是 2 条，且与服务端最后一次 POST 的 `search` 组逐字段一致 | ——（原型无宿主库，本地状态即那一份） |
  | 浮层 | `[class*=toast],[role=dialog],.so-modal` = **0** | 同 **0**；虚线假 chip 已从 DOM 消失 |

- **一处抓不到的读数，如实记**：预览桩的 `POST /prefs` 在同一个宏任务里就 resolve，所以真 client 页上「保存中…」那一档在浏览器里来不及采到（`pv4_inflight` 采到的已是落定态）。这把闸的证人是 `cn-22`（`slowPost` + `releasePost` 把在途窗口撑开）与原型的 `pr3_inflight`（320ms 模拟里采到按钮换文案、输入框禁用且保留原文）。
- **S12-④ 变异电池 8 条**（`tmp/s12d-mutate.mjs`，逐条 apply → 跑 `client` → restore 比 sha）：`m1` 不发写（回到不持久化）→ `cn-21` 红（连带 3 条）；`m2` 撤 `srchSavingRef` 同步锁 → **第一轮是绿的**，说明 `cn-22` 当时只测了跨渲染那把 props 闸 —— 给 `cn-22` 补「同一拍连点两下」后才咬住（1 条红）；`m3` 写失败不短路 → `cn-21` 红；`m4` 不吃宿主回显、界面自己记笔账 → `cn-20` 红；`m5` 写完不清空输入框 → `cn-20` 红；`m6` 重复检测失效 → `cn-20` 红；`m7` 空输入也去写 → `cn-20` 红；`m8` 回车不提交 → `cn-20` 红。**8/8 命中**，逐条「字节级一致 ✓」，事后无 `s12d-mut-*.bak` 残留、`client.js` 内 0 处「变异体」。

**本轮另有一处必须记账的事故（我自己造成，已向用户当面说明）**：取证脚本 `tmp/s12d-probe.mjs` 读宿主响应时取 `body.prefs` 而不是 `body.data.prefs`，于是它「原样写回」的那一步实际写了空记录，**把真机 `sysops_prefs` 那一行抹掉了**（提醒阈值、采集节奏、源开关、搜索通路/覆盖范围/上限/端口、清理暂存目录与保留天数全部回落到插件默认）。KV 文件没有历史版本，`clean_rules` 本来就是空的，`sysops_records.json`（留痕与冻结清单）未受影响，无法恢复原值。由此立下的规矩已写进项目记忆：对真机宿主的探针**只允许 GET**；不许写「测完原样写回」的恢复步骤；响应必须整份原文落盘；任何「读回来看某组」的代码必须先过 `.data` 信封。

**残余真机步骤**：S12-④ 全在**浏览器半边**（`client.js`）+ 原型静态页 ⇒ **不需要重启 dsh web**，刷新页面即可。真机复核点：① 限定目录里输入绝对路径点「＋ 添加目录」—— 要么 chip 立刻长出来并有一行绿字说明存进了哪一份，要么就地说不写的原因（空/重复），不许出现「点了没反应」；② 切通路、改上限之后离开本页再回来，档位仍是走的那一档；③ 因为上面的事故，**用户此前设过的偏好需要重设一遍**（提醒阈值 / 采集节奏 / 源开关 / 暂存目录等）。
**未提交**（本地改动不主动提交，等用户真机复核通过后与 S5~S12 其余批次合并处理）。

### 8.11 真机第十二批 S12-①②③⑤：留痕入口 / 页头降噪 / AI 智能清理 / 一键安装 Everything（2026-09-29，S12-A~E 收口于 S12-F）

§8.10 记的是 S12-④（添加目录）。同一轮用户截图上还标了四处，分别落在 S12-A（清理流程与信息架构对齐主流工具）、S12-B（①②）、S12-C（③）、S12-E（⑤）。四批的实现与用例在各自回合里已并入仓库，本节把**口径裁定**与**收口验证**记成一整段，避免同一句话在四个小节里各说一遍。

#### ①② —— 留痕搬页头、页头降噪、红线那条挪到最下面（S12-B）

| 用户批注 | 裁定 | 证人 |
|---|---|---|
| 「清理留痕不要放在这里」「放这里，点击弹框滚动查看」 | 留痕从页面底部那张常驻卡改成**页头入口 + 就地展开面板**。展开的是页面里的一个限高滚动框（`.so-logpanel`），**不是浮层** —— spec §4 的零 toast/modal 没有放宽；滚动只在这一个框内（与 S10「不许整屏滚」同规）。展开态挂在容器上（页面本体零 `useState`），页头那颗按钮是唯一入口，收起态 DOM 里连滚动框都不该有。 | `pg2-51`（纯渲染形状）+ `cn-17`（真点下去会开合，收起态查不到滚动框） |
| 「这几个不要展示」 | `link === 'sse'` 是健康态，**不再挂「推送通道 SSE」那一行**；只有 `polling` / `reconnecting` 才作为降级如实标注。 | `pg2-52` + `cn-17`（活体页面 `link=sse` 时也查不到这句） |
| 「（红线条）放在最下面展示」 | 那条琥珀说明从「扫描范围」卡里挪到清理页最下面，并且**全页只有一句** —— 挂在哪张卡上都会被抓成那张卡的私事，裁决说明是整页的。 | `pg2-53`（位置 + 只有一句）+ B3 变异 |

**S12-F 收口时新抓到的一处原型缺陷（真浏览器才看得见）**：`prototype/index.html` 里 `.notice{display:flex}` 把 UA 的 `[hidden]{display:none}` 盖掉了 ⇒ 安装确认行 `#installAsk` 即使 `hidden=true` 仍画成一条 **1094×20 的空琥珀色横条**（`tmp/proto-hidden.mjs` 读数；DOM 侧 `askHidden:true` 完全看不出来）。补一条全局 `[hidden]{display:none !important}` 后 hidden 元素 painted 列表为空。同一处缺陷还潜伏在 `#quarNote`（悬停才现身，所以一直没被看见）。证人：`tmp/prototype-check.mjs` 的文案/符号清单里加了这条规则。React 半边不受影响 —— 那里从不渲染 hidden 节点，而是根本不渲染。

#### ③ —— AI 智能清理：只推荐 + 就地确认（S12-C，已批边界）

审批下来的边界是 **AI 只出建议，执行仍由人点**；本节把它落成三条可测的硬话：

1. **按钮决策表只有一张**（`aiButton`）：六种「亮不起来」各说一句，其中「还没问到宿主模型」与「宿主没有模型」是两句不同的话（就绪度没读到 ≠ 能力不存在，与 `lib/caps.js` 同口径）。界面只渲染这张表交出的话。
2. **采纳集合 = 被勾上那些类的 `ids` 并集**（`aiAdoptIds`）：ids 全部来自服务端按冻结快照反查的结果，页面不产 id、不做任何路径判定 —— 能并进来的东西勾选框里本来就有，并进来之后仍要点「清理选中」才动手。
3. **发给模型的只有分类汇总与 basename**：`ai-advisor.js` 的样本走 `baseName(it.path)`；prompt 里出现反斜杠、盘符、本机用户名任一种都算失败（`ai-3`）。失败按 `code` 分支，绝不匹配 message 文本；`reasoning-delta` 只记字数、绝不累加进正文（`ai-12`：JSON 只藏在思考里 ⇒ 按「无正文」失败，不冒充成功）；`promptHash`（`fnv1a-xxxxxxxx`）留作对账抓手。
4. 全程 **零 `clean/apply` 请求**：`cn-18` 数的是网络出口，不是界面文案。三种「问不出结果」（没模型 / 征求失败 / 分类对不上）分开说，且都不发 apply（`cn-19`）。

证人：`pg2-54`（按钮决策表）、`pg2-55`（三档动作一表）、`pg2-56`（采纳集合）、`cn-17`~`cn-19`（真接线）、`ai-1`~`ai-13`（宿主侧）、`pg4-9`（能力表 ai 行不是开关）。

#### ⑤ —— Everything 一键安装（S12-E）：winget 代跑，四道闸

旧口径「本插件绝不代装软件」随用户批准作废，改口写进 `index.js` 红线段、`probe.js` 头注释与 `ADVICE[0]`、`client.js` 的 `guideOwn`、原型引导卡，**四处同文**（`ADVICE` 保持三条同序）。换来的四道闸：

| 闸 | 内容 | 证人 |
|---|---|---|
| 参数永不采信前端 | `start()` **零形参**；包 id / 源 / 命令全是 `lib/search/installer.js` 的常量，路由层 `handler` 也不把 `req` 体转进去 | `in-3`（逐字参数表 + `start.length === 0`）、`rt-42` |
| 非 shell | 只经注入的 `execFileMod`，`options` 里没有 `shell` | `in-3` + IN-7 变异 |
| 先探再起 | `winget --version` 探不到 ⇒ `SEARCH_INSTALL_UNAVAILABLE`（503），**按钮根本不亮**，原因用宿主原话回显 | `in-1`、`rt-41`、`CL-3` 变异 |
| 一次只跑一装 | 已有在跑 ⇒ `SEARCH_INSTALL_BUSY`（409），并回「已经跑了 N 秒」 | `in-4`、`rt-43` |

进度走 SSE（`search:install` 帧 `running`/`done`/`failed`），不轮询；装失败 ⇒ 探测缓存作废（PATH 改好了下一次能探到）；装成功 ⇒ `probe.invalidate()`（① 已装那一档立刻翻绿）。探测结论 TTL 120s，避免每帧 spawn。

**本轮截图核对抓到的三处文案/结构缺陷（都已修 + 补证人）**：
1. 交代行 `installNote` 原本嵌在 `ib.show ? … : null` 里面 ⇒ 装成功那一瞬 ① 翻绿、按钮整块收起，**恰好在这句话最该看的时候一起消失**。挪到按钮块外面（`pg3-4` ⑥ 钉住「按钮收起、交代行不许跟着收」）。
2. 终态文案把「① 已安装」说两遍（内联前缀 + `installNeedHttp` 各带一个 ①）。前缀删掉，`pg3-4b` 逐分支钉文案并断言 `①` 只出现一次。
3. 引导卡最后一行重述了宿主 `ADVICE[2]` 的「勾选 工具 → 选项 → HTTP 服务器」⇒ 同一句话两张卡。静态行改成只补动态事（本机实际用哪个端口 + 去哪改），`pg3-3b` 断言「勾选」在引导卡里只许出现一次且必须是宿主注入的那条。

证人：`in-1`~`in-10`、`rt-41`~`rt-44`、`pg3-3`/`pg3-3b`/`pg3-4`/`pg3-4b`。

#### S12-A —— 清理流程与信息架构对齐主流工具（同一批的地基）

用户第一问「现在 C 盘清理到底扫了哪些目录」在 S12-A 里同时变成**数据问题**和**信息架构问题**：

- **真数从哪来**：真机 `fs.statfsSync()` 只交 `bsize/blocks/bfree/bavail`，**没有 `available`、没有 `total`**（现采 `tmp/s12-disk.txt`）。清理侧三处早先都写 `?.available` ⇒ `beforeFree` 恒 0、`afterFree` 恒 null，留痕里「释放了多少」在真机上从来没真过。测试全绿是因为**假桩给了宿主根本没有的键**（与 §8.7/S9 同型）。修法：折字节单点收进 `lib/disk.js` 的 `statfsBytes`，缺字段交 `null` 不凑 0；源码锁 `cln-14` 规定别处不许再读 `.available/.total`；`dk-1` 的形状桩只写真机有的键。
- **扫了哪些目录**：`scanScope` 只吃 `GET /api/rules` 的公开字段（`id/n/kind/ageDays/rel/enabled`），扫描范围卡逐条列被扫目录，**只出 `~/rel` 不出绝对路径**（`dir`/`glob` 展开含本机私有路径，永不出接口，Ruling-106），页面也不拼绝对路径。`total` 与宿主 `activeRules()` 同式：开启的内置 + 用户自建；停用另起一行说明「不在本次范围」。
- **分类视图 + 只筛显示不动勾选**：`categoryGroups` 按命中规则成组、大小降序，每组给项数 / 合计 / 三档计数 / 全部 id / **未拒 id**（「全选本组」只吃未拒那份）。分组只服务摘要与筛选，列表顺序仍按风险等级（S11-② 那批「可清理」不能被重新埋回几百行）。
- **容量口径单点**：`capText` 1024 进制标 GB（与资源管理器、监控页同口径，原来一处除 1e9 一处除 2^30，同一个数差 7%）；服务端读失败的 `0` 统一说「未读到」；分档阈值收进 `DISK_BAND`（监控页格与概览条共用，两处读数不许一处黄一处绿）。
- **进度分母换域**：帧带 `ruleIdx/rulesLen`（第 N 类 / 共 M 类），旧宿主不给就不凑百分比。

#### 验证读数（S12-F 收口轮现采，2026-09-29 深夜）

- **9 个测试文件全 exit 0，`SKIP_LOCAL=1` 下合计 483**：`client 159 · clean 81 · collect 48 · search 44 · plugin 44 · prefs 29 · alerts 34 · host-compat 25 · guard 19`（`tmp/s12f-suites.txt`）。
- **变异电池两组合计 35 条，全部命中、逐条字节级还原**：
  - `tmp/mut_s12abc.mjs`（S12-A/B/C 补跑，这三批当时只留了测试与截图、没留电池脚本）：**16/16 红**，`allRestored: true`（`tmp/s12f-mut-abc.txt`）。**第一轮放走两条**，如实记下：`A3`（概览条阈值 `band(usedPct, 85, 92)` 改成 `80, 90`）与 `A8`（`statfsBytes` 字段缺失返回 `{total:0, free:0}`）都是绿的 —— 前者因为 `pg2-43` 只测了 90% 一个点（换阈值后仍落 warn），且 85/92 这两个字面量在监控页与概览条**各写一遍**（本身就是第二份真相）；后者因为 `dk-1` 的 junk 用例没覆盖「`bsize` 非法」这条早退分支，且电池把它派给了 `collect` 套件（用例其实在 `clean`）。补法：阈值收进 `DISK_BAND` 单点 + `pg2-43` 加 85.0/86.0/93.0 三个边界读数 + 与 `MON.mtrRows` 逐档交叉核对 + 源码锁「两处都吃 DISK_BAND」；`dk-1` 加真机形状桩（只带真机有的键）断言可用只认 `bavail×bsize`；`A3` 锚点改指 `DISK_BAND`、`A8` 套件改指 `clean`。第二轮 16/16。
  - `tmp/mut_s12e.mjs`（S12-E）：**19/19 红**，`allRestored: true`（`tmp/s12f-mut.txt`；`installer.js 6945c282134f · client.js · api.js c1ae0a05326c` 三份还原前后 sha 相同）。
- **真浏览器核对**（headless Chrome + CDP，三份脚本各 exit 0）：
  - `tmp/verify-s12e.mjs` → `tmp/s12e-verify.txt` + 7 张图：预览页 `?probe=no`（按钮 → 就地确认行含命令原文 → 取消零 POST → 确认恰好 1 次 POST 且请求体无字段 → `running`/`done` 帧 → 交代行 → 重新检测）、`?probe=no&winget=no`（按钮不亮 + 宿主原话）、原型页全流程。读数：`fit {overflowY:0, overflowX:0, gapToEdge:1}`、`floaters:0`、`title=本次安装正在进行（已经跑了 0 秒…）`、终态行 `…① 已安装已翻绿；② 查询通路还要你在 Everything 里勾选 HTTP 服务器才会绿…`（① 只一次）。
  - `tmp/verify-s12c.mjs` / `tmp/verify-s12b.mjs` 复跑（`[hidden]` 修复与 `DISK_BAND` 之后）：`tmp/s12f-verify-c.txt` / `tmp/s12f-verify-b.txt`，分类条大小降序（1.63 → 1.24 → 1.11 → 1.02 GB）、页头「清理留痕 2」开合、红线说明在页面最下面、`floaters:0`、`protoConsole:0`。
  - 逐张看图核对（黑块事故立的规矩）：`s12e-1-button` / `s12e-2-ask` / `s12e-3-running` / `s12e-4-done` / `s12e-5-nowinget` / `s12e-6-proto` / `s12e-7-proto-ask` / `s12c-4-proto-panel` —— 宿主 token 配色生效、无黑底黑字、无浮层、无空横条。

**残余真机步骤**：S12-①②③ 与 ④ 都在浏览器半边 + 原型，刷新即可；**S12-⑤ 动了宿主半边**（`lib/api.js` 新增 `GET /api/search/install/ready`、`GET /api/search/install/state`、`POST /api/search/install`，`lib/search/installer.js` 是新模块）⇒ **必须重启 `dsh web`** 才有这三条路由，没重启时界面就地说明「路由还没到」而不是画一条全屏错误。重启后复核：① 自检卡未就绪时引导卡顶部那颗按钮；② 点它先出就地确认行（含命令原文），取消 = 什么都没发生；③ 确认后才 POST，进度走 `search:install` 帧；④ 装完 ① 立刻翻绿、按钮收起、交代行留下；⑤ `node tmp/probe-live.mjs 3080 > tmp/s11-live.txt`（**只允许 GET**）。

**未提交**（四批连同 S12-④ 一起等真机复核通过后再合并处理）。

### 8.12 真机第十三批 S13：清理页空闲态「占地方又没用」—— 扫描范围收成一行摘要 + 空态压薄（2026-09-30）

用户贴的是**真机空闲那一屏**的截图，红框圈住整张「扫描范围」卡，批注：「你这些东西放在这里干什么，占地方又没用，界面设计布局优化一下，只显示关注得东西」。口径由 AskUserQuestion 定死两档：**扫描范围卡 → 收成一行摘要、就地展开**（与 S12-B 留痕入口同一套交互，零浮层）；**顺手压薄只选「空态卡压薄」，「概览条保留原样」**（用户没勾「红线/口径说明降频」⇒ 页面最下面那条琥珀红线原样留着）。

#### 三处版式裁定

| 位置 | 改前 | 改后 | 为什么这样裁 |
|---|---|---|---|
| 扫描范围卡 | 卡头读数 + 12 行目录网格 + 「已停用」行 + 「满 N 天」口径行，展开时 226px，**每屏都占** | 卡头只留 `scopeSummary()` 一行读数 + 一颗「展开明细 / 收起明细」（`aria-expanded` 跟着翻），收起 53px；点开设的是**卡内**那块 `so-card-b` | 这张卡答的是 S12-① 用户自己的提问「现在 C 盘清理到底扫了哪些目录」—— 收成一行是把它从「每屏占 226px」变成「一次点击可达」，**不是把它从产品里删掉**。展开走页面内展开，spec §4 的零 toast/modal 没有放宽 |
| 空态卡（未扫描） | `.so-empty` 那坨 26px 居中的大空白 | 一行 `so-hint`：「去哪儿扫（右上角『开始扫描』）+ 扫描是只读的、删除只发生在勾选之后点『清理选中』那一刻」，卡高 49px | 一句话把两件事说完，不再单占半屏；扫描失败的红条落点仍在这张卡里（`st.error` 不静默） |
| 概览条 / 底部红线说明 | —— | **原样保留** | 用户只勾了「空态卡压薄」，没勾降频那档 |

状态挂在容器（`cleanScopeOpen`，`client.js:2711`），`CleanPage` 自身仍是零 `useState`；切标签再回来保持展开态（`cn-23` 钉的就是这条）。

#### 两句实话不许藏在展开后面（诚实降级 × 收起态）

`scopeNote()`（「规则读数还没拿到：这次没能读到 GET /api/rules 的内置列表…」/「本次没有任何启用的规则：内置全部停用、也没有自建规则…」）与 `errForScope` 那条规则读失败的红条，都渲染在**可折叠区域之外**，收起态照样上屏。分工也是钉住的：`scopeSummary()` 只报**数**，`scopeNote()` 只报**数为什么是这样**，同一句全页只许出现一次（`pg2-59` 用 `filter(...).length === 1` 数着断言，防的就是 S12-E 那类「① 说两遍」回归）。

#### 两边同改的钉法（原型 `prototype/index.html` ↔ `client.js`）

`pg2-57` 直接读原型源码比对，不靠人眼：明细块 `<div class="card-body" id="scopeBody" hidden>`、按钮 `aria-expanded="false"` + `>展开明细<`、**语句位**的 `setScopeOpen(false)`、空态那一句与 client 渲染出的句子**逐字相等**、摘要前三段逐段字面量比对（`'内置启用 ' + … + ' 条（共 ' + … + ' 条）· 自建 '` 等三段）。

原型走 `hidden` 而不是删节点（静态演示页没渲染树可删），真机半边是**整块从渲染树里拿掉** —— 这一处差异写在 `setScopeOpen` 上方的注释里，别在测试里强求一致。

#### 本轮自己踩的两个坑（如实记）

1. **用例撞号**：S13 那四条新用例最初写成 `pg2-54/55/56`，与 S12-C 的三条**同号**，而套件照样全绿 —— `check()` 不看 id 唯一性。补了一条自查口子：`grep -o "check('[a-z0-9A-Z_-]*" test/client.test.mjs | sort | uniq -d` 现在为空；S13 的四条改号为 `pg2-57/58/59/60`。
2. **电池放走一条**：`PT-2`（把 `setScopeOpen(false);` 注释掉）第一轮是绿的 —— 因为断言写的是 `assert.match(proto, /setScopeOpen\(false\)/)`，注释行 `// setScopeOpen(false);` 里那几个字照样命中。改成语句位正则 `^[ \t]*setScopeOpen\(false\);[ \t]*$`（`/m`）后转红。教训：**「源码里有这几个字」不等于「这条语句还在」**。

#### 验证读数（2026-09-30 现采）

- **9 个套件全部 exit 0**：`SKIP_LOCAL=1` 下合计 **488**（`client 164 · clean 81 · collect 48 · search 44 · plugin 44 · prefs 29 · alerts 34 · host-compat 25 · guard 19`，`tmp/s13-suites.txt`）；不带 `SKIP_LOCAL` 为 **495**（真机类 7 条也跑）。
- **变异电池 `tmp/mut_s13.mjs`：20/20 红、逐条字节级还原**（`allRestored: true`；`client.js 6a2b24643e8d · prototype/index.html 7dda11b1655e`，日志 `tmp/mut_s13.txt`）。四组：`SM-1~5`（降级读数与摘要句式）、`OP-1~7`（就地展开的交互与容器接线，含「默认展开」「按钮接空函数」「容器不传 scopeOpen」）、`ID-1~3`（压薄时把只读承诺/错误落点/唯一入口一起压掉）、`PT-1~5`（原型同步）。
- **真浏览器读数**（headless Chrome + CDP，`tmp/verify-s13.mjs` → `tmp/s13-verify.json`，`pvConsole: []`）：扫描范围卡 **226px → 53px**，收起态那块网格 `drawn=false` 且 DOM 里根本没有它，展开回 226px（网格 83px / 12 行），再收起整页高度回到 **1158**（开合可逆、不留残高）；空闲那一屏（`?noframes=1`，就是用户截图那一屏）整页 **233px**、空态卡 49px（文本 19px、`hasEmptyBox:false`）；两种降级（内置全停用 / 规则读数没拿到）收起态那句说明 `drawn=true`；**每一次读数 `overlays: 0`**。原型页同一套形状：53px ↔ 226px、`hidden` true↔false、按钮文案与 aria 同步。
- **摘要句式两边逐段比对 `summaryHead.same: true`** —— 这一条是修完「） · 自建」（client）vs「）· 自建」（原型）那处呼吸差之后取到的读数；`pg2-58` 里同时钉了 client 那句的逐字读数，改口就要连原型一起改。
- **逐张看图 7 张**（黑块事故立的规矩）：`s13-1-preview-collapsed` / `-2-preview-expanded` / `-3-proto-collapsed` / `-4-proto-expanded` / `-5-preview-all-off` / `-6-preview-no-read` / `-7-preview-idle` —— 宿主 token 配色正常、无黑底黑字、无空横条、无浮层。

**本轮只动浏览器半边 + 原型**（`client.js`、`prototype/index.html`、`test/client.test.mjs`、`test/render-fixtures.mjs` 的按钮 `ariaExpanded` 采集、`tmp/gen-preview.mjs` 的 `?noframes=1`）⇒ 真机上 **Ctrl+R 刷新即可**，S13 不需要重启 `dsh web`。S12-⑤ 那三条宿主路由仍未真机复核（仍等重启），重启后 `node tmp/probe-live.mjs 3080 > tmp/s11-live.txt` 依旧**只允许 GET**。

**看到但没动的一处**（等定夺，不属本轮红框）：分类条里「崩溃转储」那颗 chip 把类名念了两遍 —— `<b>{g.key}</b>` 后面那段以 `g.kind` 开头，命中规则的 `kind` 与规则名同名时才显形（`client.js:1988-1991`）。修法要么是同名单不重复、要么是那段改说「候选门槛」，属文案口径，留待下轮与清单表列换行一起定。

**未提交**（S13 连同 S12 各批一起等真机复核通过后再合并处理）。

### 8.13 真机第十四批 S14：上一轮记下的两处「看到但没动」—— 分类 chip 念两遍 + 清单表数值列折行（2026-09-30）

§8.12 末尾那条「看到但没动的一处」连同清单表折行一起报上去，用户批注：**「都处理了」**。两处都在浏览器半边 + 原型，没有一句需要宿主改口。

#### ① 分类 chip 把类名念两遍（`client.js:981`、`client.js:1994-1996`）

真形状：`崩溃转储` 那颗 chip 渲染成 `崩溃转储 · 崩溃转储 · 1 项 · 388 MB · 可清理 1` —— `<b>{g.key}</b>` 后面那段 `so-num` 以 `${g.kind} · ` 开头，**命中规则的 `kind` 与规则名同名时才显形**。

修法选的是「删掉那段」，不是「同名时不显示」，两条理由：

| 候选 | 裁定 | 依据 |
|---|---|---|
| 只在 `kind === ruleName` 时省掉 | 不采 | 只压掉显形的那一种，`用户临时目录 缓存 · 2 项 · 668 MB` 那颗仍在说假话 |
| `categoryGroups` 不再挂 `kind`，chip 只留「类名 + 计数」 | **采** | 一、原型这颗 chip 从来只有两段（`prototype/index.html:1252`），两边同形是全局约束；二、那个 `kind` 取的是**组内首项**的 kind，而分组键是 `ruleName` —— 同一条规则可以既收缓存又收日志（`S12_PLAN` 的 `系统临时目录` 组里 `a` 是缓存、`d` 是日志），拿首项标整组是以偏概全。**一次改动同时杀掉重复和一个小的谎**。 |

改后读数：`崩溃转储 → 1 项 · 388 MB · 可清理 1`，6 颗 chip `dup` 全清；`用户临时目录 → 2 项 · 668 MB · 可清理 1 · 已拒绝 1`（三档计数一项没少）。

#### ② 清单表「大小 / 最后访问」折成两行（`client.js:218`、`prototype/index.html:257`）

根因不在数值列，在路径列：`.so-tbl .so-path{white-space:nowrap}`（`client.js:289`）把路径列的最小内容宽度顶住，表格自动布局只能从**没有 nowrap 的数值列**身上抠富余 ⇒ `656 / MB`、`1051 天 / 前`。

改法：给数值列补一条 `white-space:nowrap`（`PID / CPU% / 大小 / 最后访问 / 修改时间` 共用 `.so-r`），中文那两列（命中规则 / 风险说明）仍可折行去吸收挤压 —— 所以**不会因此长出横向滚动**，真溢出时外层 `.so-tblwrap` 照旧横向滚（`cf-14` 钉的就是这条通路）。原型 `.tbl .r` 同规同改。

改后读数（`getClientRects().length` 数行数，不是看 DOM 属性）：

| 侧 | 大小列 | 最后访问列 | 命中规则列 | 表容器 |
|---|---|---|---|---|
| 预览页 改前 | `656 MB` **2 行**（行高 57） | `1051 天前` **2 行** | 1 行 | `scrollW 1122 = clientW 1122`，`overflowX:false` |
| 预览页 改后 | `656 MB` **1 行** | `1051 天前` **1 行** | 仍 2 行（吸收挤压） | 同上，`maxH` 414 → 431 |
| 原型 改前 | `656 MB` / `486 MB` **2 行**（行高 57） | `今天 08:12` 1 行 | 2 行 | `scrollW 1122 = clientW 1122` |
| 原型 改后 | **1 行**（行高 57 → **54**） | 1 行 | 2 行 | 同上，`pageOverflowX:false`、`overlays:0` |

#### 本轮自己踩的坑（如实记）

1. **改前基线差点是假的**：`tmp/verify-s14.mjs` 第一版取 chip 计数段用 `.num`，那是原型的类名；client 用 `.so-num`，于是改前那份读数里 client 六颗 chip 全是 `num:""` + `dup:false` —— 看着像「这个 bug 不存在」。选择器改成 `.num, .so-num` 重采，才拿到真基线（`崩溃转储 dup:true`）。教训：**改前基线也要核对「采到数的是哪一侧」**，否则前后对照会得出「无需修」的结论。
2. **电池第一轮放走一条**：`CM-4`（chip 计数段丢掉「有风险 / 已拒绝」两档）是绿的 —— `pg2-42` 只钉了 `categoryGroups` 的**数据**，`pg2-18` 只钉了**卡头**那句，chip 上这两档没有任何用例看着。补法：`pg2-61` 里加两条逐字读数 `2 项 · 950 B · 可清理 1 · 有风险 1` / `2 项 · 110 B · 可清理 1 · 已拒绝 1`，第二轮 `CM-4` 转红。
3. **撞号自查的口子本身有洞**：§8.12 记的那条命令 `grep -o "check('[a-z0-9A-Z_-]*"` 的字符类**不含中文**，遇到 `check('C 盘…')` 这类中文 id 只截到一个 `C`，等于没扫。本轮换成按文件跑 `grep -o "^check('[a-zA-Z0-9_.-]*" | sort | uniq -d`，九个文件全为空。

#### 验证读数（2026-09-30 现采）

- **9 个套件全部 exit 0**：`SKIP_LOCAL=1` 下合计 **490**（`client 166 · clean 81 · collect 48 · search 44 · plugin 44 · prefs 29 · alerts 34 · host-compat 25 · guard 19`，`tmp/s14-suites.txt` / 补钉后复跑 `tmp/s14b-suites.txt`）；不带 `SKIP_LOCAL` 时 client 为 167（真机类那 1 条也跑）。新用例两条：`pg2-61`（chip 只念一遍类名 + 组上不挂 kind + 原型模板形状 + 三档计数逐字读数）、`pg2-62`（`.so-r` 与 `.so-path` 两条 nowrap 同时在场 + 原型同规）。
- **变异电池 `tmp/mut_s14.mjs`：9/9 红、逐条字节级还原**（`allRestored: true`；`client.js b414265b6b76 · prototype/index.html 781f78361818`，日志 `tmp/mut_s14.txt`）。两组：`CM-1~5`（念两遍回归 / 组上重新挂 kind / 原型模板加回 kind / 三档计数少一档 / 少合计大小）、`RW-1~4`（数值列 nowrap 撤掉 / 只撤路径列那条 / 原型没跟着改 / 选择器照原型写成 `.r`）。`RW-2` 除了 `pg2-62` 还被 `cf-14` 抓住（路径列折行回归）。
- **真浏览器核对**（headless Chrome + CDP，`tmp/verify-s14.mjs` → `tmp/s14-before.json` / `tmp/s14-after.json`，改前改后两份都是 `console:"原型页无 console 记录"`）：上表那些行数与高度就是这份读数；**每一次读数 `overlays: 0`、`pageOverflowX:false`**。
- **逐张看图 2 张**（黑块事故立的规矩）：`tmp/s14-1-preview-chips.png`（chip 名单只念一遍、`656 MB` / `92.0 MB` / `1051 天前` 单行、命中规则列在折行吸收挤压）、`tmp/s14-2-proto-chips.png`（原型同一屏同形，11 项 11 组 chip、行高 54）。

**本轮只动浏览器半边 + 原型**（`client.js`、`prototype/index.html`、`test/client.test.mjs`）⇒ 真机上 **Ctrl+R 刷新即可**，S14 不需要重启 `dsh web`。**S12-⑤ 那三条宿主路由仍未真机复核**（仍等重启一次），重启后 `node tmp/probe-live.mjs 3080 > tmp/s11-live.txt` 依旧**只允许 GET**。

**未提交**（S14 连同 S12/S13 各批一起等真机复核通过后再合并处理）。

### 8.14 真机第十五批 S15：曲线悬停「太丑」重做 + 触发记录独立成第 2 个页签（2026-09-30）

用户两张真机截图 + 两句话：「1. 鼠标移上去得效果太丑了，做好看一点；2. 触发记录单独做一个 tab」。三处口径经确认后落地（卡内气泡 + 圆环、第 2 个页签、绝对时刻 + 灰字相对时间并列）。

#### ① 悬停读数：为什么「丑」，以及为什么不能靠调魔数修

旧读数是画在曲线 svg 里的 `<text>` + `<circle>`。那张 svg 是 `preserveAspectRatio:'none'`、viewBox `340×92` 拉到 ~525 CSS px 宽 —— **横向被拉伸 1.54 倍、纵向 1:1**，所以字发胖、点画成椭圆，这就是「丑」的物理成因（`tmp/s15-*.png` 量到的 `stretch:1.54` 就是它）。

改法：**引导线留在 svg 内**（它要跟着曲线走，且补 `vector-effect:non-scaling-stroke` 才不被拉成 1.54px），**圆环与气泡改成卡内 HTML 元素** —— 横向按百分比贴、纵向按 px 贴，不吃拉伸。零浮层：三件套只在这张卡里出现（`.so-curve` 是定位父级），`overlays` 恒为 0。

**踩到的真缺陷（第一版仍然丑）**：气泡最初用「居中 + 固定夹边」`clamp(46px, N%, calc(100% - 46px))` + `translateX(-50%)`。气泡有多宽要等文案渲染出来才知道（网络卡那两个速率实测 **186.9px**、C 盘卡 **162.4px**），夹边值 46px 远小于半个气泡宽 ⇒ 贴边的点把气泡裁到卡外（无头实测网络卡左端 **离卡 -32.5px**）。

**改法不是把 46 调大**，而是换成与宽度无关的落位规则：**点在哪半边，气泡就朝里长** —— `start = leftPct < 50`，左半边 `left:calc(N% + 8px)` + `translateX(0)`，右半边 `left:calc(N% - 8px)` + `translateX(-100%)`。`tipLayout()` 是这两串 CSS 的唯一出处，`.so-tip-box` 类里**不再写 transform**（两处各写一份会互相压）。原型 `showCurveTip` 同式同改。改后 21 个采样点（预览 4 卡 × 3 位 + 原型 3 卡 × 3 位）**最小离卡余量 +27.7px，无一出界**。

#### ② 触发记录独立成第 2 个页签

页签表 `资源监控 / 触发记录 / C 盘清理 / 文件搜索 / 设置`（`client.js:479` 的 `nav` 是唯一清单，原型按钮是唯一清单）。时间线整块从监控页底部搬走、**不留副本**（`pg1-11b` / `cn-24` 钉「监控页上『触发记录』只出现一次 = 页签本身」）。行 = 绝对时刻 `MM-DD HH:MM` + 灰字相对时间并列；就地筛选三档 全部 / 最近 24 小时 / 最近 7 天，读数 `X / Y 条`；**档位是容器态**（`alertsRange`，与 `cleanScopeOpen` 同规），切走再回来还停在原档。窗口空态与本机空态两句话分开说（`AT-3` 钉的就是不许合并成一句）。

#### ③ 落点口径四处联动（含宿主半边）

`lib/alerts/rules.js` 内置 r1 的 note、设置页副标题、新建规则「提示落点」只读框、新建表单就地提示 —— 四处都从「监控页时间线」改口到「触发记录页」（`pg4-18` 钉四处 + 反向钉「不许残留旧话」）。

#### 本轮又抓到两处「第二份清单」缺陷（截图核对的价值）

1. **原型点「触发记录」根本切不过去**（`tmp/s15-8-proto-alerts.png` 第一次拍的是一张监控页；`-card` 那张只有 110 字节，因为 `#panel-alerts` 矩形 0×0）。根因：`prototype/index.html` 的 hashchange 里手写白名单只有四个 key、**漏了 `alerts`**，而 `activate()` 里那份是另一份已含 `alerts` 的清单 —— 两份清单各写一处就是「一份真相」的反例。改法：`var TABS = Array.prototype.map.call(el('tabs').children, …)` **从按钮本身取**，`goTab(hash)` 做校验，`activate()` 关面板与两处 hash 入口都吃它（初始那次原先完全不校验，未知 hash 会把五个面板全隐藏成白屏）。门禁 `cf-6b`：清单派生 1 处、`activate(goTab(location.hash))` 恰好 2 处、`/'monitor',\s*'/` 命中 0、每个 `data-tab` 有对应 `#panel-*` 与页头文案。
   ⇒ 连带：本轮在原型页量的 `pt_alerts*` 第一版是**隐藏节点上的假读数**（`textContent` 读得到、矩形全 0，`gapPx` 报 0px）。`tmp/verify-s15.mjs` 因此加了 `guardAlerts`（面板宽 > 100 且当前页签文字就是「触发记录」才让量）与截图前的矩形核对（≤8px 直接抛错），并把「量隐藏节点」这条坑写进脚本头。
2. **侧边栏蓝点的清未读还挂在监控页**（`if (tab !== 'monitor') return undefined;`）。时间线搬走后它的行为是「读完记录蓝点不灭，翻到根本没有记录的监控页反倒灭」—— 蓝点说谎。改成 `tab !== 'alerts'`，spec §3.5 那句「进入监控页即清」同步改口。门禁 `cn-25`：停在监控页不许发 `POST /sysops/api/alerts/read`，进触发记录页恰好一次，切回监控页不许第二次。

#### 本轮自己踩的坑（如实记）

1. **桩 React 的 setter 不自动重渲染**：`cn-25` 第一版点完页签只 `await cnTick()` 就断言，结果 effect 从没跑过 —— 报的是假的「没发请求」。必须 `w.render()` 一次让 deps 变了的 effect 执行（与 `cn-3b` 同一个坑，这次连注释一起写进用例）。
2. **guard 的默认选择器照 client 猜错了**：`.so-tabs button.is-active` 在预览页查不到（client 用 `.so-tab[aria-selected="true"]`），第一次跑就抛「当前页签是 null」。这条抛错本身是对的 —— 它拒绝把一次没落位的测量当通过。
3. **夹具时间戳写死会把证据变成噪声**：`tmp/gen-preview.mjs` 里两条 `1700000000000` 让截图长成「11-15 06:13 · 1050 天前」。改成相对 `Date.now()`（1 小时 / 3 天 / 40 天），三档筛选也顺被覆盖到（1/3、2/3）。

#### 验证读数（2026-09-30 现采）

- **9 个套件全部 exit 0**：`SKIP_LOCAL=1` 合计 **497**（`client 173 · clean 81 · collect 48 · search 44 · plugin 44 · prefs 29 · alerts 34 · host-compat 25 · guard 19`，`tmp/s15-suites-skiplocal.txt`）；不带 `SKIP_LOCAL` 合计 **504**（`client 174 · clean 82 · host-compat 27 · search 47`，`tmp/s15-suites-full.txt`）。本轮新增 4 条：`cf-6b`、`cn-25`、`pg1-12b` 扩的原型两列钉、`pg1-29` 扩的半边朝向钉与 `hideCurveTip` 三次 none 钉。
- **变异电池 `tmp/mut_s15.mjs`：28/28 全红、逐条字节级还原**（`allRestored:true`；`client a0266a05a820 · proto 06b1839438c6 · rules 3ef3f1086e54`，日志 `tmp/s15-mut.txt`）。四组：`HV-1~8`（坐标互换 / 丢 transform / 圆环不吃卡色 / 少时刻 / 撤 nowrap / 圆变方 / 撤 non-scaling-stroke / 半边判定写死）、`HP-1~6`（原型同六处）、`AT-1~10`（页改名 / 筛选假接线 / 两种空态合并 / 无时间戳混进窗口 / 撤相对列 / 原型页改名 / 原型行不报时刻 / 页签清单退回手写 / hash 校验形同虚设 / 清未读挂回监控页）、`LD-1~4`（四处落点口径各改回旧话）。
- **真浏览器核对**（headless Chrome + CDP 9230，`node tmp/gen-preview.mjs` → `tmp/verify-s15.mjs` → `tmp/s15-verify.json` / `tmp/s15-readout.txt`）：21 个悬停采样 **最小离卡余量 +27.7px、出界 0**；气泡一律 `h=23.5`（= 单行 line-height，`oneLine:true`）、`white-space:nowrap`、`offsetParent` 就是那张卡；圆环 `11×11 round:true` 且描边色随本卡曲线；引导线 `stroke-width:1px` + `vector-effect:non-scaling-stroke`（同帧报出 `stretch:1.54` 作对照）；每卡三件套 `tipNodesInThisCard:3`；**每一次读数 `overlays:0`**；移开后预览页 `boxes/rings/lines = 0/0/0`、原型三件 `display:none`。触发记录页：预览 `3 条 → 1/3 条 → 2/3 条`、原型 `5 条 → 3/5 → 4/5`，两列 `sameLine:true`、`stampShape:true`、`agoGray:true`、`gapPx:6`（两边同值），`activeTab:"触发记录"`、`panelW:1124`；监控页时间线本体 `0`（两边）。设置页落点文案命中 3 处、旧话残留 `stale:0`。
- **逐张看图 12 张**（黑块事故立的规矩）：`s15-1/2/3`（预览：中点 / 最宽气泡贴最左 / 宽气泡贴最右）+ 各自 `-card` 放大、`s15-4b/5b`（触发记录全量与 24 小时档）、`s15-6b`（设置页阈值告警卡的落点句）、`s15-7/9`（原型悬停中点与最左）、`s15-8/8b`（原型触发记录页 —— 这一张才是「页签真的切过去了」的证据）。

**本轮动了宿主半边**（`lib/alerts/rules.js` 的内置规则 note）⇒ 真机需**重启一次 `dsh web`**，之后 S11/S12/S15 三批真机复核一起做（`node tmp/probe-live.mjs 3080 > tmp/s11-live.txt`，依旧**只允许 GET**）。

**未提交**（S15 连同 S12/S13/S14 各批一起等真机复核通过后再合并处理）。另记一条待用户定夺：原型的「阈值告警」规则卡仍挂在 `#panel-monitor` 底部，而 client 的在设置页 —— S15 之前就有的分叉，本轮只报告不动。

### 8.15 真机第十六批 S16：虚线 / 网速不动 / 改名监控记录 / 记录只在框内滚（2026-10-01）

用户两张真机截图（桌面宿主 19387，非 `dsh web`）+ 四句话：「1.虚线样式不好看；2.网络吞吐数据不变化；3.触发记录改为监控记录；4.监控记录只在当前框内滚动，不要整页滚动」。第二张红框里还有一屏 `90.53895642516085%` —— 在红框内就一并修（⑤）。

#### ① 虚线：问题不是"虚线丑"，是两条线撞成同一种线

引导线与阈值线都写成 `3 3` 虚线。一条的意思是"越过没有"，另一条是"现在是哪一点"，**两种意思同一个长相**，在 92px 高的小图里就糊成一团杂线。所以修法不是调 dasharray 的魔数，而是让**虚实承载语义**：阈值线保留虚线（参考线的通用长相），引导线改实线、只靠 `opacity:.28` 退到背景里。`non-scaling-stroke` 必须留着 —— 那张 svg 横向拉 1.54 倍，去掉它 1px 会画成 1.6px，比阈值线还粗。两边同改（`.so-tip-line` / `.tip-line`）。门禁 `cf-15` 钉的是**分工**：引导线不许带 dasharray，阈值线的 dasharray 一处不能少（反向退化"两条都实线"同样判红）。

#### ② 网络吞吐"不变化"：不是采集坏了，是显示口径把动的水读成 0

先取证再动手（GET-only，`tmp/probe-net.mjs 19387` → `tmp/s16-net.txt`）：`series.netDown n=544`、间隔中位数 **1015ms**、真 SSE 流 6 秒收到 29 帧、`latest.netDown = 7030.7423 B/s`。**采集每秒都在动**，坏的是显示：旧代码固定 `v / 1e6` 再 `toFixed(1)` ⇒ 7 KB/s 量级恒等于 `"0.0"`，且调用方还 `fmtRate(v).split(' ')[0]` 把单位丢掉、自己硬写 `MB/s`。

改法是把换算收成**唯一一处** `rateParts()`（交回数値与单位两半，`fmtRate` 只是它的拼接）：
- **进制分家**：容量走 1024（`fmtBytes` / `capText`，对齐资源管理器「属性」页），**速率走 1000**（PDH 的 Bytes/sec、网卡与下载器都是十进制），这条由 `pg1-2` 早先钉的 `12 500 000 → 12.5 MB/s` 锁死 —— 本轮第一版顺手写成 1024 就被它当场抓住。
- **位数与 `fmtBytes` 同规则**：≥100 出整数、≥10 一位、其余两位 ⇒ `2 400 000` 念作 `2.40 MB/s`（`pg1-1` 的期望值因此从 `2.4` 改成 `2.40`，不是回归，是口径统一）。
- `< 1000` 落 `B/s` 档，读不到值只出 `—` 且不配单位。

调用点四个（指标卡大数字 + 卡副标题、曲线卡角注、悬停气泡的下行/上行、命中正文）全部走它。`pg1-2b` 除了钉换算本身，还钉三件"复发口"：源码里不许再出现 `/1e6`、`/1_000_000`、`/1024*1024` 的私有算式；网络行不许出现硬写 `'MB/s'` 与 `.split(`；`fmtRate` 调用点计数恰为 5（少一个就是某一处又自己算了）。原型半边同一条阶梯逐字对齐（`ratePartsB`），并钉"单位阶梯在图纸上只许有一份"。

#### ③ 触发记录 → 监控记录：只改 label，不改 key

`nav` 的 `t` 与页头 `h2`、设置页三处文案、`mergeFrame` 兜底、宿主 `lib/alerts/rules.js` 的内置规则 note、`lib/alerts/service.js` 的降级帧文案、原型页签与两处落点框 —— 全部改口；**内部键仍是 `alerts`**（页签路由、hash、清未读判定、`data-tab` 都吃它，改名会把四件事一起弄断）。门禁 `cf-6c`：键清单逐字不变 + 旧名在四份**可见**源码里清零（注释里的历史说法保留，那是台账不是文案）。真机浏览器读数：预览与原型页 `oldName:0`、设置页 `pv_settings_old:0`。

#### ④ 监控记录只在框内滚动：滚动层必须与竖线层分开

`.so-tl` 的竖线是 `::before` 绝对定位 —— **把 overflow 加在它自己身上，竖线就被钉在可视框上**，滚两行就与圆点脱节。所以另起一层 `.so-tlwrap{max-height:clamp(240px,52vh,480px);overflow:auto;overscroll-behavior:contain}`（限高口径照 `.so-tblwrap-plan` / `.logpanel`，`overscroll-behavior:contain` 是 S10 那条"滚到边界不许带着整页滚"的续命）。原型 `.tl-wrap` 同形同式。门禁 `pg1-12d` 用 `findClassIn` 在**原始渲染树**上量嵌套（`walk()` 摊平后看不出父子），并钉 CSS 三条一行不少、`.so-tl` 自己不许挂 overflow。

#### ⑤ 命中正文出显示位数

`hitText` 走 `fmtPct` / `fmtRate`，`90.53895642516085%` 念作 `90.5%`、网络类命中念 `7.03 KB/s` 而不是 `7030.0%`。**只改显示不改数据**：落盘值仍是原值（记录要能对上当时规则的阈值）。门禁 `pg1-12e`。

#### 本轮自己踩的坑（如实记）

1. **进制手滑**：新换算第一版顺手用了 1024，被 `pg1-2` 那条早就存在的钉直接判红 —— 这就是"钉住口径"的价值，也是为什么它当时要钉 12 500 000。
2. **源码锁只锁半行**：网络行在源码里折成两行，`/^\s*\{ key: 'net',.*$/m` 只吃到第一行，等于放过了 `'MB/s'` 真正可能出现的那半。改成跨行吃整个对象字面量才算锁上。
3. **`walk()` 看不出父子**：限高这条要钉的是"滚动层**包着**时间线"，摊平的类名清单证明不了嵌套，故新增 `findClassIn`（在原始树上找，先外后内）。
4. **真浏览器里"第一条横线"不是阈值线**：一张曲线 svg 里有 5 条 `line`，其中**三条横线都没有 dasharray**（网格基线）。第一版按"没有类名的第一条线"挑阈值线，量到 `dash:none` 差点把"阈值线也变实线"当成事实报出去。按"横向 + 带 dasharray"重挑，并把整组 5 条线的属性一并留证。
5. **夹具不许比真机少**：预览页原来只有 3 条记录，限高根本溢不出来 ⇒ 照真机那一页的形状补到 29 条，并把 `90.53895642516085` 这种采集原值放进夹具（否则⑤这一条量不到）。
6. 全程照旧规矩：CSS 模板字符串的注释里不写反引号；变异电池只用单行锚点、跑完字节级还原比 sha；对真机宿主只发 GET。

#### 验证读数（2026-10-01 现采）

- **9 个套件全部 exit 0**：`SKIP_LOCAL=1` 合计 **502**（`client 178 · clean 81 · collect 48 · search 44 · plugin 44 · prefs 29 · alerts 34 · host-compat 25 · guard 19`，`tmp/s16-suites-skip.txt`）；不带 `SKIP_LOCAL` 合计 **509**（`client 179 · clean 82 · host-compat 27 · search 47`，`tmp/s16-suites-full.txt`）。本轮新增/扩写：`cf-15`（虚实分工）、`pg1-2b`（换算同源 + 三件复发口 + 原型阶梯对齐）、`pg1-12d`（卡内滚动层）、`pg1-12e`（命中位数）、`cf-6c`（改名清零且键不动），并把 `pg1-1` 的单位期望改成 `2.40 MB/s`。
- **变异电池 `tmp/mut_s16.mjs`：31/31 全红、逐条字节级还原**（`allRestored:true`；`client f30be04ed455 · proto 0021c67cf0cf · rules 60ecad3b4503 · service 4ef7eaba2d8e`，日志 `tmp/s16-mut.txt`）。五组：`GL-1~5`（引导线退回虚线 / 原型同退 / 丢 non-scaling-stroke / 阈值线 dasharray 被一起删 / 原型同删）、`RT-1~8`（1024 串档 / 位数退一位 / B/s 边界 / 卡面硬写 MB/s / 曲线角注另起 `/1e6` / 原型三处同改被破坏 / 第二份单位阶梯）、`NM-1~10`（label 回退 / **key 也被改名** / 卡头 / 设置副标题 / 落点只读框 / 兜底文案 / 宿主规则 note / 宿主降级帧 / 原型页签 / 原型落点框）、`SC-1~6`（滚动层改名 / 丢 overscroll / 与竖线层合一 / 退成不限高 / 原型丢 overflow / 原型去掉外层框）、`RD-1~2`（直出原值 / 网络命中走百分比）。
- **真浏览器核对**（headless Chrome + CDP 9230，`node tmp/gen-preview.mjs` → `tmp/verify-s16.mjs` → `tmp/s16-verify.json` / `tmp/s16-verify-brief.txt`）：
  - 线：预览与原型的引导线都是 `dash:none · 1px · opacity .28 · vector-effect:non-scaling-stroke`，阈值线都是 `dash:3px,3px · opacity .55`，每帧 `dashedLines:1`、`overlays:0`。
  - 网速：连推四帧 `18.4MB/s → 7.03KB/s → 24.7KB/s → 5.32MB/s`（真机量级 7030 B/s 落进 KB/s 档），卡副标题 `下行 · 上行 13.6 KB/s`、曲线角注 `下行主线 · 上行 13.6 KB/s`；原型 `51.8KB/s / 上行 12.4 KB/s`。
  - 滚动：29 条下 `.so-tlwrap` `clientH:480 / scrollH:1566 / overflowY:auto / overscroll:contain`，**整页 `scrollH:1000 = innerH:1000`**；框滚到底 `scrollTop:1086`（= max）而 `window.scrollY` 恒为 `0`；竖线层 `rail.h:1566` 与内容同高（`::before` 1553.55px）⇒ 线跟着内容走，没被钉在框上。
  - 文案：`activeTab:"监控记录"`、`panelW:1124`、`count:"29 条" → "23 / 29 条"`（24 小时档），`oldName:0`、`pv_settings_old:0`，`longDecimals:[]`（正文里再无 6 位以上小数）。
- **逐张看图 10 张**：`s16-1`（四指标卡，网速单位随量级）、`s16-2`（CPU 卡悬停：实线引导线 vs 红虚线阈值线）+ `s16-2b`（监控整页）、`s16-3`（监控记录 29 条，框内裁切）+ `s16-3b`（整页，页头没被顶走）、`s16-4`（框滚到底：页头读数不动）、`s16-5`（24 小时档 `23 / 29 条`）、`s16-6`（设置页阈值告警卡三处新名）、`s16-7/7b`（原型监控记录）、`s16-8`（原型悬停，与 client 同一长相）。

**本轮动了宿主半边**（`lib/alerts/rules.js` 的规则 note、`lib/alerts/service.js` 的降级帧文案）⇒ 真机需**重启一次宿主**（桌面版：退出并重开 `DeepSeek Harness`；`dsh web` 同理），之后 S11/S12/S15/S16 四批真机复核一起做（真机端口现为 **19387**，`node tmp/probe-net.mjs 19387`，依旧**只允许 GET**）。

**未提交**（S16 连同 S12~S15 各批一起等真机复核通过后再合并处理）。三条待用户定夺：
1. 历史命中里存的旧 note（`落点：监控页时间线`）不改写 —— 那是当时规则文本的留痕，回写存储正是 prefs 整行覆盖那类事故的入口；界面新读的是宿主现值。
2. 监控页那行 `丢弃 7 个异常点 · 乱序 2` 仍不带键名归属：宿主 `snapshot().dropped` 只有聚合两格，要说出"哪个指标丢了几个"得动宿主半边（本轮不擅自扩接口）。
3. 原型的「阈值告警」规则卡仍挂在 `#panel-monitor` 底部，client 的在设置页（S15 之前就在，本轮只报告不动）。

### 8.16 真机第十七批 S17：「开启进程榜没反应」—— 状态被读成了增量帧里凭空补出来的那个字段（2026-10-01）

用户两真机截图（桌面宿主 19387）+ 一句话：「开启进程榜没反应」。两张图自己就把矛盾摆出来了：采集源条的 `进程榜` chip 是 **运行中**，同一页下面的进程占用榜卡体却写着 **「进程榜采集未开启。」** 并挂着一颗 **「现在开启」**。第二张图右上角的 `网络吞吐 111 KB/s` 顺带证明 S16-② 在真机上生效了。

#### 取证：先证明宿主在动，再看界面对不对（GET-only）

`tmp/probe-proc.mjs`（只发 GET，响应原文落盘）→ `tmp/s17-probe.txt` / `tmp/s17-snap-1.json` / `tmp/s17-snap-2.json` / `tmp/s17-stream.txt`：`sources` 帧里 `l1b.state` 是 `on`、`pid` 有值，`proc` 帧带着 rows。再用真模块离线复现（`tmp/repro-l1b.mjs`，真 supervisor + 真 PowerShell）：`setVisible(true)` → **+0.1s** `l1b:starting` → **+4.3s 第一帧 `proc`（400 行）** → **+5.0s** `l1b:on` → 后续帧间隔 4.6s / 4.7s（与 §1.2 的 `Start-Sleep 3` + 单轮 1.6~1.9s 对得上）。**采集与推送都是好的**，坏的是界面。

#### 根因：一份状态两处真相，其中一处是凭空补的

`lib/collect/service.js` 的三处 `proc` emit（:108 / :117 / :125）只带 `rows / note / t`，**从不带 `state`**；`snapshot().proc.state`（:325）是**取快照那一刻**由 `l1b.state()` 算出来的。客户端 `mergeFrame` 的 proc 分支写的是 `state: d.state ?? base.proc.state ?? 'off'` —— 帧里没有就从旧值兜，于是页面加载时（榜还关着）那个 `off` 被一路冻住。卡片分支 `proc.state === 'on' && procRows.length` 因此**永远为假**，400 行在手也画空态。chip 会跟着动，是因为 `sources` 帧整份替换 `base.sources`，不走这条兜底。

一句话教训：**SSE 帧里不存在的字段，不许在合并里凭空补一个** —— 补了就没有任何人知道它是旧的。状态只有一份，读那一处活的。

#### 修：状态来源收成一处，五态各给一句实话

- 新增 `sourceRow(snap, key)`（client.js:746）：取不到源行返回 **null**，调用方当「状态未确认」而不是「未开启」—— 拿 null 冒充 off 就是替宿主编一句它没说过的话。
- 卡片只读 `sourceRow(snap, 'l1b')`（client.js:1765-1767），`mergeFrame` 的 proc 分支不再造 `state` 键（:2798）。
- 空态五分支（`procEmptyText()`，client.js:1858-1864）：无源行 → 「状态未确认：宿主没给 l1b 这一源行。」；`off` → 「未开启」+ 开销理由 + 一颗「现在开启」；`starting` → 「正在起第一轮：常驻 PowerShell 冷启动，实测约 4.3s 到齐。」；`on` 无行 → 「已开启，还没出第一轮数据（每 Ns 一轮，实测约 4.3s 一行）。」；其余（`stalled/crashed/exited-max`）→ 「已停：<pill 原文>。恢复请用上方「进程榜」那一行的「重试」。」。**那段 4.3s 空窗原本也念「未开启」** —— 用户就是在这一段以为按钮没生效。
- 节奏那句从 `cfg().defaults.procIntervalSec` 现取，取不到就写「刷新间隔未确认」，不硬编一个好看的秒数。
- 空态也露 `proc.note`：PowerShell 的「非 JSON 行 / 拒绝访问」只挂在这上面，只在表格分支渲染等于把唯一线索扔了。
- 采集源条的重试条件补上 `stalled`（client.js:1732）。**这一条是看图时抓到的第二处假承诺**：新文案写着「用上方那一行的「重试」」，而源条在 `stalled` 下根本没有这颗按钮（`srcBtns:[]`）。
- 原型半边同改：`procEmpty(st, pill)` 单点出五句（`PROC_CAD` / `PROC_FIRST` 两个常量），`setProc(true)` 先 `starting` 再 1.8s 后换榜、且带 `if (srcs.l1b.state !== 'starting') return;` 守卫（被关掉的那一轮不许自己抢回来），初始一屏也走 `procEmpty(srcs.l1b.state)`，`renderSrcs()` 给停摆行挂 `data-proc-retry`，`#srcBar` 上接一次点击。

#### 本轮自己踩的坑（如实记）

1. **夹具在说谎**：`tmp/gen-preview.mjs` 原来开局推一条 `proc` 帧带 `state:'on'` 且带演示行，而 `sources.l1b` 是 `off` —— 宿主两种形状都不会出现。离线预览因此**永远看不见这个 bug**。已改成宿主的真形状（`proc` 帧不带 `state`）。这是 S16「夹具不许比真机少」的另一半：**也不许比宿主多一个字段**。
2. **我写的新文案自己造了第二处假承诺**（上一条的 `重试`）。抓它靠的不是看表格出不出，是把源条的按钮清单一起量（`srcBtns`）—— 每句指路的话都要有一个被指的东西进读数。
3. **截图折叠线**：`Page.captureScreenshot` 用 `captureBeyondViewport:false` 时只吃视口内的像素。首版 `s17-3-preview-table.png` 卡底那句「只读榜：本插件不提供「结束进程」…」在像素上没有，而 `tmp/peek-s17.mjs` 证明 DOM 里在（`h:40 · color:rgb(92,98,109)`）—— 差点把"渲染丢了"报成缺陷。量法改成截图前 `scrollIntoView({block:'center'})` 再取矩形。
4. **测试自己错两处**：`pg1-10` 把 `proc` 当 MonitorPage 的 prop 传（应放进 `snap`）；`assert.doesNotMatch(/proc\.state/, src)` 参数顺序反了（第一个参数才是被检字符串），报成 TypeError 而不是断言失败。
5. CDP `clip` 必须带 `scale`（缺了直接 `-32602 Failed to deserialize params.clip.scale`）。

#### 验证读数（2026-10-01 现采）

- **9 个套件全部 exit 0**：`SKIP_LOCAL=1` 合计 **507**（`client 183 · clean 81 · collect 48 · search 44 · plugin 44 · prefs 29 · alerts 34 · host-compat 25 · guard 19`）；client 不带 `SKIP_LOCAL` **185/185**。本轮新增/扩写：`pg1-10b`（proc.state 冻在 off 也要出榜）、`pg1-10c`（sources 说 off 就不许画榜）、`pg1-10d`（五分支各一句 + `stalledOut.buttons` 里必须有「重试」）、`pg1-10e`（空态露 note + 源码锁：`proc.state` 清零、`sourceRow(snap,'l1b')` 恰一处、两边重试条件同形、「进程榜采集未开启」两边各恰一次）、`pg1-10f`（合并不再造 `state`，且只带 note 的帧不清空榜）、`pg1-10g`（原型状态机接线 + 五句两边逐字同口径），并改写 `pg1-10`。
- **变异电池 `tmp/mut_s17.mjs`：18/18 全红、逐条字节级还原**（`allRestored:true`；`client 9c23078662ed · proto db1f0efec571`，日志 `tmp/s17-mut.txt`）。五组：`ST-1~5`（状态退回 proc.state / 不取源行 / `sourceRow` 编一个 off / 出榜不看源状态 / 取错成 l1a）、`BR-1~4`（starting 写「未开启」/ on 等首轮归进「已停」/ 开启按钮挪到 starting / 空态不露 note）、`RP-1~2`（两边源条去掉 stalled 重试）、`MR-1~2`（合并凭空补 state / 只带 note 的帧清空榜）、`PT-1~5`（原型仍画未开启 / 去掉守卫 / 重试点成关闭 / 初始一屏自己抄一份 / 那句退回「未开启」）。
- **真浏览器核对**（headless Chrome + CDP 9230，`node tmp/gen-preview.mjs` → `node tmp/verify-s17.mjs` → `tmp/s17-verify3.json`）：按真序推帧（点开启 → `sources(starting)` → `sources(on)` → **不带 `state` 的 `proc` 帧** → `sources(stalled)` → 回 `on`）。读数：`s1` 空态「进程榜采集未开启。…开了之后 每 3s 一轮。」+ `btns:["现在开启"]`、`s1posts:[]`；`click:1` 后 `s2posts:["POST /sysops/api/collect/source"]`；`s3starting` 那句 4.3s 实话、`btns:[]`、`srcPill:"进程榜 启动中"`；`s4onNoRows`「已开启，还没出第一轮数据」；**`s5table` rows:3、firstRow `Chrome.exe1138492.42.24 GBWin32_Process`、`srcPill:"进程榜 运行中"`**（这一步就是本轮的胜负手：帧里没带 `state`）；`s6stalled`「进程榜已停：超时无输出…」+ `srcBtns:["重试"]` + note 仍在；`s7back` rows:3。原型 `p1off → p3starting → p4on`（8 行，源条「进程榜 每 3s 一轮 · 运行中」）`→ p6offAgain`。每步 `overlays:0`，卡宽 1124 / 1122。
- **逐张看图 6 张**：`s17-1-preview-off`（空态三行：结论 + 代价 + 按钮）、`s17-2-preview-starting`（只剩一句实话、按钮已消失）、`s17-3-preview-table`（四列表头 + note + 卡底那句「只读榜…」、无浮层）、`s17-4-preview-stalled`（已停那句 + note 留痕）、`s17-5-proto-starting`（原型整页：源条「启动中」与卡体同口径）、`s17-6-proto-table`（原型整页：源条「每 3s 一轮 · 运行中」+ 榜）。

**本轮只动浏览器半边（`client.js`）与原型**，宿主半边一行未改 ⇒ **S17-① 不需要重启宿主**，真机上刷新那个面板就能看到榜出来（若仍在 4.3s 空窗里，卡体会先说「正在起第一轮」）。S11/S12/S15/S16 那四批的真机复核仍等一次宿主重启（桌面版：退出并重开 `DeepSeek Harness`，端口 **19387**，探针**只允许 GET**）。

**未提交**（S17 连同 S12~S16 各批一起等真机复核通过后再合并处理）。S16 留下的三条待用户定夺原样带着，本轮不新增悬案。

### 8.17 真机第十八批 S18：采集四条批注 —— 开关意图 / 幂等门 / 进程榜的滚动层与排序（2026-10-01）

用户一句话四条：「1.网络采集调整未默认开启；2.开启网络采集时，进程采集也默认开启了；3.进程采集列表不要整页滚动，只在框内滚动，按CPU使用率降序排列，支持点击cpu和内存进行排序；4.进程采集为什么会不停的启动采集」。四条分开看是三处根因：① 是**界面无源可读**，② 与 ④ 是**同一处**（宿主把「值没变的开关」当「用户刚点了一下」），③ 是**榜没有自己那一层容器**。

#### 取证：真机 GET 原文 + 离线复现（探针只发 GET，一行 POST 都没打）

`tmp/probe-s18.mjs` → `tmp/s18-get.txt`：`/prefs` 里 `sources` 只有用户写过的键；`/snapshot` 的 `sources` 三行**都没有 `enabled` 这一格**，而 `l1a` 带着 `state:"on" · pid:12404`、`latest.netDown 8612`、`series.netDown n=351` —— 明明在采。设置页那颗开关当时只能去读 `prefs.sources`，**库里没写过就是 `undefined` ⇒ 画成「没开」**。这就是①。
`tmp/repro-s18.mjs`（真 `createCollectService` + 计数桩，记 `enable()` 次数）改前读数：`setSource('l1b',true)` 起 1 次，**再 5 次 `setVisible(true)`（切页签 / SSE 重连 / visibilitychange 都会来）⇒ powershell 起 6 次**；再 3 次 `setSource('l1a',true)`（只是改了别的设置，`index.js` 的 `syncRuntime()` 会把四源全量重放）⇒ `l1a.enable()` 又 3 次。改后（`tmp/s18-repro-after.txt`）同一串动作：**powershell 1 次、l1a 1 次**。`tmp/s18b-pid.txt` 是同时段 SSE 时间线（`l1a on/24580/r0`、`l1b off/null/r0`，12s 内 8 帧）—— 重启计数与源条读数对得上才算证据。

#### 根因② 与 ④ 是同一处：`enable()` 落到监督者是 `start()`，而 `start()` 同键先 teardown 再冷启

`lib/collect/supervisor.js` 的 `start(key)` 对同键会**杀掉正在跑的孩子再冷启**（L1b 实测 4.3s 空窗）。而服务层的 `setSource` 原本按「值有没有变」裁，`setVisible(true)` 更是每次都无条件 `l1b.enable()`。两条叠起来：用户改任何一条设置 ⇒ 全量重放 ⇒ 进程采集被顺手起（=②「开网络采集时进程采集也默认开了」）；切页签 / 断线重连 ⇒ 反复起（=④「为什么不停启动采集」）。

#### 修

- **宿主 `lib/collect/service.js`**：新增 `l1aLive` / `l1bLive` 两面幂等门（:141-152），`ensureL1a()` / `ensureL1b()` 只在「该起且还没许过起」时动孩子；`setSource` 同值既不起也不停（:306-325，关掉时才 `disable()` 并 `clearProc()`，残榜不留）；`setVisible` 只在**真在跑**时走「停 + 清残值」（:350-360，否则每次隐藏页面白推一帧空榜）；`stop()` / `dispose()` / `restartSource()` 三处成对复位标志（:276-277、:420-421、:339）。源行 `sourceRows()` 补 `enabled`（:228、:246）＝**开关意图**，与 `state`（现在在不在跑）并存且在 L1b 上天然不等。另补 `restartSource(key)`（:336-350）：**这个方法此前根本不在服务出口上**，而 `lib/api.js:396` 的 `POST /api/collect/restart` 一直在调它 —— 源条那颗「重试」点下去必然 500。
- **浏览器 `client.js`**：设置页开关改读宿主源行的 `enabled`（`hostSwitch()` :1515-1519），取不到源行就说「开关状态未确认：宿主没给这一源的开关行。」，**不拿 `undefined` 冒充 `false`**；`l2` 是唯一例外（非常驻、宿主不出那一行 ⇒ 仍读库）。
- **③ 进程榜**：排序收成两个纯函数（`procSortNext` :1745、`procSortedRows` :1756-1770）——默认 CPU 降序、`null`（这轮没读到值的行）**永远沉底**（升序时「—」顶第一行看着既像 0 又像最高，两种假读数）、同值按 PID 定序（否则每帧重画并列的行自己换位置 = 榜在抖）、列名走白名单回落、`.slice()` 不就地改宿主数组。排序态挂在容器上（`SysopsPage` :2985-2986，MonitorPage 依旧零 `useState`）⇒ **SSE 新帧不许顶掉用户点的排序**，且点表头是纯 UI 动作、零请求。表头 `aria-sort` 挂 `<th>`（ARIA 的位置，挂按钮上读屏不认，:1931-1947），点击落在铺满整格的 `.so-th-btn` 上；滚动是独立一层 `.so-tblwrap-proc{max-height:clamp(220px,42vh,400px);overflow:auto}` + `thead th{position:sticky}`（:187-188，S16 那条「内滚动必须自己一层」的规矩搬到这儿）；卡头那句改成「…默认关闭 · 点 CPU% / 内存 表头可换排序」（:1983）——入口存在但没人知道能点，等于没有入口。
- **原型 `prototype/index.html`**（图纸半边同改）：CSS 同口径（:240-247）、`procSort` / `procSortNext` / `procThs()` / `procTable()`（:1204-1236）、`#procBody` 上代理 `[data-sort-col]`（:1280-1284），**旧的 `#procSort` seg 整块删除**（两套入口就是两套真相）。

#### 本轮自己踩的坑（如实记）

1. **CSS 模板字符串里写了反引号**：给 `.so-tblwrap-proc` 加的注释里用了 `` `so-tblwrap-proc` ``，直接把 client.js 的样式串截断，套件第一跑就 `SyntaxError: Unexpected identifier 'aria'`（:189）。已在那条注释里留一行警告：**这段在 CSS 模板字符串里，注释不许出现反引号**。
2. **限高断言一开始量错了对象**：先用 `documentElement.scrollHeight` 判「卡底不许顶出视口」，实测报 `bottom 1223 vs 视口 1000`。插件的滚动层其实是 `.so-root`（`max-height:100vh;overflow-y:auto`，因为宿主 `centerCol` 是 `overflow:hidden`，S16 就为这件事加过同一款兜底），文档本身永不滚。改成量**最近可滚祖先** + 一条可达性判据（滚到底后卡底在框内、`只读榜` 那句可见）。
3. **截图动作污染了读数**：`shot()` 里的 `scrollIntoView` 把 pane 的 `scrollTop` 带走，于是「框内滚动后的 pane 位置」读到的是 394 而不是 0。加 `resetPane()`：每次量之前把最近可滚祖先和框自己归零。
4. **夹具第三次撒谎**：`tmp/gen-preview.mjs` 的 `sources` 三行是手编的 label/detail 且**缺 `enabled`**，等于用假夹具验真机症状①。改成从 `lib/collect/service.js` 正则取 `SOURCE_LABELS`（取不到就硬失败）并按宿主真形状给三行带 `enabled`；原型进程榜原本只有 8 行 —— **限高在 8 行上根本量不出来**，补 `fillProcs()` 到 32 行（S16/S17「夹具不许比宿主少」那条的另一半：也不许短到让判据空转）。
5. **变异电池首跑漏网一条**（`PT-2`：把原型属性名从 `data-sort-col` 改回 `data-sort`）：`includes('data-sort-col')` 被代理监听那一处满足，`doesNotMatch(/data-sort="(cpu|mem)"/)` 又只吃字面量（`k` 是变量）。补一条**逐字钉住表头发出那串字符串**（`test/client.test.mjs` pg1-10i），顺带给原型的四条排序判据也各加逐字钉 —— 图纸不能被 `require` 出来跑，只能钉字面。

#### 验证读数（2026-10-01 现采）

- **9 套件两模式全绿**：`SKIP_LOCAL=1` 合计 **515**（`client 187 · clean 81 · collect 52 · search 44 · plugin 44 · alerts 34 · host-compat 25 · prefs 29 · guard 19`）；不带 `SKIP_LOCAL` 合计 **523**（`client 189 · search 47 · host-compat 27 · clean 82`，其余同）。本轮新增/扩写：`svc-11`（重复可见只起 1 次）、`svc-12`（同值全量重放不起不停）、`svc-13`（`enabled` 是意图、`state` 是在不在跑，两者可不等；并补 l0 那一格的 `enabled`）、`svc-14`（`restartSource` 存在且按当前条件重起）、`pg1-10h`（排序助手纯函数：沉底 / 定序 / 回落 / 不改原数组）、`pg1-10i`（卡内滚动 + `aria-sort` + 点的是列键 + 两边 CSS 与文案逐字同口径 + 原型判据字面钉）、`cn-26`（活容器：默认 CPU 降序 → 点内存 → 再点翻向 → 点回 CPU，全程 `reqsDelta 0`，推一条反序 `proc` 帧后用户排序仍在）、`pg4-2`/`pg4-2b`（开关吃宿主 `enabled`、缺行说「未确认」）。
- **变异电池 `tmp/mut_s18.mjs`：36/36 全红、逐条字节级还原**（`allRestored:true`；`host 0dcd375dba0d · client 6eb512509150 · proto 78456f95618e`，日志 `tmp/s18-mut.txt`）。三组按文件配套件：`HS-1~8` 跑 collect（`enabled` 拿 state 冒充 / l0 恒 false / 两面门各摘一次 / 忘装门 / 绕开 `ensure` 直接 enable / 重启不卸门 / 重启不看可见性），`CL-1~18` 跑 client（默认口径 / 列名白名单 / PID 定序 / null 沉底 / 方向系数 / 就地改数组 / 换列回落 / 翻向 / aria 位置 / 点击发的键 / 容器类名 / 限高 / 吸顶 / 初值 / 不传手 / 卡头文案 / 开关读库 / 缺行冒充 false），`PT-1~10` 跑 client（原型同一批：容器类名 / 属性名 / aria 位置 / 默认排序 / 换列 / 翻向 / 方向系数 / 限高 / 吸顶 / 文案）。
- **真浏览器核对**（headless Chrome + CDP 9230，`node tmp/gen-preview.mjs` → `node tmp/verify-s18.mjs` → `tmp/s18-verify.json` / `.txt`，`fails:[]`）：推 **300 行** `proc` 帧（含 3 行 `cpuPct:null`）。默认 `first p284.exe · last p291.exe · rows 300`；**`overflowInBox 10733px` 全在框里**（`wrapH 400 · computedMaxH 400px · computedOverflowY auto · sticky`，`headStickyGap 0`），而整页 `pageScrollHeight 1000 == viewportH 1000`、`window.scrollY` 全程 0 —— 用户批注的「整页滚动」在数字上没了。点内存 → `p231.exe desc`、再点 → `p0.exe asc`（`null` 行仍在底）、点回 CPU → `p284.exe desc`；**`reqsDelta 0`**、`collectReqs []`；再推一帧反序 `proc` → 仍是 `p284.exe desc`。滚到底：`paneSel so-root · paneScrollH 1394 · paneClientH 1000 · wrapBottom 785 ≤ paneBottom 972 · noticeVisible true`。`aria [descending, none]`、`segInProcHead 0`、`overlays 0`。原型：`procSortSeg 0 · oldDataSort 0`，默认 `Discord.exe` 顶行、框内溢出 `817px`，三步点击同序，卡头 `sub` 与 client **逐字同**。
- **用例 id 撞号自查**（`tmp/check-dup-ids.mjs`，正则只吃开头的 ASCII 编号段、中文开头的整串比，避开 §8.13 记的那个「`check('C 盘…')` 只截到一个 `C`」的洞）：九个文件共 **523** 条，撞号 **0**；条数与上面「不带 `SKIP_LOCAL` 合计 523」逐文件对得上（`client 189 · clean 82 · search 47 · collect 52 · plugin 44 · alerts 34 · prefs 29 · host-compat 27 · guard 19`）。
- **逐张看图 7 张**：`s18-1-client-default`（默认 CPU 降序 + 表头箭头 + 卡高 554）、`s18-2-client-box-bottom`（滚到框底，表头仍吸顶、页面无位移）、`s18-3-client-mem-desc` / `s18-4-client-cpu-desc`（换列与换向）、`s18-7-client-fullpage`（整页：榜卡在页面里不再拉长文档）、`s18-5-proto-default` / `s18-6-proto-mem-desc`（原型整页同形状）。

**宿主半边本轮有改动**（`lib/collect/service.js`：幂等门 / `enabled` / `restartSource`）⇒ **S18 需要真机重启 dsh 才生效**（桌面版退出重开，端口 **19387**），只改 `client.js` 的③刷新即可。重启后按 GET-only 复核四件：源行带 `enabled` 且默认 `l1a:true`；开一次网速采集后 powershell 不再被顺手起（`/snapshot` 的 `l1b.state` 保持 `off`）；同一面板里连点页签/SSE 重连后 `l1b` 的 `restarts` 不再爬；设置页网速开关显示「开」。真机读数落 `tmp/` 再补进本节。

**未提交**（S18 连同 S12~S17 各批一起等真机复核通过后再合并处理）。S16 留下的三条待用户定夺原样带着；本轮不新增悬案。

> **复核结果（2026-10-01 当天）：① 只修了一半。** 用户重启真机后截图仍是「网络吞吐 未开启」—— 见 §8.18。

### 8.18 真机第十八批续：① 只修了一半 —— 启动期根本没有一条拉起 L1a 的路径（2026-10-01）

用户重启 dsh 后回来一张截图，红框圈住右上角的 **网络吞吐** 卡：数值 `—`、`下行 · 上行 —`，采集源条那一行是 `网络吞吐 未开启 未开启 开启`，下面配一句「不是说了网络采集默认开启吗」。同一张图也证明两件事生效了：`进程占用榜` 卡头已经是新那句「…默认关闭 · 点 CPU% / 内存 表头可换排序」（③ 到界了），源条带着新的 `enabled` 语义。

#### 取证：GET-only 探针（`tmp/probe-s18.mjs` → `tmp/s18-get2.txt`）

```
prefs.sources = { l1a: true, l1b: true }        // updatedAt 与重启前那一次逐字相同 ⇒ 库没被动过
sources.l1a  = { state: "off", enabled: true,  pid: null, detail: "未开启" }
sources.l1b  = { state: "off", enabled: false, pid: null }
cadence 1s · latest.netDown = null · series.netDown n = 0
```

`enabled:true` 而 `state:off` ⇒ **§8.17 修的那一半是对的**（开关意图现在说实话了，设置页那颗开关确实显示「开」），但**采集本身没起**。`l1b.enabled` 是 `false` 而库里存的是 `true` —— 那是用户这一轮自己在设置页关掉的（`updatedAt` 没变是因为 `sources` 组的写入走的是同一份行的旧时间戳，不在本轮问题里）。

#### 根因：三条起 L1a 的路径，启动期一条都不走

`ensureL1a()` 只有三个调用点：`start()`、`setSource('l1a', true)`、`restartSource('l1a')`。
- `start()`：**`index.js:432` 故意不调**（注释写着「它会立即 `l1a.enable()` 去 spawn typeperf/powershell 常驻子进程」，为的是 `apply()` 在无宿主子进程生命周期管理时不派生孤儿）；
- `setSource`：只在用户点开关（`lib/api.js:384`）或**任何一次 prefs 写入之后**的 `syncRuntime()`（`index.js:287`）里被敲 —— 启动期没有写入，所以没人敲；
- `restartSource`：要点「重试」才走。

而 `index.js:433` 那句注释说「子进程由可见性驱动的 `setSource` / SSE 首连再拉起」——**这句是空头支票**：`lib/api.js:684` 的首连钩子打的是 `collect.setVisible(true)`，而 `setVisible` 里只 `ensureL1b()`。所以 L1a 在「重启宿主 + 打开面板」这条真路径上**永远起不来**，只有当用户手动开关过一次（= 触发一次 prefs 写入 = 一次 `syncRuntime` 全量重放）它才活 —— 这正好解释了 §8.17 取证时那份 `pid:12404 · state:on` 的读数：**那次探针是在用户点过开关之后打的**，它把启动期的洞盖住了。

`git show HEAD:lib/collect/service.js` 与 `HEAD:lib/api.js` 同形 ⇒ **这是既有的洞，不是 S18 改出来的**（本轮的幂等门只是让它更显眼：以前重复点开关会顺手把别的路也重起，现在不会了）。

#### 修：首连那一声 `setVisible(true)` 两路都问一次

`lib/collect/service.js` 的 `setVisible`（:346-365）：`visible` 为真时 `ensureL1a()` + `ensureL1b()`；为假时**仍只停 l1b**（l1a 实测成本 <1%，跟着可见性起停会让用户切回页面白丢一窗暖身 —— spec §3.1 那条决策不变）。两路都靠各自的幂等门兜着，所以「SSE 重连 / 切页签 / visibilitychange」反复敲 `setVisible(true)` 也只起一次（= ④ 的同一道门，不用新加机制）。

#### 本轮自己踩的坑（如实记）

1. **取证时机骗了我**：§8.17 那份真机读数是在用户操作之后采的，于是「宿主默认在采 L1a」被当成现状写进了台账。**复核必须从「刚重启、没人点过」的状态采**，否则症状会被上一次操作盖掉。
2. **注释里的设计意图不等于代码里的实现**：`index.js:433` 那句「SSE 首连再拉起」我上轮读过、也信了。判据应该是**顺着调用点数一遍谁能起 l1a**，而不是读注释。
3. **测试全绿而真机不转**：`svc-11~14` 每条都以 `w.svc.start()` 开局，而真装配**恰恰不调 `start()`** —— 这就是记忆里那条「真机用例的装配口径必须与 `index.js` 逐字同形」的反例。新增的 `svc-15` 就是按真装配口径写的（不开 `start()`，直接 `setVisible(true)`）。

#### 验证读数（2026-10-01 现采）

- **9 套件两模式全绿**：`SKIP_LOCAL=1` 合计 **516**、不带 `SKIP_LOCAL` 合计 **524**（`collect 52→53`：新增 `svc-15`「首连必须把默认开的 L1a 拉起来，隐藏不停它、重复首连不再起；库里是关 ⇒ 首连一起都不起」）。用例 id 撞号自查：524 条、撞号 0。
- **`svc-15` 不许拿 `sup.state()` 当证据**：假监督者恒报 `state:'on'`，断 `state==='on'` 是空断言 —— 判据写成数 `w.started` / `w.stopped`（起没起、停没停都是**动作**，不是替身的口供）。
- **变异电池扩到 38 条，`38/38 全红`、逐条字节级还原**（`allRestored:true`；`host 6b8813a3d2c8 · client 6eb512509150 · proto 78456f95618e`，日志 `tmp/s18-mut.txt`）。新增两条打在新落点上：`HS-9` 把 `setVisible` 里的 `ensureL1a()` 摘掉（= 本轮症状本体）、`HS-10` 让隐藏页面把 L1a 也停掉（违反 §3.1 那条决策）。

**又要重启一次真机**：本轮改的是宿主半边（`lib/collect/service.js`）。重启后 GET-only 复核三件：`sources.l1a` 应当 `state:"on"` 且 `pid` 有值、`series.netDown n>0`；源条的「网络吞吐」不再显示「未开启」；右上角那张卡的数值/单位阶梯有数。**这条记进 §8.17 末尾的待办，做完把读数补回本节。**

**未提交**（S18 主批 + 本续批连同 S12~S17 各批一起等真机复核通过后再合并处理）。

#### 复核读数（2026-10-01 晚，`tmp/probe-s18.mjs` 只发 GET → `tmp/s19-get.txt`）

用户重启真机、面板开着的那一屏：

```
sources.l1a = { state: "on", enabled: true, pid: 14604, restarts: 0, detail: "已排 0 次重启" }
sources.l1b = { state: "off", enabled: true, pid: null, restarts: 0 }   proc = { state:"off", rows: 388 }
cadence 1s · latest.netDown = 7514.88188 · series.netDown n = 326
```

① 到界了：首连那一声 `setVisible(true)` 确实把默认开的 L1a 拉了起来（`pid` 有值、`series` 在 1s 节奏下攒到 326 点、右上角那张卡有数），且 `restarts` 仍是 0 ⇒ 幂等门没被反复摘挂（= ④ 同一条判据在真机上成立）。②没有复活：`l1b` 是 `enabled:true + state:off` 这一对**天然不等**的组合（意图开、现在没在跑），不是 §8.17 那个「拿 state 冒充 enabled」的形状。

同屏另记一条**没查清的观察**：`proc.rows = 388` 与 `l1b.state = "off"` 同时在场 —— 残榜没被清。`setVisible(false)` 那条路径是 `disable()` + `clearProc()` 成对的（§8.17），所以停 L1b 的应当不是隐藏；本轮没有第三次采样能断定是哪条路径停的，先记着，别把它读成「隐藏清干净了」。

#### 同一批探针顺出来的**新悬案**：库里存的源开关，启动期一条都不重放给运行时

隔了一会儿（面板已关、没人写过配置）连打两次 GET，间隔 8s（`tmp/s19-get2.txt` / `tmp/s19-get3.txt`，两次读数逐字相同）：

```
prefs.sources = { l1a: true, l1b: true } · updatedAt 1790826518449   // 与上一屏逐字相同 ⇒ 库没被动过
sources.l1a = { state:"off", enabled:true,  pid:null, restarts:0 }   latest.netDown=null · series.netDown n=0
sources.l1b = { state:"off", enabled:FALSE, pid:null, restarts:0 }
```

`enabled` 那格是从 `switches` 现取的，而库里明明写着 `l1b:true` —— **`enabled:false` 是宿主替用户编的一句话**。顺着代码数了一遍，根因不在 §8.18 那次改动上：

- `lib/collect/service.js:54` 的 `const prefs = (getPrefs && getPrefs()) || {}` 与 `:58` 的 `const switches = { l0:true, l1a:true, l1b:false, l2:false, ...(prefs.sources || {}) }` —— **`switches` 是构造那一刻的一次性快照**（`const`，之后只有 `setSource` :306 会写它）。
- `index.js:267` 的 `let view = mergePrefs(resolved, null)` 就是**不含库内容**的默认视图；真正把库读进来的是 `reloadPrefs()`（:269），它的调用点只有两处：`ctx.inject(['storageDomain'], …)` 回调里那句 `void reloadPrefs()`（:441，异步、落地晚于 :323 的 `createCollectService`）和 `prefsFacade.writeMany` 之后（:309）。
- `reloadPrefs()` 后面**不接 `syncRuntime()`**（:441 只跟了 `syncCaps()`），而把 `view.prefs.sources` 推给 `collect.setSource` 的那段循环恰恰在 `syncRuntime` 里（:290-300）。

所以启动期这条真路径是：服务按硬编默认建好（`l1b:false`）→ 库读到了但没人重放 → 直到用户**写一次任何配置**才被子 `syncRuntime` 全量重放。后果有两层：设置页那颗开关会显示「没开」而库里写着「开」（= §8.18 那条「库里 l1b:true 而界面说没开」的另一半，之前我把它记成「用户自己关掉的」，**那个解释是错的**，本轮两份 GET 把它证伪了）；且 `l1a` 只是运气好——它的默认值与库里存的一致，所以从没露出过。

修法候选（一行，但**属宿主半边、要再重启一次真机**，且不在 S19 这两条批注的范围里，故本轮只记不动）：`index.js:441` 的 `void reloadPrefs()` 改成 `reloadPrefs().then(() => syncRuntime())`，让"库落地"与"重放给运行时"成对；同时给 `svc-*` 补一条按真装配口径的用例（先用默认 prefs 建服务，再喂库值，断 `sourceRows()` 里的 `enabled` 跟库不跟默认）。**待用户点头再做。**

### 8.19 真机第十九批 S19：清理页两条批注 —— 六颗 chip 收成一枚下拉 / 操作条搬到表上方（2026-10-01）

用户两张真机截图（507 项那一屏）配一句话：「1.这些不要放在这里，放在全部分类那里使用下拉选择；2.不要放在最下面，放在上面」。① 圈的是清单表上方那**六颗分类 chip**（每颗后面还各挂一枚「全选本组 N」，两行就换行铺满）；② 圈的是**页面最底下**那条 `已选 3 项 · 预计释放 141 MB` + 隔离到暂存目录 / 清理选中 —— 表在卡内限高滚动，它下面还压着操作条 + modeDefault 说明 + 暂存区交代，要点「清理选中」得先滚到卡尾。

#### 取舍：这一枚是原生 `<select>`，是本仓库唯一被点名的例外

「交互一律自研控件、无浮层」这条规矩当初立起来，是因为浮层满天飞（cf-12 钉的就是 CSS 里不许有 toast/notice-bar/`position:fixed` 顶部条）。用户这次**点名要下拉**，而原生 `<select>` 的弹层由 UA 画、不受我们那套就地落卡的口径管。两头都不能放开：

- 退回「一颗 `select` 都不许有」= 直接挡在用户要的东西上；
- 借这一颗把「原生控件」整体放开 = 当初立规矩的那个局面回来。

所以 cf-11（`test/client.test.mjs:226`）改成**数得过来的例外**：`client.js` 全文 `h('select'` **恰好一次**，且那一颗必须挂 `.so-cat-select`（类名与 CSS 单点同出处）。这条改口径的过程本身记进台账：**规则与被点名冲突时，收窄规则的钉法，不放宽规则的精神**。

#### 修

- **浏览器 `client.js`**：`catBar`（:2248-2273）—— 标签「分类」（:2249，`.so-cat-lb` :208）+ `<select class="so-cat-select">`（:2250-2260，CSS :209）+ 一枚「全选本组」+ 一句筛选态交代。option 文本口径 `${g.key} · ${g.count} 项 · ${g.bytesText} · 可清理 ${g.cleanable}`，尾部按 `g.risky / g.rejected` 追加「· 有风险 N / · 已拒绝 N」（:2259-2260），首格 `全部分类（${groups.length} 组 · ${planObj.items.length} 项）`（:2257）—— **chip 条删干净，但每颗 chip 原来能读到的数一个不丢**（这是 pg2-61 那批断言的内容）。`value` 取 `filterKey`（归一后的键，见下）而不是 `catFilter` 原值 ⇒ 拿着上一轮扫描的旧类名时控件不会装作还在筛选。筛选态那句（:2272-2273）写的是「上方「已选 N 项」与执行按钮吃的都是整份清单的勾选」—— 路标方向必须与 ② 搬完之后的事实一致。
- **`client.js` 的 `totBar`**（:2281-2296）搬到主卡 children 里 `header` 之后（:2347），`.so-tot` 的 CSS（:213）里那句 `margin:14px` 保持；`modeDefault` 那句说明书（:2295-2296）跟着按钮一起搬（它是这两个写按钮的解释，留在表尾就是"说明书与按钮分家"）；`catBar` 仍在表前一行（:2361-2362）。两处指路的话同批改口：`复核后点上面「清理选中」`（:2218）、`请勾选项后用上面的「清理选中」`（:2332）—— pg2-64（`test/client.test.mjs:1984`）对 `client.js` 与原型**两个文件各**逐字钉这三句，并禁掉一切还朝「下面」指路的旧话。
- **筛选键归一**（:2074-2081，本轮补的洞）：`curGroup = groups.find(g => g.key === String(catFilter||'')) || null` ⇒ 拿旧类名时 `filterKey` 归 `''`、`visibleIds` 归 `null`，下拉的 `value` 与画面一起回到「全部分类」，不再出现「表里是全量、话却说正在只看某一组」这种自相矛盾。
- **原型 `prototype/index.html`**（图纸半边同改）：CSS `.catbar/.cat-lb/.cat-select`（:258-260，注释里明写「与 client.js 的 .so-catbar/.so-cat-select 同形」）、`#cleanPlan` 卡里 `.tot` 整块移到 `.card-head` 正下方（:709-720，含 `<div class="hint note">执行方式取自快照 modeDefault…`）、`#catStrip` 那层由 chip 容器改做下拉容器（:734，`hidden` 由 `renderCats()` 控）、`catOptionText(g)`（:1469）+ `renderCats()`（:1473-1496，`<select class="cat-select" id="catSel">` :1482 + `#btnPickGroup data-cur` :1488）、`change` 代理在 `#catStrip` 上（:1497）、「全选本组」点击吃本组 `selectable` 做并集（:1502-1514）。旧的六颗 chip 与其 CSS 两边一起删净（pg2-45 断 `so-cats` 类名 0 次、pg2-64 断原型同一处）。

#### 本轮自己踩的坑（如实记）

1. **夹具短到让判据空转**（第三次犯同一族）：`tmp/gen-preview.mjs` 的清单只有 6 项 / 2 组，量不出「表在框内滚」（`maxScroll 0`），下拉里各组也全是 1 项 ⇒ 「筛只减行」「全选本组加了几项」都退化成看不出来。补 30 条同形状条目（5 组各 6 条，`plan.totals` 跟着重算）后是 **36 项 / 5 组、框内溢出 1766px**。
2. **用 `checkedTrue` 当「筛选不动勾选」的证人是个错的证人**：筛选后画面里只剩本组那几行，露出的勾数**本来就该变**（首跑报「勾了 4 项，筛完读到 1」）。判据换成操作条那句**整份清单口径**的「已选 N 项」：它随勾选动、不随筛选动。
3. **行数判据两次都量错**：先按 `容器高 / select 高` 判 chip 条是不是换行（padding 让结果是 2），再按 `top/6` 分带（原型基线偏移，也报 2）。最后改成**对容器直接子元素做重叠区间聚类** ⇒ 两页都读到 `catbarLines:1`。
4. **`walk` 的 `has()` 是子串匹配，标签证人被它骗了**（变异电池首跑的漏网之一，见下）：`plain.has('分类')` 被「全部分类（5 组 · 36 项）」那格满足，把标签整颗删掉照样绿。改成认**类名 `.so-cat-lb` + 独立文本节点 `t === '分类'`**。
5. **有一条变异是"等价变异"，不是漏测**：`CL-11` 把 `onSelectGroup(curGroup.selectable)` 改成 `curGroup.ids`，画面**读不出差别** —— 因为 `sel` 的每个消费点（`planRows.checked` :874、`selTotals` :938、`selectAllIds` :966、`categoryGroups.selected` :1117）都再过一遍 `deniedOf`。这类"靠下游单点过滤兜住"的刀只能钉**调用点字面**：pg2-45 补 `assert.match(code, /onSelectGroup\(curGroup\.selectable\)/)` + 禁 `curGroup.ids`，并在注释里写清为什么这里用源码钉而不是画面钉（集合里混进被拒项之后，任何一个**新增**消费者漏了过滤就中招）。
6. **变异电池自己会把"套件跑不起来"读成"测试很稳固"**：`CL-15` 那刀只加了三元开头没加结尾 ⇒ `SyntaxError`、零条 `FAIL`、判成「绿」。本轮给 `tmp/mut_s19.mjs` 加了第三种判读：**崩（exit≠0 且零 FAIL）= 变异无效、要修刀**，并把 `CL-15` 改成合法的双锚点刀（数组格式从 `[锚点, 替身]` 扩成 `[[锚点, 替身], …]`，"搬位置"这类刀必须多处同批改）。
7. **cn-15 的期望值我先写错了一版**：以为「全选本组」之后画面里该有 3 颗勾着的框，实际筛选态只渲染本组两行 ⇒ 是 1 颗。这次**改的是测试的期望**而不是代码 —— 按钮报的是本组 `selectable` 的条数、差额写在 title（`已勾 6 项`），那句话比"数画面里的勾"更对。

#### 验证读数（2026-10-01 现采）

- **9 套件两模式全绿**：`SKIP_LOCAL=1` 合计 **520**（`client 191 · clean 81 · collect 53 · search 44 · plugin 44 · alerts 34 · host-compat 25 · prefs 29 · guard 19`）；不带 `SKIP_LOCAL` 合计 **526**（差在 `clean 81→82`、`host-compat 25→27`、`search 44→47` 这六条真机用例）。用例 id 撞号自查（`node tmp/check-dup-ids.mjs`）：九文件 **526** 条、撞号 **无**，逐文件条数与上面同一一对得上。本轮新增/扩写：`cf-11`（改成"唯一原生例外"的数法）、`pg2-45`（下拉在场 + 旧 chip 删净 + 标签类名与独立文本 + `select.value` 归一 + capsRO 优先于"选了分组" + 筛选不动「已选」+ `selectable` 调用点源码钉）、`pg2-61`（option 尾部两档在原型半边同样要有）、`pg2-63`（texts 文档序：读数 < 表头 < modeDefault 句 ⇒ 操作条在表**前**；两颗写按钮全页各恰一颗）、`pg2-64`（两边同改：三句指路逐字 + 旧朝下的话清零）、`cn-15`（活体接线：默认勾 3 → 在另一组挖洞到 2 → 筛选后仍读 2 → 换组点「全选本组」只补回 1 → 画面里勾着的恰 1 颗）。
- **变异电池 `tmp/mut_s19.mjs`：35/35 全红、逐条字节级还原**（`allRestored:true`；`client f030b4ce9065 · proto c4394a574f4b`，日志 `tmp/s19-mut.txt`）。六组：`CL-1~5`（option 少一档 / 少总项数 / 拿首项 kind 冒充整组 / `filterKey` 不归一 / 筛选不减行）、`CL-6~10`（筛选顺手改勾选 / 路标朝下 / 不交代其余项 / 全选吃全表 / 连被拒项一起勾）、`CL-11~15`（不看 capsRO / 禁用原因不指路 / 勾满不改口 / 按钮凭空消失）、`CL-16~18`（容器类名退回 chip / select 类名改掉 / 标签删掉）、`CL-19~24`（操作条没搬 / 旧位置留一份 / 说明书整条删掉 / 「已选」改读可见行 / 两句指路朝下）+ `PT-1~11`（原型半边同一批：option 两档 / kind 复活 / 路标朝下 / `change` 不接 / option id 改 / 类名退回 `cats` / 旧 `data-cat` 死路径留一份 / 表下留一份 `.tot` / `.tot` 改名 / 两句指路朝下）。**首跑是 33/35**，两条漏网按上面第 4、5 条分别补掉。
- **真浏览器核对**（headless Chrome + CDP 9230：`node tmp/gen-preview.mjs` → `node tmp/verify-s19.mjs` → `tmp/s19-verify.json` / `.txt`，`fails:[]`，`overlays` 全程 0）：
  - 默认一屏：`chips:0`、`catbarLines:1`、下拉六格文本逐字如上（首格「全部分类（5 组 · 36 项）」，末格带「· 有风险 1」）、操作条 `bar {top:347, bottom:428, aboveTable:true, gap:228}`（表在 656）、`sum:"已选 34 项 · 预计释放 4.60 GB"`、`docOverflowX:false`。
  - 筛到「用户临时目录」：`via:"native"`（用 `HTMLSelectElement.prototype` 的原生 setter + `change` 事件驱动，不是手触 fiber ⇒ 真用户点这条路确实通）、`rows:8`、**`sumN` 仍是 34**（筛选不动勾选，真机读数的判据）、`visibleChecked:7`、`pick:["本组已全选",false]`。
  - 挖一个洞（取消本组一行）：`sumN:33`、按钮改口「全选本组 7」；点下去 → `sumN:34`、按钮回到「本组已全选」；切回「全部分类」→ `rows:36`、`sumN:34`、按钮禁用（没有作用对象）。
  - **把表在框内滚到底**：`tableScrolledTo 1766 == tableMaxScroll 1766`，此时 `bar` 的 `top:66/bottom:147`、两颗写按钮 `79~105`，`barFullyInPane:true`、`btnFullyInPane:true`、`headStickyGap:0` —— 这就是批注 ② 要的效果：滚到清单任何位置，操作条都在卡头下面够得着，不用先滚到卡尾。整页 `cardH:955`、`pvMissing:[]`、`pvConsole:[]`。
  - 原型同一套：`options` 12 格、`chips:0`、`catbarLines:1`、`barAboveTable:true`（`gap:68`）、`sum:"已选 8 项 · 预计释放 5.23 GB"`，筛选走 `native`、`sumN` 不变，挖洞/补回/切回三步同序。
- **逐张看图 7 张**：`s19-1-client-plan-top`（下拉那一行 + 操作条在表上方）、`s19-2-client-filtered`（筛到一组，「已选」没变）、`s19-7-client-hole`（挖洞后按钮改口「全选本组 7」）、`s19-3-client-table-bottom`（**表滚到框底**，操作条与两颗按钮仍在卡头下方）、`s19-4-client-fullpage`（整页无横向溢出、无浮层）、`s19-5-proto-plan-top` / `s19-6-proto-filtered`（图纸半边同形状）。

**本轮只动浏览器半边（`client.js`）与原型，宿主半边一行未改** ⇒ 真机上刷新那个面板就能看到分类下拉与上方操作条，**不需要重启 dsh**。（顺出来的那条「启动期 prefs 不重放给运行时」属宿主半边，见 §8.18 末尾的悬案，本轮未动。）

**未提交**（S19 连同 S12~S18 各批一起等真机复核通过后再合并处理）。本轮新增一条待用户定夺：`index.js:441` 那句 `void reloadPrefs()` 要不要接 `syncRuntime()`（要就再重启一次真机）。

### 8.20 真机第二十批 S20：操作条上那三句说明「这些不要了」（2026-10-02）

用户真机截图（5670 项那一屏，S19 的下拉与上方操作条都已在位）圈住操作条上的三句话，批注两个字：「这些不要了」。三句是：①「删除不可恢复，回收站不参与」（以及它的兄弟分支「勾选至少一项」）、②「已默认勾上 3 项「可清理」（有风险的 5667 项、已拒绝的 0 项都没勾）」、③「执行方式取自快照 modeDefault：永久删除（文件）；类型不符的条目会被记为「跳过」，不会被硬删。」

#### 取舍：删的是**复述**，不是**真相**

一句都不要"顺手删掉就完事"——先问每一句原本回答的是哪一问，那一问在页面上还有没有人答：

| 删掉的这句 | 原来答的是哪一问 | 删了之后由谁答 |
|---|---|---|
| 删除不可恢复，回收站不参与 | 点「清理选中」会不会进回收站 | 就地确认行（`client.js:2349` / 原型 `:1611`）—— 真动手前那一句才是它该在的位置，操作条上是提前复述 |
| 勾选至少一项（禁用原因） | 这颗按钮为什么灰着 | 两颗写按钮的 `title`（`writeWhy` `client.js:2099-2100`）—— 灰着的按钮自己说为什么灰 |
| 已默认勾上 N 项「可清理」… | 默认勾的是哪一批、剩下几批为什么没勾 | 卡头那行「共 N 项 · 可清理 · 有风险 · 已拒绝」（`client.js:2322` / 原型 `:1547`）—— 同一份三个数，操作条那份是**第二份真相** |
| 执行方式取自快照 modeDefault… | 会怎么删、类型不符怎么办 | 「清理选中」的按钮 title 与就地确认行；`modeDefault` 本身在留痕/清单快照里可读 |

所以这一轮真正的改动是：**把复述删净，把唯一证人钉牢**。第 ② 句尤其要留个心眼 —— 它是「默认勾选」那一档数字在页面上的**唯一**出口之一，删它必须确认卡头那行还在（`CL-28` 那刀把卡头那行也削成「共 N 项」，测试必须红）。顺带删掉的还有 `cleanAutoSel` 这一整个 state（它只为第 ② 句存在：`adoptPlan` 写、`doCleanScan` 清、`CleanPage` 读），一次扫描一次的 `autoSelRef` 那道幂等门保留（它还管着别的事）。

#### 修

- **`client.js`**：`totBar`（:2285-2293）删到只剩「`.so-sum` 读数 + 条件性的风险/只读交代 + 一颗 `.so-grow` 装两颗按钮」；`.so-tot .so-tot-note{flex:1 0 100%}`（原 :215）随第 ③ 句一起删；`cleanAutoSel` state、`adoptPlan` 里的赋值、`doCleanScan` 里的清空（:3065 附近）、`CleanPage` props 里的 `autoSel` 四处一并摘掉。
- **`prototype/index.html`**：`.tot` 那段 markup（:708-714）删到与 client 同形；`.tot .note` 那条 CSS 删；`renderAutoSelNote()` 整个函数、`renderPlan` 里对它的调用、`autoSelN` 变量与 `adoptPlan()` / 扫描重置里对它的两处赋值、`recompute()` 里写 `#totNote` 那句 —— 图纸上这一族从此不存在（`PT-12` 负责在有人把它们搬回来时报警）。
- **顺出来的一处真分岔（截图并排才看见）**：原型 `.tot .grow` 一直有 `margin-left:auto`（两颗按钮贴右），client 那颗 `.so-grow` 只挂了**内联样式** `display:inline-flex` —— 于是 client 的按钮挤在读数右边、原型贴右，而 `client.js` 的 CSS 注释（:210-212）当时还写着「两颗写按钮贴右」并解释一条**已经删掉的** `flex:1 0 100%`。修法：注释按 S20 现状重写，补 `.so-tot .so-grow{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}`（:216），内联样式摘掉。

#### 本轮自己踩的坑（如实记）

1. **「注释里写了这条规则」≠「这条规则存在」**：`.so-tot .so-grow` 从来没被写过，注释却替它圆谎两轮（S19 的读数只量了「操作条在表上方」，没量条内左右）。判据补在两层：源码层 `assert.match(code, /\.so-tot \.so-grow\{margin-left:auto/)` + 禁内联样式；画面层量「按钮右缘到条右缘的余量」，两边都应当恰好 15px（padding 14 + 边框 1）。
2. **`walk()` 看不见这件事**：它只吃 vnode 的 `className`，内联 `style` 与 CSS 规则都不在断言射程内 —— 所以"样式两边同口径"这一族只能靠源码钉 + 真浏览器量，别拿 class 名断言冒充。
3. **变异锚点写成通用行**：`PT-12` 首版锚点是 `            <span class="grow">`，图纸里命中 **11 次**（`.grow` 是通用行）。锚点必须带上下文（这次改成从 `#selSize` 那半截起锚）。`ANCHOR_ONLY=1` 先跑一遍就是为这个。
4. **夹具口径**：`pg2-6` 首跑红在 `配置只读：宿主未提供 storageDomain` —— 那枚夹具给的是 `caps:{}`，`writeWhy` 的第一分支先命中，于是"禁用原因"读到的不是本轮要看的那句。改成 `caps:{ storageDomain:true }`，让 `selectable.length===0` 那一支露出来。
5. **从上一轮脚本派生比复制粘贴安全，但插入点要挑在变量声明之后**：`tmp/mk-verify-s20.mjs` 第一版把 S20 断言插到「判定」小节标记之前，那里 `c0/p0` 还没声明 ⇒ TDZ `ReferenceError`；改插到 `out.fails = fails;` 前面。另外**在模板字符串里嵌模板字符串会当场截断**（内层反引号 + `${` 两样都炸），派生脚本里的插入块只能用单引号拼接。
6. **删句子时最容易连带删掉的是"同一格里挨着的读数"**：`barText` 判据写成两半 —— 禁词一个不许有（`删除不可恢复` / `回收站不参与` / `已默认勾上` / `执行方式取自快照` / `永久删除（文件）` / `类型不符的条目`）**且** `^已选 \d+ 项 · 预计释放 ` 必须还在。

#### 验证读数（2026-10-02 现采）

- **9 套件两模式全绿**：`SKIP_LOCAL=1` 合计 **522**（`client 191 · clean 81 · collect 53 · search 46 · plugin 44 · alerts 34 · host-compat 25 · prefs 29 · guard 19`）；不带 `SKIP_LOCAL` 合计 **526**（差在 `clean 81→82`、`host-compat 25→27`、`search 46→47`）。用例 id 撞号自查：526 条、撞号 **无**。本轮改动的用例：`pg2-6`（禁用原因吃 title、夹具带 storageDomain）、`pg2-7`（改名：操作条只剩项数 + 预计释放）、`pg2-46`（默认勾选只由卡头那一行交代）、`pg2-53`（红线说明的锚点从 modeDefault 换成「路径 / 内容」）、`pg2-63`（条上禁词逐条清零 + `so-tot-note` 类名清零）、`pg2-64`（两边同改：`stripComments` 之后 client 与原型各自全文不许出现那三句与 `totNote/autoSelNote/so-tot-note`，同时钉住 `勾选至少一项后才可执行` 与 `.so-tot .so-grow{margin-left:auto}`）。
- **变异电池 `tmp/mut_s19.mjs`（S20 追加 8 刀，共 43 条）：43/43 全红、逐条字节级还原**（`allRestored:true`；`client 471e3948feb2 · proto 9fd2fb68c1bb`，日志 `tmp/s20-mut.txt`）。新增：`CL-21`（把 modeDefault 那句搬回操作条）、`CL-25`（搬回「删除不可恢复，回收站不参与」/「勾选至少一项」）、`CL-26`（搬回「已默认勾上…」）、`CL-27`（连带删掉按钮 title 里的禁用原因）、`CL-28`（把卡头那行唯一证人削成「共 N 项」）、`CL-29`（摘掉 `.so-tot .so-grow` 的 `margin-left:auto`）、`CL-30`（那颗 `.so-grow` 退回内联样式）、`PT-12`（图纸把三句搬回来）、`PT-13`（图纸先分岔：`.tot .grow` 不贴右）。**S19 那 35 刀一条没减** —— 操作条搬上去、下拉收成一行这些事实本轮仍然要守。
- **真浏览器核对**（headless Chrome + CDP 9230：`node tmp/gen-preview.mjs` → `node tmp/verify-s20.mjs`，`fails:[]`，`overlays` 全程 0，`pvMissing:[]`、`pvConsole:[]`）：
  - client 默认一屏：`barText:"已选 34 项 · 预计释放 4.60 GB隔离到暂存目录清理选中"`、`barHints:0`（条内说明颗数）、`barLines:1`、`btnGapRight:15`；`barKids` 只剩两格 `SPAN.so-sum` 与 `SPAN.so-grow`。
  - 原型同一屏：`barText:"已选 8 项 · 预计释放 5.23 GB 隔离到暂存目录 清理选中"`、`barHints:0`、`barLines:1`、`btnGapRight:15` —— **两边余量分毫不差**，这就是上面第 1 条那个分岔被抹平的读数。
  - 筛选 / 挖洞 / 全选本组 / 切回四步的 `sumN` 序列仍是 `34 → 34 → 33 → 34 → 34`（S19 那条「筛选不动勾选」没退化）；表滚到框底时 `barTop:66 / barBottom:118`、`btnFullyInPane:true`、`headStickyGap:0`。
- **逐张看图 7 张**：`s20-1-client-plan-top`（读数在左、两颗按钮贴右，条上再无第三行字）、`s20-2-client-filtered`、`s20-7-client-hole`（「全选本组 7」）、`s20-3-client-table-bottom`、`s20-4-client-fullpage`（无横向溢出、无浮层）、`s20-5-proto-plan-top` / `s20-6-proto-filtered`（图纸半边同形状）。

**本轮只动浏览器半边（`client.js`）与原型，宿主半边一行未改** ⇒ 真机刷新面板即可，**不需要重启 dsh**。

**未提交**（S20 连同 S12~S19 各批一起等真机复核通过后再合并处理）。§8.18 那条悬案（`index.js:441` 的 `void reloadPrefs()` 要不要接 `syncRuntime()`）仍待用户定夺，本轮未动。
