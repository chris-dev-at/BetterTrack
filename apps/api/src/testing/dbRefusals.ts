import { expect } from 'vitest';

import { driverError } from '../data/driverError';

/**
 * Assert that the database itself refused a query, and name the reason.
 *
 * The schema suites check constraints, CHECKs and PL/pgSQL guards by driving
 * drizzle straight at the harness database and matching the refusal text. Since
 * drizzle-orm 0.44 the driver's error no longer reaches the caller: the session
 * rethrows a `DrizzleQueryError` whose message is the failing SQL plus its bound
 * parameters, with the original hung off `cause`. A plain
 * `rejects.toThrow(/constraint/)` therefore matches the query text rather than
 * the constraint, which is both a false negative here and — because it would
 * happily pass on a DIFFERENT statement mentioning the same name — a weaker
 * assertion than the one it replaced.
 *
 * So unwrap first and assert on the driver error, which is exactly what these
 * suites asserted before the upgrade.
 */
export async function expectDbRefusal(
  query: PromiseLike<unknown>,
  reason: RegExp,
): Promise<unknown> {
  let refusal: unknown;
  let refused = false;
  try {
    await query;
  } catch (error) {
    refused = true;
    refusal = driverError(error);
  }
  expect(refused, `expected the database to refuse this query with ${reason}`).toBe(true);
  expect(refusal).toHaveProperty('message', expect.stringMatching(reason));
  return refusal;
}
