import {
  LOCAL_AI_ENDPOINT_URL_POLICY,
  UnsafeOutboundUrlError,
  isOutboundPolicyRefusal,
  resolveSafeOutboundUrl,
  type OutboundUrlResolver,
  type ResolvedOutboundUrl,
} from '../security/outboundUrlGuard';
import { AiEndpointNotLocalError } from './errors';

/**
 * Everything the AI layer needs to keep its ONE admin-writable field — the
 * Ollama endpoint — inside the boundary §16 2026-07-22 drew around it: "every AI
 * feature runs on the local Ollama (internal network only, never publicly
 * exposed)". Three concerns, deliberately in one small module because they are
 * one rule seen from three sides (#1656):
 *
 *  1. {@link resolveLocalAiEndpoint} — the egress guard, applied through the
 *     shared `outboundUrlGuard` under {@link LOCAL_AI_ENDPOINT_URL_POLICY}. It
 *     runs at WRITE time (so a public endpoint is never stored) and again
 *     immediately before EVERY fetch (so a hostname that resolved privately at
 *     write time and publicly later is refused at the moment it matters). There
 *     is no second address classifier here: the policy is the guard's.
 *  2. {@link redactEndpoint} — the credential rule on every way OUT. The write
 *     path already refuses userinfo (`packages/contracts/src/ai.ts`), so this is
 *     for the rows written BEFORE it did, and for the defence-in-depth position
 *     that a credential must not be able to reach a response body, an audit row
 *     or a log line even if a validator regresses.
 *  3. {@link providerErrorDetail} — the closed set of failure tokens the admin
 *     diagnostics may report. A failure detail is a value the ADMIN reads, but
 *     it is derived from something the TARGET said, so it is never passed
 *     through: `res.json()`'s `SyntaxError` carries a ~30-character excerpt of
 *     the upstream body, and a `fetch` TypeError's message can carry the URL.
 */

/** The endpoint is not a URL we recognise, so nothing about it can be trusted. */
const UNPARSEABLE = null;

/** The schemes the write path allows — mirrors `packages/contracts/src/ai.ts`. */
const ENDPOINT_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The endpoint with any embedded credentials removed — the only form allowed to
 * leave this process (response body, audit `meta`, log line).
 *
 * Returns `null` for a string that is not a URL. That is the fail-closed answer:
 * a value we cannot parse is a value whose userinfo we cannot find, so it must
 * not be echoed on the guess that it has none.
 *
 * The host is deliberately KEPT. `endpoint` is not a secret key and must not
 * become one — `logger.ts`'s `SECRET_KEYS` is whole-key and shared with
 * `auditRedaction.ts`, so adding `endpoint` there would blank the audit diff
 * ("the local endpoint moved from A to B") that §6.12 exists to record, and
 * would silence the same key across every unrelated caller in the repo. The
 * credential is what must go; the destination is what an auditor needs.
 */
export function redactEndpoint(endpoint: string | null | undefined): string | null {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return UNPARSEABLE;
  }
  // A scheme outside the write policy reads as unset, not as something to echo.
  // `new URL` parses far more than it looks like it does: `svc:s3cr3t@host`
  // succeeds — scheme `svc:`, path `s3cr3t@host` — so `username`/`password` are
  // both empty and the credential would sail through the check below untouched.
  if (!ENDPOINT_PROTOCOLS.has(url.protocol)) return UNPARSEABLE;
  if (url.username === '' && url.password === '') return endpoint;
  url.username = '';
  url.password = '';
  return url.toString();
}

export interface LocalAiEndpointGuardDeps {
  /** Test seam + the seam a caller with a pinned resolver uses. */
  resolver?: OutboundUrlResolver;
}

/**
 * Resolve and vet an endpoint against the local-AI policy.
 *
 * Throws {@link AiEndpointNotLocalError} (typed 400) when the destination is
 * refused BY POLICY — a public address, a cloud-metadata or otherwise blocked
 * range, one of the deployment's own service addresses, or a non-`http(s)`
 * scheme. Re-throws the guard's own {@link UnsafeOutboundUrlError} untouched
 * when the host merely failed to resolve right now, because "your DNS is down"
 * and "you pointed this at the internet" are different statements and only the
 * second is a permanent refusal (`isOutboundPolicyRefusal`).
 */
export async function resolveLocalAiEndpoint(
  endpoint: string,
  deps: LocalAiEndpointGuardDeps = {},
): Promise<ResolvedOutboundUrl> {
  try {
    return await resolveSafeOutboundUrl(endpoint, {
      ...LOCAL_AI_ENDPOINT_URL_POLICY,
      ...(deps.resolver ? { resolver: deps.resolver } : {}),
    });
  } catch (err) {
    if (isOutboundPolicyRefusal(err)) throw new AiEndpointNotLocalError();
    throw err;
  }
}

