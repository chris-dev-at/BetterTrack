import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_CREDENTIAL_SERVICES,
  CLAUDE_FACTORY_ENV_PROFILE,
  createClaudeCredentialStore,
  extractClaudeSetupToken,
  redactClaudeSetupToken,
} from './claude-credentials.mjs';

const TOKEN_ONE = 'sk-ant-oat01-account_one-secret-123456';
const TOKEN_TWO = 'sk-ant-oat01-account_two-secret-654321';

async function withAuthRoot(run) {
  const authRoot = await mkdtemp(join(tmpdir(), 'bettertrack-claude-credentials-'));
  try {
    await run(authRoot);
  } finally {
    await rm(authRoot, { recursive: true, force: true });
  }
}

async function mode(path) {
  return (await stat(path)).mode & 0o777;
}

test('extracts one setup token from pasted Claude output and redacts all tokens', () => {
  const pasted = `Claude setup-token complete.\nOAuth token: ${TOKEN_ONE}\nKeep it private.`;
  assert.equal(extractClaudeSetupToken(pasted), TOKEN_ONE);
  assert.equal(
    redactClaudeSetupToken(`${TOKEN_ONE}\nthen ${TOKEN_TWO}`),
    '[REDACTED]\nthen [REDACTED]',
  );

  for (const value of ['', 'not-a-token', `${TOKEN_ONE}\n${TOKEN_TWO}`]) {
    assert.throws(
      () => extractClaudeSetupToken(value),
      (error) => {
        assert.equal(error.message.includes(TOKEN_ONE), false);
        assert.equal(error.message.includes(TOKEN_TWO), false);
        return true;
      },
    );
  }
});

test('saves opaque named profiles with private modes and exposes metadata only', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const first = await store.save({
      name: 'Main Claude',
      setupToken: `Paste this token into the app: ${TOKEN_ONE}`,
    });
    const second = await store.save({ name: 'Factory Claude', setupToken: TOKEN_TWO });

    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.notEqual(first.id, second.id);
    assert.equal(first.name, 'Main Claude');

    const state = await store.list();
    assert.deepEqual(
      state.profiles.map(({ id, name }) => ({ id, name })),
      [
        { id: first.id, name: 'Main Claude' },
        { id: second.id, name: 'Factory Claude' },
      ],
    );
    assert.deepEqual(state.assignments, {
      default: CLAUDE_FACTORY_ENV_PROFILE,
      master: null,
      'worker-1': null,
      'worker-2': null,
      'worker-3': null,
      'worker-4': null,
    });
    const publicJson = JSON.stringify(state);
    assert.equal(publicJson.includes(TOKEN_ONE), false);
    assert.equal(publicJson.includes(TOKEN_TWO), false);
    assert.equal(Object.hasOwn(state.profiles[0], 'token'), false);
    assert.equal(Object.hasOwn(state.profiles[0], 'setupToken'), false);

    const vault = join(authRoot, '.claude-credentials');
    const firstProfileDirectory = join(vault, 'profiles', first.id);
    const firstTokenPath = join(firstProfileDirectory, 'oauth-token');
    assert.equal((await readFile(firstTokenPath, 'utf8')).trim(), TOKEN_ONE);
    assert.equal(await mode(authRoot), 0o700);
    assert.equal(await mode(vault), 0o700);
    assert.equal(await mode(join(vault, 'profiles')), 0o700);
    assert.equal(await mode(firstProfileDirectory), 0o700);
    assert.equal(await mode(firstTokenPath), 0o600);
    assert.equal(await mode(join(vault, 'state.json')), 0o600);

    assert.equal(await store.tokenForProfile(first.id), TOKEN_ONE);
  });
});

