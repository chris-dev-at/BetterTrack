import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';
import { createRootErrorOptions } from './rootErrorHandling';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement, createRootErrorOptions(import.meta.env.DEV)).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
