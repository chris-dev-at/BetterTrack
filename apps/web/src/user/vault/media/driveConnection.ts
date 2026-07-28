import type { DriveAuthorizationState, GoogleDriveTokenClient } from '../drive';
import type { VaultSyncState } from '../sync';
import type {
  VaultMediaSwitcher,
  VaultMediaSwitchResult,
  VaultRetiredPurgeResult,
} from './mediaSwitcher';

/**
 * The coordinator pass around a storage action still needs attention. On a
 * committed switch this must never be collapsed into a failed result: callers
 * need the committed media state (and any Drive leftover) so they can refresh
 * and report the truth. On the preflight pass it is the reason the media set
 * was left untouched.
 */
export interface DriveSynchronizationOutcome {
  status: 'pending';
  state?: VaultSyncState;
  cause?: unknown;
}

export type DriveConnectionActionResult =
  | { status: 'authorization-required'; authorization: DriveAuthorizationState }
  | (VaultMediaSwitchResult & { synchronization?: DriveSynchronizationOutcome });

export interface DriveConnectionController {
  readonly authorization: DriveAuthorizationState;
  subscribeAuthorization(listener: () => void): () => void;
  connect(): Promise<DriveConnectionActionResult>;
  disconnect(): Promise<DriveConnectionActionResult>;
  useDriveOnly(): Promise<DriveConnectionActionResult>;
  addServerCopy(): Promise<DriveConnectionActionResult>;
  resume(): Promise<DriveConnectionResumeResult>;
  purgeRetiredServer(): Promise<
    | { status: 'authorization-required'; authorization: DriveAuthorizationState }
    | VaultRetiredPurgeResult
  >;
}

export type DriveConnectionResumeResult =
  | { status: 'ok'; state: VaultSyncState }
  | { status: 'pending'; state?: VaultSyncState; cause?: unknown }
  | { status: 'authorization-required'; authorization: DriveAuthorizationState };

export interface DriveConnectionControllerOptions {
  tokens: GoogleDriveTokenClient;
  switcher: VaultMediaSwitcher;
  /** Runtime initialization provisions proof material through the PD5 engine. */
  ready?: () => Promise<void>;
  /** Re-run that same coordinator after a fresh gesture/token. */
  resumeSync: () => Promise<VaultSyncState>;
}

export function createDriveConnectionController(
  options: DriveConnectionControllerOptions,
): DriveConnectionController {
  async function authorize(): Promise<
    { status: 'ok' } | { status: 'authorization-required'; authorization: DriveAuthorizationState }
  > {
    const current = options.tokens.getAccessToken();
    const result = current.status === 'ok' ? current : await options.tokens.authorize();
    return result.status === 'ok'
      ? { status: 'ok' }
      : { status: 'authorization-required', authorization: result.status };
  }

  async function switchMedium(
    operation: () => ReturnType<VaultMediaSwitcher['add']>,
    onCommitted?: (
      result: Extract<VaultMediaSwitchResult, { status: 'ok' | 'noop' | 'drive-leftover' }>,
    ) => void,
  ): Promise<DriveConnectionActionResult> {
    const authorization = await authorize();
    if (authorization.status !== 'ok') return authorization;
    await options.ready?.();
    // `ready()` is memoized per unlocked runtime, so only the first storage
    // action would otherwise reconcile. Every later connect / Drive-only /
    // add-server / disconnect must establish the same invariant for itself:
    // the encrypted local candidate is already on every selected medium
    // before the durable media set is allowed to move. Otherwise a pending
    // offline mutation could be migrated stale or dropped with the medium
    // that is being retired.
    const preflight = await preflightSync();
    if (preflight != null) return preflight;
    const result = await operation();
    if (result.status === 'ok' || result.status === 'noop' || result.status === 'drive-leftover') {
      onCommitted?.(result);
      return resumeCommitted(result);
    }
    return result;
  }

  async function preflightSync(): Promise<DriveConnectionActionResult | null> {
    let state: VaultSyncState;
    try {
      state = await options.resumeSync();
    } catch (cause) {
      return preflightBlocked({ status: 'pending', cause });
    }
    if (!isFullySynchronized(state)) {
      return preflightBlocked({ status: 'pending', state });
    }
    return null;
  }

  async function resumeCommitted(
    result: Extract<VaultMediaSwitchResult, { status: 'ok' | 'noop' | 'drive-leftover' }>,
  ): Promise<DriveConnectionActionResult> {
    try {
      const state = await options.resumeSync();
      if (!isFullySynchronized(state)) {
        return {
          ...result,
          synchronization: { status: 'pending', state },
        };
      }
      return result;
    } catch (cause) {
      return {
        ...result,
        synchronization: { status: 'pending', cause },
      };
    }
  }

  function preflightBlocked(
    synchronization: DriveSynchronizationOutcome,
  ): DriveConnectionActionResult {
    return {
      status: 'failed',
      media: null,
      driveLeftover: false,
      stage: 'preflight-sync',
      message:
        'Every selected vault medium must hold the current encrypted copy before the storage choice can change.',
      cause: synchronization.cause,
      synchronization,
    };
  }

  return {
    get authorization() {
      return options.tokens.state;
    },

    subscribeAuthorization(listener) {
      return options.tokens.subscribe(listener);
    },

    async connect() {
      return switchMedium(() => options.switcher.add('drive'));
    },

    async disconnect() {
      return switchMedium(
        () => options.switcher.remove('drive'),
        (result) => {
          if (!result.driveLeftover) options.tokens.clear();
        },
      );
    },

    async useDriveOnly() {
      return switchMedium(() => options.switcher.remove('server'));
    },

    async addServerCopy() {
      return switchMedium(() => options.switcher.add('server'));
    },

    async resume() {
      const authorization = await authorize();
      if (authorization.status !== 'ok') return authorization;
      await options.ready?.();
      // Report the coordinator's authoritative verdict instead of an
      // unconditional success: a resolved pending-offline/conflict pass is not
      // a synchronized vault.
      let state: VaultSyncState;
      try {
        state = await options.resumeSync();
      } catch (cause) {
        return { status: 'pending', cause };
      }
      return isFullySynchronized(state) ? { status: 'ok', state } : { status: 'pending', state };
    },

    async purgeRetiredServer() {
      const authorization = await authorize();
      if (authorization.status !== 'ok') return authorization;
      await options.ready?.();
      return options.switcher.purgeRetiredServer();
    },
  };
}

function isFullySynchronized(state: VaultSyncState): boolean {
  return state.status === 'synced' && state.active != null && state.pending == null;
}
