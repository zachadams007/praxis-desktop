/**
 * openArtifact - make "Open preview / Open folder / Open file" REAL.
 *
 *   preview · url   → the existing Tauri command `desktop_open_url` ({ url, browser: null }:
 *                     it opens in the browser the owner actually uses); if that fails, the
 *                     opener plugin's `openUrl` (a local preview falls back to `openPath`).
 *   folder · file   → the opener plugin's `openPath` (as RightDock.openFile does), after a
 *                     `path_exists` check so a deleted workspace says so plainly; if the
 *                     plugin refuses, `desktop_open_url` (it opens a local path with its
 *                     own handler).
 *
 * It RESOLVES only after the call did: `{ ok: true }` means the OS accepted the open,
 * `{ ok: false, message }` carries one plain sentence for the inline error. Nothing here
 * ever claims success it didn't get. Side effects are injected (`OpenDeps`) so the whole
 * decision tree is unit-testable without Tauri.
 *
 * SAFETY: a button must never RUN something. `desktop_open_url` / `openPath` hand a local
 * path to the shell, which executes programs and Windows-script files - so those types are
 * refused outright (open their folder instead), and a local preview is checked to exist
 * first (otherwise the browser would open a blank "file not found" page).
 */

import type { MissionArtifact } from "@/orchestrator/missionThread";
import { missingPathMessage, openFailureMessage } from "@/shared/artifactPath";

export type OpenOutcome = { ok: true } | { ok: false; message: string };

export interface OpenDeps {
  inTauri(): boolean;
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  openPath(path: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** Plain-browser (dev preview) fallback only; returns true when a window opened. */
  windowOpen(url: string): boolean;
}

/** `file:///C:/My%20Site/index.html` → `C:\My Site\index.html`; plain paths pass through. */
export function fileUrlToPath(target: string): string {
  const t = target.trim();
  if (!/^file:\/\//i.test(t)) return t.replace(/\//g, "\\");
  let rest = t.replace(/^file:\/\//i, "");
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* a stray % - keep it literal */
  }
  // file:///C:/x → "/C:/x"; file://server/share/x → "server/share/x" (a UNC path)
  if (/^\/[A-Za-z]:/.test(rest)) return rest.slice(1).replace(/\//g, "\\");
  if (rest.startsWith("/")) return rest.replace(/\//g, "\\");
  return `\\\\${rest.replace(/\//g, "\\")}`;
}

/** What the artifact really is, whatever its `kind` says: a web link is a link. */
export function effectiveKind(a: MissionArtifact): "url" | "preview" | "folder" | "file" {
  if (/^https?:\/\//i.test(a.target.trim())) return "url";
  return a.kind;
}

/** Programs and Windows script-host files: the shell would RUN these, not show them. */
const PROGRAM_RE = /\.(exe|com|bat|cmd|msi|msp|scr|pif|lnk|hta|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|reg|jar|cpl|dll)$/i;

export function launchesProgram(path: string): boolean {
  return PROGRAM_RE.test(path.trim());
}

function isLocalTarget(t: string): boolean {
  return /^file:\/\//i.test(t) || /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\");
}

export function defaultOpenDeps(): OpenDeps {
  return {
    inTauri: () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window),
    invoke: async (cmd, args) => {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke(cmd, args);
    },
    openPath: async (path) => {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path);
    },
    openUrl: async (url) => {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    },
    windowOpen: (url) => {
      try {
        return typeof window !== "undefined" && window.open(url, "_blank", "noopener,noreferrer") !== null;
      } catch {
        return false;
      }
    },
  };
}

export async function openArtifact(art: MissionArtifact, deps: OpenDeps = defaultOpenDeps()): Promise<OpenOutcome> {
  const kind = effectiveKind(art);
  const target = art.target.trim();
  if (!target) return { ok: false, message: "Couldn't open this — it has no address." };

  // A plain browser (the dev preview) has no desktop to open things on. A web link can
  // still honestly open in a new tab; a local path cannot - say so instead of pretending.
  if (!deps.inTauri()) {
    if (kind === "url" && deps.windowOpen(target)) return { ok: true };
    return { ok: false, message: `Couldn't open ${target} — Praxis isn't running as the desktop app.` };
  }

  const local = kind === "folder" || kind === "file" || (kind === "preview" && isLocalTarget(target));
  if (local) {
    const path = fileUrlToPath(target);
    if (launchesProgram(path)) {
      const name = path.split(/[\\/]/).pop() || path;
      return { ok: false, message: `Praxis won't launch a program from a button (${name}) — open its folder instead.` };
    }
    try {
      const exists = await deps.invoke("path_exists", { path });
      if (exists === false) return { ok: false, message: missingPathMessage(path) };
    } catch {
      /* an older backend without path_exists - just try to open it */
    }
    if (kind === "preview") {
      try {
        await deps.invoke("desktop_open_url", { url: target, browser: null });
        return { ok: true };
      } catch (first) {
        try {
          await deps.openPath(path);
          return { ok: true };
        } catch {
          return { ok: false, message: openFailureMessage(path, first) };
        }
      }
    }
    try {
      await deps.openPath(path);
      return { ok: true };
    } catch (first) {
      try {
        await deps.invoke("desktop_open_url", { url: path, browser: null });
        return { ok: true };
      } catch {
        return { ok: false, message: openFailureMessage(path, first) };
      }
    }
  }

  // a web address (kind url / preview over http)
  try {
    await deps.invoke("desktop_open_url", { url: target, browser: null });
    return { ok: true };
  } catch (first) {
    try {
      await deps.openUrl(target);
      return { ok: true };
    } catch {
      return { ok: false, message: openFailureMessage(target, first) };
    }
  }
}
