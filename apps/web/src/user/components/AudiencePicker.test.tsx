import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  listGroups: vi.fn(),
  setAudience: vi.fn(),
}));

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

    expect(
      await screen.findByText('Could not update sharing. Please try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
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
      acknowledgePublic: undefined,
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
      acknowledgePublic: true,
    });
  });

  test('all-friends shows a light confirm, and specific-friends needs no acknowledgment', async () => {
    const user = userEvent.setup();
    renderPicker();
    await waitFor(() => expect(screen.getByRole('radio', { name: /all friends/i })).toBeEnabled());

    await user.click(screen.getByRole('radio', { name: /all friends/i }));
    expect(
      screen.getByText(/read-only view with everyone you are friends with/i),
    ).toBeInTheDocument();
    // No acknowledgment gate for all-friends — Save is immediately available.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();

    await user.click(screen.getByRole('radio', { name: /specific friends/i }));
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  test.each([
    ['specific_friends', 'Specific friends'],
    ['public_link', 'Public link'],
  ] as const)(
    'names the %s → all-friends change and cancel leaves the audience untouched',
    async (initialAudience, initialLabel) => {
      vi.mocked(getAudience).mockResolvedValue({
        kind: 'portfolio',
        subjectId: SUBJECT,
        audience: initialAudience,
        friendIds: [],
        groupId: null,
        link: {
          active: initialAudience === 'public_link',
          createdAt: initialAudience === 'public_link' ? '2026-08-01T12:00:00.000Z' : null,
        },
      });
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderPicker(onClose);

      await user.click(await screen.findByRole('radio', { name: /all friends/i }));
      expect(
        screen.getByText(new RegExp(`change access from ${initialLabel} to All friends`, 'i')),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(setAudience).not.toHaveBeenCalled();
    },
  );

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
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'all_friends',
      friendIds: undefined,
      acknowledgePublic: undefined,
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
      acknowledgePublic: true,
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
      groups: [{ id: GROUP, name: 'Family', memberCount: 3, members: [] }],
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

    // Pick the group → Save unlocks and submits with its id.
    await user.click(screen.getByRole('radio', { name: /family/i }));
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'group',
      friendIds: undefined,
      groupId: GROUP,
      acknowledgePublic: undefined,
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
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(setAudience).toHaveBeenCalledTimes(1));
    expect(setAudience).toHaveBeenCalledWith('portfolio', SUBJECT, {
      audience: 'specific_friends',
      friendIds: [ALICE],
      acknowledgePublic: undefined,
    });
  });
});
