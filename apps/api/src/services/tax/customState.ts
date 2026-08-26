import { customTaxParamsSchema } from '@bettertrack/contracts';

import type { TransactionRecord } from '../../data/repositories/transactionRepository';

/**
 * A sell frozen under a FIFO-based custom parameter set. Any trade of its
 * asset can shift lot consumption, so the living-year engine widens the
 * affected asset set around these rows.
 */
export const isCustomFifoSell = (transaction: TransactionRecord): boolean => {
  if (transaction.side !== 'sell' || transaction.taxMode !== 'custom') return false;

  const params = customTaxParamsSchema.safeParse(transaction.taxParams);
  if (!params.success) {
    throw new Error(`Tax engine: row ${transaction.id} carries an unreadable custom-tax snapshot`);
  }
  return params.data.costBasis === 'fifo';
};
