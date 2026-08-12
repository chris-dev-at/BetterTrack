import { webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, it } from 'vitest';

import { buildAllVectors } from './buildVectors';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});

// One-shot generator: run with WRITE_VECTORS=1 to (re)freeze the fixture JSON
// in packages/domain. Not part of the normal suite output — it is the tool that
// PRODUCES the oracle the replay test then pins.
describe.runIf(process.env.WRITE_VECTORS === '1')('generate vault vectors', () => {
  it('writes packages/domain/src/vaultVectors/v2.fixture.json', async () => {
    const vectors = await buildAllVectors();
    // process.cwd() is apps/web when vitest runs; climb to the repo root.
    const out = path.resolve(
      process.cwd(),
      '../../packages/domain/src/vaultVectors/v2.fixture.json',
    );
    writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`);
  });
});
