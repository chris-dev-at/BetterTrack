import type { BrokerMapper } from '../types';

import { flatexMapper } from './flatex';
import { georgeMapper } from './george';
import { ibkrMapper } from './ibkr';
import { tradeRepublicMapper } from './tradeRepublic';

/**
 * The registered broker mappers (PROJECTPLAN.md §13.4 V4-P8). Adding a broker =
 * one mapper module + one fixture + one entry here — nothing else changes.
 * Registration order breaks detect() ties (first registered wins).
 */
export const ALL_MAPPERS: readonly BrokerMapper[] = [
  tradeRepublicMapper,
  georgeMapper,
  flatexMapper,
  ibkrMapper,
];

export { flatexMapper, georgeMapper, ibkrMapper, tradeRepublicMapper };
