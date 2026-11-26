/**
 * buildChain.ts - what turns ONE spoken build goal into a finished, visible result.
 *
 * Before this module, orchestrate() could not honor a single clause of that:
 *   - the planner got NO memory (ask()'s "shared memory" is live app state only);
 *   - nothing mapped Vega/Quill/Forge to codex/cursor/claude, or made sure each named
 *     agent actually got work;
 *   - inferRepo() read "Vega, Quill and Forge" as a Praxis hint, so a brand-new website
 *     would have been built INSIDE the Praxis checkout;
 *   - verification judged the agents' own claims, never the files on disk;
 *   - "open it in a browser and maximize it" had no executor at all.
 *
 * Everything decidable is a PURE function here (headless-tested in
 * scripts/test-orchestrator.cjs). The few Tauri seams (memory_recall,
 * workspace_prepare / _write_file / _manifest, desktop_open_url,
 * desktop_window_control) are passed in as an `invoke` so tests never need a runtime.
 */

import type { DriverTool } from "./drivers";
import { inferRepo } from "./parse";

// ── The team the owner names ──────────────────────────────────────────────────────

export interface TeamMember {
  tool: DriverTool;
  /** The fleet identity the owner says out loud. */
  name: "Forge" | "Vega" | "Quill";
  /** The product behind it (what the CLI is). */
  product: string;
  agentId: "a.forge" | "a.vega" | "a.quill";
}

export const TEAM: Record<DriverTool, TeamMember> = {
  claude: { tool: "claude", name: "Forge", product: "Claude Code", agentId: "a.forge" },
  codex: { tool: "codex", name: "Vega", product: "Codex", agentId: "a.vega" },
  cursor: { tool: "cursor", name: "Quill", product: "Cursor", agentId: "a.quill" },
};

const FLEET_NAME_RE: ReadonlyArray<[DriverTool, RegExp]> = [
  ["claude", /\bforge\b/i],
  ["codex", /\bvega\b/i],
  ["cursor", /\bquill\b/i],
];

/** Product names only count as a team pick after a delegation cue - "move the
 *  cursor" or "ask claude.ai" must not enlist an agent. */
const PRODUCT_CUE_RE =
  /\b(?:using|use|with|via|through|have|get|let|ask|by|team of|and)\b[^.;!?]{0,60}?\b(claude(?: code)?|codex|cursor)\b/gi;

/**
 * The coding agents a goal NAMES, in the order they first appear. Fleet names
 * (Forge/Vega/Quill) count anywhere; product names (Claude/Codex/Cursor) only after a
 * delegation cue ("using Vega, Quill and Claude").
 */
export function namedTeam(goal: string): DriverTool[] {
  const found: Array<{ tool: DriverTool; at: number }> = [];
  const note = (tool: DriverTool, at: number) => {
    const prev = found.find((f) => f.tool === tool);
    if (!prev) found.push({ tool, at });
    else if (at < prev.at) prev.at = at;
  };
  for (const [tool, re] of FLEET_NAME_RE) {
    const m = re.exec(goal);
    if (m) note(tool, m.index);
  }
  for (const m of goal.matchAll(PRODUCT_CUE_RE)) {
    const word = m[1].toLowerCase();
    const tool: DriverTool = word.startsWith("claude") ? "claude" : word === "codex" ? "codex" : "cursor";
    note(tool, (m.index ?? 0) + m[0].toLowerCase().lastIndexOf(word));
  }
  const delegated = /\bdelegate\s+(?:to\s+)?([^.;!?]+)/i.exec(goal);
  if (delegated) for (const m of delegated[1].matchAll(/\b(claude|codex|cursor)\b/gi)) {
    note(m[1].toLowerCase() as DriverTool, delegated.index + delegated[0].indexOf(delegated[1]) + (m.index ?? 0));
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.tool);
}

/** Who stands in for a benched agent, best first. Forge covers polish/review, Vega the
 *  heavy build, Quill fast edits - so each falls back to the closest match. */
const STAND_IN_ORDER: Record<DriverTool, DriverTool[]> = {
  cursor: ["claude", "codex"],
  codex: ["claude", "cursor"],
  claude: ["codex", "cursor"],
};

export interface TeamAdjustment {
  /** The agents who will actually work, in the order the owner named them. */
  team: DriverTool[];
  /** Named agents that are not working this run, and who took their share. */
  benched: Array<{ tool: DriverTool; standIn: DriverTool | null; why: string }>;
  /** One plain sentence for the run summary and Atlas's thread ("" when nobody is benched). */
  note: string;
}

/**
 * `paused` carries the reason a rail can't run even though its breaker is on.
 */
