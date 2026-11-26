/**
 * Flight Deck's send-to-agent - MIRRORS the Memory Galaxy's Cockpit "paste a message
 * to a single agent" mechanism exactly (src/knowledge/agentChat.ts's `sendToAgent`),
 * rather than inventing a parallel path. Same real commands underneath:
 *   • `agent_chat_append` / `agent_chat_read` - persists the exchange to the agent's
 *     thread (the SAME thread the Cockpit Fleet panel reads - Praxis + every other
 *     agent stays in sync because it's one shared log, not a Flight Deck-only copy).
 *   • `brain_chat` - persona reply for a question/quick ask (DEFAULT intent).
 *   • `orchestrate()` (src/orchestrator/orchestrator.ts) - a real work order, when the
 *     message reads as "go do this" (WORK_ORDER intent).
 *   • `write_run_note` + `hermes_teach` - durable decisions get written to memory so
 *     the ledger/Hermes stay current, exactly like the galaxy path.
 *
 * NOTE: this file used to also export `resolveAgentsForTarget`/`sendToTarget`
 * (+ the `SendTarget`/`SendToTargetResult` types) - target resolution letting the owner
 * address a whole LANE or REPO rather than one agent. Their only caller was the v2
 * `SendToAgentBox.tsx`, removed as dead code after the v3 deck port (the deck sends
 * per-session/per-agent/per-lane/per-repo casts itself, inline in DeckApp.tsx). Only
 * `appendFlightDeckAgentChat` - the v3 deck's real dependency - remains here.
 */
import type { Driver } from '../types';

type DelegateTool = 'claude' | 'codex' | 'cursor';

const FLIGHTDECK_REPLY_LIMIT = 12000;

function inTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export function agentIdForDelegateTool(tool: DelegateTool): 'a.forge' | 'a.vega' | 'a.quill' {
  switch (tool) {
    case 'codex':
      return 'a.vega';
    case 'cursor':
      return 'a.quill';
    case 'claude':
      return 'a.forge';
  }
}

function truncateForAgentMemory(text: string): string {
  if (text.length <= FLIGHTDECK_REPLY_LIMIT) return text;
  return `${text.slice(0, FLIGHTDECK_REPLY_LIMIT)}\n\n[truncated by Flight Deck memory write-back]`;
}

export async function appendFlightDeckAgentChat(args: {
  tool: DelegateTool;
  role: 'zach' | 'agent';
  text: string;
  driver: Driver;
  cwd: string | null;
  /** Which SESSION this was aimed at, when it was aimed at one.
   *
   *  The thread itself is per-AGENT (a.forge / a.vega / a.quill), so three
   *  messages to three different Forge sessions used to land indistinguishably in
   *  one file while the toast said "DELIVERED → <that session>". Recording the id
   *  at least makes the thread addressable and lets a reader tell them apart. */
  sessionId?: string | null;
}): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('agent_chat_append', {
      agentId: agentIdForDelegateTool(args.tool),
      role: args.role,
      text: args.role === 'agent' ? truncateForAgentMemory(args.text) : args.text,
      meta: {
        source: 'flightdeck',
        driver: args.driver,
        cwd: args.cwd,
        sessionId: args.sessionId ?? null,
      },
    });
  } catch {
    /* best-effort write-back; never block Flight Deck sends */
  }
}
