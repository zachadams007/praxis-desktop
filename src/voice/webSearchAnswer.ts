/**
 * Atlas's text-first web-search seam.
 *
 * The Rust command owns networking, SSRF protection, result parsing, and the optional
 * free NVIDIA summary. This module gives typed Atlas and both voice transports one
 * honest frontend contract, so "search the web" cannot drift back into merely opening
 * a browser tab on one surface.
 */

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchAnswer {
  query: string;
  hits: WebSearchHit[];
  markdown: string;
  brief: string;
  summarized: boolean;
  note?: string | null;
  pagesRead: number;
}

const EXPLICIT_WEB_SEARCH =
  /^\s*(?:atlas[,:]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:(?:search|look\s+up|find)\s+(?:(?:the\s+)?web|online)(?:\s+for)?|web\s+search(?:\s+for)?)\s*[:\-]?\s*(.+?)\s*[?.!]?\s*$/i;

/** The query from an explicit text-first search request, or null for ordinary speech. */
export function explicitWebSearchQuery(text: string): string | null {
  const match = EXPLICIT_WEB_SEARCH.exec(text);
  const query = match?.[1]?.trim().replace(/[?.!]+$/, "").trim() ?? "";
  return query || null;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/* A caller may ignore a late result after abort. */
export async function searchWebAnswer(query: string, signal?: AbortSignal): Promise<WebSearchAnswer> {
  const clean = query.trim();
  if (!clean) throw new Error("I need something to search for.");
  if (!inTauri()) throw new Error("Web answers need the Praxis desktop app.");
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
  const { invoke } = await import("@tauri-apps/api/core");
  const answer = await invoke<WebSearchAnswer>("web_search_answer", { query: clean });
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
  return answer;
}

export function webSearchSpokenBrief(answer: WebSearchAnswer): string {
  const brief = answer.brief.trim();
  if (brief) return `${brief} I put the sources in Atlas.`;
  return answer.hits.length > 0
    ? `I found ${answer.hits.length} sources and put them in Atlas.`
    : `I couldn't find results for ${answer.query}.`;
}
