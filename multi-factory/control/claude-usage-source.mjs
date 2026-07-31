// Quota telemetry needs a credential the inference path does not have.
//
// `claude setup-token` mints an inference-only credential: its scopes are
// `user:inference` and friends, and `GET /api/oauth/usage` answers such a token
// with 403 `permission_error` ("OAuth token does not meet scope requirements").
// Reading quota requires `user:profile`, which only a full interactive Claude
// Code login carries. So the dashboard cannot show limits from the same token
// the factory runs on, and no amount of retrying changes that — the 429s seen
// while diagnosing this were a separate rate limit sitting in front of the 403.
//
// The interactive login on this machine does have the scope, and Claude Code
// keeps it refreshed in the macOS Keychain. We read it there at poll time
// rather than copying it into the factory vault: nothing extra to store, the
// refresh is somebody else's job, and revoking the login revokes telemetry.
//
// A read is only used for an account the owner explicitly bound to it, and only
// while the signed-in identity still matches that binding — otherwise logging in
// as the other account would silently report one account's quota under the
// other's name.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

export const USAGE_SCOPE = 'user:profile';
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HOST_CREDENTIAL_TTL = 60_000;
const IDENTITY_TTL = 600_000;

export function parseHostCredential(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth || parsed?.oauth || null;
  if (!oauth || typeof oauth !== 'object') return null;
  const accessToken = typeof oauth.accessToken === 'string' ? oauth.accessToken : '';
  if (!accessToken) return null;
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((s) => typeof s === 'string') : [];
  const expiresAt = Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null;
  return { accessToken, scopes, expiresAt };
}

export function credentialUsable(credential, now = Date.now()) {
  if (!credential?.accessToken) return false;
  if (!credential.scopes.includes(USAGE_SCOPE)) return false;
  // Claude Code refreshes in place; a token already past expiry means nothing
  // has refreshed it and the API would reject it anyway.
  return credential.expiresAt == null || credential.expiresAt > now;
}

export function credentialState(credential, now = Date.now()) {
  if (!credential?.accessToken) return 'absent';
  if (!credential.scopes.includes(USAGE_SCOPE)) return 'unscoped';
  if (credential.expiresAt != null && credential.expiresAt <= now) return 'expired';
  return 'ready';
}

function runSecurity(exec) {
  return new Promise((resolve) => {
    exec(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 5000, maxBuffer: 1 << 20 },
      (error, stdout) => resolve(error ? null : String(stdout || '').trim()),
    );
  });
}

export function createHostUsageSource({
  exec = execFile,
  now = () => Date.now(),
  fetchImpl = fetch,
} = {}) {
  // `at: -Infinity` rather than 0: a zero timestamp reads as "cached a moment
  // ago" under any small clock and would serve the empty cache forever.
  let credentialCache = { at: -Infinity, value: null };
  let identityCache = { at: -Infinity, token: '', value: null };

  async function credential() {
    if (now() - credentialCache.at < HOST_CREDENTIAL_TTL) return credentialCache.value;
    const raw = await runSecurity(exec);
    credentialCache = { at: now(), value: raw ? parseHostCredential(raw) : null };
    return credentialCache.value;
  }

  // Which account is signed in. Cached against the token itself so a re-login
  // as a different account invalidates it immediately rather than after a TTL.
  async function identity() {
    const cred = await credential();
    if (!credentialUsable(cred, now())) return null;
    if (identityCache.token === cred.accessToken && now() - identityCache.at < IDENTITY_TTL)
      return identityCache.value;
    let value = null;
    try {
      const res = await fetchImpl('https://api.anthropic.com/api/oauth/profile', {
        headers: {
          authorization: `Bearer ${cred.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = await res.json();
        const email = body?.account?.email_address || body?.account?.email || null;
        if (typeof email === 'string' && email) value = { email };
      }
    } catch {
      // An unreachable profile endpoint must not strand telemetry: report no
      // identity, which reads as "not bound" rather than as the wrong account.
    }
    identityCache = { at: now(), token: cred.accessToken, value };
    return value;
  }

  return {
    credential,
    identity,
    async state() {
      return credentialState(await credential(), now());
    },
    // The access token for a bound account, or null with the reason why not.
    async tokenFor(boundEmail) {
      const cred = await credential();
      const state = credentialState(cred, now());
      if (state !== 'ready') return { token: null, reason: state };
      if (!boundEmail) return { token: null, reason: 'unbound' };
      const who = await identity();
      if (!who) return { token: null, reason: 'identity-unknown' };
      if (who.email !== boundEmail) return { token: null, reason: 'other-account', signedInAs: who.email };
      return { token: cred.accessToken, reason: 'ready', signedInAs: who.email };
    },
  };
}

// Bindings live beside the vault but in their own file: they hold no secret,
// only "this profile's quota is readable through the signed-in login", and
// keeping them out of the credential store avoids taking its cross-process lock
// on every dashboard poll.
export function bindingsFile(authRoot) {
  return join(authRoot, '.claude-credentials', 'usage-bindings.json');
}

export function sanitizeBindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [profileId, entry] of Object.entries(value.bindings || {})) {
    const email = typeof entry?.email === 'string' ? entry.email.slice(0, 320) : '';
    if (!email) continue;
    out[profileId] = { email, linkedAt: typeof entry.linkedAt === 'string' ? entry.linkedAt : null };
  }
  return out;
}

export async function readBindings(file) {
  try {
    return sanitizeBindings(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return {};
  }
}

export async function writeBindings(file, bindings) {
  const payload = JSON.stringify({ version: 1, bindings }, null, 2);
  const tmp = join(dirname(file), `.usage-bindings.tmp${process.pid}`);
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, file);
  return bindings;
}
