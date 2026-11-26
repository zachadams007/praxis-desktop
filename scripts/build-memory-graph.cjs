/**
 * build-memory-graph - turn the owner's REAL second brain into a typed, grouped, linked graph
 * the Memory Galaxy renders. Per the intent ledger (praxis-agent-conversations-in-memory-
 * graph): the galaxy should show "Claude conversations, worker reports, artifacts, tasks,
 * memories, dependencies, and how they connect" - first-class typed nodes, not just notes.
 *
 * ARTIFACT TYPES (the legend):
 *   • note - a memory note (durable fact / decision)            [memory/*.md]
 *   • reference - a spec / research / external reference             [memory/*.md type:reference]
 *   • task - a unit of work, planned or in-flight              [intent 🚧/🔜 + project notes]
 *   • idea - an intent-ledger topic (what the owner wants)           [intent/topics/*.md]
 *   • conversation - a real Claude Code session                        [projects/<proj>/*.jsonl]
 *
 * Edges  = type membership (artifact → its type hub → root) AND the REAL connections:
 *          `[[wikilinks]]` between notes, and conversation→note links (a session that
 *          mentions a note's slug links to it - the agent depositing into shared memory).
 * Degree = number of real links touching a node → drives size; degree 0 = faint orphan.
 *
 * A soft cap (MAX_NODES) keeps the render sane once every project is in-scope - hubs and
 * linked notes always survive; excess isolated stubs are dropped beyond the cap, LOUDLY
 * logged (never silently truncated) so a future pass can raise the cap or split further.
 *
 * Writes public/memory-graph.json (gitignored - it's personal memory). The galaxy fetches
 * it; if absent it falls back to a small bundled sample so the view is never blank.
 *
 *   node scripts/build-memory-graph.cjs [projectsRoot] [reserved] [reserved] [outPath]
 *
 * `outPath` defaults to public/memory-graph.json (dev + `npm run graph:build`). The Rust
 * `refresh_memory_graph` command (src-tauri/src/memory_graph.rs) passes an explicit outPath
 * under %LOCALAPPDATA%\Praxis instead - `public/` is baked into `dist` at BUILD time, so a
 * packaged app can't refresh it at runtime by writing there. Args 2–3 are kept as
 * positional placeholders (single-root legacy callers) but are no longer read - multi-root
 * discovery replaces them; see `PROJECTS_ROOT` below.
 */
const fs = require("fs");
const path = require("path");

// ── Roots + tunables (consts up top, per the build brief) ──────────────────────────────
const USERPROFILE = process.env.USERPROFILE || "C:/Users/dev";
const PROJECTS_ROOT = process.argv[2] || path.join(USERPROFILE, ".claude", "projects");
// argv[3] reserved (was single-project INTENT_DIR; multi-root discovery supersedes it)
// argv[4] reserved (was single-project SESSIONS_DIR; Praxis conversations still use it)
const PRAXIS_PROJECT_DIR = path.join(PROJECTS_ROOT, "C--Users-dev-Desktop-praxis");
const PRAXIS_SESSIONS_DIR = process.argv[4] || PRAXIS_PROJECT_DIR;
const OUT = process.argv[5] || path.join(__dirname, "..", "public", "memory-graph.json");

const MAX_CONVERSATIONS = 14; // most-recent Praxis sessions surfaced as conversation nodes

// Soft cap on total nodes once every project is aggregated. Hubs + anything with a real
// link (wikilink, task↔idea, conversation↔note) always survives; isolated leaf stubs are
// dropped beyond this budget - most-recently-modified-first - and every drop is logged.
const MAX_NODES = 1200;
// Per-area floor so one giant project (e.g. Catalyzed's 267 notes) can't crowd out a
// smaller one entirely once the global cap kicks in.
const MIN_PER_AREA = 40;

// One label per artifact-type hub.
const TYPE_LABEL = {
  note: "Notes",
  reference: "References",
  task: "Tasks",
  idea: "Ideas",
  conversation: "Conversations",
};

