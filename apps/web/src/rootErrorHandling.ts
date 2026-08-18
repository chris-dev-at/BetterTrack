import type { RootOptions } from 'react-dom/client';

import { recoverFromChunkLoadError } from './chunkRecovery';

type CaughtErrorHandler = NonNullable<RootOptions['onCaughtError']>;
type RootErrorOptions = { onCaughtError: CaughtErrorHandler };
export type ChunkErrorRecovery = (error: unknown) => boolean;

/**
 * React 19 logs boundary-caught errors by default. Always override that root
 * hook so production browser consoles cannot expose raw exception details. A
 * failed lazy import also gets one deploy-recovery reload before its boundary
 * remains responsible for the fallback.
 */
export function createRootErrorOptions(
  isDevelopment: boolean,
  recoverChunkError: ChunkErrorRecovery = recoverFromChunkLoadError,
): RootErrorOptions {
  return {
    onCaughtError(error, errorInfo) {
      recoverChunkError(error);
      if (isDevelopment) console.error('Caught render error', error, errorInfo);
    },
  };
}
