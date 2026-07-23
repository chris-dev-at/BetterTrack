import { z } from 'zod';

import { assetTypeSchema, currencyCodeSchema } from './market';

/**
 * Local-AI provider layer (PROJECTPLAN.md §13.5 V5-P12, as amended by §16
 * 2026-07-22 — LOCAL AI ONLY). The product ships exactly ONE adapter: the
 * owner's LAN Ollama. There is deliberately NO cloud provider, NO API-token
 * storage, and NO masked-secret DTO anywhere here — the only settings are a
 * plain endpoint URL, a model name, and a per-user daily cap.
 *
 * Two surfaces ride these shapes:
 *  - admin: read/write the endpoint + model + cap, and a test-connection probe
 *    that lists the models the endpoint actually serves (the model picker);
 *  - user: a capability read ("is AI available for me + how much of my daily cap
 *    is left") the SPA keys visibility off — no provider ⇒ disabled ⇒ nothing
 *    AI-related renders. Issue 2/2 (insights + NL builder) is purely additive.
 */

/** Typed error codes the AI layer raises (shared API ⇄ web, §8 envelope). */
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_CAP_EXCEEDED = 'AI_CAP_EXCEEDED';
export const AI_PROVIDER_ERROR = 'AI_PROVIDER_ERROR';

/** Per-user daily completion budget bounds (admin-configurable). */
export const AI_DAILY_CAP_MIN = 1;
export const AI_DAILY_CAP_MAX = 100_000;

/** An Ollama endpoint URL, or empty/null to clear the stored override. */
const endpointField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().url().max(2048).nullable(),
);
/** A model name, or empty/null to clear the stored override. */
const modelField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().min(1).max(200).nullable(),
);

/** `GET /admin/ai/settings` — the admin LLM-settings read. No secrets, ever. */
export const aiSettingsResponseSchema = z
  .object({
    /** Effective Ollama base URL (stored override else env default); null when unset. */
    endpoint: z.string().url().nullable(),
    /** Effective model name (stored override else env default); null when unset. */
    model: z.string().nullable(),
    /** Per-user daily completion cap in effect. */
    dailyCap: z.number().int().positive(),
    /** True when BOTH an endpoint and a model resolve — the feature can run. */
    configured: z.boolean(),
    /** When any AI setting was last written; null while all sit at env defaults. */
    updatedAt: z.string().datetime().nullable(),
    /** The admin who last wrote a setting; null when unset. */
    updatedBy: z.string().uuid().nullable(),
  })
  .strict();
export type AiSettingsResponse = z.infer<typeof aiSettingsResponseSchema>;

/**
 * `PATCH /admin/ai/settings` — set the endpoint, model and/or cap. An empty
 * string or null clears that override so the value falls back to the env
 * default. Switching endpoint/model takes effect on the next request with no
 * redeploy (the registry resolves config at request time).
 */
export const updateAiSettingsRequestSchema = z
  .object({
    endpoint: endpointField.optional(),
    model: modelField.optional(),
    dailyCap: z.number().int().min(AI_DAILY_CAP_MIN).max(AI_DAILY_CAP_MAX).optional(),
  })
  .strict();
export type UpdateAiSettingsRequest = z.infer<typeof updateAiSettingsRequestSchema>;

/**
 * `POST /admin/ai/test-connection` — probe an endpoint and list the models it
 * serves (feeds the model picker). Omit `endpoint` to test the stored/effective
 * one; pass a candidate to test it before saving. Local-only: the probe only
 * ever reaches the given endpoint.
 */
export const aiTestConnectionRequestSchema = z
  .object({ endpoint: endpointField.optional() })
  .strict();
export type AiTestConnectionRequest = z.infer<typeof aiTestConnectionRequestSchema>;

export const aiTestConnectionResponseSchema = z
  .object({
    /** Whether the endpoint answered the model-list probe. */
    ok: z.boolean(),
    /** The models the endpoint serves (empty on failure or none installed). */
    models: z.array(z.string()),
    /** Short, non-sensitive failure detail (e.g. `timeout`, `http 500`); null on success. */
    error: z.string().nullable(),
  })
  .strict();
export type AiTestConnectionResponse = z.infer<typeof aiTestConnectionResponseSchema>;

/** The prompt the admin diagnostic starts from — short, so any model answers fast. */
export const AI_TEST_REQUEST_DEFAULT_PROMPT = 'Reply with one word: ready';

/**
 * `POST /admin/ai/test-request` — send a REAL prompt to an endpoint/model and get
 * the generated reply back. Where test-connection only proves reachability, this
 * proves the whole round trip (endpoint + model + generation) and reports how long
 * it took, which is the number that decides whether a model is usable on the host.
 * Omit `endpoint`/`model` to use the stored/effective ones; pass candidates to
 * trial them before saving. A diagnostic only: it never spends a user's daily cap.
 */
export const aiTestRequestSchema = z
  .object({
    endpoint: endpointField.optional(),
    model: modelField.optional(),
    prompt: z.string().trim().min(1).max(1000),
  })
  .strict();
export type AiTestRequest = z.infer<typeof aiTestRequestSchema>;

