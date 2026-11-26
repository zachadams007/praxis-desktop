/** Scribe must never combine two graph snapshots in one report. No live IO. */
const assert = require('assert/strict');
const path = require('path');
const esbuild = require('esbuild');
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const built = esbuild.buildSync({
  entryPoints: [path.join(__dirname, '../src/orchestrator/boardContributors.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  alias: { '@': path.join(__dirname, '../src') },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, mod, mod.exports);
const { scribeContribution } = mod.exports;

(async () => {
  const inputs = { vault_stats: {
    present: true, total_nodes: 1207, total_edges: 3022, orphan_count: 308,
    nodes_by_kind: [['note', 1200]], nodes_by_area: [['work', 1200]],
  } };
  const fallback = await scribeContribution(inputs);
  assert.equal(fallback.bullets[0], '1207 nodes (1200 notes + 7 area hubs), 3022 edges in the vault graph. Orphan counts exclude hubs.');
  assert.equal(fallback.bullets[3], '308 of 1200 notes are orphans (degree 0 — no real links).');
  const job = {
    agent: 'scribe', ok: true, artifact: 'hygiene.md',
    bullets: [
      '17 nodes (10 notes + 7 area hubs), 22 links in the Memory Galaxy. Orphan counts exclude hubs.',
      'Orphans by kind: 2 notes.',
      '2 of 10 Memory Galaxy notes are orphans (20%).',
    ],
  };
  const result = await scribeContribution(inputs, job);
  assert.deepEqual(result.bullets, [...job.bullets, 'Evidence: hygiene.md']);
  assert(!result.bullets.join(' ').includes('1207'), 'stale board census must never be prepended');
  const oldJob = { ...job, bullets: ['2 of 10 Memory Galaxy notes are orphans (20%).'] };
  assert.deepEqual((await scribeContribution(inputs, oldJob)).bullets, [...oldJob.bullets, 'Evidence: hygiene.md'], 'legacy jobs still must not mix snapshots');
  assert((await scribeContribution({ vault_stats: { present: false } })).bullets[0].includes("hasn't been built"));
  console.log('Scribe board tests: PASS (hub explanation, orphan basis, snapshot isolation, legacy job, missing graph)');
})().catch(error => { console.error(error); process.exitCode = 1; });
