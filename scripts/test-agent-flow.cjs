const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const panel = fs.readFileSync(path.join(root, 'src/flightdeck/deck/DeckPanels.tsx'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'src/flightdeck/deck/agentFlowManifest.ts'), 'utf8');
const model = fs.readFileSync(path.join(root, 'src/flightdeck/deck/model.ts'), 'utf8');

const checks = [];
function check(name, condition) {
  checks.push({ name, ok: Boolean(condition) });
}

check('false kept-current claim removed', !panel.includes('KEPT CURRENT BY ATLAS'));
check('visible Atlas check stamp', panel.includes('data-agent-flow-check=') && panel.includes('ATLAS {atlasCheck.ok'));
check('manual accessible recheck', panel.includes('aria-label="Run Atlas Agent Flow check now"'));
check('daily cache has next-day boundary', manifest.includes('nextLocalDay(now)') && manifest.includes('saved.nextCheckAt > now'));
check('open Flight Deck rechecks at the next day boundary', panel.includes('window.setTimeout(checkAndSchedule, delay)'));
check('config changes bypass the cache', manifest.includes('saved.fingerprint === manifest.fingerprint'));
check('stamp survives WebView storage loss', manifest.includes('mirrorSet(AGENT_FLOW_CHECK_KEY'));
check('actor facts come from fleet config', manifest.includes('FLEET_AGENTS') && manifest.includes('getFleetSelection(key)'));
check('provider tiers come from live plan names', manifest.includes("plans.claude") && manifest.includes("plans.codex") && manifest.includes("plans.cursor"));
check('missing config is explicit', manifest.includes('CONFIG UNAVAILABLE') && panel.includes('FOUND CONFIG GAPS'));
check('all required actors checked', ['forge', 'vega', 'quill', 'atlas', 'lens', 'sage', 'scribe'].every((key) => manifest.includes(`'${key}'`)));
check('package port manifest is explicit', ['operator-entry', 'atlas-fast-lane', 'self-firing-work', 'praxis-orchestrator', 'configured-hands', 'provider-rails', 'worktree-lanes', 'lens-proof-gate', 'trust-gate', 'quartz-memory-loop', 'ambient-staff', 'operator-inbox'].every((id) => manifest.includes(`'${id}'`)));
check('ported diagram sections still render', ['◈ YOU', '◎ ATLAS', '⏱ SELF-FIRING', 'PRAXIS', '⎇ WORKTREE LANES', '◉ LENS', 'TRUST GATE', '◈ QUARTZ VAULT', '✳ SAGE', '✒ SCRIBE', '☰ HERMES', '◈ YOUR INBOX'].every((label) => panel.includes(label)));
check('honesty deviations remain documented', model.includes('Deviations from the Claude Design package') && model.includes('DECK_DEVIATIONS = 9'));

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
