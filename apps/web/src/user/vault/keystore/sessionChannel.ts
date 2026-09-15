import { EndpointKeystoreError } from './errors';

/**
 * §12-conformant cross-tab session sharing.
 *
 * ── WHAT §12 ACTUALLY SCOPES A SESSION TO ─────────────────────────────────
 *
 * "Entering it once per session unlocks ALL wrapped phrases on that ENDPOINT."
 * An endpoint is a device, not a browser tab — and §12's list of things that end
 * a session is exhaustive: "tab/app close (memory dies with the process), an
 * explicit 'Lock vaults' action, or the existing PIN idle-lock timer". Opening a
 * second tab appears on neither list, so a device that has one live session
 * should have it in every tab of that device.
 *
 * This module carries the LIVE session between same-origin tabs and nothing
 * else. It writes nothing, anywhere: no IndexedDB, no localStorage, no
 * sessionStorage, no cookie, no service-worker cache, no log. `BroadcastChannel`
 * messages exist only while a listener is alive to receive them, so the session
 * still dies with the last tab of the device — which is the whole of §12's
 * "memory dies with the process", applied to a device with more than one window.
 *
 * ── WHAT CROSSES THE CHANNEL ──────────────────────────────────────────────
 *
 * K_dev, and only K_dev, imported as a NON-EXTRACTABLE AES-256-GCM `CryptoKey`.
 * A non-extractable CryptoKey is structured-cloneable between same-origin
 * contexts and its non-extractability survives the clone, so what the receiving
 * tab gets is a handle it can decrypt with and cannot read out. No mnemonic, no
 * BIP39 entropy, no content key and no password ever appears in a message: the
 * receiver re-derives all of it from its own IndexedDB, exactly as a password
 * unlock does, and only after the wrap-check proves the granted key belongs to
 * this endpoint's password.
 *
 * ── THE TRADE-OFF, STATED ─────────────────────────────────────────────────
 *
 * `BroadcastChannel` is same-origin. Any script running on this origin can open
 * the channel, post a request and receive a grant. That is a real capability and
 * it is deliberately accepted, because a script that can do it can also reach
 * `endpointVaultKeystore` — the module singleton in the same bundle — and call
 * `readMnemonic()` directly. The channel therefore widens no boundary that
 * script execution on the origin had not already crossed. What the
 * non-extractable import does buy is that the key cannot be SERIALIZED out of
 * the origin: an injected script may use it here, but cannot ship K_dev to a
 * server or another device.
 */

/** One channel per account, so two accounts on one profile never meet. */
const SESSION_CHANNEL_PREFIX = 'bettertrack:endpoint-session:';
const DEVICE_KEY_BITS = 256;

export function endpointSessionChannelName(accountId: string): string {
  return `${SESSION_CHANNEL_PREFIX}${accountId}`;
}

export type EndpointSessionMessage =
  /** "Is anyone holding a live session for this account?" */
  | { kind: 'session-request'; accountId: string; requestId: string }
  /** "Here is the one I hold." Answers exactly one request id. */
  | { kind: 'session-grant'; accountId: string; requestId: string; deviceKey: CryptoKey }
  /** "The user locked this device." Carries no key material. */
  | { kind: 'session-lock'; accountId: string };

export interface EndpointSessionTransport {
  post(message: EndpointSessionMessage): void;
  close(): void;
}

/**
 * Injected so tests can drive two tabs deterministically and so a browser
 * without `BroadcastChannel` degrades to "no sharing" rather than to a crash.
 */
export type CreateEndpointSessionTransport = (
  accountId: string,
  onMessage: (message: EndpointSessionMessage) => void,
) => EndpointSessionTransport | null;

export const createBroadcastEndpointSessionTransport: CreateEndpointSessionTransport = (
  accountId,
  onMessage,
) => {
  const Channel = globalThis.BroadcastChannel;
  if (typeof Channel !== 'function') return null;
  let channel: BroadcastChannel;
  try {
    channel = new Channel(endpointSessionChannelName(accountId));
  } catch {
    return null;
  }
  const listener = (event: MessageEvent) => {
    const message = parseEndpointSessionMessage(event.data, accountId);
    if (message != null) onMessage(message);
  };
  channel.addEventListener('message', listener);
  return {
    post(message) {
      // A closed or wedged channel must never propagate as a failed lock or a
      // failed unlock: sharing is an optimization, the password always works.
      try {
        channel.postMessage(message);
      } catch {
        // Intentionally swallowed; see above.
      }
    },
    close() {
      channel.removeEventListener('message', listener);
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    },
  };
};

/**
 * Every message is untrusted input — the channel is same-origin, not
 * same-author. A message that is not exactly one of the three shapes, or that
 * names a different account than the channel it arrived on, is dropped.
 */
export function parseEndpointSessionMessage(
  data: unknown,
  expectedAccountId: string,
): EndpointSessionMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Partial<Record<string, unknown>>;
  if (typeof message.accountId !== 'string' || message.accountId !== expectedAccountId) return null;
  switch (message.kind) {
    case 'session-request':
      return typeof message.requestId === 'string' && message.requestId.length > 0
        ? { kind: 'session-request', accountId: expectedAccountId, requestId: message.requestId }
        : null;
    case 'session-grant':
      return typeof message.requestId === 'string' &&
        message.requestId.length > 0 &&
        isShareableDeviceKey(message.deviceKey)
        ? {
            kind: 'session-grant',
            accountId: expectedAccountId,
            requestId: message.requestId,
            deviceKey: message.deviceKey,
          }
        : null;
    case 'session-lock':
      return { kind: 'session-lock', accountId: expectedAccountId };
    default:
      return null;
  }
}

/**
 * The same predicate `crypto.ts` applies before it will use a CryptoKey as vault
 * key material, checked HERE as well so a junk grant is dropped at the transport
 * instead of surfacing as an authentication failure three awaits later.
 */
export function isShareableDeviceKey(value: unknown): value is CryptoKey {
  if (typeof CryptoKey !== 'function' || !(value instanceof CryptoKey)) return false;
  return (
    !value.extractable &&
    value.type === 'secret' &&
    value.algorithm.name === 'AES-GCM' &&
    (value.algorithm as AesKeyAlgorithm).length === DEVICE_KEY_BITS
  );
}

/**
 * Raw K_dev → the only form allowed onto the channel.
 *
 * `extractable: false` is asserted rather than assumed: a runtime that quietly
 * returned an extractable key would put exportable K_dev bytes into every tab of
 * the origin, so the grant is refused instead.
 */
export async function importShareableDeviceKey(deviceKey: Uint8Array): Promise<CryptoKey> {
  if (deviceKey.length !== DEVICE_KEY_BITS / 8) {
    throw new EndpointKeystoreError('crypto-failed', 'Device key must be 256 bits.');
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle == null) {
    throw new EndpointKeystoreError('crypto-failed', 'WebCrypto is unavailable.');
  }
  const key = await subtle.importKey('raw', deviceKey, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  if (!isShareableDeviceKey(key)) {
    throw new EndpointKeystoreError('crypto-failed', 'Browser returned an extractable device key.');
  }
  return key;
}
