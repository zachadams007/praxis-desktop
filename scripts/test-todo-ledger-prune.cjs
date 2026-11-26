/** Headless tests for todoStore's live-ledger pruning (no React, no Tauri, no DOM).
 * Transpiles src/command/todoStore.ts with the TypeScript compiler API the same
 * way test-deck-a11y.cjs loads a11y.ts, then runs the pure functions directly.
 * todoStore.ts's real imports (react, @/shared/persist) are only ever touched by
 * the React hook (useTodoStore/useMemoryTodos) - never by the pure functions this
 * script exercises - so a minimal stub `require` is enough to load the module. */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const root = path.join(__dirname, '..');

const source = fs.readFileSync(path.join(root, 'src/command/todoStore.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function fakeRequire(id) {
  if (id === 'react') {
    return { useState: () => [undefined, () => {}], useEffect: () => {}, useCallback: (fn) => fn, useRef: (v) => ({ current: v }) };
  }
  if (id === '@/shared/persist') {
    return { mirrorSet: () => {} };
  }
  throw new Error(`test-todo-ledger-prune: unexpected require(${id})`);
}

const mod = { exports: {} };
new Function('require', 'exports', 'module', compiled)(fakeRequire, mod.exports, mod);
const { enforce, seedFromMemory, pruneResolvedMemory } = mod.exports;

let pass = 0;
let fail = 0;
function ok(condition, label, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

let seq = 0;
function task(overrides) {
  seq += 1;
  return {
    id: overrides.id ?? `t-${seq}`,
    text: overrides.text,
    status: overrides.status ?? 'upcoming',
    source: overrides.source ?? 'memory',
    createdAt: overrides.createdAt ?? 0,
    doneAt: overrides.doneAt,
  };
}

function ledgerItem(title) {
  return { status: '🔜', date: '2026-09-27', title };
}

// ── 1. a live ledger without X removes the memory task X ──────────────────────
{
  const tasks = [
    task({ text: 'Deck design-token pass (259 hexes)', source: 'memory' }),
    task({ text: 'Still open in the ledger', source: 'memory' }),
  ];
  const live = [ledgerItem('Still open in the ledger')];
  const out = pruneResolvedMemory(tasks, live, 'live');
  ok(
    out.every((t) => t.text !== 'Deck design-token pass (259 hexes)'),
    'live ledger without X removes the resolved memory task X',
    JSON.stringify(out.map((t) => t.text)),
  );
  ok(
    out.some((t) => t.text === 'Still open in the ledger'),
    'a memory task still on the live ledger survives',
  );
}

// ── 2. "unavailable" and "loading" remove nothing ──────────────────────────────
for (const state of ['unavailable', 'loading']) {
  const tasks = [task({ text: 'Stale-looking memory item', source: 'memory' })];
  const out = pruneResolvedMemory(tasks, [], state);
  ok(out.length === 1, `ledgerState "${state}" removes nothing, even against an empty live list`, JSON.stringify(out));
}

// ── 3. manual/voice tasks survive (even with an empty live list) ──────────────
{
  const tasks = [
    task({ text: 'Zach typed this himself', source: 'manual' }),
    task({ text: 'Zach said this out loud', source: 'voice' }),
  ];
  const out = pruneResolvedMemory(tasks, [], 'live');
  ok(out.length === 2, 'manual and voice tasks are never pruned, regardless of the live ledger', JSON.stringify(out));
}

// ── 4. done tasks survive ──────────────────────────────────────────────────────
{
  const tasks = [task({ text: 'Already crossed off', source: 'memory', status: 'done', doneAt: 123 })];
  const out = pruneResolvedMemory(tasks, [], 'live');
  ok(out.length === 1 && out[0].status === 'done', 'a done memory task survives even when absent from the live ledger');
}

// ── 5. match is trimmed + case-insensitive, same as seedFromMemory's dedupe ───
{
  const tasks = [task({ text: '  Ship The Thing  ', source: 'memory' })];
  const live = [ledgerItem('ship the thing')];
  const out = pruneResolvedMemory(tasks, live, 'live');
  ok(out.length === 1, 'matching is trimmed + case-insensitive, so a live item still matches its task');
}

// ── 6. slots refill from the live list (via enforce = prune + seed) ───────────
{
  const tasks = [task({ text: 'Resolved item still sitting in storage', source: 'memory' })];
  const live = [ledgerItem('Fresh ledger item A'), ledgerItem('Fresh ledger item B')];
  const out = enforce(tasks, live, 'live');
  const texts = out.map((t) => t.text);
  ok(!texts.includes('Resolved item still sitting in storage'), 'enforce() prunes the resolved memory item', JSON.stringify(texts));
  ok(texts.includes('Fresh ledger item A') && texts.includes('Fresh ledger item B'), 'freed slots refill from the live ledger list', JSON.stringify(texts));
}

// ── 7. enforce() during "loading"/"unavailable" never wipes the list, but still
//      refills any genuinely open slots from whatever the ledger last returned ──
{
  const tasks = [task({ text: 'Untouched during a failed read', source: 'memory' })];
  const out = enforce(tasks, [], 'unavailable');
  ok(
    out.some((t) => t.text === 'Untouched during a failed read'),
    'enforce() never drops a memory task while the ledger read is unavailable',
  );
}

// ── guard the guard: seedFromMemory itself is still exported and still adds-only ──
ok(typeof seedFromMemory === 'function', 'seedFromMemory is still exported for other callers');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
