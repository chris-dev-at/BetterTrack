import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createRootErrorOptions } from '../rootErrorHandling';
import { ErrorBoundary } from './ErrorBoundary';

// Silence React's default caught-error diagnostics in tests that do not supply
// the application's explicit root handler.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  test('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('shows generic copy and a stable correlation id without rendering exception detail', async () => {
    const user = userEvent.setup();
    const secret = 'reset-token-super-secret-capability';
    const error = new Error(secret);

    // `never` return: TS would otherwise infer `void`, an invalid JSX return.
    function Bomb(): never {
      throw error;
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(
      screen.getByText(
        "We couldn't display this page. Try again. If the problem continues, share the reference below.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent(secret);

    const firstReference = screen.getByText(/^Reference ID: /).textContent;
    expect(firstReference).toMatch(/^Reference ID: \S+$/);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText(/^Reference ID: /)).toHaveTextContent(firstReference ?? '');
  });

  test('suppresses raw caught-error detail with production root options', () => {
    const secret = 'production-reset-token-super-secret-capability';
    const error = new Error(secret);

    function Bomb(): never {
      throw error;
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
      createRootErrorOptions(false),
    );

    expect(screen.getByRole('alert')).not.toHaveTextContent(secret);
    expect(console.error).not.toHaveBeenCalled();
  });

  test('logs caught-error diagnostics exactly once with development root options', () => {
    const error = new Error('development diagnostic');

    function Bomb(): never {
      throw error;
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
      createRootErrorOptions(true),
    );

    expect(console.error).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith('Caught render error', error, expect.any(Object));
  });

  test('creates a fallback state for primitive throwables', () => {
    expect(ErrorBoundary.getDerivedStateFromError('primitive failure')).toEqual({
      hasError: true,
      correlationId: expect.any(String),
    });
  });

  test('the default fallback offers a retry affordance', () => {
    function Bomb(): never {
      throw new Error('oops');
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('retry resets the boundary and re-renders the children', async () => {
    let shouldThrow = true;

    function Bomb() {
      if (shouldThrow) throw new Error('boom');
      return <p>recovered</p>;
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();

    shouldThrow = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  test('a resetKey change clears a shown error without a remount', () => {
    let shouldThrow = true;

    function Bomb() {
      if (shouldThrow) throw new Error('boom');
      return <p>recovered</p>;
    }

    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    rerender(
      <ErrorBoundary resetKey="/b">
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  test('a resetKey change while healthy keeps children mounted (state survives)', async () => {
    function Sticky() {
      const [clicks, setClicks] = useState(0);
      return (
        <button onClick={() => setClicks((count) => count + 1)} type="button">
          clicks:{clicks}
        </button>
      );
    }

    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Sticky />
      </ErrorBoundary>,
    );
    await userEvent.setup().click(screen.getByRole('button'));
    expect(screen.getByText('clicks:1')).toBeInTheDocument();

    rerender(
      <ErrorBoundary resetKey="/b">
        <Sticky />
      </ErrorBoundary>,
    );

    // A remount would reset the useState to 0 — surviving state proves the
    // subtree lived through the key change (the point of resetKey over key).
    expect(screen.getByText('clicks:1')).toBeInTheDocument();
  });

  test('uses a custom fallback when provided', () => {
    function Bomb(): never {
      throw new Error('oops');
    }

    render(
      <ErrorBoundary fallback={<p>Custom error view</p>}>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Custom error view')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
