/**
 * Artifact / file-chip paths - resolve relative, ~, and vault-relative strings
 * to absolute candidates, and format an honest open-failure sentence.
 *
 * Chips must never advertise an openable path that has not been shown to exist.
 * Opening still goes through Tauri; this module only names the candidates and
 * the failure sentence. Existence is `path_exists`.
 */

export const PRAXIS_REPO_ROOT = "C:/Users/dev/Desktop/praxis";

export function vaultRootFromHome(home: string): string {
  return winJoin(home, ".claude/projects/C--Users-dev-Desktop-praxis/memory");
}

export function praxisDataFromLocal(localData: string): string {
  return winJoin(localData, "Praxis");
}

export function winJoin(dir: string, rel: string): string {
  const left = dir.replace(/[\\/]+$/, "");
  const right = rel.replace(/^[\\/]+/, "").replace(/\//g, "\\");
  return `${left}\\${right}`;
}

export function expandUser(path: string, home: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return winJoin(home, trimmed.slice(2));
  }
  return trimmed;
}

export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");
}

export interface PathRoots {
  home: string;
  vault: string;
  repoRoot: string;
  praxisData: string;
}

/** Absolute paths to probe, in preference order. Never returns an empty string. */
export function candidateAbsolutePaths(raw: string, roots: PathRoots): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const expanded = expandUser(trimmed, roots.home);
  const out: string[] = [];
  const add = (p: string) => {
    const n = p.replace(/\//g, "\\");
    if (n && !out.includes(n)) out.push(n);
  };
  if (isAbsolutePath(expanded)) {
    add(expanded);
    return out;
  }
  add(winJoin(roots.repoRoot, expanded));
  add(winJoin(roots.vault, expanded));
  add(winJoin(roots.praxisData, expanded));
  return out;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function openFailureWhy(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const s = oneLine(raw);
  if (!s) return "the OS could not open it";
  if (/not found|cannot find|no such file|os error 2|ENOENT/i.test(s)) return "that path does not exist";
  if (/access is denied|permission denied|EACCES|EPERM/i.test(s)) return "access was denied";
  // Keep a short why, never a JSON body, never a truncated path (the path is passed separately).
  const head = s.split(":")[0];
  return head.length > 160 ? `${head.slice(0, 157)}…` : head;
}

/** One plain sentence. The path is never truncated. */
export function openFailureMessage(triedPath: string, err: unknown): string {
  const path = triedPath.trim() || "(no path)";
  return `Couldn't open ${path} — ${openFailureWhy(err)}.`;
}

export function missingPathMessage(triedPath: string): string {
  const path = triedPath.trim() || "(no path)";
  return `Couldn't open ${path} — that path does not exist.`;
}
