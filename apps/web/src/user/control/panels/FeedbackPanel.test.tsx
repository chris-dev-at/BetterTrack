import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../lib/feedbackApi', () => ({
  getFeedbackThread: vi.fn(),
  listMyFeedback: vi.fn(),
  markFeedbackRead: vi.fn(),
  sendFeedbackMessage: vi.fn(),
  submitFeedback: vi.fn(),
  withdrawFeedback: vi.fn(),
}));

import { I18nProvider } from '../../../i18n';
import { listMyFeedback, submitFeedback } from '../../../lib/feedbackApi';
import { FeedbackPanel } from './FeedbackPanel';

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <MemoryRouter>
          <FeedbackPanel />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listMyFeedback).mockReset();
  vi.mocked(submitFeedback).mockReset();
  vi.mocked(listMyFeedback).mockResolvedValue({ submissions: [] });
});

test('keeps the Settings entry compact until the feedback dialog is requested', async () => {
  const user = userEvent.setup();
  renderPanel();

  expect(screen.queryByRole('dialog', { name: 'Send feedback' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Write feedback' }));
  expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument();

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Send feedback' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Write feedback' })).toBeInTheDocument();
});

test('lists the submissions under the composer and refreshes them after a new report', async () => {
  vi.mocked(submitFeedback).mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000009',
    createdAt: '2026-08-18T12:00:00.000Z',
  });
  const user = userEvent.setup();
  renderPanel();

  expect(await screen.findByText('No submissions yet')).toBeInTheDocument();
  expect(listMyFeedback).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole('button', { name: 'Write feedback' }));
  await user.selectOptions(screen.getByLabelText('Category'), 'bug');
  await user.type(screen.getByLabelText('Message'), 'The import preview froze.');
  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

  await waitFor(() => expect(listMyFeedback).toHaveBeenCalledTimes(2));
});
