const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const code = esbuild.transformSync(fs.readFileSync('src/data/eventBus.ts', 'utf8'), { loader: 'ts', format: 'cjs', supported: { 'dynamic-import': false } }).code;
const listeners = [];
const sent = [];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function windowBus() {
  const nodeIds = [];
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'window', code)(mod, mod.exports, (spec) => {
    if (spec === '@tauri-apps/api/event') return {
      listen: async (_, fn) => { listeners.push(fn); return () => {}; },
      emit: async (_, payload) => { sent.push(payload); listeners.forEach((fn) => fn({ payload })); },
    };
    if (spec === '@/store/usePraxisStore') return { usePraxisStore: { getState: () => ({ receiveMissionNode: (m) => nodeIds.push(m.id) }) } };
    throw Error(spec);
  }, { __TAURI_INTERNALS__: {} });
  return { bus: mod.exports.eventBus, nodeIds };
}
(async () => {
  const a = windowBus(), b = windowBus();
  const aEvents = [], bEvents = [];
  a.bus.subscribe((e) => aEvents.push(e));
  b.bus.subscribe((e) => { if (e.taskId) assert(b.nodeIds.includes(e.taskId)); bEvents.push(e); });
  const node = { id: 'j.mission', areaId: 'ventures', label: 'Website', status: 'active', order: 1 };
  a.bus.emitOrchestrator({ type: 'journey:sprout', t: 0, nodeId: node.id, missionNode: node });
  await flush(); await flush();
  a.bus.emitOrchestrator({ type: 'agent:status', t: 0, agentId: 'a.vega', status: 'working', taskId: node.id, areaId: node.areaId });
  await flush(); await flush();
  assert.equal(sent.length, 2);
  assert.equal(aEvents.length, 2);
  assert.equal(bEvents.length, 2);
  assert.equal(bEvents[1].taskId, node.id);
  listeners.forEach((fn) => fn({ payload: sent[1] }));
  await flush();
  assert.equal(bEvents.length, 2);
  a.bus.emit({ type: 'task:start', t: 0 });
  assert.equal(sent.length, 2);
  console.log('PASS: two-window mission relay preserves node-before-dispatch order, dedupes, and never echoes or relays unrelated events');
})().catch((err) => { console.error(err); process.exitCode = 1; });
