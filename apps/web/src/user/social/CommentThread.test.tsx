import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  getCommentThread: vi.fn(),
  postComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleItemReaction: vi.fn(),
  toggleCommentReaction: vi.fn(),
}));

import type { CommentThreadResponse, ItemComment } from '@bettertrack/contracts';

import {
  deleteComment,
  getCommentThread,
  postComment,
  toggleItemReaction,
} from '../../lib/socialApi';
import { CommentThread } from './CommentThread';

const SUBJECT = '00000000-0000-0000-0000-000000000001';
const AUTHOR = '00000000-0000-0000-0000-000000000002';

function thread(o: {
  comments?: ItemComment[];
  reactions?: CommentThreadResponse['reactions'];
}): CommentThreadResponse {
  return {
    kind: 'portfolio',
    subjectId: SUBJECT,
    commentCount: o.comments?.length ?? 0,
    comments: o.comments ?? [],
    reactions: o.reactions ?? [],
  };
}

const oneComment: ItemComment = {
  id: 'c1',
  author: { id: AUTHOR, username: 'bob', profileIcon: null },
  body: 'Nice pick!',
  createdAt: '2026-07-19T10:00:00.000Z',
  canDelete: true,
  reactions: [],
};

function renderThread() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentThread kind="portfolio" subjectId={SUBJECT} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getCommentThread).mockReset();
  vi.mocked(postComment).mockReset();
  vi.mocked(deleteComment).mockReset();
  vi.mocked(toggleItemReaction).mockReset();
});

describe('CommentThread (§13.5 V5-P8)', () => {
  test('collapses to a comment count until expanded (anti-bloat)', async () => {
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [oneComment] }));
    renderThread();

    // The count shows, but the comment body is hidden until expansion.
    await waitFor(() => expect(screen.getByText(/1 comments/i)).toBeInTheDocument());
    expect(screen.queryByText('Nice pick!')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /1 comments/i }));
    expect(screen.getByText('Nice pick!')).toBeInTheDocument();
  });

  test('posts a comment through the API', async () => {
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [] }));
    vi.mocked(postComment).mockResolvedValue({ ...oneComment, body: 'Hello' });
    renderThread();

    await waitFor(() => expect(screen.getByText(/0 comments/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /0 comments/i }));

    await userEvent.type(screen.getByLabelText(/add a comment/i), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: /^post$/i }));

    await waitFor(() =>
      expect(vi.mocked(postComment)).toHaveBeenCalledWith('portfolio', SUBJECT, 'Hello'),
    );
  });

  test('toggles a curated item reaction', async () => {
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [] }));
    vi.mocked(toggleItemReaction).mockResolvedValue({
      reactions: [{ emoji: '🔥', count: 1, reacted: true }],
    });
    renderThread();

    // The item reaction chips are visible even while collapsed (wait for load).
    const group = await screen.findByRole('group', { name: /react to this item/i });
    const fire = within(group).getByRole('button', { name: '🔥' });
    await userEvent.click(fire);
    await waitFor(() =>
      expect(vi.mocked(toggleItemReaction)).toHaveBeenCalledWith('portfolio', SUBJECT, '🔥'),
    );
  });

  test('deletes a moderatable comment', async () => {
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [oneComment] }));
    vi.mocked(deleteComment).mockResolvedValue(undefined);
    renderThread();

    await waitFor(() => expect(screen.getByText(/1 comments/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /1 comments/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(vi.mocked(deleteComment)).toHaveBeenCalledWith('c1'));
  });

  test('renders nothing when the thread 404s (audience-excluded)', async () => {
    vi.mocked(getCommentThread).mockRejectedValue(new Error('not found'));
    const { container } = renderThread();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
