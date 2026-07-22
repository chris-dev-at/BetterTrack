/**
 * The AI provider adapter seam (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22 —
 * LOCAL AI ONLY). A clean interface so a future adapter is a drop-in, but the
 * product ships exactly ONE implementation: the local Ollama adapter. There is
 * deliberately no cloud adapter, no API-token concept, and no per-call billing
 * anywhere behind this seam.
 *
 * Everything a provider does is a plain HTTP call to a single, admin-configured
 * base URL (the owner's LAN Ollama) — a provider never reaches a hardcoded or
 * external host.
 */

/** A single chat turn handed to the model. */
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * A completion request. Kept minimal for 1/2 (the provider layer): a system
 * preamble + the user prompt, with optional decoding knobs. Issue 2/2 (insights,
 * NL builder) composes concrete prompts on top of this shape.
 */
export interface AiCompletionRequest {
  /** Optional system preamble (framing / guardrails). */
  system?: string;
  /** The user prompt. */
  prompt: string;
  /** Optional sampling temperature (provider default when omitted). */
  temperature?: number;
}

/** A completion result — just the generated text plus provenance. */
export interface AiCompletionResult {
  /** The generated text (trimmed of surrounding whitespace). */
  text: string;
  /** The model that produced it. */
  model: string;
  /** The adapter name (always `ollama` today). */
  provider: string;
}

/** The result of a health / list-models probe (test-connection). */
export interface AiProviderHealth {
  /** Whether the endpoint answered the probe. */
  ok: boolean;
  /** The models the endpoint serves (empty on failure or none installed). */
  models: string[];
  /** Short, non-sensitive failure detail (e.g. `timeout`, `http 500`); null on success. */
  error: string | null;
}

/** Per-call resilience knobs. */
export interface AiCallOptions {
  /** Override the adapter's default timeout for this call, in ms. */
  timeoutMs?: number;
}

/**
 * The provider seam. An adapter targets exactly one endpoint + model, resolved
 * from the admin config at construction time (see the registry). All three
 * methods only ever reach {@link AiProvider.endpoint}.
 */
export interface AiProvider {
  /** Adapter name — `ollama`. */
  readonly name: string;
  /** The base URL this provider talks to (a single local host). */
  readonly endpoint: string;
  /** The model this provider generates with. */
  readonly model: string;
  /** Generate a completion for the request. */
  complete(request: AiCompletionRequest, opts?: AiCallOptions): Promise<AiCompletionResult>;
  /** List the models the endpoint serves (feeds the admin model picker). */
  listModels(opts?: AiCallOptions): Promise<string[]>;
  /** Probe reachability + list models, folded into one soft-failing result. */
  health(opts?: AiCallOptions): Promise<AiProviderHealth>;
}
