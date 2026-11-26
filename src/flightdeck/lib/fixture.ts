// Demo fixture for the flow diagram - used ONLY for headless screenshot
// verification and `?demo=fleet` previews (gated to import.meta.env.DEV in
// api.ts's fetchTopology). Never used in release.
//
// NOTE: this file used to also export FLEET_FIXTURE (a matching LanesSnapshot
// fixture) for the v2 useLanes.ts hook. That hook and every v2 view it fed were
// removed as dead code after the v3 deck port, so FLEET_FIXTURE was removed too
// - only this topology fixture is still consumed (by api.ts).
import type { TopologySnapshot } from '../types';

export const TOPOLOGY_FIXTURE: TopologySnapshot = {
  generatedAt: Date.now(),
  repos: [
    {
      id: 'C--Users-dev-Desktop-catalyzed-alpha',
      label: 'Catalyzed Alpha',
      root: 'C:\\Users\\dev\\Desktop\\catalyzed-alpha',
      worktrees: [
        { path: 'C:\\Users\\dev\\Desktop\\catalyzed-alpha', branch: 'brand/app-icon-azure-gold', head: 'a2898a0', label: 'catalyzed-alpha', isMain: true },
        { path: 'C:\\Users\\dev\\Desktop\\catalyzed-lanes\\laneA', branch: 'lane/a', head: 'b05703c', label: 'laneA', isMain: false },
        { path: 'C:\\Users\\dev\\Desktop\\catalyzed-lanes\\laneB', branch: 'lane/b', head: 'b05703c', label: 'laneB', isMain: false },
        { path: 'C:\\Users\\dev\\Desktop\\catalyzed-lanes\\cursor', branch: 'lane/cursor', head: 'b05703c', label: 'cursor', isMain: false },
        { path: 'C:\\Users\\dev\\Desktop\\catalyzed-lanes\\codex', branch: 'lane/codex', head: '379027f', label: 'codex', isMain: false },
      ],
    },
    {
      id: 'C--Users-dev-Desktop-praxis',
      label: 'Praxis',
      root: 'C:\\Users\\dev\\Desktop\\praxis',
      worktrees: [
        { path: 'C:\\Users\\dev\\Desktop\\praxis', branch: 'feat/flight-deck', head: 'b98eedf', label: 'praxis', isMain: true },
      ],
    },
  ],
};
