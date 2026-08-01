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

  test('can keep a contextual loading status out of the visual layout', () => {
    renderState({
      loading: true,
      error: null,
      loadingLabel: 'Checking categories…',
      loadingPresentation: 'sr-only',
    });

    expect(screen.getByRole('status')).toHaveClass('sr-only');
    expect(screen.getByRole('status')).toHaveTextContent('Checking categories…');
  });

  test('a compact read stays inline while loading instead of inserting a spinner row', () => {
    // `compact` promises not to erase or displace usable sibling content. The
    // error branch honoured that while loading fell through to the full
    // Spinner, so an auxiliary read still grew and shrank the layout around it
    // on every visit.
    const { container } = renderState({ loading: true, error: null, compact: true });

    const status = screen.getByRole('status');
    expect(status.tagName).toBe('SPAN');
    expect(status).toHaveTextContent('Loading…');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  test('a non-compact read still gets the full spinner', () => {
    const { container } = renderState({ loading: true, error: null });

    expect(container.querySelector('.animate-spin')).not.toBeNull();
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

// A surface with several concurrent reads used to collapse them with `??`, so
// whichever error was DECLARED first decided the classification for all of
// them: a 5xx behind a confirmed 403 silently lost its Retry, and a confirmed
// 403 behind a 5xx gained one. Order must not decide any of this, which is why
// every case below is asserted in both declaration orders.
describe('AsyncReadState over a group of reads', () => {
  const outage = () => new ApiError(503, 'UNAVAILABLE', 'down');
  const confirmed = (status: number) => new ApiError(status, 'NOT_AVAILABLE', 'secret');

  test.each([401, 403, 404])(
    'offers recovery for a simultaneous outage and confirmed %i, in either order',
    (status) => {
      const retryOutage = vi.fn();
      const retryConfirmed = vi.fn();

      for (const reads of [
        [
          { error: outage(), refetch: retryOutage },
          { error: confirmed(status), refetch: retryConfirmed },
        ],
        [
          { error: confirmed(status), refetch: retryConfirmed },
          { error: outage(), refetch: retryOutage },
        ],
      ]) {
        retryOutage.mockClear();
        retryConfirmed.mockClear();
        const view = renderState({ loading: false, reads });

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        // Only the recoverable read is re-run; the confirmed rejection is never
        // retried, and its message never reaches the user.
        expect(retryOutage).toHaveBeenCalledOnce();
        expect(retryConfirmed).not.toHaveBeenCalled();
        expect(screen.queryByText('secret')).not.toBeInTheDocument();
        view.unmount();
      }
    },
  );

  test('re-runs every outage read in the group and nothing else', () => {
    const first = vi.fn();
    const second = vi.fn();
    const healthy = vi.fn();
    const rejected = vi.fn();
    renderState({
      loading: false,
      reads: [
        { error: outage(), refetch: first },
        { error: null, refetch: healthy },
        { error: confirmed(403), refetch: rejected },
        { error: outage(), refetch: second },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(healthy).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });

  test.each([401, 403, 404])(
    'keeps a group of confirmed %i failures terminal, with no retry',
    (status) => {
      renderState({
        loading: false,
        reads: [
          { error: confirmed(status), refetch: vi.fn() },
          { error: new Error('unknown'), refetch: vi.fn() },
        ],
      });

      expect(screen.getByRole('alert')).toHaveTextContent("This information isn't available.");
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    },
  );

  test('renders nothing while every read in the group is healthy', () => {
    const { container } = renderState({
      loading: false,
      reads: [{ error: null }, { error: null, refetch: vi.fn() }],
    });

    expect(container).toBeEmptyDOMElement();
  });

  test('states an outage without a retry affordance when the read cannot be re-run', () => {
    renderState({ loading: false, reads: [{ error: outage() }] });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
