import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../lib/feedbackApi', () => ({
  getFeedbackThread: vi.fn(),
  listMyFeedback: vi.fn(),
  markFeedbackRead: vi.fn(),
  sendFeedbackMessage: vi.fn(),
  withdrawFeedback: vi.fn(),
}));

import {
  FEEDBACK_STATUSES,
  FEEDBACK_THREAD_CURSOR_UNKNOWN,
  type FeedbackThreadMessage,
  type FeedbackThreadResponse,
  type MyFeedbackSubmission,
} from '@bettertrack/contracts';

import { I18nProvider, localizedMessage } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import {
  getFeedbackThread,
  listMyFeedback,
  markFeedbackRead,
  sendFeedbackMessage,
  withdrawFeedback,
} from '../../../lib/feedbackApi';
import { setViewportWidth } from '../../../test/viewport';
import { MyFeedbackSubmissions } from './MyFeedbackSubmissions';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

function submission(overrides: Partial<MyFeedbackSubmission> = {}): MyFeedbackSubmission {
  return {
    id: ID_A,
    category: 'feature',
    subject: 'A quicker import flow',
    message: 'Please add a shortcut for my usual broker import.',
    status: 'new',
    lastStatusChangeAt: '2026-08-18T12:00:00.000Z',
    declinedReason: null,
    shippedVersion: null,
    unreadReplyCount: 0,
    createdAt: '2026-08-17T12:00:00.000Z',
    ...overrides,
  };
}

function message(overrides: Partial<FeedbackThreadMessage> = {}): FeedbackThreadMessage {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    feedbackId: ID_A,
    senderId: null,
    authorSide: 'admin',
    body: 'Could you share an example?',
    createdAt: '2026-08-18T12:00:00.000Z',
    ...overrides,
  };
}

function thread(
  messages: FeedbackThreadMessage[] = [],
  nextCursor: string | null = null,
): FeedbackThreadResponse {
  return { thread: { id: ID_A, unreadCount: 0 }, messages, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function LocationProbe() {
  const location = useLocation();
  // A plain span: `<output>` carries an implicit status role of its own.
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderPanel(path = '/control/feedback', locale: 'en' | 'de' = 'en') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>
        <MemoryRouter initialEntries={[path]}>
          <MyFeedbackSubmissions />
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest('li');
  if (!row) throw new Error(`no row for ${text}`);
  return row;
}

function openButtonFor(text: string): HTMLElement {
  const button = screen.getByText(text).closest('button');
  if (!button) throw new Error(`no open button for ${text}`);
  return button;
}

beforeEach(() => {
  vi.mocked(getFeedbackThread).mockReset();
  vi.mocked(listMyFeedback).mockReset();
  vi.mocked(markFeedbackRead).mockReset();
  vi.mocked(sendFeedbackMessage).mockReset();
  vi.mocked(withdrawFeedback).mockReset();
  vi.mocked(markFeedbackRead).mockResolvedValue(undefined);
  vi.mocked(getFeedbackThread).mockResolvedValue(thread());
});

afterEach(() => {
  setViewportWidth(1440);
});

// ─── List ────────────────────────────────────────────────────────────────────

test('shows a declined submission’s reason on the row itself, without expanding anything', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({
    submissions: [
      submission({
        status: 'declined',
        declinedReason: 'It overlaps with the new import review flow.',
      }),
    ],
  });

  renderPanel();

  const outcome = await screen.findByTestId('feedback-outcome');
  expect(outcome).toHaveTextContent('Declined — It overlaps with the new import review flow.');
  expect(within(rowFor('A quicker import flow')).getByText('Declined')).toBeInTheDocument();
  expect(screen.getByText(/Status changed/)).toBeInTheDocument();
});

test('makes a shipped submission’s version the row headline', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({
    submissions: [submission({ status: 'shipped', shippedVersion: '1.4.0' })],
  });

  renderPanel();

  expect(await screen.findByTestId('feedback-outcome')).toHaveTextContent('Shipped in 1.4.0');
  expect(screen.getByText('Shipped')).toBeInTheDocument();
});

