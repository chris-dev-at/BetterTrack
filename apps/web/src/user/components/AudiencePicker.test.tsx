import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  getAudience: vi.fn(),
  listFriends: vi.fn(),
  setAudience: vi.fn(),
}));

import { getAudience, listFriends, setAudience } from '../../lib/socialApi';
import { AudiencePicker } from './AudiencePicker';

const SUBJECT = '00000000-0000-0000-0000-000000000001';

function renderPicker(onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AudiencePicker kind="portfolio" subjectId={SUBJECT} subjectLabel="Main" onClose={onClose} />
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
    link: { active: false, createdAt: null },
  });
  vi.mocked(listFriends).mockResolvedValue({ friends: [] });
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
