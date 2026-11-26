/**
 * labelFontStore - the CLUSTER LABEL typeface (the big tier-1 names in the brain,
 * e.g. PRAXIS / FINANCE). This is intentionally a small live picker: the Controls
 * tab can audition faces without changing the authored clusters themselves.
 *
 * ⚠️ TROIKA TAKES TTF/OTF/WOFF ONLY - NEVER WOFF2. troika-three-text 0.52.4
 * `throw new Error('woff2 fonts not supported')` on the wOF2 magic bytes, and a
 * font failure inside the label <Text> can take down the whole brain window
 * (2026-07-10: the spectral .woff2 options crashed the mount, the choice was
 * persisted, and every watchdog reload re-crashed - the grey-window wedge).
 * The Spectral faces are therefore vendored as fonttools-converted .ttf twins of
 * the DOM's .woff2s. If you add an option here, point it at a .ttf under
 * public/fonts and click it before shipping.
 *
 * Default is the original Plex Mono 600. The v2 key intentionally forgets the brief
 * Spectral-only forced state so the brain returns to the previous normal look.
 *
 * NB: this only swaps the cluster NAME cap's font.
 */

import { create } from "zustand";

export interface LabelFontOption {
  id: string;
  /** Display name - the picker renders it IN this face (type-specimen style). */
  name: string;
  /** Public URL of the troika font file - TTF only (see header warning). */
  url: string;
  /** DOM font-family stack for the picker's live specimen (base.css @font-face). */
  css: string;
  /** DOM font-weight for the specimen. */
  weight: number;
}

/**
 *
 * Kept as a list rather than a bare constant because `Labels.tsx`, the picker
 * plumbing and the error boundary all index into it - and because restoring a
 * choice later is then a one-line change. The Controls picker that used to
 * render these was removed from RightDock in the same change.
 *
 * Side benefit: a single vendored .ttf retires the font-cycler crash class
 * entirely (troika throws on woff2, and a poisoned localStorage id used to grey
 * out the brain on boot).
 */
export const LABEL_FONTS: LabelFontOption[] = [
  { id: "spectral-500", name: "Spectral 500", url: "/fonts/spectral-500.ttf", css: '"Spectral", Georgia, serif', weight: 500 },
];

const KEY = "praxis.labelFont.v2";

function loadIndex(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const i = raw ? LABEL_FONTS.findIndex((f) => f.id === raw) : -1;
    return i >= 0 ? i : 0;
  } catch {
    return 0;
  }
}

interface LabelFontState {
  index: number;
  font: LabelFontOption;
  /** Advance to the next font and persist the choice (voice-command friendly). */
  cycle: () => void;
  /** Jump straight to a face by id (the Controls picker) and persist it. */
  setFont: (id: string) => void;
  /** Back to the known-good default and FORGET the persisted choice - the
   *  Labels error boundary calls this so a bad font can never poison boots. */
  reset: () => void;
}

export const useLabelFont = create<LabelFontState>((set, get) => {
  const commit = (next: number) => {
    try {
      localStorage.setItem(KEY, LABEL_FONTS[next].id);
    } catch {
      /* best-effort persistence */
    }
    set({ index: next, font: LABEL_FONTS[next] });
  };
  const start = loadIndex();
  return {
    index: start,
    font: LABEL_FONTS[start],
    cycle: () => commit((get().index + 1) % LABEL_FONTS.length),
    setFont: (id) => {
      const i = LABEL_FONTS.findIndex((f) => f.id === id);
      if (i >= 0) commit(i);
    },
    reset: () => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
      set({ index: 0, font: LABEL_FONTS[0] });
    },
  };
});
