import { EndpointKeystoreError } from './errors';
import type { PlainCustodyAcknowledgmentToken } from './types';

let acknowledgmentGeneration = 0;
const acknowledgments = new WeakMap<
  object,
  { vaultId: string; consumed: boolean; generation: number }
>();

/**
 * E8 calls this only after the user accepts the strong plain-custody warning.
 * Tokens are vault-scoped and deliberately consumable exactly once.
 */
export function acknowledgePlainCustodyRisk(vaultId: string): PlainCustodyAcknowledgmentToken {
  const token = Object.freeze({});
  acknowledgments.set(token, {
    vaultId,
    consumed: false,
    generation: acknowledgmentGeneration,
  });
  return token as PlainCustodyAcknowledgmentToken;
}

export function consumePlainCustodyAcknowledgment(
  vaultId: string,
  token: PlainCustodyAcknowledgmentToken,
): void {
  const record = acknowledgments.get(token as object);
  if (
    record == null ||
    record.vaultId !== vaultId ||
    record.consumed ||
    record.generation !== acknowledgmentGeneration
  ) {
    throw new EndpointKeystoreError(
      'acknowledgment-required',
      'Plain custody requires a fresh acknowledgment for this vault.',
    );
  }
  record.consumed = true;
}

/** Session/reset boundaries invalidate every outstanding warning receipt. */
export function invalidatePlainCustodyAcknowledgments(): void {
  acknowledgmentGeneration += 1;
}
