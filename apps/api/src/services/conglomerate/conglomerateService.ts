import type {
  AllocateRequest,
  AllocateResponse,
  ConglomerateDetail,
  ConglomerateListResponse,
  ConglomerateResolvedResponse,
  ConglomerateSummary,
  CreateConglomerateRequest,
  ReplacePositionInput,
  UpdateConglomerateRequest,
} from '@bettertrack/contracts';

import type { AssetRepository } from '../../data/repositories/assetRepository';
import {
  ConglomerateNameConflictError,
  type ConglomerateDetailRow,
  type ConglomerateRepository,
  type ConglomerateSummaryRow,
} from '../../data/repositories/conglomerateRepository';
import {
  allocateBudget,
  AllocationError,
  type AllocationPositionInput,
  type AllocationResult,
} from '../../domain/allocation';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../../errors';
import type { MarketDataService } from '../../providers';
import type { CurrencyService } from '../currency/currencyService';
import type { AudienceService } from '../social/audienceService';
import {
  createsCycle,
  flattenConglomerate,
  longestChainLength,
  MAX_NESTING_DEPTH,
} from './nesting';

/**
 * Conglomerate orchestration + rule enforcement (PROJECTPLAN.md §6.5, §8).
 *
 * Ownership is enforced in the repository (every method is `owner_id`-scoped),
 * so a not-owned id surfaces here as a null/false result and this service maps
 * it to a **404** — never a 403, no IDOR (§8). The §6.5 model rules live here:
 * 1–50 positions, `0 < w ≤ 100` with ≤ 3 decimals, no duplicate assets, and
 * `active` requires Σ weights = 100 ± 0.01 (a `draft` may hold any sum).
 */

export interface ConglomerateServiceDeps {
  repo: ConglomerateRepository;
  /** Resolves a position's asset (owner-scoped) for its provider ref + native currency. */
  assetRepo: AssetRepository;
  /** Live quotes for the Invest Calculator (§6.7), cached/coalesced/serve-stale (§5.3). */
  marketData: MarketDataService;
  /** The single EUR-conversion keystone (§5.4); quotes are converted before the engine. */
  currencyService: CurrencyService;
  /** Sharing-enforcement layer — a deleted basket's audience row is cleared here (§13.3 V3-P5). */
  audience: AudienceService;
}

export interface ConglomerateService {
  list(ownerId: string): Promise<ConglomerateListResponse>;
  get(ownerId: string, id: string): Promise<ConglomerateDetail>;
  create(ownerId: string, input: CreateConglomerateRequest): Promise<ConglomerateDetail>;
  update(
    ownerId: string,
    id: string,
    patch: UpdateConglomerateRequest,
  ): Promise<ConglomerateDetail>;
  replacePositions(
    ownerId: string,
    id: string,
    positions: ReplacePositionInput[],
  ): Promise<ConglomerateDetail>;
  activate(ownerId: string, id: string): Promise<ConglomerateDetail>;
  remove(ownerId: string, id: string): Promise<void>;
  /**
   * The resolved (flattened) view of a possibly-nested conglomerate (V5-P6):
   * effective asset weights via the shared {@link flattenConglomerate}
   * resolution — the same function backtest and allocation consume.
   */
  resolved(ownerId: string, id: string): Promise<ConglomerateResolvedResponse>;
  /**
   * Turn a budget into a buy list over the Conglomerate's positions (§6.7).
   * The budget and every returned money figure are denominated in
   * `opts.baseCurrency` (the caller's per-user base, §5.4/V3-P10d; EUR when
   * omitted).
   */
  allocate(
    ownerId: string,
    id: string,
    req: AllocateRequest,
    opts?: { baseCurrency?: string },
  ): Promise<AllocateResponse>;
}

/** §6.5: at most 50 positions per Conglomerate. */
const MAX_POSITIONS = 50;
/** §6.5: an `active` Conglomerate's weights must sum to 100 within this tolerance. */
const SUM_TOLERANCE = 0.01;
const ACTIVE_SUM = 100;

const NOT_FOUND = () => notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');

function toSummary(row: ConglomerateSummaryRow): ConglomerateSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    visibility: row.visibility,
    positionCount: row.positionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: ConglomerateDetailRow): ConglomerateDetail {
  return {
    ...toSummary(row),
    positions: row.positions.map((p) =>
      p.kind === 'asset'
        ? {
            kind: 'asset' as const,
            assetId: p.assetId,
            weightPct: p.weightPct,
            sortOrder: p.sortOrder,
            asset: p.asset,
          }
        : {
            kind: 'conglomerate' as const,
            childId: p.childId,
            weightPct: p.weightPct,
            sortOrder: p.sortOrder,
            child: p.child,
          },
    ),
  };
}

