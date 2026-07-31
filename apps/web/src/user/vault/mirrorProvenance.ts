import {
  VAULT_MIRROR_PROVENANCE_ENTITY_KINDS,
  vaultMirrorProvenanceSchema,
  type VaultDocument,
  type VaultEntity,
  type VaultMirrorProvenance,
} from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';
import type { VaultSyncEngine, VaultSyncState } from './sync';

/**
 * Severed-fork MIRRORCHAIN provenance, client side
 * (`docs/paranoid-design.md` §7.1).
 *
 * `mirror_rows` — the chain's logical↔local identity map — dies with the copy at
 * paranoid enable, while the append-only oplog keeps only the LOGICAL id. After a
 * sanctioned financial correction the surviving local row is a replacement, so
 * `localId = mirrorId` is false and restore-time validation cannot re-derive the
 * association. The map therefore has to be captured BEFORE enable and carried
 * inside the encrypted document — it is the user's own fork, and a Drive-only
 * account gains no new cleartext server-side alias table.
 *
 * Everything here is pure except {@link captureForkProvenanceIntoVault}, which
 * folds one capture read into the live document through the sync engine.
 */

/** Deterministic separator: no id or row kind can contain it. */
const KEY_SEPARATOR = '\u0000';

/**
 * Deterministic key: one logical entity per MEMBERSHIP and row kind. The chain id
 * alone is not enough — re-joining a chain mints a second membership with a second
 * copy, so one chain can legitimately hold two retained forks that each carry the
 * same logical entity under their own local id.
 */
function logicalKey(entry: VaultMirrorProvenance): string {
  return [entry.kind, entry.membershipId, entry.mirrorId].join(KEY_SEPARATOR);
}

/** Deterministic key: one local row per row kind. */
function localKey(entry: VaultMirrorProvenance): string {
  return [entry.kind, entry.localId].join(KEY_SEPARATOR);
}

function entityKey(kind: string, id: string): string {
  return [kind, id].join(KEY_SEPARATOR);
}

function invalid(message: string): VaultCryptoError {
  return new VaultCryptoError('document-invalid', message);
}

function parseEntry(entry: VaultMirrorProvenance): VaultMirrorProvenance {
  const parsed = vaultMirrorProvenanceSchema.safeParse(entry);
  if (!parsed.success) {
    throw invalid('Vault fork provenance does not match the current schema.');
  }
  return parsed.data;
}

function sameEntry(left: VaultMirrorProvenance, right: VaultMirrorProvenance): boolean {
  return (
    left.chainId === right.chainId &&
    left.membershipId === right.membershipId &&
    left.kind === right.kind &&
    left.mirrorId === right.mirrorId &&
    left.portfolioId === right.portfolioId &&
    left.localId === right.localId
  );
}

/**
 * Validate, de-duplicate and order one capture. Two entries claiming the same
 * logical identity with different local rows — or one local row under two logical
 * identities — is a malformed document, not a conflict to resolve: the server
 * refuses both, so failing closed here keeps the failure where it can be fixed.
 */
export function normalizeForkProvenance(
  entries: readonly VaultMirrorProvenance[] = [],
): VaultMirrorProvenance[] {
  const byLogical = new Map<string, VaultMirrorProvenance>();
  const byLocal = new Map<string, VaultMirrorProvenance>();
  for (const raw of entries) {
    const entry = parseEntry(raw);
    const existingLogical = byLogical.get(logicalKey(entry));
    if (existingLogical && !sameEntry(existingLogical, entry)) {
      throw invalid('Two local rows claim one logical MIRRORCHAIN identity.');
    }
    const existingLocal = byLocal.get(localKey(entry));
    if (existingLocal && !sameEntry(existingLocal, entry)) {
      throw invalid('One local row claims two logical MIRRORCHAIN identities.');
    }
    byLogical.set(logicalKey(entry), entry);
    byLocal.set(localKey(entry), entry);
  }
  return [...byLogical.values()].sort((left, right) =>
    logicalKey(left) < logicalKey(right) ? -1 : logicalKey(left) > logicalKey(right) ? 1 : 0,
  );
}

/**
 * The CAS/merge union. Provenance is content-addressed rather than
 * entity-atomic — every replica captured the same server rows — so a union keyed
 * by logical identity is deterministic and order-independent.
 */
