import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';

import App from './App';

test('App renders the BetterTrack wordmark', () => {
  const html = renderToString(<App />);
  // The wordmark splits "Better" (white) and "Track" (gold) into sibling spans.
  expect(html).toContain('Better');
  expect(html).toContain('Track');
});
