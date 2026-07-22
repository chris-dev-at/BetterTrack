import type { Logger } from '../../logger';
import { retryOnce } from '../../providers/resilience';
import type {
  AiCallOptions,
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderHealth,
} from './types';

/**
 * The ONE shipped AI adapter (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22): the
 * owner's local Ollama over its plain HTTP API. `fetch`-based, no SDK dependency,
 * and it only ever reaches the single admin-configured base URL — there is no
 * hardcoded or external host anywhere in this module (a test asserts it makes no
 * external calls).
 *
 * Resilience follows `providers/resilience.ts`: a bounded per-call timeout
 * (aborting the socket) and retry-once on the cheap control calls
 * (list-models / health). A completion is expensive and a local failure is
 * usually deterministic, so it is a single attempt — never a retried generation.
 */

/** Completion timeout — generous, a local model can take a while (§5.1 spirit). */
export const OLLAMA_COMPLETION_TIMEOUT_MS = 60_000;
/** Control-call timeout (list models / health) — short, like other probes. */
export const OLLAMA_CONTROL_TIMEOUT_MS = 5_000;

export interface CreateOllamaProviderDeps {
  /** Base URL of the Ollama endpoint (e.g. `http://ollama.lan:11434`). */
  endpoint: string;
  /** Model to generate with (e.g. `llama3.1:8b`). */
  model: string;
  /** Injectable fetch (tests + no-external-call enforcement). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/** Ollama's `/api/tags` payload (only the model names are used). */
interface OllamaTagsResponse {
  models?: Array<{ name?: string }>;
}

/** Ollama's `/api/chat` (stream:false) payload. */
interface OllamaChatResponse {
  message?: { role?: string; content?: string };
}

/** Short, non-sensitive detail for a failed probe (mirrors the monitoring probe). */
function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    return err.message || err.name || 'error';
  }
  return 'error';
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function createOllamaProvider(deps: CreateOllamaProviderDeps): AiProvider {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = stripTrailingSlash(deps.endpoint);
  const { model } = deps;

  /** One JSON call to the LOCAL endpoint, aborted on timeout. Never a redirect off-host. */
  async function callJson<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      // Never follow a redirect: a well-behaved local Ollama never issues one,
      // and refusing keeps every request pinned to the configured host.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return (await res.json()) as T;
  }

  async function listModels(opts?: AiCallOptions): Promise<string[]> {
    const timeout = opts?.timeoutMs ?? OLLAMA_CONTROL_TIMEOUT_MS;
    const body = await retryOnce(() =>
      callJson<OllamaTagsResponse>('/api/tags', { method: 'GET' }, timeout),
    );
    return (body.models ?? [])
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((name) => name.length > 0);
  }

  async function health(opts?: AiCallOptions): Promise<AiProviderHealth> {
    try {
      const models = await listModels(opts);
      return { ok: true, models, error: null };
    } catch (err) {
      deps.logger?.warn({ err, endpoint: base }, 'ollama health probe failed');
      return { ok: false, models: [], error: errorDetail(err) };
    }
  }

  async function complete(
    request: AiCompletionRequest,
    opts?: AiCallOptions,
  ): Promise<AiCompletionResult> {
    const timeout = opts?.timeoutMs ?? OLLAMA_COMPLETION_TIMEOUT_MS;
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push({ role: 'user', content: request.prompt });

    const body = await callJson<OllamaChatResponse>(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          ...(request.temperature !== undefined
            ? { options: { temperature: request.temperature } }
            : {}),
        }),
      },
      timeout,
    );

    const text = body.message?.content;
    if (typeof text !== 'string') throw new Error('ollama returned no message content');
    return { text: text.trim(), model, provider: 'ollama' };
  }

  return { name: 'ollama', endpoint: base, model, complete, listModels, health };
}
