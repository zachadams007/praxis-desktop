/**
 * Flight Deck v3 - global prompt-vault search overlay.
 *
 * Restores the v2 "search ALL saved prompts" capability the port dropped. The
 * per-console vault tab (DeckDock) only shows one entity's queue; this reaches
 * across every lane / agent / repo / session at once via `pv_search`
 * (useDeckVault.searchVault → Rust). View + navigate only - deliberately NO
 * FIRE here, so an overnight session can browse the vault without ever
 * launching a prompt. Clicking a result opens that entry's owning console on
 * the vault tab, scrolled to it.
 *
 * Design language is borrowed verbatim from DeckDock's vault items (same card
 * border/background, same ◈ model + effort chips) so it reads as one surface.
 */
import { activateDeckControl } from '@/flightdeck/deck/a11y';
import React from 'react';
import { AGENT_META, type AgentId, type DeckModel, type DeckSession } from './model';
import { COLORS, withAlpha } from './tokens';
import { searchVault, type PvEntry } from './useDeckVault';
import type { DockTarget } from './DeckDock';

interface Props {
  open: boolean;
  onClose: () => void;
  model: DeckModel;
  sessions: DeckSession[];
  /** Open the entry's owning console (vault tab) and scroll to the entry. */
  onPick: (type: DockTarget, id: string, entryId: string) => void;
}

interface Owner {
  type: DockTarget;
  id: string;
  /** Human label for the console the entry is saved under. */
  label: string;
  /** Accent colour for the owner badge (agent/repo hue, praxis violet). */
  hue: string;
  /** False when the entry has no live console to open (e.g. a migrated entry
   *  whose lane no longer exists) - the row still shows, just isn't clickable. */
  navigable: boolean;
}

const PRAXIS_HUE = COLORS.accent;

/**
 * Resolve which console a vault entry belongs to. Deck entries carry an
 * `fd:<entKey>` tag where entKey is `praxis` | `agent:<id>` | `lane:<id>` |
 * `repo:<id>` | `session:<id>` (ids may themselves contain ':' - e.g.
 * `session:cursor:ab12` or a Windows worktree path - so we split on the FIRST
 * ':' only). Falls back to `laneHint` for older/migrated entries that predate
 * the tag scheme. Returns null when nothing resolves.
 */
export function resolveOwner(entry: PvEntry, model: DeckModel, sessions: DeckSession[]): Owner | null {
  const fdTag = entry.tags.find((t) => t.startsWith('fd:'));
  if (fdTag) {
    const entKey = fdTag.slice(3);
    if (entKey === 'praxis') {
      return { type: 'praxis', id: 'praxis', label: 'PRAXIS', hue: PRAXIS_HUE, navigable: true };
    }
    const colon = entKey.indexOf(':');
    if (colon > 0) {
      const type = entKey.slice(0, colon) as DockTarget;
      const id = entKey.slice(colon + 1);
      const built = ownerFor(type, id, model, sessions);
      if (built) return built;
    }
  }
  // Migrated FD entries carry only a laneHint (branch/lane id), no fd: tag.
  if (entry.laneHint) {
    const lane = model.laneById[entry.laneHint];
    if (lane) {
      const repo = model.repoById[lane.repoId];
      return { type: 'lane', id: lane.id, label: `${lane.letter} — ${repo?.name ?? ''}`.trim(), hue: repo?.hue ?? PRAXIS_HUE, navigable: true };
    }
    return { type: 'lane', id: entry.laneHint, label: entry.laneHint.toUpperCase(), hue: COLORS.textIdle, navigable: false };
  }
  return null;
}

