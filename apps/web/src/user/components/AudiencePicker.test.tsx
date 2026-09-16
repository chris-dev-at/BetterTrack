import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  listGroups: vi.fn(),
  setAudience: vi.fn(),
}));

import { FRIEND_GROUPS_MAX, GROUP_AUDIENCE_INVALID_ERROR_CODE } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { getAudience, listFriends, listGroups, setAudience } from '../../lib/socialApi';
import { MutationFeedbackProvider } from '../hooks/useMutationFeedback';
import { AudiencePicker } from './AudiencePicker';

const SUBJECT = '00000000-0000-0000-0000-000000000001';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderPicker(
  onClose = vi.fn(),
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MutationFeedbackProvider>
        <AudiencePicker
          kind="portfolio"
          subjectId={SUBJECT}
          subjectLabel="Main"
          onClose={onClose}
        />
      </MutationFeedbackProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAudience).mockResolvedValue({
    kind: 'portfolio',
    subjectId: SUBJECT,
    audience: 'private',
    friendIds: [],
    groupId: null,
    link: { active: false, createdAt: null },
  });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
  vi.mocked(listGroups).mockResolvedValue({ groups: [] });
});

describe('AudiencePicker — mutation feedback', () => {
  test('confirms a saved non-public audience without stacking notices', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'private',
        friendIds: [],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    renderPicker(onClose);

    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('Sharing updated.')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  test('surfaces a failed audience save and keeps the picker open', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    vi.mocked(setAudience).mockRejectedValue(new Error('offline'));
    renderPicker(onClose);

    await user.click(await screen.findByRole('button', { name: /^save$/i }));

    const dialog = screen.getByRole('dialog');
    expect(
      await within(dialog).findByText('Could not update sharing. Please try again.'),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('AudiencePicker — authoritative reads', () => {
  test('refreshes a cached audience before exposing or saving its recipients', async () => {
    const oldFriendId = '00000000-0000-0000-0000-0000000000a1';
    const currentFriendId = '00000000-0000-0000-0000-0000000000b2';
    const audienceRead = deferred<Awaited<ReturnType<typeof getAudience>>>();
    vi.mocked(getAudience).mockReturnValue(audienceRead.promise);
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        {
          user: { id: currentFriendId, username: 'current-friend' },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'specific_friends',
        friendIds: [currentFriendId],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['social', 'audience', 'portfolio', SUBJECT], {
      kind: 'portfolio',
      subjectId: SUBJECT,
      audience: 'specific_friends',
      friendIds: [oldFriendId],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    queryClient.setQueryData(['social', 'friends'], {
      friends: [
        {
          user: { id: oldFriendId, username: 'old-friend' },
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    queryClient.setQueryData(['social', 'groups'], { groups: [] });

    const user = userEvent.setup();
    renderPicker(vi.fn(), queryClient);

    expect(await screen.findByText('Loading sharing settings…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByText('old-friend')).not.toBeInTheDocument();

    await act(async () => {
      audienceRead.resolve({
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'specific_friends',
        friendIds: [currentFriendId],
        groupId: null,
        link: { active: false, createdAt: null },
      });
    });

    const currentFriend = await screen.findByRole('checkbox', { name: 'current-friend' });
    expect(currentFriend).toBeChecked();
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'specific_friends',
      friendIds: [currentFriendId],
      groupId: undefined,
      acknowledgePublic: undefined,
      confirmWiden: undefined,
    });
  });

  test('does not expose a save action before the current audience is known', async () => {
    const audienceRead = deferred<Awaited<ReturnType<typeof getAudience>>>();
    vi.mocked(getAudience).mockReturnValue(audienceRead.promise);
    renderPicker();

    expect(await screen.findByText('Loading sharing settings…')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(setAudience).not.toHaveBeenCalled();

    await act(async () => {
      audienceRead.resolve({
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'all_friends',
        friendIds: [],
        groupId: null,
        link: { active: false, createdAt: null },
      });
    });

    expect(await screen.findByRole('radio', { name: /all friends/i })).toBeChecked();
    expect(setAudience).not.toHaveBeenCalled();
  });

  test('a failed current-audience read retries without defaulting or overwriting it', async () => {
    vi.mocked(getAudience)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'all_friends',
        friendIds: [],
        groupId: null,
        link: { active: false, createdAt: null },
      });
    const user = userEvent.setup();
    renderPicker();

    expect(
      await screen.findByText('Could not load the current sharing settings. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('radio', { name: /all friends/i })).toBeChecked();
    expect(getAudience).toHaveBeenCalledTimes(2);
    expect(setAudience).not.toHaveBeenCalled();
  });

  test.each(['friends', 'groups'] as const)(
    'a failed %s roster stays distinct from a genuine empty roster and can retry',
    async (read) => {
      if (read === 'friends') {
        vi.mocked(listFriends)
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValueOnce({ friends: [] });
      } else {
        vi.mocked(listGroups)
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValueOnce({ groups: [] });
      }
      const user = userEvent.setup();
      renderPicker();

      expect(
        await screen.findByText('Could not load the current sharing settings. Please try again.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/You have no (friends|groups) yet/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('radio', { name: /only me/i })).toBeChecked();
      expect(read === 'friends' ? listFriends : listGroups).toHaveBeenCalledTimes(2);
      expect(setAudience).not.toHaveBeenCalled();
    },
  );
});

describe('AudiencePicker — friction ladder (§16)', () => {
  test('the public confirm cannot submit without the explicit acknowledgment', async () => {
    const user = userEvent.setup();
    renderPicker();

    // Wait for the picker to load, then choose the public-link rung.
    await waitFor(() => expect(screen.getByRole('radio', { name: /public link/i })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: /public link/i }));

    // The strong warning is shown, verbatim.
    expect(
      screen.getByText(/anyone with the link sees your holdings and net worth/i),
    ).toBeInTheDocument();

    // Save is BLOCKED until the acknowledgment is checked.
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    expect(setAudience).not.toHaveBeenCalled();

    // Acknowledge → Save unlocks.
    await user.click(
      screen.getByRole('checkbox', { name: /i understand that anyone with the link/i }),
    );
    expect(save).toBeEnabled();

    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'public_link',
        friendIds: [],
        groupId: null,
        link: { active: true, createdAt: new Date().toISOString() },
      },
      link: { token: 'tok_abc', url: '/api/v1/social/links/tok_abc' },
    });
    await user.click(save);

    // It submits with the acknowledgment flag set (server double-checks it too).
    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'public_link',
      friendIds: undefined,
      groupId: undefined,
      acknowledgePublic: true,
      confirmWiden: true,
    });
  });

  test('blocks every genuine widening until the shared-lattice confirmation is checked', async () => {
    const user = userEvent.setup();
    renderPicker();
    await waitFor(() => expect(screen.getByRole('radio', { name: /all friends/i })).toBeEnabled());

    await user.click(screen.getByRole('radio', { name: /all friends/i }));
    expect(screen.getByText(/change access from Private to All friends/i)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    expect(save).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: /specific friends/i }));
    expect(save).toBeDisabled();
  });

  test('names a specific-friends → all-friends widening and cancel leaves it untouched', async () => {
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SUBJECT,
      audience: 'specific_friends',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPicker(onClose);

    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    expect(
      screen.getByText(/change access from Specific friends to All friends/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(setAudience).not.toHaveBeenCalled();
  });

  test('keeps public-link → all-friends narrowing friction-free', async () => {
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SUBJECT,
      audience: 'public_link',
      friendIds: [],
      groupId: null,
      link: { active: true, createdAt: '2026-08-01T12:00:00.000Z' },
    });
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    expect(screen.queryByRole('checkbox', { name: /this change widens access/i })).toBeNull();
    expect(screen.queryByText(/change access from Public link to All friends/i)).toBeNull();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  test('saves a named specific-friends → all-friends change only after confirmation', async () => {
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SUBJECT,
      audience: 'specific_friends',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'all_friends',
        friendIds: [],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /all friends/i }));
    expect(setAudience).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'all_friends',
      friendIds: undefined,
      groupId: undefined,
      acknowledgePublic: undefined,
      confirmWiden: true,
    });
  });
});

describe('AudiencePicker — active public-link lifecycle', () => {
  const createdAt = '2026-08-01T12:00:00.000Z';

  beforeEach(() => {
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SUBJECT,
      audience: 'public_link',
      friendIds: [],
      groupId: null,
      link: { active: true, createdAt },
    });
  });

  test('renders the persistent active-link explanation after the creation moment', async () => {
    renderPicker();

    expect(
      await screen.findByText(/a public link is active.*url is shown only once/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /public link/i })).toBeChecked();
  });

  test('keeps the dialog open and reports the truthful outcome when the active link is re-saved', async () => {
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'public_link',
        friendIds: [],
        groupId: null,
        link: { active: true, createdAt },
      },
    });
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderPicker(onClose);

    await screen.findByText(/a public link is active.*url is shown only once/i);
    await user.click(
      screen.getByRole('checkbox', { name: /i understand that anyone with the link/i }),
    );
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(
      await screen.findByText(/saved.*existing public link remains active.*cannot be shown again/i),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'public_link',
      friendIds: undefined,
      groupId: undefined,
      acknowledgePublic: true,
      confirmWiden: undefined,
    });
  });
});