const titleCase = (slug) =>
  slug
    .replace(/\.md$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

function readFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  const nameM = m[1].match(/^name:\s*(.+)$/m);
  const descM = m[1].match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const typeM = m[1].match(/^\s*type:\s*([a-z|]+)/m); // metadata.type (first word)
  if (nameM) fm.name = nameM[1].trim();
  if (descM) fm.description = descM[1].trim();
  if (typeM) fm.type = typeM[1].trim().split("|")[0].trim();
  // `depends:` - hand-authored REAL dependencies (this note builds on / requires that
  // one). Accepts inline `depends: a, [[b]]` or a YAML list of `- slug` lines. These
  // become directed `dep` edges (this → prerequisite) - the STRONGEST typed dependency
  // kind the galaxy animates its brighter dependency arrows on, so only author them
  // where a genuine dependency exists (design rule: arrows must mean something).
  //
  // Rather than fabricate relationships, we ALSO read a few synonym frontmatter keys that are
  // just as hand-authored and dependency-shaped: `blockedBy`/`upstream` (this note is gated on /
  // builds on that one - same direction as `depends:`) and `blocks` (the inverse - that note
  // depends on THIS one, so we flip direction below). `related:` is explicitly NOT a dependency
  // (no inherent direction) - it becomes a plain `link` via fm.related, handled by the caller
  // alongside body wikilinks.
  const parseSlugList = (key) => {
    const inlineM = m[1].match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    if (!inlineM) return [];
    let raw = inlineM[1].trim();
    if (!raw) {
      const listM = m[1].match(new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s*.+\\n?)+)`, "m"));
      raw = listM ? listM[1].replace(/\s*-\s*/g, ",") : "";
    }
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^\[\[|\]\]$/g, "").replace(/\.md$/, ""))
      .filter(Boolean);
  };
  const depends = parseSlugList("depends");
  const blockedBy = parseSlugList("blockedBy");
  const upstream = parseSlugList("upstream");
  if (depends.length || blockedBy.length || upstream.length) {
    fm.depends = [...new Set([...depends, ...blockedBy, ...upstream])];
  }
  const blocks = parseSlugList("blocks");
  const downstream = parseSlugList("downstream");
  if (blocks.length || downstream.length) {
    // inverse direction: THIS note is the prerequisite, the named note(s) depend on it.
    fm.blocksTargets = [...new Set([...blocks, ...downstream])];
  }
  const related = parseSlugList("related");
  if (related.length) fm.related = related;
  return fm;
}

// pull a project's MEMORY.md's "[Title](file.md)" so leaves get the human title
function readIndexTitles(memDir) {
  const map = {};
  const p = path.join(memDir, "MEMORY.md");
  if (!fs.existsSync(p)) return map;
  const txt = fs.readFileSync(p, "utf8");
  const re = /\[([^\]]+)\]\(([a-z0-9._-]+)\.md\)/gi;
  let m;
  while ((m = re.exec(txt))) map[m[2]] = m[1].replace(/[⭐⚠️✅🚧🔜❓⛔🧠📐⌨️]/gu, "").trim();
  return map;
}

/** Recursively collect .md files under a dir (used for intent/topics, which sometimes
 *  nests one slug-directory deep - e.g. Praxis's shared ledger `topics/praxis/*.md`). */
function walkMd(dir, depth = 2) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const stack = [{ d: dir, depth }];
  while (stack.length) {
    const { d, depth: rem } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory() && rem > 0 && e.name !== "archive") stack.push({ d: fp, depth: rem - 1 });
      else if (e.isFile() && e.name.endsWith(".md") && e.name !== "INDEX.md") out.push(fp);
    }
  }
  return out;
}

const nodes = new Map(); // id -> node
const edges = [];
const addNode = (id, n) => { if (!nodes.has(id)) nodes.set(id, { id, ...n }); return nodes.get(id); };
const addEdge = (source, target, kind) => edges.push({ source, target, kind });
// `blocks:`/`downstream:` frontmatter names a note that hasn't necessarily been visited
// yet (forward reference, same as wikilinks) - queue them and resolve into real `dep`
// edges once every project's notes have been read (see "resolve pending inverse deps").
const pendingInverseDeps = []; // { source, target } - already in final id form

// ── AREA taxonomy (the star-atlas clustering axis) ─────────────────────────
// Reuses the EXACT names from src/data/realEvents.ts repoToArea() + the six real
// initiatives (plus a `global` fallback for meta/cross-cutting notes). One hub per area.
const AREAS = [
  { id: "praxis", name: "Praxis" },
  { id: "catalyzed", name: "Catalyzed Alpha" },
  { id: "learnai", name: "Learn AI" },
  { id: "finance", name: "Finance" },
  { id: "ventures", name: "Ventures" },
  { id: "studio", name: "Studio" },
  { id: "global", name: "Global" },
];
const AREA_NAME = Object.fromEntries(AREAS.map((a) => [a.id, a.name]));

