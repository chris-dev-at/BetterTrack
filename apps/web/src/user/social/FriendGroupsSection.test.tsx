import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

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
} from '../../lib/socialApi';
import { FriendGroupsSection } from './FriendGroupsSection';

const BOB = '00000000-0000-0000-0000-0000000000b2';
const GROUP = '00000000-0000-0000-0000-0000000000f1';

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
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
      groups: [{ id: GROUP, name: 'Family', memberCount: 0, members: [] }],
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
      groups: [{ id: GROUP, name: 'Family', memberCount: 0, members: [] }],
    });
    vi.mocked(listFriends).mockResolvedValue({
      friends: [{ user: { id: BOB, username: 'bob' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    vi.mocked(addGroupMember).mockResolvedValue({
      id: GROUP,
      name: 'Family',
      memberCount: 1,
      members: [{ id: BOB, username: 'bob', profileIcon: null }],
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
        { id: GROUP, name: 'Family', memberCount: 0, members: [] },
        { id: OTHER, name: 'Investors', memberCount: 0, members: [] },
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

  test('warns before deleting a group', async () => {
    vi.mocked(listGroups).mockResolvedValue({
      groups: [{ id: GROUP, name: 'Family', memberCount: 2, members: [] }],
    });
    vi.mocked(deleteGroup).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole('button', { name: /family/i }));
    await user.click(screen.getByRole('button', { name: /delete group/i }));

    // The confirm dialog warns the shares go dark before the destructive action.
    expect(screen.getByText(/no longer be visible to its members/i)).toBeInTheDocument();
    expect(deleteGroup).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith(GROUP));
  });
});
