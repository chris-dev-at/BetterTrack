import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../lib/settingsApi', () => ({
  getTaxSettings: vi.fn(),
  updateTaxSettings: vi.fn(),
}));

import { getTaxSettings, updateTaxSettings } from '../../../lib/settingsApi';
import { DefaultsPanel } from './DefaultsPanel';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DefaultsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTaxSettings).mockResolvedValue({ mode: 'none', country: null });
});

describe('DefaultsPanel (issue #636)', () => {
  test('frames the tax control as the default for new portfolios', async () => {
    renderPanel();
    // The hint only renders once the default has loaded — telling the user a
    // single portfolio can override it (in its own settings, since R2 moved the
    // per-portfolio override off the tax report).
    expect(await screen.findByText(/can override it in its own settings/i)).toBeInTheDocument();
    // The popup head names the panel (the old page title stack is gone).
    expect(screen.getByRole('heading', { name: 'Portfolio defaults' })).toBeInTheDocument();
    // Owner-mandated liability framing (#635) on the tax settings surface.
    expect(screen.getByText(/Estimates for your personal overview only/i)).toBeInTheDocument();
  });

  test('offers all modes with `none` selected, editing the user-level default', async () => {
    renderPanel();
    expect(await screen.findByRole('radio', { name: /No tax tracking/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Manual — enter tax per trade/i })).not.toBeChecked();
    const austria = screen.getByRole('radio', { name: /Austria \(KESt\)/i });
    expect(austria).toHaveAccessibleName(/27\.5 % KESt/);
  });

  // The owner's complaint: at popup scale ONE mode filled the screen, because the
  // page picker gives every option a 2–4 sentence description. The dense list
  // keeps the same six choices but replaces each description with one qualifying
  // line — so the whole set is on screen at once.
  test('renders every mode as a dense row, without the page picker prose', async () => {
    renderPanel();

    await screen.findByRole('radio', { name: /No tax tracking/i });
    const group = screen.getByRole('radiogroup', { name: 'Tax mode' });
    expect(within(group).getAllByRole('radio')).toHaveLength(6);

    // The long descriptions are gone — these sentences belong to the full-page
    // picker (portfolio tax surface + first-run step), which still shows them.
    expect(screen.queryByText(/Everything resets on 1 January — no losses carry/i)).toBeNull();
    expect(screen.queryByText(/A €1,000 saver's allowance/i)).toBeNull();
    expect(screen.queryByText(/The €30,000 bracket applies per portfolio/i)).toBeNull();
    expect(screen.queryByText(/Build your own tax system/i)).toBeNull();

    // No card per option: the rows are hairline-ruled, and selection is carried
    // by background/ink — never an edge marker.
    for (const radio of within(group).getAllByRole('radio')) {
      const row = radio.closest('label');
      expect(row).toHaveClass('bt-cc-mode');
      expect(row?.className).not.toMatch(/bt-panel/);
    }
    expect(
      within(group)
        .getByRole('radio', { name: /No tax tracking/i })
        .closest('label'),
    ).toHaveClass('is-selected');
  });

  test('choosing Austria persists country_specific/AT and reveals the report link', async () => {
    vi.mocked(updateTaxSettings).mockResolvedValue({ mode: 'country_specific', country: 'AT' });
    const user = userEvent.setup();
    renderPanel();

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
    renderPanel();

    await user.click(await screen.findByRole('radio', { name: /Manual — enter tax per trade/i }));

    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'manual_per_trade' }),
    );
  });

  test('offers Germany and persists country_specific with country DE', async () => {
    vi.mocked(updateTaxSettings).mockResolvedValue({ mode: 'country_specific', country: 'DE' });
    const user = userEvent.setup();
    renderPanel();

    const germany = await screen.findByRole('radio', { name: /Germany \(Abgeltungsteuer\)/i });
    // The qualifier still rides in the accessible name — compacted from the
    // page picker's four sentences to the numbers that actually distinguish DE.
    expect(germany).toHaveAccessibleName(/25 %/);
    expect(germany).toHaveAccessibleName(/FIFO/);
    expect(germany).toHaveAccessibleName(/carry forward/i);
    await user.click(germany);
    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'country_specific', country: 'DE' }),
    );
  });

  test('surfaces a load error without crashing', async () => {
    vi.mocked(getTaxSettings)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ mode: 'none', country: null });
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText(/Couldn’t load your tax settings/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('radio', { name: /No tax tracking/i })).toBeChecked();
    expect(getTaxSettings).toHaveBeenCalledTimes(2);
  });

  test('saved DE default marks Germany selected — not Austria', async () => {
    vi.mocked(getTaxSettings).mockResolvedValue({ mode: 'country_specific', country: 'DE' });
    renderPanel();
    expect(
      await screen.findByRole('radio', { name: /Germany \(Abgeltungsteuer\)/i }),
    ).toBeChecked();
    expect(screen.getByRole('radio', { name: /Austria \(KESt\)/i })).not.toBeChecked();
  });
});