/** Infer a node's area from its slug/label/text (mirrors realEvents.ts repoToArea). */
function areaOf(...parts) {
  const s = parts.filter(Boolean).join(" ").toLowerCase();
  if (/catalyzed|friends-feed|bloomberg|stock-signal/.test(s)) return "catalyzed";
  if (/studio|render-pipeline|faceless|shorts|autopost/.test(s)) return "studio";
  if (/trading-bot|freqai|alpaca|backtest|\bspend\b|usage-ledger|guardrail|budget|finance/.test(s)) return "finance";
  if (/freelanc|monetize|ventures|offers|outreach|pricing/.test(s)) return "ventures";
  if (/learn-ai|learnai|\bskill\b|skills|workflow|offload|memprompt|overnight|codex|model-rout|agent-stack|subscription/.test(s)) return "learnai";
  if (/praxis|brain|flight-deck|flightdeck|journey|gesture|orchestrator|hermes|voice|command-center|memory-galaxy|event-bus|connectome/.test(s)) return "praxis";
  return "global";
}

/** Classify an entire PROJECT (by its `.claude/projects/<slug>` dir name and/or resolved
 *  repo path) onto one Area. Same rule family as `areaOf`, applied to the project identity
 *  rather than per-note text - this is what fixes the overrepresentation: a note in
 *  Catalyzed's memory folder is Catalyzed even if its slug never says so. Falls back to
 *  per-note `areaOf` only for genuinely ambiguous/global project dirs (home dir, system32).
 */
function classifyProject(projectSlug, repoPath) {
  const s = `${projectSlug} ${repoPath || ""}`.toLowerCase();
  if (/catalyzed/.test(s)) return "catalyzed";
  if (/studio|render-pipeline/.test(s)) return "studio";
  if (/trading-bot|finance|alpha-fund/.test(s)) return "finance";
  if (/freelanc|ventures|3d-print/.test(s)) return "ventures";
  if (/learn-ai|learnai|\bskills?\b/.test(s)) return "learnai";
  if (/praxis|flight-deck|flightdeck/.test(s)) return "praxis";
  return null;
}

/** Reverse a Claude Code project-dir slug back to a real filesystem path, best-effort.
 *  `C--Users-dev-Desktop-foo` → `C:/Users/dev/Desktop/foo`. Claude slugifies `:` → `-`
 *  and `\`/`/` → `-`, which is lossy for names that legitimately contain hyphens - so this
 *  is a heuristic used only to locate an OPTIONAL docs/README enrichment, never required
 *  for a project's memory/intent to be included. */
function guessRepoPath(slug) {
  if (!/^[A-Za-z]--/.test(slug)) return null;
  const drive = slug[0].toUpperCase() + ":";
  const rest = slug.slice(3).replace(/-/g, "/");
  return `${drive}/${rest}`;
}

const PRAXIS_PROJECT_SLUG = "C--Users-dev-Desktop-praxis";
const PRAXIS_VAULT_DIR = path.join(PROJECTS_ROOT, PRAXIS_PROJECT_SLUG, "memory");

/** Nodes whose real file lives inside the Praxis memory vault (the actual Obsidian vault
 *  root) keep the existing obsidian://open?vault=memory flow (App.tsx's openInObsidian).
 *  Everything else - another project's memory/intent/docs, OR Praxis's own repo docs/*.md
 *  (which live in the repo checkout, not the vault) - is OUTSIDE that vault, so the
 *  Inspector needs to fall back to opening the file directly (src/knowledge/App.tsx's
 *  openMode:"file" branch, via the opener plugin's openPath). */
const openModeFor = (fp) => (fp && fp.startsWith(PRAXIS_VAULT_DIR) ? undefined : "file");

const hubId = (area) => `hub.${area}`;
const ensureHub = (area) => {
  const id = hubId(area);
  if (!nodes.has(id)) {
    addNode(id, { label: AREA_NAME[area] || area, kind: "hub", area, degree: 0 });
  }
  return id;
};

/** Map a memory note's frontmatter type → an artifact kind. */
function noteKind(fmType) {
  if (fmType === "reference") return "reference";
  return "note"; // project / feedback / user / (default) all read as durable notes
}

