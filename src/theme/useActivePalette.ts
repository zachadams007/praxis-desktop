/**
 * useActivePalette - the ONE place the active palette is resolved.
 * "custom" reads the live Theme-Lab palette; anything else reads the preset.
 */

import { usePraxisStore } from "@/store/usePraxisStore";
import { THEMES, type Palette } from "./tokens";

export function useActivePalette(): Palette {
  const name = usePraxisStore((s) => s.themeName);
  const custom = usePraxisStore((s) => s.customPalette);
  return name === "custom" ? custom : THEMES[name];
}
