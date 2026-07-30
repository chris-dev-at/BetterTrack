import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

// React logs caught boundary errors via console.error; silence it so the test
// output stays clean.
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
