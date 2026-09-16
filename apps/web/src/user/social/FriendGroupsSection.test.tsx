import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  FRIEND_GROUPS_MAX,
  FRIEND_GROUP_MEMBERS_MAX,
  FRIEND_GROUP_MEMBER_LIMIT_ERROR_CODE,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';

vi.mock('../../lib/socialApi', () => ({
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  renameGroup: vi.fn(),
  deleteGroup: vi.fn(),
  addGroupMember: vi.fn(),
  removeGroupMember: vi.fn(),
  listFriends: vi.fn(),
}));

import {
  addGroupMember,
  createGroup,
  deleteGroup,
  listFriends,
  listGroups,
  removeGroupMember,
  renameGroup,
} from '../../lib/socialApi';
import { FriendGroupsSection } from './FriendGroupsSection';

const ALICE = '00000000-0000-0000-0000-0000000000a1';
const BOB = '00000000-0000-0000-0000-0000000000b2';
const GROUP = '00000000-0000-0000-0000-0000000000f1';

function renderSection(
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <FriendGroupsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
});

describe('FriendGroupsSection (V5-P8)', () => {
  test('retries a failed group-list read in place', async () => {
    vi.mocked(listGroups)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ groups: [] });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('No groups yet')).toBeInTheDocument();
    expect(listGroups).toHaveBeenCalledTimes(2);
  });

  test('renders a friend-roster read failure inside an expanded group', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 0, members: [], shareCount: 0 }],
    });
    vi.mocked(listFriends).mockRejectedValue(new Error('friends unavailable'));
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
  });

  test('creates a group from the inline form', async () => {
    vi.mocked(createGroup).mockResolvedValue({
      id: GROUP,
      name: 'Family',
      memberCount: 0,
      members: [],
      shareCount: 0,
    });
    const user = userEvent.setup();
    renderSection();

    await waitFor(() => expect(listGroups).toHaveBeenCalled());
    await user.type(screen.getByLabelText(/new group name/i), 'Family');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(createGroup).toHaveBeenCalledWith('Family'));
  });

  test('lists a group with its members and can add an accepted friend', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 0, members: [], shareCount: 0 }],
    });
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: BOB, username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    vi.mocked(addGroupMember).mockResolvedValue({
      id: GROUP,
      name: 'Family',
      memberCount: 1,
      members: [{ id: BOB, username: 'bob', profileIcon: null }],
      shareCount: 0,
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    // The add-a-friend roster offers bob (an accepted friend not yet in the group).
    await user.click(await screen.findByRole('button', { name: /^add$/i }));
    await waitFor(() => expect(addGroupMember).toHaveBeenCalledWith(GROUP, BOB));
  });

  test('gives each expanded card its own name field id', async () => {
    const OTHER = '00000000-0000-0000-0000-0000000000f2';
    vi.mocked(listGroups).mockResolvedValue({
      groups: [
        { id: GROUP, name: 'Family', memberCount: 0, members: [], shareCount: 0 },
        { id: OTHER, name: 'Investors', memberCount: 0, members: [], shareCount: 0 },
      ],
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(screen.getByRole('button', { name: /investors/i }));

    const fields = screen.getAllByLabelText('Group name');
    expect(fields).toHaveLength(2);
    // Two cards open at once must not share a DOM id, or the second card's label
    // focuses the first card's input.
    expect(new Set(fields.map((f) => f.id)).size).toBe(2);

    // Each label focuses its own card's input.
    const [, secondLabel] = screen.getAllByText('Group name');
    await user.click(secondLabel as HTMLElement);
    expect(document.activeElement).toBe(fields[1]);
    expect((fields[1] as HTMLInputElement).value).toBe('Investors');
  });

  test('warns before deleting a group, naming how many shares go dark', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 2, members: [], shareCount: 6 }],
    });
    vi.mocked(deleteGroup).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(screen.getByRole('button', { name: /delete group/i }));

    // The confirm dialog warns the shares go dark before the destructive action,
    // and says HOW MANY — a static warning made deleting a circle six items point
    // at look exactly like deleting an unused one (#1710).
    expect(screen.getByText(/6 shared items point at this group/i)).toBeInTheDocument();
    expect(deleteGroup).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith(GROUP));
  });

  test('an unused group is warned about differently from one shares point at', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 2, members: [], shareCount: 0 }],
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(screen.getByRole('button', { name: /delete group/i }));

    expect(screen.getByText(/nothing is shared with this group right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/point at this group/i)).not.toBeInTheDocument();
  });
});

/**
 * The ceilings the server enforces (#1780), surfaced before the click. An
 * ordinary user never sees either line; at the boundary the reason is named
 * instead of arriving as an opaque "could not update the group".
 */
