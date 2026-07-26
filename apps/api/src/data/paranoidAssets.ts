/**
 * A content-free FK anchor for a custom asset that is still referenced by a
 * server-classified watchlist item, conglomerate position, or price alert while
 * its owner is in paranoid mode.
 *
 * The row deliberately retains only its id + owner relationship (which the kept
 * rows already reveal). Every user-entered field is blanked by the transition
 * repository, all price history is purged, and the original row is restored in
 * place from the encrypted vault on disable.
 */
export const PARANOID_SEALED_ASSET_PROVIDER_ID = 'paranoid-sealed';