/**
 * Whether a write may proceed for this endpoint. Returns whether the address was
 * actually vetted, so the caller can say which of the two "allowed" outcomes it
 * got; throws {@link AiEndpointNotLocalError} when the destination is refused.
 *
 * A POLICY refusal blocks the write. A host that simply cannot be classified
 * right now does NOT: an admin configuring the box before powering it on, or
 * saving during a DNS blip, is a legitimate flow, and the fetch-time guard
 * refuses the request anyway if the name later answers with a public address.
 * Fail-open here is not a widening — nothing becomes reachable that the
 * fetch-time guard would not re-vet.
 *
 * ## Why the catch is "anything that is not a policy refusal"
 *
 * The first version of this caught {@link UnsafeOutboundUrlError} and rethrew
 * the rest, on the theory that an unresolvable host arrives as the guard's
 * `invalid_resolved_address`. It does not. `node:dns`'s `lookup` REJECTS on
 * NXDOMAIN with a plain `Error{code:'ENOTFOUND'}` and never returns the empty
 * array that branch needs, so in production that branch was unreachable and
 * every transient DNS condition escaped as a non-`ApiError` → 500. The flow this
 * fail-open exists to support — save the endpoint before the box exists — was
 * the exact flow it broke (#1992 review, blocker 1).
 *
 * So the predicate is the one the repo already uses for the same decision on the
 * webhook receiver (`webhookService.assertAllowedDestination`): a refusal is a
 * refusal, and EVERYTHING else is treated as "cannot classify right now". That
 * is fail-open on a write whose value is re-vetted before every single use, and
 * fail-closed on the use itself.
 */
export async function assertWritableLocalAiEndpoint(
  endpoint: string,
  deps: LocalAiEndpointGuardDeps = {},
): Promise<boolean> {
  try {
    await resolveLocalAiEndpoint(endpoint, deps);
    return true;
  } catch (err) {
    if (err instanceof AiEndpointNotLocalError) throw err;
    return false;
  }
}

/** A short error code shape (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, …). */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** The failure token for anything the closed set below cannot name. */
export const AI_DETAIL_UNREACHABLE = 'unreachable';
/** The endpoint was refused by the local-AI egress policy before any socket opened. */
export const AI_DETAIL_NOT_LOCAL = 'endpoint not local';
/** The endpoint answered 2xx with something that is not the JSON we asked for. */
export const AI_DETAIL_INVALID_RESPONSE = 'invalid response';

/**
 * A short, non-sensitive detail for a failed probe or completion — from a CLOSED
 * set, never from the upstream's own words (#1656 defect 3).
 *
 * `err.message` is the shape that leaked: `res.json()` rejects with a
 * `SyntaxError` whose message quotes the first ~30 characters of the response
 * body, and undici's `TypeError` for a failed connect can carry the request URL.
 * Both used to be copied verbatim into `AiTestConnectionResponse.error` and into
 * the process log. Error NAMES and `code`s carry no target data, so they are the
 * part kept — losing ECONNREFUSED-vs-ENOTFOUND would cost the admin the one
 * diagnostic that actually distinguishes "wrong port" from "wrong host".
 *
 * `http NNN` is produced by this module's own thrower, not by the target.
 */
export function providerErrorDetail(err: unknown): string {
  // Only a POLICY refusal is "not local". The guard's other failure —
  // `invalid_resolved_address`, i.e. the name gave us nothing to vet — is a
  // transient network condition and must not be reported as a configuration
  // error the admin has to go fix.
  if (isOutboundPolicyRefusal(err) || err instanceof AiEndpointNotLocalError) {
    return AI_DETAIL_NOT_LOCAL;
  }
  if (err instanceof UnsafeOutboundUrlError) return AI_DETAIL_UNREACHABLE;
  if (!(err instanceof Error)) return AI_DETAIL_UNREACHABLE;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  if (err instanceof AiResponseStatusError) return `http ${err.status}`;
  if (err instanceof AiInvalidResponseError) return AI_DETAIL_INVALID_RESPONSE;
  const code = errorCode(err) ?? errorCode(err.cause);
  return code ?? AI_DETAIL_UNREACHABLE;
}

function errorCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : null;
}

/** The endpoint answered with a non-2xx status. Carries only the status number. */
export class AiResponseStatusError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
    this.name = 'AiResponseStatusError';
  }
}

/**
 * The endpoint answered 2xx but the body was not the JSON shape expected.
 *
 * Carries NOTHING from the body — that is the whole point. The original parse
 * error is deliberately not chained either, because `providerErrorDetail` walks
 * `cause` looking for a code and a `SyntaxError` message must never become
 * reachable from there.
 */
export class AiInvalidResponseError extends Error {
  constructor() {
    super('The endpoint did not return the expected JSON.');
    this.name = 'AiInvalidResponseError';
  }
}
