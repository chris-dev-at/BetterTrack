import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { I18nProvider } from '../../i18n';
import { MarketDataPage } from './MarketDataPage';

/**
 * Operations → Market data: the W5 placeholder (§16 ruling 2026-08-29).
 *
 * The tab is deliberately visible and selectable. These tests hold it to being
 * a HONEST placeholder — it states the guardrails, and it offers no control
 * that could be mistaken for the inspector itself.
 */
function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/admin/market-data']}>
        <MarketDataPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

test('says plainly that it is not built yet', () => {
  renderPage();

  expect(screen.getByRole('heading', { level: 1, name: 'Market data' })).toBeInTheDocument();
  expect(
    screen.getByText(/Nothing here reads an instrument, enqueues a job or touches a price/),
  ).toBeInTheDocument();
});

// The guardrails are the interesting part of W5. Writing them down is what stops
// the next implementer from quietly relaxing them.
test('records the decided guardrails rather than showing an empty box', () => {
  renderPage();

  expect(screen.getByText(/only writes/i)).toBeInTheDocument();
  expect(
    screen.getByText(/guarded, audited enqueue of the existing per-symbol backfill/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/No direct price-row edits, no blind duplicate merges/),
  ).toBeInTheDocument();
  expect(screen.getByText(/only affected-user counts/)).toBeInTheDocument();
});

test('offers no control at all — a placeholder that could act would be the worse failure', () => {
  renderPage();

  // The tab strip's links are navigation, not actions; there must be no buttons.
  expect(screen.queryAllByRole('button')).toHaveLength(0);
});

test('is reachable as a marked tab in the Operations strip', () => {
  renderPage();

  const nav = screen.getByRole('navigation', { name: 'Operations' });
  const tab = within(nav).getByRole('link', { name: /Market data/ });
  expect(tab).toHaveAttribute('aria-current', 'page');
  expect(tab).toHaveTextContent('Soon');
});

test('localizes into German', () => {
  renderPage('de');

  expect(screen.getByRole('heading', { level: 1, name: 'Marktdaten' })).toBeInTheDocument();
  expect(screen.getByText('Die einzigen Schreibvorgänge')).toBeInTheDocument();
});
