/**
 * 测试用的内存 storageDomain 设施桩。
 *
 * 从 `test/prefs.test.mjs` 原样搬来（Task 3 交付）：全仓库只有这一份内存桩，
 * `prefs` 与 `alerts` 两个仓储都要用它，两处各留一份就会各自漂移 ——
 * 桩的行为（关域再开数据还在、put 过 schema）必须是单一真相。
 */
/**
 * @param options.closeDelayMs 让 `close()` 真的挂一会儿：复现「域名字尚未释放」那段关闭窗口
 *   （复评 F-3）。默认 0 = 与改名前逐字同行为，其余用例一律不受影响。
 */
export function createMemoryFacility({ closeDelayMs = 0 } = {}) {
  const opened = new Map();
  const disk = new Map(); // 关域再开，数据要还在 —— 桩每次重建空表会把这条测成假的
  const stats = { opens: 0, closes: 0 }; // 关闭侧的取证：域到底开了几次、关了几次
  return {
    stats,
    async open(spec) {
      stats.opens += 1;
      if (opened.has(spec.name)) throw new Error('already-open');
      let tables = disk.get(spec.name);
      if (!tables) {
        tables = new Map(Object.keys(spec.tables).map((n) => [n, new Map()]));
        disk.set(spec.name, tables);
      }
      const domain = {
        async close() {
          // 关域要真的挂一会儿才摘名字：F-3 的竞态窗口就在「close 已开始、名字还没释放」这段。
          // 默认 0 不排帧，行为与改名前一致。
          if (closeDelayMs) await new Promise((r) => setTimeout(r, closeDelayMs));
          stats.closes += 1;
          opened.delete(spec.name);
        },
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

/**
 * `fs.statfsSync()` 的桩（S12-A）。
 *
 * **键集合逐字取真机读数**（`node tmp/probe-s12-disk.mjs` → `tmp/s12-disk.txt`）：
 * `type / bsize / blocks / bfree / bavail / files / ffree`。真机上**没有** `available` 与 `total`，
 * 而清理侧三处早先读的就是 `.available` ⇒ 假桩多给一个键，替宿主圆了一个谎：
 * 四百多条断言全绿，真机每条留痕的 `beforeFree` 都是 0（spec §8.7 / S9 同型事故，本函数就是那道闸）。
 *
 * `total` / `free` 按字节交，内部折成扇区计数 —— 不能被 `bsize` 整除时报错，
 * 免得用例把「换算写错」读成「桩给的数不对」。
 */
export function statfsFixture({ total = 120 * 2 ** 30, free = 60 * 2 ** 30, bsize = 4096 } = {}) {
  const t = Number(total);
  const f = Number(free);
  if (!Number.isInteger(t) || !Number.isInteger(f)) throw new Error('statfsFixture 的 total / free 必须是整数值');
  if (t % bsize !== 0 || f % bsize !== 0) throw new Error(`statfsFixture 的值必须能被 bsize(${bsize}) 整除，收到 total=${t} free=${f}`);
  return { type: 0, bsize, blocks: t / bsize, bfree: f / bsize, bavail: f / bsize, files: 0, ffree: 0 };
}
