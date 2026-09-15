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
  // The owner's comment surface mounts the same CommentThread the viewer pages
  // do (#1677), so its client calls have to exist on the mocked module.
  getCommentThread: vi.fn(),
  getCommentThreadSummary: vi.fn(),
  postComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleItemReaction: vi.fn(),
  toggleCommentReaction: vi.fn(),
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
  deleteComment,
  getAudience,
  getCommentThread,
  getCommentThreadSummary,
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
    {
      portfolioId: PORTFOLIO_ID,
      name: 'Main',
      audience: 'all_friends',
      friendCount: 0,
      group: null,
    },
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

function renderPage(initialEntry = '/people/shared') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
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
  vi.mocked(getCommentThreadSummary).mockResolvedValue({
    kind: 'portfolio',
    subjectId: PORTFOLIO_ID,
    commentCount: 0,
    reactions: [],
  });
  vi.mocked(getCommentThread).mockResolvedValue({
    kind: 'portfolio',
    subjectId: PORTFOLIO_ID,
    commentCount: 0,
    comments: [],
    nextCursor: null,
    reactions: [],
  });
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

  test('names every shared portfolio while the vault metadata is still pending', async () => {
    const read = deferred<Awaited<ReturnType<typeof listPortfolios>>>();
    vi.mocked(listMyShared).mockResolvedValue(WITH_PORTFOLIO);
    vi.mocked(listPortfolios).mockReturnValue(read.promise);
    renderPage();

    // The sharing action waits for the metadata; the row's NAME never does —
    // masking it would rename every plain portfolio on each background refetch.
    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.queryByText('Locked portfolio')).not.toBeInTheDocument();

    await act(async () => {
      read.resolve(portfolioList());
    });

    expect(screen.getByText('Main')).toBeInTheDocument();
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
        {
          portfolioId: PORTFOLIO_ID,
          name: 'Main',
          audience: 'all_friends',
          friendCount: 0,
          group: null,
        },
      ],
      conglomerates: [],
      watchlists: [
        {
          watchlistId: WATCHLIST_ID,
          name: 'General',
          audience: 'public_link',
          itemCount: 3,
          friendCount: 0,
          group: null,
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
          group: null,
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
        {
          portfolioId: PORTFOLIO_ID,
          name: 'Main',
          audience: 'private',
          friendCount: 0,
          group: null,
        },
      ],
      conglomerates: [
        {
          conglomerateId: CONGLOMERATE_ID,
          name: 'Tech basket',
          positionCount: 3,
          audience: 'private',
          friendCount: 0,
          group: null,
        },
      ],
      watchlists: [
        {
          watchlistId: WATCHLIST_ID,
          name: 'General',
          itemCount: 2,
          audience: 'private',
          friendCount: 0,
          group: null,
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
    expect(screen.getByText('Main')).toBeInTheDocument();
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
        {
          portfolioId: PORTFOLIO_ID,
          name: 'Main',
          audience: 'all_friends',
          friendCount: 0,
          group: null,
        },
        {
          portfolioId: SECONDARY_ID,
          name: 'Trading',
          audience: 'private',
          friendCount: 0,
          group: null,
        },
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
        {
          portfolioId: PORTFOLIO_ID,
          name: 'Vaulted Main',
          audience: 'private',
          friendCount: 0,
          group: null,
        },
        {
          portfolioId: SECONDARY_ID,
          name: 'Plain Trading',
          audience: 'private',
          friendCount: 0,
          group: null,
        },
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
          group: null,
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
        group: null,
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

/**
 * The owner's half of V5-P8 (#1677). A `group` share used to render a flat
 * "Friend group" chip: a circle of eighteen looked exactly like a deleted one
 * that reaches nobody, which is precisely the reach the friction ladder assumes
 * the owner knows.
 */
describe('the group badge names the circle and its reach', () => {
  function withGroup(group: { id: string; name: string; memberCount: number } | null) {
    return {
      portfolios: [
        {
          portfolioId: PORTFOLIO_ID,
          name: 'Main',
          audience: 'group' as const,
          friendCount: 0,
          group,
        },
      ],
      conglomerates: [],
      watchlists: [],
      ideas: [],
    };
  }

  test('shows the group name and its current member count', async () => {
    vi.mocked(listMyShared).mockResolvedValue(
      withGroup({ id: '00000000-0000-0000-0000-0000000000f1', name: 'Family', memberCount: 2 }),
    );
    renderPage();

    const badge = await screen.findByTestId('who-sees-this');
    expect(badge).toHaveTextContent('Family · 2');
    expect(badge).toHaveAttribute('data-reach', 'group');
    expect(badge).not.toHaveClass('bt-badge--outline');
  });

  test('renders an emptied circle visibly differently from a populated one', async () => {
    vi.mocked(listMyShared).mockResolvedValue(
      withGroup({ id: '00000000-0000-0000-0000-0000000000f1', name: 'Family', memberCount: 0 }),
    );
    const { unmount } = renderPage();
    const empty = await screen.findByTestId('who-sees-this');
    const emptyText = empty.textContent;
    expect(emptyText).toBe('Family · reaches nobody');
    expect(empty).toHaveAttribute('data-reach', 'nobody');
    expect(empty).toHaveClass('bt-badge--outline');
    unmount();

    vi.mocked(listMyShared).mockResolvedValue(
      withGroup({ id: '00000000-0000-0000-0000-0000000000f1', name: 'Family', memberCount: 2 }),
    );
    renderPage();
    const populated = await screen.findByTestId('who-sees-this');
    expect(populated.textContent).not.toBe(emptyText);
    expect(populated).not.toHaveClass('bt-badge--outline');
  });

  test('renders a deleted group as reaching nobody, not as a plain friend group', async () => {
    vi.mocked(listMyShared).mockResolvedValue(withGroup(null));
    renderPage();

    const badge = await screen.findByTestId('who-sees-this');
    expect(badge).toHaveTextContent('Friend group deleted · reaches nobody');
    expect(badge).toHaveAttribute('data-reach', 'nobody');
    expect(badge).toHaveClass('bt-badge--outline');
  });
});

/**
 * My items is the ONLY surface from which the item owner can reach the thread
 * they moderate: every friend-shared page inner-joins friendship, and nobody is
 * their own friend (#1677).
 */
describe('the owner opens and moderates the thread of their own item', () => {
  const SHARED = {
    portfolios: [
      {
        portfolioId: PORTFOLIO_ID,
        name: 'Main',
        audience: 'all_friends' as const,
        friendCount: 0,
        group: null,
      },
    ],
    conglomerates: [],
    watchlists: [],
    ideas: [],
  };

  function thread(canDelete: boolean) {
    return {
      kind: 'portfolio' as const,
      subjectId: PORTFOLIO_ID,
      commentCount: 1,
      comments: [
        {
          id: '00000000-0000-0000-0000-0000000000b1',
          author: { id: 'bob', username: 'bob', profileIcon: null },
          body: 'abusive',
          createdAt: '2026-01-02T10:00:00.000Z',
          canDelete,
          reactions: [],
        },
      ],
      nextCursor: null,
      reactions: [],
    };
  }

  test('opens the thread expanded and deletes a comment the server says it may', async () => {
    vi.mocked(listMyShared).mockResolvedValue(SHARED);
    vi.mocked(getCommentThread).mockResolvedValue(thread(true));
    vi.mocked(deleteComment).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Comments/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Comments on Main' });
    // Expanded on open: the user already asked for the thread.
    expect(await within(dialog).findByText('abusive')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(deleteComment).toHaveBeenCalledWith('00000000-0000-0000-0000-0000000000b1');
  });

  test('offers no delete affordance when the server withholds it', async () => {
    vi.mocked(listMyShared).mockResolvedValue(SHARED);
    vi.mocked(getCommentThread).mockResolvedValue(thread(false));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Comments/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Comments on Main' });
    expect(await within(dialog).findByText('abusive')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  test('a comment.created deep link opens that item’s thread straight away', async () => {
    vi.mocked(listMyShared).mockResolvedValue(SHARED);
    vi.mocked(getCommentThread).mockResolvedValue(thread(true));
    renderPage(`/people/shared#thread-portfolio-${PORTFOLIO_ID}`);

    const dialog = await screen.findByRole('dialog', { name: 'Comments on Main' });
    expect(await within(dialog).findByText('abusive')).toBeInTheDocument();
  });

  test('a deep link naming an item the caller no longer owns opens no dialog', async () => {
    vi.mocked(listMyShared).mockResolvedValue(SHARED);
    renderPage('/people/shared#thread-portfolio-00000000-0000-0000-0000-00000000dead');

    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
