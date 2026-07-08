import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi');
import * as portfolioApi from '../../lib/portfolioApi';

import { ValuePointEditor, type ValuePointEditorAsset } from './ValuePointEditor';

const ASSET: ValuePointEditorAsset = {
  id: 'c1',
  symbol: 'ACME',
  name: 'Acme Private Shares',
  currency: 'EUR',
  category: 'other',
  smoothing: false,
};

function renderEditor(asset: ValuePointEditorAsset = ASSET) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ValuePointEditor asset={asset} onClose={onClose} onSaved={onSaved} today="2026-07-02" />
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(portfolioApi.getValuePoints).mockResolvedValue({ points: [] });
  vi.mocked(portfolioApi.putValuePoints).mockResolvedValue([]);
  vi.mocked(portfolioApi.updateCustomAsset).mockResolvedValue({} as never);
});

describe('ValuePointEditor — V3-P2 category + smoothing', () => {
  test('seeds the category select and smoothing checkbox from the asset', async () => {
    renderEditor({ ...ASSET, category: 'stock', smoothing: true });
    const select = (await screen.findByLabelText('Category')) as HTMLSelectElement;
    expect(select.value).toBe('stock');
    expect(screen.getByRole('checkbox', { name: 'Smooth values between marks' })).toBeChecked();
  });

  test('changing category + smoothing calls updateCustomAsset, then putValuePoints', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderEditor();

    const select = await screen.findByLabelText('Category');
    await user.selectOptions(select, 'stock');
    await user.click(screen.getByRole('checkbox', { name: 'Smooth values between marks' }));
    await user.click(screen.getByRole('button', { name: 'Save value points' }));

    await waitFor(() =>
      expect(vi.mocked(portfolioApi.updateCustomAsset)).toHaveBeenCalledWith('c1', {
        category: 'stock',
        smoothing: true,
      }),
    );
    expect(vi.mocked(portfolioApi.putValuePoints)).toHaveBeenCalledWith('c1', []);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test('no metadata change skips updateCustomAsset and only replaces value points', async () => {
    const user = userEvent.setup();
    renderEditor();

    // Wait for the seeded controls, then save without touching category/smoothing.
    await screen.findByLabelText('Category');
    await user.click(screen.getByRole('button', { name: 'Save value points' }));

    await waitFor(() =>
      expect(vi.mocked(portfolioApi.putValuePoints)).toHaveBeenCalledWith('c1', []),
    );
    expect(vi.mocked(portfolioApi.updateCustomAsset)).not.toHaveBeenCalled();
  });

  test('a failed metadata update surfaces the save-error alert', async () => {
    vi.mocked(portfolioApi.updateCustomAsset).mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    const { onSaved } = renderEditor();

    await screen.findByLabelText('Category');
    await user.selectOptions(screen.getByLabelText('Category'), 'etf');
    await user.click(screen.getByRole('button', { name: 'Save value points' }));

    expect(await screen.findByText(/Could not save value points/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
