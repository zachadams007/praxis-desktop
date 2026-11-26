/**
 * Inbox delete / clear / undo - the pure set math plus the localStorage writes.
 *
 * Run: node scripts/test-inbox-manage.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
global.Event = class Event {
  constructor(type) {
    this.type = type;
  }
};
global.window = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {
    return true;
  },
  localStorage: global.localStorage,
};

const built = esbuild.buildSync({
  entryPoints: [path.join(root, "src/command/inboxStore.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["react", "react-dom", "@tauri-apps/api/*"],
  loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".glb": "empty" },
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(require, mod, mod.exports);

const {
  DISMISSED_CAP,
  HERMES_INBOX_ID,
  boardInboxId,
  commitDismiss,
  commitDismissMany,
  commitMarkAllRead,
  commitRestore,
  currentBoardInboxId,
  deliveredItems,
  dismissableIds,
  dismissableReadIds,
  isInboxDismissable,
  visibleInboxItems,
} = mod.exports;

const READ_KEY = "praxis.inbox.read.v1";
const DISMISSED_KEY = "praxis.inbox.dismissed.v1";
const BOARD_KEY = "praxis.board.v1";

function reset() {
  store.clear();
}
function readJson(key) {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : null;
}
function idsOf(items) {
  return visibleInboxItems(items).map((item) => item.id);
}

let passed = 0;
function test(name, fn) {
  reset();
  fn();
  passed += 1;
  console.log("  ✓ " + name);
}

console.log("Inbox manage");

test("dismiss hides a delivered row and persists it as read", () => {
  const rows = deliveredItems(
    [
      { id: "open", ts: 1, missionId: "m", from: "zach", kind: "mission", text: "build a site", title: "Hello site" },
      { id: "res", ts: 2, missionId: "m", from: "praxis", kind: "result", text: "The site is up and serving.", status: "done" },
    ],
    new Set(),
    3,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "delivered-res");
  assert.equal(commitDismiss(rows[0].id), true);
  assert.deepEqual(idsOf(rows), []);
  assert.deepEqual(readJson(DISMISSED_KEY), ["delivered-res"]);
  assert.deepEqual(readJson(READ_KEY), ["delivered-res"]);
});

test("markAllRead records every message and skips the health row", () => {
  const items = [
    { id: "delivered-a", unread: true },
    { id: "delivered-b", unread: false },
    { id: HERMES_INBOX_ID, unread: true },
  ];
  commitMarkAllRead(items.map((item) => item.id));
  const read = readJson(READ_KEY);
  assert.deepEqual(read, ["delivered-a", "delivered-b"]);
  assert.equal(read.includes(HERMES_INBOX_ID), false);
});

test("clearRead keeps unread rows and the health row", () => {
  const items = [
    { id: "delivered-read", unread: false },
    { id: "delivered-new", unread: true },
    { id: HERMES_INBOX_ID, unread: true },
  ];
  const gone = dismissableReadIds(items);
  assert.deepEqual(gone, ["delivered-read"]);
  commitDismissMany(gone);
  assert.deepEqual(idsOf(items), ["delivered-new", HERMES_INBOX_ID]);
});

test("clearAll hides every message and restore puts them back", () => {
  const items = [
    { id: "delivered-read", unread: false },
    { id: "delivered-new", unread: true },
    { id: HERMES_INBOX_ID, unread: true },
  ];
  const removed = dismissableIds(items);
  assert.deepEqual(removed, ["delivered-read", "delivered-new"]);
  assert.deepEqual(commitDismissMany(removed), removed);
  assert.deepEqual(idsOf(items), [HERMES_INBOX_ID]);
  commitRestore(removed);
  assert.deepEqual(idsOf(items), ["delivered-read", "delivered-new", HERMES_INBOX_ID]);
});

test("the dismissed set keeps the newest 500", () => {
  const ids = Array.from({ length: DISMISSED_CAP + 20 }, (_, i) => `delivered-${i}`);
  commitDismissMany(ids);
  const stored = readJson(DISMISSED_KEY);
  assert.equal(stored.length, DISMISSED_CAP);
  assert.equal(stored[0], "delivered-20");
  assert.equal(stored[stored.length - 1], `delivered-${DISMISSED_CAP + 19}`);
  const shown = idsOf(ids.map((id) => ({ id })));
  assert.deepEqual(shown, ids.slice(0, 20));
});

test("board id is date-scoped, so dismissing today leaves tomorrow", () => {
  assert.notEqual(boardInboxId("2026-10-10"), boardInboxId("2026-10-11"));
  localStorage.setItem(
    BOARD_KEY,
    JSON.stringify({
      date: "2026-10-10",
      digestMarkdown: "## Needs Zach\n- one",
      path: "vault/board.md",
      generatedAtMs: Date.parse("2026-10-10T10:00:00Z"),
    }),
  );
  const today = currentBoardInboxId();
  assert.equal(today, "board-2026-10-10");
  commitDismiss(today);
  localStorage.setItem(
    BOARD_KEY,
    JSON.stringify({
      date: "2026-10-11",
      digestMarkdown: "## Needs Zach\n- two",
      path: "vault/board.md",
      generatedAtMs: Date.parse("2026-10-11T10:00:00Z"),
    }),
  );
  const tomorrow = currentBoardInboxId();
  assert.equal(tomorrow, "board-2026-10-11");
  assert.notEqual(today, tomorrow);
  assert.deepEqual(idsOf([{ id: today }, { id: tomorrow }]), [tomorrow]);
});

test("the hermes-degraded row cannot be dismissed", () => {
  assert.equal(isInboxDismissable(HERMES_INBOX_ID), false);
  assert.equal(commitDismiss(HERMES_INBOX_ID), false);
  assert.equal(localStorage.getItem(DISMISSED_KEY), null);
  assert.equal(localStorage.getItem(READ_KEY), null);
  // Even a hand-written set cannot hide the live health row.
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([HERMES_INBOX_ID, "delivered-1"]));
  assert.deepEqual(idsOf([{ id: HERMES_INBOX_ID }, { id: "delivered-1" }]), [HERMES_INBOX_ID]);
  assert.deepEqual(commitDismissMany([HERMES_INBOX_ID]), []);
});

console.log(`\n${passed} passed`);
