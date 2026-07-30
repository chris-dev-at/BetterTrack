import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
}));
vi.mock('../../lib/standingOrdersApi', () => ({}));

import * as portfolioApi from '../../lib/portfolioApi';
import { apiPortfolioStore } from '../../lib/portfolioStore';
import { PortfolioStoreProvider, usePortfolioStore } from './PortfolioStoreProvider';

function Probe() {
  const store = usePortfolioStore();
  return (
    <button
      type="button"
      onClick={() => {
        void store.listPortfolios().then((result) => {
          document.body.dataset.portfolioSource = result.portfolios[0]?.name ?? 'empty';
        });
      }}
    >
      Read portfolios
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  delete document.body.dataset.portfolioSource;
});

test('normal mode preserves endpoint behavior through apiPortfolioStore', async () => {
  vi.mocked(portfolioApi.listPortfolios).mockResolvedValue({
    portfolios: [summary('Normal API')],
  });
  const user = userEvent.setup();
  render(
    <PortfolioStoreProvider>
      <Probe />
    </PortfolioStoreProvider>,
  );

  await user.click(screen.getByRole('button', { name: 'Read portfolios' }));

  await vi.waitFor(() => expect(document.body.dataset.portfolioSource).toBe('Normal API'));
  expect(portfolioApi.listPortfolios).toHaveBeenCalledOnce();
});

test('the account-mode provider selects the unlocked vault adapter without mounting an API read', async () => {
  const vaultList = vi.fn(async () => ({ portfolios: [summary('Encrypted vault')] }));
  const user = userEvent.setup();
  render(
    <PortfolioStoreProvider store={{ ...apiPortfolioStore, listPortfolios: vaultList }}>
      <Probe />
    </PortfolioStoreProvider>,
  );

  await user.click(screen.getByRole('button', { name: 'Read portfolios' }));

  await vi.waitFor(() => expect(document.body.dataset.portfolioSource).toBe('Encrypted vault'));
  expect(vaultList).toHaveBeenCalledOnce();
  expect(portfolioApi.listPortfolios).not.toHaveBeenCalled();
});

function summary(name: string) {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    name,
    visibility: 'private' as const,
    sortOrder: 0,
    isDefault: true,
    defaultPayFromCash: false,
    archivedAt: null,
  };
}