test('default and service assignments materialize the selected credential atomically', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const first = await store.save({ name: 'Primary', setupToken: TOKEN_ONE });
    const second = await store.save({ name: 'Second account', setupToken: TOKEN_TWO });

    let state = await store.assign({ target: 'default', profileId: first.id });
    assert.equal(state.assignments.default, first.id);
    for (const service of CLAUDE_CREDENTIAL_SERVICES) {
      const claudeRoot = join(authRoot, service, 'claude');
      assert.equal((await readFile(join(claudeRoot, 'oauth-token'), 'utf8')).trim(), TOKEN_ONE);
      assert.deepEqual(JSON.parse(await readFile(join(claudeRoot, 'profile.json'), 'utf8')), {
        version: 1,
        source: 'profile',
        profileId: first.id,
        name: 'Primary',
      });
      assert.equal(await mode(join(authRoot, service)), 0o700);
      assert.equal(await mode(claudeRoot), 0o700);
      assert.equal(await mode(join(claudeRoot, 'oauth-token')), 0o600);
      assert.equal(await mode(join(claudeRoot, 'profile.json')), 0o600);
    }

    state = await store.assign({ target: 'worker-2', profileId: second.id });
    assert.equal(state.assignments['worker-2'], second.id);
    assert.equal(await store.tokenForService('worker-2'), TOKEN_TWO);
    assert.equal(await store.tokenForService('master'), TOKEN_ONE);
    assert.equal(
      (await readFile(join(authRoot, 'worker-2', 'claude', 'oauth-token'), 'utf8')).trim(),
      TOKEN_TWO,
    );

    state = await store.assign({
      target: 'worker-2',
      profileId: CLAUDE_FACTORY_ENV_PROFILE,
    });
    assert.equal(state.assignments['worker-2'], CLAUDE_FACTORY_ENV_PROFILE);
    assert.equal(await store.tokenForService('worker-2'), null);
    await assert.rejects(readFile(join(authRoot, 'worker-2', 'claude', 'oauth-token'), 'utf8'), {
      code: 'ENOENT',
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(authRoot, 'worker-2', 'claude', 'profile.json'), 'utf8')),
      {
        version: 1,
        source: 'factory-env',
        profileId: null,
        name: 'Factory .env',
      },
    );

    await store.assign({ target: 'worker-2', profileId: null });
    assert.equal(await store.tokenForService('worker-2'), TOKEN_ONE);
    assert.equal(
      (await readFile(join(authRoot, 'worker-2', 'claude', 'oauth-token'), 'utf8')).trim(),
      TOKEN_ONE,
    );
    const leftovers = (await readdir(join(authRoot, 'worker-2', 'claude'))).filter((entry) =>
      entry.endsWith('.tmp'),
    );
    assert.deepEqual(leftovers, []);
  });
});

test('factory-env default removes inherited materialized tokens but preserves overrides', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const first = await store.save({ name: 'Primary', setupToken: TOKEN_ONE });
    const second = await store.save({ name: 'Dedicated worker', setupToken: TOKEN_TWO });
    await store.assign({ target: 'default', profileId: first.id });
    await store.assign({ target: 'worker-1', profileId: second.id });
    await store.assign({ target: 'default', profileId: CLAUDE_FACTORY_ENV_PROFILE });

    for (const service of ['master', 'worker-2', 'worker-3', 'worker-4']) {
      assert.equal(await store.tokenForService(service), null);
      await assert.rejects(readFile(join(authRoot, service, 'claude', 'oauth-token'), 'utf8'), {
        code: 'ENOENT',
      });
    }
    assert.equal(await store.tokenForService('worker-1'), TOKEN_TWO);
    assert.equal(
      (await readFile(join(authRoot, 'worker-1', 'claude', 'oauth-token'), 'utf8')).trim(),
      TOKEN_TWO,
    );
  });
});

test('removing a profile clears its assignments and leaves no selected secret behind', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const profile = await store.save({ name: 'Disposable', setupToken: TOKEN_ONE });
    await store.assign({ target: 'default', profileId: profile.id });
    const state = await store.remove(profile.id);

    assert.deepEqual(state.profiles, []);
    assert.equal(state.assignments.default, CLAUDE_FACTORY_ENV_PROFILE);
    assert.equal(JSON.stringify(state).includes(TOKEN_ONE), false);
    await assert.rejects(
      readFile(
        join(authRoot, '.claude-credentials', 'profiles', profile.id, 'oauth-token'),
        'utf8',
      ),
      { code: 'ENOENT' },
    );
    for (const service of CLAUDE_CREDENTIAL_SERVICES) {
      assert.equal(await store.tokenForService(service), null);
      await assert.rejects(readFile(join(authRoot, service, 'claude', 'oauth-token'), 'utf8'), {
        code: 'ENOENT',
      });
    }
  });
});