export function availableTeam(
  named: DriverTool[],
  isOn: (tool: DriverTool) => boolean,
  paused: Partial<Record<DriverTool, string>> = {},
): TeamAdjustment {
  const usable = (t: DriverTool) => isOn(t) && !paused[t];
  const team: DriverTool[] = [];
  const benched: TeamAdjustment["benched"] = [];
  for (const t of named) {
    if (usable(t)) {
      if (!team.includes(t)) team.push(t);
      continue;
    }
    const standIn = STAND_IN_ORDER[t].find(usable) ?? null;
    benched.push({ tool: t, standIn, why: paused[t] ?? `${TEAM[t].name} is switched off right now` });
    if (standIn && !team.includes(standIn)) team.push(standIn);
  }
  const note = benched
    .map((b) => {
      const reason = b.why.replace(/\.$/, "");
      const cover = b.standIn ? ` ${TEAM[b.standIn].name} took ${TEAM[b.tool].name}'s part.` : " Nobody was available to take its part.";
      // A reason that already says the agent can't run reads as is: "..., so Forge can't run,
      // so Forge sat this one out" (live 2026-10-04) said it twice.
      return /sat this one out|can'?t (?:run|work)/i.test(reason) ? `${reason}.${cover}` : `${reason}, so ${TEAM[b.tool].name} sat this one out.${cover}`;
    })
    .join(" ");
  return { team, benched, note };
}

/** The model a stand-in runs when it takes over another agent's step. */
export function standInModel(tool: DriverTool): string {
  return tool === "claude" ? "claude-sonnet-5-5" : tool === "codex" ? "gpt-6-astra" : QUILL_DEFAULT_MODEL;
}

/** Remove team names (and the "using X, Y and Z" phrase around them) so repo
 *  inference and slugs see only what is being built. */
