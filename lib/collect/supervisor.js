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
