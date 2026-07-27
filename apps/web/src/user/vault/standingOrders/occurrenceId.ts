const OCCURRENCE_NAMESPACE = '6906a66e-1028-5c2e-8942-38485868f140';

/**
 * RFC 4122 UUIDv5. The stable namespace plus `(orderId, dueDate)` makes an
 * occurrence converge to one entity identity on retries and concurrent devices.
 */
export async function standingOrderOccurrenceId(orderId: string, dueDate: string): Promise<string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderId) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
  ) {
    throw new TypeError('A standing-order occurrence requires a UUID and ISO calendar day.');
  }
  const namespace = uuidBytes(OCCURRENCE_NAMESPACE);
  const name = new TextEncoder().encode(`${orderId}\u0000${dueDate}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

function uuidBytes(uuid: string): Uint8Array {
  return Uint8Array.from(uuid.replaceAll('-', '').match(/.{2}/g)!, (byte) =>
    Number.parseInt(byte, 16),
  );
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
