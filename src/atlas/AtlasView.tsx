/**
 * AtlasView - the premium bento command-dashboard shell around the iso task-city.
 *
 * Layout (3-column bento + top bar), all glass over the 3D canvas:
 *   top - wordmark · breadcrumb · workspace mode · legend
 *   left - initiative RAIL: per-district status bars + sparkline + a completion
 *            donut; click flies the city to that district
 *   center - the AtlasCity canvas (fills; the rails float over its edges)
 *   right - focused district DRILL-IN: NOW / NEXT / LATER / DONE lanes + the
 *            agents on site; with nothing focused, a workspace summary
 *
 * Reads the SAME model as the brain (journey.ts + the live store), so the two
 * directions never disagree. Presentational; the camera/picking live in AtlasCity.
 */

import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AtlasCity } from "./AtlasCity";
import { usePraxisStore } from "@/store/usePraxisStore";
import { buildGraph, CLUSTER_ORDER } from "@/data/graph";
import { AUTHORED_MILESTONES, STATUS_RANK, type MilestoneStatus } from "@/data/journey";
import { areaHuesOf } from "@/theme/tokens";
import { useActivePalette } from "@/theme/useActivePalette";
import { Glyph, AREA_GLYPH } from "@/glyphs/glyphs";

const STATUS_ORDER: MilestoneStatus[] = ["active", "next", "later", "done"];
const STATUS_LABEL: Record<MilestoneStatus, string> = {
  active: "NOW · firing",
  next: "NEXT",
  later: "LATER",
  done: "DONE",
};

interface DistrictStat {
  id: string;
  label: string;
  hue: string;
  total: number;
  done: number;
  pct: number;
  firing: boolean;
  byStatus: Record<MilestoneStatus, { id: string; label: string; eta?: string }[]>;
}

