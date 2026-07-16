import type { BrokerMapper } from '../types';

import { tradeRepublicMapper } from './tradeRepublic';

/**
 * The registered broker mappers (PROJECTPLAN.md §13.4 V4-P8). Adding a broker =
 * one mapper module + one fixture + one entry here — nothing else changes
 * (George/Flatex/IBKR land in the follow-up issue against this frozen list).
 */
export const ALL_MAPPERS: readonly BrokerMapper[] = [tradeRepublicMapper];

export { tradeRepublicMapper };
