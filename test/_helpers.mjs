/**
 * 测试用的内存 storageDomain 设施桩。
 *
 * 从 `test/prefs.test.mjs` 原样搬来（Task 5 交付）：全仓库只有这一份内存桩，
 * `prefs` 与 `alerts` 两个仓储都要用它，两处各留一份就会各自漂移 ——
 * 桩的行为（关域再开数据还在、put 过 schema）必须是单一真相。
 */
export function createMemoryFacility() {
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
