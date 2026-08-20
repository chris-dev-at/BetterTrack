import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../lib/feedbackApi', () => ({
  getFeedbackThread: vi.fn(),
  listMyFeedback: vi.fn(),
  markFeedbackRead: vi.fn(),
  sendFeedbackMessage: vi.fn(),
}));

import type {
  FeedbackThreadMessage,
  FeedbackThreadResponse,
  MyFeedbackSubmission,
} from '@bettertrack/contracts';

import { I18nProvider } from '../../i18n';
import {
  getFeedbackThread,
  listMyFeedback,
  markFeedbackRead,
  sendFeedbackMessage,
} from '../../lib/feedbackApi';
import { setViewportWidth } from '../../test/viewport';
import { MyFeedbackSubmissionsDialog } from './MyFeedbackSubmissionsDialog';

const FEEDBACK_ID = '00000000-0000-4000-8000-000000000001';

function submission(overrides: Partial<MyFeedbackSubmission> = {}): MyFeedbackSubmission {
  return {
    id: FEEDBACK_ID,
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

function thread(messages: FeedbackThreadMessage[] = []): FeedbackThreadResponse {
  return {
    thread: { id: FEEDBACK_ID, unreadCount: 0 },
    messages,
    nextCursor: null,
  };
}

function renderDialog(onWriteFeedback = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <MyFeedbackSubmissionsDialog onClose={vi.fn()} onWriteFeedback={onWriteFeedback} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient, onWriteFeedback };
}

beforeEach(() => {
  vi.mocked(getFeedbackThread).mockReset();
  vi.mocked(listMyFeedback).mockReset();
  vi.mocked(markFeedbackRead).mockReset();
  vi.mocked(sendFeedbackMessage).mockReset();
  vi.mocked(markFeedbackRead).mockResolvedValue(undefined);
});

afterEach(() => {
  setViewportWidth(1440);
});

test('renders a declined reason inline on the submission row', async () => {
  const declined = submission({
    status: 'declined',
    declinedReason: 'It overlaps with the new import review flow.',
  });
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [declined] });

  renderDialog();

  expect(
    await screen.findByText('Declined — It overlaps with the new import review flow.'),
  ).toBeInTheDocument();
  expect(screen.getByText('Status changed 18 Aug 2026, 14:00')).toBeInTheDocument();
});

test('renders a shipped version as the submission row headline', async () => {
  const shipped = submission({ status: 'shipped', shippedVersion: '1.4.0' });
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [shipped] });

  renderDialog();

  expect(await screen.findByText('Shipped in 1.4.0')).toBeInTheDocument();
  expect(screen.getByText('Shipped')).toBeInTheDocument();
});

test('clears an unread-reply badge when its thread opens and keeps it clear after refetch', async () => {
  const unread = submission({ unreadReplyCount: 2 });
  vi.mocked(listMyFeedback)
    .mockResolvedValueOnce({ submissions: [unread] })
    .mockResolvedValue({ submissions: [{ ...unread, unreadReplyCount: 0 }] });
  vi.mocked(getFeedbackThread).mockResolvedValue(thread());
  const user = userEvent.setup();

  renderDialog();

  expect(await screen.findByLabelText('2 unread replies')).toBeInTheDocument();
  await user.click(screen.getByText(unread.subject!).closest('button')!);

  await waitFor(() => expect(markFeedbackRead).toHaveBeenCalledWith(FEEDBACK_ID));
  await waitFor(() => expect(screen.queryByLabelText('2 unread replies')).not.toBeInTheDocument());
  await waitFor(() => expect(listMyFeedback).toHaveBeenCalledTimes(2));
  expect(screen.queryByLabelText('2 unread replies')).not.toBeInTheDocument();
});

test('posts a reply and renders the conversation in chronological order', async () => {
  const adminMessage: FeedbackThreadMessage = {
    id: '00000000-0000-4000-8000-000000000002',
    feedbackId: FEEDBACK_ID,
    senderId: null,
    authorSide: 'admin',
    body: 'Could you share an example?',
    createdAt: '2026-08-18T12:00:00.000Z',
  };
  const reply: FeedbackThreadMessage = {
    id: '00000000-0000-4000-8000-000000000003',
    feedbackId: FEEDBACK_ID,
    senderId: '00000000-0000-4000-8000-000000000004',
    authorSide: 'submitter',
    body: 'Here is one from my broker export.',
    createdAt: '2026-08-18T12:01:00.000Z',
  };
  const current = submission();
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [current] });
  vi.mocked(getFeedbackThread).mockResolvedValue(thread([adminMessage]));
  vi.mocked(sendFeedbackMessage).mockResolvedValue({ message: reply });
  const user = userEvent.setup();

  renderDialog();

  await user.click((await screen.findByText(current.subject!)).closest('button')!);
  expect(await screen.findByText(adminMessage.body)).toBeInTheDocument();

  await user.type(screen.getByLabelText('Reply'), reply.body);
  await user.click(screen.getByRole('button', { name: 'Send reply' }));

  await waitFor(() =>
    expect(sendFeedbackMessage).toHaveBeenCalledWith(FEEDBACK_ID, { body: reply.body }),
  );
  await waitFor(() => expect(screen.getAllByTestId('feedback-thread-message')).toHaveLength(2));
  const renderedMessages = screen.getAllByTestId('feedback-thread-message');
  expect(renderedMessages[0]).toHaveTextContent(adminMessage.body);
  expect(renderedMessages[1]).toHaveTextContent(reply.body);
});

test('offers the feedback form from an empty phone-sized submissions list', async () => {
  setViewportWidth(390);
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [] });
  const user = userEvent.setup();
  const { onWriteFeedback } = renderDialog();

  expect(await screen.findByText('No submissions yet')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Write feedback' }));
  expect(onWriteFeedback).toHaveBeenCalledOnce();
});
