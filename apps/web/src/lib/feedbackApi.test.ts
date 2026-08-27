import { afterEach, expect, test, vi } from 'vitest';

import type { CreateFeedbackRequest } from '@bettertrack/contracts';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

import { apiRequest } from './apiClient';
import { submitFeedback } from './feedbackApi';

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