// ── discover every Claude Code project ──────────────────────────────────────────────────
const droppedLog = []; // { reason, id }
let projectDirs = [];
// One retry after 500ms: a transient EPERM/EBUSY here (AV scan, OneDrive, whatever) once
// produced a sessions-only 13-node graph that CLOBBERED the real 950-node one and rendered
// as an empty-looking galaxy (found live 2026-07-02 7:16pm). Never trust a single failed read.
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    break;
  } catch (e) {
    console.error(`[build-memory-graph] cannot read projects root ${PROJECTS_ROOT} (attempt ${attempt + 1}/2): ${e.message}`);
    if (attempt === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}
// The degenerate guards below mean "never CLOBBER a good graph", not "never write":
// on a machine with no previous graph (fresh install/profile), publishing a thin
// sessions-only graph beats leaving read_memory_graph returning None forever.
const HAS_PREVIOUS_GRAPH = fs.existsSync(OUT);
if (projectDirs.length === 0) {
  // A graph built with zero projects would contain only Praxis session stubs - worse than
  // useless when it replaces the last GOOD graph. Fail loudly, keep the old file.
  console.error(`[build-memory-graph] no project dirs under ${PROJECTS_ROOT}`);
  if (HAS_PREVIOUS_GRAPH) {
    console.error("[build-memory-graph] ABORT: refusing to overwrite the previous graph with a degenerate one");
    process.exit(1);
  }
  console.error("[build-memory-graph] no previous graph exists — continuing so the first run publishes something");
}

const projects = projectDirs.map((slug) => {
  const dir = path.join(PROJECTS_ROOT, slug);
  const repoPath = guessRepoPath(slug);
  return { slug, dir, memDir: path.join(dir, "memory"), repoPath, forcedArea: classifyProject(slug, repoPath) };
});

const perProjectStats = []; // { slug, area, notes, ideas, tasks, docs }
const noteSlugs = new Set(); // slugs that exist as note/reference nodes (for conversation linking, Praxis only)

for (const proj of projects) {
  if (!fs.existsSync(proj.memDir)) continue;
  const stat = { slug: proj.slug, area: proj.forcedArea || "(per-note)", notes: 0, ideas: 0, tasks: 0, docs: 0 };
  const titles = readIndexTitles(proj.memDir);

  // ── memory notes ──────────────────────────────────────────────────────────
  let files = [];
  try { files = fs.readdirSync(proj.memDir); } catch { /* unreadable - skip project */ }
  for (const f of files) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const fp = path.join(proj.memDir, f);
    let txt;
    try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
    const fm = readFrontmatter(txt);
    const slug = f.replace(/\.md$/, "");
    // Namespace the node id by project so same-named notes across projects don't collide
    // (e.g. every project has feedback-*.md). Praxis keeps bare ids for backward-compat
    // with existing [[wikilinks]] written before multi-root.
    const bareId = fm.name || slug;
    const id = proj.slug === "C--Users-dev-Desktop-praxis" ? bareId : `${proj.slug}:${bareId}`;
    const type = noteKind(fm.type);
    const label = titles[slug] || titleCase(bareId);
    const area = proj.forcedArea || areaOf(slug, bareId, label, fm.description);
    addNode(id, {
      label, kind: type, type, area, slug, path: fp, openMode: openModeFor(fp),
      description: fm.description || "", degree: 0, project: proj.slug,
    });
    addEdge(ensureHub(area), id, "member");
    noteSlugs.add(bareId);
    noteSlugs.add(slug);
    stat.notes++;
    // real [[wikilinks]] in the body → connection edges (resolved after all nodes exist).
    // Wikilinks are per-project (they reference sibling slugs, not cross-project ids).
    const body = txt.replace(/^---[\s\S]*?---/, "");
    const seen = new Set(); // dep/inverse-dep/related targets - a wikilink to the same
                            // slug stays whatever the frontmatter already declared it as
                            // (a dep beats a plain link: the galaxy only animates deps).
    const toId = (slug) => (proj.slug === "C--Users-dev-Desktop-praxis" ? slug : `${proj.slug}:${slug}`);
    // frontmatter `depends:`/`blockedBy:`/`upstream:` → directed dep edges (this →
    // prerequisite) FIRST, so a same-slug wikilink below doesn't downgrade it.
    for (const dep of fm.depends || []) {
      const tgtId = toId(dep);
      if (tgtId !== id && !seen.has(tgtId)) { seen.add(tgtId); addEdge(id, tgtId, "dep"); }
    }
    // `blocks:`/`downstream:` → inverse-direction dep edges (named note → this one; THIS
    // note is the prerequisite). Queued for resolution once every node exists (2026-07-05).
    for (const tgt of fm.blocksTargets || []) {
      const tgtId = toId(tgt);
      if (tgtId !== id) pendingInverseDeps.push({ source: tgtId, target: id });
    }
    // `related:` frontmatter → plain non-directional links (explicitly not a dependency).
    for (const rel of fm.related || []) {
      const tgtId = toId(rel);
      if (tgtId !== id && !seen.has(tgtId)) { seen.add(tgtId); addEdge(id, tgtId, "link"); }
    }
    // real [[wikilinks]] in the body - a genuine, already-authored relationship. The owner
    // (2026-07-05): surfacing these as lighter directed edges is legitimate, not invented;
    // they become `wlink` (wikilink-derived) so the renderer can give them a quiet
    // always-on arrowhead without conflating them with hand-authored `dep` edges.
    let lm;
    const re = /\[\[([a-z0-9._-]+)\]\]/gi;
    while ((lm = re.exec(body))) {
      const tgt = lm[1].trim();
      const tgtId = toId(tgt);
      if (tgtId !== id && !seen.has(tgtId)) { seen.add(tgtId); addEdge(id, tgtId, "wlink"); }
    }
  }

  // ── ideas + tasks (this project's intent ledger, wherever it lives) ───────
  // Two possible layouts on this machine: a self-contained `memory/intent/topics/**` (most
  // projects), or - for Praxis specifically - the shared global ledger under
  // `~/.claude/memory/intent/topics/praxis`. Aggregate both when present; walkMd dedupes
  // nothing across the two by design (they hold different files in practice).
  const intentDirs = [path.join(proj.memDir, "intent", "topics")];
  if (proj.slug === "C--Users-dev-Desktop-praxis") {
    intentDirs.push(path.join(USERPROFILE, ".claude", "memory", "intent", "topics", "praxis"));
  }
  const TASK_STATUS = [
    { re: /🚧|in[_ ]progress/i, status: "in progress" },
    { re: /🔜|future/i, status: "planned" },
  ];
  const slugTitle = (name) => titleCase(name).replace(/^Praxis /i, "");

  for (const intentDir of intentDirs) {
    for (const fp of walkMd(intentDir)) {
      const f = path.basename(fp);
      if (/^praxis-praxis-/.test(f)) continue; // dedup-prefixed duplicate
      const slug = f.replace(/\.md$/, "");
      const bareId = `idea:${slug}`;
      const id = proj.slug === "C--Users-dev-Desktop-praxis" ? bareId : `${proj.slug}:${bareId}`;
      let txt;
      try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
      const area = proj.forcedArea || areaOf(slug, txt.slice(0, 400));
      addNode(id, { label: slugTitle(slug), kind: "idea", type: "idea", area, slug, path: fp, openMode: openModeFor(fp), degree: 0, project: proj.slug });
      addEdge(ensureHub(area), id, "member");
      stat.ideas++;
      const hit = TASK_STATUS.find((s) => s.re.test(txt));
      if (hit) {
        const bareTid = `task:${slug}`;
        const tid = proj.slug === "C--Users-dev-Desktop-praxis" ? bareTid : `${proj.slug}:${bareTid}`;
        addNode(tid, {
          label: slugTitle(slug), kind: "task", type: "task", area, slug, path: fp, openMode: openModeFor(fp),
          description: "", meta: hit.status, live: hit.status === "in progress", degree: 0, project: proj.slug,
        });
        addEdge(ensureHub(area), tid, "member");
        addEdge(tid, id, "link"); // task realises the idea
        stat.tasks++;
      }
    }
  }

  // ── docs/*.md + README.md from the project's real repo checkout (read-only) ─────────
  if (proj.repoPath && fs.existsSync(proj.repoPath)) {
    const docCandidates = [];
    const readme = path.join(proj.repoPath, "README.md");
    if (fs.existsSync(readme)) docCandidates.push(readme);
    const docsDir = path.join(proj.repoPath, "docs");
    if (fs.existsSync(docsDir)) {
      try {
        for (const f of fs.readdirSync(docsDir)) {
          if (f.endsWith(".md")) docCandidates.push(path.join(docsDir, f));
        }
      } catch { /* unreadable docs dir - skip */ }
    }
    for (const fp of docCandidates) {
      const slug = path.basename(fp).replace(/\.md$/, "");
      const bareId = `doc:${slug}`;
      const id = proj.slug === "C--Users-dev-Desktop-praxis" ? bareId : `${proj.slug}:${bareId}`;
      if (nodes.has(id)) continue;
      let txt = "";
      try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
      const fm = readFrontmatter(txt);
      const area = proj.forcedArea || areaOf(slug, fm.description);
      addNode(id, {
        label: titleCase(slug), kind: "reference", type: "reference", area, slug, path: fp, openMode: openModeFor(fp),
        description: fm.description || "", degree: 0, project: proj.slug,
      });
      addEdge(ensureHub(area), id, "member");
      stat.docs++;
    }
  }

  if (stat.notes || stat.ideas || stat.tasks || stat.docs) perProjectStats.push(stat);
}

