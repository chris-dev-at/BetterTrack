import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the parameters mandated by PROJECTPLAN.md §10: memory 64 MiB,
 * iterations 3, parallelism 1. argon2id is @node-rs/argon2's default algorithm
 * (the password test asserts the `$argon2id$` output format). Parameters are
 * embedded in the hash, so verifying older hashes keeps working after a tune.
 */
export interface HashOptions {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

const HASH_OPTIONS: HashOptions = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
};

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

/**
 * Production callers pass no arguments and get §10's parameters. `overrides`
 * is a test seam: the deliberate slowness of those parameters is the security
 * property in production and pure overhead in tests, and because the parameters
 * are embedded in each hash, hashes minted at different costs verify freely.
 */
export function createPasswordHasher(overrides?: Partial<HashOptions>): PasswordHasher {
  const options: HashOptions = { ...HASH_OPTIONS, ...overrides };
  return {
    hash: (password) => hash(password, options),
    async verify(passwordHash, password) {
      try {
        return await verify(passwordHash, password);
      } catch {
        // Malformed/foreign hash → treat as a non-match rather than a 500.
        return false;
      }
    },
  };
}