function ownerFor(type: DockTarget, id: string, model: DeckModel, sessions: DeckSession[]): Owner | null {
  if (type === 'agent') {
    const a = AGENT_META[id as AgentId];
    return { type, id, label: a ? a.name : id.toUpperCase(), hue: a?.color ?? PRAXIS_HUE, navigable: true };
  }
  if (type === 'lane') {
    const lane = model.laneById[id];
    if (!lane) return { type, id, label: 'LANE (GONE)', hue: COLORS.textIdle, navigable: false };
    const repo = model.repoById[lane.repoId];
    return { type, id, label: `${lane.letter} — ${repo?.name ?? ''}`.trim(), hue: repo?.hue ?? PRAXIS_HUE, navigable: true };
  }
  if (type === 'repo') {
    const repo = model.repoById[id];
    return { type, id, label: repo ? repo.name : 'REPO (GONE)', hue: repo?.hue ?? COLORS.textIdle, navigable: Boolean(repo) };
  }
  if (type === 'session') {
    const s = sessions.find((x) => x.id === id);
    if (!s) return { type, id, label: 'SESSION (ENDED)', hue: COLORS.textIdle, navigable: false };
    return { type, id, label: s.name, hue: AGENT_META[s.agent]?.color ?? PRAXIS_HUE, navigable: true };
  }
  if (type === 'praxis') {
    return { type, id, label: 'PRAXIS', hue: PRAXIS_HUE, navigable: true };
  }
  return null;
}

