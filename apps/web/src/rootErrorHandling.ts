import type { RootOptions } from 'react-dom/client';

type CaughtErrorHandler = NonNullable<RootOptions['onCaughtError']>;
type RootErrorOptions = { onCaughtError: CaughtErrorHandler };

const suppressCaughtError: CaughtErrorHandler = () => {};

const logCaughtError: CaughtErrorHandler = (error, errorInfo) => {
  console.error('Caught render error', error, errorInfo);
};

/**
 * React 19 logs boundary-caught errors by default. Always override that root
 * hook so production browser consoles cannot expose raw exception details.
 */
export function createRootErrorOptions(isDevelopment: boolean): RootErrorOptions {
  return {
    onCaughtError: isDevelopment ? logCaughtError : suppressCaughtError,
  };
}
