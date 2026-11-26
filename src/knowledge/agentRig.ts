/**
 * agentRig.ts - the agent armillary-rig renderer + roam state machine (ported from the
 * Memory Galaxy design prototype's drawAgents / updateAgents / plow / nextTarget).
 *
 * Agents are INSTRUMENTS, not stars: a live armillary rig - two crossed precessing hoops
 * around a hot core, satellites riding the rings, name + task-progress hairline above, and
 * a verb readout below whenever it touches the vault. Every beam, scaffold and readout is a
 * real op fed through the engine's applyEvent(). The legacy "insignia" chip path is dropped
 * (orrery only, per the locked decision).
 *
 * This module is UI-free: it draws onto the engine's 2D context using the engine's camera +
 * node lookups, exposed via the `RigHost` interface so it stays decoupled from the class.
 */
import { rgba as rgbaHex, mix } from "./atlas";
import { agentSigil } from "@/glyphs/glyphs";
import type { AgentBody, EngineAgent, SimNode } from "./engineTypes";

/** Model-family tint (mirrors src/brain/modelTint MODEL_TINT; local copy keeps the rig
 *  self-contained and matches the design prototype's exact hues). */
export const MODEL_TINT: Record<string, string> = {
  opus: "#B48CFF",
  sonnet: "#FFC24A",
  haiku: "#5EF0A0",
  fable: "#FF6CC4",
  hermes: "#00E5FF",
  codex: "#26D4C8",
  cursor: "#F0A832",
};

