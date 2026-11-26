/**
 * GraphControls - the left "Atlas" panel (ported from the design prototype): View / Vault /
 * Forces, frameless hairline chrome over the canvas, collapsible to a single icon button.
 *   • View - Node size + Link opacity sliders; Labels / Arrows / Nebula / Orphans toggles.
 *   • Vault - the per-AREA filter (dot + name + count) - the star-atlas clustering axis.
 *   • Forces - Repel / Gravity / Link length sliders.
 */
import { useMemo } from "react";
import { deriveAreaBuckets } from "./derive";
import type { GraphSettings } from "./graphSettings";
import type { GraphData, AreaId } from "./types";

interface Props {
  open: boolean;
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings>) => void;
  onToggleArea: (id: AreaId) => void;
  onReset: () => void;
  onCollapse: () => void;
  graph: GraphData;
}

export function GraphControls({ open, settings: s, onChange, onToggleArea, onReset, onCollapse, graph }: Props) {
  // Shared bucket derivation (same as the header + System pane) so the Vault counts always sum
  // to the header's artifact total; an un-tagged node shows as a read-only "Uncategorized" row.
  const { buckets } = useMemo(() => deriveAreaBuckets(graph), [graph]);

  if (!open) {
    return (
      <button className="mg-atlas-fab" title="Atlas controls" onClick={onCollapse}>
        ☰
      </button>
    );
  }

  return (
    <aside className="mg-atlas">
      <header className="mg-atlas-head">
        <h3>Atlas</h3>
        <div className="mg-atlas-actions">
          <button title="Reset layout & settings" onClick={onReset}>RESET</button>
          <button aria-label="Hide panel" onClick={onCollapse}>HIDE</button>
        </div>
      </header>

      <section className="mg-atlas-sec">
        <h4>View</h4>
        <Slider label="Node size" value={s.nodeScale} min={0.6} max={2} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => onChange({ nodeScale: v })} />
        <Slider label="Link opacity" value={s.linkOpacity} min={0.2} max={2} step={0.05} fmt={(v) => `${v.toFixed(2)}×`} onChange={(v) => onChange({ linkOpacity: v })} />
        <div className="mg-atlas-toggles">
          <Toggle label="Labels" on={s.labels} onClick={() => onChange({ labels: !s.labels })} />
          <Toggle label="Arrows" on={s.arrows} onClick={() => onChange({ arrows: !s.arrows })} />
          <Toggle label="Nebula" on={s.fog} onClick={() => onChange({ fog: !s.fog })} />
          <Toggle label="Orphans" on={s.showOrphans} onClick={() => onChange({ showOrphans: !s.showOrphans })} />
        </div>
      </section>

      <section className="mg-atlas-sec mg-atlas-bordered">
        <h4>Vault</h4>
        <div className="mg-vault-list">
          {buckets.map((a) => {
            // The Uncategorized catch-all has no area-filter toggle - render it read-only so the
            // Vault counts still reconcile with the header total without a dead toggle.
            const on = a.uncategorized ? true : s.shown[a.id as AreaId];
            return (
              <button
                key={a.id}
                className="mg-vault-item"
                style={{
                  color: on ? "#D5DDEC" : "var(--p-dim)",
                  opacity: on ? 1 : 0.45,
                  cursor: a.uncategorized ? "default" : "pointer",
                }}
                onClick={a.uncategorized ? undefined : () => onToggleArea(a.id as AreaId)}
                aria-disabled={a.uncategorized || undefined}
              >
                <span
                  className="mg-vault-dot"
                  style={{
                    background: a.hue,
                    boxShadow: on ? `0 0 8px -1px ${a.hue}` : "none",
                    filter: on ? "none" : "grayscale(.6)",
                  }}
                />
                <span className="mg-vault-name mg-ellip">{a.name}</span>
                <span className="mg-vault-count">{a.count}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mg-atlas-sec mg-atlas-bordered">
        <h4>Forces</h4>
        <Slider label="Repel" value={s.repel} min={14} max={90} step={1} fmt={(v) => `${Math.round(v)}`} onChange={(v) => onChange({ repel: v })} />
        <Slider label="Gravity" value={s.gravity} min={0.01} max={0.1} step={0.005} fmt={(v) => v.toFixed(3)} onChange={(v) => onChange({ gravity: v })} />
        <Slider label="Link length" value={s.linkDist} min={40} max={140} step={2} fmt={(v) => `${Math.round(v)}`} onChange={(v) => onChange({ linkDist: v })} />
      </section>
    </aside>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="mg-slider">
      <span className="mg-slider-head">
        <span>{label}</span>
        <span className="mg-slider-val">{fmt(value)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`mg-atlas-toggle ${on ? "on" : ""}`} onClick={onClick} aria-pressed={on}>
      <span className="mg-atlas-knob" aria-hidden />
      {label}
    </button>
  );
}
