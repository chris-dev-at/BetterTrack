import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AskDock } from './AskDock';
import { resetAskDockCache, toggleAskDock, useAskDockOpen } from './askDockStore';
import { ASK_DOCK_MIN_WIDTH, useAskDockEligible } from './useAskDockEligible';

const STORAGE_KEY = 'bt.askdock';

/**
 * Stands in for the rail's Ask row, which is what opens the panel now — the same
 * store + eligibility hooks `OriginShell` wires into that row. (The row itself,
 * inside the real rail, is covered by AppShell.test.tsx.)
 */
function RailAskRow() {
  const open = useAskDockOpen();
  const eligible = useAskDockEligible();
  if (!eligible) return <a href="/ask">Ask BetterTrack</a>;
  return (
    <button aria-expanded={open} onClick={toggleAskDock} type="button">
      Ask BetterTrack
    </button>
  );
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/portfolio']}>
      <RailAskRow />
      <AskDock />
    </MemoryRouter>,
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width, writable: true });
}

const originalWidth = window.innerWidth;

const trigger = () => screen.getByRole('button', { name: 'Ask BetterTrack' });
const panel = () => screen.queryByRole('complementary', { name: 'Ask BetterTrack panel' });

beforeEach(() => {
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

  test('the close button dismisses the panel', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Close Ask BetterTrack' }));

    await waitFor(() => expect(panel()).toBeNull());
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
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('open'));

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

describe('AskDock — below the panel breakpoint', () => {
  test('the trigger stays a link to /ask and the panel never opens', () => {
    setViewportWidth(ASK_DOCK_MIN_WIDTH - 100);
    localStorage.setItem(STORAGE_KEY, 'open');
    resetAskDockCache();

    renderShell();

    expect(screen.getByRole('link', { name: 'Ask BetterTrack' })).toHaveAttribute('href', '/ask');
    expect(screen.queryByRole('button', { name: 'Ask BetterTrack' })).toBeNull();
    expect(panel()).toBeNull();
  });
});
