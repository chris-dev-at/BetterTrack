import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Bypass the 300 ms debounce so tests don't need fake timers.
vi.mock('../hooks/useDebounce', () => ({ useDebounce: (v: unknown) => v }));

vi.mock('../../lib/searchApi');
import type { SearchResultItem } from '@bettertrack/contracts';
import * as searchApi from '../../lib/searchApi';
import { CmdKPalette } from './CmdKPalette';

const NVDA: SearchResultItem = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
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
          <Route path="/portfolio/activity" element={<div>Activity page</div>} />
          <Route path="/portfolio/cash-flow" element={<div>Cash flow page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

/** The palette input (a combobox: it owns the keys, the listbox owns the rows). */
function input() {
  return screen.getByRole('combobox', { name: /search bettertrack/i });
}

/** Section headers, in the order they are rendered. */
function sectionOrder(): string[] {
  return screen
    .getAllByRole('group')
    .map((group) => group.getAttribute('aria-labelledby'))
    .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''));
}

/** Navigable option rows, in visual order (the non-interactive notes excluded). */
function navigableRows(): HTMLElement[] {
  return screen
    .getAllByRole('option')
    .filter((row) => row.getAttribute('aria-disabled') !== 'true');
}

function rowLabels(): string[] {
  return navigableRows().map((row) => row.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [] });
});