describe('AudiencePicker — friend groups (V5-P8)', () => {
  const GROUP = '00000000-0000-0000-0000-0000000000f1';

  test('orders the group rung between specific-friends and all-friends', async () => {
    renderPicker();
    await waitFor(() => expect(screen.getByRole('radio', { name: /friend group/i })).toBeEnabled());

    const order = screen.getAllByRole('radio').map((r) => r.getAttribute('value'));
    expect(order).toEqual(['private', 'specific_friends', 'group', 'all_friends', 'public_link']);
  });

  test('the group rung shows its confirm and cannot submit until a group is chosen', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 3, members: [], shareCount: 0 }],
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'group',
        friendIds: [],
        groupId: GROUP,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();
    renderPicker();

    await waitFor(() => expect(screen.getByRole('radio', { name: /friend group/i })).toBeEnabled());
    await user.click(screen.getByRole('radio', { name: /friend group/i }));

    // The friction-ladder confirm note for the group tier is shown.
    expect(screen.getByText(/everyone currently in this group will see/i)).toBeInTheDocument();

    // Save is BLOCKED until a group is actually selected (the group tier's friction).
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();

    // Pick the group, then explicitly confirm the widening.
    await user.click(screen.getByRole('radio', { name: /family/i }));
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'group',
      friendIds: undefined,
      groupId: GROUP,
      acknowledgePublic: undefined,
      confirmWiden: true,
    });
  });

  describe('the widening confirmation names the circle it means', () => {
    const WORK = '00000000-0000-0000-0000-0000000000f2';

    function withCircles(current: { audience: 'group' | 'specific_friends'; groupId?: string }) {
      vi.mocked(listGroups).mockResolvedValue({
        groups: [
          { id: GROUP, name: 'Family', memberCount: 3, members: [], shareCount: 0 },
          { id: WORK, name: 'Work', memberCount: 18, members: [], shareCount: 0 },
        ],
      });
      vi.mocked(getAudience).mockResolvedValue({
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: current.audience,
        friendIds: [],
        groupId: current.groupId ?? null,
        link: { active: false, createdAt: null },
      });
    }

    test('a group → group swap names both circles, not "Friend group" twice', async () => {
      // Three people to eighteen is a genuine widening (contracts classifies it
      // so); asking the owner to acknowledge it while refusing to name either
      // circle makes the acknowledgment meaningless.
      withCircles({ audience: 'group', groupId: GROUP });
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() => expect(screen.getByRole('radio', { name: /work/i })).toBeEnabled());
      await user.click(screen.getByRole('radio', { name: /work/i }));

      expect(
        screen.getByText(
          /change access from group “Family” \(3 members\) to group “Work” \(18 members\)/i,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/from Friend group to Friend group/i)).toBeNull();
    });

    test('a specific-friends → group change names the target circle', async () => {
      withCircles({ audience: 'specific_friends' });
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() =>
        expect(screen.getByRole('radio', { name: /friend group/i })).toBeEnabled(),
      );
      await user.click(screen.getByRole('radio', { name: /friend group/i }));
      await user.click(screen.getByRole('radio', { name: /work/i }));

      expect(
        screen.getByText(/change access from Specific friends to group “Work” \(18 members\)/i),
      ).toBeInTheDocument();
    });

    test('a group → specific-friends change names the source circle', async () => {
      withCircles({ audience: 'group', groupId: WORK });
      const user = userEvent.setup();
      renderPicker();

      await waitFor(() =>
        expect(screen.getByRole('radio', { name: /specific friends/i })).toBeEnabled(),
      );
      await user.click(screen.getByRole('radio', { name: /specific friends/i }));

      expect(
        screen.getByText(/change access from group “Work” \(18 members\) to Specific friends/i),
      ).toBeInTheDocument();
    });
  });
});