export function mergeForkProvenance(
  left: readonly VaultMirrorProvenance[] | undefined,
  right: readonly VaultMirrorProvenance[] | undefined,
): VaultMirrorProvenance[] {
  return normalizeForkProvenance([...(left ?? []), ...(right ?? [])]);
}

/** True when `left` already contains every entry of `right` (dominance test). */
export function forkProvenanceDominates(
  left: readonly VaultMirrorProvenance[] | undefined,
  right: readonly VaultMirrorProvenance[] | undefined,
): boolean {
  const mine = new Map((left ?? []).map((entry) => [logicalKey(entry), entry]));
  return (right ?? []).every((entry) => {
    const candidate = mine.get(logicalKey(entry));
    return candidate != null && sameEntry(candidate, entry);
  });
}

/**
 * Cleanup: keep only entries whose local row is still live in the document. A row
 * the user deleted locally after the capture has no provenance to prove, and the
 * server rejects an entry that names no restored row — so a stale alias must
 * never accumulate, or the account could no longer leave paranoid mode.
 *
 * This runs on EVERY document the engine encrypts (`sync.ts`) and inside the CAS
 * merge (`merge.ts`), so a local deletion prunes on the very next write instead of
 * surviving until some later capture step.
 */
export function pruneForkProvenance(
  entries: readonly VaultMirrorProvenance[] | undefined,
  entitiesByKind: VaultDocument['entities'],
): VaultMirrorProvenance[] {
  if ((entries ?? []).length === 0) return [];
  const live = new Set<string>();
  for (const [kind, entities] of Object.entries(entitiesByKind) as [
    keyof VaultDocument['entities'],
    VaultEntity[] | undefined,
  ][]) {
    for (const entity of entities ?? []) {
      if (entity.deletedAt === null) live.add(entityKey(kind, entity.id));
    }
  }
  return normalizeForkProvenance(entries).filter((entry) =>
    live.has(entityKey(VAULT_MIRROR_PROVENANCE_ENTITY_KINDS[entry.kind], entry.localId)),
  );
}

/**
 * The document-lifecycle hook: the provenance a document is about to carry,
 * normalized and pruned — WITHOUT inventing the key on a document that has none.
 * An absent key and `[]` mean the same thing ("no severed fork"), and defaulting
 * one in would change the plaintext, and therefore the published envelope bytes,
 * of every fork-free vault in existence (see `vectors.ts`).
 */
export function carriedForkProvenance(
  document: VaultDocument,
): VaultMirrorProvenance[] | undefined {
  if (document.mirrorProvenance == null) return undefined;
  return pruneForkProvenance(document.mirrorProvenance, document.entities);
}

/**
 * Fold one capture read into the document. Runs before enable — while
 * `mirror_rows` still exists — and is idempotent, so a retried wizard step or a
 * second unlocked session cannot duplicate or drop an identity.
 */
export function withForkProvenance(
  document: VaultDocument,
  captured: readonly VaultMirrorProvenance[],
): VaultDocument {
  const mirrorProvenance = pruneForkProvenance(
    mergeForkProvenance(document.mirrorProvenance, captured),
    document.entities,
  );
  if (mirrorProvenance.length === 0 && document.mirrorProvenance == null) return document;
  return { ...document, mirrorProvenance };
}

/**
 * Capture the account's severed-fork identity map and commit it into the
 * encrypted document. This is the production path that gets the map inside the
 * vault BEFORE `enable()` purges `mirror_rows`: every unlocked session runs it
 * (`media/runtime.ts`), so the vault the enable wizard publishes already carries
 * it, and every paranoid-mode session afterwards reads an empty map and no-ops.
 *
 * Returns null when the document already carries everything the read reported —
 * the common case, and the reason this is cheap enough to run on every unlock.
 * The test is DOMINANCE, not equality: the fold is a union (another replica's
 * capture may already have contributed an identity this read no longer sees), and
 * shrinking it here would drop a fork the vault is the only remaining witness for.
 */
export async function captureForkProvenanceIntoVault(
  engine: Pick<VaultSyncEngine, 'mutate' | 'state'>,
  read: () => Promise<readonly VaultMirrorProvenance[]>,
): Promise<VaultSyncState | null> {
  const captured = normalizeForkProvenance(await read());
  const current = engine.state.active?.document;
  if (current != null && forkProvenanceDominates(carriedForkProvenance(current), captured)) {
    return null;
  }
  return engine.mutate(({ document }) => withForkProvenance(document, captured));
}
