import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';
import { initializeAppPwa } from './lib/appServiceWorker';
import { getRuntimeConfig } from './lib/runtimeConfig';
import { createRootErrorOptions } from './rootErrorHandling';
import { bootTheme } from './user/theme';
import { bootUiScale } from './user/uiScale';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// Interface scale, before the first paint (see user/uiScale.ts). User app only:
// the admin console is a separate visual system whose full-height utilities are
// not scale-compensated, so it stays at the browser's own scale.
const appKind = getRuntimeConfig().app;
if (appKind !== 'admin') bootUiScale();

// Theme, re-asserted after the inline boot script in index.html (see
// user/theme.ts). Normally a no-op that restamps the attribute already there;
// it earns its place when the inline script did not run — CSP, a cached shell,
// or a bfcache restore carrying a stale attribute. Admin is excluded for the
// same reason it opts out of the interface scale: its own visual system.
if (appKind !== 'admin') bootTheme();

createRoot(rootElement, createRootErrorOptions(import.meta.env.DEV)).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registration happens after the first render and is shared with web-push, so
// desktop boot never creates competing workers or an unhandled async failure.
void initializeAppPwa(appKind).catch(() => undefined);
