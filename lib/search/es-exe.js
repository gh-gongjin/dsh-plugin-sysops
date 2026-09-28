/**
 * lib/search/es-exe.js —— es.exe 适配器（Task 17，通路 ②）
 *
 * 走 Everything 官方命令行工具 es.exe。**未在本机验证**（计划期实测修正 #4：本机 `where es.exe` 无命中）。
 * 安全：execFile 而非 exec —— bin 与关键字都不拼进 shell 字符串，避免命令注入。
 */

/** 参数表：空 query 直接拒（es.exe 无参会吐全库，等于把用户整盘文件名打包带走） */
export function buildArgs({ q, limit }) {
  const query = String(q ?? '').trim();
  if (!query) throw new Error('query（关键字）不能为空：es.exe 无参会吐全库');
  const max = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 200)));
  return ['-max-count', String(max), '-sort', 'path', query];
}

/** 每行一条完整路径；空行与表头行丢弃 */
export function parseEsOutput(text) {
  const rows = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(name|path|size|attr|date_modified|status)(\t|,)/i.test(line)) continue; // 防御性丢表头
    rows.push({ name: line.split(/[\\/]/).pop(), path: line });
  }
  return rows;
}

/** 查一次：ENOENT（未安装/不在 PATH）与超时都收敛为 { rows: [], error }，不向上抛 */
export async function searchEs({ q, limit, bin, execFileMod, timeoutMs = 4000 }) {
  let args;
  try {
    args = buildArgs({ q, limit });
  } catch (error) {
    return { rows: [], error: `关键字校验未通过：${error.message}` };
  }
  try {
    const out = await execFileMod(bin || 'es.exe', args, { timeout: timeoutMs, windowsHide: true });
    return { rows: parseEsOutput(out && out.stdout) };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { rows: [], error: '未找到 es.exe：请安装 Everything 附带的 ES 命令行工具并放进 PATH，或在设置页 → 搜索通路 指定 es.exe 完整路径' };
    }
    if (error && /timed out|ETIMEDOUT|超时/.test(String(error.code ?? '') + String(error.message ?? ''))) {
      return { rows: [], error: `es.exe 执行超时（${timeoutMs}ms），已取消` };
    }
    return { rows: [], error: `es.exe 执行失败：${error && error.message ? error.message : String(error)}` };
  }
}
