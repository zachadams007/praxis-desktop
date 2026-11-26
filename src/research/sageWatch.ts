/**
 * sageWatch.ts - Sage's watch loop, frontend half.
 *
 * The Rust background thread (`src-tauri/src/research_watch.rs`) RSS-checks Example Creator
 * (+ future sources, see `scripts/research-sources.json`) every 6h, fetches new-video
 * transcripts via the bulletproof `scripts/fetch-transcript.cjs` pipeline, and appends any
 * successfully-fetched transcript (full text embedded, not just a path - the webview has no
 * generic filesystem-read plugin) as a job in `%LOCALAPPDATA%\Praxis\research-pending.json`.
 * It then emits `praxis://research-pending` so THIS hook - which alone has access to the
 * selected brain model (`@/orchestrator/brain`) - can drain the queue:
 *
 *   for each pending job:
 *     1. run the idea-extraction prompt through the existing brain (`hermes_brain` - the
 *        THINK/PLAN entry point orchestrator.ts already uses for multi-step reasoning,
 *        reused here rather than duplicated; `brain_chat` is NOT used because its system
 *        prompt caps replies to 1-3 sentences, wrong shape for a structured digest)
 *     3. surface a toast so the owner sees it land live, not just silently in a file
 *
 * Filter (per the mission brief): only extract ideas that make Praxis - an all-in-one AI
 * OS - more capable (computer use, skills, agent connectivity, shared memory), NOT
 * use-case-specific tricks (e.g. thumbnail generation). This filter is baked into the
 * extraction PROMPT itself (see `extractionPrompt` below), not a post-hoc content filter -
 * the brain is asked to apply it while reading, which produces a better digest than
 * generating everything and discarding afterward.
 *
 * A failed transcript fetch never reaches this file - research-scan.cjs writes those
 * straight to the inbox itself (a loud, specific failure entry) and never queues a job for
 * a video it couldn't transcribe. This hook only ever sees genuinely fetched transcripts.
 * If idea-EXTRACTION itself fails (brain down, etc.), the job is re-queued via
 * `write_research_pending` rather than silently dropped - see the catch block below.
 */

import { useEffect } from "react";
import { usePraxisStore } from "@/store/usePraxisStore";

interface PendingJob {
  sourceId: string;
  sourceLabel: string;
  videoId: string;
  title: string;
  url: string;
  published: string | null;
  transcriptSource: string;
  text: string;
  textPath: string;
  segmentsPath: string;
  queuedAt: number;
}

interface PendingQueue {
  jobs: PendingJob[];
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Extra safety clip on top of research-scan.cjs's own MAX_EMBEDDED_CHARS - keeps the brain
 * call itself fast/cheap even if the embedded-text cap is ever raised upstream. */
const MAX_TRANSCRIPT_CHARS = 24000;

function extractionPrompt(job: PendingJob): string {
  const clipped =
    job.text.length > MAX_TRANSCRIPT_CHARS
      ? job.text.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[transcript truncated for length]"
      : job.text;

  return [
    `You are Sage, Praxis's research agent. Below is the transcript of a YouTube video from `,
    `${job.sourceLabel}: "${job.title}" (${job.url}).`,
    ``,
    `Extract ONLY transferable ideas that would make Praxis — Zach's all-in-one AI operating `,
    `system (a living orchestrator that runs agents, has skills, shared memory, and computer `,
    `use) — more CAPABLE. Concretely, look for: new computer-use / agent-control techniques, `,
    `skill-authoring or skill-reuse patterns, agent-to-agent or agent-to-tool connectivity `,
    `ideas, memory/context architecture ideas, or orchestration/routing patterns.`,
    ``,
    `Do NOT include use-case-specific tricks that don't generalize to Praxis's own `,
    `architecture — e.g. thumbnail generation, niche content-creation workflows, or anything `,
    `that's really just "how to use tool X for task Y" with no transferable mechanism. If the `,
    `video genuinely contains nothing transferable by this filter, say so plainly instead of `,
    `padding the digest with weak ideas.`,
    ``,
    `Format your reply as markdown: a short 1-2 sentence summary of the video's relevance, `,
    `then a bulleted list of the transferable ideas, each with a one-line "why this matters `,
    `for Praxis" note. Be concrete and concise — this is a working digest for a decision, not `,
    `an essay.`,
    ``,
    `--- TRANSCRIPT ---`,
    clipped,
  ].join("\n");
}

async function drainQueue(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");

  const raw = await invoke<string | null>("take_research_pending").catch((e) => {
    console.error("[sage] take_research_pending failed:", e);
    return null;
  });
  if (!raw) return;

  let queue: PendingQueue;
  try {
    queue = JSON.parse(raw) as PendingQueue;
  } catch (e) {
    console.error("[sage] pending queue was not valid JSON:", e);
    return;
  }
  if (!queue.jobs || queue.jobs.length === 0) return;

  const { selectedBrain } = await import("@/orchestrator/brain");
  const remaining: PendingJob[] = [];

  for (const job of queue.jobs) {
    try {
      const { provider, model, fallbacks } = selectedBrain();
      const ideasMarkdown = await invoke<string>("hermes_brain", {
        goal: extractionPrompt(job),
        model,
        provider,
        fallbacks,
      });

      await invoke("write_research_note", {
        entry: {
          source_label: job.sourceLabel,
          video_id: job.videoId,
          title: job.title,
          url: job.url,
          published: job.published,
          ideas_markdown: ideasMarkdown.trim() || "(brain returned no content)",
          model,
          ts: Date.now(),
        },
      });

      usePraxisStore.getState().notify(`Sage: new research digest — "${job.title}"`);
    } catch (e) {
      // Idea-extraction failing (brain down, etc.) is NOT the "transcript unreachable"
      // failure mode fetch-transcript.cjs guards against - but it must still be loud, not
      // silently dropped. Re-queue so the next drain retries it, and note the miss.
      console.error("[sage] idea-extraction failed for", job.videoId, e);
      remaining.push(job);
    }
  }

  if (remaining.length > 0) {
    await invoke("write_research_pending", { json: JSON.stringify({ jobs: remaining }) }).catch((e) => {
      console.error("[sage] failed to re-queue failed jobs:", e);
    });
  }
}

/** Mount once (App.tsx) to run Sage's watch loop: drain on every research-pending event,
 * plus one drain shortly after mount in case a scan completed while the window was closed. */
export function useSageWatch(): void {
  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const safeDrain = () => {
      if (!cancelled) void drainQueue().catch((e) => console.error("[sage] drain failed:", e));
    };

    // Catch up on anything queued while the app was closed (research-scan.cjs can also run
    // out-of-process, e.g. a scheduled task, between app sessions).
    const t = window.setTimeout(safeDrain, 5000);

    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("praxis://research-pending", safeDrain))
      .then((f) => {
        if (cancelled) f();
        else unlisten = f;
      })
      .catch(() => {
        /* not inside the Tauri shell */
      });

    return () => {
      cancelled = true;
      window.clearTimeout(t);
      unlisten?.();
    };
  }, []);
}
