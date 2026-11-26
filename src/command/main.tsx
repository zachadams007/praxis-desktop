// Command Center - entry for its dedicated Tauri window (command.html).
// No StrictMode (Praxis rule): keep parity with the other window roots.
// restoreMirror runs BEFORE mount so stores' synchronous localStorage loads
// see disk-restored state after a WebView2 data loss (src/shared/persist.ts).
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
