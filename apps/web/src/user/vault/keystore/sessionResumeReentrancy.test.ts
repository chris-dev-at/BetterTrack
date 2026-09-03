import { webcrypto } from 'node:crypto';

import 'fake-indexeddb/auto';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VAULT_DOC_SCHEMA_VERSION } from '@bettertrack/contracts';

import { utf8, zeroBytes } from '../bytes';
import { encryptVaultDoc } from '../keys/documents';
import {
  deriveAccountBinding,
  deriveKeyFingerprint,
  deriveVaultWrapKey,
  wrapContentKey,
} from '../keys/keyCore';
import {
  readVaultEndpointState,
  VAULT_ENDPOINT_STATE_QUERY_PREFIX,
  vaultEndpointStateQueryKey,
} from '../ui/useVaultEndpointState';
import { isEndpointDeviceLocked } from './deviceLock';
import { bindEndpointKeystoreAccount, endpointVaultKeystore } from './runtime';
import type { EndpointVaultState } from './types';

/**
 * Regression for the review finding on PR #1707: a session end must never
 * re-enter the resume path synchronously.
 *
 * The chain that did: `runtime.ts` drops its resume memo on every session end →
 * the shell's listener (`useEndpointVaultSession`) invalidates the endpoint-state
 * queries in the same tick → TanStack re-runs a query that already HOLDS data
 * synchronously → its queryFn asks `resumeEndpointSessionOnce()` → a fresh
 * resume started before the previous one had assigned its promise, and its
 * `beginSessionChange()` announced another session end. 300+ nested resumes,
 * a swallowed `RangeError`, and every nested resume installing over the
 * previous one.
 *
 * Two guards close it, and this suite pins both: a resume mints its generation
 * WITHOUT announcing a session end (there is nothing to end at entry), and the
 * in-flight promise is assigned before the resume body runs. The setup mirrors
 * production exactly — the module singleton, a real `QueryClient` observer with
 * data, and the same invalidate-on-session-end listener the shell installs.
 */

const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';
const KEY_ID = '018f6a3e-3333-7000-8000-000000000001';
const DOC_ID = '018f6a3e-2222-7000-8000-000000000001';
const DEVICE_ID = '018f6a3e-4444-7000-8000-000000000001';
const WRITE_ID = '018f6a3e-5555-7000-8000-000000000001';
const ACCOUNT_ID = '018f6a3e-0000-7000-8000-00000000aaaa';
const PASSWORD = 'endpoint password secret';
/** Public BIP39 TEST VECTOR: 128 zero entropy bits, never production material. */
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function deterministicRandom(): (length: number) => Uint8Array {
  let next = 1;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = next++ % 256;
    return bytes;
  };
}

