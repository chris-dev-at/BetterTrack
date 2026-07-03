import type {
  ConglomerateDetail,
  ConglomerateListResponse,
  ConglomerateSummary,
  CreateConglomerateRequest,
  ReplacePositionInput,
  UpdateConglomerateRequest,
} from '@bettertrack/contracts';

import {
  ConglomerateNameConflictError,
  type ConglomerateDetailRow,
  type ConglomerateRepository,
  type ConglomerateSummaryRow,
} from '../../data/repositories/conglomerateRepository';
import { badRequest, conflict, notFound } from '../../errors';

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
    positionCount: row.positionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: ConglomerateDetailRow): ConglomerateDetail {
  return {
    ...toSummary(row),
    positions: row.positions.map((p) => ({
      assetId: p.assetId,
      weightPct: p.weightPct,
      sortOrder: p.sortOrder,
      asset: p.asset,
    })),
  };
}

export function createConglomerateService(deps: ConglomerateServiceDeps): ConglomerateService {
  const { repo } = deps;

  /** Fetch the detail after a mutation; the row must exist at this point. */
  async function detailOrThrow(ownerId: string, id: string): Promise<ConglomerateDetail> {
    const row = await repo.findByIdForOwner(ownerId, id);
    if (!row) throw NOT_FOUND();
    return toDetail(row);
  }

  /**
   * Validate a position set against the §6.5 model rules that zod can't express:
   * the ≤ 50 cap (defence-in-depth over the contract), and no duplicate asset —
   * the same asset may not appear twice in one basket. Also confirm every
   * referenced asset exists, so a bad id is a clean 400 rather than an FK 500.
   */
  async function validatePositions(positions: readonly ReplacePositionInput[]): Promise<void> {
    if (positions.length > MAX_POSITIONS) {
      throw badRequest(
        `A conglomerate may have at most ${MAX_POSITIONS} positions.`,
        'TOO_MANY_POSITIONS',
      );
    }

    const seen = new Set<string>();
    for (const p of positions) {
      if (seen.has(p.assetId)) {
        throw badRequest('An asset may only appear once in a conglomerate.', 'DUPLICATE_ASSET');
      }
      seen.add(p.assetId);
    }

    const existing = await repo.existingAssetIds([...seen]);
    for (const assetId of seen) {
      if (!existing.has(assetId)) {
        throw notFound('One or more assets do not exist.', 'ASSET_NOT_FOUND');
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
      await validatePositions(positions);
      const ok = await repo.replacePositions(
        ownerId,
        id,
        positions.map((p) => ({ assetId: p.assetId, weightPct: p.weightPct })),
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
      const deleted = await repo.delete(ownerId, id);
      if (!deleted) throw NOT_FOUND();
    },
  };
}
