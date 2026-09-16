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
/**
 * The admin named an endpoint that is not on the internal network (§16
 * 2026-07-22 — "internal network only, never publicly exposed"): a public
 * address, a cloud-metadata or otherwise refused range, or one of the
 * deployment's own service addresses. Raised at WRITE time (`PATCH
 * /admin/ai/settings`) and by the admin probes, so a refused destination is
 * never probed and never stored.
 */
export const AI_ENDPOINT_NOT_LOCAL = 'AI_ENDPOINT_NOT_LOCAL';
/**
 * The provider answered, but its output could not be used for what was asked
 * (the NL builder parsed zero intents out of it). Distinct from
 * {@link AI_PROVIDER_ERROR} on purpose: the provider is healthy and the daily-cap
 * unit has been refunded, so the right client behaviour is "rephrase and try
 * again", not "the local model is down".
 */
export const AI_UNUSABLE_OUTPUT = 'AI_UNUSABLE_OUTPUT';

/** Per-user daily completion budget bounds (admin-configurable). */
export const AI_DAILY_CAP_MIN = 1;
export const AI_DAILY_CAP_MAX = 100_000;

/** The only schemes an Ollama endpoint may be written with. */
const ENDPOINT_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Longest endpoint the settings store accepts. */
const ENDPOINT_MAX_LENGTH = 2048;

/**
 * Everything about an endpoint string that can be decided WITHOUT a resolver
 * (#1656 defects 1 + 2). Shared so the admin form, the OpenAPI document and the
 * API all refuse the same strings, and so the response schema can assert the
 * same credential rule on the way back out.
 *
 * `z.string().url()` is not this check: under zod 3 it is a bare `new URL()`
 * try/catch, so it accepts `javascript:`, `file:`, `gopher:` — and
 * `https://svc:s3cr3t@host/`, which is how an Ollama behind a basic-auth proxy
 * gets written and how a credential ends up in a jsonb row, an audit record and
 * a log line.
 *
 * What it deliberately does NOT do is classify the HOST. Address classification
 * is one policy that lives in the API's `outboundUrlGuard` (Node `BlockList`
 * over the RFC ranges, plus the deployment's own service network); this package
 * ships to the browser and cannot import it, and a second hand-rolled copy here
 * would be the two-lists-that-drift failure `auditRedaction.ts` already
 * documents. The API therefore runs the real guard at write time — and again at
 * fetch time, which is the only place a HOSTNAME's address can be known at all.
 */
function checkEndpointSyntax(value: string, ctx: z.RefinementCtx): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid URL.' });
    return;
  }
  if (!ENDPOINT_PROTOCOLS.has(url.protocol)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be an http:// or https:// URL.' });
  }
  if (url.username !== '' || url.password !== '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must not embed credentials — put the endpoint alone in this field.',
    });
  }
  if (url.hostname === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must name a host.' });
  }
  // A base URL with a query or fragment is never a real Ollama endpoint; both
  // would be silently dropped when `/api/chat` is appended, so refusing them
  // says so rather than saving something that does not mean what it reads as.
  if (url.search !== '' || url.hash !== '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Must not carry a query string or fragment.',
    });
  }
}

/** An Ollama endpoint URL, or empty/null to clear the stored override. */
const endpointField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z
    .string()
    .max(ENDPOINT_MAX_LENGTH)
    .nullable()
    .superRefine((value, ctx) => {
      if (value !== null) checkEndpointSyntax(value, ctx);
    }),
);
/** A model name, or empty/null to clear the stored override. */
const modelField = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().min(1).max(200).nullable(),
);

/** `GET /admin/ai/settings` — the admin LLM-settings read. No secrets, ever. */
export const aiSettingsResponseSchema = z
  .object({
    /**
     * Effective Ollama base URL (stored override else env default); null when
     * unset — and null, too, when the stored value is unparseable.
     *
     * The same credential rule as the write path, asserted on the way OUT
     * (#1656 defect 2). The service already strips any userinfo an older row
     * carries, so this can only ever fire if that stripping regresses — and
     * then failing the response is strictly better than serving the credential
     * to the admin SPA, where it would land in a browser cache and a screenshot.
     * A public host is deliberately still rendered: an endpoint stored before
     * this validation existed has to be VISIBLE to be fixed.
     */
    endpoint: z
      .string()
      .max(ENDPOINT_MAX_LENGTH)
      .nullable()
      .superRefine((value, ctx) => {
        if (value === null) return;
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must be a valid URL.' });
          return;
        }
        if (url.username !== '' || url.password !== '') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Must not embed credentials.' });
        }
      }),
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
