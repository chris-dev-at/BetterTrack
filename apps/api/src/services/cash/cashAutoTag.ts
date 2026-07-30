import type { CashSystemTagKey } from '@bettertrack/contracts';

import type { CashMovementKind } from '../../domain/cashLedger';

/**
 * AUTO-TAGGING — the engine stamping a movement's app-owned tag when it books it
 * (V5 cash fusion).
 *
 * Nine movement kinds map onto SEVEN system tags. The table is exhaustive by
 * type: `Record<CashMovementKind, …>` means a tenth kind cannot be added without
 * deciding what it is tagged as, which is exactly the mistake the ledger's own
 * external/internal table was written to prevent.
 *
 *   buy              → investment      money leaving to buy an asset
 *   sell_proceeds    → sale_proceeds   money arriving from a sale
 *   dividend         → dividend        a distribution
 *   tax_withholding  → tax             both directions of a tax settlement are
 *   tax_refund       → tax             the same question, so they share a tag
 *   transfer_out     → transfer        both legs; they cancel, and splitting them
 *   transfer_in      → transfer        would double-count an internal move
 *   deposit          → deposit         external money in
 *   withdrawal       → withdrawal      external money out
 *
 * The two seeded keys with no kind behind them — `interest` and `fees` — are
 * deliberately unreachable from here. No movement kind produces them today (bank
 * interest arrives as a `deposit`; trade fees are folded into the buy/sell
 * magnitude), and inventing a mapping would mis-label real rows. They exist so an
 * imported statement row has a home from day one, assigned by a rule or by hand.
 *
 * The table is the DECISION; the stamping itself lives in
 * `data/repositories/cashSystemTagStamp.ts`, hanging off the three INSERT paths
 * so that a new booking site gets auto-tagging by construction rather than by
 * somebody remembering to call a service.
 *
 * ── WHAT HAPPENS TO A USER'S OWN TAGS ──
 *
 * Stamping is ADDITIVE and idempotent: it attaches one tag and never removes
 * another, and `UNIQUE(movement, tag)` makes a repeat a no-op. So a user's manual
 * tags survive re-booking, and a user who REMOVES a system tag from a movement
 * keeps it removed — nothing re-stamps an existing movement, because stamping only
 * ever happens at the moment a movement row is created.
 *
 * If the underlying trade is later EDITED, the edit deletes the old movement and
 * books a new one (a new row, a new id). The new row is stamped fresh with its
 * system tag and carries NO user tags — the tags belonged to the row that no
 * longer exists, and there is no correct way to move a label onto a movement whose
 * amount or date may now be different. That is stated here because it is the one
 * place a user can lose a tag they set, and `cashTagging.test.ts` pins it.
 */

/** The app-owned tag every bookable movement kind carries. */
export const SYSTEM_TAG_FOR_KIND: Readonly<Record<CashMovementKind, CashSystemTagKey>> = {
  deposit: 'deposit',
  withdrawal: 'withdrawal',
  buy: 'investment',
  sell_proceeds: 'sale_proceeds',
  transfer_out: 'transfer',
  transfer_in: 'transfer',
  dividend: 'dividend',
  tax_withholding: 'tax',
  tax_refund: 'tax',
};