// ── resolve pending inverse deps (`blocks:`/`downstream:` frontmatter) - every note in
//    every project now has a node, so these forward references can be turned into real
//    `dep` edges. Deduped against edges already added (a note that both `depends:` on X
//    and is separately named in X's `blocks:` shouldn't get the edge twice). ────────────
{
  const existingDepPairs = new Set(
    edges.filter((e) => e.kind === "dep").map((e) => `${e.source}|${e.target}`),
  );
  for (const { source, target } of pendingInverseDeps) {
    const key = `${source}|${target}`;
    if (nodes.has(source) && nodes.has(target) && !existingDepPairs.has(key)) {
      existingDepPairs.add(key);
      addEdge(source, target, "dep");
    }
  }
}

// ── conversations (real Claude Code sessions - Praxis only, unchanged) ────────────────
function firstUserLine(fp) {
  let raw;
  try { raw = fs.readFileSync(fp, "utf8"); } catch { return null; }
  const lines = raw.split("\n");
  for (const l of lines) {
    if (!l) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== "user" || !o.message) continue;
    let c = o.message.content;
    if (Array.isArray(c)) { const t = c.find((x) => x && x.type === "text"); c = t ? t.text : ""; }
    if (typeof c !== "string") continue;
    c = c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (c.length > 4) return c;
  }
  return null;
}

