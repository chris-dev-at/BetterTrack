import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { Logger } from '../../logger';
import { retryOnce } from '../../providers/resilience';
import {
  createPinnedAgent,
  type OutboundUrlResolver,
  type ResolvedOutboundUrl,
} from '../security/outboundUrlGuard';
import {
  AiInvalidResponseError,
  AiResponseStatusError,
  providerErrorDetail,
  redactEndpoint,
  resolveLocalAiEndpoint,
} from './endpointPolicy';
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
 * ## The endpoint is guarded on EVERY call, not once at construction (#1656)
 *
 * "Only ever reaches the configured endpoint" was true and insufficient: nothing
 * constrained what the configured endpoint WAS. `assertSafeOutboundUrl` could
 * not simply be dropped in — it demands https + a PUBLIC address, the exact
 * inverse of a LAN Ollama — so the guard grew the local-only policy
 * (`LOCAL_AI_ENDPOINT_URL_POLICY`) and this adapter applies it immediately
 * before every single fetch, through `resolveLocalAiEndpoint`.
 *
 * Per-call, not per-construction, because a HOSTNAME's address is only knowable
 * at resolution time: an endpoint that answered `10.0.0.5` when the admin saved
 * it can answer a collector's public address on the next lookup, and a guard
 * that ran once at save time would never see it. The cost is one resolver call
 * per request (none at all for a literal address, which the guard short-circuits)
 * against a completion that takes seconds on a local model.
 *
 * ## …and the vetted address is PINNED into the socket
 *
 * Vetting and then handing the HOSTNAME to `fetch` is not a pin. It is two
 * independent `getaddrinfo` calls per request, and a zone answering with TTL 0
 * can hand a different address to each of them deterministically — so the guard
 * approves `10.0.0.5` and the socket lands wherever the second answer points.
 * The guard says as much at {@link createPinnedAgent} ("callers must pin
 * `addresses` into the actual connection"), and `webhookDispatcher.ts` already
 * obeys it; this adapter was the one caller that did not (#1992 review).
 *
 * So the production transport is `node:http`/`node:https` over a single-use
 * agent whose socket lookup can only ever answer with the address set the guard
 * just approved. The request keeps its ORIGINAL hostname, which is why the agent
 * is pinned instead of the URL being rewritten to the vetted literal: undici
 * overwrites a caller-set `Host` header (measured), so a rewrite would silently
 * break any endpoint served behind a name-based reverse proxy, while a pinned
 * agent preserves `Host` and, for `https:`, SNI and certificate verification.
 * `node:http` never follows redirects, so the redirect pivot is closed by
 * construction rather than by a flag.
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
  /**
   * Injectable fetch — a TEST seam only (canned payloads + no-external-call
   * enforcement). Left undefined in production, where the transport is the
   * guard-pinned `node:http` path below; `ollamaPinnedTransport.test.ts` covers
   * that path over a real socket, and everything either path shares (the
   * fetch-time guard, the status check, the JSON handling) is one function.
   */
  fetchImpl?: typeof fetch;
  /**
   * DNS resolver for the fetch-time egress guard. Defaults to the system
   * resolver; a test injects a stub so a rebinding hostname is deterministic and
   * the suite stays offline.
   */
  resolver?: OutboundUrlResolver;
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

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Hard ceiling on a response body. A local model's JSON reply is kilobytes; this
 * only exists so a misconfigured or hostile endpoint cannot make the API buffer
 * without bound (the same reason `oauthLogo.ts` caps its download).
 */
export const OLLAMA_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** What either transport returns: a status and the raw body text. */
interface OllamaRawResponse {
  status: number;
  body: string;
}

/**
 * One request over a single-use agent pinned to the addresses the guard just
 * approved — the production transport.
 *
 * Structural failures only: a socket error is re-raised as-is so
 * `providerErrorDetail` can read its `code` (ECONNREFUSED vs ENOTFOUND is the
 * one diagnostic that separates "wrong port" from "wrong host"), and nothing
 * derived from the body ever becomes an error message.
 */
function pinnedRequest(
  target: ResolvedOutboundUrl,
  init: RequestInit,
  timeoutMs: number,
): Promise<OllamaRawResponse> {
  const agent = createPinnedAgent(target);
  const send = target.url.protocol === 'http:' ? httpRequest : httpsRequest;
  const payload = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : null;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
    ...(payload ? { 'content-length': String(payload.byteLength) } : {}),
  };

  return new Promise<OllamaRawResponse>((resolve, reject) => {
    // One shared cell so whichever of the response, the error or the deadline
    // settles first clears the other two.
    const attempt: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };
    const finish = (
      outcome: { ok: true; value: OllamaRawResponse } | { ok: false; err: unknown },
    ) => {
      if (attempt.settled) return;
      attempt.settled = true;
      if (attempt.timer !== undefined) clearTimeout(attempt.timer);
      agent.destroy();
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.err);
    };

    const req = send(target.url, { method: init.method ?? 'GET', agent, headers });

    attempt.timer = setTimeout(() => {
      // Named so `providerErrorDetail` reports `timeout`, exactly as the
      // `AbortSignal.timeout` path did.
      const timeout = Object.assign(new Error('ollama request timed out'), {
        name: 'TimeoutError',
      });
      req.destroy(timeout);
      finish({ ok: false, err: timeout });
    }, timeoutMs);

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > OLLAMA_MAX_RESPONSE_BYTES) {
          res.destroy(new Error('ollama response exceeded the size cap'));
          return;
        }
        chunks.push(chunk);
      });
      res.once('end', () =>
        finish({
          ok: true,
          value: {
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks, size).toString('utf8'),
          },
        }),
      );
      res.once('error', (err) => finish({ ok: false, err }));
    });
    req.once('error', (err) => finish({ ok: false, err }));
    if (payload) req.end(payload);
    else req.end();
  });
}

