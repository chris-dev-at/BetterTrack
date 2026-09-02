/**
 * Tax conformance vectors — the shared oracle both tax engines replay.
 *
 * Families:
 *   rowEngine — which engine a frozen row settles under against the living
 *               regime (#1512): replayed by the server `countryState` suite
 *               and the paranoid client `taxEngine` suite so the two hand-
 *               mirrored classifiers can never drift silently.
 *
 * Nothing in this directory performs I/O — it is fixed data only.
 */

export * from './rowEngine';
