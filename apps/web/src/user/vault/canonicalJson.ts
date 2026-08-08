import { VaultCryptoError } from './errors';

/**
 * Canonical JSON — the deterministic serialization the vault stack agrees on.
 *
 * One definition, two safety-critical consumers: the §4 merge tie-breaks (a
 * whole-entity winner may be decided by comparing these strings) and the r3
 * §21 header MAC (the authenticated bytes ARE this serialization). Both need
 * the same guarantee: equal values produce equal bytes on every engine, and
 * anything that cannot round-trip as plain JSON fails closed instead of
 * serializing ambiguously.
 *
 * Rules: object keys sorted lexicographically (by UTF-16 code unit) at every
 * nesting level; arrays in order; no insignificant whitespace; finite numbers
 * only (`-0` serializes as `-0` so it can never collide with `0`); plain
 * objects and dense arrays only; cycles, getters, holes and exotic prototypes
 * are refused.
 */
export function canonicalVaultJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw documentInvalid('Vault documents may contain only finite JSON numbers.');
    }
    if (Object.is(value, -0)) return '-0';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertAcyclic(value, ancestors);
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        ancestors.delete(value);
        throw documentInvalid(
          'Vault arrays may contain only dense enumerable indexed data properties.',
        );
      }
      entries.push(canonicalVaultJson(descriptor.value, ancestors));
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      ancestors.delete(value);
      throw documentInvalid('Vault arrays may contain only indexed JSON values.');
    }
    const result = `[${entries.join(',')}]`;
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    assertAcyclic(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ancestors.delete(value);
      throw documentInvalid('Vault documents may contain only plain JSON objects.');
    }
    const entries = Reflect.ownKeys(value).map((key): [string, unknown] => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        descriptor == null ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        ancestors.delete(value);
        throw documentInvalid(
          'Vault objects may contain only enumerable string-keyed data properties.',
        );
      }
      return [key, descriptor.value];
    });
    const result = `{${entries
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalVaultJson(entry, ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return result;
  }
  throw documentInvalid('Vault documents may contain only JSON values.');
}

function assertAcyclic(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw documentInvalid('Vault documents may not contain cyclic values.');
  }
  ancestors.add(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function documentInvalid(message: string): VaultCryptoError {
  return new VaultCryptoError('document-invalid', message);
}
