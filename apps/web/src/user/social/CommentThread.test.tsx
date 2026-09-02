import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/socialApi', () => ({
  getCommentThread: vi.fn(),
  getCommentThreadSummary: vi.fn(),
  postComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleItemReaction: vi.fn(),
  toggleCommentReaction: vi.fn(),
}));

import type {
  CommentThreadResponse,
  CommentThreadSummaryResponse,
  ItemComment,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import {
  deleteComment,
  getCommentThread,
  getCommentThreadSummary,
  postComment,
  toggleCommentReaction,
  toggleItemReaction,
} from '../../lib/socialApi';
import { setViewportWidth } from '../../test/viewport';
import { CommentThread } from './CommentThread';

const SUBJECT = '00000000-0000-0000-0000-000000000001';
const AUTHOR = '00000000-0000-0000-0000-000000000002';

function summary(o: {
  commentCount?: number;
  reactions?: CommentThreadSummaryResponse['reactions'];
}): CommentThreadSummaryResponse {
  return {
    kind: 'portfolio',
    subjectId: SUBJECT,
    commentCount: o.commentCount ?? 0,
    reactions: o.reactions ?? [],
  };
}

function thread(o: {
  comments?: ItemComment[];
  commentCount?: number;
  nextCursor?: string | null;
  reactions?: CommentThreadResponse['reactions'];
}): CommentThreadResponse {
  return {
    kind: 'portfolio',
    subjectId: SUBJECT,
    commentCount: o.commentCount ?? o.comments?.length ?? 0,
    comments: o.comments ?? [],
    nextCursor: o.nextCursor ?? null,
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
  vi.mocked(getCommentThreadSummary).mockReset();
  vi.mocked(postComment).mockReset();
  vi.mocked(deleteComment).mockReset();
  vi.mocked(toggleItemReaction).mockReset();
  vi.mocked(toggleCommentReaction).mockReset();
});

describe('CommentThread (§13.5 V5-P8)', () => {
  test('shows loading instead of a false zero-comment count while the read is pending', () => {
    vi.mocked(getCommentThreadSummary).mockReturnValue(new Promise(() => undefined));
    renderThread();

    expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /0 comments/i })).not.toBeInTheDocument();
  });

  test('collapses to a comment count and fetches no thread page until expanded', async () => {
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 1 }));
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [oneComment] }));
    renderThread();

    // Collapsed: the count comes from the cheap summary; no page is ever read.
    await waitFor(() => expect(screen.getByText(/1 comment$/i)).toBeInTheDocument());
    expect(screen.queryByText('Nice pick!')).not.toBeInTheDocument();
    expect(getCommentThread).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /1 comment$/i }));
    expect(await screen.findByText('Nice pick!')).toBeInTheDocument();
    expect(getCommentThread).toHaveBeenCalledWith(
      'portfolio',
      SUBJECT,
      undefined,
      expect.anything(),
    );
  });

  test('renders the singular and plural comment counts', async () => {
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 2 }));
    renderThread();

    expect(await screen.findByText(/2 comments/i)).toBeInTheDocument();
  });

  test('an expanded thread takes its count from the polled page, not the frozen summary', async () => {
    // The summary query stops polling once expanded (that is the AC), so a
    // thread left open would otherwise show the count as of expansion forever.
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 2 }));
    vi.mocked(getCommentThread).mockResolvedValue(
      thread({ comments: [oneComment], commentCount: 7 }),
    );
    renderThread();

    await userEvent.click(await screen.findByRole('button', { name: /2 comments/i }));

    expect(await screen.findByRole('button', { name: /7 comments/i })).toBeInTheDocument();
  });

  test('loads an older page through the cursor', async () => {
    const older: ItemComment = { ...oneComment, id: 'c0', body: 'First!' };
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 2 }));
    vi.mocked(getCommentThread).mockImplementation(async (_kind, _subjectId, cursor) =>
      cursor
        ? thread({ comments: [older], commentCount: 2 })
        : thread({
            comments: [oneComment],
            commentCount: 2,
            nextCursor: 'c1',
          }),
    );
    renderThread();

    await userEvent.click(await screen.findByRole('button', { name: /2 comments/i }));
    await screen.findByText('Nice pick!');

    await userEvent.click(screen.getByRole('button', { name: /load older comments/i }));

    expect(await screen.findByText('First!')).toBeInTheDocument();
    expect(getCommentThread).toHaveBeenCalledWith('portfolio', SUBJECT, 'c1', expect.anything());
    // Oldest-first render order: the older page sits above the newest one.
    const bodies = screen.getAllByText(/First!|Nice pick!/).map((el) => el.textContent);
    expect(bodies).toEqual(['First!', 'Nice pick!']);
  });

  test('posts a comment through the API', async () => {
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 0 }));
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
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({}));
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

  test('surfaces a failed reaction toggle instead of failing silently', async () => {
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({}));
    vi.mocked(toggleItemReaction).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'not found'));
    renderThread();

    const group = await screen.findByRole('group', { name: /react to this item/i });
    await userEvent.click(within(group).getByRole('button', { name: '🔥' }));

    expect(await screen.findByText(/couldn’t save your reaction/i)).toBeInTheDocument();
  });

  test('deletes a moderatable comment', async () => {
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 1 }));
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [oneComment] }));
    vi.mocked(deleteComment).mockResolvedValue(undefined);
    renderThread();

    await waitFor(() => expect(screen.getByText(/1 comment$/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /1 comment$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(vi.mocked(deleteComment)).toHaveBeenCalledWith('c1'));
  });

  test('surfaces a failed moderation delete instead of failing silently', async () => {
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({ commentCount: 1 }));
    vi.mocked(getCommentThread).mockResolvedValue(thread({ comments: [oneComment] }));
    vi.mocked(deleteComment).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'not found'));
    renderThread();

    await userEvent.click(await screen.findByRole('button', { name: /1 comment$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/couldn’t delete that comment/i)).toBeInTheDocument();
  });

  test('renders nothing when the thread 404s (audience-excluded)', async () => {
    vi.mocked(getCommentThreadSummary).mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', 'not found'),
    );
    const { container } = renderThread();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test('keeps transport failures visible and retryable', async () => {
    vi.mocked(getCommentThreadSummary)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(summary({}));
    const user = userEvent.setup();
    renderThread();

    expect(await screen.findByText(/couldn't load the comments/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: /0 comments/i })).toBeInTheDocument();
    expect(getCommentThreadSummary).toHaveBeenCalledTimes(2);
  });

  test('at 390 px reacts to a shared item through the reachable chip grid', async () => {
    setViewportWidth(390);
    vi.mocked(getCommentThreadSummary).mockResolvedValue(summary({}));
    vi.mocked(toggleItemReaction).mockResolvedValue({
      reactions: [{ emoji: '❤️', count: 1, reacted: true }],
    });
    const { container } = renderThread();

    const group = await screen.findByRole('group', { name: /react to this item/i });
    await userEvent.click(within(group).getByRole('button', { name: '❤️' }));

    await waitFor(() =>
      expect(toggleItemReaction).toHaveBeenCalledWith('portfolio', SUBJECT, '❤️'),
    );
    expect(container.querySelector('.bt-comment-thread')).toBeInTheDocument();
  });
});