/** What the rig renderer needs from the engine (camera + lookups + timing). */
export interface RigHost {
  ctx: CanvasRenderingContext2D;
  tms: number;
  reduced: boolean;
  ambient: boolean;
  accent: string;
  cam: { scale: number; tx: number; ty: number };
  agents: EngineAgent[];
  agentBodies: Record<string, AgentBody> | null;
  byId: Map<string, SimNode>;
  visible(n: SimNode): boolean;
  toScreen(n: { x: number; y: number }): { x: number; y: number };
  screenR(n: SimNode): number;
  glowSprite(hex: string): HTMLCanvasElement;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** working distance the rig hovers at from the star it has open. */
export function orbitR(node: SimNode, scale: number): number {
  return node.r + 9 + 13 / Math.max(0.35, scale);
}

/**
 * Draw all working agent rigs. Ported 1:1 from the DC (orrery renderer only) - comet
 * trails, live-op beams/scaffolds/weave-sparks, the precessing hoops + satellites + hot
 * core, and the name/progress/verb readouts.
 */
export function drawAgents(host: RigHost, zoom: number, W: number, H: number): void {
  const { ctx, agentBodies, agents } = host;
  if (!agentBodies) return;
  const still = !host.ambient || host.reduced;
  const accent = host.accent;
  const t = still ? 0.6 : host.tms * 0.001;
  const u = clamp(8 * Math.sqrt(Math.max(0.4, zoom)), 10, 18);
  const VERB: Record<string, string> = { read: "#7FA3FF", write: accent, link: "#35D3C0" };
  ctx.lineCap = "round";

  for (const ag of agents) {
    const b = agentBodies[ag.id];
    if (!b || ag.status !== "working") continue;
    const node = host.byId.get(b.nodeId);
    if (node && !host.visible(node)) continue;
    const tint = MODEL_TINT[ag.fam] || "#8FB4FF";
    const sc = host.toScreen(b);
    if (sc.x < -180 || sc.x > W + 180 || sc.y < -180 || sc.y > H + 180) continue;

    // comet trail while traveling
    if (!still && b.trail.length > 1) {
      let prev = host.toScreen(b.trail[0]);
      for (let i = 1; i < b.trail.length; i++) {
        const pt = b.trail[i];
        const cur = host.toScreen(pt);
        const age = 1 - (host.tms - pt.t) / 1300;
        if (age > 0) {
          ctx.strokeStyle = rgbaHex(tint, 0.28 * age * (i / b.trail.length));
          ctx.lineWidth = u * 0.26 * age;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(cur.x, cur.y);
          ctx.stroke();
        }
        prev = cur;
      }
    }

    // live ops → beams, forge scaffolds, weave sparks
    b.ops = (b.ops || []).filter((op) => host.tms - op.t0 < op.dur);
    interface RigMeta {
      op: AgentBody["ops"][number];
      N: SimNode;
      sn: { x: number; y: number };
      p: number;
      env: number;
      col: string;
      ang: number;
    }
    const meta: RigMeta[] = [];
    let top: RigMeta | null = null;
    for (const op of b.ops) {
      const N = host.byId.get(op.nodeId);
      if (!N || !host.visible(N)) continue;
      const sn = host.toScreen(N);
      const p = clamp((host.tms - op.t0) / op.dur, 0, 1);
      const m: RigMeta = {
        op,
        N,
        sn,
        p,
        env: Math.sin(Math.PI * p),
        col: op.type === "create" ? tint : VERB[op.type] || tint,
        ang: Math.atan2(sn.y - sc.y, sn.x - sc.x),
      };
      meta.push(m);
      if (!top || m.env > top.env) top = m;
    }
    const flare = clamp(b.flare || 0, 0, 1);
    const trav = b.state === "travel" ? 1 : 0;
    // the rig noses toward the star it is operating on
    const rx = sc.x + (top ? Math.cos(top.ang) * u * 0.5 * top.env : 0);
    const ry = sc.y + (top ? Math.sin(top.ang) * u * 0.5 * top.env : 0);

    if (b.state === "dwell" && node && !top) {
      // resting tether to the open file
      const sn = host.toScreen(node);
      ctx.strokeStyle = rgbaHex(tint, 0.15);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(sn.x, sn.y);
      ctx.lineTo(rx, ry);
      ctx.stroke();
    }
    for (const m of meta) {
      const dd = Math.hypot(m.sn.x - rx, m.sn.y - ry) || 1;
      const ex = m.sn.x - ((m.sn.x - rx) / dd) * (host.screenR(m.N) + 2);
      const ey = m.sn.y - ((m.sn.y - ry) / dd) * (host.screenR(m.N) + 2);
      ctx.save();
      ctx.strokeStyle = rgbaHex(m.col, 0.5 * m.env);
      ctx.lineWidth = m.op.type === "create" ? 1.3 : 0.9;
      ctx.setLineDash([2.5, 5.5]);
      ctx.lineDashOffset = (m.op.type === "read" ? 1 : -1) * host.tms * 0.022;
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.restore();
      if (m.op.type === "create") {
        // forge scaffold collapsing onto the newborn star
        const rr = Math.max(2.5, host.screenR(m.N) + 2 + (1 - m.p) * u * 1.7);
        ctx.strokeStyle = rgbaHex(m.col, 0.75 * m.env);
        ctx.lineWidth = 1.1;
        for (let q = 0; q < 3; q++) {
          const a0 = t * 3.1 + q * 2.0944;
          ctx.beginPath();
          ctx.arc(m.sn.x, m.sn.y, rr, a0, a0 + 1.3);
          ctx.stroke();
        }
      } else if (m.op.type === "link") {
        // weave spark circling the far anchor
        const a0 = t * 4.2;
        const orr = host.screenR(m.N) + 3.5;
        ctx.fillStyle = rgbaHex(m.col, 0.9 * m.env);
        ctx.beginPath();
        ctx.arc(m.sn.x + Math.cos(a0) * orr, m.sn.y + Math.sin(a0) * orr, 1.3, 0, 7);
        ctx.fill();
      } else {
        // read / write payload beads riding the beam
        for (let q = 0; q < 2; q++) {
          let bp = (m.p * 1.7 + q * 0.5) % 1;
          if (m.op.type === "read") bp = 1 - bp;
          ctx.fillStyle = rgbaHex(mix(m.col, "#ffffff", 0.3), 0.9 * m.env);
          ctx.beginPath();
          ctx.arc(rx + (ex - rx) * bp, ry + (ey - ry) * bp, 1.4, 0, 7);
          ctx.fill();
        }
      }
    }

    // the armillary rig glow
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.5 + flare * 0.4;
    const gs = u * (1.25 + flare * 0.55);
    ctx.drawImage(host.glowSprite(tint), rx - gs, ry - gs, gs * 2, gs * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    const ph = b.ph || 0;
    {
      const A = 1;
      const rr = u * (1.5 - trav * 0.22);
      const ir = u * 0.6;
      const w1 = t * (0.5 + flare * 1.6 + trav * 0.55) + ph;
      const w2 = -t * (0.38 + flare * 1.3 + trav * 0.45) + ph * 1.7 + 1.2;
      ctx.strokeStyle = rgbaHex(tint, 0.5 * A);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(rx, ry, rr, rr * 0.34, w1, 0, 7);
      ctx.stroke();
      ctx.strokeStyle = rgbaHex(tint, 0.34 * A);
      ctx.beginPath();
      ctx.ellipse(rx, ry, rr * 0.97, rr * 0.34, w2, 0, 7);
      ctx.stroke();
      const g0 = -t * (0.85 + flare * 1.8 + trav * 0.7) + ph;
      ctx.strokeStyle = rgbaHex(mix(tint, "#ffffff", 0.28), 0.8 * A);
      ctx.lineWidth = 1.1;
      for (let q = 0; q < 3; q++) {
        const a0 = g0 + q * 2.0944;
        ctx.beginPath();
        ctx.arc(rx, ry, ir, a0, a0 + 1.45);
        ctx.stroke();
      }
      if (top) {
        // dish arc facing the work
        ctx.strokeStyle = rgbaHex(top.col, 0.95 * top.env * A);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(rx, ry, ir + 2.2, top.ang - 0.5, top.ang + 0.5);
        ctx.stroke();
      }
      const sat = (w: number, th: number, k: number) => {
        const cx = Math.cos(th) * rr * k;
        const cy = Math.sin(th) * rr * 0.34 * k;
        const x = rx + cx * Math.cos(w) - cy * Math.sin(w);
        const y = ry + cx * Math.sin(w) + cy * Math.cos(w);
        ctx.fillStyle = rgbaHex(mix(tint, "#ffffff", 0.5), 0.95 * A);
        ctx.beginPath();
        ctx.arc(x, y, 1.25, 0, 7);
        ctx.fill();
      };
      sat(w1, t * (1.5 + flare * 2.2) + ph, 1);
      sat(w2, -t * 1.2 + ph * 2.3, 0.97);
    }
    // hot core
    ctx.fillStyle = mix(tint, "#ffffff", 0.62);
    ctx.beginPath();
    ctx.arc(rx, ry, u * 0.23 + flare * 0.9, 0, 7);
    ctx.fill();

    // name + task progress above, live verb readout below
    ctx.font = "600 9.5px " + MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = rgbaHex(tint, 0.95);
    ctx.shadowColor = "rgba(2,3,8,.85)";
    ctx.shadowBlur = 3;
    const ny = ry - u * 2.25;
    ctx.fillText(ag.name.toUpperCase(), rx, ny);
    ctx.shadowBlur = 0;
    const bw = u * 2.1;
    ctx.fillStyle = "rgba(233,238,247,.16)";
    ctx.fillRect(rx - bw / 2, ny + 3.5, bw, 1.4);
    ctx.fillStyle = rgbaHex(tint, 0.9);
    // Only a REAL measurement earns a progress hairline. A session-derived row has
    // no per-task percentage, so drawing one would render a constant as progress.
    if (ag.progKnown) ctx.fillRect(rx - bw / 2, ny + 3.5, bw * clamp(ag.prog || 0, 0, 1), 1.4);
    if (top) {
      let lb = String(top.N.label || "");
      if (lb.length > 16) lb = lb.slice(0, 15) + "…";
      ctx.font = "600 8px " + MONO;
      ctx.textBaseline = "top";
      ctx.fillStyle = rgbaHex(top.col, 0.95 * Math.min(1, top.env * 1.6));
      ctx.shadowColor = "rgba(2,3,8,.85)";
      ctx.shadowBlur = 3;
      ctx.fillText(top.op.type.toUpperCase() + " · " + lb, rx, ry + u * 1.8);
      ctx.shadowBlur = 0;
    }
  }
}

const MONO = "'IBM Plex Mono', ui-monospace, monospace";

/** Build (once) an offscreen sigil-badge sprite for an agent - the legacy chip renderer
 *  used it; kept for the roster's SVG path which uses agentSigil() directly. Retained here
 *  only if a future consumer wants the canvas badge. */
export function agentSprite(agentId: string, fam: string, tint: string): HTMLCanvasElement {
  const S = 96;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d")!;
  x.lineCap = "round";
  x.lineJoin = "round";
  x.fillStyle = "rgba(6,8,15,0.9)";
  x.beginPath();
  x.arc(S / 2, S / 2, S * 0.43, 0, 7);
  x.fill();
  x.strokeStyle = tint;
  x.lineWidth = S * 0.045;
  x.beginPath();
  x.arc(S / 2, S / 2, S * 0.43, 0, 7);
  x.stroke();
  const g = S * 0.62;
  const paths = agentSigil(agentId, fam);
  const drawSet = (col: string) => {
    x.strokeStyle = col;
    for (const p of paths) {
      x.lineWidth = 1.7 * (p.w || 1);
      x.stroke(new Path2D(p.d));
    }
  };
  x.save();
  x.translate((S - g) / 2, (S - g) / 2);
  x.scale(g / 24, g / 24);
  x.save();
  x.globalAlpha = 0.85;
  x.shadowColor = tint;
  x.shadowBlur = 7;
  drawSet(tint);
  x.restore();
  drawSet(mix(tint, "#ffffff", 0.32));
  x.restore();
  return c;
}
