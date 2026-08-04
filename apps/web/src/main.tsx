import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';
import { registerAppServiceWorker } from './lib/appServiceWorker';
import { getRuntimeConfig } from './lib/runtimeConfig';
import { createRootErrorOptions } from './rootErrorHandling';
import { bootUiScale } from './user/uiScale';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

// Interface scale, before the first paint (see user/uiScale.ts). User app only:
// the admin console is a separate visual system whose full-height utilities are
// not scale-compensated, so it stays at the browser's own scale.
if (getRuntimeConfig().app !== 'admin') bootUiScale();

createRoot(rootElement, createRootErrorOptions(import.meta.env.DEV)).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registration happens after the first render and is shared with web-push, so
// desktop boot never creates competing workers or an unhandled async failure.
void registerAppServiceWorker().catch(() => undefined);
