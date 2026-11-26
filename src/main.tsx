import ReactDOM from "react-dom/client";
import { installDiagTap } from "@/lib/diagTap";
import { restoreMirror } from "@/shared/persist";
import App from "./App";

import "./styles/base.css";
import "./styles/hud.css";
import "./styles/atlas.css";

// NOTE: no <React.StrictMode>. R3F's <Canvas> measures its container with a
// ResizeObserver; StrictMode's mount→unmount→remount double-invoke can leave the
// observer wired to an element it never reports a size change for, so R3F's measured
// size stays 0 and the scene silently never mounts (esp. on reload). Dropping
// StrictMode also avoids double-creating the WebGL context. Standard for R3F apps.
//
// restoreMirror seeds missing localStorage keys (autonomy, tool breakers, todo…)
// from the disk mirror BEFORE mount - see src/shared/persist.ts.
installDiagTap();
void restoreMirror().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
});
