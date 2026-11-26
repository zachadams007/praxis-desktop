// Shared by grammar/execution and Mission classifier tests: every supported form
// must take the same path whether spoken, typed, or sent by praxis_command.
const cases = [];
for (const verb of ["reload", "refresh"])
  for (const article of ["", "the "])
    for (const target of ["usage", "usage limits", "supply", "meters"])
      cases.push([`${verb} ${article}${target}`, { kind: "refresh-usage" }]);
cases.push(["check my limits", { kind: "refresh-usage" }]);
for (const verb of ["refresh", "reload"])
  for (const article of ["", "the "])
    for (const target of ["flight deck", "sessions", "agents"])
      cases.push([`${verb} ${article}${target}`, { kind: "refresh-flightdeck" }]);
for (const verb of ["refresh", "rebuild", "reload"])
  for (const target of ["memory galaxy", "memory graph", "vault graph"])
    cases.push([`${verb} the ${target}`, { kind: "refresh-memory" }]);
cases.push(
  ["set Quill to Grok 4.7", { kind: "fleet-model", agent: "quill", model: "grok 4.7" }],
  ["put Vega on GPT-6 Astra", { kind: "fleet-model", agent: "vega", model: "gpt-6 astra" }],
  ["use Opus 5.5 for Forge", { kind: "fleet-model", agent: "forge", model: "opus 5.5" }],
  ["switch Sage to Fable", { kind: "fleet-model", agent: "sage", model: "fable" }],
  ["set Lens to Vision", { kind: "fleet-model", agent: "lens", model: "vision" }],
  ["set Atlas to Sonnet", { kind: "fleet-model", agent: "atlas", model: "sonnet" }],
  ["set Scribe to Sonnet", { kind: "fleet-model", agent: "scribe", model: "sonnet" }],
);
for (const key of ["claude", "codex", "cursor", "openrouter", "hermes", "computer-use"]) {
  for (const enabled of [true, false])
    for (const verb of ["turn", "switch"])
      for (const article of ["", "the "])
        cases.push([`${verb} ${enabled ? "on" : "off"} ${article}${key}${article ? " breaker" : ""}`, { kind: "tool-breaker", key, enabled }]);
  cases.push([`cut ${key}`, { kind: "tool-breaker", key, enabled: false }]);
}
// The owner names the agents: Forge = Claude, Vega = Codex, Quill = Cursor.
for (const [agent, key] of [["forge", "claude"], ["vega", "codex"], ["quill", "cursor"]]) {
  cases.push([`turn off ${agent}`, { kind: "tool-breaker", key, enabled: false }]);
  cases.push([`turn on ${agent}'s breaker`, { kind: "tool-breaker", key, enabled: true }]);
  cases.push([`cut ${agent}`, { kind: "tool-breaker", key, enabled: false }]);
}
module.exports = cases;
