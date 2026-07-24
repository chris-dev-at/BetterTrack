import { VaultCryptoError } from './errors';

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(
  bytes: Uint8Array,
  code: 'document-invalid' | 'envelope-invalid',
): string {
  try {
    return strictDecoder.decode(bytes);
  } catch (cause) {
    throw new VaultCryptoError(code, 'Vault data is not valid UTF-8.', { cause });
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(
  value: string,
  code: 'envelope-invalid' | 'recovery-kit-invalid',
): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new VaultCryptoError(code, 'Vault data is not canonical base64.');
  }

  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (bytesToBase64(bytes) !== value) {
      throw new VaultCryptoError(code, 'Vault data is not canonical base64.');
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof VaultCryptoError) throw cause;
    throw new VaultCryptoError(code, 'Vault data is not valid base64.', { cause });
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}