async function createHeaderEnvelope(vaultId: string): Promise<Uint8Array> {
  const contentKey = new Uint8Array(32).fill(0x31);
  const wrapKey = await deriveVaultWrapKey(MNEMONIC, vaultId);
  try {
    const keySlot = await wrapContentKey({
      contentKey,
      wrapKey,
      vaultId,
      keyId: KEY_ID,
      randomBytes: deterministicRandom(),
    });
    await deriveKeyFingerprint(contentKey);
    const encrypted = await encryptVaultDoc({
      plaintext: utf8(
        JSON.stringify({
          schemaVersion: VAULT_DOC_SCHEMA_VERSION,
          name: 'TEST VECTOR vault',
          portfolios: [],
          keySlots: [keySlot],
          driveConnection: null,
          created: { at: '2026-08-20T12:00:00.000Z', deviceId: DEVICE_ID },
        }),
      ),
      contentKey,
      header: {
        keyId: KEY_ID,
        keySlots: [keySlot],
        vaultId,
        docId: DOC_ID,
        docKind: 'header',
        accountBinding: await deriveAccountBinding(ACCOUNT_ID),
        docVersion: 1,
        schemaVersion: VAULT_DOC_SCHEMA_VERSION,
        deviceId: DEVICE_ID,
        writeId: WRITE_ID,
        writtenAt: '2026-08-20T12:00:00.000Z',
      },
      randomBytes: deterministicRandom(),
    });
    return encrypted.envelope;
  } finally {
    zeroBytes(contentKey);
    zeroBytes(wrapKey);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
/** The session state once every in-flight resume has settled (the sibling-tab ask waits 300 ms first). */
const sessionAfterResume = () =>
  expect.poll(
    async () => {
      const state = await endpointVaultKeystore.stateFor(VAULT_1);
      return state.status === 'stored+wrapped' ? state.session : state.status;
    },
    { timeout: 4_000, interval: 50 },
  );

let queryClient: QueryClient;
let observer: QueryObserver<
  EndpointVaultState,
  Error,
  EndpointVaultState,
  EndpointVaultState,
  ReturnType<typeof vaultEndpointStateQueryKey>
>;
let unsubscribe: () => void;
let releaseListener: () => void;
let depth = 0;
let maxDepth = 0;
let sessionEnds = 0;
let queryFnCalls = 0;

beforeAll(async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  localStorage.clear();
  bindEndpointKeystoreAccount(ACCOUNT_ID);
  const envelope = await createHeaderEnvelope(VAULT_1);
  // The ceremony: the first password creates the metadata and the first session.
  await endpointVaultKeystore.storeAfterVerifiedOpen({
    vaultId: VAULT_1,
    mnemonic: MNEMONIC,
    devicePassword: PASSWORD,
    fetchHeaderEnvelope: async () => envelope.slice(),
  });
  await settle();

  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  observer = new QueryObserver(queryClient, {
    queryKey: vaultEndpointStateQueryKey(VAULT_1),
    queryFn: () => {
      queryFnCalls += 1;
      return readVaultEndpointState(VAULT_1);
    },
    staleTime: 5_000,
  });
  unsubscribe = observer.subscribe(() => undefined);
  await observer.refetch();
  // The shell's second effect in `useEndpointVaultSession`, verbatim in spirit.
  releaseListener = endpointVaultKeystore.subscribeToSessionEnd(() => {
    sessionEnds += 1;
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    try {
      void queryClient.invalidateQueries({ queryKey: VAULT_ENDPOINT_STATE_QUERY_PREFIX });
    } finally {
      depth -= 1;
    }
  });
});

afterAll(() => {
  releaseListener?.();
  unsubscribe?.();
  endpointVaultKeystore.lockDevice();
  bindEndpointKeystoreAccount(null);
});

function resetCounters() {
  depth = 0;
  maxDepth = 0;
  sessionEnds = 0;
  queryFnCalls = 0;
}

describe('endpoint session resume is not re-entrant through the state invalidation', () => {
  it('precondition: live session, persisted record, marker unset, query holds data', async () => {
    expect(await endpointVaultKeystore.stateFor(VAULT_1)).toMatchObject({ session: 'unlocked' });
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(false);
    expect(observer.getCurrentResult().data).toMatchObject({ session: 'unlocked' });
  });

  it('a consistency teardown resumes once from the device record — no cascade', async () => {
    resetCounters();
    endpointVaultKeystore.endSession();
    // The listener ran exactly once for the end we caused, nested nowhere.
    expect(maxDepth).toBeLessThan(2);
    expect(sessionEnds).toBe(1);
    // The record brought the session back, and it did so in ONE resume.
    await sessionAfterResume().toBe('unlocked');
    expect(sessionEnds, 'a resume must not announce session ends').toBe(1);
    expect(queryFnCalls).toBeLessThan(4);
  });

  it('an unlock with the marker unset and no record does not nest resumes into itself', async () => {
    // Forget without a lock (TTL expiry / eviction stand-in): end the session,
    // then make sure nothing resumes it.
    endpointVaultKeystore.lockDevice();
    await settle();
    localStorage.clear(); // marker unset, record gone
    expect(isEndpointDeviceLocked(ACCOUNT_ID)).toBe(false);
    await observer.refetch();
    await sessionAfterResume().toBe('locked');

    resetCounters();
    // The password must win against the speculative resume its own session end
    // triggers through the invalidation: no "cancelled", no nested cascade.
    await expect(endpointVaultKeystore.unlock(PASSWORD)).resolves.toEqual({
      unlockedVaultIds: [VAULT_1],
    });
    expect(maxDepth).toBeLessThan(2);
    await sessionAfterResume().toBe('unlocked');
    expect(sessionEnds, 'the unlock itself is the only session end').toBeLessThanOrEqual(1);
  });
});