test('labels every wire status with its catalogued label, newest submission first', async () => {
  const submissions = FEEDBACK_STATUSES.map((status, index) =>
    submission({
      id: `00000000-0000-4000-8000-00000000020${index}`,
      subject: `Submission ${index}`,
      status,
      declinedReason: status === 'declined' ? 'Out of scope.' : null,
      shippedVersion: status === 'shipped' ? '2.0.0' : null,
      createdAt: `2026-08-1${index}T12:00:00.000Z`,
    }),
  );
  // The server answers newest first; the list keeps that order.
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [...submissions].reverse() });

  renderPanel();

  const list = await screen.findByRole('list', { name: 'Your feedback submissions' });
  const rows = within(list).getAllByTestId('feedback-submission-row');
  expect(rows).toHaveLength(FEEDBACK_STATUSES.length);
  expect(rows[0]).toHaveTextContent(`Submission ${FEEDBACK_STATUSES.length - 1}`);
  for (const [index, status] of FEEDBACK_STATUSES.entries()) {
    const row = rowFor(`Submission ${index}`);
    const badge = row.querySelector(`[data-status="${status}"]`);
    expect(badge, status).toHaveTextContent(localizedMessage('en', `feedback.status.${status}`));
  }
});

test('renders the empty state at 390 px and German copy without hard-coded English', async () => {
  setViewportWidth(390);
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [] });

  renderPanel('/control/feedback', 'de');

  expect(await screen.findByText('Noch keine Einsendungen')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Meine Einsendungen' })).toBeInTheDocument();
});

test('shows loading, then a retryable error when the list read fails', async () => {
  const first = deferred<never>();
  vi.mocked(listMyFeedback)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue({ submissions: [submission()] });
  const user = userEvent.setup();

  renderPanel();

  expect(await screen.findByText('Loading your submissions…')).toBeInTheDocument();
  first.reject(new ApiError(503, 'UNAVAILABLE', 'down'));
  expect(await screen.findByText("Couldn't load your submissions.")).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('A quicker import flow')).toBeInTheDocument();
});

// ─── Thread + mark read ──────────────────────────────────────────────────────

test('opening a thread clears its unread badge, marks it read, and the badge stays clear after refetch', async () => {
  const unread = submission({ unreadReplyCount: 2 });
  vi.mocked(listMyFeedback)
    .mockResolvedValueOnce({ submissions: [unread] })
    .mockResolvedValue({ submissions: [{ ...unread, unreadReplyCount: 0 }] });
  const user = userEvent.setup();

  renderPanel();

  expect(await screen.findByTestId('feedback-unread-badge')).toHaveTextContent('2 unread replies');
  await user.click(openButtonFor(unread.subject!));

  expect(screen.getByTestId('location')).toHaveTextContent(`?submission=${ID_A}`);
  await waitFor(() => expect(markFeedbackRead).toHaveBeenCalledWith(ID_A));
  await waitFor(() => expect(listMyFeedback).toHaveBeenCalledTimes(2));

  await user.click(screen.getByRole('button', { name: 'All submissions' }));
  expect(await screen.findByText(unread.subject!)).toBeInTheDocument();
  expect(screen.queryByTestId('feedback-unread-badge')).not.toBeInTheDocument();
  // Focus returns to the row the thread was opened from.
  expect(openButtonFor(unread.subject!)).toHaveFocus();
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/control\/feedback$/);
});

test('a failed mark-read restores only its own badge, never a sibling that was cleared meanwhile', async () => {
  // The #1448 rollback wrote a whole-list snapshot back on error: A's failure,
  // settling after B was opened and cleared, resurrected B's badge.
  const a = submission({ id: ID_A, subject: 'Submission A', unreadReplyCount: 2 });
  const b = submission({ id: ID_B, subject: 'Submission B', unreadReplyCount: 3 });
  vi.mocked(listMyFeedback)
    .mockResolvedValueOnce({ submissions: [a, b] })
    // Server truth after B's read succeeded: A is still unread, B is read.
    .mockResolvedValue({ submissions: [a, { ...b, unreadReplyCount: 0 }] });
  const markA = deferred<void>();
  vi.mocked(markFeedbackRead).mockImplementation((id) =>
    id === ID_A ? markA.promise : Promise.resolve(),
  );
  const user = userEvent.setup();

  renderPanel();

  await screen.findByText('Submission A');
  await user.click(openButtonFor('Submission A'));
  await waitFor(() => expect(markFeedbackRead).toHaveBeenCalledWith(ID_A));
  await user.click(screen.getByRole('button', { name: 'All submissions' }));

  await user.click(openButtonFor('Submission B'));
  await waitFor(() => expect(markFeedbackRead).toHaveBeenCalledWith(ID_B));
  await waitFor(() => expect(listMyFeedback).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole('button', { name: 'All submissions' }));

  markA.reject(new ApiError(503, 'UNAVAILABLE', 'down'));
  await waitFor(() =>
    expect(within(rowFor('Submission A')).getByTestId('feedback-unread-badge')).toHaveTextContent(
      '2 unread replies',
    ),
  );
  // A's restored badge IS the completion signal: the rollback that could reach
  // B (the #1448 whole-list snapshot) lands in that same cache write, so by now
  // B shows whatever the rollback left it.
  expect(within(rowFor('Submission B')).queryByTestId('feedback-unread-badge')).toBeNull();
});