describe('AudiencePicker — MIRRORCHAIN §10 share notice (V5-P7 M5)', () => {
  test('carries the synced-copy notice when sharing a chain-attached portfolio', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AudiencePicker
          kind="portfolio"
          subjectId={SUBJECT}
          subjectLabel="Family"
          mirrorSyncedCopy
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The one-line notice is rendered (from `mirrorchain.share.syncedNotice`).
    await waitFor(() =>
      expect(
        screen.getByText(/others in this group portfolio will remain visible to you/i),
      ).toBeInTheDocument(),
    );
  });

  test('a non-chain portfolio does not render the synced-copy notice', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AudiencePicker
          kind="portfolio"
          subjectId={SUBJECT}
          subjectLabel="Main"
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole('radio', { name: /private/i })).toBeEnabled());
    expect(
      screen.queryByText(/others in this group portfolio will remain visible to you/i),
    ).not.toBeInTheDocument();
  });
});

describe('AudiencePicker — specific-friends searchable multi-select (V3-P6)', () => {
  const ALICE = '00000000-0000-0000-0000-0000000000a1';
  const BOB = '00000000-0000-0000-0000-0000000000b2';

  test('searches, filters and toggles friends by avatar row, then saves the exact set', async () => {
    vi.mocked(listFriends).mockResolvedValue({
      friends: [
        { user: { id: ALICE, username: 'alice' }, createdAt: '2026-01-01T00:00:00.000Z' },
        { user: { id: BOB, username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    vi.mocked(setAudience).mockResolvedValue({
      state: {
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: 'specific_friends',
        friendIds: [ALICE],
        groupId: null,
        link: { active: false, createdAt: null },
      },
    });
    const user = userEvent.setup();
    renderPicker();

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /specific friends/i })).toBeEnabled(),
    );
    await user.click(screen.getByRole('radio', { name: /specific friends/i }));

    // The searchable roster renders both friends (not a raw checkbox list dump).
    const search = screen.getByRole('searchbox', { name: /search friends/i });
    expect(screen.getByRole('checkbox', { name: /alice/i })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /bob/i })).toBeInTheDocument();

    // Searching filters the roster to just alice.
    await user.type(search, 'ali');
    expect(screen.getByRole('checkbox', { name: /alice/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /bob/i })).not.toBeInTheDocument();

    // Toggle alice, save → the exact named set is submitted.
    await user.click(screen.getByRole('checkbox', { name: /alice/i }));
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    await user.click(save);

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'specific_friends',
      friendIds: [ALICE],
      groupId: undefined,
      acknowledgePublic: undefined,
      confirmWiden: true,
    });
  });
});