if (fs.existsSync(PRAXIS_SESSIONS_DIR)) {
  const sessions = fs
    .readdirSync(PRAXIS_SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fp = path.join(PRAXIS_SESSIONS_DIR, f);
      // one stat per file, guarded: a locked/vanished session file must not abort the build
      try {
        const st = fs.statSync(fp);
        return { f, fp, mtime: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter((s) => s && s.size > 1500) // skip stubs + unreadable
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_CONVERSATIONS);

  for (const s of sessions) {
    const line = firstUserLine(s.fp);
    if (!line) continue;
    const id = `conv:${s.f.replace(/\.jsonl$/, "")}`;
    const date = new Date(s.mtime).toISOString().slice(0, 10);
    const label = clip(line.replace(/^praxis\s*[—-]\s*/i, ""), 52);
    const area = areaOf(line);
    addNode(id, {
      label,
      kind: "conversation",
      type: "conversation",
      area,
      description: clip(line, 220),
      meta: date,
      degree: 0,
      // the session transcript IS the conversation's real backing file - carry it so the
      // Inspector's "Open file" button works for conversations too instead of sitting
      // honestly-disabled (2026-07-10). Lives outside the memory vault → openMode "file".
      path: s.fp,
      openMode: "file",
    });
    addEdge(ensureHub(area), id, "member");
    // link to notes this session names by slug (cap so a long session doesn't dominate)
    const lower = line.toLowerCase();
    let linked = 0;
    for (const slug of noteSlugs) {
      if (linked >= 3) break;
      if (slug.length < 6) continue; // avoid weak/common slugs
      if (lower.includes(slug.toLowerCase())) { addEdge(id, slug, "link"); linked++; }
    }
  }
}

// ── agent run-notes (written by orchestrator.ts's ledger hook into the Praxis vault's
//    runs/ subfolder) - first-class vault nodes so agent work shows up in the galaxy. ────
const RUNS_DIR = path.join(PRAXIS_PROJECT_DIR, "memory", "runs");
if (fs.existsSync(RUNS_DIR)) {
  for (const f of fs.readdirSync(RUNS_DIR)) {
    if (!f.endsWith(".md")) continue;
    const fp = path.join(RUNS_DIR, f);
    let txt;
    try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
    const fm = readFrontmatter(txt);
    const slug = f.replace(/\.md$/, "");
    const id = `run:${slug}`;
    const label = clip(fm.name || fm.description || titleCase(slug), 52);
    const area = areaOf(fm.description, slug);
    addNode(id, {
      label, kind: "task", type: "task", area, slug, path: fp,
      description: fm.description || "", meta: "agent run", degree: 0, project: "C--Users-dev-Desktop-praxis",
    });
    addEdge(ensureHub(area), id, "member");
  }
}

// ── Sage research digests (written by research_watch.rs's write_research_note into the
//    Praxis vault's research/ subfolder) - first-class vault nodes, same shape as run-notes
//    above, so every extracted-ideas digest from the watch loop shows up in the galaxy too. ─
const RESEARCH_DIR = path.join(PRAXIS_PROJECT_DIR, "memory", "research");
if (fs.existsSync(RESEARCH_DIR)) {
  for (const f of fs.readdirSync(RESEARCH_DIR)) {
    if (!f.endsWith(".md")) continue;
    const fp = path.join(RESEARCH_DIR, f);
    let txt;
    try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
    const fm = readFrontmatter(txt);
    const slug = f.replace(/\.md$/, "");
    const id = `research:${slug}`;
    const type = noteKind(fm.type); // typically "reference" per write_research_note's frontmatter
    const label = clip(fm.name || fm.description || titleCase(slug), 52);
    // Sage's digests are about AI-workflow/tooling ideas (Example Creator et al.) - falls
    // through areaOf's own regex (skill/workflow/codex terms → "learnai"), same bucket as
    // Praxis's other Learning-AI-cluster artifacts (memprompt, offload, skills).
    const area = areaOf(fm.description, slug);
    addNode(id, {
      label, kind: type, type, area, slug, path: fp,
      description: fm.description || "", meta: "research digest", degree: 0, project: "C--Users-dev-Desktop-praxis",
    });
    addEdge(ensureHub(area), id, "member");
  }
}

const HERMES_MEMORIES_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(USERPROFILE, "AppData", "Local"),
  "hermes",
  "memories",
);
const HERMES_MEMORY_FILES = [
  { file: "MEMORY.md", id: "hermes:memory", label: "Hermes: Environment Notes" },
  { file: "USER.md", id: "hermes:user", label: "Hermes: Zach's Preferences" },
];
for (const { file, id, label } of HERMES_MEMORY_FILES) {
  const fp = path.join(HERMES_MEMORIES_DIR, file);
  if (!fs.existsSync(fp)) continue;
  let txt;
  try { txt = fs.readFileSync(fp, "utf8"); } catch { continue; }
  if (!txt.trim()) continue; // Hermes creates the file lazily but may leave it empty
  addNode(id, {
    label, kind: "note", type: "note", area: "praxis", slug: id, path: fp,
    openMode: "file", // lives outside the Obsidian vault - plain file open, not obsidian://
    description: clip(txt.trim(), 800), meta: "Hermes self-improvement", degree: 0,
    project: "hermes",
  });
  addEdge(ensureHub("praxis"), id, "member");
}

// ── resolve + degree ──────────────────────────────────────────────────────
const has = (id) => nodes.has(id);
let linkEdges = edges.filter((e) => e.kind === "link" && has(e.source) && has(e.target));
let memberEdges = edges.filter((e) => e.kind === "member");
// dep edges: hand-authored `depends:`/`blockedBy:`/`upstream:`/`blocks:`/`downstream:`
// frontmatter - directed, sparse, and the STRONGEST typed edges the galaxy animates
// (brighter dash-crawl + arrowhead - see galaxyEngine's dependency motion).
let depEdges = edges.filter((e) => e.kind === "dep" && has(e.source) && has(e.target));
// wlink edges (2026-07-05): directed, wikilink-derived dependency-shaped edges - a real
// already-authored `[[wikilink]]` in a note's body, surfaced as a lighter/quieter directed
// edge so the galaxy can show MANY more small always-on arrowheads without conflating them
// with hand-authored `dep` edges (see galaxyEngine's rendering for the visual distinction).
let wlinkEdges = edges.filter((e) => e.kind === "wlink" && has(e.source) && has(e.target));
for (const e of [...linkEdges, ...depEdges, ...wlinkEdges]) {
  const a = nodes.get(e.source);
  const b = nodes.get(e.target);
  a.degree++;
  b.degree++;
  // cross-area seam? tag it so the renderer draws a gradient link.
  if (a.area && b.area && a.area !== b.area) e.cross = true;
}
// orphan = a note/reference with no real links (only its area membership)
for (const n of nodes.values())
  if (n.kind === "note" || n.kind === "reference") n.orphan = n.degree === 0;

// ── soft cap by importance (2026-07-02 Scribe pass) ────────────────────────────────────
// Multi-root aggregation multiplies node count a lot (Catalyzed alone brings 267 notes +
// its own idea/task ledger). Keep the render sane: hubs always survive; anything with a
// real link (degree > 0) survives; beyond that, keep the newest per-area up to MIN_PER_AREA,
// then fill remaining budget by recency. Everything dropped is logged, never silent.
const allLeaf = [...nodes.values()].filter((n) => n.kind !== "hub");
if (allLeaf.length > MAX_NODES) {
  const mtimeOf = (n) => {
    if (!n.path) return 0;
    try { return fs.statSync(n.path).mtimeMs; } catch { return 0; }
  };
  const scored = allLeaf.map((n) => ({ n, linked: n.degree > 0, mtime: mtimeOf(n) }));
  const byArea = new Map();
  for (const s of scored) {
    if (!byArea.has(s.n.area)) byArea.set(s.n.area, []);
    byArea.get(s.n.area).push(s);
  }
  const keep = new Set();
  // 1) every linked node always survives
  for (const s of scored) if (s.linked) keep.add(s.n.id);
  // 2) per-area floor, newest-first
  for (const [, group] of byArea) {
    group.sort((a, b) => b.mtime - a.mtime);
    let kept = group.filter((s) => keep.has(s.n.id)).length;
    for (const s of group) {
      if (kept >= MIN_PER_AREA) break;
      if (!keep.has(s.n.id)) { keep.add(s.n.id); kept++; }
    }
  }
  // 3) fill remaining global budget by recency across everything not yet kept
  const remaining = scored.filter((s) => !keep.has(s.n.id)).sort((a, b) => b.mtime - a.mtime);
  let budget = MAX_NODES - keep.size;
  for (const s of remaining) {
    if (budget <= 0) break;
    keep.add(s.n.id);
    budget--;
  }
  // drop everything else, loudly
  for (const s of scored) {
    if (!keep.has(s.n.id)) {
      droppedLog.push({ id: s.n.id, area: s.n.area, kind: s.n.kind, project: s.n.project || "" });
      nodes.delete(s.n.id);
    }
  }
  linkEdges = linkEdges.filter((e) => has(e.source) && has(e.target));
  memberEdges = memberEdges.filter((e) => has(e.source) && has(e.target));
  depEdges = depEdges.filter((e) => has(e.source) && has(e.target));
  wlinkEdges = wlinkEdges.filter((e) => has(e.source) && has(e.target));
}

// Degenerate-output guard: the vault always has hundreds of real artifacts on this machine.
// If every memDir read failed (transient FS trouble), the node set degrades to hubs +
// conversations only - publishing that would replace a good graph with a near-empty one.
const vaultArtifacts = [...nodes.values()].filter(
  (n) => n.kind !== "hub" && n.kind !== "conversation",
).length;
if (vaultArtifacts === 0 && HAS_PREVIOUS_GRAPH) {
  console.error("[build-memory-graph] ABORT: 0 vault artifacts ingested (sessions-only result) — refusing to overwrite the previous graph");
  process.exit(1);
}

const out = {
  generatedFrom: { projectsRoot: PROJECTS_ROOT, sessions: PRAXIS_SESSIONS_DIR },
  areas: AREAS,
  nodes: [...nodes.values()],
  edges: [...memberEdges, ...linkEdges, ...depEdges, ...wlinkEdges],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
// Atomic publish: write a sibling tmp file, then rename over OUT. The galaxy window polls
// read_memory_graph on its own clock - a direct writeFileSync leaves a window where it
// reads a half-written file. On Windows, rename-over-open-file (a reader mid-poll, AV,
// OneDrive) throws EPERM - retry once, then abort WITHOUT publishing (old graph stays,
// the next 5-min poll self-heals).
const tmp = `${OUT}.${process.pid}.tmp`; // pid-unique: concurrent builders must not share a staging file
fs.writeFileSync(tmp, JSON.stringify(out));
try {
  fs.renameSync(tmp, OUT);
} catch (e) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  try {
    fs.renameSync(tmp, OUT);
  } catch (e2) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort orphan cleanup */ }
    console.error(`[build-memory-graph] ABORT: cannot replace ${OUT}: ${e2.message} — previous graph left in place`);
    process.exit(1);
  }
}

