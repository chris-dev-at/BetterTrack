import {
  trimVaultMergeLog,
  vaultContentDocSchema,
  type VaultCommonDoc,
  type VaultContentDoc,
  type VaultEntity,
  type VaultEntityKind,
  type VaultMirrorProvenance,
  type VaultPortfolioDoc,
} from '@bettertrack/contracts';

import { canonicalVaultJson } from '../canonicalJson';
import { VaultCryptoError } from '../errors';
import { chooseVaultEntity } from '../merge';

/**
 * `both`-backend reconcile (`docs/VAULTS_V2_DESIGN.md` r3 §17, closing mobile
 * finding A8).
 *
 * r2 §13 said `both` reconciles by "highest (version, then updatedAt) wins" —
 * whole-document last-writer-wins. That is data loss: two devices that each
 * booked one entity offline reach the same version, and the clock picks a
 * winner whose document never saw the other's entity. It also promoted the
 * engines' degenerate corrupt-bytes fallback to the primary path.
 *
 * The rule instead: when BOTH media hold a readable candidate for one document,
 * merge them per the §4 entity rules — union by id, whole-entity winner by
 * `rev → live-beats-tombstone → editedAt → editedBy → canonical content`. The
 * merged doc is written through to both media at `max(version) + 1`.
 *
 * `(version, updatedAt)` survives ONLY as the fallback for UNDECRYPTABLE
 * candidates: a readable candidate always beats an unreadable one; among two
 * unreadable ones the higher `(version, updatedAt)` selects which bytes are
 * kept (quarantined for the restore picker, never silently merged or dropped).
 *
 * This module is the pure decision core. The caller supplies already-decoded
 * candidates and, on a merge, re-encrypts and writes the result through both
 * media — exactly as the v1 replicated data home already presents each replica
 * to the merge engine rather than choosing by version.
 */

export interface ReadableCandidate {
  readable: true;
  doc: VaultContentDoc;
  version: number;
  updatedAt: string;
}

export interface UnreadableCandidate {
  readable: false;
  version: number;
  updatedAt: string;
}

export type ReconcileCandidate = ReadableCandidate | UnreadableCandidate;

export type ReconcileOutcome =
  /** Both legs read: the merged document, to be re-encrypted at `version`. */
  | { kind: 'merged'; doc: VaultContentDoc; version: number; converged: boolean }
  /** Exactly one leg read: it wins outright over an undecryptable sibling. */
  | { kind: 'readable-wins'; doc: VaultContentDoc; version: number }
  /** Neither leg read: keep the higher (version, updatedAt) bytes, never merge. */
  | { kind: 'undecryptable-fallback'; version: number; updatedAt: string };

/**
 * Reconcile the two per-medium candidates of ONE document.
 *
 * `converged` on a merge is `true` when the merged document is byte-identical
 * to both inputs (nothing to write through); the caller can skip the write.
 */
export function reconcileVaultDocs(
  left: ReconcileCandidate,
  right: ReconcileCandidate,
): ReconcileOutcome {
  if (left.readable && right.readable) {
    const merged = mergeVaultContentDocs(left.doc, right.doc);
    const version = Math.max(left.version, right.version) + (merged.converged ? 0 : 1);
    return { kind: 'merged', doc: merged.doc, version, converged: merged.converged };
  }
  if (left.readable) return { kind: 'readable-wins', doc: left.doc, version: left.version };
  if (right.readable) return { kind: 'readable-wins', doc: right.doc, version: right.version };

  // Both undecryptable — the ONLY place (version, updatedAt) decides. Never a
  // merge, never a silent discard: the loser's bytes are kept for the restore
  // picker by the caller.
  const winner = higherVersionThenUpdatedAt(left, right);
  return { kind: 'undecryptable-fallback', version: winner.version, updatedAt: winner.updatedAt };
}

export interface MergedContentDoc {
  doc: VaultContentDoc;
  /** True when the merge changed nothing on either side (identical inputs). */
  converged: boolean;
}

/**
 * Merge two decrypted v2 content docs by the §4 entity rules. Both must be the
 * same kind and identity — a server and a Drive copy of the SAME document — or
 * this fails closed rather than fusing unrelated ledgers.
 */