test('renames a profile without changing its credential or lane assignments', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const profile = await store.save({ name: 'Old label', setupToken: TOKEN_ONE });
    await store.assign({ target: 'master', profileId: profile.id });

    const state = await store.renameProfile({
      profileId: profile.id,
      name: 'New label',
    });

    assert.equal(state.profiles[0].id, profile.id);
    assert.equal(state.profiles[0].name, 'New label');
    assert.equal(state.profiles[0].createdAt, profile.createdAt);
    assert.equal(state.assignments.master, profile.id);
    assert.equal(await store.tokenForProfile(profile.id), TOKEN_ONE);
    assert.equal(await store.tokenForService('master'), TOKEN_ONE);
    assert.deepEqual(
      JSON.parse(await readFile(join(authRoot, 'master', 'claude', 'profile.json'), 'utf8')),
      {
        version: 1,
        source: 'profile',
        profileId: profile.id,
        name: 'New label',
      },
    );
    assert.equal(JSON.stringify(state).includes(TOKEN_ONE), false);
  });
});

test('separate store instances serialize writes without losing a profile', async () => {
  await withAuthRoot(async (authRoot) => {
    const firstStore = createClaudeCredentialStore({ authRoot });
    const secondStore = createClaudeCredentialStore({ authRoot });
    await Promise.all([
      firstStore.save({ name: 'Concurrent one', setupToken: TOKEN_ONE }),
      secondStore.save({ name: 'Concurrent two', setupToken: TOKEN_TWO }),
    ]);

    const state = await firstStore.list();
    assert.deepEqual(state.profiles.map((profile) => profile.name).sort(), [
      'Concurrent one',
      'Concurrent two',
    ]);
  });
});

test('expired lock lease recovers even when its PID has been reused', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({
      authRoot,
      lockWaitMs: 200,
      lockLeaseMs: 10,
      lockRecoveryGraceMs: 0,
    });
    await store.list();
    const lockRoot = join(authRoot, '.claude-credentials', '.store-lock');
    await mkdir(lockRoot);
    await writeFile(
      join(lockRoot, 'owner.json'),
      `${JSON.stringify({
        id: 'stale-owner',
        pid: process.pid,
        createdAt: '2000-01-01T00:00:00.000Z',
      })}\n`,
    );

    const state = await store.list();
    assert.equal(state.version, 1);
    await assert.rejects(stat(lockRoot), { code: 'ENOENT' });
  });
});

test('an unavailable selected token rolls back the assignment and materialization', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const profile = await store.save({ name: 'Unavailable', setupToken: TOKEN_ONE });
    await rm(join(authRoot, '.claude-credentials', 'profiles', profile.id, 'oauth-token'), {
      force: true,
    });

    await assert.rejects(
      store.assign({ target: 'master', profileId: profile.id }),
      (error) => error.code === 'MATERIALIZE_FAILED',
    );
    const state = await store.list();
    assert.equal(state.assignments.master, null);
    await assert.rejects(readFile(join(authRoot, 'master', 'claude', 'oauth-token'), 'utf8'), {
      code: 'ENOENT',
    });
    const marker = JSON.parse(
      await readFile(join(authRoot, 'master', 'claude', 'profile.json'), 'utf8'),
    );
    assert.equal(marker.source, CLAUDE_FACTORY_ENV_PROFILE);
    assert.equal(marker.status, undefined);
    assert.equal(JSON.stringify(marker).includes(TOKEN_ONE), false);
    assert.equal(await store.tokenForService('master'), null);
  });
});

