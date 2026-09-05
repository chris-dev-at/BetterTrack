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
  type NestingEdgeRow,
} from '../../data/repositories/conglomerateRepository';
import {
  allocateBudget,
  AllocationError,
  type AllocationPositionInput,
  type AllocationResult,
} from '../../domain/allocation';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../../errors';
import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
import type { CurrencyService } from '../currency/currencyService';
import type { AudienceService } from '../social/audienceService';
import {
  createFlattenCache,
  createsCycle,
  flattenConglomerate,
  longestChainLength,
  mapFlattened,
  MAX_NESTING_DEPTH,
  type FlattenCache,
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
  /**
   * Scopes the otherwise-kept basket surfaces to GLOBAL market assets while the
   * caller is paranoid. A conglomerate is private local structure, but a
   * constituent may be the account's OWN custom asset — killed content — so
   * every read/write that would surface or price one is scoped here.
   */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowedWithOptional'>;
  /** Resolves a position's asset (owner-scoped) for its provider ref + native currency. */
  assetRepo: AssetRepository;
  /** Live quotes for the Invest Calculator (§6.7), cached/coalesced/serve-stale (§5.3). */
  marketData: MarketDataService;
  /** The single EUR-conversion keystone (§5.4); quotes are converted before the engine. */
  currencyService: CurrencyService;
  /** Sharing-enforcement layer — a deleted basket's audience row is cleared here (§13.3 V3-P5). */
  audience: AudienceService;
  /**
   * Where post-commit bookkeeping that failed is reported. The activation
   * revalidation runs AFTER its write committed and is therefore total: a
   * failure there is logged here, never turned into a response (#1776).
   */
  logger?: Logger;
}

type ConglomerateMetadataPatch = Omit<UpdateConglomerateRequest, 'visibility' | 'confirmWiden'>;

