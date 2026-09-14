import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// The deploy-time market-intel capability (§13.5 V5-P5) decides which widgets the
// catalog may offer at all; drive it explicitly rather than through the network.
const deployCapabilities = vi.hoisted(() => ({ marketIntel: true }));
vi.mock('../../lib/featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/featureFlags')>()),
  useDeployCapabilities: () => ({ marketIntel: deployCapabilities.marketIntel }),
}));

import { AddWidgetDrawer } from './AddWidgetDrawer';
import { WIDGET_REGISTRY } from './widgets';

function renderDrawer() {
  return render(<AddWidgetDrawer onAdd={vi.fn()} onClose={vi.fn()} open />);
}

describe('home widget catalog — market-intel capability gate (§13.5 V5-P5)', () => {
  test('both market-intel widgets declare the capability they need', () => {
    // The registry is the single source the catalog reads; a widget that calls
    // `marketIntelApi` without this key would be offered on a deployment where
    // its only possible render is "not available".
    expect(WIDGET_REGISTRY.news.capability).toBe('marketIntel');
    expect(WIDGET_REGISTRY.dividends.capability).toBe('marketIntel');
  });

  test('offers the news and dividends widgets when the capability is present', () => {
    deployCapabilities.marketIntel = true;
    renderDrawer();

    expect(screen.getByText('News')).toBeInTheDocument();
    expect(screen.getByText('Dividends')).toBeInTheDocument();
    // A widget with no capability requirement is unaffected either way.
    expect(screen.getByText('Watchlist')).toBeInTheDocument();
  });

  test('does not offer them at all when the deployment has no market intel', () => {
    deployCapabilities.marketIntel = false;
    renderDrawer();

    expect(screen.queryByText('News')).not.toBeInTheDocument();
    expect(screen.queryByText('Dividends')).not.toBeInTheDocument();
    // The rest of the catalog is untouched — this is a gate, not a kill switch.
    expect(screen.getByText('Watchlist')).toBeInTheDocument();
    expect(screen.getByText('Net worth')).toBeInTheDocument();
  });
});
