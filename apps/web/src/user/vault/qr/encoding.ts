/**
 * qrcode.react encodes text through qrcodegen's `makeSegments`. The mandatory
 * lowercase `btvault1:` prefix cannot be numeric/alphanumeric QR text, so the
 * library deterministically selects its UTF-8 byte segment. Disabling boost is
 * what keeps the emitted level exactly M instead of silently raising it.
 */
export const VAULT_TRANSFER_QR_OPTIONS = {
  mode: 'byte',
  characterEncoding: 'UTF-8',
  errorCorrectionLevel: 'M',
  boostErrorCorrectionLevel: false,
} as const;

export const VAULT_TRANSFER_QR_EXPIRY_MS = 60_000;
export const VAULT_TRANSFER_STEP_UP_MAX_AGE_MS = 60_000;