test('a failed mark-read restores the badge it cleared and says so in the thread', async () => {
  const unread = submission({ unreadReplyCount: 1 });
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [unread] });
  vi.mocked(markFeedbackRead).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
  const user = userEvent.setup();

  renderPanel();

  await screen.findByText(unread.subject!);
  await user.click(openButtonFor(unread.subject!));
  expect(await screen.findByText(/Couldn't mark the replies as read/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'All submissions' }));
  expect(await screen.findByTestId('feedback-unread-badge')).toHaveTextContent('1 unread reply');
});

test('a ?submission= deep link opens that conversation directly and marks it read', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({
    submissions: [
      submission({ id: ID_B, subject: 'Other one' }),
      submission({ id: ID_A, unreadReplyCount: 1 }),
    ],
  });
  vi.mocked(getFeedbackThread).mockResolvedValue(thread([message()]));

  renderPanel(`/control/feedback?submission=${ID_A}`);

  expect(await screen.findByText('Could you share an example?')).toBeInTheDocument();
  expect(getFeedbackThread).toHaveBeenCalledWith(ID_A, expect.anything(), expect.anything());
  expect(screen.getByTestId('feedback-thread-submission')).toHaveTextContent(
    'Please add a shortcut for my usual broker import.',
  );
  expect(screen.queryByText('Other one')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Conversation' })).toHaveFocus();
  await waitFor(() => expect(markFeedbackRead).toHaveBeenCalledWith(ID_A));
  expect(markFeedbackRead).toHaveBeenCalledTimes(1);
});

test('a deep link to a submission that is not in the list says so and reads nothing', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });
  const user = userEvent.setup();

  renderPanel(`/control/feedback?submission=${ID_B}`);

  expect(await screen.findByTestId('feedback-submission-missing')).toHaveTextContent(
    'This submission is no longer in your list.',
  );
  expect(getFeedbackThread).not.toHaveBeenCalled();
  expect(markFeedbackRead).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'All submissions' }));
  expect(await screen.findByText('A quicker import flow')).toBeInTheDocument();
});

test('shows the empty-thread state when nobody has replied yet', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });

  renderPanel(`/control/feedback?submission=${ID_A}`);

  expect(await screen.findByText(/No replies yet/)).toBeInTheDocument();
});

test('posts a reply and renders the conversation oldest first', async () => {
  const adminMessage = message();
  const reply = message({
    id: '00000000-0000-4000-8000-000000000102',
    senderId: '00000000-0000-4000-8000-000000000004',
    authorSide: 'submitter',
    body: 'Here is one from my broker export.',
    createdAt: '2026-08-18T12:01:00.000Z',
  });
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });
  vi.mocked(getFeedbackThread).mockResolvedValue(thread([adminMessage]));
  vi.mocked(sendFeedbackMessage).mockResolvedValue({ message: reply });
  const user = userEvent.setup();

  renderPanel(`/control/feedback?submission=${ID_A}`);

  expect(await screen.findByText(adminMessage.body)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Reply'), `  ${reply.body}  `);
  await user.click(screen.getByRole('button', { name: 'Send reply' }));

  await waitFor(() => expect(sendFeedbackMessage).toHaveBeenCalledWith(ID_A, { body: reply.body }));
  await waitFor(() => expect(screen.getAllByTestId('feedback-thread-message')).toHaveLength(2));
  const rendered = screen.getAllByTestId('feedback-thread-message');
  expect(rendered[0]).toHaveTextContent('BetterTrack team');
  expect(rendered[0]).toHaveTextContent(adminMessage.body);
  expect(rendered[1]).toHaveTextContent('You');
  expect(rendered[1]).toHaveTextContent(reply.body);
  expect(screen.getByLabelText('Reply')).toHaveValue('');
});

