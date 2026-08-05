import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { MutationFeedbackProvider, useMutationFeedback } from './useMutationFeedback';

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
