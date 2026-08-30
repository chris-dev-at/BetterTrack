import type { CreateDriveConnectionRequest, DriveConnection } from '@bettertrack/contracts';

import {
  readGoogleDriveIdentity,
  type DriveTokenClientIdentity,
  type GoogleDriveTokenClient,
} from '../drive';
import { createGoogleDriveTokenClient } from '../drive';

export interface DriveConnectionRegistryApi {
  create(identity: CreateDriveConnectionRequest): Promise<DriveConnection>;
  verify(connectionId: string): Promise<DriveConnection>;
  delete(connectionId: string, acknowledgeBound: boolean): Promise<void>;
}

export type DriveRegistryAuthorizationResult =
  | { status: 'ok'; connection: DriveConnection }
  | {
      status: 'authorization-required' | 'identity-mismatch' | 'failed';
      connection?: DriveConnection;
      /**
       * Diagnostic only — never rendered. The UI maps `status` to an i18n key
       * (EN + DE), so this English text must not reach a surface; keep it that
       * way rather than translating it here, outside the catalog.
       */
      message: string;
    };

export interface DriveConnectionRegistry {
  /**
   * Load GIS into the very client the next gesture will use, so `connect()` and
   * `authorize()` open Google's popup synchronously from the click instead of
   * taking `authorize()`'s load-then-request fallback (#1518). With a
   * connection it prepares that identity's client; without one it prepares the
   * client a fresh `connect()` mints plus every already-registered identity.
   *
   * A surface that owns a Drive button awaits this and keeps the button
   * unavailable until it settles — the popup guarantee is by construction here,
   * not by convention.
   */
  prepare(connection?: DriveConnection): Promise<void>;
  connect(): Promise<DriveRegistryAuthorizationResult>;
  authorize(connection: DriveConnection): Promise<DriveRegistryAuthorizationResult>;
  authorization(connection: DriveConnection): GoogleDriveTokenClient['state'];
  subscribe(connection: DriveConnection, listener: () => void): () => void;
  tokens(connectionId: string): GoogleDriveTokenClient | null;
  disconnect(connection: DriveConnection, acknowledgeBound: boolean): Promise<void>;
}

export interface DriveConnectionRegistryOptions {
  clientId: string;
  api: DriveConnectionRegistryApi;
  tokenClient?: (connection?: DriveConnection) => GoogleDriveTokenClient;
  identify?: typeof readGoogleDriveIdentity;
}

interface RegisteredDriveClient {
  raw: GoogleDriveTokenClient;
  tokens: GoogleDriveTokenClient;
  state: RegisteredDriveClientState;
}

interface RegisteredDriveClientState {
  connection: DriveConnection;
  mismatchMessage: string | null;
}

/**
 * What a registered connection contributes to its GIS client.
 *
 * GIS documents `hint`/`login_hint` as an EMAIL ADDRESS or an ID-token `sub`.
 * Our `googleSub` holds Drive's `about.get` `user.permissionId` — a
 * Permission-resource id Google documents nowhere as a hint value, so passing
 * it can be ignored silently and drop the owner into the full account chooser.
 * The email is the documented form and is already stored, so it is the hint;
 * the permissionId keeps the job it is good for — the post-consent equality
 * check in `proveIdentity` that refuses the wrong principal.
 */
export function driveTokenClientIdentity(connection?: DriveConnection): DriveTokenClientIdentity {
  return { loginHint: connection?.email, identityLabel: connection?.email };
}

/**
 * Own one memory-only GIS client per registered Drive identity. Registry API
 * calls receive only the about.get projection; token objects never cross this
 * composition boundary.
 */
