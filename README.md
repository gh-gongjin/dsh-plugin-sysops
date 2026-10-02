# dsh-plugin-sysops

DSH（deepseek HARNESS）的**本机系统运维**插件：在左侧栏增加一个入口，打开一整页本机面板 —— 实时监控 + 两段式 C 盘清理 + 全盘文件搜索 + 监控记录 + 设置。

面向 Windows 桌面机器，**自用工具**的口吻写的：能做什么、做不到什么、以及删除这类不可逆动作是怎么被闸住的，都写在明面上。

**它是什么**

- **实时监控**：CPU 使用率 / 内存占用 / 网络吞吐 / C 盘可用空间四条曲线（30 分钟环形缓冲），采集源状态条常显；进程榜只读，按 CPU 降序、可点 CPU / 内存切排序
- **阈值告警**：规则可配（连续 N 次才报、冷却去重），触发后落进「监控记录」页签 + 侧边栏蓝点，**不推系统通知**（宿主不提供该能力，见下）
- **两段式 C 盘清理**：扫描 → **冻结清单快照** → 逐项勾选 → 执行。执行前你看到的对象列表就是动手时删的对象列表；分类按「建议清理 / 建议先看一眼 / 建议保留」给，默认只勾第一档
- **AI 智能清理**（`lib/clean/ai-advisor.js`）：把清单交给宿主模型做分类建议，**全程零 apply** —— 它只推荐，删不删由你在同一页逐项确认
- **全盘文件搜索**：三级探测选通路（Everything HTTP / `es.exe` / 限定目录遍历），每条结果显示来源 pill；探不到就降级并说明缺哪一级，不静默失效
- **留痕**：每次执行的清单快照、执行方式、前后容量差、成功 / 跳过 / 失败三档计数都落库，不是「大概清了多少」

**它不是什么**（红线，收口在 `lib/clean/guard.js` 单点，任何模块不得自行放宽）

- **不结束、不杀任何进程**（进程榜只读）
- **不碰系统目录**：`C:\Windows\*`、`Program Files*`、`C:\$Recycle.Bin*` 命中即拒
- **不改属主、不改 ACL、不写注册表**（探测只读）
- **不做开机自启常驻**（宿主不提供该能力，UI 上也不留假开关）
- **探测段绝不夹带安装**：搜索通路三级探测（`lib/search/probe.js`）全程只读（`existsSync` / GET / 查询）
- 同时拒绕过形态：`\\?\` 前缀、UNC、8.3 短文件名、`..` 与 junction 逃逸、大小写与全角变体、未展开的 `%VAR%`、省略盘符。**新增规则在写入阶段就被拒**，而不是执行阶段才失败。

**唯一一处写入系统的动作**：搜索自检卡上的「Everything 一键安装」（`lib/search/installer.js`）。它是显式点击的独立动作，不藏在任何只读流程里，四道闸顺序不能反：

1. **参数永不采信前端** —— `start()` 不收任何来自请求体的字段；包 id（`voidtools.Everything`）、源、参数表全是本文件常量。
2. **非 shell** —— 只经注入的 `execFile` 门面跑，命令行不是拼出来的字符串。
3. **先探再起** —— 探不到 `winget` 就直接拒，界面上「按钮亮不起来」与「点了被拒」是同一句原因。
4. **一次只跑一装** —— 运行期间的第二次点击拒成 `SEARCH_INSTALL_BUSY`。

UAC 提权窗口由 winget 自己弹，**插件不代点同意，也不冒充管理员**。不需要它的话，自己 `winget install voidtools.Everything` 或去官网装，插件只用不碰。

---

## 安装

### 方式 A：官方 CLI

```bash
dsh plugin --profile web add github:gh-gongjin/dsh-plugin-sysops
```

CLI 内部走 pnpm，需要 `pnpm` 在 PATH 里。也可以装本地目录：`dsh plugin --profile web add <本仓库的绝对路径>`。

### 方式 B：手工两步（不需要 pnpm）

1. 编辑 profile 的 `package.json`（默认 `~/.dsh/profiles/web/package.json`，Windows 为 `%USERPROFILE%\.dsh\profiles\web\package.json`）：

   - `dependencies` 增加：`"dsh-plugin-sysops": "link:<本仓库的绝对路径>"`
   - `dsh.profile.bundles` 数组末尾追加 `"dsh-plugin-sysops"`

2. 在 profile 的 `node_modules` 下建一个指向本仓库的目录联接：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-sysops" `
     -Target "<本仓库的绝对路径>"
   ```

3. **重启 dsh**（宿主半边在启动时加载，只刷新页面不够）。

### 停用 / 卸载

临时停用：在 `~/.dsh/profiles/web/cordis.patch.yml` 里加

```yaml
- id: sysops
  disabled: true
