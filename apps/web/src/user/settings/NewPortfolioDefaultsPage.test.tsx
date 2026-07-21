import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/settingsApi', () => ({
  getTaxSettings: vi.fn(),
  updateTaxSettings: vi.fn(),
}));

import { getTaxSettings, updateTaxSettings } from '../../lib/settingsApi';
import { NewPortfolioDefaultsPage } from './NewPortfolioDefaultsPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NewPortfolioDefaultsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaxSettings).mockResolvedValue({ mode: 'none', country: null });
});

describe('NewPortfolioDefaultsPage (issue #636)', () => {
  test('frames the tax control as the default for new portfolios', async () => {
    renderPage();
    // The hint only renders once the default has loaded — telling the user each
    // portfolio can override it.
    expect(await screen.findByText(/override or reset it per portfolio/i)).toBeInTheDocument();
    expect(screen.getByText(/Defaults for new portfolios/i)).toBeInTheDocument();
  });

  test('offers all modes with `none` selected, editing the user-level default', async () => {
    renderPage();
    expect(await screen.findByRole('radio', { name: /No tax tracking/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Manual — enter tax per trade/i })).not.toBeChecked();
    const austria = screen.getByRole('radio', { name: /Austria \(KESt\)/i });
    expect(austria).toHaveAccessibleName(/27\.5 % KESt/);
  });

  test('choosing Austria persists country_specific/AT and reveals the report link', async () => {
    vi.mocked(updateTaxSettings).mockResolvedValue({ mode: 'country_specific', country: 'AT' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /Austria \(KESt\)/i }));

    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'country_specific', country: 'AT' }),
    );
    expect(await screen.findByRole('link', { name: /per-year tax report/i })).toHaveAttribute(
      'href',
      '/portfolio/tax',
    );
  });

  test('choosing Manual persists manual_per_trade with no country', async () => {
    vi.mocked(updateTaxSettings).mockResolvedValue({ mode: 'manual_per_trade', country: null });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('radio', { name: /Manual — enter tax per trade/i }));

    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'manual_per_trade' }),
    );
  });

  test('offers Germany and persists country_specific with country DE', async () => {
    vi.mocked(updateTaxSettings).mockResolvedValue({ mode: 'country_specific', country: 'DE' });
    const user = userEvent.setup();
    renderPage();

    const germany = await screen.findByRole('radio', { name: /Germany \(Abgeltungsteuer\)/i });
    expect(germany).toHaveAccessibleName(/Sparer-Pauschbetrag/i);
    await user.click(germany);
    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'country_specific', country: 'DE' }),
    );
  });

  test('surfaces a load error without crashing', async () => {
    vi.mocked(getTaxSettings).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Couldn’t load your tax settings/i)).toBeInTheDocument();
  });

  test('saved DE default marks Germany selected — not Austria', async () => {
    vi.mocked(getTaxSettings).mockResolvedValue({ mode: 'country_specific', country: 'DE' });
    renderPage();
    expect(
      await screen.findByRole('radio', { name: /Germany \(Abgeltungsteuer\)/i }),
    ).toBeChecked();
    expect(screen.getByRole('radio', { name: /Austria \(KESt\)/i })).not.toBeChecked();
  });
});
