/**
 * orgScan - shared bridge to the `org_scan` Tauri command (src-tauri/src/org_scan.rs),
 * Atlas's dry-run Desktop/vault cleanup sweep. One implementation for both callers:
 *   - the voice/command-launcher "run org scan" verb (src/voice/execute.ts)
 *   - the Command Center's on-demand button (src/command/ControlPanel.tsx)
 *
 * V1 is DRY-RUN ONLY on the Rust side - this module never moves or deletes anything,
 * it just invokes the scan and returns its summary. Silent/no-op in a plain browser
 * (no Tauri), matching every other bridge in this codebase (see launch.ts).
 */

export type OrgScanTier = "protected" | "archive-candidate" | "trash-candidate";
export type OrgScanSource = "desktop" | "handoff" | "orphan-note" | "scratch-repo";

export interface OrgScanCandidate {
  source: OrgScanSource;
  tier: OrgScanTier;
  name: string;
  path: string;
  size_bytes: number;
  age_days: number;
  reason: string;
  proposed_dest: string | null;
}

export interface OrgScanCounts {
  protected: number;
  archive_candidate: number;
  trash_candidate: number;
  scanned: number;
}

export interface OrgScanResult {
  generated_at_ms: number;
  report_path: string | null;
  candidates: OrgScanCandidate[];
  counts: OrgScanCounts;
}

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Run the scan and return its result. Returns null in a plain browser (no Tauri) or
 *  on failure - callers decide how to surface that (voice speaks a fallback line, the
 *  Command Center button shows an inline error state). */
export async function runOrgScan(): Promise<OrgScanResult | null> {
  if (!inTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<OrgScanResult>("org_scan");
  } catch (err) {
    console.error("[org-scan] failed:", err);
    return null;
  }
}

/** One spoken/toast-friendly summary line from a scan result. */
export function summarizeOrgScan(result: OrgScanResult): string {
  const { archive_candidate, trash_candidate, protected: protectedCount } = result.counts;
  const actionable = archive_candidate + trash_candidate;
  if (actionable === 0) {
    return `Organization scan clean — ${protectedCount} files inspected, nothing worth flagging.`;
  }
  return (
    `Organization scan done — ${archive_candidate} archive candidate${archive_candidate === 1 ? "" : "s"} ` +
    `and ${trash_candidate} trash candidate${trash_candidate === 1 ? "" : "s"} found. ` +
    `Nothing moved — review the report before anything happens.`
  );
}
