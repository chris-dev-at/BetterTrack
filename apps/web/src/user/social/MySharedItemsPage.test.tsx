import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { MySharedResponse } from '@bettertrack/contracts';

vi.mock('../../lib/socialApi', () => ({
  listMyShared: vi.fn(),
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  listGroups: vi.fn(),
  setAudience: vi.fn(),
}));

vi.mock('../../lib/alertsApi', () => ({
  ALERT_SHARING_QUERY_KEY: ['alerts', 'sharing'],
  getAlertSharing: vi.fn(),
  updateAlertSharing: vi.fn(),
}));

vi.mock('../../lib/portfolioApi', () => ({
  listPortfolios: vi.fn(),
}));

import {
  getAudience,
  listFriends,
  listGroups,
  listMyShared,
  setAudience,
} from '../../lib/socialApi';
import { getAlertSharing, updateAlertSharing } from '../../lib/alertsApi';
import { listPortfolios } from '../../lib/portfolioApi';
import { setViewportWidth } from '../../test/viewport';
import { MutationFeedbackProvider } from '../hooks/useMutationFeedback';
import { MySharedItemsPage } from './MySharedItemsPage';

const PORTFOLIO_ID = '00000000-0000-0000-0000-000000000001';
const CONGLOMERATE_ID = '00000000-0000-0000-0000-0000000000e1';
const WATCHLIST_ID = '00000000-0000-0000-0000-0000000000c1';

const EMPTY: MySharedResponse = { portfolios: [], conglomerates: [], watchlists: [], ideas: [] };

const WITH_PORTFOLIO: MySharedResponse = {
  portfolios: [
    { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'all_friends', friendCount: 0 },
  ],
  conglomerates: [],
  watchlists: [],
  ideas: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function portfolioList(mirror = false): Awaited<ReturnType<typeof listPortfolios>> {
  return {
    portfolios: [
      {
        id: PORTFOLIO_ID,
        name: 'Main',
        visibility: 'private',
        sortOrder: 0,
        isDefault: true,
        defaultPayFromCash: false,
        archivedAt: null,
        ...(mirror
          ? {
              mirror: {
                chainId: '00000000-0000-0000-0000-0000000000c1',
                chainName: 'Household',
                role: 'owner' as const,
                memberCount: 2,
                sync: { appliedSeq: 4, lastSeq: 4, percent: 100, synced: true },
              },
            }
          : {}),
      },
    ],
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MutationFeedbackProvider>
          <MySharedItemsPage />
        </MutationFeedbackProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'portfolio',
    subjectId: PORTFOLIO_ID,
    audience: 'all_friends',
    friendIds: [],
    groupId: null,
    link: { active: false, createdAt: null },
  });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
  vi.mocked(getAlertSharing).mockResolvedValue({ visibleToFollowers: false });
  // MIRRORCHAIN §10 (V5-P7 M5): the page cross-references the portfolios list
  // to know which shared portfolios are synced copies of an active chain — the
  // default is an empty list so the notice stays off for these tests.
  vi.mocked(listPortfolios).mockResolvedValue({ portfolios: [] });
});

