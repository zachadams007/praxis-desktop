// Exercise the actual effect callbacks with a controlled event bus and clock.
// Isolating the effects avoids starting the 3D Galaxy just to test cross-window IPC.
const fs = require("fs");
const path = require("path");
const ts = require("typescript");
const esbuild = require("esbuild");
const assert = require("assert/strict");

function effectFor(file, event, scope) {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes(event))
      callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callback, `${file} has a ${event} effect`);
  const compiled = esbuild.transformSync(`module.exports = ${callback}`, {
    loader: "tsx", format: "cjs", target: "es2020", supported: { "dynamic-import": false },
  }).code;
  const m = { exports: {} };
  new Function("module", ...Object.keys(scope), compiled)(m, ...Object.values(scope));
  return m.exports;
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

module.exports = async function testRefreshListeners() {
  let handlers = [];
  let offCount = 0;
  let resolveListen;
  let delayed = false;
  let broadcasts = 0;
  const eventApi = {
    listen: async (event, handler) => {
      handlers.push({ event, handler });
      if (delayed) await new Promise((resolve) => { resolveListen = resolve; });
      return () => { offCount++; };
    },
    emit: () => { broadcasts++; },
  };
  let reads = [0, 0];
  const cleanups = [];
  for (let i = 0; i < 2; i++) {
    const effect = effectFor("src/command/controlStore.ts", "praxis://usage-refresh", {
      window: { __TAURI_INTERNALS__: {} }, refresh: () => { reads[i]++; },
      require: () => eventApi,
    });
    cleanups.push(effect());
  }
  await flush();
  handlers.forEach(({ handler }) => handler());
  assert.deepEqual(reads, [1, 1], "every mounted Supply hook refreshes");
  assert.equal(broadcasts, 0, "listeners never re-emit");
  cleanups.forEach((off) => off());
  assert.equal(offCount, 2);
  handlers.forEach(({ handler }) => handler());
  assert.deepEqual(reads, [1, 1], "callbacks arriving after unmount cannot refresh");

  delayed = true;
  const lateEffect = effectFor("src/command/controlStore.ts", "praxis://usage-refresh", {
    window: { __TAURI__: {} }, refresh: () => {}, require: () => eventApi,
  });
  const lateCleanup = lateEffect();
  await flush();
  lateCleanup();
  resolveListen();
  await flush();
  assert.equal(offCount, 3, "listener registration resolving after cleanup unregisters itself");
  effectFor("src/command/controlStore.ts", "praxis://usage-refresh", {
    window: {}, refresh: () => {}, require: () => { throw new Error("unguarded import"); },
  })();

  handlers = [];
  delayed = false;
  let current;
  let clock = 0;
  let graph = { nodes: [{ id: "old" }], edges: [] };
  let timers = new Map();
  let timerId = 0;
  let stopped = false;
  const invokes = [];
  const scope = {
    fetch: async () => ({ ok: true, json: async () => graph }),
    inTauri: () => true,
    normalizeGraph: (g) => g,
    SAMPLE_GRAPH: graph,
    setData: (updater) => { current = updater(current); },
    visibleInterval: () => () => { stopped = true; },
    Date: { now: () => clock },
    setInterval: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearInterval: (id) => timers.delete(id),
    require: (name) => name.endsWith("/event") ? eventApi : {
      invoke: async (command) => { invokes.push(command); return command === "read_memory_graph" ? JSON.stringify(graph) : undefined; },
    },
  };
  const galaxy = effectFor("src/knowledge/App.tsx", "praxis://memory-refresh", scope);
  const cleanup = galaxy();
  await flush();
  invokes.length = 0;
  handlers[0].handler();
  await flush();
  assert.deepEqual(invokes, ["read_memory_graph"], "broadcast reads without rebuilding");
  graph = { nodes: [{ id: "new" }, { id: "another" }], edges: [{}] };
  [...timers.values()].forEach((fn) => fn());
  await flush();
  assert.deepEqual(current, graph, "a file arriving after the rebuild request updates the Galaxy");
  assert.equal(broadcasts, 0);
  handlers[0].handler();
  await flush();
  assert.equal(timers.size, 1, "repeat requests replace the polling timer");
  clock = 60_001;
  [...timers.values()].forEach((fn) => fn());
  assert.equal(timers.size, 0, "burst polling is bounded");
  handlers[0].handler();
  cleanup();
  await flush();
  assert.equal(timers.size, 0);
  assert.ok(stopped);
  assert.equal(offCount, 4);

  delayed = true;
  const lateGalaxyCleanup = galaxy();
  await flush();
  lateGalaxyCleanup();
  resolveListen();
  await flush();
  assert.equal(offCount, 5, "Galaxy also cleans up a late listener registration");
};

if (require.main === module) {
  module.exports().then(() => console.log("PASS — command refresh listeners")).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