describe('CmdKPalette', () => {
  test('is not rendered when closed', () => {
    renderPalette({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('is rendered when open, with the universal search input', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByRole('dialog', { name: /quick search/i })).toBeInTheDocument();
    expect(input()).toBeInTheDocument();
  });

  test('the placeholder names everything the palette searches, not just assets', () => {
    renderPalette({ isOpen: true });
    // The old copy ("Search stocks, ETFs, indices…") claimed an asset-only search.
    expect(input()).toHaveAttribute('placeholder', 'Search pages, actions, settings and assets…');
    expect(screen.queryByPlaceholderText(/indices/i)).not.toBeInTheDocument();
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

    await user.click(screen.getByRole('dialog', { name: /quick search/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  test('does not call onClose when clicking inside the panel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    await user.click(input());

    expect(onClose).not.toHaveBeenCalled();
  });

  test('shows the key legend (navigate / open / close)', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByText('Navigate')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText(/to close/i)).toBeInTheDocument();
  });

  test('restores focus to the opener when it closes', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open search
          </button>
          <CmdKPalette isOpen={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'Open search' });
    await user.click(trigger);
    expect(input()).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(trigger).toHaveFocus();
  });
});

describe('default state (empty query)', () => {
  test('offers a curated Suggested group instead of a blank void', () => {
    renderPalette({ isOpen: true });

    expect(sectionOrder()).toEqual(['Suggested']);
    // The registry's `suggested` ranks, in rank order — not registry order.
    expect(rowLabels().length).toBe(6);
    expect(rowLabels()[0]).toContain('Buy or sell');
    expect(rowLabels().join('|')).toContain('Cash flow');
    expect(rowLabels().join('|')).toContain('Control Center');
  });

  test('shows a quiet hint about what is searchable', () => {
    renderPalette({ isOpen: true });
    expect(
      screen.getByText('Pages, actions, settings and market assets — all from here.'),
    ).toBeInTheDocument();
  });

  test('never searches assets before anything is typed', () => {
    renderPalette({ isOpen: true });
    expect(searchApi.searchAssets).not.toHaveBeenCalled();
  });

  test('keeps the gold parked dot on planned destinations', () => {
    renderPalette({ isOpen: true });
    // "Ask BetterTrack" is suggested and parked.
    expect(screen.getAllByRole('img', { name: /planned/i }).length).toBeGreaterThan(0);
  });
});

describe('with a query', () => {
  test('commands come first, assets in their own section underneath', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'cash');
    await screen.findByText('NVDA');

    const order = sectionOrder();
    expect(order[order.length - 1]).toBe('Assets');
    expect(order.slice(0, -1).length).toBeGreaterThan(0);
    // Fixed grouping: creation intents, then destinations, then settings.
    expect(order).toEqual(['Actions', 'Go to', 'Assets']);
  });

  test('every command row precedes every asset row in keyboard order', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'cash');
    await screen.findByText('NVDA');

    const texts = rowLabels();
    const isAsset = (text: string) => text.includes('NVDA');
    const firstAsset = texts.findIndex(isAsset);
    const lastCommand = texts.reduce((last, text, i) => (isAsset(text) ? last : i), -1);
    expect(firstAsset).toBeGreaterThan(-1);
    expect(firstAsset).toBeGreaterThan(lastCommand);
  });

  test('the command sections render before the asset response lands', async () => {
    let release: (value: { results: SearchResultItem[] }) => void = () => {};
    vi.mocked(searchApi.searchAssets).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'cash');

    // Commands are already there while the asset section only says it is busy.
    expect(await screen.findByText('Cash flow')).toBeInTheDocument();
    expect(screen.getByText('Searching assets…')).toBeInTheDocument();
    expect(screen.queryByText('NVDA')).not.toBeInTheDocument();

    release({ results: [NVDA] });
    expect(await screen.findByText('NVDA')).toBeInTheDocument();
  });

  test('asset rows are pure targets — no per-row sub-actions', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'nv');
    await screen.findByText('NVDA');

    // The old palette pasted AssetSearchBox's action strip into every row.
    expect(screen.queryByRole('button', { name: /watchlist/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blueprint/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /record a buy/i })).not.toBeInTheDocument();
    expect(screen.queryByText('→ Portfolio')).not.toBeInTheDocument();
  });

  test('an asset row carries symbol, name, exchange, currency and a type badge', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'nv');

    const row = (await screen.findByText('NVDA')).closest('[role="option"]');
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText(/NVIDIA Corporation · NASDAQ · USD/),
    ).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Stock')).toBeInTheDocument();
  });

  test('clicking an asset row opens its detail page and closes the palette', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    await user.type(input(), 'nv');
    await user.click(await screen.findByText('NVDA'));

    expect(await screen.findByText('Asset detail page')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('one honest line when nothing at all matches', async () => {
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'zzzqqq');

    expect(
      await screen.findByText(/Nothing matched “zzzqqq”/, { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });
});

describe('keyboard', () => {
  test('the first row is active on open and Enter opens it', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    const first = screen.getAllByRole('option')[0]!;
    expect(input()).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');

    expect(await screen.findByText('Activity page')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('arrow keys walk every row in visual order and wrap', async () => {
    const user = userEvent.setup();
    renderPalette({ isOpen: true });
    const rows = screen.getAllByRole('option');

    await user.keyboard('{ArrowDown}');
    expect(input()).toHaveAttribute('aria-activedescendant', rows[1]!.id);

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(input()).toHaveAttribute('aria-activedescendant', rows[rows.length - 1]!.id);

    await user.keyboard('{ArrowDown}');
    expect(input()).toHaveAttribute('aria-activedescendant', rows[0]!.id);
  });

  test('arrows reach the asset rows below the command sections, and Enter opens one', async () => {
    vi.mocked(searchApi.searchAssets).mockResolvedValue({ results: [NVDA] });
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    await user.type(input(), 'cash');
    await screen.findByText('NVDA');

    const rows = navigableRows();
    const assetIndex = rows.findIndex((row) => row.textContent?.includes('NVDA'));
    // Commands are above it: the asset row is never the first keyboard stop.
    expect(assetIndex).toBeGreaterThan(0);

    await user.keyboard('{ArrowDown}'.repeat(assetIndex));
    expect(input()).toHaveAttribute('aria-activedescendant', rows[assetIndex]!.id);

    await user.keyboard('{Enter}');

    expect(await screen.findByText('Asset detail page')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('a non-interactive section note is never a keyboard stop', async () => {
    let release: (value: { results: SearchResultItem[] }) => void = () => {};
    vi.mocked(searchApi.searchAssets).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPalette({ isOpen: true });

    await user.type(input(), 'cash');
    await screen.findByText('Searching assets…');

    const note = screen.getByText('Searching assets…');
    expect(note).toHaveAttribute('aria-disabled', 'true');

    // Walk the whole list: aria-activedescendant never points at the note.
    for (let i = 0; i < rowLabels().length + 2; i += 1) {
      expect(input().getAttribute('aria-activedescendant')).not.toBe(note.id);
      await user.keyboard('{ArrowDown}');
    }

    release({ results: [] });
    expect(await screen.findByText('No assets matched.')).toBeInTheDocument();
  });
});

describe('⌘K / Ctrl-K shortcut (OriginShell integration)', () => {
  test('the palette component does not self-open (open state is owned by the shell)', () => {
    renderPalette({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
