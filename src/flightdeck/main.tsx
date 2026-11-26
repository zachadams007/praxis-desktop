// Flight Deck - entry for the dedicated Tauri window (flightdeck.html).
// No StrictMode: the double-invoke would fire the lane poll twice on mount.
import { createRoot } from 'react-dom/client';
import { installDiagTap } from '@/lib/diagTap';
import { restoreMirror } from '@/shared/persist';
import App from './App';
import './styles/global.css';

installDiagTap();
void restoreMirror().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
