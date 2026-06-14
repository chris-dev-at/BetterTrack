import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the parameters mandated by PROJECTPLAN.md §10: memory 64 MiB,
 * iterations 3, parallelism 1. argon2id is @node-rs/argon2's default algorithm
 * (the password test asserts the `$argon2id$` output format). Parameters are
 * embedded in the hash, so verifying older hashes keeps working after a tune.
 */
const HASH_OPTIONS = {
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export function createPasswordHasher(): PasswordHasher {
  return {
    hash: (password) => hash(password, HASH_OPTIONS),
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