test('waits for the initial conversation before a reply can be sent', async () => {
  const pending = deferred<FeedbackThreadResponse>();
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });
  vi.mocked(getFeedbackThread).mockReturnValue(pending.promise);
  const user = userEvent.setup();

  renderPanel(`/control/feedback?submission=${ID_A}`);

  await user.type(await screen.findByLabelText('Reply'), 'An example is coming.');
  expect(screen.getByRole('button', { name: 'Send reply' })).toBeDisabled();

  pending.resolve(thread());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send reply' })).toBeEnabled());
});

test('keeps the draft and shows an error when a reply fails', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });
  vi.mocked(sendFeedbackMessage).mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'down'));
  const user = userEvent.setup();

  renderPanel(`/control/feedback?submission=${ID_A}`);

  await screen.findByText(/No replies yet/);
  await user.type(screen.getByLabelText('Reply'), 'Still broken.');
  await user.click(screen.getByRole('button', { name: 'Send reply' }));

  expect(
    await screen.findByText("Couldn't send your reply. Please try again."),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Reply')).toHaveValue('Still broken.');
});

test('loads earlier replies, and restarts from the newest page on an unknown cursor', async () => {
  const newest = message({ id: '00000000-0000-4000-8000-000000000111', body: 'Newest reply' });
  const older = message({ id: '00000000-0000-4000-8000-000000000110', body: 'Older reply' });
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });
  vi.mocked(getFeedbackThread).mockImplementation((_id, params) =>
    params?.cursor
      ? Promise.reject(new ApiError(400, FEEDBACK_THREAD_CURSOR_UNKNOWN, 'Unknown thread cursor.'))
      : Promise.resolve(thread([newest], newest.id)),
  );
  const user = userEvent.setup();

  renderPanel(`/control/feedback?submission=${ID_A}`);

  expect(await screen.findByText('Newest reply')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Load earlier replies' }));
  await waitFor(() =>
    expect(
      vi.mocked(getFeedbackThread).mock.calls.filter(([, params]) => params?.cursor === undefined),
    ).toHaveLength(2),
  );
  expect(await screen.findByText('Newest reply')).toBeInTheDocument();
  expect(screen.queryByText(older.body)).not.toBeInTheDocument();
});

// ─── Withdraw ────────────────────────────────────────────────────────────────

test('withdraw asks first; a failure keeps the row with an error, a success removes it', async () => {
  const target = submission({ subject: 'Withdraw me' });
  const keep = submission({ id: ID_B, subject: 'Keep me' });
  vi.mocked(listMyFeedback)
    .mockResolvedValueOnce({ submissions: [target, keep] })
    .mockResolvedValue({ submissions: [keep] });
  vi.mocked(withdrawFeedback)
    .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'down'))
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();

  renderPanel();

  await user.click(await screen.findByRole('button', { name: 'Withdraw “Withdraw me”' }));
  // Nothing is sent before the confirmation; focus lands on the safe choice.
  expect(withdrawFeedback).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

  await user.click(screen.getByRole('button', { name: 'Withdraw submission' }));
  expect(
    await screen.findByText("Couldn't withdraw this submission. Please try again."),
  ).toBeInTheDocument();
  expect(screen.getByText('Withdraw me')).toBeInTheDocument();
  expect(withdrawFeedback).toHaveBeenCalledWith(ID_A);

  await user.click(screen.getByRole('button', { name: 'Withdraw submission' }));
  await waitFor(() => expect(screen.queryByText('Withdraw me')).not.toBeInTheDocument());
  expect(screen.getByText('Keep me')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Submission withdrawn.');
  expect(screen.getByRole('heading', { name: 'My submissions' })).toHaveFocus();
});

test('cancelling a withdraw sends nothing and returns focus to the Withdraw button', async () => {
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [submission()] });
  const user = userEvent.setup();

  renderPanel();

  await user.click(await screen.findByRole('button', { name: 'Withdraw “A quicker import flow”' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(withdrawFeedback).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Withdraw “A quicker import flow”' })).toHaveFocus();
});
