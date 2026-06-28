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

  test('catches a thrown child error and shows the default fallback', () => {
    // `never` return: TS would otherwise infer `void`, an invalid JSX return.
    function Bomb(): never {
      throw new Error('kaboom');
    }

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
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

  test('omits the message paragraph when the error has no message', () => {
    function Bomb(): never {
      throw new Error('');
    }

    const { container } = render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    // The alert holds exactly one <p> — the heading, with no message line.
    expect(container.querySelector('[role="alert"]')?.querySelectorAll('p')).toHaveLength(1);
  });
});
