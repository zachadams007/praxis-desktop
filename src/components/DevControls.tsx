/**
 * DevControls - the leva dev HUD.
 *
 * Headline = "theme" (flip presets live to A/B the look). New in Round 2: the THEME LAB (design
 * lock 2026-06-12) - a full set of per-token color controls so the owner can play with every color
 * and combination against the real glowing brain. Editing any token switches the active theme to
 * "custom"; "Save scheme" persists it (and "Copy JSON" exports it so the winner can be baked
 * into tokens.ts).
 */

import { useControls, folder, button } from "leva";
import { useEffect, useRef } from "react";
import { usePraxisStore } from "@/store/usePraxisStore";
import {
  THEMES,
  THEME_NAMES,
  saveCustomPalette,
  type ActiveThemeName,
  type Palette,
} from "@/theme/tokens";

/** The Theme-Lab-editable chrome tokens, in display order. */
const LAB_KEYS = [
  "bg",
  "baseCool",
  "baseWarm",
  "edge",
  "hub",
  "accent",
  "accentHot",
  "text",
] as const;
type LabKey = (typeof LAB_KEYS)[number];

const LAB_LABELS: Record<LabKey, string> = {
  bg: "background",
  baseCool: "web cool",
  baseWarm: "web warm",
  edge: "links",
  hub: "core",
  accent: "active",
  accentHot: "alert",
  text: "text",
};

export function DevControls() {
  const themeName = usePraxisStore((s) => s.themeName);
  // true while WE are pushing preset values into the pickers (not a user edit)
  const syncing = useRef(false);

  const labInit = Object.fromEntries(
    LAB_KEYS.map((k) => [LAB_LABELS[k], usePraxisStore.getState().customPalette[k]]),
  ) as Record<string, string>;

  const [values, setLeva] = useControls(() => ({
    Praxis: folder({
      theme: {
        value: usePraxisStore.getState().themeName as string,
        options: [...THEME_NAMES, "custom"] as string[],
      },
      paused: false,
      perf: false,
      ringFrame: true,
    }),
    "Theme Lab": folder(
      {
        ...labInit,
        bloom: { value: usePraxisStore.getState().customPalette.bloom, min: 0.4, max: 1.6, step: 0.01 },
        "Save scheme": button(() => {
          const p = usePraxisStore.getState().customPalette;
          saveCustomPalette(p);
          usePraxisStore.getState().setTheme("custom");
        }),
        "Copy JSON": button(() => {
          const p = usePraxisStore.getState().customPalette;
          void navigator.clipboard?.writeText(JSON.stringify(p, null, 2));
        }),
      },
      { collapsed: true },
    ),
  }));

  // preset flip → apply to store AND mirror its tokens into the lab pickers
  useEffect(() => {
    const name = values.theme as ActiveThemeName;
    usePraxisStore.getState().setTheme(name);
    if (name !== "custom") {
      const p = THEMES[name];
      syncing.current = true;
      setLeva(
        Object.fromEntries([
          ...LAB_KEYS.map((k) => [LAB_LABELS[k], p[k]]),
          ["bloom", p.bloom],
        ]) as never,
      );
      // seed the lab from the preset so "custom" starts from what you see
      usePraxisStore.setState((s) => ({
        customPalette: { ...p, label: "Custom" },
        // keep the preset active - only an actual edit flips to custom
        themeName: s.themeName,
      }));
      syncing.current = false;
    }
  }, [values.theme, setLeva]);

  // picker edits → live-patch the custom palette (and switch to it)
  useEffect(() => {
    if (syncing.current) return;
    const patch: Partial<Palette> = {};
    let changed = false;
    const cur = usePraxisStore.getState().customPalette;
    for (const k of LAB_KEYS) {
      const v = (values as Record<string, unknown>)[LAB_LABELS[k]] as string;
      if (typeof v === "string" && v !== cur[k]) {
        patch[k] = v;
        changed = true;
      }
    }
    const bloom = (values as Record<string, unknown>).bloom as number;
    if (typeof bloom === "number" && bloom !== cur.bloom) {
      patch.bloom = bloom;
      changed = true;
    }
    if (changed) {
      usePraxisStore.getState().setCustomPalette(patch);
      if (values.theme !== "custom") setLeva({ theme: "custom" } as never);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [LAB_KEYS.map((k) => (values as Record<string, unknown>)[LAB_LABELS[k]]).join("|"), (values as Record<string, unknown>).bloom]);

  // keep the dropdown honest if something else changes the theme (e.g. boot restore)
  useEffect(() => {
    if (values.theme !== themeName) setLeva({ theme: themeName } as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeName]);

  useEffect(() => {
    usePraxisStore.getState().setPaused(values.paused);
  }, [values.paused]);
  useEffect(() => {
    usePraxisStore.getState().setShowPerf(values.perf);
  }, [values.perf]);
  useEffect(() => {
    usePraxisStore.getState().setRingFrame(values.ringFrame);
  }, [values.ringFrame]);

  return null;
}
