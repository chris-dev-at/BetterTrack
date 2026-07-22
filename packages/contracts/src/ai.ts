import { z } from 'zod';

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
