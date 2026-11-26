/**
 * Autonomy / trust ladder - the canonical definition, shared by the Command Center dial,
 * the brain store, and any future surface. Each rung widens what Praxis may do on its own;
 * the guardrail copy is the Phase-3 safety contract in plain language.
 *
 * THE DIAL GOVERNS UNATTENDED RUNS AND NOTHING ELSE. That is him operating his own machine, and
 * it carries no gates at all. See src/shared/actionOrigin.ts for the split and
 * src/shared/autonomyPolicy.ts for the decision the levels below actually drive.
 *
 * The level is persisted to localStorage (shared across the same-origin Tauri windows) so
 * the cockpit dial and the brain agree, and it survives a window reopen. Pure + DOM-light
 * (only touches localStorage behind guards) so it unit-tests headless.
 */

export type AutonomyKey = "observe" | "suggest" | "approve" | "operator" | "full";

export interface TrustLevel {
  key: AutonomyKey;
  label: string;
  blurb: string;
  /** what it WON'T do - the leash, shown so autonomy never feels like a black box */
  guard: string;
}

export const TRUST_LEVELS: TrustLevel[] = [
  {
    key: "observe",
    label: "Observe",
    blurb: "Watches every session and reports. Never touches your machine.",
    guard: "Read-only. No edits, installs, spawns, or spend.",
  },
  {
    key: "suggest",
    label: "Suggest",
    blurb: "Plans the next move and writes it down — you fire every step yourself.",
    guard: "Drafts only. Nothing runs unattended.",
  },
  {
    key: "approve",
    label: "Propose",
    blurb: "Runs unattended work, pausing at every single step for your yes.",
    guard: "Asks before each step — every one, not just the risky ones.",
  },
  {
    key: "operator",
    label: "Execute",
    blurb: "Works alone — edits, installs, runs commands, drives long loops.",
    guard: "Asks before paying, creating an account, signing in, posting or sending.",
  },
  {
    key: "full",
    label: "Sovereign",
    // This used to read "Still asks before accounts, passwords, payments,
    // messages, destructive changes, installs, or security/privacy actions" - the
    // top of the dial advertising that it did not clear its own gates. It was
    // also accurate: thirteen separate gates outranked it, so paying, submitting
    // a form and driving the browser were all blocked at maximum trust.
    blurb: "Runs unattended with nothing withheld: pays, signs in, creates accounts, submits forms, drives the browser.",
    guard: "Asks nothing. HALT is the only thing that stops it.",
  },
];

// The owner lives toward the higher end. Execute is the default for real work: an
// unattended run acts on its own and stops to ask only at a step that spends
// money, creates an identity, or speaks publicly in his name.
export const DEFAULT_AUTONOMY: AutonomyKey = "operator";

/** Index of a key in the ladder (for the radial dial). Falls back to the default. */
export function autonomyIndex(key: AutonomyKey): number {
  const i = TRUST_LEVELS.findIndex((l) => l.key === key);
  return i >= 0 ? i : TRUST_LEVELS.findIndex((l) => l.key === DEFAULT_AUTONOMY);
}

const STORE_KEY = "praxis.autonomy";

/**
 * Mirror the dial into %LOCALAPPDATA%\Praxis\autonomy.txt via the `autonomy_sync`
 * Tauri command, so Rust-side gates (visible computer-use auto-submit) read the
 * SAME level the frontend shows. Fire-and-forget + guarded, so it stays inert in
 * the browser/dev view and in headless unit tests.
 */
function syncAutonomyToShell(key: AutonomyKey): void {
  try {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("autonomy_sync", { level: key }))
      .catch(() => {
        /* best-effort - the Rust side falls back to the shared default */
      });
  } catch {
    /* best-effort */
  }
}

/** Seed the shell mirror once per window load, even if the dial is never touched. */
let shellSeeded = false;

export function loadAutonomy(): AutonomyKey {
  let level: AutonomyKey = DEFAULT_AUTONOMY;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORE_KEY) : null;
    if (raw && TRUST_LEVELS.some((l) => l.key === raw)) level = raw as AutonomyKey;
  } catch {
    /* private mode / unavailable - fall through to default */
  }
  if (!shellSeeded) {
    shellSeeded = true;
    syncAutonomyToShell(level);
  }
  return level;
}

export function saveAutonomy(key: AutonomyKey): void {
  try {
    localStorage?.setItem(STORE_KEY, key);
  } catch {
    /* ignore - persistence is best-effort */
  }
  syncAutonomyToShell(key);
  // Durable disk mirror (survives WebView2 data loss) - see src/shared/persist.ts.
  void import("./persist").then(({ mirrorSet }) => mirrorSet(STORE_KEY, key)).catch(() => {});
}