describe('MySharedItemsPage', () => {
  test('uses Shared items as the page heading', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Shared items' })).toBeInTheDocument();
  });

  test('keeps portfolio sharing disabled while MIRRORCHAIN metadata is pending', async () => {
    const read = deferred<Awaited<ReturnType<typeof listPortfolios>>>();
    vi.mocked(listMyShared).mockResolvedValue(WITH_PORTFOLIO);
    vi.mocked(listPortfolios).mockReturnValue(read.promise);
    renderPage();

    const share = await screen.findByRole('button', { name: 'Share' });
    expect(screen.getByText('Checking group-portfolio privacy…')).toBeInTheDocument();
    expect(share).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await act(async () => {
      read.resolve(portfolioList());
    });

    await waitFor(() => expect(share).toBeEnabled());
  });

  test('retries failed MIRRORCHAIN metadata before opening a live, authoritative picker', async () => {
    vi.mocked(listMyShared).mockResolvedValue(WITH_PORTFOLIO);
    vi.mocked(listPortfolios)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(portfolioList(true));
    const user = userEvent.setup();
    renderPage();

    const share = await screen.findByRole('button', { name: 'Share' });
    expect(
      await screen.findByText(
        "Could not verify this portfolio's group-sharing notice. Try again before sharing it.",
      ),
    ).toBeInTheDocument();
    expect(share).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(share).toBeEnabled());
    await user.click(share);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText(/others in this group portfolio will remain visible to you/i),
    ).toBeInTheDocument();
    expect(listPortfolios).toHaveBeenCalledTimes(2);
  });

  test('retries a failed item-list read in place', async () => {
    vi.mocked(listMyShared)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(EMPTY);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText("You don't own anything yet")).toBeInTheDocument();
    expect(listMyShared).toHaveBeenCalledTimes(2);
  });

  test('shows an empty state when the caller owns nothing', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    renderPage();
    await waitFor(() => expect(screen.getByText("You don't own anything yet")).toBeInTheDocument());
  });

  test('lists shared portfolios and watchlists with a who-sees-this summary and opens the AudiencePicker', async () => {
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'all_friends', friendCount: 0 },
      ],
      conglomerates: [],
      watchlists: [
        {
          watchlistId: WATCHLIST_ID,
          name: 'General',
          audience: 'public_link',
          itemCount: 3,
          friendCount: 0,
        },
      ],
      ideas: [],
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Main')).toBeInTheDocument());
    expect(screen.getByText('General')).toBeInTheDocument();
    // The per-item "who can see this" summary renders (portfolio → All friends,
    // watchlist → Public link).
    expect(screen.getByText('All friends')).toBeInTheDocument();
    expect(screen.getByText('Public link')).toBeInTheDocument();

    // Clicking Share opens the reusable picker dialog.
    const user = userEvent.setup();
    const share = screen.getAllByRole('button', { name: /share/i })[0]!;
    await waitFor(() => expect(share).toBeEnabled());
    await user.click(share);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    // The reusable AudiencePicker renders the audience ladder.
    expect(screen.getByRole('radio', { name: /all friends/i })).toBeInTheDocument();
  });

  test('uses the same named audience transition and cancel gate as item views', async () => {
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [],
      conglomerates: [
        {
          conglomerateId: CONGLOMERATE_ID,
          name: 'Tech basket',
          positionCount: 3,
          audience: 'specific_friends',
          friendCount: 1,
        },
      ],
      watchlists: [],
      ideas: [],
    });
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'conglomerate',
      subjectId: CONGLOMERATE_ID,
      audience: 'specific_friends',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Share' }));
    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    expect(
      screen.getByText(/change access from specific friends to all friends/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(setAudience).not.toHaveBeenCalled();
  });

  test('lists all three kinds including a never-shared blueprint + watchlist, each settable (#384)', async () => {
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'private', friendCount: 0 },
      ],
      conglomerates: [
        {
          conglomerateId: CONGLOMERATE_ID,
          name: 'Tech basket',
          positionCount: 3,
          audience: 'private',
          friendCount: 0,
        },
      ],
      watchlists: [
        {
          watchlistId: WATCHLIST_ID,
          name: 'General',
          itemCount: 2,
          audience: 'private',
          friendCount: 0,
        },
      ],
      ideas: [],
    });
    // The picker seeds from the conglomerate's current (private) audience.
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'conglomerate',
      subjectId: CONGLOMERATE_ID,
      audience: 'private',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    renderPage();

    // Every kind is present — a private portfolio, a never-shared conglomerate
    // and a never-shared watchlist — under its own section heading.
    await waitFor(() => expect(screen.getByText('Tech basket')).toBeInTheDocument());
    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Portfolios')).toBeInTheDocument();
    expect(screen.getByText('Blueprints')).toBeInTheDocument();
    expect(screen.getByText('Watchlists')).toBeInTheDocument();
    // All three read Private (never shared).
    expect(screen.getAllByText('Private')).toHaveLength(3);

    // The conglomerate has its own Share entry point → the picker for THAT basket.
    const user = userEvent.setup();
    const shareButtons = screen.getAllByRole('button', { name: /share/i });
    expect(shareButtons).toHaveLength(3);
    await user.click(shareButtons[1]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: /only me/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /all friends/i })).toBeInTheDocument();
  });

  test('lists a private (non-shared) portfolio so a secondary one can be shared here (#377)', async () => {
    const SECONDARY_ID = '00000000-0000-0000-0000-000000000002';
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Main', audience: 'all_friends', friendCount: 0 },
        { portfolioId: SECONDARY_ID, name: 'Trading', audience: 'private', friendCount: 0 },
      ],
      conglomerates: [],
      watchlists: [],
      ideas: [],
    });
    // The AudiencePicker seeds from the subject's current (private) audience.
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SECONDARY_ID,
      audience: 'private',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    renderPage();

    // The private secondary portfolio is listed with the dimmed "Private" badge —
    // the entry point that used to be missing, so it can now be shared.
    await waitFor(() => expect(screen.getByText('Trading')).toBeInTheDocument());
    expect(screen.getByText('Private')).toBeInTheDocument();

    // Its own Share control opens the picker for THAT portfolio (private selected).
    const user = userEvent.setup();
    const shareButtons = screen.getAllByRole('button', { name: /share/i });
    const secondaryShare = shareButtons[shareButtons.length - 1]!;
    await waitFor(() => expect(secondaryShare).toBeEnabled());
    await user.click(secondaryShare);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('radio', { name: /only me/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /all friends/i })).toBeInTheDocument();
  });

  test('removes every sharing affordance for a vaulted portfolio while keeping its plain sibling', async () => {
    const SECONDARY_ID = '00000000-0000-0000-0000-000000000002';
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [
        { portfolioId: PORTFOLIO_ID, name: 'Vaulted Main', audience: 'private', friendCount: 0 },
        { portfolioId: SECONDARY_ID, name: 'Plain Trading', audience: 'private', friendCount: 0 },
      ],
      conglomerates: [],
      watchlists: [],
      ideas: [],
    });
    const metadata = portfolioList();
    vi.mocked(listPortfolios).mockResolvedValue({
      portfolios: [
        { ...metadata.portfolios[0]!, vaultId: '00000000-0000-0000-0000-000000000099' },
        { ...metadata.portfolios[0]!, id: SECONDARY_ID, name: 'Plain Trading' },
      ],
    });
    renderPage();

    expect(await screen.findByText('Plain Trading')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Vaulted Main')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Share' })).toHaveLength(1);
  });

  test('shows an ideas group with a per-item audience entry point (V4-P9)', async () => {
    const IDEA_ID = '00000000-0000-0000-0000-0000000000a1';
    vi.mocked(listMyShared).mockResolvedValue({
      portfolios: [],
      conglomerates: [],
      watchlists: [],
      ideas: [
        {
          ideaId: IDEA_ID,
          name: 'Momentum basket',
          hasThesis: true,
          audience: 'private',
          friendCount: 0,
        },
      ],
    });
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'idea',
      subjectId: IDEA_ID,
      audience: 'private',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Momentum basket')).toBeInTheDocument());
    expect(screen.getByText('Ideas')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /share/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(getAudience).toHaveBeenCalledWith('idea', IDEA_ID, expect.anything());
  });
});

