import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Invoke = (command: string, args?: unknown, options?: unknown) => Promise<unknown>;
type TauriInternals = { invoke?: Invoke };

let installed = false;

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message || value.name;
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function installDiagTap(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  try {
    const internals = (
      window as unknown as { __TAURI_INTERNALS__?: TauriInternals }
    ).__TAURI_INTERNALS__;
    const original = internals?.invoke;
    if (!internals || typeof original !== "function") return;

    let source = "unknown";
    try {
      source = getCurrentWebviewWindow().label;
    } catch {
      // A missing label must never prevent diagnostics from installing.
    }

    const report = (message: string): void => {
      try {
        void original
          .call(internals, "diag_report", { source, message })
          .catch(() => {});
      } catch {
        // Diagnostics are best-effort and must never affect the caller.
      }
    };

    internals.invoke = function diagnosticInvoke(
      command: string,
      args?: unknown,
      options?: unknown,
    ): Promise<unknown> {
      let result: Promise<unknown>;
      try {
        result = original.call(internals, command, args, options);
      } catch (error) {
        if (command !== "diag_report") {
          report(`invoke ${command} failed: ${errorText(error)}`);
        }
        throw error;
      }
      if (command === "diag_report") return result;
      return result.catch((error: unknown) => {
        report(`invoke ${command} failed: ${errorText(error)}`);
        throw error;
      });
    };

    window.addEventListener("error", (event) => {
      try {
        const where = event.filename
          ? ` (${event.filename}:${event.lineno}:${event.colno})`
          : "";
        report(`window error: ${event.message || errorText(event.error)}${where}`);
      } catch {
        // Never let reporting disturb the browser's error dispatch.
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      try {
        report(`unhandled rejection: ${errorText(event.reason)}`);
      } catch {
        // Never let reporting disturb the browser's rejection dispatch.
      }
    });
  } catch {
    // Non-Tauri previews and partial boot states intentionally stay untouched.
  }
}
