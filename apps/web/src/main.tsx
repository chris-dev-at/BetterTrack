import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';
import { initWebObservability } from './lib/sentry';

// Error tracking (§13.4 V4-P5a): env-gated on VITE_SENTRY_DSN. A no-op when
// unset, so boot is unchanged; when set it must run before render so early
// errors are captured.
initWebObservability();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
