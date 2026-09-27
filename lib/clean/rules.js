/**
 * 内置清理规则库（Task 11，2026-09-27 本机存在性复核现采）。
 *
 * 只收本机实测存在的路径：凭印象列路径 = 清单永远 0 命中。
 * 仓库里只存相对 `os.homedir()` 的段串 `rel`（不把机器名焊进代码），
 * `dir` / `glob` 是**加载时展开好的本机绝对路径** —— rules-1/2/8/10 与
 * `activeRules()` 的 guard 复检都读 `r.dir` / `r.glob`，Task 12 的 scanner
 * 直接用，不再自己拼。
 *
 * 两处与「按印象列路径」的差异，是实测裁定，执行时不得改回：
 * 1. **`windows-err`（`AppData/Local/Microsoft/Windows/WER`）不入内置库 —— 实测不存在。**
 *    2026-09-27 现采（`node tmp/t11wer.mjs` → `tmp/t11-wer.txt`）：`WER`、`WER/ReportQueue`、
 *    `WER/ReportArchive` 三条全 ENOENT；Windows 错误报告实际落在 `C:/ProgramData/Microsoft/Windows/WER`，
 *    那是系统存储、不在用户目录下 —— 既违反"内置库只存相对 os.homedir() 的段串"这条约束，
 *    也踩红线附近的应用能力（属主与 ACL）。所以 `BUILTIN_RULES` 是 **12 条**，
 *    `rules-1` 的条数断言写 12。**条数跟着实测走，不许反过来改实测。**
 *    剔除后内置库里暂时没有 `日志` 类规则，`RULE_KINDS` 仍保留四类 —— 它是**用户自建规则**
 *    的分类表（Task 22 清理页的分类筛选按它渲染），不是内置库的投影，不因"没人用"就删。
 * 2. **`Package Cache` 不入内置库（判定，不是漏收）**：`C:/ProgramData/Package Cache` 实测存在，
 *    但它是 Windows Installer 的包缓存，删掉会让已装程序的 repair / 卸载失败 ——
 *    红线之外还要留出修复能力。
 *
 * 其余 12 条实测存在（同轮读数 tmp/t11-wer.txt）：`Temp` 6524 条目、`Explorer` 33 条目（抽样 79 MB）、
 * `CrashDumps` 3 文件（抽样 141 MB）、`ms-playwright` / `Packages` / `.cache` / `WeChat` /
 * `Edge/.../Cache` / `Code/Cache` / `pip/Cache` 均存在。多条规则在 depth-1 只有子目录没有文件
 * （缓存目录普遍套一层，如 `Edge/.../Cache/Cache_Data`）—— 这是常态，不是误收；
 * 深度遍历与"目录算不算命中"由 Task 12 的 scanner 裁决，本库只保证路径存在且过 guard。
 */
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
