/*
 * LIVE owned-session behavioral suite.
 *
 * The old version inspected Rust/TS source substrings. That could pass while a
 * changed backend contract made the actual frontend dispatch wrong. The real
 * mocked-Tauri exercises now live in test-orchestrator.cjs: they prove a
 * missing-artifact response uses the same owned session key with followUp=true,
 * a new run gets a new key, Quill is not sent through LIVE, and existing repos
 * use their effective cwd. Keep this compatibility entry point for QA runners.
 */
const path = require("path");
const { spawnSync } = require("child_process");

const result = spawnSync(process.execPath, [path.join(__dirname, "test-orchestrator.cjs")], {
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