export const aiTestRequestResponseSchema = z
  .object({
    /** Whether the model generated a reply. */
    ok: z.boolean(),
    /** The model that answered (candidate else effective); null when none resolved. */
    model: z.string().nullable(),
    /** The model's reply text; null on failure. */
    reply: z.string().nullable(),
    /** Round-trip time of the generation call in ms (0 when nothing was sent). */
    latencyMs: z.number().int().nonnegative(),
    /** Short, non-sensitive failure detail (e.g. `timeout`, `http 404`); null on success. */
    error: z.string().nullable(),
  })
  .strict();
export type AiTestRequestResponse = z.infer<typeof aiTestRequestResponseSchema>;

/**
 * `GET /ai/capability` — the user-facing availability + remaining daily budget.
 * `available` is false whenever no provider is configured (or the `ai` feature
 * flag is off), and the SPA renders nothing AI-related in that case.
 */
export const aiCapabilityResponseSchema = z
  .object({
    available: z.boolean(),
    /** The active model when available, else null. */
    model: z.string().nullable(),
    /** The per-user daily cap in effect. */
    dailyCap: z.number().int().nonnegative(),
    /** Completions the user has spent today (UTC). */
    used: z.number().int().nonnegative(),
    /** Completions the user has left today (never negative). */
    remaining: z.number().int().nonnegative(),
  })
  .strict();
export type AiCapabilityResponse = z.infer<typeof aiCapabilityResponseSchema>;

/* ────────────────────────────────────────────────────────────────────────────
 * Issue 2/2 — the user-facing feature shapes (insights + NL conglomerate builder).
 * Purely additive on the 1/2 layer above and gated by the same capability read.
 * Design mandate: the model ONLY phrases / extracts intent — every number and
 * every asset id below is service-computed, never model-derived.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The observation kinds the insights service derives from holdings/analytics data. */
export const AI_INSIGHT_KINDS = ['concentration', 'drawdown'] as const;
export type AiInsightKind = (typeof AI_INSIGHT_KINDS)[number];

/** `POST /ai/insights` — request the AI observations for one of the caller's portfolios. */
export const aiInsightsRequestSchema = z.object({ portfolioId: z.string().uuid() }).strict();
export type AiInsightsRequest = z.infer<typeof aiInsightsRequestSchema>;

/**
 * One service-computed fact: a stable `key` the web maps to an i18n label + a
 * numeric `value`. Kept numeric on the wire (not a pre-formatted string) so the
 * web owns EN/DE formatting — and so the value is unambiguously the authoritative,
 * service-computed figure, never something a model phrased.
 */
export const aiInsightFactSchema = z.object({ key: z.string(), value: z.number() }).strict();
export type AiInsightFact = z.infer<typeof aiInsightFactSchema>;

/** One observation: its kind + the authoritative numeric facts behind it. */
export const aiInsightObservationSchema = z
  .object({
    kind: z.enum(AI_INSIGHT_KINDS),
    facts: z.array(aiInsightFactSchema).min(1),
  })
  .strict();
export type AiInsightObservation = z.infer<typeof aiInsightObservationSchema>;

/**
 * `POST /ai/insights` response. `observations` carry the service-computed facts
 * (authoritative); `summary` is the model's plain-language phrasing of them —
 * informational ONLY, it never carries an action, and even if it contains figures
 * they never override the `observations`. The web renders the hard
 * "not financial advice" disclaimer (an i18n string) alongside it.
 */
export const aiInsightsResponseSchema = z
  .object({
    model: z.string(),
    observations: z.array(aiInsightObservationSchema),
    summary: z.string(),
  })
  .strict();
export type AiInsightsResponse = z.infer<typeof aiInsightsResponseSchema>;

/** `POST /ai/conglomerate-draft` — turn a natural-language basket description into a draft. */
export const aiConglomerateDraftRequestSchema = z
  .object({ prompt: z.string().trim().min(1).max(1000) })
  .strict();
export type AiConglomerateDraftRequest = z.infer<typeof aiConglomerateDraftRequestSchema>;

/** The concrete asset a draft line resolved to via the LOCAL catalog (null ⇒ unresolvable). */
export const aiDraftAssetSchema = z
  .object({
    id: z.string().uuid(),
    symbol: z.string(),
    name: z.string(),
    type: assetTypeSchema,
    currency: currencyCodeSchema,
  })
  .strict();
export type AiDraftAsset = z.infer<typeof aiDraftAssetSchema>;

/**
 * One line of a drafted basket: the model-extracted `query` phrase + its weight,
 * and the LOCAL-catalog asset it resolved to. `asset: null` ⇒ unresolvable, and
 * the builder flags it — an unresolved intent is NEVER silently dropped. The model
 * only supplies `query`/`weightPct`; resolution runs exclusively through the
 * search catalog, never the model.
 */
export const aiConglomerateDraftLineSchema = z
  .object({
    query: z.string(),
    weightPct: z.number().min(0).max(100),
    asset: aiDraftAssetSchema.nullable(),
  })
  .strict();
export type AiConglomerateDraftLine = z.infer<typeof aiConglomerateDraftLineSchema>;

/**
 * `POST /ai/conglomerate-draft` response — a DRAFT only. The web prefills the
 * normal Conglomerate Builder with the resolved lines (flagging unresolved ones);
 * the user reviews, edits and explicitly saves. Nothing here is ever persisted
 * server-side.
 */
export const aiConglomerateDraftResponseSchema = z
  .object({
    model: z.string(),
    lines: z.array(aiConglomerateDraftLineSchema),
  })
  .strict();
export type AiConglomerateDraftResponse = z.infer<typeof aiConglomerateDraftResponseSchema>;
