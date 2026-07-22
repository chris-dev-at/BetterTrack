import { ersteGeorgeMapper } from './erste-george';
import { n26Mapper } from './n26';
import { raiffeisenElbaMapper } from './raiffeisen-elba';
import { revolutMapper } from './revolut';
import type { BankStatementMapper } from './types';

/**
 * The registered bank-statement mappers (PROJECTPLAN.md §13.5 V5-P9, issue 2/3),
 * AT-relevant + the two common neobanks. Adding a bank is one module here — the
 * import framework and contracts don't change. Registration order is the
 * tie-break for equal detect() scores (there are none in practice — the
 * signature-column disqualification keeps the four exports mutually exclusive).
 */
export const ALL_BANK_MAPPERS: readonly BankStatementMapper[] = [
  ersteGeorgeMapper,
  raiffeisenElbaMapper,
  n26Mapper,
  revolutMapper,
];

export { ersteGeorgeMapper, raiffeisenElbaMapper, n26Mapper, revolutMapper };
export {
  createBankMapperRegistry,
  BANK_DETECT_THRESHOLD,
  type BankMapperRegistry,
} from './registry';
export {
  buildExpenseRow,
  columnIndex,
  firstNonEmpty,
  headerCoverage,
  lowerHeader,
  type BankStatementMapper,
  type MappedExpenseLine,
  type NormalizedExpenseRow,
} from './types';
