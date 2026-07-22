import type {
  AiConglomerateDraftLine,
  AiConglomerateDraftRequest,
  AiConglomerateDraftResponse,
  AiInsightsRequest,
  AiInsightsResponse,
} from '@bettertrack/contracts';

import { badRequest } from '../../errors';
import type { Logger } from '../../logger';
import type { AnalyticsService } from '../analytics/analyticsService';
import type { PortfolioService } from '../portfolio/portfolioService';
import type { SearchService } from '../search/searchService';
import type { AiService } from './aiService';
import { AiProviderError } from './errors';
import { buildInsightsPrompt, computeInsights, INSIGHTS_SYSTEM_PROMPT } from './insightFacts';
import { buildNlBuilderPrompt, NL_BUILDER_SYSTEM_PROMPT, parseNlIntents } from './nlIntent';

/**
 * The user-facing AI features (PROJECTPLAN.md §13.5 V5-P12 2/2) built purely on
 * top of the 1/2 provider layer. Two surfaces, both consuming the one guarded
 * {@link AiService.complete} path (availability + cap + provider), so absent
 * provider ⇒ {@link AiUnavailableError} and cap exhaustion ⇒ {@link
 * AiCapExceededError} come for free and identically on both.
 *
 * Design mandate (design guidance, §16 2026-07-22 LOCAL AI ONLY): the LLM ONLY
 * phrases / extracts intent — every number and every asset id comes from the
 * existing services. Insights hand the model service-computed facts to verbalize
 * (the wire observations stay authoritative); the NL builder resolves the model's
 * weighted phrases to concrete assets exclusively through the local search
 * catalog. No asset id or figure ever originates in the model.
 */

export interface AiFeaturesServiceDeps {
  ai: Pick<AiService, 'complete'>;
  portfolio: Pick<PortfolioService, 'getPortfolio'>;
  analytics: Pick<AnalyticsService, 'getSeries'>;
  search: Pick<SearchService, 'search'>;
  logger: Logger;
}

export interface AiFeaturesService {
  /** Portfolio observations: service-computed facts phrased by the model (informational). */
  insights(userId: string, input: AiInsightsRequest): Promise<AiInsightsResponse>;
  /** NL → a reviewed conglomerate draft: model extracts intents, catalog resolves assets. */
  conglomerateDraft(
    userId: string,
    input: AiConglomerateDraftRequest,
  ): Promise<AiConglomerateDraftResponse>;
}

export function createAiFeaturesService(deps: AiFeaturesServiceDeps): AiFeaturesService {
  const { ai, portfolio, analytics, search, logger } = deps;

  async function insights(userId: string, input: AiInsightsRequest): Promise<AiInsightsResponse> {
    // `getPortfolio` enforces ownership (404/403), so this doubles as the
    // authorization check on the portfolio the caller asked about.
    const overview = await portfolio.getPortfolio(userId, input.portfolioId);

    // Drawdown is best-effort context: reuse the Analytics series' own
    // maxDrawdown (the exact figure the Analytics page renders). If the series
    // can't be built, the drawdown observation is simply omitted.
    let maxDrawdownPct: number | null = null;
    try {
      const series = await analytics.getSeries(userId, input.portfolioId, { mode: 'value' });
      maxDrawdownPct = series.primary.stats.maxDrawdownPct;
    } catch (err) {
      logger.debug({ err }, 'ai insights: analytics series unavailable, omitting drawdown');
    }

    const { observations, promptFacts } = computeInsights({
      holdings: overview.holdings,
      maxDrawdownPct,
    });
    if (observations.length === 0) {
      throw badRequest('This portfolio has no priced holdings to analyze.', 'AI_NO_DATA');
    }

    // The model ONLY phrases the facts (one cap unit). Its text becomes `summary`;
    // the authoritative numbers stay in the service-computed `observations`.
    const completion = await ai.complete(userId, {
      system: INSIGHTS_SYSTEM_PROMPT,
      prompt: buildInsightsPrompt(promptFacts),
      temperature: 0.2,
    });

    return { model: completion.model, observations, summary: completion.text };
  }

  async function conglomerateDraft(
    userId: string,
    input: AiConglomerateDraftRequest,
  ): Promise<AiConglomerateDraftResponse> {
    // The model extracts weighted intents only (one cap unit).
    const completion = await ai.complete(userId, {
      system: NL_BUILDER_SYSTEM_PROMPT,
      prompt: buildNlBuilderPrompt(input.prompt),
      temperature: 0,
    });
    const intents = parseNlIntents(completion.text);
    if (intents.length === 0) {
      logger.warn('ai nl builder: model returned no usable intents');
      throw new AiProviderError('Could not turn that description into a basket. Try rephrasing.');
    }

    // Resolve every intent through the LOCAL catalog ONLY (`searchService`). An
    // unresolvable intent stays in the draft with `asset: null` so the builder
    // flags it — never silently dropped.
    const lines: AiConglomerateDraftLine[] = [];
    for (const intent of intents) {
      const res = await search.search(userId, intent.query);
      const hit = res.results[0] ?? null;
      lines.push({
        query: intent.query,
        weightPct: intent.weightPct,
        asset: hit
          ? {
              id: hit.id,
              symbol: hit.symbol,
              name: hit.name,
              type: hit.type,
              currency: hit.currency,
            }
          : null,
      });
    }

    return { model: completion.model, lines };
  }

  return { insights, conglomerateDraft };
}
