import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  USAGE_SCOPE,
  bindingsFile,
  createHostUsageSource,
  credentialState,
  credentialUsable,
  parseHostCredential,
  readBindings,
  sanitizeBindings,
  writeBindings,
} from './claude-usage-source.mjs';

const KEYCHAIN = (scopes, expiresAt) =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'host-access-token', scopes, expiresAt } });

const execStub =
  (payload, error = null) =>
  (_bin, _args, _opts, cb) =>
    cb(error, payload, '');

test('a keychain blob yields the access token, its scopes and its expiry', () => {
  const cred = parseHostCredential(KEYCHAIN([USAGE_SCOPE, 'user:inference'], 4_000));
  assert.equal(cred.accessToken, 'host-access-token');
  assert.deepEqual(cred.scopes, [USAGE_SCOPE, 'user:inference']);
  assert.equal(cred.expiresAt, 4_000);
  assert.equal(parseHostCredential('not json'), null);
  assert.equal(parseHostCredential(JSON.stringify({ claudeAiOauth: {} })), null);
});

test('only a profile-scoped, unexpired credential can read quota', () => {
  const now = 1_000;
  // This is the whole reason the panel was blank: setup tokens are inference-only
  // and /api/oauth/usage answers them 403, so they must never be attempted.
  assert.equal(credentialUsable(parseHostCredential(KEYCHAIN(['user:inference'], 9_000)), now), false);
  assert.equal(credentialState(parseHostCredential(KEYCHAIN(['user:inference'], 9_000)), now), 'unscoped');
  assert.equal(credentialState(parseHostCredential(KEYCHAIN([USAGE_SCOPE], 500)), now), 'expired');
  assert.equal(credentialState(parseHostCredential(KEYCHAIN([USAGE_SCOPE], 9_000)), now), 'ready');
  assert.equal(credentialState(null, now), 'absent');
  assert.equal(credentialUsable(parseHostCredential(KEYCHAIN([USAGE_SCOPE], null)), now), true);
});

test('a bound account gets the token only while that account is the one signed in', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ account: { email_address: 'first@example.com' } }),
  });
  const source = createHostUsageSource({
    exec: execStub(KEYCHAIN([USAGE_SCOPE], 9_999_999)),
    now: () => 1_000,
    fetchImpl,
  });
  assert.equal((await source.tokenFor('first@example.com')).token, 'host-access-token');
  // Signing in as the other account must not report its quota under this
  // account's name — that is worse than showing nothing.
  const wrong = await source.tokenFor('second@example.com');
  assert.equal(wrong.token, null);
  assert.equal(wrong.reason, 'other-account');
  assert.equal(wrong.signedInAs, 'first@example.com');
  assert.equal((await source.tokenFor(null)).reason, 'unbound');
});

test('an unreadable keychain or profile endpoint degrades to a reason, never a wrong number', async () => {
  const noKeychain = createHostUsageSource({
    exec: execStub(null, new Error('not found')),
    now: () => 1_000,
  });
  assert.equal((await noKeychain.tokenFor('a@example.com')).reason, 'absent');

  const unscoped = createHostUsageSource({
    exec: execStub(KEYCHAIN(['user:inference'], 9_999_999)),
    now: () => 1_000,
  });
  assert.equal((await unscoped.tokenFor('a@example.com')).reason, 'unscoped');

  const profileDown = createHostUsageSource({
    exec: execStub(KEYCHAIN([USAGE_SCOPE], 9_999_999)),
    now: () => 1_000,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  const result = await profileDown.tokenFor('a@example.com');
  assert.equal(result.token, null);
  assert.equal(result.reason, 'identity-unknown');
});

test('bindings persist without secrets and survive a corrupt file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mf-usage-binding-'));
  try {
    const file = join(dir, 'usage-bindings.json');
    await writeBindings(file, { 'profile-1': { email: 'a@example.com', linkedAt: '2026-07-31T00:00:00Z' } });
    const back = await readBindings(file);
    assert.deepEqual(back, { 'profile-1': { email: 'a@example.com', linkedAt: '2026-07-31T00:00:00Z' } });
    const raw = await readFile(file, 'utf8');
    assert.doesNotMatch(raw, /accessToken|sk-ant/);
    assert.deepEqual(await readBindings(join(dir, 'missing.json')), {});
    assert.deepEqual(sanitizeBindings({ bindings: { x: { email: 42 } } }), {});
    assert.deepEqual(sanitizeBindings(null), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the bindings file sits beside the vault, not inside the dashboard tree', () => {
  assert.equal(bindingsFile('/auth'), '/auth/.claude-credentials/usage-bindings.json');
});