// The "share my alerts" control moved out of Settings into the Social "My items"
// area (#532) — same behaviour, incl. the all-followers friction dialog + ack.
describe('MySharedItemsPage — alert sharing (relocated from Settings)', () => {
  test('renders an alert-sharing read failure without hiding owned items', async () => {
    vi.mocked(listMyShared).mockResolvedValue(WITH_PORTFOLIO);
    vi.mocked(getAlertSharing).mockRejectedValue(new Error('sharing unavailable'));
    renderPage();

    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
  });

  test('shows the alert-sharing control even when the caller owns nothing', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Share my alerts with followers' }),
      ).toBeInTheDocument(),
    );
  });

  test('enabling walks the warning dialog and sends the ack (#455)', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    vi.mocked(updateAlertSharing).mockResolvedValue({ visibleToFollowers: true });
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Share my alerts with followers' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    // Enabling never writes directly — the strong warning comes first.
    await user.click(toggle);
    expect(updateAlertSharing).not.toHaveBeenCalled();
    expect(screen.getByText(/which assets you watch and your price targets/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'I understand — share my alerts' }));
    await waitFor(() =>
      expect(updateAlertSharing).toHaveBeenCalledWith({
        visibleToFollowers: true,
        acknowledgeFollowers: true,
      }),
    );
  });

  test('keeps a failed enable message inside the confirmation dialog', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    vi.mocked(updateAlertSharing).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: 'Share my alerts with followers' }));
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'I understand — share my alerts' }),
    );

    expect(
      await within(dialog).findByText('Could not update alert sharing. Please try again.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('disabling needs no confirmation (#455)', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    vi.mocked(getAlertSharing).mockResolvedValue({ visibleToFollowers: true });
    vi.mocked(updateAlertSharing).mockResolvedValue({ visibleToFollowers: false });
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Share my alerts with followers' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await user.click(toggle);
    await waitFor(() =>
      expect(updateAlertSharing).toHaveBeenCalledWith({ visibleToFollowers: false }),
    );
  });

  test('uses the global error toast when an immediate disable fails', async () => {
    vi.mocked(listMyShared).mockResolvedValue(EMPTY);
    vi.mocked(getAlertSharing).mockResolvedValue({ visibleToFollowers: true });
    vi.mocked(updateAlertSharing).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: 'Share my alerts with followers' }));

    await screen.findByText('Could not update alert sharing. Please try again.');
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'error');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

test('at 390 px shared-item actions remain reachable and open a phone sheet', async () => {
  setViewportWidth(390);
  vi.mocked(listMyShared).mockResolvedValue({
    portfolios: [],
    conglomerates: [],
    watchlists: [],
    ideas: [
      {
        ideaId: '00000000-0000-0000-0000-0000000000a1',
        name: 'Phone idea',
        hasThesis: false,
        audience: 'private',
        friendCount: 0,
      },
    ],
  });
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'idea',
    subjectId: '00000000-0000-0000-0000-0000000000a1',
    audience: 'private',
    friendIds: [],
    groupId: null,
    link: { active: false, createdAt: null },
  });
  const user = userEvent.setup();
  const { container } = renderPage();

  await user.click(await screen.findByRole('button', { name: 'Share' }));
  expect(await screen.findByRole('dialog', { name: /share.*phone idea/i })).toHaveClass(
    'bt-dialog__panel--phone-sheet',
  );
  expect(container.querySelector('.bt-my-shared-page')).toBeInTheDocument();
});