export interface ConglomerateService {
  list(ownerId: string): Promise<ConglomerateListResponse>;
  get(ownerId: string, id: string): Promise<ConglomerateDetail>;
  create(ownerId: string, input: CreateConglomerateRequest): Promise<ConglomerateDetail>;
  update(
    ownerId: string,
    id: string,
    patch: ConglomerateMetadataPatch,
  ): Promise<ConglomerateDetail>;
  /** Mixed metadata + legacy sharing mutation, guarded before either write. */
  updateWithVisibility(
    ownerId: string,
    id: string,
    patch: UpdateConglomerateRequest & { visibility: 'private' | 'friends' },
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
  /**
   * Identity only: the ids of the owner's baskets that hold `assetId` as a
   * direct constituent. Resolved BEFORE an asset is deleted, because
   * `conglomerate_positions.asset_id` cascades — after the delete there is
   * nothing left to find (#1776).
   */
  basketsHoldingAsset(ownerId: string, assetId: string): Promise<string[]>;
  /**
   * Post-delete bookkeeping for {@link basketsHoldingAsset}: re-run the §6.5
   * activation gate over those baskets and every ancestor of them, demoting
   * whatever no longer earns `active`. §6.8.5 keeps a custom-asset delete a
   * hard delete, so the baskets it empties are relabelled rather than kept
   * claiming a status they no longer earn.
   *
   * TOTAL — the delete has already committed, so this never throws.
   */
  revalidateAfterAssetRemoval(ownerId: string, basketIds: readonly string[]): Promise<void>;
}

/** §6.5: at most 50 positions per Conglomerate. */
const MAX_POSITIONS = 50;
/** §6.5: an `active` Conglomerate's weights must sum to 100 within this tolerance. */
const SUM_TOLERANCE = 0.01;
const ACTIVE_SUM = 100;

const NOT_FOUND = () => notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');

/**
 * The V5-P6 graph rules over the owner-local nesting graph with `id`'s outgoing
 * edges replaced by `childIds`: no cycle (direct or transitive) and no chain
 * longer than {@link MAX_NESTING_DEPTH}. Pure — the caller supplies the edge
 * set — so the exact same check runs twice against two different snapshots: once
 * up front on the service's read, and once again inside the write transaction
 * (`replacePositions`' `verifyNesting`) where a concurrent writer's committed
 * edges are visible. Throwing there rolls the write back.
 */
function assertNestingRules(
  id: string,
  childIds: ReadonlySet<string>,
  existingEdges: readonly NestingEdgeRow[],
): void {
  const edges = existingEdges
    .filter((e) => e.parentId !== id)
    .concat([...childIds].map((childId) => ({ parentId: id, childId })));
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

  /**
   * Run `action` with the asset provenance this caller may see, holding their
   * transition lock for the whole call. Baskets built purely from global market
   * assets stay fully usable in paranoid mode; anything touching the account's
   * own custom assets is scoped out under the same lock, so a transition can
   * never commit between the decision and response construction.
   */
  function withVisibleAssetScope<T>(
    ownerId: string,
    action: (includeCustomAssets: boolean) => Promise<T>,
  ): Promise<T> {
    if (!deps.paranoid) return action(true);
    return deps.paranoid.runAllowedWithOptional([], [ownerId], 'portfolioServer', (normalUserIds) =>
      action(normalUserIds.has(ownerId)),
    );
  }

  /**
   * The owner's conglomerates that resolve — directly or through nesting — to
   * at least one of their own custom assets. In paranoid mode those baskets are
   * not server-side readable: `list` omits them and every other branch returns
   * the established opaque 404, exactly as if the id did not exist (§8, §10).
   */
  async function customAssetTaintedIds(ownerId: string): Promise<ReadonlySet<string>> {
    const tainted = new Set(await repo.ownedAssetConglomerateIds(ownerId));
    if (tainted.size === 0) return tainted;
    // Propagate up the owner-local nesting graph: a parent that embeds a
    // tainted child resolves to that custom asset too. Bounded by the graph
    // size — each pass can only add ids, so it converges.
    const edges = await repo.nestingEdges(ownerId);
    for (let changed = true; changed; ) {
      changed = false;
      for (const edge of edges) {
        if (tainted.has(edge.childId) && !tainted.has(edge.parentId)) {
          tainted.add(edge.parentId);
          changed = true;
        }
      }
    }
    return tainted;
  }

  /** 404 a basket that resolves to a custom asset while the caller is scoped out. */
  async function assertReadable(
    ownerId: string,
    id: string,
    includeCustomAssets: boolean,
  ): Promise<void> {
    if (includeCustomAssets) return;
    if ((await customAssetTaintedIds(ownerId)).has(id)) throw NOT_FOUND();
  }

  /** Fetch the detail after a mutation; the row must exist at this point. */
  async function detailOrThrow(
    ownerId: string,
    id: string,
    includeCustomAssets = true,
  ): Promise<ConglomerateDetail> {
    const row = await repo.findByIdForOwner(ownerId, id, {
      globalAssetMetadataOnly: !includeCustomAssets,
    });
    if (!row) throw NOT_FOUND();
    return toDetail(row);
  }

  async function updateRecord(
    ownerId: string,
    id: string,
    patch: UpdateConglomerateRequest,
    includeCustomAssets = true,
  ): Promise<ConglomerateDetail> {
    let updated: boolean;
    try {
      updated = await repo.update(ownerId, id, patch);
    } catch (err) {
      if (err instanceof ConglomerateNameConflictError) {
        throw conflict('A conglomerate with this name already exists.', 'CONGLOMERATE_NAME_TAKEN');
      }
      throw err;
    }
    if (!updated) throw NOT_FOUND();
    return detailOrThrow(ownerId, id, includeCustomAssets);
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
    includeCustomAssets = true,
  ): Promise<ReadonlySet<string>> {
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
      const visible = await repo.visibleAssetIds(ownerId, [...seenAssets], {
        includeCustomAssets,
      });
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

      assertNestingRules(id, seenChildren, await repo.nestingEdges(ownerId));
    }

    return seenChildren;
  }

