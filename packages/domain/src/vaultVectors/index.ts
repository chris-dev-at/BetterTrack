/**
 * Vault conformance vectors — the shared oracle both clients replay.
 *
 * The platform authors these byte-exact fixtures; the web suites replay them
 * against the production crypto path, and the mobile port re-pins the same
 * bytes (`tools/domain-vectors` in the app repo). Nothing in this directory
 * performs I/O or crypto — it is fixed data plus the deterministic inputs that
 * reproduce it.
 *
 * Families:
 *   v1 — the BTVAULT1 account-singleton format, the format of the ONE surviving
 *        paranoid implementation (§13.5 V5-P13).
 *
 * The six `v2*` families were deleted with the per-portfolio vault v2 surface
 * (owner ruling 2026-08-19, PROJECTPLAN §16). The mobile repo must drop its
 * matching v2 replay — nothing on this side pins those bytes any more.
 */

export * from './v1';