```

彻底卸载：删掉方式 B 的两处改动 + 那个目录联接，重启即可。

---

## 界面

五个页签，同一个时刻只渲染一个面板：

| 页签 | 答哪一问 |
|---|---|
| 监控 | 现在这台机器在忙什么（四曲线 + 采集源条 + 进程榜） |
| 监控记录 | 哪些规则在什么时候真的触发过（时间线 + 未读蓝点） |
| 清理 | 到底扫了哪些目录、扫出了什么、要删哪些 |
| 搜索 | 这个文件在哪，以及这个答案是哪条通路给的 |
| 设置 | 四个采集源开关、阈值、清理规则、搜索通路、宿主能力表 |

版式约定：错误与状态**一律就地落在触发它的那张卡**（行内 notice），**零顶部浮层 toast**；无原生 `confirm` / `alert`；断点 1080 / 860 / 620。

---

## 采集是怎么分层的

各源代价差两个数量级，所以不是一个节奏包打天下（数字为 2026-09-28 本机实测，复跑命令 `node scripts/probe-collect.mjs`）：

| 层 | 采什么 | 手段 | 代价 |
|---|---|---|---|
| L0 | CPU / 内存 / 磁盘容量 | 纯 Node（`os.cpus` / `os.totalmem` / `fs.statfsSync`），不起子进程 | `os.cpus()` ×100 = 61ms，1s 采样无感 |
| L1a | 网络吞吐 | 常驻 `typeperf`，定窗续采（每窗 `-sc 30 -si 1`） | 暖身 ≈402ms/窗，摊到 30 样本窗 1.3% |
| L1b | 进程榜 | 常驻 PowerShell（`Get-CimInstance Win32_Process`） | 冷启动单轮 1475ms ⇒ **默认关**，页面可见才采 |
| L2 | 清理扫描 | 请求驱动的 Node 遍历 | `%LOCALAPPDATA%\Temp` 85,122 条目 / 4,532ms ⇒ 必须带进度与可停止 |

子进程由 `lib/collect/supervisor.js` 统一监督：退避 1s/2s/4s/8s/30s、5 次封顶后进 `exited-max` 并标红 + 附最后一段 stderr；超过 3× 采样间隔无输出判 `stalled`（挂着不输出比崩更难发现）；Windows 下 `child.kill()` 对 `shell:true` 不可靠，改用 `taskkill /PID <pid> /T /F`，**PID 只取 `spawn` 返回值，绝不接受外部输入拼进命令行**。

---

## 数据与隐私

- 配置与留痕存在**宿主**的 KV 存储里（domain `sysops`：prefs / clean_rules / alert_hit / clean-plan / clean-log），不落本仓库目录，不上传任何第三方。
- HTTP 面只挂在前缀 `/sysops` 下，写端点全 POST，非回环请求一律 403。
- 告警与曲线在内存环形缓冲 + KV 留痕；「系统通知 / 后台常驻」宿主不提供，能力表里如实标，UI 上不留开关。
- 采集异常分四类各写各的文案：未开启 / 进程已退出 / 权限不足 / 数据异常（NaN、负值、>100%）。第四类的脏点**丢弃不写入缓冲并单独计数** —— 一个假点会在曲线上被读成真实尖峰。

## 做不到就写出来（诚实降级）

宿主能力启动时探测一次并缓存，结果在设置页能力表可见：

| 缺什么 | 表现 |
|---|---|
| `storageDomain` | 配置转只读，写接口返回 501，保存按钮置灰并注明原因 |
| `webServer` | 不注册侧边栏入口（点开空白页比看不到入口更糟） |
| `timer` | 退回 `setInterval`，但必须显式 `stop()`，能力表如实标这行降级 |
| 系统通知 / 开机自启 | 能力表标「宿主不提供」，UI 上不留开关 |

清理执行的错误口径同样不糊：`EBUSY / EPERM / ENOTEMPTY` → 该项 `skipped` 并写原因、**不重试**；快照 re-stat 不过 → `rejected-snapshot` 提示重扫；暂存目录跨卷 `move` 报 `EXDEV` → 回退 copy + delete 且**先写成功再删源**，失败保留原件并报因。禁止 `catch {}`：每个 catch 必须产生一个可见状态变化或一条时间线记录。

---

## 测试

零依赖：`node:assert/strict` + 自研 `check(name, fn)`，`node test/<x>.test.mjs` 直跑，无测试框架、无 npm script。真机项由 `SKIP_LOCAL=1` 跳过。

```bash
# 全套（含会真建目录树、真删的机器相关用例）
for f in test/*.test.mjs; do node "$f"; done

# 跳过机器相关用例（在别的机器 / CI 上跑）
SKIP_LOCAL=1 node test/clean.test.mjs

# 宿主兼容性验证（可选，指向一个 dsh 安装；没设会明确打 SKIP，不假装验证过）
DSH_MODULES="D:\Deepseek harness\node_modules" node test/host-compat.test.mjs
```

当前读数（2026-10-02 本机 `SKIP_LOCAL=1`，9 个文件共 **489 过 / 0 挂**）：alerts 34 · clean 81 · client 191 · collect 53 · guard 19 · host-compat 25 · plugin 44 · prefs 29 · search 46。

| 文件 | 覆盖 |
|---|---|
| `guard.test.mjs` | 红线矩阵 19 项，按 `BRANCH_IDS` 分支清单逐条打勾（系统目录 / 回收站 / `\\?\` / UNC / 8.3 短名 / `..` 与 junction 逃逸 / 全角 / 未展开 `%VAR%` / 省略盘符 / 通配越界）：用例若写了清单里不存在的分支 id 会直接失败 |
| `collect.test.mjs` | ring 边界；typeperf 输出 fixture（表头、多实例、中文计数器、半行断流）；进程榜 JSON；supervisor 假 child 驱动退避与 stall 判定 |
| `alerts.test.mjs` | 阈值穿越、连续 N 次、冷却窗口、依赖关闭后不评估 |
| `clean.test.mjs` | 在 `%TEMP%` 真建目录树真遍历比对与真删；**伪造 itemId / 伪造路径必须被拒**；EXDEV 回退打桩 |
| `search.test.mjs` | probe 三级 8 种组合 → 通路选择；Everything HTTP 响应 fixture（403 / 超时 / 畸形 JSON）；两条通路结果归一化一致 |
| `prefs.test.mjs` | 五条记录的 schema 与读写语义；未声明字段丢弃；命中红线的规则在**写入阶段**被拒 |
| `plugin.test.mjs` / `client.test.mjs` | 加载级：宿主半边 inject / 路由表 / 回环闸门 / 源码零 `@deepseek-ai` import；浏览器半边页签骨架、零浮层、四页渲染与端到端接线证人 |
| `host-compat.test.mjs` | 缺 `storageDomain` / `webServer` / `timer` 三种组合下加载不抛、状态如实报 |

`guard.js` 是唯一要求分支全覆盖的模块 —— 它是这台机器上不可逆动作的单点。本仓库不产覆盖率百分比（引工具即破坏零依赖），改为维护一份分支清单、每条红线一个用例 ID。

---

## 目录结构

```
.
├── package.json            插件清单（dsh.bundle.patch / dsh.client），零第三方依赖
├── cordis.yml              bundle patch：把插件插进 profile 的插件树
├── index.js                宿主半边：能力探测、依赖装配、建服务、注路由
├── client.js               浏览器半边：侧边栏入口 + 主面板（React，零构建，CSS 以字符串注入）
├── lib/
│   ├── kv-schema.js          自造记录校验器（宿主只调 parse/safeParse，零 instanceof 检查）
│   ├── kv-records-base.js    domain 建域 / 写链 / 关停 / 容量的公共基座
│   ├── caps.js               宿主能力探测，结果缓存并对外可查
│   ├── api.js                前缀内路由表 + SSE hub + 回环闸门
│   ├── disk.js               容量与字节的单点折算（清单分组、进度、留痕共用同一口径）
│   ├── collect/              ring / l0-node / l1a-typeperf / l1b-powershell / supervisor / service
│   ├── alerts/               rules（纯函数判定）/ store（alert_hit）/ service（评估编排 + 未读计数）
│   ├── clean/                guard（红线单点）/ rules（内置库）/ scanner / ai-advisor（只推荐不执行）/
│   │                         plan-store（冻结清单）/ executor（两段式执行）/ log-store（留痕）/ quarantine（暂存）/ service
│   ├── records/              spec.js —— alert_hit / clean-plan / clean-log 三张记录表的声明处
│   ├── search/               probe（三级探测，全程只读）/ everything-http / es-exe / walk / installer（一键安装四道闸）/ service
│   └── prefs/                spec + store（采集档位、源开关、阈值、限定目录）/ rules-store（本机清理规则）
├── docs/
│   ├── design-spec.md          设计说明：决策表、实测代价、数据流、错误处理、测试与验收门禁
│   └── implementation-plan.md  25 个 Task 的实现计划（含逐条契约）
├── scripts/probe-collect.mjs   实测代价探针（只报事实，恒 exit 0）
├── prototype/index.html        可点原型（与 client.js 同口径，改设计先改它）
└── test/                       见上
```

`kv-schema.js` 与 `dsh-plugin-stock-analysis` / `dsh-plugin-modelwatch` 的同名文件是**同源拷贝**：宿主以 `link:` 挂载时 import 官方包会解析出第二份模块实例，所以三份实现必须保持同源，改一处要三处对齐。

---

## 许可

MIT。见 `LICENSE`。

本插件只做本机读写与显式确认的删除，不提供任何提权、不提供结束进程的能力，也不替你决定删什么。用完请自行核对留痕。
