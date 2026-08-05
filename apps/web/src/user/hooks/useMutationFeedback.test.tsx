import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import { ApiError } from '../../lib/apiClient';
import {
  MUTATION_FEEDBACK_DURATION_MS,
  MutationFeedbackProvider,
  useMutationFeedback,
} from './useMutationFeedback';

function FeedbackHarness() {
  const feedback = useMutationFeedback();
  return (
    <>
      <button onClick={() => feedback.success('Saved once.')} type="button">
        Success
      </button>
      <button onClick={() => feedback.error('Try again.')} type="button">
        Error
      </button>
      <button
        onClick={() =>
          feedback.error(
            'Generic mutation failure.',
            new ApiError(429, 'RATE_LIMITED', 'Too many requests.'),
          )
        }
        type="button"
      >
        Rate limited
      </button>
      <button onClick={() => feedback.rateLimit("You're doing that too fast.")} type="button">
        Policy notice
      </button>
    </>
  );
}

test('keeps one mutation toast and replaces it with the latest result', () => {
  render(
    <MutationFeedbackProvider>
      <FeedbackHarness />
    </MutationFeedbackProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Success' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Saved once.');
  expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'success');
  expect(screen.getByRole('alert').style.boxShadow).toContain('var(--bt-pos)');

  fireEvent.click(screen.getByRole('button', { name: 'Error' }));
  expect(screen.queryByText('Saved once.')).not.toBeInTheDocument();
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent('Try again.');
  expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
  expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'error');
  expect(screen.getByRole('alert').style.boxShadow).toContain('var(--bt-neg)');

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('leaves rate-limit failures to the app-wide response policy', () => {
  render(
    <MutationFeedbackProvider>
      <FeedbackHarness />
    </MutationFeedbackProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Rate limited' }));

  expect(screen.queryByText('Generic mutation failure.')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('the rate-limit notice takes over the slot from a still-showing success', () => {
  // The bug this guards: the two notices used to have separate renderers of the
  // same fixed toast position, so the older success stayed mounted underneath —
  // two alerts, with the stale one painting over the current failure.
  render(
    <MutationFeedbackProvider>
      <FeedbackHarness />
    </MutationFeedbackProvider>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Success' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Saved once.');

  fireEvent.click(screen.getByRole('button', { name: 'Policy notice' }));

  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent("You're doing that too fast.");
  expect(screen.queryByText('Saved once.')).not.toBeInTheDocument();
});

test('the rate-limit notice stays put until dismissed or replaced', () => {
  vi.useFakeTimers();
  try {
    render(
      <MutationFeedbackProvider>
        <FeedbackHarness />
      </MutationFeedbackProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Policy notice' }));
    act(() => vi.advanceTimersByTime(MUTATION_FEEDBACK_DURATION_MS * 3));

    // Unlike a mutation result, "wait 30 seconds" must not expire before the
    // wait it describes does — it keeps the standalone toast's old lifetime.
    expect(screen.getByRole('alert')).toHaveTextContent("You're doing that too fast.");

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // A later mutation result still auto-expires as usual — the sticky notice
    // must not leave the timer permanently disarmed.
    fireEvent.click(screen.getByRole('button', { name: 'Success' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Saved once.');
    act(() => vi.advanceTimersByTime(MUTATION_FEEDBACK_DURATION_MS));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
