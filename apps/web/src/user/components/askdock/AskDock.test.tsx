import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('../../../lib/aiApi', () => ({
  AI_CAPABILITY_QUERY_KEY: ['ai', 'capability'],
  useAiCapability: vi.fn(),
}));

import { useAiCapability } from '../../../lib/aiApi';
import { ASK_DOCK_ID, AskDock } from './AskDock';
import { resetAskDockCache, toggleAskDock, useAskDockState } from './askDockStore';
import { ASK_DOCK_MIN_WIDTH, useAskDockAvailable } from './useAskDockEligible';

const STORAGE_KEY = 'bt.askdock';

/** What the store wrote, parsed — the persisted record the panel round-trips. */
function persisted(): unknown {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/**
 * Stands in for the rail's Ask row, which is what opens the panel now — the same
 * store + eligibility hooks `OriginShell` wires into that row, including the
 * `aria-controls` link the panel's click-away guard uses to recognise its own
 * trigger. (The row itself, inside the real rail, is covered by AppShell.test.tsx.)
 */
function RailAskRow() {
  const { open } = useAskDockState();
  const available = useAskDockAvailable();
  if (!available) return <a href="/ask">Ask BetterTrack</a>;
  return (
    <button aria-controls={ASK_DOCK_ID} aria-expanded={open} onClick={toggleAskDock} type="button">
      Ask BetterTrack
    </button>
  );
}

/** The shell's gated mount: no local AI provider ⇒ the panel is never mounted. */
function AskDockMount() {
  const available = useAskDockAvailable();
  if (!available) return null;
  return <AskDock />;
}

/** A click target on the "page" underneath, to prove outside clicks still land. */
const pageClick = vi.fn();

function renderShell(extra?: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/portfolio']}>
        <RailAskRow />
        <button onClick={pageClick} type="button">
          Page button
        </button>
        {extra}
        <AskDockMount />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The capability descriptor the panel keys its whole existence off (§6.18). */
const AI_AVAILABLE = {
  available: true,
  model: 'llama3.1:8b',
  dailyCap: 20,
  used: 0,
  remaining: 20,
};

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true });
}

const originalWidth = window.innerWidth;

const trigger = () => screen.getByRole('button', { name: 'Ask BetterTrack' });
const panel = () => screen.queryByRole('complementary', { name: 'Ask BetterTrack panel' });
// Both labels, because each control names the action it will perform next.
const pinButton = () => screen.getByRole('button', { name: /^(Keep open|Stop keeping open)$/ });
const sizeButton = () => screen.getByRole('button', { name: /^(Maximize|Restore size)$/ });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAiCapability).mockReturnValue({ data: AI_AVAILABLE } as never);
  localStorage.clear();
  resetAskDockCache();
  setViewportWidth(1280); // a desktop viewport: the panel is eligible
});

afterEach(() => {
  setViewportWidth(originalWidth);
  localStorage.clear();
  resetAskDockCache();
});