  /**
   * The NESTED half of the activation gate (§6.5 + V5-P6): the reason this
   * position set may not carry an `active` status, or `null` when every nested
   * slice still resolves to assets.
   *
   * A nested constituent counts toward the 100 %, so a child that resolves to NO
   * asset would let a basket activate whose weights add up on paper while its
   * slice buys nothing: at flatten time the empty child is dropped and its weight
   * is silently redistributed onto the survivors (a 60/40 basket buys 100 % of
   * the 60 % leg). Extracted from {@link activateScoped} so the exact same rule
   * can be re-run later — the gate is point-in-time, but the condition it checks
   * belongs to a child the parent does not control (see
   * {@link revalidateAncestorActivation}).
   */
  async function nestedActivationFailure(
    ownerId: string,
    positions: readonly ConglomerateDetailRow['positions'][number][],
    includeCustomAssets: boolean,
    cache?: FlattenCache,
  ): Promise<string | null> {
    for (const position of positions) {
      if (position.kind !== 'conglomerate') continue;
      const child = await flattenConglomerate(
        (cid) =>
          repo.findByIdForOwner(ownerId, cid, { globalAssetMetadataOnly: !includeCustomAssets }),
        position.childId,
        // One cache for the whole sweep when the caller supplies it: without it
        // each child got a fresh one, so a diamond grandchild was re-loaded once
        // per branch and again for every ancestor above (#1776).
        cache ? { cache } : undefined,
      );
      if (!child || child.positions.length === 0) {
        return `Nested conglomerate ${position.child.name} resolves to no assets — give it positions or remove it before activating.`;
      }
      if (child.unresolvedPct > 0) {
        return `Nested conglomerate ${position.child.name} contains a conglomerate that resolves to no assets — give it positions or remove it before activating.`;
      }
    }
    return null;
  }

