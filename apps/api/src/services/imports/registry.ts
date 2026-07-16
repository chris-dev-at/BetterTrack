import type { ImportBroker } from '@bettertrack/contracts';

import type { ParsedCsv } from './csv';
import type { BrokerMapper } from './types';

/**
 * Mapper registry + broker autodetection (PROJECTPLAN.md §13.4 V4-P8). The
 * registry is built from a plain mapper list, so tests can inject fakes and the
 * production wiring just passes `ALL_MAPPERS`.
 */

/** Minimum detect() confidence before autodetection trusts a mapper. */
export const DETECT_THRESHOLD = 0.6;

export interface MapperRegistry {
  list(): ImportBroker[];
  byId(id: string): BrokerMapper | null;
  /** The most confident mapper above {@link DETECT_THRESHOLD}, or null. */
  detect(csv: ParsedCsv): BrokerMapper | null;
}

export function createMapperRegistry(mappers: readonly BrokerMapper[]): MapperRegistry {
  return {
    list() {
      return mappers.map((m) => ({ id: m.id, label: m.label }));
    },

    byId(id) {
      return mappers.find((m) => m.id === id) ?? null;
    },

    detect(csv) {
      let best: BrokerMapper | null = null;
      let bestScore = 0;
      for (const mapper of mappers) {
        const score = mapper.detect(csv);
        if (score > bestScore) {
          best = mapper;
          bestScore = score;
        }
      }
      return bestScore >= DETECT_THRESHOLD ? best : null;
    },
  };
}