describe('AudiencePicker — the friend-group list is bounded (#1780)', () => {
  const groupsAt = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      name: `Circle ${i}`,
      memberCount: 1,
      members: [],
      shareCount: 0,
    }));

  test('names the ceiling when the caller holds the maximum number of circles', async () => {
    vi.mocked(listGroups).mockResolvedValue({ groups: groupsAt(FRIEND_GROUPS_MAX) });
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /friend group/i }));

    // The read is capped at the same ceiling the server enforces, so the list IS
    // the caller's whole set — say so rather than showing a silently short list.
    expect(
      screen.getByText(
        `This is all ${FRIEND_GROUPS_MAX} of your groups — the maximum. Manage them on the People page.`,
      ),
    ).toBeInTheDocument();
  });

  test('stays compact below the ceiling — no extra line', async () => {
    vi.mocked(listGroups).mockResolvedValue({ groups: groupsAt(2) });
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /friend group/i }));

    expect(screen.getByText('Circle 0')).toBeInTheDocument();
    expect(screen.queryByText(/the maximum/i)).not.toBeInTheDocument();
  });
});

/**
 * #1899 — a share whose circle was deleted. `share_audiences.group_id` is
 * `ON DELETE SET NULL` (`apps/api/src/data/schema.ts`), so the server state is
 * `{ audience: 'group', groupId: null }`: the tier outlives the circle and the
 * enforcement layer then admits NOBODY. The picker seeded that verbatim and
 * disabled Save with nothing rendered to explain it, and the matching refusal
 * (`GROUP_AUDIENCE_INVALID`) arrived as the generic "please try again", so
 * retrying repeated it forever.
 *
 * The repair must never widen on its own: every way out of this state is either
 * a narrowing (`private`) or walks the §16 friction ladder.
 */
