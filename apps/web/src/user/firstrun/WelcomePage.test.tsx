import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi');
vi.mock('../../lib/twoFactorApi');
vi.mock('../../lib/settingsApi');
vi.mock('../../lib/socialApi');
vi.mock('../../lib/portfolioApi');
vi.mock('../../lib/workboardApi', () => ({
  WORKBOARD_QUERY_KEY: ['workboard'],
  listWorkboard: vi.fn(),
  addToWorkboard: vi.fn(),
  removeFromWorkboard: vi.fn(),
  reorderWorkboard: vi.fn(),
}));

import * as settingsApi from '../../lib/settingsApi';
import * as socialApi from '../../lib/socialApi';
import * as twoFactorApi from '../../lib/twoFactorApi';
import * as api from '../../lib/userApi';
import { listWorkboard } from '../../lib/workboardApi';
import { UserApp, queryClient } from '../UserApp';
import { readFirstRun } from './firstRunStorage';
import { FIRST_RUN_STEP_META } from './stepMeta';
import { FIRST_RUN_STEPS } from './steps';

const user: MeResponse = {
  id: '8d7cf3d6-e8b8-4fa4-98a4-8712cddc05bf',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderWelcome() {
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <Routes>
        <Route path="/*" element={<UserApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  // The query client is an app-module singleton — drop cached step reads so each
  // case starts from its own mocks rather than the previous case's response.
  queryClient.clear();

  vi.mocked(api.getMe).mockResolvedValue(user);
  vi.mocked(api.getParanoidMediaState).mockResolvedValue({
    privacyMode: 'normal',
    mediaState: null,
  });
  vi.mocked(listWorkboard).mockResolvedValue({ items: [] });
  // Every step's read: a brand-new account, nothing configured yet.
  vi.mocked(api.getGoogleLinkStatus).mockResolvedValue({
    enabled: false,
    linked: false,
    email: null,
    linkedAt: null,
    canUnlink: false,
  });
  vi.mocked(twoFactorApi.getTwoFactorStatus).mockResolvedValue({
    totpEnabled: false,
    totpPending: false,
    emailEnabled: false,
    recoveryCodesRemaining: 0,
  });
  vi.mocked(settingsApi.getAccountSettings).mockResolvedValue({
    defaultPortfolioVisibility: 'private',
    locale: 'en',
    baseCurrency: 'EUR',
    discreetMode: false,
  });
  vi.mocked(settingsApi.getTaxSettings).mockResolvedValue({ mode: 'none', country: null });
  vi.mocked(socialApi.getProfileSettings).mockResolvedValue({
    username: 'jane',
    isPublic: false,
    bio: null,
    publicItemCount: 0,
    profileIcon: null,
  });
});

/** Advance past the current step with the frame's gold CTA. */
async function clickContinue(u: ReturnType<typeof userEvent.setup>) {
  await u.click(screen.getByRole('button', { name: 'Continue' }));
}

// ── The registry drives the frame ────────────────────────────────────────────

test('the wizard opens on the first registered step and counts the registry', async () => {
  renderWelcome();

  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
  expect(screen.getByText(`Step 1 of ${FIRST_RUN_STEPS.length}`, { exact: false })).toBeVisible();
  // The frame renders one question at a time — the next step's is not mounted.
  expect(screen.queryByRole('heading', { name: 'Add a second lock?' })).not.toBeInTheDocument();
});

test('the registry and the step metadata stay in lockstep', () => {
  expect(FIRST_RUN_STEPS.map((step) => step.id)).toEqual(
    FIRST_RUN_STEP_META.map((meta) => meta.id),
  );
  // Every registered step is actually wired to a component.
  for (const step of FIRST_RUN_STEPS) expect(step.Component).toBeTypeOf('function');
  // Exactly one terminal step, and it is last.
  const terminals = FIRST_RUN_STEPS.filter((step) => step.terminal);
  expect(terminals).toHaveLength(1);
  expect(FIRST_RUN_STEPS.at(-1)?.terminal).toBe(true);
});

test('Continue walks the registry in order and Back returns', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  await clickContinue(u);
  expect(await screen.findByRole('heading', { name: 'Verify your email' })).toBeInTheDocument();

  await u.click(screen.getByRole('button', { name: 'Back' }));
  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
  // First step: nothing to go back to.
  expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
});

