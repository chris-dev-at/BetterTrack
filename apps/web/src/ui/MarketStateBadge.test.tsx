import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { I18nProvider } from '../i18n';

import { MarketStateBadge } from './MarketStateBadge';

const renderBadge = (state: Parameters<typeof MarketStateBadge>[0]['state'], locale = 'en') =>
  render(
    <I18nProvider initialLocale={locale}>
      <MarketStateBadge state={state} />
    </I18nProvider>,
  );

describe('MarketStateBadge (§13.5 V5-P1)', () => {
  test('renders the correct label for each of the four states (EN)', () => {
    renderBadge('open');
    expect(screen.getByText('Open')).toBeInTheDocument();
    renderBadge('closed');
    expect(screen.getByText('Closed')).toBeInTheDocument();
    renderBadge('pre');
    expect(screen.getByText('Pre-market')).toBeInTheDocument();
    renderBadge('post');
    expect(screen.getByText('After hours')).toBeInTheDocument();
  });

  test('renders localized labels (DE)', () => {
    renderBadge('open', 'de');
    expect(screen.getByText('Geöffnet')).toBeInTheDocument();
    renderBadge('closed', 'de');
    expect(screen.getByText('Geschlossen')).toBeInTheDocument();
  });

  test('renders nothing for an unknown / missing state (never a wrong badge)', () => {
    const { container: nullContainer } = renderBadge(null);
    expect(nullContainer).toBeEmptyDOMElement();
    const { container: undefContainer } = renderBadge(undefined);
    expect(undefContainer).toBeEmptyDOMElement();
  });
});