function useDistrictStats(): DistrictStat[] {
  const palette = useActivePalette();
  return useMemo(() => {
    const hues = areaHuesOf(palette);
    const g = buildGraph();
    return CLUSTER_ORDER.map((id) => {
      const ms = AUTHORED_MILESTONES.filter((m) => m.areaId === id).sort(
        (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order,
      );
      const byStatus = { active: [], next: [], later: [], done: [] } as DistrictStat["byStatus"];
      for (const m of ms) byStatus[m.status].push({ id: m.id, label: m.label, eta: m.eta });
      const done = byStatus.done.length;
      return {
        id,
        label: g.byId.get(id)?.label ?? id,
        hue: hues[id] ?? palette.baseCool,
        total: ms.length,
        done,
        pct: ms.length ? done / ms.length : 0,
        firing: byStatus.active.length > 0,
        byStatus,
      };
    });
  }, [palette]);
}

/** Deterministic cumulative-progress sparkline points from a district's statuses. */
function sparkPoints(stat: DistrictStat, w: number, h: number): string {
  const seq: MilestoneStatus[] = [];
  for (const s of ["done", "active", "next", "later"] as MilestoneStatus[])
    for (let i = 0; i < stat.byStatus[s].length; i++) seq.push(s);
  if (seq.length < 2) return `0,${h} ${w},${h * 0.5}`;
  const weight: Record<MilestoneStatus, number> = { done: 1, active: 0.7, next: 0.4, later: 0.2 };
  let acc = 0;
  const max = seq.reduce((a, s) => a + weight[s], 0) || 1;
  return seq
    .map((s, i) => {
      acc += weight[s];
      const x = (i / (seq.length - 1)) * w;
      const y = h - (acc / max) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export function AtlasView() {
  const stats = useDistrictStats();
  const palette = useActivePalette();
  const focusId = usePraxisStore((s) => s.focusId);
  const agents = usePraxisStore((s) => s.agents);

  // overall completion across every initiative (the headline donut)
  const totalAll = stats.reduce((a, s) => a + s.total, 0);
  const doneAll = stats.reduce((a, s) => a + s.done, 0);
  const pctAll = totalAll ? doneAll / totalAll : 0;
  const firingCount = stats.filter((s) => s.firing).length;
  const workingAgents = Object.values(agents).filter((a) => a.status === "working");

  // which district is focused (a task focus rolls up to its area)
  const g = buildGraph();
  const focusedAreaId = focusId
    ? g.byId.get(focusId)?.areaId ?? (stats.some((s) => s.id === focusId) ? focusId : null)
    : null;
  const focused = stats.find((s) => s.id === focusedAreaId) ?? null;
  const focus = (id: string | null) => usePraxisStore.getState().focus(id);

  return (
    <div className="atlas-root">
      <AtlasCity />

      {/* ---------- top bar ---------- */}
      <header className="atlas-top pane">
        <div className="atlas-brand">
          <span className="atlas-brand-mark" aria-hidden />
          <h1>PRAXIS</h1>
          <span className="atlas-brand-sub">Atlas</span>
        </div>
        <nav className="atlas-crumb" aria-label="breadcrumb">
          <button className="crumb-link" onClick={() => focus(null)}>
            Workspace
          </button>
          {focused && (
            <>
              <span className="crumb-sep">›</span>
              <span className="crumb-here" style={{ color: focused.hue }}>
                {focused.label}
              </span>
            </>
          )}
        </nav>
        <div className="atlas-legend">
          <span className="lg"><i className="lg-swatch" style={{ background: palette.accent }} />firing</span>
          <span className="lg"><i className="lg-swatch lg-tall" />scope = height</span>
          <span className="lg"><i className="lg-line" />dependency</span>
        </div>
      </header>

      {/* ---------- left rail: initiatives ---------- */}
      <aside className="atlas-left pane">
        <div className="atlas-rail-head">
          <span className="kicker">INITIATIVES</span>
          <span className="kicker-dim">{stats.length} districts</span>
        </div>

        <div className="atlas-init-list" role="list">
          {stats.map((s) => {
            const on = focusedAreaId === s.id;
            return (
              <button
                key={s.id}
                role="listitem"
                className={`init-row ${on ? "init-on" : ""} ${s.firing ? "init-firing" : ""}`}
                style={{ "--hue": s.hue } as React.CSSProperties}
                onClick={() => focus(s.id)}
              >
                <span className="init-glyph">
                  <Glyph id={AREA_GLYPH[s.id] ?? "praxis"} size={16} />
                </span>
                <span className="init-body">
                  <span className="init-name">{s.label}</span>
                  <span className="init-meta">
                    {s.done}/{s.total} done
                    {s.firing && <span className="init-live">● live</span>}
                  </span>
                </span>
                <svg className="init-spark" viewBox="0 0 56 22" preserveAspectRatio="none" aria-hidden>
                  <polyline points={sparkPoints(s, 56, 22)} fill="none" stroke={s.hue} strokeWidth={1.4} />
                </svg>
              </button>
            );
          })}
        </div>

        {/* completion donut */}
        <div className="atlas-score">
          <Donut pct={pctAll} color={palette.accent} track={palette.line} />
          <div className="score-meta">
            <span className="score-num mono">{Math.round(pctAll * 100)}</span>
            <span className="score-lbl">% shipped</span>
            <span className="score-sub mono">
              {doneAll}/{totalAll} tasks
            </span>
          </div>
        </div>
      </aside>

      {/* ---------- right rail: district drill-in ---------- */}
      <aside className="atlas-right pane">
        <AnimatePresence mode="wait" initial={false}>
          {focused ? (
            <motion.div
              key={focused.id}
              className="atlas-drill"
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 14 }}
              transition={{ duration: 0.22 }}
            >
              <div className="drill-head" style={{ "--hue": focused.hue } as React.CSSProperties}>
                <span className="drill-dot" />
                <h2>{focused.label}</h2>
                <span className="drill-count mono">
                  {focused.done}/{focused.total}
                </span>
              </div>

              {STATUS_ORDER.map((st) =>
                focused.byStatus[st].length ? (
                  <section key={st} className={`lane lane-${st}`}>
                    <header className="lane-head">
                      <span className="lane-name">{STATUS_LABEL[st]}</span>
                      <span className="lane-n mono">{focused.byStatus[st].length}</span>
                    </header>
                    <ul className="lane-rows">
                      {focused.byStatus[st].map((t) => (
                        <li key={t.id}>
                          <button
                            className={`task-row ${focusId === t.id ? "task-on" : ""}`}
                            onClick={() => focus(t.id)}
                          >
                            <span className="task-tick" aria-hidden />
                            <span className="task-label">{t.label}</span>
                            {t.eta && <span className="task-eta">{t.eta}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null,
              )}

              <section className="agents-on-site">
                <header className="lane-head">
                  <span className="lane-name">AGENTS ON SITE</span>
                </header>
                {workingAgents.filter((a) => a.areaId === focused.id).length ? (
                  <ul className="agent-rows">
                    {workingAgents
                      .filter((a) => a.areaId === focused.id)
                      .map((a) => (
                        <li key={a.id} className="agent-row">
                          <span className="agent-pip" />
                          <span className="agent-name">{a.name}</span>
                          <span className="agent-role">{a.role}</span>
                          <span className="agent-state mono">working</span>
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="agents-empty">No agents on site — idle district.</p>
                )}
              </section>
            </motion.div>
          ) : (
            <motion.div
              key="summary"
              className="atlas-summary"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22 }}
            >
              <span className="kicker">WORKSPACE</span>
              <div className="sum-grid">
                <Stat n={totalAll} label="tasks placed" />
                <Stat n={firingCount} label="districts firing" accent={palette.accent} />
                <Stat n={workingAgents.length} label="agents working" />
                <Stat n={doneAll} label="shipped" />
              </div>
              <p className="sum-hint">
                Click a district to drill in. Building <strong>height</strong> = scope,{" "}
                <strong style={{ color: palette.accent }}>glow</strong> = firing now.
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </aside>

      <div className="atlas-hint">drag to pan · scroll to zoom · click a building</div>
    </div>
  );
}

/* --------------------------------------------------------------- bits ---- */

function Stat({ n, label, accent }: { n: number; label: string; accent?: string }) {
  return (
    <div className="sum-stat">
      <span className="sum-num mono" style={accent ? { color: accent } : undefined}>
        {n}
      </span>
      <span className="sum-lbl">{label}</span>
    </div>
  );
}

function Donut({ pct, color, track }: { pct: number; color: string; track: string }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  return (
    <svg className="donut" viewBox="0 0 64 64" width={64} height={64} aria-hidden>
      <circle cx={32} cy={32} r={R} fill="none" stroke={track} strokeWidth={6} />
      <circle
        cx={32}
        cy={32}
        r={R}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - pct)}
        transform="rotate(-90 32 32)"
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
    </svg>
  );
}
