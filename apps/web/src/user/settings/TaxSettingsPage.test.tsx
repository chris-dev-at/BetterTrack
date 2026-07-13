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
import { TaxSettingsPage } from './TaxSettingsPage';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaxSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaxSettings).mockResolvedValue({ mode: 'none', country: null });
});

describe('TaxSettingsPage', () => {
  test('offers all three modes with `none` selected, and the Austria option explains the model', async () => {
    renderPage();

    expect(await screen.findByRole('radio', { name: /No tax tracking/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Manual — enter tax per trade/i })).not.toBeChecked();

    const austria = screen.getByRole('radio', { name: /Austria \(KESt\)/i });
    expect(austria).not.toBeChecked();
    // The AT option spells out the model per the locked v3 spec (§13.3 item 34).
    expect(austria).toHaveAccessibleName(/27\.5 % KESt/);
    expect(austria).toHaveAccessibleName(/moving-average cost basis/i);
    expect(austria).toHaveAccessibleName(/1 January/i);
    expect(austria).toHaveAccessibleName(/no losses carry/i);
  });

  test('choosing Austria persists country_specific with country AT and reveals the report link', async () => {
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

  test('no report signpost while tax tracking is off', async () => {
    renderPage();
    await screen.findByRole('radio', { name: /No tax tracking/i });
    expect(screen.queryByRole('link', { name: /per-year tax report/i })).toBeNull();
  });

  test('surfaces a load error without crashing', async () => {
    vi.mocked(getTaxSettings).mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Couldn’t load your tax settings/i)).toBeInTheDocument();
  });
});
