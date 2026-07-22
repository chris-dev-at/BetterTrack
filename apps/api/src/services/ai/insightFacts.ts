import type { AiInsightObservation, Holding } from '@bettertrack/contracts';

/**
 * Insight fact computation (PROJECTPLAN.md §13.5 V5-P12 2/2, design guidance —
 * "the LLM only PHRASES; the numbers come from the existing services"). PURE and
 * I/O-free: it turns already-fetched holdings/analytics data into the structured,
 * service-computed observations that ride the wire (authoritative — never derived
 * from the model) plus a set of plain-English fact bullets handed to the model to
 * verbalize. The model is deliberately given the facts and asked only to phrase
 * them, so it can never invent or override a figure.
 */

/** Below this EUR value a holding is treated as flat (no meaningful weight). */
const VALUE_EPSILON = 1e-9;

/** Round a percentage to one decimal place (the display precision). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface InsightFactsInput {
  /** The portfolio's holdings view (`GET /portfolios/:id`). */
  holdings: readonly Holding[];
  /**
   * Max drawdown percent (≤ 0) from the Analytics series — the very number the
   * Analytics page itself shows — or null when the series can't be built.
   */
  maxDrawdownPct: number | null;
}

export interface ComputedInsights {
  /** Wire observations — numeric facts only, all service-computed (authoritative). */
  observations: AiInsightObservation[];
  /** Plain-English fact bullets handed to the model to PHRASE (may name holdings). */
  promptFacts: string[];
}

/**
 * Compute the structured observations + prompt facts for a portfolio. Only the
 * observation kinds the data supports are emitted; an empty result means there is
 * nothing to analyze (the service rejects that before spending a completion).
 */
export function computeInsights(input: InsightFactsInput): ComputedInsights {
  const observations: AiInsightObservation[] = [];
  const promptFacts: string[] = [];

  // ── Concentration (from holdings) ──────────────────────────────────────────
  // Weight each priced holding against the priced total (cash and flat/unpriced
  // rows excluded), so the top-weight and top-3 figures are self-consistent.
  const priced = input.holdings
    .map((h) => ({ symbol: h.asset.symbol, value: h.marketValueEur ?? 0 }))
    .filter((h) => h.value > VALUE_EPSILON)
    .sort((a, b) => b.value - a.value);
  const total = priced.reduce((acc, h) => acc + h.value, 0);
  const hasPricedHoldings = priced.length > 0 && total > VALUE_EPSILON;
  if (hasPricedHoldings) {
    const topWeightPct = round1((priced[0]!.value / total) * 100);
    const top3Value = priced.slice(0, 3).reduce((acc, h) => acc + h.value, 0);
    const top3WeightPct = round1((top3Value / total) * 100);
    const positionCount = priced.length;
    observations.push({
      kind: 'concentration',
      facts: [
        { key: 'topWeightPct', value: topWeightPct },
        { key: 'top3WeightPct', value: top3WeightPct },
        { key: 'positionCount', value: positionCount },
      ],
    });
    promptFacts.push(
      `The largest holding, ${priced[0]!.symbol}, is ${topWeightPct}% of the invested value.`,
      `The top 3 holdings together are ${top3WeightPct}% of the invested value.`,
      `The portfolio holds ${positionCount} priced position${positionCount === 1 ? '' : 's'}.`,
    );
  }

  // ── Drawdown context (from the Analytics series) ────────────────────────────
  // Only meaningful alongside holdings — an empty portfolio has no value curve.
  if (hasPricedHoldings && input.maxDrawdownPct !== null && input.maxDrawdownPct < -VALUE_EPSILON) {
    const magnitude = round1(Math.abs(input.maxDrawdownPct));
    observations.push({
      kind: 'drawdown',
      facts: [{ key: 'maxDrawdownPct', value: magnitude }],
    });
    promptFacts.push(
      `The largest peak-to-trough decline over the tracked window was ${magnitude}%.`,
    );
  }

  return { observations, promptFacts };
}

/**
 * The insights system preamble. Hard guardrails: use only the given numbers, no
 * advice, stay short. The disclaimer the user sees is a separate i18n string.
 */
export const INSIGHTS_SYSTEM_PROMPT = [
  'You turn factual statistics about an investment portfolio into a short, neutral, plain-language summary.',
  'Rules:',
  '- Use ONLY the numbers provided. Never invent, estimate, or change any figure.',
  '- Do NOT give advice, recommendations, predictions, or buy/sell/hold suggestions.',
  '- Be concise: 2 to 4 short sentences. No markdown, no lists, no headings.',
].join('\n');

/** Build the insights user prompt from the service-computed fact bullets. */
export function buildInsightsPrompt(promptFacts: readonly string[]): string {
  return [
    'Here are factual statistics about a portfolio:',
    ...promptFacts.map((fact) => `- ${fact}`),
    '',
    'Write a brief, neutral summary of what these figures describe. Do not recommend any action.',
  ].join('\n');
}
