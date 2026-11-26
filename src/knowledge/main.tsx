// Knowledge window (Memory Galaxy) - entry for its dedicated Tauri window (knowledge.html).
// No StrictMode: the double-invoke would re-run the force layout twice on mount.
// restoreMirror seeds missing localStorage keys (galaxy tuning etc.) from the disk
// mirror BEFORE mount - see src/shared/persist.ts.
import { createRoot } from "react-dom/client";
import { installDiagTap } from "@/lib/diagTap";
import { restoreMirror } from "@/shared/persist";
import { FitScaler } from "@/shared/FitScaler";
import "@/shared/fitScaler.css";
import App from "./App";

installDiagTap();
void restoreMirror().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <FitScaler>
      <App />
    </FitScaler>,
  );
});