// ── Per-step complete / skipped persistence ──────────────────────────────────

test('walking past a step records it as skipped, and a satisfied step as complete', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  // Profile is a confirmation — seeing it completes it.
  await clickContinue(u);
  await waitFor(() => expect(readFirstRun(user.id).steps.profile).toBe('complete'));

  // A password account has nothing to verify against yet — parked, so skipped.
  await screen.findByRole('heading', { name: 'Verify your email' });
  await clickContinue(u);
  await waitFor(() => expect(readFirstRun(user.id).steps.verifyEmail).toBe('skipped'));

  // Neither lock set → skipped.
  await screen.findByRole('heading', { name: 'Add a second lock?' });
  await clickContinue(u);
  await waitFor(() => expect(readFirstRun(user.id).steps.security).toBe('skipped'));
});

test('a Google-verified account completes the email step without any code entry', async () => {
  vi.mocked(api.getGoogleLinkStatus).mockResolvedValue({
    enabled: true,
    linked: true,
    email: 'jane@bettertrack.test',
    linkedAt: '2026-01-01T00:00:00.000Z',
    canUnlink: true,
  });
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });
  await clickContinue(u);

  await screen.findByRole('heading', { name: 'Verify your email' });
  expect(await screen.findByText(/already verified through Google/i)).toBeInTheDocument();
  expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();

  await clickContinue(u);
  await waitFor(() => expect(readFirstRun(user.id).steps.verifyEmail).toBe('complete'));
});

test('setting a PIN through the real endpoint completes the security step', async () => {
  vi.mocked(api.setPin).mockResolvedValue({ ...user, pinEnabled: true });
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Verify your email' });
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Add a second lock?' });

  // Both offers are visible and neither is expanded — one thing at a time.
  expect(screen.getByText('App PIN')).toBeInTheDocument();
  expect(screen.getByText('Two-factor authentication')).toBeInTheDocument();
  await u.click(screen.getAllByRole('button', { name: 'Set up' })[0] as HTMLElement);

  for (const [index, digit] of [...'1234'].entries()) {
    const label = index === 0 ? 'New PIN' : `New PIN digit ${index + 1}`;
    await u.type(screen.getByLabelText(label), digit);
  }
  for (const [index, digit] of [...'1234'].entries()) {
    const label = index === 0 ? 'Confirm PIN' : `Confirm PIN digit ${index + 1}`;
    await u.type(screen.getByLabelText(label), digit);
  }
  await u.click(screen.getByRole('button', { name: 'Save PIN' }));

  await waitFor(() => expect(api.setPin).toHaveBeenCalledWith({ pin: '1234' }));
  // The row flips to "On" and the step now counts as complete.
  expect(await screen.findByText('On')).toBeInTheDocument();
  await clickContinue(u);
  await waitFor(() => expect(readFirstRun(user.id).steps.security).toBe('complete'));
});

test('a mismatched PIN confirmation never reaches the server', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Verify your email' });
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Add a second lock?' });
  await u.click(screen.getAllByRole('button', { name: 'Set up' })[0] as HTMLElement);

  for (const [index, digit] of [...'1234'].entries()) {
    const label = index === 0 ? 'New PIN' : `New PIN digit ${index + 1}`;
    await u.type(screen.getByLabelText(label), digit);
  }
  for (const [index, digit] of [...'9999'].entries()) {
    const label = index === 0 ? 'Confirm PIN' : `Confirm PIN digit ${index + 1}`;
    await u.type(screen.getByLabelText(label), digit);
  }
  await u.click(screen.getByRole('button', { name: 'Save PIN' }));

  expect(await screen.findByText('The two PINs do not match.')).toBeInTheDocument();
  expect(api.setPin).not.toHaveBeenCalled();
});

// ── The side step rail ───────────────────────────────────────────────────────

