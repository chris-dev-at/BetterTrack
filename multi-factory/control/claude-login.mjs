import { spawn } from 'node:child_process';
import { extractClaudeSetupToken } from './claude-credentials.mjs';

const ACTIVE_STATES = new Set(['starting', 'waiting-browser', 'needs-code']);
const STRIP_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_AGENT_API_BASE_URL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
];

export function scrubClaudeLoginEnv(source = process.env) {
  const clean = { ...source };
  for (const key of STRIP_ENV) delete clean[key];
  return clean;
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 64 || hasControlCharacter(name) || /sk-ant-oat01-/i.test(name))
    return null;
  return name;
}

function safeState(state) {
  return {
    status: state.status,
    name: state.name || null,
    startedAt: state.startedAt || null,
    completedAt: state.completedAt || null,
    needsCode: state.status === 'needs-code',
    profileId: state.profileId || null,
    message: state.message || null,
  };
}

export function createClaudeLoginManager({
  store,
  spawnImpl = spawn,
  command = 'claude',
  cwd = process.cwd(),
  now = () => new Date(),
  maxCaptureBytes = 1024 * 1024,
  loginTimeoutMs = 10 * 60 * 1000,
  killGraceMs = 2000,
} = {}) {
  if (!store || typeof store.save !== 'function')
    throw new TypeError('Claude credential store is required');

  let child = null;
  let capture = '';
  let codeSubmitted = false;
  let terminalOverride = null;
  let deadlineTimer = null;
  let killTimer = null;
  let generation = 0;
  let state = { status: 'idle' };

  const setState = (next) => {
    state = { ...state, ...next };
  };

  const append = (chunk) => {
    capture += String(chunk || '');
    if (Buffer.byteLength(capture) > maxCaptureBytes) {
      capture = capture.slice(-Math.floor(maxCaptureBytes / 2));
    }
    if (
      !codeSubmitted &&
      ACTIVE_STATES.has(state.status) &&
      /paste (?:the )?(?:authorization )?code|paste code here|enter (?:the )?(?:authorization )?code/i.test(
        capture,
      )
    ) {
      setState({
        status: 'needs-code',
        message: 'Finish the browser sign-in, then paste the authorization code here.',
      });
    } else if (state.status === 'starting') {
      setState({
        status: 'waiting-browser',
        message: 'Complete the Claude sign-in in the browser window.',
      });
    }
  };

  const clearTimers = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (killTimer) clearTimeout(killTimer);
    deadlineTimer = null;
    killTimer = null;
  };

  const terminateCurrent = (override) => {
    if (!child || terminalOverride) return;
    terminalOverride = override;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    const target = child;
    try {
      target.kill('SIGTERM');
    } catch {
      // SIGKILL escalation below is still attempted.
    }
    killTimer = setTimeout(() => {
      if (child !== target) return;
      try {
        target.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }, killGraceMs);
    killTimer.unref?.();
  };

  const finish = async (runGeneration, code) => {
    if (runGeneration !== generation) return;
    let setupToken = null;
    if (!terminalOverride && code === 0) {
      try {
        setupToken = extractClaudeSetupToken(capture);
      } catch {
        setupToken = null;
      }
    }
    capture = '';
    child = null;
    clearTimers();
    if (terminalOverride) {
      const override = terminalOverride;
      terminalOverride = null;
      setState({
        status: override.status,
        completedAt: now().toISOString(),
        message: override.message,
      });
      return;
    }
    if (code !== 0 || !setupToken) {
      setState({
        status: 'failed',
        completedAt: now().toISOString(),
        message: 'Claude sign-in ended before a credential was captured. Try again.',
      });
      return;
    }
    try {
      const profile = await store.save({ name: state.name, setupToken });
      if (runGeneration !== generation) return;
      setState({
        status: 'completed',
        profileId: profile.id,
        completedAt: now().toISOString(),
        message: `${profile.name} was saved. Assign it to the master or a worker below.`,
      });
    } catch {
      if (runGeneration !== generation) return;
      setState({
        status: 'failed',
        completedAt: now().toISOString(),
        message: 'Claude signed in, but the credential could not be saved securely.',
      });
    }
  };

  return {
    publicState() {
      return safeState(state);
    },

    start({ name } = {}) {
      if (child || ACTIVE_STATES.has(state.status))
        return { ok: false, message: 'A Claude sign-in is already in progress.' };
      const clean = cleanName(name);
      if (!clean) return { ok: false, message: 'Account name must be 1–64 printable characters.' };

      codeSubmitted = false;
      terminalOverride = null;
      capture = '';
      clearTimers();
      generation += 1;
      const runGeneration = generation;
      state = {
        status: 'starting',
        name: clean,
        startedAt: now().toISOString(),
        completedAt: null,
        profileId: null,
        message: 'Opening Claude browser sign-in…',
      };
      try {
        child = spawnImpl(command, ['setup-token'], {
          cwd,
          env: scrubClaudeLoginEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        });
      } catch {
        child = null;
        setState({
          status: 'failed',
          completedAt: now().toISOString(),
          message: 'Claude sign-in could not be started.',
        });
        return { ok: false, message: state.message };
      }

      const spawnedChild = child;
      const appendForRun = (chunk) => {
        if (runGeneration === generation && child === spawnedChild) append(chunk);
      };
      child.stdout?.on('data', appendForRun);
      child.stderr?.on('data', appendForRun);
      child.stdin?.on('error', () => {
        if (runGeneration !== generation || child !== spawnedChild) return;
        terminateCurrent({
          status: 'failed',
          message: 'Claude sign-in could not accept the authorization code.',
        });
      });
      child.on('error', () => {
        if (runGeneration !== generation) return;
        generation += 1;
        clearTimers();
        capture = '';
        child = null;
        setState({
          status: 'failed',
          completedAt: now().toISOString(),
          message: 'Claude sign-in could not be started.',
        });
      });
      child.on('close', (code) => {
        void finish(runGeneration, code);
      });
      deadlineTimer = setTimeout(() => {
        if (runGeneration !== generation || child !== spawnedChild) return;
        terminateCurrent({
          status: 'failed',
          message: 'Claude sign-in timed out. Start it again when you are ready.',
        });
      }, loginTimeoutMs);
      deadlineTimer.unref?.();
      return {
        ok: true,
        message: 'Claude sign-in started. Complete the OAuth flow in your browser.',
      };
    },

    submitCode(code) {
      if (!child || !ACTIVE_STATES.has(state.status))
        return { ok: false, message: 'No Claude sign-in is waiting for a code.' };
      if (typeof code !== 'string')
        return { ok: false, message: 'Authorization code is required.' };
      const clean = code.trim();
      if (!clean || clean.length > 4096 || hasControlCharacter(clean))
        return { ok: false, message: 'Authorization code is invalid.' };
      try {
        if (!child.stdin?.writable) throw new Error('stdin unavailable');
        child.stdin.write(`${clean}\n`);
        codeSubmitted = true;
        setState({
          status: 'waiting-browser',
          message: 'Authorization code submitted; finishing Claude sign-in…',
        });
        return { ok: true, message: 'Authorization code submitted.' };
      } catch {
        return { ok: false, message: 'Authorization code could not be submitted.' };
      }
    },

    cancel() {
      if (!child || !ACTIVE_STATES.has(state.status))
        return { ok: false, message: 'No Claude sign-in is in progress.' };
      terminateCurrent({
        status: 'cancelled',
        message: 'Claude sign-in cancelled.',
      });
      return { ok: true, message: 'Cancelling Claude sign-in…' };
    },

    dispose() {
      const target = child;
      generation += 1;
      capture = '';
      clearTimers();
      child = null;
      terminalOverride = null;
      state = { status: 'idle' };
      if (!target) return Promise.resolve();
      return new Promise((resolveDispose) => {
        let settled = false;
        let forceTimer = null;
        let fallbackTimer = null;
        const done = () => {
          if (settled) return;
          settled = true;
          if (forceTimer) clearTimeout(forceTimer);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          resolveDispose();
        };
        target.once('close', done);
        try {
          target.kill('SIGTERM');
        } catch {
          // Escalation below handles a process that remains alive.
        }
        forceTimer = setTimeout(() => {
          try {
            target.kill('SIGKILL');
          } catch {
            // The process may already have exited without a close event.
          }
        }, killGraceMs);
        fallbackTimer = setTimeout(done, killGraceMs + 1000);
      });
    },
  };
}
