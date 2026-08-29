import { afterEach, expect, test, vi } from 'vitest';

import type {
  CreateFeedbackRequest,
  FeedbackThreadResponse,
  MyFeedbackResponse,
  SendFeedbackMessageResponse,
} from '@bettertrack/contracts';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

import { apiRequest } from './apiClient';
import {
  getFeedbackThread,
  listMyFeedback,
  markFeedbackRead,
  sendFeedbackMessage,
  submitFeedback,
} from './feedbackApi';

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

test('uses the caller-owned submissions and thread endpoints with their contracts', async () => {
  const feedbackId = '00000000-0000-4000-8000-000000000001';
  const threadResponse: FeedbackThreadResponse = {
    thread: { id: feedbackId, unreadCount: 1 },
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        feedbackId,
        senderId: null,
        authorSide: 'admin',
        body: 'Could you share an example?',
        createdAt: '2026-08-18T12:00:00.000Z',
      },
    ],
    nextCursor: null,
  };
  const myResponse: MyFeedbackResponse = { submissions: [] };
  const sentResponse: SendFeedbackMessageResponse = {
    message: {
      id: '00000000-0000-4000-8000-000000000003',
      feedbackId,
      senderId: '00000000-0000-4000-8000-000000000004',
      authorSide: 'submitter',
      body: 'Here is one.',
      createdAt: '2026-08-18T12:01:00.000Z',
    },
  };
  const controller = new AbortController();
  vi.mocked(apiRequest)
    .mockResolvedValueOnce(myResponse)
    .mockResolvedValueOnce(threadResponse)
    .mockResolvedValueOnce(sentResponse)
    .mockResolvedValueOnce({ ok: true });

  await expect(listMyFeedback(controller.signal)).resolves.toEqual(myResponse);
  await expect(getFeedbackThread(feedbackId, { cursor: feedbackId, limit: 25 })).resolves.toEqual(
    threadResponse,
  );
  await expect(sendFeedbackMessage(feedbackId, { body: 'Here is one.' })).resolves.toEqual(
    sentResponse,
  );
  await expect(markFeedbackRead(feedbackId)).resolves.toBeUndefined();

  expect(apiRequest).toHaveBeenNthCalledWith(1, '/feedback/mine', { signal: controller.signal });
  expect(apiRequest).toHaveBeenNthCalledWith(2, `/feedback/${feedbackId}/messages`, {
    query: { cursor: feedbackId, limit: 25 },
    signal: undefined,
  });
  expect(apiRequest).toHaveBeenNthCalledWith(3, `/feedback/${feedbackId}/messages`, {
    method: 'POST',
    body: { body: 'Here is one.' },
  });
  expect(apiRequest).toHaveBeenNthCalledWith(4, `/feedback/${feedbackId}/read`, { method: 'POST' });
});
