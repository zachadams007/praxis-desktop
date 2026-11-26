/**
 * researchScan - shared bridge to the `research_scan` Tauri command
 * (src-tauri/src/research_watch.rs), Sage's on-demand RSS + transcript sweep. One
 * implementation for both callers:
 *   - the voice/command-launcher "run research scan" verb (src/voice/execute.ts)
 *   - the Command Center's on-demand button (src/command/ControlPanel.tsx)
 *
 * Mirrors src/shared/orgScan.ts's shape exactly. Silent/no-op in a plain browser
 * (no Tauri), matching every other bridge in this codebase.
 */

export interface ResearchScanSummary {
  newVideos?: number;
  transcribed?: number;
  failed?: number;
  [key: string]: unknown; // research-scan.cjs's JSON is schema-loose on the Rust side
}

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Run the scan now and return its summary. Returns null in a plain browser (no Tauri)
 *  or on failure - callers decide how to surface that. */
export async function runResearchScan(): Promise<ResearchScanSummary | null> {
  if (!inTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ResearchScanSummary>("research_scan");
  } catch (err) {
    console.error("[research-scan] failed:", err);
    return null;
  }
}

/** One spoken/toast-friendly summary line from a scan result. */
export function summarizeResearchScan(result: ResearchScanSummary): string {
  if (result.skipped) return "Research scan already ran moments ago — nothing new to check yet.";
  const newVideos = result.newVideos ?? 0;
  if (newVideos === 0) return "Research scan done — no new videos from the watched sources.";
  const transcribed = result.transcribed ?? 0;
  const failed = result.failed ?? 0;
  return (
    `Research scan found ${newVideos} new video${newVideos === 1 ? "" : "s"} — ` +
    `${transcribed} digested${failed ? `, ${failed} failed (check the research inbox)` : ""}.`
  );
}
