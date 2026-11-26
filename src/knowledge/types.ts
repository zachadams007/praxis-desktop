/** The Memory Galaxy graph model - emitted by scripts/build-memory-graph.cjs from
 * Consumed by the custom star-atlas canvas engine.
 *
 *  TWO axes coexist (the star-atlas remodel):
 *    • AREA (`area`) - the owner's initiative the node belongs to (Praxis · Catalyzed Alpha ·
 *      Learn AI · Finance · Ventures · Studio, plus a `global` fallback). Drives node
 *      HUE, cluster position, and the Vault filter list.
 *    • ARTIFACT TYPE (`type`) - what kind of thing it is (note / conversation / task /
 *      reference / idea / capture). Drives the node GLYPH + label typography (secondary).
 *
 *  Structural roles: `hub` (an area index star, one per area) and `leaf` (everything else).
 *  There is no hard cluster boundary - density + nebula fog reads as the cluster. */

/** First-class artifact types - the things that live in the second brain. */
export type ArtifactKind =
  | "note" // a memory note (durable fact / decision)
  | "conversation" // a Claude Code session / chat
  | "task" // a unit of work - in-progress or planned
  | "reference" // an external reference / spec / research
  | "idea" // an intent-ledger topic (what the owner wants)
  | "capture"; // a loose dust capture (small star giving a region its density)

/** Structural node roles that aren't artifacts themselves. */
export type StructuralKind = "hub";

export type NodeKind = ArtifactKind | StructuralKind;

/** The six real initiatives + a fallback bucket for global/meta notes that fit no area
 *  (distinct from `orphan`, which is about link-degree). Matches src/data/realEvents.ts's
 *  repoToArea() taxonomy and src/shared/agents.ts AgentRow.touches. */
export type AreaId =
  | "praxis"
  | "catalyzed"
  | "learnai"
  | "finance"
  | "ventures"
  | "studio"
  | "global"; // global/meta - fits no single initiative

/** Real link between artifacts, or structural membership, or a directed dependency.
 *  `dep` = hand-authored `depends:`/`blockedBy:`/`upstream:`/`blocks:`/`downstream:`
 *  frontmatter - the strongest, sparsest typed dependency. `wlink` = a real `[[wikilink]]`
 *  found in a note's body - directed and dependency-shaped (A references B) but lighter-
 *  weight than a hand-authored `dep`, so the renderer gives it a quieter always-on
 *  arrowhead instead of the brighter dep treatment (2026-07-05). */
export type EdgeKind = "member" | "link" | "wlink" | "dep";

export interface GNode {
  id: string;
  label: string;
  /** Structural role: `hub` (area index) or an artifact kind (leaf). */
  kind: NodeKind;
  /** The artifact type that drives glyph + label typography. For a hub this is undefined. */
  type?: ArtifactKind;
  /** The initiative area - drives hue + clustering. */
  area: AreaId;
  /** real-link degree (drives size; 0 = no connections → faint "orphan"). */
  degree: number;
  /** a small/dust capture - smallest radius, faint label. */
  minor?: boolean;
  orphan?: boolean;
  /** a task with live work in flight (drives the accent pulse + progress). */
  live?: boolean;
  /** 0..1 progress for a live task (Inspector progress bar). */
  prog?: number;
  description?: string;
  /** optional metadata surfaced in the inspector (e.g. date, status, source). */
  meta?: string;
  /** the real Obsidian-openable file slug (for "Open in Obsidian"). */
  slug?: string;
  /** absolute path to the real source file on disk (multi-root: notes/docs from OTHER
   *  projects live outside the Praxis vault, so they can't use the obsidian:// vault-file
   *  scheme - see `openMode`). */
  path?: string;
  /** how the Inspector's open button should open this node's file. Nodes inside the Praxis
   *  memory vault omit this (default = "obsidian"); nodes whose real file lives outside that
   *  vault (another project's memory/intent/docs) get "file" so the Inspector falls back to
   *  the OS default-app opener instead of an obsidian://open?vault=memory URL that can't
   *  resolve a file outside the vault root. */
  openMode?: "obsidian" | "file";
}

export interface GEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  /** dep edges: true when the two ends live in different areas (a cross-seam). */
  cross?: boolean;
}

/** Area metadata - id, name, hue, layout anchor, one-line blurb. */
export interface Area {
  id: AreaId;
  name: string;
  hue: string;
  /** layout anchor (world units) - irregular so density clusters read organically. */
  ax: number;
  ay: number;
  blurb: string;
}

export interface GraphData {
  /** Multi-root build provenance (2026-07-02): every Claude Code project under
   *  `projectsRoot` is aggregated (each project's own memory/intent/docs), plus the Praxis
   *  `sessions` dir for conversation nodes. */
  generatedFrom?: { projectsRoot: string; sessions?: string };
  /** the area taxonomy present in this graph (in legend order). */
  areas?: Area[];
  nodes: GNode[];
  edges: GEdge[];
}
