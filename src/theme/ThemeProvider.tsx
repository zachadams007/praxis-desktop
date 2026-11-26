/**
 * ThemeApplier - mirrors the active palette into CSS custom properties on :root so
 * the DOM HUD restyles instantly when the palette is flipped. Renders nothing.
 */

import { useEffect } from "react";
import { applyThemeVars } from "./tokens";
import { useActivePalette } from "./useActivePalette";

export function ThemeApplier() {
  const palette = useActivePalette();
  useEffect(() => {
    applyThemeVars(palette);
  }, [palette]);
  return null;
}