// --- V5-P4c (#584): the custom rule builder + the manual default ------------

const AT_LIKE_PARAMS = {
  ratePct: 27.5,
  lossOffset: true,
  refund: true,
  yearReset: true,
  carryForward: false,
  costBasis: 'moving-average',
} as const;

describe('custom tax mode (V5-P4c)', () => {
  test('picking Custom rules persists the mode with the default parameter set', async () => {
    vi.mocked(updateTaxSettings).mockResolvedValue({
      mode: 'custom',
      country: null,
      custom: AT_LIKE_PARAMS,
    });
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('radio', { name: /Custom rules/i }));
    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'custom', custom: AT_LIKE_PARAMS }),
    );
  });

  test('the builder folds open in custom mode and applies edited parameters', async () => {
    vi.mocked(getTaxSettings).mockResolvedValue({
      mode: 'custom',
      country: null,
      custom: { ...AT_LIKE_PARAMS, ratePct: 10 },
    });
    vi.mocked(updateTaxSettings).mockResolvedValue({
      mode: 'custom',
      country: null,
      custom: { ...AT_LIKE_PARAMS, ratePct: 20, carryForward: true, costBasis: 'fifo' },
    });
    const user = userEvent.setup();
    renderPanel();

    // The compact card shows the saved parameters.
    const rate = await screen.findByLabelText(/custom tax rate in percent/i);
    expect(rate).toHaveValue(10);

    await user.clear(rate);
    await user.type(rate, '20');
    await user.click(screen.getByRole('checkbox', { name: /carry losses forward/i }));
    await user.selectOptions(screen.getByLabelText(/custom cost-basis method/i), 'fifo');
    await user.click(screen.getByRole('button', { name: /apply rules/i }));

    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({
        mode: 'custom',
        custom: { ...AT_LIKE_PARAMS, ratePct: 20, carryForward: true, costBasis: 'fifo' },
      }),
    );
  });

  test('the builder stays hidden in every other mode (anti-bloat)', async () => {
    renderPanel();
    await screen.findByRole('radio', { name: /No tax tracking/i });
    expect(screen.queryByLabelText(/custom tax rate in percent/i)).toBeNull();
  });
});

describe('manual default (V5-P4c)', () => {
  test('manual mode reveals the default field and saves an amount default', async () => {
    vi.mocked(getTaxSettings).mockResolvedValue({ mode: 'manual_per_trade', country: null });
    vi.mocked(updateTaxSettings).mockResolvedValue({
      mode: 'manual_per_trade',
      country: null,
      manualDefaultAmountEur: 5,
    });
    const user = userEvent.setup();
    renderPanel();

    const value = await screen.findByLabelText(/default manual tax/i);
    await user.type(value, '5');
    await user.click(screen.getByRole('button', { name: /save default/i }));

    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({
        mode: 'manual_per_trade',
        manualDefaultAmountEur: 5,
      }),
    );
  });

  test('a % default saves as a rate; a stored default shows and clears', async () => {
    vi.mocked(getTaxSettings).mockResolvedValue({
      mode: 'manual_per_trade',
      country: null,
      manualDefaultRatePct: 10,
    });
    vi.mocked(updateTaxSettings).mockResolvedValue({ mode: 'manual_per_trade', country: null });
    const user = userEvent.setup();
    renderPanel();

    // The stored rate default is shown with the % unit active.
    expect(await screen.findByLabelText(/default manual tax/i)).toHaveValue(10);
    expect(screen.getByRole('button', { name: /% of gain/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Clearing drops the default entirely (blank = today's behavior).
    await user.click(screen.getByRole('button', { name: /^clear$/i }));
    await waitFor(() =>
      expect(updateTaxSettings).toHaveBeenCalledWith({ mode: 'manual_per_trade' }),
    );
  });

  test('the default field stays hidden outside manual mode', async () => {
    renderPanel();
    await screen.findByRole('radio', { name: /No tax tracking/i });
    expect(screen.queryByLabelText(/default manual tax/i)).toBeNull();
  });
});
