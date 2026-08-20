import { VaultKeyCoreError } from './errors';

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** Strict, canonical, unpadded base64url decoder. */
export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new VaultKeyCoreError('envelope-invalid', 'Value is not canonical base64url.');
  }
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(value.replace(/-/gu, '+').replace(/_/gu, '/') + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) {
      throw new VaultKeyCoreError('envelope-invalid', 'Value is not canonical base64url.');
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof VaultKeyCoreError) throw cause;
    throw new VaultKeyCoreError('envelope-invalid', 'Value is not valid base64url.', { cause });
  }
}