describe('AudiencePicker — a share whose circle was deleted (#1899)', () => {
  const FAMILY = '00000000-0000-0000-0000-0000000000f1';
  const WORK = '00000000-0000-0000-0000-0000000000f2';
  const WORK_ROW = { id: WORK, name: 'Work', memberCount: 18, members: [], shareCount: 0 };
  const FAMILY_ROW = { id: FAMILY, name: 'Family', memberCount: 3, members: [], shareCount: 0 };

  const DELETED_CIRCLE_NOTICE =
    'The group this was shared with no longer exists, so right now nobody can see it. ' +
    'Pick another group or a different audience below, then save.';
  const GROUP_GONE_ERROR =
    'That group no longer exists. Your sharing is unchanged — pick another group or a ' +
    'different audience, then save again.';

  function deletedCircleShare() {
    vi.mocked(getAudience).mockResolvedValue({
      kind: 'portfolio',
      subjectId: SUBJECT,
      audience: 'group',
      friendIds: [],
      groupId: null,
      link: { active: false, createdAt: null },
    });
    vi.mocked(listGroups).mockResolvedValue({ groups: [WORK_ROW] });
  }

  function savedState(audience: 'private' | 'group', groupId: string | null = null) {
    return {
      state: {
        kind: 'portfolio' as const,
        subjectId: SUBJECT,
        audience,
        friendIds: [],
        groupId,
        link: { active: false, createdAt: null },
      },
    };
  }

  test('explains the state instead of presenting a silently disabled Save', async () => {
    deletedCircleShare();
    renderPicker();

    expect(await screen.findByText(DELETED_CIRCLE_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  test('is repairable to private from inside the dialog — no reload, no ladder, no widening', async () => {
    deletedCircleShare();
    vi.mocked(setAudience).mockResolvedValue(savedState('private'));
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /only me/i }));
    const save = screen.getByRole('button', { name: /^save$/i });
    // Narrowing: the ladder has no rung here, and nothing was widened to escape.
    expect(screen.queryByRole('checkbox', { name: /this change widens access/i })).toBeNull();
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'private',
      friendIds: undefined,
      groupId: undefined,
      acknowledgePublic: undefined,
      confirmWiden: undefined,
    });
  });

  test('is repairable by re-picking a live circle, under the ladder', async () => {
    deletedCircleShare();
    vi.mocked(setAudience).mockResolvedValue(savedState('group', WORK));
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /work/i }));
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    await user.click(save);

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'group',
      friendIds: undefined,
      groupId: WORK,
      acknowledgePublic: undefined,
      confirmWiden: true,
    });
  });

  /**
   * The judgment call the issue asked to decide deliberately: the ladder's FROM
   * slot must name the reach it means. "from Friend group to All friends" reads
   * as though a populated circle already sees the item, which understates the
   * widening the acknowledgment exists to make explicit.
   */
  test('the ladder names the zero reach, never a populated “Friend group”', async () => {
    deletedCircleShare();
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /all friends/i }));

    expect(
      screen.getByText(/change access from a deleted group \(reaches nobody\) to All friends/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/from Friend group to All friends/i)).toBeNull();

    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
    expect(setAudience).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    expect(save).toBeEnabled();
  });

  test('a GROUP_AUDIENCE_INVALID refusal names the cause, refreshes the stale list and leaves sharing unchanged', async () => {
    // The issue's scenario: the circle list is cached 30 s and never refetches
    // while the dialog is open. The owner deletes "Family" in a second tab,
    // returns, and picks it from the stale list.
    vi.mocked(listGroups)
      .mockResolvedValueOnce({ groups: [FAMILY_ROW, WORK_ROW] })
      .mockResolvedValue({ groups: [WORK_ROW] });
    vi.mocked(setAudience).mockRejectedValue(
      new ApiError(
        400,
        // The contract constant, not a re-typed literal: if the server renames
        // the code this test goes red instead of the repair UX going quiet.
        GROUP_AUDIENCE_INVALID_ERROR_CODE,
        'Sharing to a group requires one of your own.',
      ),
    );
    const user = userEvent.setup();
    renderPicker();

    await user.click(await screen.findByRole('radio', { name: /friend group/i }));
    await user.click(screen.getByRole('radio', { name: /family/i }));
    await user.click(screen.getByRole('checkbox', { name: /this change widens access/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText(GROUP_GONE_ERROR)).toBeInTheDocument();
    expect(screen.queryByText('Could not update sharing. Please try again.')).toBeNull();

    // The stale list is refreshed, and the dead circle is gone from it.
    await waitFor(() => expect(listGroups).toHaveBeenCalledTimes(2));
    // Sharing is unchanged: the picker is back on the server's own audience,
    // never on a wider one, and nothing was re-submitted behind the owner.
    expect(await screen.findByRole('radio', { name: /only me/i })).toBeChecked();
    expect(setAudience).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('radio', { name: /friend group/i }));
    expect(screen.getByRole('radio', { name: /work/i })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /family/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
});