describe('FriendGroupsSection — the friend-group ceilings', () => {
  function circles(count: number, memberCount = 0) {
    return Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      name: `Circle ${i}`,
      memberCount,
      members: [],
      shareCount: 0,
    }));
  }

  test('closes the inline creator at the per-user ceiling and says why', async () => {
    vi.mocked(listGroups).mockResolvedValue({ groups: circles(FRIEND_GROUPS_MAX) });
    const user = userEvent.setup();
    renderSection();

    expect(
      await screen.findByText(
        `You've reached the maximum of ${FRIEND_GROUPS_MAX} groups. Delete one to create another.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/new group name/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^create$/i }));
    expect(createGroup).not.toHaveBeenCalled();
  });

  test('leaves the creator open one circle below the ceiling', async () => {
    vi.mocked(listGroups).mockResolvedValue({ groups: circles(FRIEND_GROUPS_MAX - 1) });
    renderSection();

    await waitFor(() => expect(listGroups).toHaveBeenCalled());
    expect(await screen.findByLabelText(/new group name/i)).not.toBeDisabled();
    expect(screen.queryByText(/reached the maximum/i)).not.toBeInTheDocument();
  });

  test('replaces the add-a-friend roster with the reason on a full circle', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [
        {
          id: GROUP,
          name: 'Family',
          memberCount: FRIEND_GROUP_MEMBERS_MAX,
          members: [],
          shareCount: 0,
        },
      ],
    });
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: BOB, username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    expect(
      screen.getByText(
        `This group is full — a group can hold at most ${FRIEND_GROUP_MEMBERS_MAX} members.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^add$/i })).not.toBeInTheDocument();
  });

  /**
   * The circle can fill up between the list read and the click (another tab,
   * another device). The refusal that comes back is the one refusal the owner
   * can act on — remove a member they can see — so it must name itself instead
   * of arriving as the generic "could not update the group" (#1830).
   */
  async function clickAddWith(error: unknown) {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 0, members: [], shareCount: 0 }],
    });
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: BOB, username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    vi.mocked(addGroupMember).mockRejectedValue(error);
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(await screen.findByRole('button', { name: /^add$/i }));
  }

  test('names the roster ceiling when the add is refused for it', async () => {
    await clickAddWith(
      new ApiError(400, FRIEND_GROUP_MEMBER_LIMIT_ERROR_CODE, 'A group can have at most 200.'),
    );

    expect(
      await screen.findByText(
        `This group is full — a group can hold at most ${FRIEND_GROUP_MEMBERS_MAX} members.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not update the group/i)).not.toBeInTheDocument();
  });

  test('keeps the generic message for any other failed add', async () => {
    await clickAddWith(new ApiError(500, 'INTERNAL', 'boom'));

    expect(await screen.findByText(/could not update the group/i)).toBeInTheDocument();
    expect(screen.queryByText(/this group is full/i)).not.toBeInTheDocument();
  });
});

/**
 * #1899 — "editing a group updates its reach" (§6.9, Audiences bullet) is a
 * claim about the SURFACES that report reach, not only about the circle list.
 * These five mutations invalidated `['social','groups']` alone, so My items'
 * badges (`['social','my-shared']`) and every open share dialog's audience read
 * (`['social','audience',kind,subjectId]`) kept serving pre-mutation reach for
 * the whole 30 s stale window — the owner deletes a circle four items point at
 * and all four rows still name it.
 *
 * The fix is ONE definition (`invalidateReachQueries`) taking the same
 * `['social']` prefix the AudiencePicker's own write already takes: every
 * reach-bearing read in the app lives under it, and hand-listing dependents is
 * exactly what drifted. These tests pin both halves — the prefix IS invalidated,
 * and the sweep stops there: no cache-wide invalidation, nothing outside
 * `['social']`.
 */
describe('FriendGroupsSection — a circle edit reaches every surface that reports reach (#1899)', () => {
  const OTHER_SUBJECT = '00000000-0000-0000-0000-0000000000d1';
  const FAMILY = {
    id: GROUP,
    name: 'Family',
    memberCount: 1,
    members: [{ id: BOB, username: 'bob', profileIcon: null }],
    shareCount: 4,
  };
  /** Caches a circle edit has no business touching. */
  const UNRELATED_KEYS = [
    ['workboard'],
    ['portfolios'],
    ['conglomerates'],
    ['ideas'],
    ['chat', 'conversations'],
    ['alerts', 'sharing'],
  ] as const;
  /**
   * Caches that state reach and therefore MUST hear the edit. Only queries with
   * no observer are asserted on: the section's own `['social','groups']` read
   * is invalidated too, but it refetches immediately and clears the flag again,
   * so asserting it would be a race. The call-argument check below covers it.
   */
  const REACH_KEYS = [
    ['social', 'my-shared'],
    ['social', 'audience', 'portfolio', OTHER_SUBJECT],
    ['social', 'shared-with-me'],
  ] as const;

  function renderWithCaches() {
    const queryClient = new QueryClient({
      // The app's real default (`UserApp.tsx`): without an invalidation these
      // reads stay fresh — and wrong — for 30 s.
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    for (const key of [...UNRELATED_KEYS, ...REACH_KEYS]) {
      queryClient.setQueryData([...key], { seeded: true });
    }
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    return { queryClient, invalidateQueries, ...renderSection(queryClient) };
  }

  function expectReachInvalidatedAndNothingElse(
    queryClient: QueryClient,
    calls: readonly (readonly unknown[])[],
  ) {
    for (const key of REACH_KEYS) {
      expect(
        queryClient.getQueryState([...key])?.isInvalidated,
        `reach-bearing ${JSON.stringify(key)} must hear the circle edit`,
      ).toBe(true);
    }
    // Negative space: the widening stops at the `['social']` prefix. A
    // cache-wide `invalidateQueries()` (no key) would also turn every assertion
    // above green, so pin the argument of every call too.
    for (const key of UNRELATED_KEYS) {
      expect(
        queryClient.getQueryState([...key])?.isInvalidated,
        `${JSON.stringify(key)} does not derive reach from a circle`,
      ).toBe(false);
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const [options] of calls) {
      expect(options).toEqual({ queryKey: ['social'] });
    }
  }

  beforeEach(() => {
    vi.mocked(listGroups).mockResolvedValue({ groups: [FAMILY] });
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: ALICE, username: 'alice' }, createdAt: '2026-01-01T00:00:00.000Z' },
        { user: { id: BOB, username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
  });

  test('creating a circle', async () => {
    vi.mocked(createGroup).mockResolvedValue({ ...FAMILY, name: 'Investors' });
    const user = userEvent.setup();
    const { queryClient, invalidateQueries } = renderWithCaches();

    await waitFor(() => expect(listGroups).toHaveBeenCalled());
    await user.type(screen.getByLabelText(/new group name/i), 'Investors');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(createGroup).toHaveBeenCalledWith('Investors'));
    await waitFor(() =>
      expectReachInvalidatedAndNothingElse(queryClient, invalidateQueries.mock.calls),
    );
  });

  test('renaming a circle', async () => {
    vi.mocked(renameGroup).mockResolvedValue({ ...FAMILY, name: 'Close family' });
    const user = userEvent.setup();
    const { queryClient, invalidateQueries } = renderWithCaches();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.clear(screen.getByLabelText('Group name'));
    await user.type(screen.getByLabelText('Group name'), 'Close family');
    await user.click(screen.getByRole('button', { name: /^rename$/i }));

    await waitFor(() => expect(renameGroup).toHaveBeenCalledWith(GROUP, 'Close family'));
    await waitFor(() =>
      expectReachInvalidatedAndNothingElse(queryClient, invalidateQueries.mock.calls),
    );
  });

  test('deleting a circle', async () => {
    vi.mocked(deleteGroup).mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { queryClient, invalidateQueries } = renderWithCaches();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(screen.getByRole('button', { name: /delete group/i }));
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith(GROUP));
    await waitFor(() =>
      expectReachInvalidatedAndNothingElse(queryClient, invalidateQueries.mock.calls),
    );
  });

  test('adding a member', async () => {
    vi.mocked(addGroupMember).mockResolvedValue({ ...FAMILY, memberCount: 2 });
    const user = userEvent.setup();
    const { queryClient, invalidateQueries } = renderWithCaches();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(await screen.findByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(addGroupMember).toHaveBeenCalledWith(GROUP, ALICE));
    await waitFor(() =>
      expectReachInvalidatedAndNothingElse(queryClient, invalidateQueries.mock.calls),
    );
  });

  test('removing a member', async () => {
    vi.mocked(removeGroupMember).mockResolvedValue({ ...FAMILY, memberCount: 0, members: [] });
    const user = userEvent.setup();
    const { queryClient, invalidateQueries } = renderWithCaches();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(await screen.findByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(removeGroupMember).toHaveBeenCalledWith(GROUP, BOB));
    await waitFor(() =>
      expectReachInvalidatedAndNothingElse(queryClient, invalidateQueries.mock.calls),
    );
  });
});
