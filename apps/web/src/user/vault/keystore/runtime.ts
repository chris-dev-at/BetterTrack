import { EndpointVaultKeystore } from './core';

/** One endpoint-scoped E3 keystore shared by the directory, chip and stubs. */
export const endpointVaultKeystore = new EndpointVaultKeystore();
