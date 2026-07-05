import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Bypass the 300 ms debounce so tests don't need fake timers.
vi.mock('../hooks/useDebounce', () => ({ useDebounce: (v: unknown) => v }));

vi.mock('../../lib/searchApi');
vi.mock('../../lib/workboardApi');
import type { SearchResultItem } from '@bettertrack/contracts';
import * as searchApi from '../../lib/searchApi';
import * as workboardApi from '../../lib/workboardApi';
import { CmdKPalette } from './CmdKPalette';

const NVDA: SearchResultItem = {
  id: 'asset-nvda',
  providerId: 'yahoo',
  providerRef: 'NVDA',
  symbol: 'NVDA',
  name: 'NVIDIA Corporation',
  exchange: 'NASDAQ',
  type: 'stock',
  currency: 'USD',
  isCustom: false,
};

function renderPalette(props: { isOpen: boolean; onClose?: () => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<CmdKPalette isOpen={props.isOpen} onClose={onClose} />} />
          <Route path="/assets/:id" element={<div>Asset detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workboardApi.listWorkboard).mockResolvedValue({ items: [] });
});

describe('CmdKPalette', () => {
  test('is not rendered when closed', () => {
    renderPalette({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('is rendered when open', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByRole('dialog', { name: /quick search/i })).toBeInTheDocument();
  });

  test('contains the asset search input when open', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByRole('searchbox', { name: /search assets/i })).toBeInTheDocument();
  });

  test('calls onClose when Escape is pressed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  test('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    // The backdrop is the dialog element itself (the outermost div with role="dialog")
    await user.click(screen.getByRole('dialog', { name: /quick search/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  test('does not call onClose when clicking inside the dialog panel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    // Click the search input — inside the panel, not the backdrop
    await user.click(screen.getByRole('searchbox'));

    expect(onClose).not.toHaveBeenCalled();
  });

  test('shows the Esc hint', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByText(/esc/i)).toBeInTheDocument();
  });
});

describe('⌘K / Ctrl-K shortcut (AppLayout integration)', () => {
  test('the palette component does not self-open (open state is owned by the parent)', () => {
    renderPalette({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('direct actions parity (§13.2 — reuses AssetSearchBox)', () => {
  test('clicking a result opens its asset detail page and closes the palette', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');
    await user.click(screen.getByRole('button', { name: /open nvda/i }));

    expect(await screen.findByText('Asset detail page')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('every direct action from AssetSearchBox is available inside the palette', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(screen.getByRole('searchbox'), 'NV');
    await screen.findByText('NVDA');

    expect(screen.getByRole('button', { name: /add nvda to watchlist/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add nvda to a conglomerate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record a buy for nvda/i })).toBeInTheDocument();
  });
});