  /**
   * Re-run the nested activation gate over every ANCESTOR of the seed baskets —
   * and over the seeds themselves when `checkSeeds` is set — demoting to `draft`
   * whatever no longer passes it (#1755, #1776).
   *
   * The gate is enforced when a basket is activated, but what it checks — that
   * each nested slice resolves to at least one asset — is a property of baskets
   * the parent does not own the edits to. Emptying a child left every parent
   * `active` while its resolved view, its backtest and every comparison silently
   * renormalized the child's slice onto the survivors, disagreeing with the
   * Invest Calculator on the same screen, which correctly withholds it. The
   * parent is therefore relabelled instead of left claiming a status it no
   * longer earns; re-activating it after fixing (or removing) the child is the
   * normal `POST /:id/activate` and re-runs the same gate.
   *
   * Two seeds, two callers:
   *  - a `PUT /:id/positions` seeds the edited basket, ancestors only — the
   *    sum-to-100 half of the gate belongs to that basket's own weights and is
   *    deliberately left alone;
   *  - a custom-asset delete seeds every basket that held it and checks those
   *    too, because the cascade can empty one outright (§6.8.5, #1776).
   *
   * **TOTAL: it never throws.** It runs AFTER its write committed, so a failure
   * here — a flatten that refuses a structure it cannot resolve, or a
   * repository error — must be reported, not returned: reporting it turned a
   * durable save into a 4xx the Builder retried forever. Whatever cannot be
   * revalidated is demoted (a basket whose own resolved view is an error does
   * not earn `active`) and logged.
   *
   * The walk is bounded by {@link MAX_NESTING_DEPTH} (the longest chain the
   * write-time rules admit) and by a visited set, so a structure that slipped a
   * cycle past those rules still terminates. Every basket read — ancestor rows
   * and the flattens' own child loads alike — goes through ONE cache, so the
   * whole sweep loads each basket in the closure exactly once.
   */
  async function revalidateActivation(
    ownerId: string,
    seedIds: readonly string[],
    includeCustomAssets: boolean,
    options?: { checkSeeds?: boolean },
  ): Promise<void> {
    const cache = createFlattenCache();
    const loadCached = (id: string): Promise<ConglomerateDetailRow | null> => {
      const inFlight = cache.get(id);
      if (inFlight) return inFlight;
      const pending = repo.findByIdForOwner(ownerId, id, {
        globalAssetMetadataOnly: !includeCustomAssets,
      });
      cache.set(id, pending);
      return pending;
    };

    /** Why `row` may no longer carry `active`, or null. Never throws. */
    const activationFailure = async (row: ConglomerateDetailRow): Promise<string | null> => {
      // §6.5 "≥ 1 to activate": a basket the cascade emptied resolves to no
      // asset at all — 100 % unresolved, the state #1755 ruled invalid.
      if (row.positions.length === 0) return 'it has no positions left';
      try {
        return await nestedActivationFailure(ownerId, row.positions, includeCustomAssets, cache);
      } catch (err) {
        deps.logger?.warn(
          { err, ownerId, conglomerateId: row.id },
          'conglomerate activation revalidation could not resolve the nesting — demoting to draft',
        );
        return 'its nesting no longer resolves';
      }
    };

    const check = async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        const row = await loadCached(id);
        // A cached row keeps the status it was read with, but `visited` gives
        // every basket exactly one check, so no decision is ever made twice.
        if (!row || row.status !== 'active') continue;
        if ((await activationFailure(row)) === null) continue;
        await repo.setStatus(ownerId, id, 'draft');
      }
    };

    try {
      const visited = new Set<string>();
      let frontier: string[] = [];
      for (const id of seedIds) {
        if (visited.has(id)) continue;
        visited.add(id);
        frontier.push(id);
      }
      if (options?.checkSeeds) await check(frontier);
      for (let level = 0; level < MAX_NESTING_DEPTH && frontier.length > 0; level += 1) {
        const parents: string[] = [];
        for (const id of frontier) {
          for (const parent of await repo.parentsOf(ownerId, id)) {
            if (visited.has(parent.id)) continue;
            visited.add(parent.id);
            parents.push(parent.id);
          }
        }
        await check(parents);
        frontier = parents;
      }
    } catch (err) {
      deps.logger?.error(
        { err, ownerId, seedIds: [...seedIds] },
        'conglomerate activation revalidation failed after a committed write',
      );
    }
  }

  async function activateScoped(
    ownerId: string,
    id: string,
    includeCustomAssets: boolean,
  ): Promise<ConglomerateDetail> {
    await assertReadable(ownerId, id, includeCustomAssets);
    const row = await repo.findByIdForOwner(ownerId, id, {
      globalAssetMetadataOnly: !includeCustomAssets,
    });
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

    const nestedFailure = await nestedActivationFailure(
      ownerId,
      row.positions,
      includeCustomAssets,
    );
    if (nestedFailure !== null) throw badRequest(nestedFailure, 'ACTIVATION_INVALID');

    const ok = await repo.setStatus(ownerId, id, 'active');
    if (!ok) throw NOT_FOUND();
    return detailOrThrow(ownerId, id, includeCustomAssets);
  }

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
   *     A nested constituent that resolves to no asset keeps its slice OUT of
   *     the budget instead of donating it to the survivors (see below).
   *  4. Run the engine and shape its result to the wire contract; an
   *     {@link AllocationError} (e.g. a non-positive quote) becomes a 422.
   *
   * Scoped: a paranoid caller never reaches step 2 for one of their own custom
   * assets — the basket 404s at step 1, so no manual valuation is ever quoted
   * or run through the allocation engine server-side.
   */
  async function allocateScoped(
    ownerId: string,
    id: string,
    req: AllocateRequest,
    opts: { baseCurrency?: string } | undefined,
    includeCustomAssets: boolean,
  ): Promise<AllocateResponse> {
    await assertReadable(ownerId, id, includeCustomAssets);
    const fx =
      opts?.baseCurrency === undefined
        ? currencyService
        : currencyService.withBase(opts.baseCurrency);
    // Flatten first (V5-P6): a nested conglomerate allocates over its
    // effective asset weights — the same shared resolution backtest uses.
    // For a flat basket this is its own weights normalized by their sum, so
    // both an active (Σ=100) and a draft basket allocate proportionally,
    // exactly as before.
    const flat = await flattenConglomerate(
      (cid) =>
        repo.findByIdForOwner(ownerId, cid, { globalAssetMetadataOnly: !includeCustomAssets }),
      id,
    );
    if (!flat) throw NOT_FOUND();
    if (flat.positions.length === 0) {
      throw badRequest(
        'This conglomerate has no positions to allocate a budget over.',
        'ALLOCATION_NO_POSITIONS',
      );
    }

    // One row read + quote + FX per resolved asset, through a small pool rather
    // than a sequential round trip each: nesting lifted the effective per-request
    // asset count well past the 50-position per-basket cap.
    //
    // In TWO phases, like the backtest basket load: every asset is authorized
    // first (database only), and only then is a single quote fetched. Fanned out
    // in one phase, a request that ends in a 404 would still have sent provider
    // traffic for the assets that happened to resolve — so the refusal comes
    // before any market-data call, whatever the scheduling.
    const rows = await mapFlattened(flat.positions, async (pos) => {
      // The embedded position asset carries neither the provider ref nor is a
      // full row, so re-resolve owner-scoped (a vanished/foreign asset 404s —
      // nothing leaks, §10 — though positions are validated on write). The
      // global-only lookup keeps a scoped-out custom asset indistinguishable.
      const asset = await assetRepo.findByIdForUser(pos.assetId, ownerId, {
        includeCustomAssets,
      });
      if (!asset) throw notFound('Asset not found.', 'ASSET_NOT_FOUND');
      return { pos, asset };
    });

    const priced = await mapFlattened(rows, async ({ pos, asset }) => {
      try {
        const cached = await marketData.getQuote({
          providerId: asset.providerId,
          providerRef: asset.providerRef,
        });
        return {
          assetId: pos.assetId,
          weightPct: pos.weightPct,
          name: asset.name,
          symbol: asset.symbol,
          stale: cached.stale,
          // Native (own-currency) price per asset — a transaction's `price` is
          // recorded in the asset's native currency (`domain/holdings.ts`), so
          // the bulk buy-flow prefill must carry this, not the converted cost.
          native: { price: cached.value.price, currency: asset.currency },
          // Convert into the caller's base here, before the pure engine — the
          // domain does no FX (§5.4); the budget is in the same base.
          priceEur: await fx.toBase(cached.value.price, asset.currency),
        };
      } catch {
        throw unprocessable(`No current quote available for ${asset.symbol}.`, 'NO_QUOTE');
      }
    });

    const anyStale = priced.some((p) => p.stale);
    const nameByAssetId = new Map(priced.map((p) => [p.assetId, p.name]));
    const nativeByAssetId = new Map(priced.map((p) => [p.assetId, p.native]));
    const positions: AllocationPositionInput[] = priced.map((p) => ({
      assetId: p.assetId,
      symbol: p.symbol,
      // The flatten already normalized the vector to Σ=100 over what resolved.
      weight: p.weightPct / 100,
      priceEur: p.priceEur,
    }));

    // A nested constituent that resolves to no asset is NOT free money for the
    // rest of the basket: the flatten normalizes the survivors to 100, so
    // spending the whole budget over them would buy the empty child's slice as
    // extra shares of everything else (a 60/40 basket with an empty 40 % child
    // would buy 100 % of the 60 % leg). Only the resolved share of the budget is
    // handed to the engine; the rest stays unallocated and is reported as such.
    const withheldEur = req.budgetEur * (flat.unresolvedPct / 100);
    const allocatableEur = req.budgetEur - withheldEur;

    let result: AllocationResult;
    try {
      result = allocateBudget({
        budgetEur: allocatableEur,
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
      // `totalCostEur + leftoverEur === budgetEur` still holds: the withheld
      // slice is part of the leftover, not money that vanished.
      leftoverEur: result.leftoverEur + withheldEur,
      warnings:
        withheldEur > 0
          ? [
              ...result.warnings,
              `${withheldEur.toFixed(2)} ${fx.baseCurrency} is left unallocated: ${flat.unresolvedPct.toFixed(2)} % of this conglomerate is a nested conglomerate with no assets in it.`,
            ]
          : result.warnings,
      stale: anyStale,
      quoteNotice: anyStale
        ? 'Some quotes are stale (market closed or the data provider is unreachable); showing the last known prices.'
        : null,
      baseCurrency: fx.baseCurrency,
    };
  }

  return {
    async list(ownerId) {
      return withVisibleAssetScope(ownerId, async (includeCustomAssets) => {
        const rows = await repo.listForOwner(ownerId);
        if (includeCustomAssets) return { conglomerates: rows.map(toSummary) };
        const tainted = await customAssetTaintedIds(ownerId);
        return { conglomerates: rows.filter((row) => !tainted.has(row.id)).map(toSummary) };
      });
    },

    async get(ownerId, id) {
      return withVisibleAssetScope(ownerId, async (includeCustomAssets) => {
        await assertReadable(ownerId, id, includeCustomAssets);
        const row = await repo.findByIdForOwner(ownerId, id, {
          globalAssetMetadataOnly: !includeCustomAssets,
        });
        if (!row) throw NOT_FOUND();
        return toDetail(row);
      });
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
      // Private local metadata stays usable in paranoid mode. A hand-crafted
      // below-HTTP call must not smuggle the sharing-bearing legacy visibility
      // field through this deliberately kept entry point.
      if ('visibility' in patch) {
        throw badRequest(
          'Visibility changes require the guarded sharing mutation.',
          'CONGLOMERATE_VISIBILITY_GUARD_REQUIRED',
        );
      }
      return withVisibleAssetScope(ownerId, async (includeCustomAssets) => {
        await assertReadable(ownerId, id, includeCustomAssets);
        return updateRecord(ownerId, id, patch, includeCustomAssets);
      });
    },

    async updateWithVisibility(ownerId, id, patch) {
      return audience.withVisibilityMutation(
        ownerId,
        'conglomerate',
        id,
        patch.visibility,
        patch.confirmWiden,
        async (lockedRecipientIds) => {
          const detail = await updateRecord(ownerId, id, patch);
          await audience.applyVisibility(
            ownerId,
            'conglomerate',
            id,
            patch.visibility,
            patch.confirmWiden,
            lockedRecipientIds,
          );
          return detail;
        },
      );
    },

    async replacePositions(ownerId, id, positions) {
      return withVisibleAssetScope(ownerId, async (includeCustomAssets) => {
        await assertReadable(ownerId, id, includeCustomAssets);
        const childIds = await validatePositions(ownerId, id, positions, includeCustomAssets);
        const ok = await repo.replacePositions(
          ownerId,
          id,
          positions.map((p) =>
            'assetId' in p
              ? { kind: 'asset' as const, assetId: p.assetId, weightPct: p.weightPct }
              : { kind: 'conglomerate' as const, childId: p.childId, weightPct: p.weightPct },
          ),
          // Re-run the graph rules against the edge set as it stands INSIDE the
          // write transaction: a racing write that committed since the check
          // above is visible there, so two concurrent writes can never persist a
          // cycle between them. Only a set that nests something can create one,
          // so a plain asset write takes no lock at all.
          childIds.size > 0
            ? { verifyNesting: (edges) => assertNestingRules(id, childIds, edges) }
            : undefined,
        );
        if (!ok) throw NOT_FOUND();
        // What this basket resolves to just changed, and an ANCESTOR's `active`
        // status was granted against the old answer (#1755). Bookkeeping only,
        // and the write above is already durable — so this is total and cannot
        // turn a saved draft into the Builder's "save failed" (#1776).
        await revalidateActivation(ownerId, [id], includeCustomAssets);
        return detailOrThrow(ownerId, id, includeCustomAssets);
      });
    },

    async activate(ownerId, id) {
      return withVisibleAssetScope(ownerId, (includeCustomAssets) =>
        activateScoped(ownerId, id, includeCustomAssets),
      );
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
      return withVisibleAssetScope(ownerId, async (includeCustomAssets) => {
        await assertReadable(ownerId, id, includeCustomAssets);
        const flat = await flattenConglomerate(
          (cid) =>
            repo.findByIdForOwner(ownerId, cid, {
              globalAssetMetadataOnly: !includeCustomAssets,
            }),
          id,
        );
        if (!flat) throw NOT_FOUND();
        return {
          conglomerateId: id,
          nested: flat.nested,
          positions: flat.positions.map((p) => ({
            assetId: p.assetId,
            weightPct: p.weightPct,
            asset: p.asset,
          })),
          // The share an empty nested child left behind. Withheld by the money
          // path since V5-P6 and dropped by every read path until #1755 — so the
          // donut on the detail page showed a fully-invested basket while the
          // calculator on the same screen refused to spend part of the budget.
          unresolvedPct: flat.unresolvedPct,
        };
      });
    },

    async allocate(ownerId, id, req, opts) {
      return withVisibleAssetScope(ownerId, (includeCustomAssets) =>
        allocateScoped(ownerId, id, req, opts, includeCustomAssets),
      );
    },

    async basketsHoldingAsset(ownerId, assetId) {
      return repo.conglomerateIdsHoldingAsset(ownerId, assetId);
    },

    async revalidateAfterAssetRemoval(ownerId, basketIds) {
      if (basketIds.length === 0) return;
      try {
        // The seeds are checked too, not just their ancestors: the delete may
        // have removed a basket's LAST constituent, and an empty basket cannot
        // keep claiming `active` any more than a parent of one can (§6.5,
        // §6.8.5). The sweep itself is total; only acquiring the scope is left,
        // and the asset is already gone, so that is reported too.
        await withVisibleAssetScope(ownerId, (includeCustomAssets) =>
          revalidateActivation(ownerId, basketIds, includeCustomAssets, { checkSeeds: true }),
        );
      } catch (err) {
        deps.logger?.error(
          { err, ownerId, conglomerateIds: [...basketIds] },
          'conglomerate activation revalidation could not run after an asset removal',
        );
      }
    },
  };
}
