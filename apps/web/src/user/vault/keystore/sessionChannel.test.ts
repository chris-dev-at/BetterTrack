import { webcrypto } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createBroadcastEndpointSessionTransport,
  endpointSessionChannelName,
  importShareableDeviceKey,
  isShareableDeviceKey,
  parseEndpointSessionMessage,
  type EndpointSessionMessage,
} from './sessionChannel';

const ACCOUNT_A = '018f6a3e-0000-7000-8000-00000000aaaa';
const ACCOUNT_B = '018f6a3e-0000-7000-8000-00000000bbbb';
const REQUEST = '018f6a3e-9999-7000-8000-000000000001';

let deviceKey: CryptoKey;
let extractableKey: CryptoKey;

beforeEach(async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  deviceKey = await importShareableDeviceKey(new Uint8Array(32).fill(0x11));
  extractableKey = await webcrypto.subtle.importKey(
    'raw',
    new Uint8Array(32).fill(0x11),
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt'],
  );
});

/**
 * The channel is same-ORIGIN, not same-AUTHOR: everything arriving on it is
 * untrusted input, and this is the gate that says so.
 */
describe('parseEndpointSessionMessage', () => {
  it('accepts the three well-formed shapes', () => {
    expect(
      parseEndpointSessionMessage(
        { kind: 'session-request', accountId: ACCOUNT_A, requestId: REQUEST },
        ACCOUNT_A,
      ),
    ).toEqual({ kind: 'session-request', accountId: ACCOUNT_A, requestId: REQUEST });
    expect(
      parseEndpointSessionMessage(
        { kind: 'session-grant', accountId: ACCOUNT_A, requestId: REQUEST, deviceKey },
        ACCOUNT_A,
      ),
    ).toEqual({ kind: 'session-grant', accountId: ACCOUNT_A, requestId: REQUEST, deviceKey });
    expect(
      parseEndpointSessionMessage({ kind: 'session-lock', accountId: ACCOUNT_A }, ACCOUNT_A),
    ).toEqual({ kind: 'session-lock', accountId: ACCOUNT_A });
  });

  it('drops anything stamped with another account, on any shape', () => {
    for (const message of [
      { kind: 'session-request', accountId: ACCOUNT_B, requestId: REQUEST },
      { kind: 'session-grant', accountId: ACCOUNT_B, requestId: REQUEST, deviceKey },
      { kind: 'session-lock', accountId: ACCOUNT_B },
    ]) {
      expect(parseEndpointSessionMessage(message, ACCOUNT_A)).toBeNull();
    }
  });

  it('drops an EXTRACTABLE key, and every other malformed grant', () => {
    const cases: unknown[] = [
      // Exportable K_dev must never enter a keystore — it would be re-shared.
      {
        kind: 'session-grant',
        accountId: ACCOUNT_A,
        requestId: REQUEST,
        deviceKey: extractableKey,
      },
      // Raw bytes are not a handle: accepting them would put K_dev on the wire.
      {
        kind: 'session-grant',
        accountId: ACCOUNT_A,
        requestId: REQUEST,
        deviceKey: new Uint8Array(32),
      },
      { kind: 'session-grant', accountId: ACCOUNT_A, requestId: REQUEST },
      { kind: 'session-grant', accountId: ACCOUNT_A, requestId: '', deviceKey },
      { kind: 'session-request', accountId: ACCOUNT_A },
      { kind: 'session-request', accountId: ACCOUNT_A, requestId: 42 },
      { kind: 'something-else', accountId: ACCOUNT_A },
      { accountId: ACCOUNT_A },
      'session-lock',
      null,
      undefined,
      42,
    ];
    for (const message of cases) {
      expect(parseEndpointSessionMessage(message, ACCOUNT_A)).toBeNull();
    }
  });
});

describe('shareable device keys', () => {
  it('imports K_dev as a non-extractable AES-256-GCM key', () => {
    expect(deviceKey.extractable).toBe(false);
    expect(deviceKey.type).toBe('secret');
    expect(deviceKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(isShareableDeviceKey(deviceKey)).toBe(true);
  });

  it('refuses a key that is not exactly 256 bits', async () => {
    await expect(importShareableDeviceKey(new Uint8Array(16))).rejects.toMatchObject({
      code: 'crypto-failed',
    });
  });

  it('rejects extractable, wrong-algorithm and non-key values', async () => {
    expect(isShareableDeviceKey(extractableKey)).toBe(false);
    expect(isShareableDeviceKey(new Uint8Array(32))).toBe(false);
    expect(isShareableDeviceKey(null)).toBe(false);
    const hmac = await webcrypto.subtle.importKey(
      'raw',
      new Uint8Array(32),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(isShareableDeviceKey(hmac)).toBe(false);
  });
});

describe('the BroadcastChannel transport', () => {
  it('names one channel per account', () => {
    expect(endpointSessionChannelName(ACCOUNT_A)).not.toBe(endpointSessionChannelName(ACCOUNT_B));
    expect(endpointSessionChannelName(ACCOUNT_A)).toContain(ACCOUNT_A);
  });

  it('delivers to the account channel, validated, and never to itself', async () => {
    const received: EndpointSessionMessage[] = [];
    const crossAccount: EndpointSessionMessage[] = [];
    const sender = createBroadcastEndpointSessionTransport(ACCOUNT_A, () => {
      throw new Error('a transport must never receive its own post');
    })!;
    const peer = createBroadcastEndpointSessionTransport(ACCOUNT_A, (message) => {
      received.push(message);
    })!;
    const other = createBroadcastEndpointSessionTransport(ACCOUNT_B, (message) => {
      crossAccount.push(message);
    })!;

    sender.post({ kind: 'session-grant', accountId: ACCOUNT_A, requestId: REQUEST, deviceKey });
    await waitFor(() => received.length === 1);

    expect(received[0]!.kind).toBe('session-grant');
    // The structured clone crossed a channel and non-extractability survived it.
    const granted = received[0]!;
    if (granted.kind !== 'session-grant') throw new Error('unreachable');
    expect(granted.deviceKey.extractable).toBe(false);
    expect(crossAccount).toHaveLength(0);

    sender.close();
    peer.close();
    other.close();
  });

  it('swallows a post on a closed channel rather than failing the lock', () => {
    const transport = createBroadcastEndpointSessionTransport(ACCOUNT_A, () => undefined)!;
    transport.close();
    expect(() => transport.post({ kind: 'session-lock', accountId: ACCOUNT_A })).not.toThrow();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never became true');
}
