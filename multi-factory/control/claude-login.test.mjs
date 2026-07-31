import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createClaudeLoginManager, scrubClaudeLoginEnv } from './claude-login.mjs';

const TOKEN = `sk-ant-oat01-${'a'.repeat(48)}`;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    queueMicrotask(() => this.emit('close', 143));
    return true;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('login environment removes every higher-precedence Claude credential', () => {
  const clean = scrubClaudeLoginEnv({
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_AUTH_TOKEN: 'secret',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    ANTHROPIC_BASE_URL: 'https://secret.invalid',
  });
  assert.deepEqual(clean, { PATH: '/bin' });
});

test('OAuth setup-token is captured without entering public state', async () => {
  const child = new FakeChild();
  const calls = [];
  const saved = [];
  const manager = createClaudeLoginManager({
    store: {
      async save(value) {
        saved.push(value);
        return { id: 'claude-abc123', name: value.name };
      },
    },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
    now: () => new Date('2026-07-30T12:00:00Z'),
  });

  assert.equal(manager.start({ name: 'Factory Claude' }).ok, true);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, ['setup-token']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  child.stdout.write(`Complete browser login\n${TOKEN}\n`);
  child.emit('close', 0);
  await settle();

  assert.deepEqual(saved, [{ name: 'Factory Claude', setupToken: TOKEN }]);
  const publicState = manager.publicState();
  assert.equal(publicState.status, 'completed');
  assert.equal(publicState.profileId, 'claude-abc123');
  assert.doesNotMatch(JSON.stringify(publicState), /sk-ant|oat01|a{16}/);
});

test('authorization code can be submitted without being retained', () => {
  const child = new FakeChild();
  let submitted = '';
  child.stdin.on('data', (chunk) => {
    submitted += chunk;
  });
  const manager = createClaudeLoginManager({
    store: { async save() {} },
    spawnImpl: () => child,
  });
  manager.start({ name: 'Second account' });
  child.stderr.write('Paste code here if prompted:');
  assert.equal(manager.publicState().needsCode, true);
  assert.equal(manager.submitCode('temporary-code-123').ok, true);
  assert.equal(submitted, 'temporary-code-123\n');
  assert.doesNotMatch(JSON.stringify(manager.publicState()), /temporary-code/);
  child.stderr.write('Paste code here if prompted:');
  assert.equal(manager.publicState().needsCode, false);
});

test('missing token and process errors fail without leaking raw CLI output', async () => {
  const child = new FakeChild();
  let saves = 0;
  const manager = createClaudeLoginManager({
    store: {
      async save() {
        saves += 1;
      },
    },
    spawnImpl: () => child,
  });
  manager.start({ name: 'Broken login' });
  child.stderr.write('internal oauth failure with private diagnostics');
  child.emit('close', 1);
  await settle();
  assert.equal(saves, 0);
  assert.equal(manager.publicState().status, 'failed');
  assert.doesNotMatch(JSON.stringify(manager.publicState()), /private diagnostics|internal oauth/);

  const errorChild = new FakeChild();
  const second = createClaudeLoginManager({
    store: { async save() {} },
    spawnImpl: () => errorChild,
  });
  second.start({ name: 'Spawn error' });
  errorChild.emit('error', new Error('secret executable path'));
  errorChild.emit('close', 1);
  await settle();
  assert.equal(second.publicState().status, 'failed');
  assert.doesNotMatch(JSON.stringify(second.publicState()), /secret executable path/);
});

test('cancel terminates the child and invalid names never start a process', async () => {
  const child = new FakeChild();
  let spawns = 0;
  const manager = createClaudeLoginManager({
    store: { async save() {} },
    spawnImpl: () => {
      spawns += 1;
      return child;
    },
  });
  assert.equal(manager.start({ name: '../secret' }).ok, true);
  assert.equal(manager.cancel().ok, true);
  await settle();
  assert.equal(child.killedWith, 'SIGTERM');
  assert.equal(manager.publicState().status, 'cancelled');
  assert.equal(manager.start({ name: '\u0000' }).ok, false);
  assert.equal(manager.start({ name: TOKEN }).ok, false);
  assert.equal(spawns, 1);
});

test('login deadline escalates an ignored termination without leaving the manager active', async () => {
  class StubbornChild extends FakeChild {
    kill(signal) {
      this.killedWith ||= [];
      this.killedWith.push(signal);
      if (signal === 'SIGKILL') queueMicrotask(() => this.emit('close', 137));
      return true;
    }
  }
  const child = new StubbornChild();
  const manager = createClaudeLoginManager({
    store: { async save() {} },
    spawnImpl: () => child,
    loginTimeoutMs: 5,
    killGraceMs: 5,
  });
  manager.start({ name: 'Timed account' });
  await wait(25);
  assert.deepEqual(child.killedWith, ['SIGTERM', 'SIGKILL']);
  assert.equal(manager.publicState().status, 'failed');
  assert.match(manager.publicState().message, /timed out/i);
});

test('dispose escalates a stuck login process before resolving', async () => {
  class StubbornChild extends FakeChild {
    kill(signal) {
      this.killedWith ||= [];
      this.killedWith.push(signal);
      if (signal === 'SIGKILL') queueMicrotask(() => this.emit('close', 137));
      return true;
    }
  }
  const child = new StubbornChild();
  const manager = createClaudeLoginManager({
    store: { async save() {} },
    spawnImpl: () => child,
    killGraceMs: 5,
  });
  manager.start({ name: 'Shutdown account' });
  await manager.dispose();
  assert.deepEqual(child.killedWith, ['SIGTERM', 'SIGKILL']);
  assert.equal(manager.publicState().status, 'idle');
});