export function DeckVaultSearch(props: Props): React.ReactElement | null {
  const { open, onClose, model, sessions, onPick } = props;
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<PvEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  // Whether the CURRENT query has a settled result set - distinguishes the
  // "nothing typed yet" prompt from an honest "no matches" state.
  const [ran, setRan] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  // Fresh open → blank slate + focus the field.
  React.useEffect(() => {
    if (!open) return;
    setQ('');
    setResults([]);
    setRan(false);
    setBusy(false);
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open]);

  // Debounced (~200ms) search. Empty query clears results without an IPC round-trip.
  React.useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setResults([]);
      setRan(false);
      setBusy(false);
      return;
    }
    setBusy(true);
    let cancelled = false;
    const t = window.setTimeout(async () => {
      const found = await searchVault(term);
      if (cancelled) return;
      setResults(found);
      setRan(true);
      setBusy(false);
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, open]);

  // Esc closes.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const modelChip: React.CSSProperties = { fontSize: 8, letterSpacing: '.08em', color: COLORS.accentBright, background: withAlpha(COLORS.accent, 0.1), border: `1px solid ${withAlpha(COLORS.accent, 0.4)}`, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap', fontWeight: 600, flex: 'none' };
  const effortChip: React.CSSProperties = { fontSize: 7.5, letterSpacing: '.12em', color: COLORS.textFaint, border: `1px solid ${withAlpha(COLORS.line, 0.22)}`, borderRadius: 6, padding: '3px 8px', whiteSpace: 'nowrap', flex: 'none' };

  return (
    <>
      <div aria-hidden="true"
        style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(2,3,8,.62)', animation: 'fdToastIn .18s ease' }}
        onClick={onClose}
      />
      <div
        data-screen-label="Vault Search"
        style={{ position: 'fixed', inset: 0, zIndex: 56, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 96, pointerEvents: 'none' }}
      >
        <div
          style={{
            pointerEvents: 'auto',
            width: 588,
            maxWidth: '92%',
            maxHeight: 640,
            display: 'flex',
            flexDirection: 'column',
            background: 'rgba(9,12,22,.985)',
            border: `1px solid ${withAlpha(COLORS.accent, 0.35)}`,
            borderRadius: 16,
            boxShadow: `0 34px 90px ${withAlpha(COLORS.black, 0.62)}`,
            overflow: 'hidden',
            animation: 'fdRise .22s ease',
          }}
        >
          <div style={{ height: 2, flex: 'none', background: `linear-gradient(90deg,${PRAXIS_HUE}cc,${PRAXIS_HUE}00 78%)` }} />
          {/* search field */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 18px 13px', borderBottom: `1px solid ${withAlpha(COLORS.line, 0.1)}`, flex: 'none' }}>
            <span style={{ fontSize: 16, color: PRAXIS_HUE, flex: 'none', lineHeight: 1 }}>⌕</span>
            <input
              ref={inputRef}
              className="fd-focus-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search every saved prompt — text or tag…"
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: COLORS.textBright, fontSize: 14, letterSpacing: '.01em' }}
            />
            <span style={{ fontSize: 7, letterSpacing: '.16em', color: COLORS.textFaintest, whiteSpace: 'nowrap', flex: 'none' }}>ESC TO CLOSE</span>
            <button type="button" aria-label="Close vault search" className="fd-control fd-hov-x" style={{ fontSize: 12, color: COLORS.textFaint, cursor: 'pointer', padding: '2px 4px', flex: 'none' }} onClick={onClose}>✕</button>
          </div>
          {/* results */}
          <div data-scroll="1" style={{ flex: 1, overflowY: 'auto', padding: '12px 14px 16px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            {!ran && !busy && (
              <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 13, color: COLORS.textFaint, padding: '24px 8px', textAlign: 'center' }}>
                every prompt saved anywhere in Praxis — start typing to find it
              </div>
            )}
            {busy && results.length === 0 && (
              <div style={{ fontSize: 8, letterSpacing: '.2em', color: COLORS.textFainter, padding: '14px 8px', textAlign: 'center' }}>SEARCHING…</div>
            )}
            {ran && !busy && results.length === 0 && (
              <div style={{ fontFamily: "'Newsreader',Georgia,serif", fontStyle: 'italic', fontSize: 13, color: COLORS.textFaint, padding: '24px 8px', textAlign: 'center' }}>
                no saved prompts match “{q.trim()}”
              </div>
            )}
            {ran && !busy && results.length > 0 && (
              <div style={{ fontSize: 7, letterSpacing: '.22em', color: COLORS.textFainter, padding: '2px 2px 4px' }}>
                {results.length} MATCH{results.length === 1 ? '' : 'ES'}
              </div>
            )}
            {results.map((it) => {
              const owner = resolveOwner(it, model, sessions);
              const canOpen = Boolean(owner?.navigable);
              return (
                <div role="button" tabIndex={canOpen ? 0 : -1} onKeyDown={activateDeckControl} aria-label={`Open saved prompt: ${it.text || 'empty'}`} aria-disabled={!canOpen}
                  key={it.id}
                  className={canOpen ? 'fd-hov-vault' : undefined}
                  onClick={canOpen && owner ? () => onPick(owner.type, owner.id, it.id) : undefined}
                  title={canOpen ? 'open its console on the vault tab' : 'no live console for this prompt'}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 7,
                    border: `1px solid ${withAlpha(COLORS.line, 0.12)}`,
                    background: withAlpha(COLORS.line, 0.04),
                    borderRadius: 9,
                    padding: '10px 12px',
                    cursor: canOpen ? 'pointer' : 'default',
                    transition: 'border-color .15s',
                  }}
                >
                  <div style={{ fontSize: 11, color: COLORS.textSoft, lineHeight: 1.6, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', wordBreak: 'break-word' }}>
                    {it.text || '— empty —'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={modelChip}>◈ {it.model ?? 'GPT-6 ASTRA'}</span>
                    <span style={effortChip}>{it.effort ?? 'MED'}</span>
                    {it.history.length > 0 && (
                      <span style={{ fontSize: 7.5, letterSpacing: '.1em', color: COLORS.textFainter, flex: 'none' }}>FIRED ×{it.history.length}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {owner ? (
                      <span
                        style={{ fontSize: 7.5, letterSpacing: '.12em', color: owner.hue, border: `1px solid ${owner.hue}55`, background: `${owner.hue}12`, borderRadius: 99, padding: '3px 9px', whiteSpace: 'nowrap', fontWeight: 700, flex: 'none', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {typeGlyph(owner.type)} {owner.label}
                      </span>
                    ) : (
                      <span style={{ fontSize: 7.5, letterSpacing: '.12em', color: COLORS.textIdle, border: `1px solid ${withAlpha(COLORS.line, 0.22)}`, borderRadius: 99, padding: '3px 9px', whiteSpace: 'nowrap', flex: 'none' }}>
                        {(it.source || 'UNFILED').toUpperCase()}
                      </span>
                    )}
                    {canOpen && <span style={{ fontSize: 9, color: COLORS.textFaint, flex: 'none' }}>↗</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function typeGlyph(type: DockTarget): string {
  switch (type) {
    case 'praxis':
      return '✦';
    case 'agent':
      return '◈';
    case 'lane':
      return '⋔';
    case 'repo':
      return '⎇';
    case 'session':
      return '▸';
    default:
      return '·';
  }
}
