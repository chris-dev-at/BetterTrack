/**
 * Vault conformance vectors — the shared oracle both clients replay
 * (`docs/VAULTS_V2_DESIGN.md` §16 / r3).
 *
 * The platform authors these byte-exact fixtures; the web suites replay them
 * against the production crypto path, and the mobile port re-pins the same
 * bytes (`tools/domain-vectors` in the app repo). Nothing in this directory
 * performs I/O or crypto — it is fixed data plus the deterministic inputs that
 * reproduce it.
 *
 * Families (r2 §16, delivered by the r3 hardening pass):
 *   v1              — the BTVAULT1 account-singleton format (relocated intact)
 *   v2Header        — header derive/wrap/unwrap incl. the r3 `mac` (family 1)
 *   v2MultiSlot     — multi-slot `keySlots[]` unwrap (family 2)
 *   v2Partition     — the 26-kind per-portfolio/common split (family 3)
 *   v2Migration     — the byte-exact claim→write→verify→flip transcript (family 4)
 *   v2RecoveryKit   — the v2 recovery-kit layout (family 5)
 *   v2Qr            — the canonical QR string + code-KDF wrap (family 6)
 */

export * from './v1';
export * from './v2';