/** The test transport: the injected `fetch`, reduced to the same raw shape. */
async function fetchRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<OllamaRawResponse> {
  const res = await fetchImpl(url, {
    ...init,
    // Never follow a redirect: a well-behaved local Ollama never issues one,
    // and refusing keeps every request pinned to the configured host. (The
    // production path gets this for free — `node:http` never redirects.)
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: await res.text() };
}

export function createOllamaProvider(deps: CreateOllamaProviderDeps): AiProvider {
  const base = stripTrailingSlash(deps.endpoint);
  const { model } = deps;
  /** The only spelling of the endpoint allowed to reach a log line (#1656). */
  const loggableEndpoint = redactEndpoint(base);

  /** One JSON call to the LOCAL endpoint, aborted on timeout. Never a redirect off-host. */
  async function callJson<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const url = `${base}${path}`;
    // The egress guard, immediately before the socket. Refuses a public,
    // metadata, or deployment-internal destination even when the STORED string
    // looked private — the address behind a hostname is only knowable here. Its
    // answer is then PINNED into the connection, so the socket cannot resolve
    // the name a second time and land somewhere else.
    const target = await resolveLocalAiEndpoint(url, { resolver: deps.resolver });
    const res = deps.fetchImpl
      ? await fetchRequest(deps.fetchImpl, url, init, timeoutMs)
      : await pinnedRequest(target, init, timeoutMs);

    if (res.status < 200 || res.status >= 300) throw new AiResponseStatusError(res.status);
    // A 2xx is not a promise of JSON. `JSON.parse` throws a `SyntaxError` whose
    // message quotes the first ~30 characters of whatever the target sent, and
    // that message used to travel verbatim into the admin UI — so the parse
    // failure is converted to an error that carries nothing from the body.
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new AiInvalidResponseError();
    }
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
      // The DETAIL, not the error: a fetch failure's message can carry the
      // request URL (credentials and all, for a row written before the write
      // path refused them), and the endpoint is logged only in its redacted
      // form. `detail` is a closed set, so this line cannot grow a leak.
      deps.logger?.warn(
        { detail: providerErrorDetail(err), endpoint: loggableEndpoint },
        'ollama health probe failed',
      );
      return { ok: false, models: [], error: providerErrorDetail(err) };
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
    if (typeof text !== 'string') throw new AiInvalidResponseError();
    return { text: text.trim(), model, provider: 'ollama' };
  }

  // The exposed `endpoint` is the redacted spelling (the raw one stays closed
  // over inside this factory): it is a descriptive field, and a descriptive
  // field is exactly what ends up in a diagnostic someone pastes somewhere.
  return {
    name: 'ollama',
    endpoint: loggableEndpoint ?? base,
    model,
    complete,
    listModels,
    health,
  };
}