const byKind = {};
const byArea = {};
for (const n of nodes.values()) {
  byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  if (n.kind !== "hub") byArea[n.area] = (byArea[n.area] || 0) + 1;
}
const orphans = [...nodes.values()].filter((n) => n.orphan).length;
console.log(`memory-graph.json → ${out.nodes.length} nodes, ${out.edges.length} edges`);
console.log(`  real links: ${linkEdges.length} · dep edges (depends/blockedBy/upstream/blocks/downstream): ${depEdges.length} · wlink edges (wikilink-derived): ${wlinkEdges.length} · orphans: ${orphans}`);
console.log(`  by type:`, byKind);
console.log(`  by area:`, byArea);
console.log(`  projects aggregated: ${perProjectStats.length}/${projects.length}`);
for (const s of perProjectStats) {
  console.log(`    ${s.slug} [${s.area}] — notes:${s.notes} ideas:${s.ideas} tasks:${s.tasks} docs:${s.docs}`);
}
if (droppedLog.length) {
  console.log(`  soft-cap dropped ${droppedLog.length} node(s) beyond MAX_NODES=${MAX_NODES} (isolated, oldest-first):`);
  const dropByArea = {};
  for (const d of droppedLog) dropByArea[d.area] = (dropByArea[d.area] || 0) + 1;
  console.log(`    by area:`, dropByArea);
} else {
  console.log(`  soft-cap: no drops (${allLeaf.length} leaf nodes ≤ MAX_NODES=${MAX_NODES})`);
}
console.log(`  wrote ${OUT}`);