/** The rail row for a step, by its visible label. */
function railRow(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

/** The EN rail labels, in registry order. */
const RAIL_LABELS = ['You', 'Email', 'Security', 'Preferences', 'Tax', 'Profile', 'Done'] as const;

test('the rail lists every registered step up front, current marked, rest upcoming', async () => {
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  // The whole run is visible, so it reads as bounded rather than open-ended —
  // and the rail is driven by the registry, so this covers every step there is.
  expect(RAIL_LABELS).toHaveLength(FIRST_RUN_STEP_META.length);
  for (const label of RAIL_LABELS) expect(railRow(label)).toBeInTheDocument();

  expect(railRow('You')).toHaveAttribute('data-state', 'current');
  expect(railRow('You')).toHaveAttribute('aria-current', 'step');
  // Everything ahead is upcoming and inert — not a dead-looking link.
  expect(railRow('Security')).toHaveAttribute('data-state', 'upcoming');
  expect(railRow('Security')).toBeDisabled();
  expect(railRow('Done')).toBeDisabled();
});

test('the rail distinguishes done from skipped', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  // Profile completes itself; the parked email step does not.
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Verify your email' });
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Add a second lock?' });

  expect(railRow('You')).toHaveAttribute('data-state', 'done');
  // Skipped is deliberately NOT the done state — passing over something must
  // never read as having handled it.
  expect(railRow('Email')).toHaveAttribute('data-state', 'skipped');
  expect(railRow('Security')).toHaveAttribute('data-state', 'current');
});

test('a visited rail row navigates back; an unreached one does nothing', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });
  await clickContinue(u);
  await clickContinue(u);
  await screen.findByRole('heading', { name: 'Add a second lock?' });

  // Clicking a completed row jumps back to it.
  await u.click(railRow('You'));
  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
  // …and the steps ahead are upcoming again.
  expect(railRow('Security')).toHaveAttribute('data-state', 'upcoming');

  // An unreached row is inert: clicking it leaves the question alone.
  await u.click(railRow('Tax'));
  expect(screen.getByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
});

test('each step renders exactly one figure, and it is hidden from assistive tech', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  for (let i = 0; i < FIRST_RUN_STEPS.length; i += 1) {
    const figures = document.querySelectorAll('.bt-frfig');
    // One per step — a figure, never a gallery.
    expect(figures).toHaveLength(1);
    expect(figures[0]).toHaveAttribute('aria-hidden', 'true');
    if (i < FIRST_RUN_STEPS.length - 1) await clickContinue(u);
  }
});

// ── Leaving the wizard ───────────────────────────────────────────────────────

test('"Do this later" closes the run out and hands over the app', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  await u.click(screen.getByRole('button', { name: 'Do this later' }));

  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(readFirstRun(user.id).done).toBe(true);
});

test('the last step summarises what was set versus deferred, then opens the app', async () => {
  const u = userEvent.setup();
  renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });

  // Walk the whole registry without configuring anything.
  for (let i = 0; i < FIRST_RUN_STEPS.length - 1; i += 1) await clickContinue(u);

  expect(await screen.findByRole('heading', { name: 'You are set up' })).toBeInTheDocument();
  // Profile confirmed itself; the parked email step did not. Scoped to the step
  // body — the step rail is a list too, and its rows come first in the document.
  const body = document.querySelector('.bt-fr__body') as HTMLElement;
  const rows = within(body).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('Set');
  expect(rows[1]).toHaveTextContent('Later');
  // The terminal step offers no "later" — there is nothing left to defer.
  expect(screen.queryByRole('button', { name: 'Do this later' })).not.toBeInTheDocument();

  await u.click(screen.getByRole('button', { name: 'Go to BetterTrack' }));
  expect(await screen.findByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  expect(readFirstRun(user.id).done).toBe(true);
});

test('/welcome is re-runnable: a finished run reopens at the first step', async () => {
  const u = userEvent.setup();
  const first = renderWelcome();
  await screen.findByRole('heading', { name: 'Is this you?' });
  await u.click(screen.getByRole('button', { name: 'Do this later' }));
  await screen.findByRole('button', { name: 'Account menu' });
  expect(readFirstRun(user.id).done).toBe(true);
  first.unmount();

  renderWelcome();
  // Not a one-shot gate: the run simply starts again from the top.
  expect(await screen.findByRole('heading', { name: 'Is this you?' })).toBeInTheDocument();
});