describe('AskDock — the rail row toggles the floating panel', () => {
  test('opens and closes from the trigger, reporting aria-expanded', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).toBeNull();

    await user.click(trigger());
    await waitFor(() => expect(panel()).toBeInTheDocument());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    await user.click(trigger());
    await waitFor(() => expect(panel()).toBeNull());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  test('the close button dismisses the panel and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Close Ask BetterTrack' }));

    await waitFor(() => expect(panel()).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  test('Escape closes the panel while focus is inside it', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(trigger());
    (await screen.findByRole('button', { name: 'Close Ask BetterTrack' })).focus();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(panel()).toBeNull());
  });

  test('is NON-MODAL: no scrim, no aria-modal, no scroll lock', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();

    await user.click(trigger());
    await waitFor(() => expect(panel()).toBeInTheDocument());

    // The page underneath must stay fully interactive — that is the point.
    expect(container.querySelector('.bt-scrim')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  test('the open state persists and is restored on mount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderShell();

    await user.click(trigger());
    await waitFor(() => expect(persisted()).toMatchObject({ open: true }));

    // A fresh mount (a reload) reads it back out of storage and reopens.
    unmount();
    resetAskDockCache();
    renderShell();
    await waitFor(() => expect(panel()).toBeInTheDocument());
  });

  test('unparseable persisted state degrades to a closed panel', () => {
    localStorage.setItem(STORAGE_KEY, 'whatever');
    resetAskDockCache();

    renderShell();

    expect(panel()).toBeNull();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  test('a payload with unknown fields keeps the flags it does understand', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ open: true, pinned: true, somethingNewer: { deep: 1 } }),
    );
    resetAskDockCache();

    renderShell();

    expect(panel()).toBeInTheDocument();
    expect(pinButton()).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('AskDock — click-away', () => {
  test('an outside click closes the panel, and still reaches the page', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());
    await waitFor(() => expect(panel()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Page button' }));

    await waitFor(() => expect(panel()).toBeNull());
    // Nothing was swallowed: the click that dismissed the panel did its own job.
    expect(pageClick).toHaveBeenCalledTimes(1);
  });

  test('a click inside the panel keeps it open', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());

    await user.click(await screen.findByText('In the works'));

    expect(panel()).toBeInTheDocument();
  });

  test('a click inside a dialog the panel opened keeps it open', async () => {
    const user = userEvent.setup();
    // Portalled overlays live outside the panel's subtree, so `contains` alone
    // would treat them as "outside" and close the panel underneath them.
    renderShell(
      <div role="dialog">
        <button type="button">Dialog action</button>
      </div>,
    );
    await user.click(trigger());
    await waitFor(() => expect(panel()).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Dialog action' }));

    expect(panel()).toBeInTheDocument();
  });

  test('pinned: outside clicks are ignored', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());
    await user.click(pinButton());

    await user.click(screen.getByRole('button', { name: 'Page button' }));

    expect(panel()).toBeInTheDocument();
    expect(pageClick).toHaveBeenCalledTimes(1);
  });

  test('pinned: Escape still closes — the pin is about stray clicks', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());
    await user.click(pinButton());

    await user.keyboard('{Escape}');

    await waitFor(() => expect(panel()).toBeNull());
    // …and the preference survives the dismissal.
    expect(persisted()).toMatchObject({ open: false, pinned: true });
  });
});

describe('AskDock — the pin is a persistent preference', () => {
  test('pin, close with the ✕, reopen → still pinned (the owner scenario)', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(trigger());
    await user.click(pinButton());
    expect(pinButton()).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Close Ask BetterTrack' }));
    await waitFor(() => expect(panel()).toBeNull());
    // Closing must not clear the preference.
    expect(persisted()).toMatchObject({ open: false, pinned: true });

    await user.click(trigger());

    await waitFor(() => expect(panel()).toBeInTheDocument());
    expect(pinButton()).toHaveAttribute('aria-pressed', 'true');
    // Still pinned means still immune to outside clicks.
    await user.click(screen.getByRole('button', { name: 'Page button' }));
    expect(panel()).toBeInTheDocument();
  });

  test('the pin survives a remount (a page reload)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderShell();

    await user.click(trigger());
    await user.click(pinButton());
    await waitFor(() => expect(persisted()).toMatchObject({ pinned: true }));

    unmount();
    resetAskDockCache();
    renderShell();

    await waitFor(() => expect(panel()).toBeInTheDocument());
    expect(pinButton()).toHaveAttribute('aria-pressed', 'true');
  });

  test('unpinning restores click-away', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());

    await user.click(pinButton()); // pinned
    await user.click(pinButton()); // unpinned again
    expect(pinButton()).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Page button' }));

    await waitFor(() => expect(panel()).toBeNull());
  });
});