export function mergeVaultContentDocs(
  left: VaultContentDoc,
  right: VaultContentDoc,
): MergedContentDoc {
  const l = vaultContentDocSchema.parse(left);
  const r = vaultContentDocSchema.parse(right);
  if (l.docKind !== r.docKind || l.vaultId !== r.vaultId) {
    throw new VaultCryptoError(
      'document-invalid',
      'Cannot reconcile two vault documents of different identity.',
    );
  }
  if (l.docKind === 'portfolio' && r.docKind === 'portfolio' && l.portfolioId !== r.portfolioId) {
    throw new VaultCryptoError(
      'document-invalid',
      'Cannot reconcile two portfolio documents of different portfolios.',
    );
  }

  const entities = mergeEntities(l.entities, r.entities);
  const mergeLog = trimVaultMergeLog(unionMergeLog(l.mergeLog, r.mergeLog));

  let doc: VaultContentDoc;
  if (l.docKind === 'common' && r.docKind === 'common') {
    doc = mergeCommon(l, r, entities, mergeLog);
  } else {
    doc = {
      schemaVersion: l.schemaVersion,
      docKind: 'portfolio',
      vaultId: l.vaultId,
      portfolioId: (l as VaultPortfolioDoc).portfolioId,
      entities,
      mergeLog,
    };
  }

  const converged =
    canonicalVaultJson(doc) === canonicalVaultJson(l) &&
    canonicalVaultJson(l) === canonicalVaultJson(r);
  return { doc: vaultContentDocSchema.parse(doc), converged };
}

function mergeCommon(
  left: VaultCommonDoc,
  right: VaultCommonDoc,
  entities: VaultContentDoc['entities'],
  mergeLog: VaultCommonDoc['mergeLog'],
): VaultCommonDoc {
  const mirrorProvenance = unionMirrorProvenance(left.mirrorProvenance, right.mirrorProvenance);
  const clientSecurity = reconcileClientSecurity(left.clientSecurity, right.clientSecurity);
  return {
    schemaVersion: left.schemaVersion,
    docKind: 'common',
    vaultId: left.vaultId,
    entities,
    mergeLog,
    ...(mirrorProvenance != null ? { mirrorProvenance } : {}),
    ...(clientSecurity != null ? { clientSecurity } : {}),
  };
}

/** §4 per-entity merge: union by id per kind, whole-entity winner by the tie-break. */
function mergeEntities(
  left: VaultContentDoc['entities'],
  right: VaultContentDoc['entities'],
): VaultContentDoc['entities'] {
  const kinds = new Set<VaultEntityKind>([
    ...(Object.keys(left) as VaultEntityKind[]),
    ...(Object.keys(right) as VaultEntityKind[]),
  ]);
  const merged: VaultContentDoc['entities'] = {};
  for (const kind of [...kinds].sort(compareText)) {
    const byId = new Map<string, VaultEntity>();
    for (const entity of [...(left[kind] ?? []), ...(right[kind] ?? [])]) {
      const existing = byId.get(entity.id);
      byId.set(entity.id, existing == null ? entity : chooseVaultEntity(existing, entity));
    }
    const list = [...byId.values()].sort((a, b) => compareText(a.id, b.id));
    if (list.length > 0) merged[kind] = list;
  }
  return merged;
}

function unionMergeLog(
  left: VaultContentDoc['mergeLog'],
  right: VaultContentDoc['mergeLog'],
): VaultContentDoc['mergeLog'] {
  const byKey = new Map<string, VaultContentDoc['mergeLog'][number]>();
  for (const record of [...left, ...right]) byKey.set(canonicalVaultJson(record), record);
  return [...byKey.values()].sort((a, b) =>
    compareText(canonicalVaultJson(a), canonicalVaultJson(b)),
  );
}

/**
 * §7.1 severed-fork provenance is content-addressed: the union keyed by logical
 * identity is what every replica converges on — a merge must never be the step
 * that loses an identity map (mobile A8's inverse concern).
 */
function unionMirrorProvenance(
  left: VaultMirrorProvenance[] | undefined,
  right: VaultMirrorProvenance[] | undefined,
): VaultMirrorProvenance[] | undefined {
  if (left == null && right == null) return undefined;
  const byKey = new Map<string, VaultMirrorProvenance>();
  for (const row of [...(left ?? []), ...(right ?? [])]) byKey.set(canonicalVaultJson(row), row);
  return [...byKey.values()].sort((a, b) =>
    compareText(canonicalVaultJson(a), canonicalVaultJson(b)),
  );
}

function reconcileClientSecurity(
  left: VaultCommonDoc['clientSecurity'],
  right: VaultCommonDoc['clientSecurity'],
): VaultCommonDoc['clientSecurity'] {
  if (left == null) return right;
  if (right == null) return left;
  if (canonicalVaultJson(left) !== canonicalVaultJson(right)) {
    throw new VaultCryptoError(
      'document-invalid',
      'Vault retirement proof material diverged across replicas.',
    );
  }
  return left;
}

function higherVersionThenUpdatedAt(
  left: UnreadableCandidate,
  right: UnreadableCandidate,
): UnreadableCandidate {
  if (left.version !== right.version) return left.version > right.version ? left : right;
  return left.updatedAt >= right.updatedAt ? left : right;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