export function createConglomerateService(deps: ConglomerateServiceDeps): ConglomerateService {
  const { repo, assetRepo, marketData, currencyService, audience } = deps;

  /** Fetch the detail after a mutation; the row must exist at this point. */
  async function detailOrThrow(ownerId: string, id: string): Promise<ConglomerateDetail> {
    const row = await repo.findByIdForOwner(ownerId, id);
    if (!row) throw NOT_FOUND();
    return toDetail(row);
  }

  /**
   * Validate a constituent set against the §6.5 model rules that zod can't
   * express: the ≤ 50 cap (defence-in-depth over the contract), no duplicate
   * asset and no duplicate child — the same constituent may not appear twice in
   * one basket. Every referenced asset must be *visible* to the owner (a global
   * asset or their own custom asset): a missing id — or another user's private
   * custom asset — is a 404, so nothing leaks and a bad id can't become an FK
   * 500 (§8, §10).
   *
   * The V5-P6 nesting rules run over the owner-local graph with this basket's
   * outgoing edges replaced by the proposed set:
   *  - only the caller's OWN conglomerates are nestable — a foreign/unknown id
   *    is a 404, indistinguishable from nonexistence (§8);
   *  - a cycle, direct (self) or transitive (A→B, B→A), is a hard reject;
   *  - a chain longer than {@link MAX_NESTING_DEPTH} conglomerates is rejected —
   *    including chains formed *through* this basket's ancestors.
   */
  async function validatePositions(
    ownerId: string,
    id: string,
    positions: readonly ReplacePositionInput[],
  ): Promise<void> {
    if (positions.length > MAX_POSITIONS) {
      throw badRequest(
        `A conglomerate may have at most ${MAX_POSITIONS} positions.`,
        'TOO_MANY_POSITIONS',
      );
    }

    const seenAssets = new Set<string>();
    const seenChildren = new Set<string>();
    for (const p of positions) {
      if ('assetId' in p) {
        if (seenAssets.has(p.assetId)) {
          throw badRequest('An asset may only appear once in a conglomerate.', 'DUPLICATE_ASSET');
        }
        seenAssets.add(p.assetId);
      } else {
        if (seenChildren.has(p.childId)) {
          throw badRequest(
            'A conglomerate may only appear once as a constituent.',
            'DUPLICATE_CHILD',
          );
        }
        seenChildren.add(p.childId);
      }
    }

    if (seenAssets.size > 0) {
      const visible = await repo.visibleAssetIds(ownerId, [...seenAssets]);
      for (const assetId of seenAssets) {
        if (!visible.has(assetId)) {
          throw notFound('One or more assets do not exist.', 'ASSET_NOT_FOUND');
        }
      }
    }

    if (seenChildren.size > 0) {
      if (seenChildren.has(id)) {
        throw badRequest('A conglomerate cannot contain itself.', 'NESTING_CYCLE');
      }
      const owned = await repo.ownedConglomerateIds(ownerId, [...seenChildren]);
      for (const childId of seenChildren) {
        if (!owned.has(childId)) throw NOT_FOUND();
      }

      const existing = await repo.nestingEdges(ownerId);
      const edges = existing
        .filter((e) => e.parentId !== id)
        .concat([...seenChildren].map((childId) => ({ parentId: id, childId })));
      if (createsCycle(edges, id)) {
        throw badRequest(
          'Nesting these conglomerates would create a cycle — a conglomerate cannot contain itself, directly or through another conglomerate.',
          'NESTING_CYCLE',
        );
      }
      if (longestChainLength(edges) > MAX_NESTING_DEPTH) {
        throw badRequest(
          `Conglomerates can be nested at most ${MAX_NESTING_DEPTH} levels deep.`,
          'NESTING_TOO_DEEP',
        );
      }
    }
  }

  return {
    async list(ownerId) {
      const rows = await repo.listForOwner(ownerId);
      return { conglomerates: rows.map(toSummary) };
    },

    async get(ownerId, id) {
      const row = await repo.findByIdForOwner(ownerId, id);
      if (!row) throw NOT_FOUND();
      return toDetail(row);
    },

    async create(ownerId, input) {
      let id: string;
      try {
        id = await repo.create(ownerId, {
          name: input.name,
          description: input.description ?? null,
        });
      } catch (err) {
        if (err instanceof ConglomerateNameConflictError) {
          throw conflict(
            'A conglomerate with this name already exists.',
            'CONGLOMERATE_NAME_TAKEN',
          );
        }
        throw err;
      }
      return detailOrThrow(ownerId, id);
    },

    async update(ownerId, id, patch) {
      let updated: boolean;
      try {
        updated = await repo.update(ownerId, id, patch);
      } catch (err) {
        if (err instanceof ConglomerateNameConflictError) {
          throw conflict(
            'A conglomerate with this name already exists.',
            'CONGLOMERATE_NAME_TAKEN',
          );
        }
        throw err;
      }
      if (!updated) throw NOT_FOUND();
      return detailOrThrow(ownerId, id);
    },

    async replacePositions(ownerId, id, positions) {
      await validatePositions(ownerId, id, positions);
      const ok = await repo.replacePositions(
        ownerId,
        id,
        positions.map((p) =>
          'assetId' in p
            ? { kind: 'asset' as const, assetId: p.assetId, weightPct: p.weightPct }
            : { kind: 'conglomerate' as const, childId: p.childId, weightPct: p.weightPct },
        ),
      );
      if (!ok) throw NOT_FOUND();
      return detailOrThrow(ownerId, id);
    },

    async activate(ownerId, id) {
      const row = await repo.findByIdForOwner(ownerId, id);
      if (!row) throw NOT_FOUND();

      if (row.positions.length < 1) {
        throw badRequest(
          'A conglomerate needs at least one position to activate.',
          'ACTIVATION_INVALID',
        );
      }
      const sum = row.positions.reduce((acc, p) => acc + p.weightPct, 0);
      if (Math.abs(sum - ACTIVE_SUM) > SUM_TOLERANCE) {
        throw badRequest(
          'Weights must sum to 100% (±0.01) before a conglomerate can be activated.',
          'ACTIVATION_INVALID',
        );
      }

      const ok = await repo.setStatus(ownerId, id, 'active');
      if (!ok) throw NOT_FOUND();
      return detailOrThrow(ownerId, id);
    },

    async remove(ownerId, id) {
      // Deleting a conglomerate still embedded in another is blocked with the
      // parent names — fail-safe, no silent detach (V5-P6). A concurrent nest
      // added between this check and the delete is backstopped by the child
      // FK's NO ACTION. `parentsOf` is owner-scoped, so a foreign id yields []
      // here and 404s below — no existence leak.
      const parents = await repo.parentsOf(ownerId, id);
      if (parents.length > 0) {
        const names = parents.map((p) => p.name).join(', ');
        throw new ApiError(
          409,
          'CONGLOMERATE_IN_USE',
          `This conglomerate is a constituent of ${names} — remove it there first.`,
          { parents },
        );
      }
      const deleted = await repo.delete(ownerId, id);
      if (!deleted) throw NOT_FOUND();
      // Drop the audience row for this now-deleted basket (polymorphic subject,
      // no cascade). Hygiene only — the enforcement joins already exclude it.
      await audience.clearForSubject('conglomerate', id);
    },

    async resolved(ownerId, id) {
      const flat = await flattenConglomerate((cid) => repo.findByIdForOwner(ownerId, cid), id);
      if (!flat) throw NOT_FOUND();
      return {
        conglomerateId: id,
        nested: flat.nested,
        positions: flat.positions.map((p) => ({
          assetId: p.assetId,
          weightPct: p.weightPct,
          asset: p.asset,
        })),
      };
    },

    /**
     * Invest Calculator (§6.7): fetch a current EUR-converted quote per position
     * and hand the basket to the pure {@link allocateBudget} engine. The
     * orchestration seam does all the I/O and FX — the domain does neither:
     *
     *  1. Load the Conglomerate owner-scoped — a foreign/unknown id is a 404,
     *     never a 403 (no IDOR, §8).
     *  2. For each position, resolve its asset (owner-scoped) for the provider
     *     ref + native currency, fetch a quote through the market-data keystone
     *     (§5.3), and convert it to EUR through the {@link CurrencyService} (§5.4)
     *     **before** the engine sees any price. A quote served stale is surfaced
     *     as a response flag, never an error; a quote that is wholly unavailable
     *     is a 422 (the position cannot be priced).
     *  3. Normalise the stored percent weights to fractions summing to ~1 — by
     *     the basket's own weight sum, so both an active (Σ=100) and a draft
     *     basket allocate proportionally; the engine re-normalises to exactly 1.
     *  4. Run the engine and shape its result to the wire contract; an
     *     {@link AllocationError} (e.g. a non-positive quote) becomes a 422.
     */
    async allocate(ownerId, id, req, opts) {
      const fx =
        opts?.baseCurrency === undefined
          ? currencyService
          : currencyService.withBase(opts.baseCurrency);
      // Flatten first (V5-P6): a nested conglomerate allocates over its
      // effective asset weights — the same shared resolution backtest uses.
      // For a flat basket this is its own weights normalized by their sum, so
      // both an active (Σ=100) and a draft basket allocate proportionally,
      // exactly as before.
      const flat = await flattenConglomerate((cid) => repo.findByIdForOwner(ownerId, cid), id);
      if (!flat) throw NOT_FOUND();
      if (flat.positions.length === 0) {
        throw badRequest(
          'This conglomerate has no positions to allocate a budget over.',
          'ALLOCATION_NO_POSITIONS',
        );
      }

      let anyStale = false;
      const nameByAssetId = new Map<string, string>();
      // Native (own-currency) price per asset — a transaction's `price` is
      // recorded in the asset's native currency (`domain/holdings.ts`), so the
      // bulk buy-flow prefill must carry this, not the EUR-converted costEur.
      const nativeByAssetId = new Map<string, { price: number; currency: string }>();
      const positions: AllocationPositionInput[] = [];
      for (const pos of flat.positions) {
        // The embedded position asset carries neither the provider ref nor is a
        // full row, so re-resolve owner-scoped (a vanished/foreign asset 404s —
        // nothing leaks, §10 — though positions are validated on write).
        const asset = await assetRepo.findByIdForUser(pos.assetId, ownerId);
        if (!asset) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
        nameByAssetId.set(pos.assetId, asset.name);

        let priceEur: number;
        try {
          const cached = await marketData.getQuote({
            providerId: asset.providerId,
            providerRef: asset.providerRef,
          });
          if (cached.stale) anyStale = true;
          nativeByAssetId.set(pos.assetId, {
            price: cached.value.price,
            currency: asset.currency,
          });
          // Convert into the caller's base here, before the pure engine — the
          // domain does no FX (§5.4); the budget is interpreted in the same base.
          priceEur = await fx.toBase(cached.value.price, asset.currency);
        } catch {
          throw unprocessable(`No current quote available for ${asset.symbol}.`, 'NO_QUOTE');
        }

        positions.push({
          assetId: pos.assetId,
          symbol: asset.symbol,
          // The flatten already normalized the vector to Σ=100.
          weight: pos.weightPct / 100,
          priceEur,
        });
      }

      let result: AllocationResult;
      try {
        result = allocateBudget({
          budgetEur: req.budgetEur,
          mode: req.mode,
          step: req.step,
          atLeastOneShare: req.atLeastOneShare,
          positions,
        });
      } catch (err) {
        if (err instanceof AllocationError) {
          throw unprocessable(err.message, 'ALLOCATION_INVALID');
        }
        throw err;
      }

      return {
        positions: result.positions.map((line) => {
          // Every input position was resolved and quoted above before the
          // engine ran, so its native price/currency is always present here.
          const native = nativeByAssetId.get(line.assetId)!;
          const row: AllocateResponse['positions'][number] = {
            assetId: line.assetId,
            symbol: line.symbol,
            name: nameByAssetId.get(line.assetId) ?? line.symbol,
            qty: line.qty,
            costEur: line.costEur,
            nativePrice: native.price,
            currency: native.currency,
            actualPct: line.actualPct,
            targetPct: line.targetPct,
            deltaPp: line.deltaPp,
          };
          if (line.unbuyable) row.unbuyable = true;
          if (line.note !== undefined) row.note = line.note;
          return row;
        }),
        totalCostEur: result.totalCostEur,
        leftoverEur: result.leftoverEur,
        warnings: result.warnings,
        stale: anyStale,
        quoteNotice: anyStale
          ? 'Some quotes are stale (market closed or the data provider is unreachable); showing the last known prices.'
          : null,
        baseCurrency: fx.baseCurrency,
      };
    },
  };
}
