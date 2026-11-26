/**
 * persist - durable disk mirror over localStorage (state_mirror.rs).
 *
 * localStorage lives inside the WebView2 profile and can be lost to a
 * hard-shutdown corruption (and was historically wiped by launcher cache
 * clears). Every store keeps localStorage as its hot, synchronous source of
 * truth; `mirrorSet` additionally writes the key to
 * `%LOCALAPPDATA%\Praxis\state.json` (fire-and-forget), and `restoreMirror`
 * runs ONCE per window BEFORE React mounts, seeding any key that is missing
 * from localStorage back from disk. A present localStorage key always wins -
 * the mirror restores, never overrides.
 *
 * Outside Tauri (dev browser) both are silent no-ops.
 */

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Mirror a key to disk. Call from every store's save fn, after localStorage. */
export function mirrorSet(key: string, value: string): void {
  if (!inTauri()) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("state_set", { key, value }))
    .catch(() => {
      /* older backend without the command - localStorage still works */
    });
}

/**
 * Seed missing localStorage keys from the disk mirror. Await this BEFORE
 * mounting React so stores' synchronous load() calls see restored state.
 */
export async function restoreMirror(): Promise<void> {
  if (!inTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const all = await invoke<Record<string, string>>("state_all");
    for (const [key, value] of Object.entries(all)) {
      try {
        if (localStorage.getItem(key) == null) localStorage.setItem(key, value);
      } catch {
        /* storage unavailable - nothing to restore into */
      }
    }
  } catch {
    /* command missing / backend older - boot proceeds on localStorage alone */
  }
}
