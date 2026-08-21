import type { CreateDriveConnectionRequest, DriveConnection } from '@bettertrack/contracts';

import { readGoogleDriveIdentity, type GoogleDriveTokenClient } from '../drive';
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

/**
 * Own one memory-only GIS client per registered Drive identity. Registry API
 * calls receive only the about.get projection; token objects never cross this
 * composition boundary.
 */
export function createDriveConnectionRegistry(
  options: DriveConnectionRegistryOptions,
): DriveConnectionRegistry {
  const clients = new Map<string, GoogleDriveTokenClient>();
  const identify = options.identify ?? readGoogleDriveIdentity;
  const makeClient =
    options.tokenClient ??
    ((connection?: DriveConnection) =>
      createGoogleDriveTokenClient({
        clientId: options.clientId,
        loginHint: connection?.googleSub,
        identityLabel: connection?.email,
      }));

  function clientFor(connection: DriveConnection): GoogleDriveTokenClient {
    let client = clients.get(connection.id);
    if (!client) {
      client = makeClient(connection);
      clients.set(connection.id, client);
    }
    return client;
  }

  async function proveIdentity(
    connection: DriveConnection,
    client: GoogleDriveTokenClient,
  ): Promise<DriveRegistryAuthorizationResult> {
    const authorized = await client.authorize();
    if (authorized.status !== 'ok') {
      return {
        status: 'authorization-required',
        connection,
        message: authorized.message,
      };
    }
    try {
      const identity = await identify(client);
      if (identity.googleSub !== connection.googleSub) {
        client.clear();
        return {
          status: 'identity-mismatch',
          connection,
          message: `Sign in to Google (${connection.email}) to sync.`,
        };
      }
      return { status: 'ok', connection: await options.api.verify(connection.id) };
    } catch (cause) {
      return {
        status: 'failed',
        connection,
        message: cause instanceof Error ? cause.message : 'Google Drive verification failed.',
      };
    }
  }

  return {
    async connect() {
      const bootstrap = makeClient();
      const authorized = await bootstrap.authorize();
      if (authorized.status !== 'ok') {
        return { status: 'authorization-required', message: authorized.message };
      }
      try {
        const identity = await identify(bootstrap);
        const connection = await options.api.create(identity);
        // Keep the fresh capability under exactly one registry id. A later page
        // load creates the normal googleSub-pinned client for this connection.
        // Re-consenting an already-registered account upserts onto the same id,
        // so the client it replaces is released here — otherwise its token and
        // expiry timer would outlive every reference to it.
        const replaced = clients.get(connection.id);
        if (replaced && replaced !== bootstrap) replaced.clear();
        clients.set(connection.id, bootstrap);
        return { status: 'ok', connection };
      } catch (cause) {
        bootstrap.clear();
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
      return clientFor(connection).state;
    },

    subscribe(connection, listener) {
      return clientFor(connection).subscribe(listener);
    },

    tokens(connectionId) {
      return clients.get(connectionId) ?? null;
    },

    async disconnect(connection, acknowledgeBound) {
      await options.api.delete(connection.id, acknowledgeBound);
      clients.get(connection.id)?.clear();
      clients.delete(connection.id);
    },
  };
}