test('factory-env transition publishes an unavailable marker before removing an old token', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const profile = await store.save({ name: 'Previous account', setupToken: TOKEN_ONE });
    await store.assign({ target: 'default', profileId: profile.id });
    const tokenPath = join(authRoot, 'master', 'claude', 'oauth-token');
    await rm(tokenPath, { force: true });
    await mkdir(tokenPath);

    await assert.rejects(
      store.assign({ target: 'default', profileId: CLAUDE_FACTORY_ENV_PROFILE }),
      (error) => error.code === 'MATERIALIZE_FAILED',
    );
    const state = await store.list();
    assert.equal(state.assignments.default, profile.id);
    const marker = JSON.parse(
      await readFile(join(authRoot, 'master', 'claude', 'profile.json'), 'utf8'),
    );
    assert.equal(marker.source, 'unavailable');
    assert.equal(marker.status, 'unavailable');
    await assert.rejects(store.tokenForService('master'), {
      code: 'MATERIALIZATION_UNAVAILABLE',
    });
  });
});

test('rejects traversal, unknown profiles, unsafe names, and never echoes tokens', async () => {
  await withAuthRoot(async (authRoot) => {
    const store = createClaudeCredentialStore({ authRoot });
    const profile = await store.save({ name: 'Safe profile', setupToken: TOKEN_ONE });
    const calls = [
      () => store.materialize('../master'),
      () => store.tokenForService('worker-5'),
      () => store.tokenForProfile('../state.json'),
      () =>
        store.assign({
          target: 'worker-1',
          profileId: '00000000-0000-4000-8000-000000000000',
        }),
      () => store.assign({ target: '../default', profileId: profile.id }),
      () => store.save({ name: `oops ${TOKEN_TWO}`, setupToken: TOKEN_TWO }),
      () => store.save({ name: 'Two pasted tokens', setupToken: `${TOKEN_ONE} ${TOKEN_TWO}` }),
    ];

    for (const call of calls) {
      await assert.rejects(
        async () => call(),
        (error) => {
          const publicError = JSON.stringify({
            code: error.code,
            message: error.message,
          });
          assert.equal(publicError.includes(TOKEN_ONE), false);
          assert.equal(publicError.includes(TOKEN_TWO), false);
          return true;
        },
      );
    }
  });
});

test('a symlinked auth root is followed, while a symlinked vault is still refused', async () => {
  await withAuthRoot(async (realRoot) => {
    // The deploy worktree reaches the vault through a symlink on purpose.
    // Condemning it emptied the accounts panel and dropped every lane back to
    // the legacy .env account, with nothing in the log to say why.
    const linkParent = await mkdtemp(join(tmpdir(), 'bettertrack-claude-credentials-link-'));
    const linkedRoot = join(linkParent, 'auth');
    try {
      await symlink(realRoot, linkedRoot, 'dir');

      const viaLink = createClaudeCredentialStore({ authRoot: linkedRoot });
      const profile = await viaLink.save({ name: 'ChrisiWiesi', setupToken: TOKEN_ONE });
      assert.equal((await viaLink.list()).profiles.length, 1);

      // Same vault, reached directly: the link is a route, not a second store.
      const direct = createClaudeCredentialStore({ authRoot: realRoot });
      assert.deepEqual(
        (await direct.list()).profiles.map((entry) => entry.name),
        ['ChrisiWiesi'],
      );
      assert.equal(await direct.tokenForProfile(profile.id), TOKEN_ONE);
    } finally {
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  // The guard that matters is untouched: swapping the vault directory itself
  // for a symlink would redirect credential material, so it stays fatal.
  await withAuthRoot(async (authRoot) => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'bettertrack-claude-credentials-vault-'));
    try {
      await symlink(elsewhere, join(authRoot, '.claude-credentials'), 'dir');
      await assert.rejects(
        async () => createClaudeCredentialStore({ authRoot }).list(),
        (error) => {
          assert.equal(error.code, 'UNSAFE_STORAGE');
          return true;
        },
      );
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
