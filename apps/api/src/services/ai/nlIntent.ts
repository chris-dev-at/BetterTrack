import { z } from 'zod';

/**
 * NL-conglomerate-builder intent extraction (PROJECTPLAN.md §13.5 V5-P12 2/2,
 * design guidance). PURE and I/O-free. The model's ONLY job is to turn a
 * free-text basket description into a list of weighted search phrases; the
 * resolution of a phrase to a concrete asset happens exclusively through the
 * LOCAL search catalog (never the model), so a model can never conjure an asset
 * id. This module builds the extraction prompt and defensively parses the
 * model's JSON — a small local model's output is unreliable, so parsing tolerates
 * surrounding prose/fences and fails soft (empty ⇒ the service raises a typed
 * provider error rather than guessing).
 */

/** §6.5: a basket holds at most 50 positions, so never extract more intents. */
export const NL_BUILDER_MAX_INTENTS = 50;
/** Search queries are capped at 64 chars (`searchQuerySchema`); longer phrases are truncated. */
const MAX_QUERY_LEN = 64;

export const NL_BUILDER_SYSTEM_PROMPT = [
  'You extract weighted allocation intents from a description of an investment basket.',
  'Output STRICT JSON and nothing else, in exactly this shape:',
  '{"lines":[{"query":"<short catalog search phrase>","weightPct":<number 0-100>}]}',
  'Rules:',
  '- "query" is a short phrase to search a financial asset catalog: a company, ETF, sector, region, or asset name.',
  '- Use the weights the user stated. If the user gives no weights, split evenly so the total is about 100.',
  '- Do not add commentary, explanations, or code fences. Output JSON only.',
].join('\n');

/** Build the NL-builder user prompt from a free-text basket description. */
export function buildNlBuilderPrompt(description: string): string {
  return `Description:\n${description}\n\nReturn the JSON now.`;
}

/** One raw weighted intent the model extracted (pre-resolution). */
export interface NlIntent {
  query: string;
  weightPct: number;
}

const rawLineSchema = z.object({
  query: z.string(),
  weightPct: z.coerce.number(),
});
const rawSchema = z.object({ lines: z.array(rawLineSchema) });

/**
 * Extract the first balanced JSON object from a model response, tolerating
 * leading prose or ```json fences. Tracks string context so a brace inside a
 * quoted value never closes the object early.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Clamp a weight into [0, 100] at 3-decimal precision (non-finite ⇒ 0). */
function clampWeightPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)) * 1000) / 1000;
}

/**
 * Parse the model's response into clean, bounded intents. Returns `[]` when the
 * output is unparseable or carries no usable line — the caller treats that as a
 * provider failure rather than fabricating a basket.
 */
export function parseNlIntents(modelText: string): NlIntent[] {
  const json = extractJsonObject(modelText);
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const result = rawSchema.safeParse(parsed);
  if (!result.success) return [];
  return result.data.lines
    .map((line) => ({
      query: line.query.trim().slice(0, MAX_QUERY_LEN),
      weightPct: clampWeightPct(line.weightPct),
    }))
    .filter((line) => line.query.length > 0)
    .slice(0, NL_BUILDER_MAX_INTENTS);
}