describe('AskDock — maximize', () => {
  test('toggles the centered popup geometry and reports aria-pressed', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());

    expect(panel()).not.toHaveClass('bt-askdock--max');
    expect(sizeButton()).toHaveAttribute('aria-pressed', 'false');

    await user.click(sizeButton());

    expect(panel()).toHaveClass('bt-askdock--max');
    expect(sizeButton()).toHaveAttribute('aria-pressed', 'true');
    // The label flips to the way out, so the control is never a dead end.
    expect(screen.getByRole('button', { name: 'Restore size' })).toBeInTheDocument();

    await user.click(sizeButton());

    expect(panel()).not.toHaveClass('bt-askdock--max');
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument();
  });

  test('maximized stays NON-MODAL: no scrim, no aria-modal, click-away applies', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(trigger());
    await user.click(sizeButton());
    expect(panel()).toHaveClass('bt-askdock--max');

    expect(container.querySelector('.bt-scrim')).toBeNull();
    expect(panel()).not.toHaveAttribute('aria-modal');
    expect(document.body.style.overflow).not.toBe('hidden');

    // Maximize is about size, not about trapping the user.
    await user.click(screen.getByRole('button', { name: 'Page button' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(pageClick).toHaveBeenCalledTimes(1);
  });

  test('the size survives close→reopen and a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = renderShell();

    await user.click(trigger());
    await user.click(sizeButton());
    await waitFor(() => expect(persisted()).toMatchObject({ maximized: true }));

    await user.click(screen.getByRole('button', { name: 'Close Ask BetterTrack' }));
    await waitFor(() => expect(panel()).toBeNull());
    expect(persisted()).toMatchObject({ open: false, maximized: true });

    unmount();
    resetAskDockCache();
    renderShell();
    await user.click(trigger());

    await waitFor(() => expect(panel()).toHaveClass('bt-askdock--max'));
  });

  test('pin and maximize are independent flags in one record', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());

    await user.click(pinButton());
    await user.click(sizeButton());

    expect(persisted()).toEqual({ open: true, pinned: true, maximized: true });
  });
});

describe('AskDock — AI only', () => {
  test('holds the parked Ask surface and no chat at all', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());

    // The /ask parked copy, reused verbatim — no invented AI claims.
    expect(await screen.findByText('In the works')).toBeInTheDocument();
    expect(
      screen.getByText(/You choose exactly which portfolios the answer may read/),
    ).toBeInTheDocument();

    // No tab strip and no friend chat: those are separate things now.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull();
    expect(screen.queryByText('Messages')).toBeNull();
  });

  test('the composer is present but inert — no fake AI conversation', async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(trigger());

    const input = await screen.findByPlaceholderText('Ask about your portfolios');
    expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await user.type(input, 'what is my exposure?');
    expect(input).toHaveValue('');
  });
});

describe('AskDock — with no local AI provider configured', () => {
  test('the AI panel does not exist and the rail row stays a link to /ask (§6.18)', () => {
    vi.mocked(useAiCapability).mockReturnValue({
      data: { ...AI_AVAILABLE, available: false },
    } as never);
    // Even a persisted "open, pinned" panel stays gone: availability is the gate.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, pinned: true }));
    resetAskDockCache();

    renderShell();

    expect(screen.getByRole('link', { name: 'Ask BetterTrack' })).toHaveAttribute('href', '/ask');
    expect(screen.queryByRole('button', { name: 'Ask BetterTrack' })).toBeNull();
    expect(panel()).toBeNull();
  });
});

describe('AskDock — below the panel breakpoint', () => {
  test('the trigger stays a link to /ask and the panel never opens', () => {
    setViewportWidth(ASK_DOCK_MIN_WIDTH - 100);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ open: true, pinned: true }));
    resetAskDockCache();

    renderShell();

    expect(screen.getByRole('link', { name: 'Ask BetterTrack' })).toHaveAttribute('href', '/ask');
    expect(screen.queryByRole('button', { name: 'Ask BetterTrack' })).toBeNull();
    expect(panel()).toBeNull();
  });
});
