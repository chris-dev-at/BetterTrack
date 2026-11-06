import { afterEach, expect, test, vi } from 'vitest';

import type { CreateFeedbackRequest } from '@bettertrack/contracts';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

import { apiRequest } from './apiClient';
import {
  getFeedbackThread,
  listMyFeedback,
  markFeedbackRead,
  sendFeedbackMessage,
  submitFeedback,
  withdrawFeedback,
} from './feedbackApi';

const FEEDBACK_ID = '00000000-0000-4000-8000-0000000000f1';
const MESSAGE_ID = '00000000-0000-4000-8000-0000000000a1';

function threadMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    feedbackId: FEEDBACK_ID,
    senderId: null,
    authorSide: 'admin',
    body: 'Thanks, this is on the list.',
    createdAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

test('posts the locked feedback contract unchanged', async () => {
  const body: CreateFeedbackRequest = {
    category: 'feature',
    subject: 'A quicker import flow',
    message: 'Please add a shortcut for my usual broker import.',
    context: {
      platform: 'web',
      appVersion: 'bettertrack-web@test',
      browser: 'test browser',
      locale: 'en',
      screen: '/portfolio',
    },
  };
  const response = {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-18T12:00:00.000Z',
  };
  vi.mocked(apiRequest).mockResolvedValue(response);

  await expect(submitFeedback(body)).resolves.toEqual(response);
  expect(apiRequest).toHaveBeenCalledWith('/feedback', { method: 'POST', body });
});

test('lists my submissions and parses them with the contract', async () => {
  const response = {
    submissions: [
      {
        id: FEEDBACK_ID,
        category: 'bug',
        subject: 'Chart flickers',
        message: 'The chart flickers on resize.',
        status: 'declined',
        lastStatusChangeAt: '2026-10-21T09:00:00.000Z',
        declinedReason: 'Cannot reproduce on current builds.',
        shippedVersion: null,
        unreadReplyCount: 2,
        createdAt: '2026-10-20T09:00:00.000Z',
      },
    ],
  };
  vi.mocked(apiRequest).mockResolvedValue(response);
  const signal = new AbortController().signal;

  await expect(listMyFeedback(signal)).resolves.toEqual(response);
  expect(apiRequest).toHaveBeenCalledWith('/feedback/mine', { signal });
});

test('rejects a submission list that breaks the contract (declined without a reason)', async () => {
  vi.mocked(apiRequest).mockResolvedValue({
    submissions: [
      {
        id: FEEDBACK_ID,
        category: 'bug',
        subject: null,
        message: 'x',
        status: 'declined',
        lastStatusChangeAt: '2026-10-21T09:00:00.000Z',
        declinedReason: null,
        shippedVersion: null,
        unreadReplyCount: 0,
        createdAt: '2026-10-20T09:00:00.000Z',
      },
    ],
  });

  await expect(listMyFeedback()).rejects.toThrow();
});

test('reads one thread page with the cursor and limit as query parameters', async () => {
  const response = {
    thread: { id: FEEDBACK_ID, unreadCount: 1 },
    messages: [threadMessage()],
    nextCursor: MESSAGE_ID,
  };
  vi.mocked(apiRequest).mockResolvedValue(response);
  const signal = new AbortController().signal;

  await expect(
    getFeedbackThread(FEEDBACK_ID, { cursor: MESSAGE_ID, limit: 20 }, signal),
  ).resolves.toEqual(response);
  expect(apiRequest).toHaveBeenCalledWith(`/feedback/${FEEDBACK_ID}/messages`, {
    query: { cursor: MESSAGE_ID, limit: 20 },
    signal,
  });
});

test('rejects a thread page carrying a field the contract does not know', async () => {
  vi.mocked(apiRequest).mockResolvedValue({
    thread: { id: FEEDBACK_ID, unreadCount: 0 },
    messages: [threadMessage({ senderEmail: 'staff@example.com' })],
    nextCursor: null,
  });

  await expect(getFeedbackThread(FEEDBACK_ID)).rejects.toThrow();
});

test('posts a reply and parses the created message', async () => {
  const response = { message: threadMessage({ authorSide: 'submitter', body: 'Still happens.' }) };
  vi.mocked(apiRequest).mockResolvedValue(response);

  await expect(sendFeedbackMessage(FEEDBACK_ID, { body: 'Still happens.' })).resolves.toEqual(
    response,
  );
  expect(apiRequest).toHaveBeenCalledWith(`/feedback/${FEEDBACK_ID}/messages`, {
    method: 'POST',
    body: { body: 'Still happens.' },
  });
});

test('marks a thread read and insists on the { ok: true } acknowledgement', async () => {
  vi.mocked(apiRequest).mockResolvedValueOnce({ ok: true });
  await expect(markFeedbackRead(FEEDBACK_ID)).resolves.toBeUndefined();
  expect(apiRequest).toHaveBeenCalledWith(`/feedback/${FEEDBACK_ID}/read`, { method: 'POST' });

  vi.mocked(apiRequest).mockResolvedValueOnce({ ok: false });
  await expect(markFeedbackRead(FEEDBACK_ID)).rejects.toThrow();
});

test('withdraws with DELETE and resolves on the 204 empty body', async () => {
  // apiRequest answers a 204 with `undefined`; withdraw must not try to parse it.
  vi.mocked(apiRequest).mockResolvedValue(undefined);

  await expect(withdrawFeedback(FEEDBACK_ID)).resolves.toBeUndefined();
  expect(apiRequest).toHaveBeenCalledWith(`/feedback/${FEEDBACK_ID}`, { method: 'DELETE' });
});

test('encodes the submission id into every per-submission path', async () => {
  vi.mocked(apiRequest).mockResolvedValue(undefined);

  await withdrawFeedback('a/b?c');
  expect(apiRequest).toHaveBeenCalledWith('/feedback/a%2Fb%3Fc', { method: 'DELETE' });
});