export function stripTeamNames(goal: string): string {
  return goal
    .replace(/\b(?:through|via|using)\s+Praxis\b|\bhave\s+Praxis\s+delegate\b|\bin\s+the\s+Praxis\s+app\b/gi, " ")
    .replace(
      /\b(?:using|with|via|through|by)\s+(?:(?:forge|vega|quill|claude(?: code)?|codex|cursor)\s*(?:,|and|&|\+)?\s*)+/gi,
      " ",
    )
    .replace(/\b(?:forge|vega|quill)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ── New project vs existing repo ─────────────────────────────────────────────

// Up to three describing words between the article and the thing ("a tiny one-page
// website", "a quick dark-mode dashboard"). It was a fixed adjective list, so "Make a
// tiny one-page website" (2026-10-04) was not a new project at all and the build ran in
// the Praxis repo. Glue words still end the description, so "make a change to the deck
// page" never reads as a new page.
const DESCRIPTOR =
  "(?:(?!(?:to|for|of|the|in|on|at|that|which|with|from|about|into|and|or|it|this)\\b)[a-z][a-z0-9'’-]*\\s+){0,3}";
const ARTIFACT =
  DESCRIPTOR +
  "(web ?site|site|web ?page|landing page|home ?page|portfolio|web app|app|game|dashboard|blog|resume|cv|page|prototype|demo|tool|script|program|cli|extension|library|package)";

const NEW_PROJECT_RE = new RegExp(
  `\\b(?:create|build|make|write|develop|generate|design|spin up|scaffold|put together|code up|whip up)\\s+(?:me\\s+|us\\s+)?(?:a|an|my|a new|some|one)\\s+(${ARTIFACT})\\b`,
  "i",
);

/**
 * A goal that creates a NEW standalone thing ("create a personal website") rather
 * than changing an existing repo ("add a page to the flight deck"). Repo words win:
 * if the goal - with team names removed - still points at a known repo, it is not new.
 */
export function isNewProjectGoal(goal: string): boolean {
  // "…in a new folder" says it outright. Live 2026-10-10, "Write a small Python
  // command-line tool … in a new folder" was not a new project ("write" wasn't a build
  // verb), so the brain made its own folder on the owner's Desktop instead of praxis-builds.
  if (!NEW_PROJECT_RE.test(goal) && !NEW_FOLDER_RE.test(goal)) return false;
  return inferRepo(stripDeliverableContent(stripTeamNames(goal))) === undefined;
}

/** "in a new / fresh / separate folder (or project)" - a new standalone build. */
const NEW_FOLDER_RE = /\b(?:in|into)\s+(?:a\s+)?(?:new|fresh|separate|its own)\s+(?:folder|directory|project|repo(?:sitory)?)\b/i;

/**
 * Drop what the deliverable should SAY or be ABOUT before looking for a repo name.
 * "a website that says hello from Praxis" is a new site that mentions Praxis, not work
 * in the Praxis repo (2026-10-04: exactly that sentence planned Workspace = the Praxis
 * repo). Quoted text, "that says/shows/displays …", "saying …" and "about …" are content.
 */
export function stripDeliverableContent(goal: string): string {
  return goal
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .replace(/\b(?:that|which)\s+(?:just\s+|only\s+|simply\s+)?(?:says?|reads?|shows?|displays?|prints?|greets?)\b[^.!?\n]*/gi, " ")
    .replace(/\b(?:saying|showing|displaying|reading)\b[^.!?\n]*/gi, " ")
    .replace(/\babout\s+[^.!?\n]*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const WEB_ARTIFACT_RE = /\b(?:web ?site|site|web ?page|landing page|home ?page|portfolio|web app|blog|resume|cv|page)\b/i;

/** Does the finished thing live in a browser (so an HTML entry page must exist)? */
export function isWebDeliverable(goal: string, delivery: DeliveryIntent | null): boolean {
  const m = NEW_PROJECT_RE.exec(goal);
  return Boolean(delivery?.open) || WEB_ARTIFACT_RE.test(m?.[1] ?? "");
}

/** The owner explicitly wants a NEW build rather than to continue an unfinished one. */
export function wantsFreshBuild(goal: string): boolean {
  return /\b(?:another|from scratch|start (?:it )?over|brand[- ]new|a second|fresh one|new version)\b/i.test(goal);
}

/** Written into the workspace when a run is VERIFIED done; its absence marks an
 *  unfinished build a same-day re-ask resumes (workspace.rs DONE_MARKER). */
export const DONE_MARKER = ".praxis-done";

/** Folder-safe slug for the thing being built: "personal website" → "personal-website". */
export function projectSlug(goal: string): string {
  const m = NEW_PROJECT_RE.exec(goal);
  const phrase = m?.[1] ?? stripTeamNames(goal).split(/\s+/).slice(0, 4).join(" ");
  const slug = phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "build";
}

/** Repo folder for an EXISTING-repo goal, ignoring team names ("using Forge" is not
 *  a Praxis hint). Undefined when the goal names no repo. */
export function repoFolderFor(goal: string): { id: string; folder: string; hint: string } | undefined {
  return inferRepo(stripTeamNames(goal));
}

// ── Delivery: "then open it … and maximize it" ───────────────────────────────

export interface DeliveryIntent {
  open: boolean;
  maximize: boolean;
}

const OPEN_RESULT_RE =
  /\b(?:open|show|launch|load|pull up|bring up|display|preview|view)\b[^.;!?]{0,24}?\b(?:it|that|this|the (?:site|website|web ?page|page|result|app|game|build|thing))\b/i;
const MAXIMIZE_RE = /\b(?:maximi[sz]e|full[- ]?screen|fill (?:my|the) (?:whole )?screen)\b/i;

/** What the owner wants done with the finished result, or null when he didn't say. */
export function parseDelivery(goal: string): DeliveryIntent | null {
  const maximize = MAXIMIZE_RE.test(goal);
  const open = maximize || OPEN_RESULT_RE.test(goal);
  return open ? { open, maximize } : null;
}

// ── Memory (the Memory Galaxy, via Rust memory_recall) ───────────────────────

/** One hit from `memory_recall` (memory_graph.rs) - snake_case as serialized. */
export interface MemoryHit {
  path: string;
  label: string;
  project: string;
  kind: string;
  memory_type?: string | null;
  description?: string | null;
  excerpt: string;
  galaxy_id?: string | null;
  score: number;
}

const PROFILE_RE =
  /\b(?:personal|about me|about zach|my (?:own )?(?:site|website|portfolio|resume|cv|bio|page|story)|you (?:have|know|remember) (?:my )?(?:memory|me)|from (?:my |your )?memory|portfolio|resume|biography|bio)\b/i;

/** Should recall lead with who the owner IS (user-type memories)? */
export function wantsProfile(goal: string): boolean {
  return PROFILE_RE.test(goal);
}

/** The words recall should search on: the build subject, not the delivery clause,
 *  the team names, or the conversational scaffolding around them. */
export function memoryQuery(goal: string): string {
  let q = stripTeamNames(goal)
    .replace(/\b(?:then|and)\s+(?:open|show|launch|load|pull up|bring up|display|preview|view)\b[\s\S]*$/i, " ")
    .replace(/\byou (?:choose|pick|decide)(?: the)? content\b/gi, " ")
    .replace(/\byou (?:have|know|remember) (?:my )?(?:memory|me)\b/gi, " ")
    .replace(/[—–]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (wantsProfile(goal)) q = `${q} projects interests skills studies what I build`;
  return q.slice(0, 300);
}

/** Compact memory block for the PLAN prompt (bounded - the planner needs the gist,
 *  the brief file carries the full excerpts). */
export function formatMemoryForPrompt(hits: MemoryHit[], budgetChars = 5000): string {
  if (!hits.length) return "";
  const lines: string[] = [
    `Memory Praxis recalled from the Memory Galaxy (${hits.length} real notes — ground choices in these, never invent facts about Zach):`,
  ];
  let used = lines[0].length;
  for (const h of hits) {
    const head = `- [${h.memory_type ?? h.kind}] ${h.label}${h.description ? ` — ${h.description}` : ""}`;
    const body = h.excerpt ? `  ${h.excerpt.slice(0, 360)}` : "";
    const chunk = body ? `${head}\n${body}` : head;
    if (used + chunk.length > budgetChars) break;
    lines.push(chunk);
    used += chunk.length;
  }
  return lines.join("\n");
}

// ── The brief every agent reads from disk ────────────────────────────────────

export interface BriefInput {
  goal: string;
  team: DriverTool[];
  workspace: string;
  hits: MemoryHit[];
  delivery: DeliveryIntent | null;
}

export const BRIEF_FILE = "PRAXIS-BRIEF.md";

/**
 * Written into the workspace so every agent reads the same brief instead of each getting a
 * paraphrase in a 30k-char CLI argument.
 */
export function formatBrief(b: BriefInput): string {
  const team = (b.team.length ? b.team : (["claude", "codex", "cursor"] as DriverTool[]))
    .map((t) => `${TEAM[t].name} (${TEAM[t].product})`)
    .join(", ");
  const out: string[] = [
    "# Praxis build brief",
    "",
    "## Goal (Zach's words, verbatim)",
    `> ${b.goal.trim()}`,
    "",
    "## Team",
    `${team}. Praxis orchestrates: it plans, hands each agent its part, checks the files on disk after every step, re-prompts with feedback when a part falls short, and verifies the whole before calling it done.`,
    "",
    "## Workspace",
    `\`${b.workspace}\` — every file lives here. Nothing outside it.`,
    "",
    "## Quality bar",
    "- A static site: HTML + CSS + vanilla JS. No build step, no framework install, no external paid services, no analytics or tracking.",
    "- It must look premium and human-made: a deliberate type scale, a restrained palette, real hierarchy and rhythm, tasteful motion that respects `prefers-reduced-motion`. Never a generic AI template (no stock gradient hero + three identical cards).",
    "- Responsive from 360px to 1920px wide. Accessible: semantic landmarks, one h1, alt text, visible focus states, AA contrast.",
    "- `index.html` at the workspace root is the entry point, with a real `<title>`.",
    "- Content is about Zach and grounded ONLY in the memory below. No invented jobs, awards, dates, employers or quotes. No lorem ipsum, no placeholders.",
    "- Privacy: nothing that doesn't belong on a public personal site — no credentials, API keys, account or billing details, finances, health, internal file paths, or private details about other people.",
    "",
  ];
  if (b.delivery?.open) {
    out.push(
      "## Delivery",
      `Praxis itself opens the finished \`index.html\` in the browser${b.delivery.maximize ? " and maximizes the window" : ""} after verification. Agents must NOT open a browser or any window.`,
      "",
    );
  }
  out.push("## Memory Praxis recalled (from the Memory Galaxy)");
  if (!b.hits.length) {
    out.push("", "_Recall returned nothing. Keep claims minimal and general rather than inventing any._");
  }
  for (const h of b.hits) {
    out.push(
      "",
      `### ${h.label}`,
      `Source: \`${h.path}\` · project \`${h.project}\` · ${h.memory_type ?? h.kind}`,
    );
    if (h.description) out.push(`_${h.description}_`);
    if (h.excerpt) out.push("", h.excerpt);
  }
  out.push("");
  return out.join("\n");
}

// ── Model routing per subtask (verified live rosters, 2026-09-16) ────────────

/**
 * Cursor models Quill may run - ONLY Cursor's "Cursor Models" pool. `-fast` variants cost 2-6x
 * per token. Rust enforces the same list for every caller (hermes_bridge::quill_model).
 */
// Grok 4.7 joined that pool (Cursor staff, 2026-09-21); its ids dropped the "cursor-" prefix
// Grok 4.6 carried.
const CURSOR_MODEL_RE = /^(?:composer-2\.5|cursor-grok-4\.6-(?:low|medium|high|xhigh)|grok-4\.7-(?:low|medium|high|xhigh))$/;

/** What Quill runs when a plan names nothing usable: Grok 4.6, never the CLI default. */
export const QUILL_DEFAULT_MODEL = "grok-4.7-high";

/** Keep a plan's model pin only when that rail can actually run it. Claude pins are
 *  sanitized later by drivers.sanitizeClaudeModel. */
export function sanitizeStepModel(tool: DriverTool, model: string | undefined): string | undefined {
  const m = model?.trim();
  if (!m) return undefined;
  // An API-pool or unknown Cursor id becomes Grok 4.6 rather than "whatever the CLI defaults to".
  if (tool === "cursor") return CURSOR_MODEL_RE.test(m) ? m : QUILL_DEFAULT_MODEL;
  if (tool === "codex") return /^(?:gpt-[a-z0-9][\w.-]*|o\d[\w.-]*)$/i.test(m) ? m : undefined;
  return m;
}

/** Per-subtask model guidance the planner sees (the owner's routing rule). */
export const TEAM_MODEL_GUIDE = [
  "Roles (Zach, 2026-10-10): YOU — Praxis's brain — are the orchestrator. You plan, review every result, give feedback and decide; the agents EXECUTE. Pick the most capable model FOR THAT SUBTASK and spread the work so no subscription runs dry while another sits idle (see Capacity).",
  '- Vega = "codex" (Codex): execution — the hardest implementation, integration, debugging and tests. model "gpt-6-astra"; "gpt-5.6-terra" for routine work when Codex\'s 5-hour window is running low.',
  '- Quill = "cursor" (Cursor — its Cursor Models pool, never the API pool): execution — fast, efficient implementation, front-end/UI, refactors, responsive/accessibility and polish passes with model "grok-4.7-high" ("grok-4.7-xhigh" for a genuinely hard Quill step); purely mechanical edits (renames, copy swaps, meta tags, small CSS fixes) with "composer-2.5". Never "auto", a "-fast" variant, or a Claude/GPT/Gemini model through Cursor. Give Quill a SCOPED step that names the files or sections.',
  '- Forge = "claude" (Claude Code): only work that needs top-tier judgment — architecture, tricky reasoning, content and information architecture, a final quality review. model "claude-sonnet-5-5"; "claude-opus-5-5" for one genuinely critical step. Claude\'s 5-hour window is SHARED with your own thinking and Zach\'s Claude sessions, so give Forge the fewest, highest-value steps.',
].join("\n");

// ── Default team plan + coverage enforcement ─────────────────────────────────

export interface TeamStep {
  tool: DriverTool;
  model?: string;
  prompt: string;
  why: string;
  cwd?: string;
  /** Explicit artifacts this phase owns. Only these filenames may be checked
   * before the whole-build gate; prose is never guessed into a filename. */
  expectedFiles?: string[];
}

/* A deliberately tiny proof page is valid only when the owner explicitly asked for * its tiny content,
   e.g. "a one-page site that just says hello". */
export function isMinimalWebProofGoal(goal: string): boolean {
  return /\b(?:just|only|simply)\s+(?:say|says|display|show)\s+(?:the word\s+)?["']?hello\b/i.test(goal)
    || /\bhello world\b/i.test(goal);
}

/** The canonical division of labor for a new site/app when the planner is
 *  unavailable, or the source of a missing member's step when it skipped one. */
export function defaultTeamStep(tool: DriverTool, phase: "content" | "build" | "polish" | "review"): TeamStep {
  switch (phase) {
    case "content":
      return {
        tool,
        model: tool === "claude" ? "claude-sonnet-5-5" : undefined,
        why: `${TEAM[tool].name} shapes the content from Zach's real memory`,
        prompt:
          `Write CONTENT.md: the site's structure (sections in order) and final, polished copy for every section, grounded ONLY in the memory in ${BRIEF_FILE}. ` +
          "Name the voice (confident, specific, plain — no hype words), pick the 3–5 most compelling real projects and say concretely what each does and why it matters, and propose a visual direction (type pairing, palette, one signature layout idea) that fits Zach. No placeholders.",
        expectedFiles: ["CONTENT.md"],
      };
    case "build":
      return {
        tool,
        model: tool === "codex" ? "gpt-6-astra" : tool === "claude" ? "claude-sonnet-5-5" : QUILL_DEFAULT_MODEL,
        why: `${TEAM[tool].name} builds the site`,
        prompt:
          `Build the site from ${BRIEF_FILE} and CONTENT.md (if CONTENT.md is missing, write the copy yourself from the brief's memory first): index.html + styles.css + script.js at the workspace root, ` +
          "using the exact copy and visual direction. Craft it like a senior product designer: a real type scale, spacing rhythm, a restrained palette with CSS custom properties, a strong hero, project sections with genuine hierarchy, subtle motion that honors prefers-reduced-motion, and a footer. Fully responsive and accessible.",
        expectedFiles: ["index.html", "styles.css", "script.js"],
      };
    case "polish":
      return {
        tool,
        model: tool === "cursor" ? QUILL_DEFAULT_MODEL : tool === "claude" ? "claude-sonnet-5-5" : "gpt-6-astra",
        why: `${TEAM[tool].name} polishes and hardens it`,
        // Named sections, in order, each finished before the next. Live 2026-09-17 the
        // open-ended "polish everything" step came back three times with a different half
        // done ("only hero/nav"; then "only cards and education") and was rejected at 862 s.
        prompt:
          "Polish the existing site section by section, finishing each before starting the next: (1) header, navigation and hero; (2) every project / work card; (3) education, about and footer. In each: layout at 360px, 768px and 1440px widths, visible focus rings, AA contrast, no placeholder text, interactions that feel intentional. Then one site-wide pass: one h1, semantic landmarks, alt text, smooth in-page navigation, dead code removed. Edit the files directly — do not rebuild from scratch.",
      };
    case "review":
      return {
        tool,
        model: tool === "claude" ? "claude-sonnet-5-5" : tool === "codex" ? "gpt-6-astra" : QUILL_DEFAULT_MODEL,
        why: `${TEAM[tool].name} is the final quality gate`,
        prompt:
          `Final quality gate. Review the whole site against ${BRIEF_FILE}: every fact traceable to the memory, no invented claims, no placeholders, premium human-made design, responsive, accessible, no broken links or console errors. ` +
          "FIX every defect you find directly in the files, then write a SHORT REVIEW.md (under 30 lines): what you fixed, and anything genuinely still weak. No verification essays — Praxis runs the page in a real browser itself.",
        expectedFiles: ["REVIEW.md"],
      };
  }
}

/** Default phases for a team, in order: content → build → polish → review. */
export function defaultTeamPlan(team: DriverTool[]): TeamStep[] {
  const members: DriverTool[] = team.length ? team : ["claude", "codex", "cursor"];
  const has = (t: DriverTool) => members.includes(t);
  const steps: TeamStep[] = [];
  const contentBy: DriverTool = has("claude") ? "claude" : members[0];
  const buildBy: DriverTool = has("codex") ? "codex" : has("cursor") ? "cursor" : members[0];
  const polishBy: DriverTool | null = has("cursor") && buildBy !== "cursor" ? "cursor" : null;
  const reviewBy: DriverTool | null = has("claude") ? "claude" : null;
  if (contentBy !== buildBy) steps.push(defaultTeamStep(contentBy, "content"));
  steps.push(defaultTeamStep(buildBy, "build"));
  if (polishBy) steps.push(defaultTeamStep(polishBy, "polish"));
  if (reviewBy) steps.push(defaultTeamStep(reviewBy, "review"));
  // Anyone named but still unused gets the polish slot (a team of one never repeats).
  for (const t of members) {
    if (!steps.some((s) => s.tool === t)) steps.splice(Math.max(1, steps.length - 1), 0, defaultTeamStep(t, "polish"));
  }
  return steps;
}

/**
 * The fallback plan for CONTINUING an unfinished build (the planner was unavailable):
 * review what exists, fix it, polish it - never redo content or rebuild from scratch.
 */
export function resumeTeamPlan(team: DriverTool[]): TeamStep[] {
  const members: DriverTool[] = team.length ? team : ["claude", "codex", "cursor"];
  const steps: TeamStep[] = [];
  const reviewer: DriverTool = members.includes("claude") ? "claude" : members[0];
  steps.push({
    ...defaultTeamStep(reviewer, "review"),
    prompt:
      `This workspace holds an UNFINISHED build from an earlier run. Review everything that exists against ${BRIEF_FILE} and any CONTENT.md / SITE-PLAN.md, FIX the defects you can directly, and write REVIEW.md listing what is still missing or wrong, most important first. Do not start over.`,
    why: `${TEAM[reviewer].name} reviews the unfinished build`,
  });
  const fixer: DriverTool | undefined = members.find((t) => t === "codex") ?? members.find((t) => t !== reviewer);
  if (fixer) {
    steps.push({
      ...defaultTeamStep(fixer, "build"),
      prompt: "Finish the existing site: complete everything REVIEW.md lists as missing or wrong, editing the existing files. Do not rebuild from scratch.",
      why: `${TEAM[fixer].name} finishes what the review found`,
    });
  }
  for (const t of members) {
    if (!steps.some((s) => s.tool === t)) steps.push(defaultTeamStep(t, "polish"));
  }
  return steps;
}

/**
 * Enforce the owner's instruction in CODE, not just in the prompt: every agent he named
 * gets at least one step. A missing member is inserted with its canonical phase
 * (Forge → review at the end, Vega → build, Quill → polish before the review).
 * Never exceeds 5 steps; never removes the planner's own steps.
 */
export function ensureTeamCoverage<S extends TeamStep>(steps: S[], team: DriverTool[]): Array<S | TeamStep> {
  const out: Array<S | TeamStep> = [...steps];
  for (const tool of team) {
    if (out.some((s) => s.tool === tool)) continue;
    const reviewAt = out.findIndex((s) => s.tool === "claude" && /\breview|quality gate\b/i.test(`${s.why} ${s.prompt}`));
    if (tool === "claude") out.push(defaultTeamStep("claude", "review"));
    else if (tool === "codex") out.splice(Math.min(1, out.length), 0, defaultTeamStep("codex", "build"));
    else out.splice(reviewAt >= 0 ? reviewAt : out.length, 0, defaultTeamStep("cursor", "polish"));
  }
  if (out.length <= 5) return out;
  // Over budget: keep the first step of each named member, then fill in plan order.
  const keep = new Set<number>();
  for (const tool of team) {
    const i = out.findIndex((s) => s.tool === tool);
    if (i >= 0) keep.add(i);
  }
  for (let i = 0; i < out.length && keep.size < 5; i++) keep.add(i);
  return out.filter((_, i) => keep.has(i));
}

/**
 * The one delivery constraint no plan step may override for a web build: Praxis opens
 * index.html straight from disk. Live 2026-09-16 the planner asked Vega for
 * Vite/React/TypeScript and Vega decided that "supersedes the brief" - a framework
 * shell renders a blank page from file://, so the finished site could never be shown.
 */
export const STATIC_SITE_RULE =
  "NON-NEGOTIABLE, overrides any instruction above: this is a static site that Praxis opens straight from disk (file://). Ship index.html + styles.css + script.js at the workspace root — no framework, no bundler, no npm install, no build step, only relative asset paths. If a teammate started a framework build, convert it to static files instead of extending it.";

export const HEADLESS_QA_RULE = "Verify headlessly only (Playwright headless: true). Do NOT open a browser or any visible app window for QA. Never leave servers, file watchers or background processes running; if a test needs a server, stop it in a finally block before replying. Praxis opens the verified preview once, after completion, when Zach asks.";

/** The words each team member actually receives for a new-project step. */
export function teamStepPrompt(
  step: TeamStep,
  workspace: string,
  delivery: DeliveryIntent | null,
  webDeliverable = true,
): string {
  const me = TEAM[step.tool];
  return [
    `You are ${me.name} (${me.product}) on Praxis's build team — Forge = Claude Code, Vega = Codex, Quill = Cursor — working for Zach.`,
    `Workspace: ${workspace}`,
    "Work ONLY inside that folder.",
    HEADLESS_QA_RULE,
    `Read ${BRIEF_FILE} in the workspace first: the goal in Zach's words, the quality bar, and the real memory Praxis pulled about him (with source files). Read any CONTENT.md / REVIEW.md a teammate already wrote.`,
    "",
    `Your part: ${step.prompt}`,
    "",
    ...(webDeliverable ? [STATIC_SITE_RULE, ""] : []),
    delivery?.open
      ? "Do NOT open a browser or any window, and NEVER start a server, file watcher or any other long-running or background process — it keeps your run from ever finishing (live 2026-09-16 Quill hit the 30-minute cap twice that way). Praxis opens and maximizes the finished site itself after it verifies the files."
      : "Do not open windows or browsers.",
    "Praxis stops every step at 30 minutes, and live 2026-09-17 a polish step spent all 30 on one-byte CSS tweaks and never wrote its notes. Do the changes that matter most first, keep any notes file short, and aim to reply within about 20 minutes.",
    "Finish your whole part yourself — make reasonable calls rather than asking; only something truly impossible without Zach (a password, a payment, a choice only he can make) is worth raising.",
    "Reply in at most five short lines: the files you changed, what you did, and anything genuinely left undone.",
  ].join("\n");
}

// ── Files on disk (Rust workspace_manifest) ──────────────────────────────────

export interface WorkspaceManifest {
  root: string;
  files: Array<{ rel: string; bytes: number }>;
  total_bytes: number;
  entry: { rel: string; abs: string; bytes: number; title?: string | null; head: string } | null;
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** One paragraph of ground truth about the workspace, for supervisor + verify prompts. */
export function manifestSummary(m: WorkspaceManifest | null): string {
  if (!m) return "Praxis file check: workspace unreadable.";
  if (!m.files.length) return `Praxis file check: the workspace ${m.root} is EMPTY — no files were written.`;
  const listed = m.files
    .slice(0, 24)
    .map((f) => `${f.rel} (${kb(f.bytes)})`)
    .join(", ");
  const more = m.files.length > 24 ? `, +${m.files.length - 24} more` : "";
  const entry = m.entry
    ? `Entry ${m.entry.rel}: ${kb(m.entry.bytes)}, title ${m.entry.title ? `"${m.entry.title}"` : "MISSING"}.`
    : "No HTML entry point found.";
  return `Praxis file check (${m.files.length} files, ${kb(m.total_bytes)}): ${listed}${more}. ${entry}`;
}

/**
 * A corrective step that only asks to SHOW the result (open a browser, start a
 * server, maximize a window) - the delivery Praxis performs itself after done. A
 * verdict whose every remaining step is delivery-only is a done build.
 */
export function isDeliveryOnlyStep(prompt: string): boolean {
  // Delivery means a browser, a server or the window size - not any step that happens
  // to say "show" or "display" ("make the hero show real projects" is file work, and
  // reading it as delivery would call an unfinished build done).
  const delivery =
    /\b(?:browser|edge|chrome|firefox|localhost|maximi[sz]e[sd]?|full[- ]?screen|(?:http|local|dev|web|static|persistent) server|serve (?:it|the (?:site|page|files|website)))\b/i.test(prompt);
  const fileWork =
    /\b(?:fix|edit|update|add|remove|delete|improve|review|rewrite|write|refactor|test|build|implement|polish|restyle|replace|correct|complete|finish|make|create|design|change|adjust|tweak|style|restructure|content|copy|section|layout|hero|nav|footer|typography|contrast|responsive|animation|image|font|colou?r|spacing)\b/i.test(prompt);
  return delivery && !fileWork;
}

/** Did a pass change anything on disk? Agents that time out or hit a usage limit
 *  can still leave real work behind - live 2026-09-16 every step "failed" while a
 *  65 KB site sat in the workspace, and the loop stopped without ever verifying it. */
export function manifestChanged(before: WorkspaceManifest | null, after: WorkspaceManifest | null): boolean {
  if (!after || !after.files.length) return false;
  if (!before) return true;
  const was = new Map(before.files.map((f) => [f.rel, f.bytes]));
  return after.files.some((f) => was.get(f.rel) !== f.bytes) || after.files.length !== before.files.length;
}

/**
 * The CODE gate a website build must clear before the brain may call it done: a real
 * entry page exists, has substance and a title, and carries no placeholder text.
 */
export function deliverableGate(
  m: WorkspaceManifest | null,
  opts: { allowMinimal?: boolean } = {},
): { ok: boolean; reason: string } {
  if (!m) return { ok: false, reason: "the workspace could not be read" };
  const e = m.entry;
  if (!e) return { ok: false, reason: "no index.html (or any HTML entry page) exists in the workspace" };
  // A framework shell renders a blank page from disk: an empty mount node plus a
  // module entry, or root-absolute asset paths that file:// resolves to C:\.
  if (/<div[^>]+id=["'](?:root|app)["'][^>]*>\s*<\/div>/i.test(e.head) && /type=["']module["']/i.test(e.head)) {
    return { ok: false, reason: `${e.rel} is a framework shell (empty mount node + module script) that renders blank when opened from disk — ship static HTML` };
  }
  if (/(?:src|href)=["']\/(?!\/)[^"']+/i.test(e.head)) {
    return { ok: false, reason: `${e.rel} uses root-absolute asset paths ("/…") that break when opened from disk — use relative paths` };
  }
  if (!e.title) return { ok: false, reason: `${e.rel} has no <title>` };
  if (/lorem ipsum|\bplaceholder\b|\bTODO\b|your name here/i.test(e.head)) {
    return { ok: false, reason: `${e.rel} still contains placeholder text` };
  }
  if (e.bytes < 1500) {
    // Byte count is a useful normal-site quality floor, but it is a bad proxy
    // for an explicitly requested hello-world proof. Admit only a complete,
    // static document with visible body text - not a shell or an empty stub.
    const complete = /<!doctype\s+html/i.test(e.head)
      && /<html(?:\s|>)/i.test(e.head)
      && /<head(?:\s|>)/i.test(e.head)
      && /<body(?:\s|>)/i.test(e.head)
      && /<\/body>/i.test(e.head)
      && /<\/html>/i.test(e.head);
    const visible = (e.head.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!opts.allowMinimal || !complete || !visible) {
      return { ok: false, reason: `${e.rel} is only ${e.bytes} bytes — a normal site needs substantive content${opts.allowMinimal ? ", and a tiny proof must still be a complete static HTML document with visible body text" : ""}` };
    }
  }
  return { ok: true, reason: `${e.rel} is a real page titled "${e.title}"` };
}

// ── Delivery executor ────────────────────────────────────────────────────────

export type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

export interface DeliveryResult {
  opened: boolean;
  maximized: boolean;
  message: string;
}

/** A title fragment distinctive enough to find the browser window by, and short
 *  enough to survive the browser's own " - Profile - Microsoft Edge" suffix. */
export function windowNeedle(entry: NonNullable<WorkspaceManifest["entry"]>): string {
  const title = (entry.title ?? "").replace(/\s+/g, " ").trim();
  if (title) return title.slice(0, 48).trim();
  return entry.rel.split("/").pop() ?? entry.rel;
}

/**
 * Polls because the browser needs a moment to show the tab.
 */
export async function deliverResult(
  entry: NonNullable<WorkspaceManifest["entry"]>,
  intent: DeliveryIntent,
  invoke: Invoke,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 20,
): Promise<DeliveryResult> {
  try {
    await invoke<string>("desktop_open_url", { url: entry.abs });
  } catch (err) {
    return { opened: false, maximized: false, message: `I couldn't open ${entry.abs}: ${String(err).slice(0, 160)}` };
  }
  if (!intent.maximize) return { opened: true, maximized: false, message: "I opened it in your browser." };
  const needle = windowNeedle(entry);
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    await sleep(600);
    try {
      const said = await invoke<string>("desktop_window_control", { target: needle, action: "maximize" });
      void said;
      return { opened: true, maximized: true, message: "I opened it in your browser and maximized the window." };
    } catch (err) {
      lastErr = String(err);
    }
  }
  return {
    opened: true,
    maximized: false,
    message: `Opened ${entry.rel}, but I couldn't find its browser window to maximize ("${needle}"): ${lastErr.slice(0, 120)}`,
  };
}
