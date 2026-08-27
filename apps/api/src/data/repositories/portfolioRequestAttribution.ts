import { eq } from 'drizzle-orm';

import type { Database } from '../db';
import {
  cashBudgets,
  importBatches,
  itemComments,
  portfolioCashMovements,
  portfolios,
  standingOrders,
} from '../schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PORTFOLIO_ATTRIBUTION_SEGMENT = '_portfolio';

export interface PortfolioRequestAttribution {
  readonly recognized: boolean;
  readonly portfolioId: string | null;
  readonly ownerId: string | null;
  readonly vaultId: string | null;
  /** True when the resource exists but is account-common rather than portfolio content. */
  readonly nonPortfolio: boolean;
}

const UNRECOGNIZED: PortfolioRequestAttribution = {
  recognized: false,
  portfolioId: null,
  ownerId: null,
  vaultId: null,
  nonPortfolio: false,
};

const MISSING: PortfolioRequestAttribution = {
  recognized: true,
  portfolioId: null,
  ownerId: null,
  vaultId: null,
  nonPortfolio: false,
};

function pathSegments(path: string): string[] {
  const segments = path.split('?', 1)[0]!.split('/').filter(Boolean);
  return segments[0]?.toLowerCase() === 'api' && segments[1]?.toLowerCase() === 'v1'
    ? segments.slice(2)
    : segments;
}

function resourceIdForPath(path: string): {
  kind: 'import' | 'standing-order' | 'cash-budget' | 'cash-movement' | 'comment';
  id: string;
} | null {
  const segments = pathSegments(path);
  const first = segments[0]?.toLowerCase();
  if (first === 'imports' && UUID_PATTERN.test(segments[1] ?? '')) {
    return { kind: 'import', id: segments[1]! };
  }
  if (first === 'standing-orders' && UUID_PATTERN.test(segments[1] ?? '')) {
    return { kind: 'standing-order', id: segments[1]! };
  }
  if (
    first === 'cash' &&
    segments[1]?.toLowerCase() === 'budgets' &&
    UUID_PATTERN.test(segments[2] ?? '')
  ) {
    return { kind: 'cash-budget', id: segments[2]! };
  }
  if (
    first === 'cash' &&
    segments[1]?.toLowerCase() === 'movements' &&
    UUID_PATTERN.test(segments[2] ?? '')
  ) {
    return { kind: 'cash-movement', id: segments[2]! };
  }
  if (
    first === 'social' &&
    segments[1]?.toLowerCase() === 'comments' &&
    UUID_PATTERN.test(segments[2] ?? '')
  ) {
    return { kind: 'comment', id: segments[2]! };
  }
  return null;
}

async function portfolioAttribution(
  db: Database,
  portfolioId: string,
): Promise<PortfolioRequestAttribution> {
  const [row] = await db
    .select({ ownerId: portfolios.userId, vaultId: portfolios.vaultId })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1);
  return row
    ? {
        recognized: true,
        portfolioId,
        ownerId: row.ownerId,
        vaultId: row.vaultId,
        nonPortfolio: false,
      }
    : MISSING;
}

/**
 * Resolve direct and child-resource request paths without reading content
 * columns. The result is intentionally global, not requester-owned: a shared
 * portfolio request is still residue belonging to the portfolio owner.
 */
export async function resolvePortfolioRequestAttribution(
  db: Database,
  path: string,
  explicitPortfolioId?: string | null,
): Promise<PortfolioRequestAttribution> {
  if (explicitPortfolioId && UUID_PATTERN.test(explicitPortfolioId)) {
    return portfolioAttribution(db, explicitPortfolioId);
  }

  const resource = resourceIdForPath(path);
  if (!resource) return UNRECOGNIZED;
  if (resource.kind === 'comment') {
    const [comment] = await db
      .select({ kind: itemComments.kind, subjectId: itemComments.subjectId })
      .from(itemComments)
      .where(eq(itemComments.id, resource.id))
      .limit(1);
    if (!comment) return MISSING;
    if (comment.kind !== 'portfolio') {
      return { ...MISSING, nonPortfolio: true };
    }
    return portfolioAttribution(db, comment.subjectId);
  }

  const [row] =
    resource.kind === 'import'
      ? await db
          .select({ portfolioId: importBatches.portfolioId })
          .from(importBatches)
          .where(eq(importBatches.id, resource.id))
          .limit(1)
      : resource.kind === 'standing-order'
        ? await db
            .select({ portfolioId: standingOrders.portfolioId })
            .from(standingOrders)
            .where(eq(standingOrders.id, resource.id))
            .limit(1)
        : resource.kind === 'cash-budget'
          ? await db
              .select({ portfolioId: cashBudgets.portfolioId })
              .from(cashBudgets)
              .where(eq(cashBudgets.id, resource.id))
              .limit(1)
          : await db
              .select({ portfolioId: portfolioCashMovements.portfolioId })
              .from(portfolioCashMovements)
              .where(eq(portfolioCashMovements.id, resource.id))
              .limit(1);
  return row ? portfolioAttribution(db, row.portfolioId) : MISSING;
}

/** Add an identity-only portfolio marker to a child-resource endpoint path. */
export function attributePortfolioRequestPath(path: string, portfolioId: string): string {
  if (pathSegments(path).some((segment) => segment.toLowerCase() === portfolioId.toLowerCase())) {
    return path;
  }
  return `${path.replace(/\/+$/, '')}/${PORTFOLIO_ATTRIBUTION_SEGMENT}/${portfolioId}`;
}

/** Remove the internal marker before comparing the public idempotency fingerprint. */
export function stripPortfolioRequestAttribution(path: string): string {
  return path.replace(new RegExp(`/${PORTFOLIO_ATTRIBUTION_SEGMENT}/[0-9a-f-]{36}$`, 'i'), '');
}