export function createDriveConnectionRegistry(
  options: DriveConnectionRegistryOptions,
): DriveConnectionRegistry {
  const clients = new Map<string, RegisteredDriveClient>();
  // The client a fresh `connect()` gesture will use, minted (and prepared)
  // ahead of that gesture instead of at click time.
  let bootstrap: GoogleDriveTokenClient | null = null;
  let prepared = false;
  const identify = options.identify ?? readGoogleDriveIdentity;
  const makeClient =
    options.tokenClient ??
    ((connection?: DriveConnection) =>
      createGoogleDriveTokenClient({
        clientId: options.clientId,
        ...driveTokenClientIdentity(connection),
      }));

  function registerClient(
    connection: DriveConnection,
    raw: GoogleDriveTokenClient,
  ): RegisteredDriveClient {
    const state = { connection, mismatchMessage: null as string | null };
    const tokens: GoogleDriveTokenClient = {
      get state() {
        return state.mismatchMessage === null ? raw.state : 'identity-mismatch';
      },

      getAccessToken() {
        return state.mismatchMessage === null
          ? raw.getAccessToken()
          : { status: 'identity-mismatch', message: state.mismatchMessage };
      },

      subscribe: (listener) => raw.subscribe(listener),

      // Straight through: preparation is a GIS script load with no identity in
      // it, so a mismatch flag has nothing to hide here.
      prepare: () => raw.prepare(),

      async authorize() {
        const before = tokens.getAccessToken();
        state.mismatchMessage = null;
        const authorized = await raw.authorize();
        if (authorized.status !== 'ok' || before.status === 'ok') return authorized;

        const verified = await verifyIdentity(raw, state);
        if (verified.status === 'ok') return authorized;
        return {
          status:
            verified.status === 'identity-mismatch'
              ? 'identity-mismatch'
              : ('consent-required' as const),
          message: verified.message,
        };
      },

      identify: (identity) => raw.identify(identity),

      clear() {
        state.mismatchMessage = null;
        raw.clear();
      },

      markExpired() {
        state.mismatchMessage = null;
        raw.markExpired();
      },

      markRevoked() {
        state.mismatchMessage = null;
        raw.markRevoked();
      },
    };
    return { raw, tokens, state };
  }

  function bootstrapClient(): GoogleDriveTokenClient {
    bootstrap ??= makeClient();
    return bootstrap;
  }

  /**
   * A client minted AFTER the surface prepared — a connection row that appeared
   * on a refetch — would otherwise be the one caller still taking `authorize()`'s
   * deferred-popup fallback. The GIS script is cached by then, so this settles
   * without another round trip.
   */
  function ensurePrepared(client: GoogleDriveTokenClient): void {
    if (prepared) void client.prepare().catch(() => undefined);
  }

  function clientFor(connection: DriveConnection): RegisteredDriveClient {
    let entry = clients.get(connection.id);
    if (!entry) {
      entry = registerClient(connection, makeClient(connection));
      clients.set(connection.id, entry);
      ensurePrepared(entry.raw);
    } else {
      if (entry.state.connection.email !== connection.email) {
        entry.raw.identify(driveTokenClientIdentity(connection));
      }
      entry.state.connection = connection;
    }
    return entry;
  }

  async function verifyIdentity(
    raw: GoogleDriveTokenClient,
    state: RegisteredDriveClientState,
  ): Promise<DriveRegistryAuthorizationResult> {
    const { connection } = state;
    try {
      const identity = await identify(raw);
      if (identity.googleSub !== connection.googleSub) {
        state.mismatchMessage = `Sign in to Google (${connection.email}) to sync.`;
        raw.clear();
        return {
          status: 'identity-mismatch',
          connection,
          message: state.mismatchMessage,
        };
      }
      const verified = await options.api.verify(connection.id);
      state.connection = verified;
      state.mismatchMessage = null;
      return { status: 'ok', connection: verified };
    } catch (cause) {
      // A token whose principal could not be proved must never remain reachable
      // through `tokens(id)`, even when the failure was a transient about.get
      // or registry-touch error rather than an explicit mismatch.
      state.mismatchMessage = null;
      raw.clear();
      return {
        status: 'failed',
        connection,
        message: cause instanceof Error ? cause.message : 'Google Drive verification failed.',
      };
    }
  }

  async function proveIdentity(
    connection: DriveConnection,
    entry: RegisteredDriveClient,
  ): Promise<DriveRegistryAuthorizationResult> {
    entry.state.connection = connection;
    entry.state.mismatchMessage = null;
    const authorized = await entry.raw.authorize();
    if (authorized.status !== 'ok') {
      return {
        status: 'authorization-required',
        connection,
        message: authorized.message,
      };
    }
    return verifyIdentity(entry.raw, entry.state);
  }

  return {
    async prepare(connection) {
      if (connection) {
        await clientFor(connection).raw.prepare();
        return;
      }
      const pending = [bootstrapClient(), ...[...clients.values()].map((entry) => entry.raw)];
      await Promise.all(pending.map((client) => client.prepare()));
      prepared = true;
    },

    async connect() {
      const client = bootstrapClient();
      const authorized = await client.authorize();
      if (authorized.status !== 'ok') {
        // The prepared client keeps its loaded GIS, so a cancelled popup can be
        // reopened synchronously from the user's next click.
        return { status: 'authorization-required', message: authorized.message };
      }
      try {
        const identity = await identify(client);
        const connection = await options.api.create(identity);
        // Keep the fresh capability under exactly one registry id AND pin it to
        // the identity the row just resolved. The bootstrap client was minted
        // before any of this was known, so without the pin every re-mint for
        // the rest of the page session would run hint-less (account chooser)
        // and fall back to the generic sign-in copy. `tokens(connectionId)` is
        // a checked facade: every later mint repeats the about.get equality
        // proof before it exposes the new capability.
        client.identify(driveTokenClientIdentity(connection));
        // Re-consenting an already-registered account upserts onto the same id,
        // so the client it replaces is released here — otherwise its token and
        // expiry timer would outlive every reference to it.
        const replaced = clients.get(connection.id);
        if (replaced?.raw !== client) replaced?.raw.clear();
        clients.set(connection.id, registerClient(connection, client));
        // This client is now pinned to the account it just registered, so the
        // NEXT "add another account" gesture needs its own — minted and
        // prepared by the surface's next preparation pass.
        bootstrap = null;
        return { status: 'ok', connection };
      } catch (cause) {
        client.clear();
        return {
          status: 'failed',
          message: cause instanceof Error ? cause.message : 'Google Drive could not be connected.',
        };
      }
    },

    authorize(connection) {
      return proveIdentity(connection, clientFor(connection));
    },

    authorization(connection) {
      return clientFor(connection).tokens.state;
    },

    subscribe(connection, listener) {
      return clientFor(connection).tokens.subscribe(listener);
    },

    tokens(connectionId) {
      return clients.get(connectionId)?.tokens ?? null;
    },

    async disconnect(connection, acknowledgeBound) {
      await options.api.delete(connection.id, acknowledgeBound);
      clients.get(connection.id)?.raw.clear();
      clients.delete(connection.id);
    },
  };
}
