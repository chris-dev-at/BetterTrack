import type { DriveAuthorizationState, GoogleDriveTokenClient } from '../drive';
import type {
  VaultMediaSwitcher,
  VaultMediaSwitchResult,
  VaultRetiredPurgeResult,
} from './mediaSwitcher';

export type DriveConnectionActionResult =
  | { status: 'authorization-required'; authorization: DriveAuthorizationState }
  | VaultMediaSwitchResult;

export interface DriveConnectionController {
  readonly authorization: DriveAuthorizationState;
  connect(): Promise<DriveConnectionActionResult>;
  disconnect(): Promise<DriveConnectionActionResult>;
  useDriveOnly(): Promise<DriveConnectionActionResult>;
  addServerCopy(): Promise<DriveConnectionActionResult>;
  resume(): Promise<
    { status: 'ok' } | { status: 'authorization-required'; authorization: DriveAuthorizationState }
  >;
  purgeRetiredServer(): Promise<
    | { status: 'authorization-required'; authorization: DriveAuthorizationState }
    | VaultRetiredPurgeResult
  >;
}

export interface DriveConnectionControllerOptions {
  tokens: GoogleDriveTokenClient;
  switcher: VaultMediaSwitcher;
  /** Runtime initialization provisions proof material through the PD5 engine. */
  ready?: () => Promise<void>;
  /** Re-run that same coordinator after a fresh gesture/token. */
  resumeSync?: () => Promise<void>;
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
  ): Promise<DriveConnectionActionResult> {
    const authorization = await authorize();
    if (authorization.status !== 'ok') return authorization;
    await options.ready?.();
    const result = await operation();
    if (result.status === 'ok' || result.status === 'noop') {
      await options.resumeSync?.();
    }
    return result;
  }

  return {
    get authorization() {
      return options.tokens.state;
    },

    async connect() {
      return switchMedium(() => options.switcher.add('drive'));
    },

    async disconnect() {
      const authorization = await authorize();
      if (authorization.status !== 'ok') return authorization;
      await options.ready?.();
      const result = await options.switcher.remove('drive');
      if ((result.status === 'ok' || result.status === 'noop') && !result.driveLeftover) {
        options.tokens.clear();
      }
      if (
        result.status === 'ok' ||
        result.status === 'noop' ||
        result.status === 'drive-leftover'
      ) {
        await options.resumeSync?.();
      }
      return result;
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
      await options.resumeSync?.();
      return { status: 'ok' };
    },

    async purgeRetiredServer() {
      const authorization = await authorize();
      if (authorization.status !== 'ok') return authorization;
      await options.ready?.();
      return options.switcher.purgeRetiredServer();
    },
  };
}
