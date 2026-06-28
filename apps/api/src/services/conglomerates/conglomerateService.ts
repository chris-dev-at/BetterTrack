import { backtest, BacktestError } from '../../domain/backtest';
import type { CurrencyService } from '../currency/currencyService';
import type {
  ConglomerateDetailRow,
  ConglomerateRepository,
} from '../../data/repositories/conglomerateRepository';
import { badRequest, conflict, notFound } from '../../errors';

const ACTIVE_SUM_TOLERANCE = 0.01;

export interface ConglomerateServiceDeps {
  repo: ConglomerateRepository;
  currencyService: CurrencyService;
}

export interface ConglomerateService {
  create(
    ownerId: string,
    input: { name: string; description?: string | null },
  ): Promise<ConglomerateDetailRow>;
  load(ownerId: string, id: string): Promise<ConglomerateDetailRow>;
  updateMeta(
    ownerId: string,
    id: string,
    input: { name?: string; description?: string | null },
  ): Promise<ConglomerateDetailRow>;
  replacePositions(
    ownerId: string,
    id: string,
    positions: Array<{ assetId: string; weightPct: number }>,
  ): Promise<ConglomerateDetailRow>;
  activate(ownerId: string, id: string): Promise<ConglomerateDetailRow>;
  preview(
    ownerId: string,
    input: {
      range: '1Y' | '3Y' | '5Y' | 'Max';
      positions: Array<{ assetId: string; weightPct: number }>;
    },
  ): Promise<{
    range: '1Y' | '3Y' | '5Y' | 'Max';
    series: Array<{ date: string; value: number }>;
    stats: Awaited<ReturnType<typeof backtest>>['stats'] | null;
    notice: string | null;
  }>;
}

function hasTooManyDecimals(value: number): boolean {
  return Math.abs(value * 1_000 - Math.round(value * 1_000)) > 1e-9;
}

function validatePositionSet(
  positions: Array<{ assetId: string; weightPct: number }>,
  mode: 'draft' | 'active',
): void {
  if (positions.length > 50) {
    throw badRequest('A conglomerate can contain at most 50 positions.', 'TOO_MANY_POSITIONS');
  }
  if (mode === 'active' && positions.length < 1) {
    throw badRequest('An active conglomerate needs at least one position.', 'NO_POSITIONS');
  }

  const seen = new Set<string>();
  for (const position of positions) {
    if (seen.has(position.assetId)) {
      throw badRequest('Each asset can appear only once.', 'DUPLICATE_POSITION');
    }
    seen.add(position.assetId);

    if (
      !Number.isFinite(position.weightPct) ||
      position.weightPct < 0 ||
      position.weightPct > 100
    ) {
      throw badRequest('Weights must be between 0 and 100.', 'INVALID_WEIGHT');
    }
    if (hasTooManyDecimals(position.weightPct)) {
      throw badRequest('Weights support at most 3 decimal places.', 'INVALID_WEIGHT_PRECISION');
    }
    if (mode === 'active' && position.weightPct <= 0) {
      throw badRequest('Active positions must have a weight above 0.', 'ZERO_WEIGHT');
    }
  }

  if (mode === 'active') {
    const sum = positions.reduce((total, position) => total + position.weightPct, 0);
    if (Math.abs(sum - 100) > ACTIVE_SUM_TOLERANCE) {
      throw badRequest('Active weights must sum to 100% ± 0.01.', 'INVALID_WEIGHT_SUM', { sum });
    }
  }
}

function startForRange(range: '1Y' | '3Y' | '5Y' | 'Max', end: string): string {
  if (range === 'Max') return '1900-01-01';
  const years = Number(range.slice(0, -1));
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

export function createConglomerateService(deps: ConglomerateServiceDeps): ConglomerateService {
  const { repo, currencyService } = deps;

  return {
    async create(ownerId, input) {
      const name = input.name.trim();
      if (await repo.nameExists(ownerId, name)) {
        throw conflict('A conglomerate with that name already exists.', 'NAME_EXISTS');
      }
      const row = await repo.create(ownerId, name, input.description ?? null);
      const detail = await repo.load(ownerId, row.id);
      if (!detail) throw new Error('Conglomerate vanished after insert');
      return detail;
    },

    async load(ownerId, id) {
      const detail = await repo.load(ownerId, id);
      if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
      return detail;
    },

    async updateMeta(ownerId, id, input) {
      const nextName = input.name?.trim();
      if (nextName && (await repo.nameExists(ownerId, nextName, id))) {
        throw conflict('A conglomerate with that name already exists.', 'NAME_EXISTS');
      }
      const detail = await repo.updateMeta(ownerId, id, {
        ...input,
        name: nextName,
        description: input.description ?? undefined,
      });
      if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
      return detail;
    },

    async replacePositions(ownerId, id, positions) {
      validatePositionSet(positions, 'draft');
      const assetIds = [...new Set(positions.map((p) => p.assetId))];
      const existingAssets = await repo.visibleAssetsExist(ownerId, assetIds);
      if (existingAssets.size !== assetIds.length) {
        throw badRequest('One or more assets are unavailable.', 'ASSET_NOT_FOUND');
      }
      const detail = await repo.replacePositions(ownerId, id, positions);
      if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
      return detail;
    },

    async activate(ownerId, id) {
      const detail = await repo.load(ownerId, id);
      if (!detail) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
      validatePositionSet(
        detail.positions.map((p) => ({ assetId: p.assetId, weightPct: Number(p.weightPct) })),
        'active',
      );
      const activated = await repo.activate(ownerId, id);
      if (!activated) throw notFound('Conglomerate not found.', 'CONGLOMERATE_NOT_FOUND');
      return activated;
    },

    async preview(ownerId, input) {
      validatePositionSet(input.positions, 'draft');
      const weighted = input.positions.filter((p) => p.weightPct > 0);
      if (weighted.length === 0) {
        return { range: input.range, series: [], stats: null, notice: null };
      }

      const assetIds = [...new Set(weighted.map((p) => p.assetId))];
      const assets = await repo.historyForAssets(ownerId, assetIds);
      if (assets.length !== assetIds.length) {
        throw badRequest('One or more assets are unavailable.', 'ASSET_NOT_FOUND');
      }
      const end =
        assets
          .flatMap((asset) => asset.prices.map((point) => point.date))
          .sort()
          .at(-1) ?? new Date().toISOString().slice(0, 10);

      try {
        const result = await backtest({
          positions: weighted.map((p) => ({ assetId: p.assetId, weight: p.weightPct })),
          assets,
          range: { start: startForRange(input.range, end), end },
          converter: currencyService,
          baseCurrency: currencyService.baseCurrency,
        });
        return {
          range: input.range,
          series: result.series,
          stats: result.stats,
          notice: result.notice,
        };
      } catch (error) {
        if (error instanceof BacktestError) {
          return { range: input.range, series: [], stats: null, notice: error.message };
        }
        throw error;
      }
    },
  };
}
