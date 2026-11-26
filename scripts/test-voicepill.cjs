/* Run the actual page/hooks against a deterministic React hook + Tauri boundary.
 * No browser, microphone, installed app, or filesystem fixtures required.
 * Run: node scripts/test-voicepill.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
let now = 1_800_000_000_000;
Date.now = () => now;
const storage = new Map();
const listeners = new Map();
const nativeListeners = new Map();
const timers = new Map();
const calls = [];
let timerId = 0;
global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
global.window = {
  __TAURI_INTERNALS__: {}, location: { pathname: '/voicepill.html' },
  addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
  removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
  dispatchEvent(e) { for (const fn of listeners.get(e.type) ?? []) fn(e); },
  setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; },
  clearInterval(id) { timers.delete(id); },
};
global.document = {
  hasFocus: () => true, hidden: false, getElementById: () => ({}),
  addEventListener() {}, removeEventListener() {},
};
global.CustomEvent = class { constructor(type, { detail }) { this.type = type; this.detail = detail; } };

// Each mounted function gets stable hook slots, dependency effects and cleanup.
let current;
let mountedContent;
const observers = new Set();
global.ResizeObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() { observers.add(this); }
  disconnect() { observers.delete(this); }
};
const hooks = {
  useState(initial) {
    const scope = current, i = scope.index++;
    if (!scope.slots[i]) scope.slots[i] = { value: typeof initial === 'function' ? initial() : initial };
    return [scope.slots[i].value, next => {
      const value = typeof next === 'function' ? next(scope.slots[i].value) : next;
      if (!Object.is(value, scope.slots[i].value)) { scope.slots[i].value = value; scope.dirty = true; }
    }];
  },
  useEffect(effect, deps) {
    const scope = current, i = scope.index++, old = scope.slots[i];
    if (!old || !deps || deps.some((dep, j) => !Object.is(dep, old.deps[j]))) {
      scope.pending.push(() => { old?.cleanup?.(); scope.slots[i] = { deps, cleanup: effect() }; });
    }
  },
  useRef(value) { const scope = current, i = scope.index++; return scope.slots[i] ??= { current: value }; },
  useCallback(fn) { return fn; },
};
function mount(fn, props) {
  const scope = { slots: [], index: 0, pending: [], dirty: true, output: null,
    flush() {
      for (let n = 0; this.dirty; n++) {
        assert(n < 20, 'render must settle'); this.dirty = false; this.index = 0; current = this;
        this.output = fn(props); current = undefined;
        if (this.output?.props.ref && mountedContent) this.output.props.ref.current = mountedContent;
        for (const effect of this.pending.splice(0)) effect();
      }
      return this.output;
    },
    unmount() { for (const slot of this.slots) slot?.cleanup?.(); },
  };
  scope.flush(); return scope;
}
const jsx = (type, props) => ({ type, props });
let bootElement;
let releaseStart;
let blockStart = false;
let ends = 0;
function load(relativePath, extraExternal = []) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, relativePath)], bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node20', loader: { '.css': 'empty' },
    alias: { '@': path.join(root, 'src') },
    external: ['react', 'react/*', 'react-dom/client', 'motion/react', '@tauri-apps/api/*', ...extraExternal],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  // Keep dynamic Tauri imports on the same mocked boundary as static imports.
  const code = result.outputFiles[0].text.replace(/import\("(@tauri-apps\/api\/[^\"]+)"\)/g, 'Promise.resolve(require("$1"))');
  new Function('require', 'module', 'exports', code)(spec => {
    if (spec === 'react') return hooks;
    if (spec === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (spec === 'react-dom/client') return { createRoot: () => ({ render: element => { bootElement = element; } }) };
    if (spec === 'motion/react') return { AnimatePresence: 'presence', MotionConfig: 'config', motion: { div: 'div' } };
    if (spec === '@tauri-apps/api/core') return { invoke: async (command, args) => {
      if (!command.startsWith('voice_pill_')) return; // existing renderer heartbeat/telemetry
      calls.push({ command, args });
      if (blockStart && args.on) await new Promise(resolve => { releaseStart = resolve; });
    } };
    if (spec === '@tauri-apps/api/webviewWindow') return { getCurrentWebviewWindow: () => ({ label: 'voicepill' }) };
    if (spec === '@tauri-apps/api/event') return {
      listen: async (name, fn) => {
        if (!nativeListeners.has(name)) nativeListeners.set(name, new Set());
        nativeListeners.get(name).add(fn);
        return () => nativeListeners.get(name).delete(fn);
      }, emit: async () => {},
    };
    if (spec === './useHybridSession') return { useHybridSession: () => ({
      liveState: 'listening', speaking: false, transportKind: 'local',
      interrupt() {}, endSession() { ends++; },
    }) };
    throw new Error('Unexpected require: ' + spec);
  }, mod, mod.exports);
  return mod.exports;
}
async function settle(scope) {
  for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); scope?.flush(); }
}
const activeState = (active = true, ts = now) => ({ active, ts, startedAt: now - 1000,
  state: 'listening', speaking: false, transport: 'local', origin: 'command.html' });
function broadcast(payload) {
  for (const fn of nativeListeners.get('praxis://voice-popup-state') ?? []) fn({ payload });
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  PASS ' + name); }

(async () => {
  const { VoicePill } = load('src/voicepill/main.tsx');
  const { VoiceStateSatellite } = load('src/voice/VoiceStateIndicator.tsx');
  let page;
  await test('Vite entry mounts only the read-only overlay satellite', async () => {
    assert.equal(bootElement.type, VoicePill);
    page = mount(VoicePill); await settle(page);
    assert.equal(page.output.props.children.props.overlay, true);
    assert.equal(page.output.props.children.props.onEnd, undefined);
    assert.deepEqual(calls.at(-1), { command: 'voice_pill_track', args: { on: false } });
  });
  await test('native broadcast activation starts tracking once; heartbeat does not restart', async () => {
    calls.length = 0; broadcast(activeState()); await settle(page);
    assert.deepEqual(calls, [{ command: 'voice_pill_track', args: { on: true } }]);
    broadcast({ ...activeState(), state: 'acting' }); await settle(page);
    assert.equal(calls.length, 1);
  });
  await test('inactive broadcast hides the overlay', async () => {
    broadcast(activeState(false)); await settle(page);
    assert.deepEqual(calls.at(-1), { command: 'voice_pill_track', args: { on: false } });
  });
  await test('an expired active broadcast stops tracking without another event', async () => {
    broadcast(activeState()); await settle(page);
    now += 60_001;
    for (const tick of [...timers.values()]) tick();
    await settle(page);
    assert.deepEqual(calls.at(-1), { command: 'voice_pill_track', args: { on: false } });
  });
  await test('already stale event cannot briefly re-show a stopped overlay', async () => {
    const count = calls.length;
    broadcast(activeState(true, now - 60_001)); await settle(page);
    assert.equal(calls.length, count);
  });
  await test('local broadcast uses the same state source', async () => {
    window.dispatchEvent(new CustomEvent('praxis:voice-popup-state', { detail: activeState() }));
    await settle(page);
    assert.deepEqual(calls.at(-1), { command: 'voice_pill_track', args: { on: true } });
  });
  await test('a stop waits for an in-flight start, then wins', async () => {
    broadcast(activeState(false)); await settle(page); calls.length = 0; blockStart = true;
    broadcast(activeState()); await settle(page);
    broadcast(activeState(false)); await settle(page);
    assert.deepEqual(calls.map(c => c.args.on), [true]);
    blockStart = false; releaseStart(); await settle(page);
    assert.deepEqual(calls.map(c => c.args.on), [true, false]);
  });
  await test('unmount stops tracking and detaches broadcast listeners', async () => {
    broadcast(activeState()); await settle(page);
    page.unmount(); await settle();
    assert.equal(calls.at(-1).args.on, false);
    assert.equal(nativeListeners.get('praxis://voice-popup-state').size, 0);
  });
  storage.set('praxis.voice.popup.v1', JSON.stringify(activeState()));
  await test('all Tauri in-window satellites render no pill, overlay ignores focus', async () => {
    for (const pathname of ['/command.html', '/flightdeck.html', '/knowledge.html', '/index.html']) {
      window.location.pathname = pathname;
      const inline = mount(VoiceStateSatellite); assert.equal(inline.output.props.children, false);
      inline.unmount();
    }
    const overlay = mount(VoiceStateSatellite, { overlay: true });
    assert(overlay.output.props.children);
    assert.equal(overlay.output.props.children.props.endButton, undefined);
    assert.equal(overlay.output.props.children.props.onInterrupt, undefined);
    overlay.unmount(); await settle();
    assert.equal(nativeListeners.get('praxis://voice-popup-state').size, 0, 'async listen cleanup');
  });
  await test('HybridSession hides its owner pill in Tauri and preserves Escape ending', async () => {
    const { HybridSession } = load('src/voice/HybridSession.tsx', ['./useHybridSession']);
    let onEnds = 0;
    const owner = mount(HybridSession, { onEnd: () => onEnds++ });
    assert.equal(owner.output.props.children, false);
    let prevented = false;
    window.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; } });
    assert.equal(ends, 1); assert.equal(onEnds, 1); assert(prevented);
    owner.unmount();
  });
  await test('plain browser keeps the owner and satellite fallback', async () => {
    delete window.__TAURI_INTERNALS__;
    storage.set('praxis.voice.popup.v1', JSON.stringify(activeState()));
    const inline = mount(VoiceStateSatellite); assert(inline.output.props.children); inline.unmount();
    const { HybridSession } = load('src/voice/HybridSession.tsx', ['./useHybridSession']);
    const owner = mount(HybridSession, { onEnd() {} }); assert(owner.output.props.children); owner.unmount();
  });
  await test('startup, capability and Vite entry are wired', () => {
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    assert(JSON.parse(read('src-tauri/capabilities/default.json')).windows.includes('voicepill'));
    assert.match(read('vite.config.ts'), /voicepill: entry\("\.\/voicepill.html"\)/);
    assert.match(read('src-tauri/src/lib.rs'), /voice_pill::voice_pill_track/);
    assert.match(read('voicepill.html'), /background: transparent; overflow: hidden/);
    assert.match(read('src-tauri/src/lib.rs'), /if label == "voicepill"/);
  });
  await test('wrapped notices expand the native page and shrink back without clipping', async () => {
    window.__TAURI_INTERNALS__ = {};
    const element = { offsetHeight: 101 };
    mountedContent = { querySelector: () => element };
    storage.set('praxis.voice.popup.v1', JSON.stringify(activeState()));
    const sized = mount(VoicePill); await settle(sized);
    assert.deepEqual(calls.findLast(c => c.command === 'voice_pill_resize').args, { height: 102 });
    element.offsetHeight = 51;
    for (const observer of observers) observer.callback();
    await settle(sized);
    assert.deepEqual(calls.findLast(c => c.command === 'voice_pill_resize').args, { height: 72 });
    sized.unmount(); await settle(); mountedContent = undefined;
    assert.equal(observers.size, 0);
  });
  console.log(`\nPASS: ${passed} tests`);
})().catch(error => { console.error(error); process.exitCode = 1; });
