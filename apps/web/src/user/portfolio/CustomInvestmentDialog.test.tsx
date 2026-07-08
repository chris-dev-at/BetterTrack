import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { CustomInvestmentDialog } from './CustomInvestmentDialog';

function renderDialog() {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<CustomInvestmentDialog onClose={onClose} onCreated={onCreated} today="2026-07-02" />);
  return { onClose, onCreated };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(portfolioApi.createCustomAsset).mockResolvedValue({
    asset: {
      id: 'c1',
      symbol: 'ACME',
      name: 'Acme',
      exchange: null,
      currency: 'EUR',
      type: 'custom',
      isCustom: true,
      category: 'other',
      smoothing: false,
      needsRecategorization: false,
    },
  } as never);
});

describe('CustomInvestmentDialog — V3-P2 category + smoothing', () => {
  test('category select offers the new catalog taxonomy labels', () => {
    renderDialog();
    const select = screen.getByLabelText('Category');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Stocks', 'ETFs', 'Crypto', 'Commodities', 'Cash-like', 'Other']);
    // Default is "Other" (real_estate no longer exists).
    expect((select as HTMLSelectElement).value).toBe('other');
  });

  test('smoothing checkbox defaults off and its value flows into the create body', async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    const smoothing = screen.getByRole('checkbox', { name: 'Smooth values between marks' });
    expect(smoothing).not.toBeChecked();

    await user.type(screen.getByLabelText('Name'), 'Acme Private Shares');
    await user.click(smoothing);
    await user.click(screen.getByRole('button', { name: 'Create investment' }));

    await waitFor(() =>
      expect(vi.mocked(portfolioApi.createCustomAsset)).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Acme Private Shares',
          category: 'other',
          currency: 'EUR',
          smoothing: true,
        }),
      ),
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  test('leaving smoothing off sends smoothing: false', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Name'), 'Gold Bar');
    await user.selectOptions(screen.getByLabelText('Category'), 'commodity');
    await user.click(screen.getByRole('button', { name: 'Create investment' }));

    await waitFor(() =>
      expect(vi.mocked(portfolioApi.createCustomAsset)).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'commodity', smoothing: false }),
      ),
    );
  });
});
