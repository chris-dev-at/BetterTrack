import { describe, expect, it } from 'vitest';

import { AT_AS_CUSTOM_PARAMS } from '../../../domain/tax';
import { isCustomFifoSell } from '../customState';
import { txRecord } from './records';

describe('isCustomFifoSell', () => {
  it('recognises only custom sells frozen under FIFO parameters', () => {
    const movingAverageSell = txRecord({
      id: 'moving-average-sell',
      side: 'sell',
      taxMode: 'custom',
      taxParams: AT_AS_CUSTOM_PARAMS,
    });
    const fifoSell = txRecord({
      id: 'fifo-sell',
      side: 'sell',
      taxMode: 'custom',
      taxParams: { ...AT_AS_CUSTOM_PARAMS, costBasis: 'fifo' },
    });

    expect(isCustomFifoSell(fifoSell)).toBe(true);
    expect(isCustomFifoSell(movingAverageSell)).toBe(false);
    expect(isCustomFifoSell(txRecord({ id: 'buy', side: 'buy', taxMode: 'custom' }))).toBe(false);
    expect(isCustomFifoSell(txRecord({ id: 'manual', side: 'sell', taxMode: 'none' }))).toBe(false);
  });

  it('fails loud with the row id when a custom FIFO candidate has corrupt parameters', () => {
    expect(() =>
      isCustomFifoSell(
        txRecord({ id: 'bad-row', side: 'sell', taxMode: 'custom', taxParams: null }),
      ),
    ).toThrow(/bad-row/);
  });
});
