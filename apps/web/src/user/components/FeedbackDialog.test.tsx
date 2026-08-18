import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';

import { FEEDBACK_MESSAGE_MAX_LENGTH } from '@bettertrack/contracts';

vi.mock('../../lib/feedbackApi', () => ({ submitFeedback: vi.fn() }));

import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { submitFeedback } from '../../lib/feedbackApi';
import { setViewportWidth } from '../../test/viewport';
import { FeedbackPanel } from '../control/panels/FeedbackPanel';
import { FeedbackDialog } from './FeedbackDialog';

function renderDialog(path = '/portfolio?portfolio=portfolio-1') {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={[path]}>
        <FeedbackDialog onClose={vi.fn()} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

function renderFeedbackPanel(screenPath: string) {
  return render(
    <I18nProvider initialLocale="en">
      <MemoryRouter initialEntries={['/control/feedback']}>
        <FeedbackPanel screen={screenPath} />
      </MemoryRouter>
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  setViewportWidth(1440);
});

test('at 390 px submits feedback from the Settings panel with client context', async () => {
  setViewportWidth(390);
  vi.mocked(submitFeedback).mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-18T12:00:00.000Z',
  });
  const user = userEvent.setup();
  renderFeedbackPanel('/portfolio?portfolio=portfolio-1');

  await user.click(screen.getByRole('button', { name: 'Write feedback' }));

  const dialog = screen.getByRole('dialog', { name: 'Send feedback' });
  expect(dialog).toHaveClass('bt-dialog__panel--phone-sheet');
  expect(screen.getByText(`0/${FEEDBACK_MESSAGE_MAX_LENGTH}`)).toBeInTheDocument();

  await user.selectOptions(screen.getByLabelText('Category'), 'feature');
  await user.type(screen.getByLabelText('Subject (optional)'), '  A quicker import flow  ');
  await user.type(screen.getByLabelText('Message'), '  Please add a shortcut.  ');
  expect(screen.getByText(`26/${FEEDBACK_MESSAGE_MAX_LENGTH}`)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

  await waitFor(() =>
    expect(submitFeedback).toHaveBeenCalledWith({
      category: 'feature',
      subject: 'A quicker import flow',
      message: 'Please add a shortcut.',
      context: {
        platform: 'web',
        appVersion: expect.any(String),
        browser: expect.any(String),
        locale: 'en',
        screen: '/portfolio?portfolio=portfolio-1',
      },
    }),
  );
  expect(await screen.findByText('Thanks — your feedback was submitted.')).toBeInTheDocument();
});

test('keeps an in-flight submission open to prevent duplicate feedback', async () => {
  let settleSubmission!: () => void;
  const pendingSubmission = new Promise<Awaited<ReturnType<typeof submitFeedback>>>((resolve) => {
    settleSubmission = () =>
      resolve({
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: '2026-08-18T12:00:00.000Z',
      });
  });
  vi.mocked(submitFeedback).mockReturnValue(pendingSubmission);
  const user = userEvent.setup();
  renderFeedbackPanel('/portfolio?portfolio=portfolio-1');

  await user.click(screen.getByRole('button', { name: 'Write feedback' }));
  const dialog = screen.getByRole('dialog', { name: 'Send feedback' });
  await user.selectOptions(screen.getByLabelText('Category'), 'bug');
  await user.type(
    screen.getByLabelText('Message'),
    'The request must stay visible while it sends.',
  );
  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

  await waitFor(() => expect(submitFeedback).toHaveBeenCalledOnce());
  expect(screen.queryByRole('button', { name: 'Close dialog' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

  await user.keyboard('{Escape}');
  fireEvent.mouseDown(dialog.parentElement!);
  expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument();
  expect(submitFeedback).toHaveBeenCalledOnce();

  settleSubmission();
  expect(await screen.findByText('Thanks — your feedback was submitted.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog', { name: 'Send feedback' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Write feedback' }));
  expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument();
  expect(submitFeedback).toHaveBeenCalledOnce();
});

test('accepts exactly 5000 characters and blocks a longer message locally', async () => {
  vi.mocked(submitFeedback).mockResolvedValue({
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-18T12:00:00.000Z',
  });
  const user = userEvent.setup();
  const view = renderDialog();

  await user.selectOptions(screen.getByLabelText('Category'), 'bug');
  const message = screen.getByLabelText('Message');
  fireEvent.change(message, { target: { value: 'a'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH) } });
  expect(
    screen.getByText(`${FEEDBACK_MESSAGE_MAX_LENGTH}/${FEEDBACK_MESSAGE_MAX_LENGTH}`),
  ).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));
  await waitFor(() => expect(submitFeedback).toHaveBeenCalledOnce());

  // A fresh dialog makes the over-limit guard observable even if a browser's
  // native maxlength normally prevents the extra keystroke.
  view.unmount();
  renderDialog('/workbench');
  const secondDialog = screen.getByRole('dialog', { name: 'Send feedback' });
  const secondCategory = secondDialog.querySelector<HTMLSelectElement>('#feedback-category')!;
  const secondMessage = secondDialog.querySelector<HTMLTextAreaElement>('#feedback-message')!;
  fireEvent.change(secondCategory, { target: { value: 'other' } });
  fireEvent.change(secondMessage, {
    target: { value: 'a'.repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1) },
  });

  await user.click(secondDialog.querySelector<HTMLButtonElement>('button[type="submit"]')!);
  expect(submitFeedback).toHaveBeenCalledOnce();
  expect(secondMessage.value).toHaveLength(FEEDBACK_MESSAGE_MAX_LENGTH + 1);
  expect(
    await screen.findByText('Your message must be no more than 5000 characters.'),
  ).toBeInTheDocument();
});

test('shows a localized API validation error and keeps typed feedback after a failed submission', async () => {
  vi.mocked(submitFeedback).mockRejectedValue(
    new ApiError(400, 'VALIDATION_ERROR', 'Invalid request.', {
      fieldErrors: { message: ['String must contain at most 5000 character(s)'] },
      formErrors: [],
    }),
  );
  const user = userEvent.setup();
  renderDialog();

  await user.selectOptions(screen.getByLabelText('Category'), 'other');
  await user.type(screen.getByLabelText('Subject (optional)'), 'Something else');
  await user.type(screen.getByLabelText('Message'), 'The typed report must remain here.');
  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

  expect(
    await screen.findByText('Your message must be no more than 5000 characters.'),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Subject (optional)')).toHaveValue('Something else');
  expect(screen.getByLabelText('Message')).toHaveValue('The typed report must remain here.');
});

test('falls back safely when validation details do not contain field error arrays', async () => {
  vi.mocked(submitFeedback).mockRejectedValue(
    new ApiError(400, 'VALIDATION_ERROR', 'Invalid request.', {
      fieldErrors: { message: 'not an array' },
    }),
  );
  const user = userEvent.setup();
  renderDialog();

  await user.selectOptions(screen.getByLabelText('Category'), 'other');
  await user.type(screen.getByLabelText('Message'), 'The service rejected this request.');
  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

  expect(
    await screen.findByText("Couldn't submit your feedback. Please try again."),
  ).toBeInTheDocument();
});

test('rejects a whitespace-only message before submitting', async () => {
  const user = userEvent.setup();
  renderDialog();

  await user.selectOptions(screen.getByLabelText('Category'), 'other');
  await user.type(screen.getByLabelText('Message'), '   ');
  await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

  expect(submitFeedback).not.toHaveBeenCalled();
  expect(await screen.findByText('Write a message.')).toBeInTheDocument();
});
