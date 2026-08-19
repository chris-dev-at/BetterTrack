export const CHUNK_RECOVERY_SESSION_KEY = 'bettertrack.chunk-recovery.release';

const CHUNK_LOAD_ERROR_PATTERNS = [
  /\bChunkLoadError\b/i,
  /\bLoading (?:CSS )?chunk\b.*\bfailed\b/i,
  /\b(?:Failed to fetch|Failed to load|Error loading) dynamically imported module\b/i,
  /\bImporting a module script failed\b/i,
  /\bUnable to preload (?:CSS|module)\b/i,
];

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChunkRecoveryEnvironment {
  release: string;
  reload: () => void;
  storage: SessionStorageLike;
}

function browserEnvironment(): ChunkRecoveryEnvironment | null {
  try {
    return {
      release: __APP_RELEASE__,
      reload: () => window.location.reload(),
      storage: window.sessionStorage,
    };
  } catch {
    return null;
  }
}

function errorText(error: unknown, seen = new Set<unknown>()): string {
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return '';
  if (seen.has(error)) return '';
  seen.add(error);

  try {
    const candidate = error as { cause?: unknown; message?: unknown; name?: unknown };
    const ownText = [candidate.name, candidate.message]
      .filter((value): value is string => typeof value === 'string')
      .join(': ');
    return `${ownText} ${errorText(candidate.cause, seen)}`.trim();
  } catch {
    return '';
  }
}

export function isChunkLoadError(error: unknown): boolean {
  const text = errorText(error);
  return text !== '' && CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reload at most once for a given deployed web release. Keeping the release in
 * sessionStorage blocks a broken build from looping, while still letting a
 * later deploy self-heal in the same browser tab.
 */
export function reloadForChunkRecovery(environment?: ChunkRecoveryEnvironment): boolean {
  const activeEnvironment = environment ?? browserEnvironment();
  if (activeEnvironment === null) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;

  try {
    if (
      activeEnvironment.storage.getItem(CHUNK_RECOVERY_SESSION_KEY) === activeEnvironment.release
    ) {
      return false;
    }
    activeEnvironment.storage.setItem(CHUNK_RECOVERY_SESSION_KEY, activeEnvironment.release);
  } catch {
    // Reloading without a durable loop guard could strand the tab in a loop.
    return false;
  }

  try {
    activeEnvironment.reload();
    return true;
  } catch {
    // The marker stays set: a blocked reload must fall through to the boundary,
    // not retry on every render of the same broken release.
    return false;
  }
}

export function recoverFromChunkLoadError(
  error: unknown,
  environment?: ChunkRecoveryEnvironment,
): boolean {
  return isChunkLoadError(error) && reloadForChunkRecovery(environment);
}

/**
 * Vite emits this event before rethrowing a failed dynamic import. Suppress the
 * throw only when a reload was actually started; once guarded, the error keeps
 * flowing to the nearest React error boundary.
 */
export function installVitePreloadErrorRecovery(
  environment?: ChunkRecoveryEnvironment,
  target: EventTarget = window,
): () => void {
  const onPreloadError = (event: Event) => {
    // preventDefault() makes Vite resolve the failed module as undefined before navigation commits.
    if (reloadForChunkRecovery(environment)) event.preventDefault();
  };

  target.addEventListener('vite:preloadError', onPreloadError);
  return () => target.removeEventListener('vite:preloadError', onPreloadError);
}
