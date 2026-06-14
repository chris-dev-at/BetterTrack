import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';

import App from './App';

test('App renders the BetterTrack wordmark', () => {
  const html = renderToString(<App />);
  expect(html).toContain('BetterTrack');
});
