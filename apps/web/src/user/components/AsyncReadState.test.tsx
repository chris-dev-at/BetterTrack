import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { AsyncReadState } from './AsyncReadState';

function renderState(props: React.ComponentProps<typeof AsyncReadState>) {
  return render(
    <I18nProvider>
      <AsyncReadState {...props} />
    </I18nProvider>,
  );
}

describe('AsyncReadState', () => {
  test('renders a compact loading status', () => {
    renderState({ loading: true, error: null });

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  test('offers retry for a transport or server outage', () => {
    const onRetry = vi.fn();
    renderState({ loading: false, error: new ApiError(503, 'UNAVAILABLE', 'down'), onRetry });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test.each([401, 403, 404])('keeps confirmed status %i unavailable without retry', (status) => {
    renderState({
      loading: false,
      error: new ApiError(status, 'NOT_AVAILABLE', 'secret'),
      onRetry: vi.fn(),
    });

    expect(screen.getByRole('alert')).toHaveTextContent("This information isn't available.");
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  test('does not guess that an unknown failure is retryable', () => {
    renderState({ loading: false, error: new Error('unknown'), onRetry: vi.fn() });

    expect(screen.getByRole('alert')).toHaveTextContent("This information isn't available.");
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
