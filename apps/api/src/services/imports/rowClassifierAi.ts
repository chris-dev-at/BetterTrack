import type { AiService } from '../ai/aiService';

/**
 * Stage-3 AI fallback for import-row classification (PROJECTPLAN.md §16
 * 2026-07-31 — the import wizard understands a WHOLE FILE). Mirrors the
 * `nlIntent.ts` playbook exactly: a strict output contract in the system prompt,
 * a bounded prompt builder, and a defensive parse that FAILS SOFT — a malformed
 * or missing line means "needs review", never a guessed kind. PURE and I/O-free;
 * the caller injects the AI seam, so tests run without any model.
 *
 * Two hard mandates live here rather than in discipline:
 * - **CHEAP tier only.** {@link ROW_CLASSIFICATION_AI_TIER} is pinned to
 *   `'cheap'`; HEAVY (`qwen3.8`) is reserved for schema-level reasoning in
 *   another task and is structurally unreachable from the classifier: the seam
 *   below is a one-argument interface that `Pick<AiService, 'complete'>` (whose
 *   `complete` takes userId + request) does NOT satisfy, so raw service objects
 *   are rejected at compile time and wiring must go through {@link
 *   bindCheapTierAi}, which fixes temperature 0 and nothing else.
 * - **Kind labels only.** The model names a kind per row; it never produces or
 *   alters a number, date, amount, or asset id (§16 2026-07-22 LOCAL AI ONLY
 *   mandate, same as insights/NL builder). Every value comes from the parsed
 *   row.
 */

/**
 * The configured model tier this feature consumes. Bulk row classification is
 * exactly what the CHEAP tier exists for (measured: a 7B local model classified
 * German broker rows 6/6 in 8.6 s at temperature 0 with the `<index>=<LABEL>`
 * contract below) — spending HEAVY here would be a bug, and this constant is
 * what deployment wiring resolves to the configured cheap endpoint/model.
 */
export const ROW_CLASSIFICATION_AI_TIER = 'cheap' as const;

/** The labels the model may answer with — the five wire kinds, nothing else. */
export const AI_ROW_LABELS = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'] as const;
export type RowClassificationAiLabel = (typeof AI_ROW_LABELS)[number];

function isAiRowLabel(value: string): value is RowClassificationAiLabel {
  return (AI_ROW_LABELS as readonly string[]).includes(value);
}

/**
 * The narrow one-argument completion seam the classifier consumes. Deliberately
 * NOT satisfied by `Pick<AiService, 'complete'>` (two parameters) — passing the
 * raw AI service is a compile error, so the guarded `complete()` path can only
 * be reached through {@link bindCheapTierAi}.
 */
export interface ImportRowAiSeam {
  complete(request: { system: string; prompt: string }): Promise<{ text: string; model: string }>;
}

/**
 * Bind the guarded {@link AiService.complete} path (feature flag + daily cap +
 * refund-on-failure) to the classifier's narrow CHEAP-tier seam. Temperature 0
 * is fixed: the measured stage-3 result holds only for deterministic decoding.
 */
export function bindCheapTierAi(ai: Pick<AiService, 'complete'>, userId: string): ImportRowAiSeam {
  return {
    complete: async ({ system, prompt }) => {
      const completion = await ai.complete(userId, {
        system,
        prompt,
        temperature: 0,
      });
      return { text: completion.text, model: completion.model };
    },
  };
}

export const ROW_CLASSIFY_SYSTEM_PROMPT = [
  'You classify the kinds of rows from a stock-broker CSV statement.',
  'Output STRICT lines and nothing else, in exactly this shape:',
  '<index>=<LABEL>',
  'Rules:',
  '- <LABEL> is exactly one of: buy, sell, dividend, deposit, withdrawal.',
  '- buy/sell: a security trade; dividend: a payout from a held asset;',
  '  deposit: cash moving INTO the account; withdrawal: cash moving OUT of it.',
  '- One line per input row, reusing the exact index the row was given. Never invent indexes.',
  '- Do not add commentary, explanations, or code fences. Output the lines only.',
].join('\n');

/** One row handed to the batch prompt — facts only, copied from the parsed row. */
export interface AiBatchRow {
  index: number;
  text: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  symbol: string | null;
  isin: string | null;
}

/** Flatten a fact into the prompt line, or drop it entirely when absent. */
function appendFact(line: string[], label: string, value: number | string | null): void {
  if (value === null || value === '') return;
  line.push(`${label}=${value}`);
}

/**
 * Build the batched user prompt: indexed rows, facts only. Text is flattened
 * hard — quotes/backslashes removed, whitespace collapsed, truncated at 120
 * chars, emitted UNQUOTED — so one noisy memo can neither derail the strict
 * output contract nor smuggle a character that impersonates quoting.
 */
export function buildRowKindBatchPrompt(rows: readonly AiBatchRow[]): string {
  const lines = rows.map((row) => {
    const parts: string[] = [];
    const flatText = row.text?.replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
    appendFact(parts, 'text', flatText ? flatText.slice(0, 120) : null);
    appendFact(parts, 'qty', row.quantity);
    appendFact(parts, 'price', row.price);
    appendFact(parts, 'amount', row.amount);
    appendFact(parts, 'sym', row.symbol);
    appendFact(parts, 'isin', row.isin);
    return `${row.index}: ${parts.join(' ')}`;
  });
  return `Rows:\n${lines.join('\n')}\n\nAnswer now.`;
}

/**
 * Tolerant line shape: `<index>=<LABEL>`, also accepting the separator and
 * spacing variants the small model drifts into (`:` / `-` / `>`), so a slightly
 * bent-but-decipherable line still counts while pure prose never does.
 */
const REPLY_LINE_PATTERN = /(\d{1,4})\s*[=:>~-]+\s*([a-zA-Z]+)/g;

/**
 * Parse a batch reply defensively. Returns the trusted subset: only indexes the
 * caller actually sent, only known labels, first line wins per index. Missing,
 * duplicated-garbage, or foreign-label lines are simply ABSENT from the map —
 * the caller turns every absent index into `needsReview`, never a guess.
 */
export function parseRowKindBatchReply(
  modelText: string,
  validIndexes: ReadonlySet<number>,
): Map<number, RowClassificationAiLabel> {
  const parsed = new Map<number, RowClassificationAiLabel>();
  for (const match of modelText.matchAll(REPLY_LINE_PATTERN)) {
    const rawIndex = match[1];
    const rawLabel = match[2];
    if (rawIndex === undefined || rawLabel === undefined) continue;
    const index = Number(rawIndex);
    const label = rawLabel.toLowerCase();
    if (!validIndexes.has(index) || !isAiRowLabel(label)) continue;
    if (parsed.has(index)) continue;
    parsed.set(index, label);
  }
  return parsed;
}
