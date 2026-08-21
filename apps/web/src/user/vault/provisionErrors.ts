/**
 * Provisioning failure shapes, kept in a leaf module so the creation ceremony
 * can tell them apart without importing the crypto/keystore stack it never
 * touches itself.
 */

/**
 * The vault row exists on the server, but its setup did not finish — the
 * document write, the media attestation or the endpoint keystore failed after
 * `createVault()` had already succeeded.
 *
 * It is its own error because "try again" means something different here: a
 * retry mints a SECOND vault rather than completing the first, so the surface
 * has to name the leftover instead of offering a plain retry. Deleting it for
 * the user is not an option — `DELETE /vaults/:id` is step-up gated and the
 * ceremony holds no account credential — so the honest move is to say the empty
 * vault is there and can be deleted from the list.
 */
export class VaultProvisionIncompleteError extends Error {
  readonly vaultName: string;

  constructor(vaultName: string, options?: { cause?: unknown }) {
    super('vault-provisioning-incomplete', options);
    this.name = 'VaultProvisionIncompleteError';
    this.vaultName = vaultName;
  }
}
