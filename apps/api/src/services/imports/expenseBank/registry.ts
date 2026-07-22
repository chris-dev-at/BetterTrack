import type { ExpenseBank } from '@bettertrack/contracts';

import type { ParsedCsv } from '../csv';
import type { BankStatementMapper } from './types';

/**
 * Bank-statement mapper registry + autodetection (PROJECTPLAN.md §13.5 V5-P9,
 * issue 2/3). A SEPARATE instance from the broker registry (`../registry.ts`) so
 * the expense import path never touches broker autodetect. Built from a plain
 * mapper list, so tests can inject fakes and production passes `ALL_BANK_MAPPERS`.
 */

/** Minimum detect() confidence before autodetection trusts a mapper. */
export const BANK_DETECT_THRESHOLD = 0.6;

export interface BankMapperRegistry {
  list(): ExpenseBank[];
  byId(id: string): BankStatementMapper | null;
  /** The most confident mapper above {@link BANK_DETECT_THRESHOLD}, or null. */
  detect(csv: ParsedCsv): BankStatementMapper | null;
}

export function createBankMapperRegistry(
  mappers: readonly BankStatementMapper[],
): BankMapperRegistry {
  return {
    list() {
      return mappers.map((m) => ({ id: m.id, label: m.label }));
    },

    byId(id) {
      return mappers.find((m) => m.id === id) ?? null;
    },

    detect(csv) {
      let best: BankStatementMapper | null = null;
      let bestScore = 0;
      for (const mapper of mappers) {
        const score = mapper.detect(csv);
        if (score > bestScore) {
          best = mapper;
          bestScore = score;
        }
      }
      return bestScore >= BANK_DETECT_THRESHOLD ? best : null;
    },
  };
}
