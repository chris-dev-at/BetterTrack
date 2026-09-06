import type { AiService } from '../ai/aiService';
import { AiCapExceededError, AiUnavailableError } from '../ai/errors';

/**
 * The ONE completion seam the import wizard's two AI consumers share — column
 * headers (`headerMappingAi.ts`) and row kinds (`rowClassifierAi.ts`).
 *
 * There used to be two of them, separated by a `tier` field pinned to `'heavy'`
 * and `'cheap'`. Nothing resolved either: §6.18 configures exactly ONE local
 * Ollama endpoint/model pair (`BT_OLLAMA_ENDPOINT`/`BT_OLLAMA_MODEL`, admin
 * overridable), `AiRegistry.resolve()` returns exactly that one provider, and
 * both binders reached it through the same {@link AiService.complete}. The tier
 * was therefore a guarantee the provider layer could not give, asserted in code,
 * comments and tests alike — so it is gone, and the two consumers say plainly
 * that they share one model and one per-user daily budget.
 *
 * What the seam DOES still guarantee is unchanged and enforced here:
 * - it is a ONE-argument interface, so `Pick<AiService, 'complete'>` (userId +
 *   request) does not satisfy it and the guarded path can only be reached
 *   through {@link bindImportAi};
 * - temperature 0, so one uploaded file gets one reproducible answer;
 * - the caller's user id, so every import completion spends the CALLER's daily
 *   cap and lands in their audit trail.
 */
export interface ImportAiSeam {
  complete(request: { system: string; prompt: string }): Promise<{ text: string; model: string }>;
}

/**
 * Why an import AI call did not produce an answer. The three are kept apart all
 * the way to the evidence a review row carries, because they mean three
 * different things to the person reading it: their shared daily budget is spent
 * (comes back tomorrow), no assistant is configured at all (nothing to wait
 * for), or the configured one failed to answer (worth retrying).
 *
 * `'cap-exhausted'` additionally STOPS the caller: every further call in the
 * same import is a guaranteed 429, so the budgeted remainder is not spent on
 * one.
 */
export const IMPORT_AI_FAILURES = ['cap-exhausted', 'unavailable', 'failed'] as const;
export type ImportAiFailure = (typeof IMPORT_AI_FAILURES)[number];

/**
 * What a bound seam throws. It carries the classified {@link ImportAiFailure}
 * rather than the AI layer's typed `ApiError`s, so the import modules stay pure
 * of HTTP concerns and a test can script any of the three cases without
 * constructing an `AiService`.
 */
export class ImportAiSeamError extends Error {
  constructor(readonly failure: ImportAiFailure) {
    super(`import ai seam: ${failure}`);
    this.name = 'ImportAiSeamError';
  }
}

/**
 * Classify anything a seam threw. An {@link ImportAiSeamError} states its own
 * case; the AI layer's typed errors map onto it; everything else — including a
 * stub seam throwing a bare `Error` — is `'failed'`, the conservative reading
 * (retryable, and never mistaken for a spent budget).
 */
export function importAiFailureOf(err: unknown): ImportAiFailure {
  if (err instanceof ImportAiSeamError) return err.failure;
  if (err instanceof AiCapExceededError) return 'cap-exhausted';
  if (err instanceof AiUnavailableError) return 'unavailable';
  return 'failed';
}

/**
 * Bind the guarded {@link AiService.complete} path (feature flag + daily cap +
 * refund-on-failure) to the narrow import seam, for ONE user.
 *
 * Both import consumers bind through this same function because both reach the
 * same configured model: the header mapper asks its question once per file, the
 * row classifier asks its question for at most a few batches, and every one of
 * those calls spends a unit of the SAME per-user daily cap the Insights and NL
 * builder features draw on (§6.18 — one cap per user, not per feature).
 */
export function bindImportAi(ai: Pick<AiService, 'complete'>, userId: string): ImportAiSeam {
  return {
    complete: async ({ system, prompt }) => {
      try {
        const completion = await ai.complete(userId, { system, prompt, temperature: 0 });
        return { text: completion.text, model: completion.model };
      } catch (err) {
        // Narrowed at the boundary: consumers get the seam's own taxonomy and
        // never have to know which typed AI error means "budget spent".
        throw new ImportAiSeamError(importAiFailureOf(err));
      }
    },
  };
}
