#!/usr/bin/env node
// multi-factory/control/server.mjs — ControlWebView backend (run on the HOST).
//
//   node multi-factory/control/server.mjs       →  http://10.0.0.4:8790
//
// Zero-dependency Node (≥20). Serves the live dashboard (index.html + SSE) and
// executes the owner's controls: start / dry-run / pause / unpause / stop /
// down / mode changes (run | run-out | close-down). It is the host-side half of
// the drain modes: when the master reports control/phase=drained it downs the
// compose project automatically. Listens on LAN interfaces, then rejects any
// non-private source and untrusted Host before routing the request.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat, rename, mkdir, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildUsageAnalytics, ledgerEquivalentUsd, parseUsageRange } from './usage-analytics.mjs';
import {
  DIFFICULTIES,
  PINNABLE_ROLES,
  SLOTS,
  composerRouteAllowed,
  defaultRouteForProvider,
  entryRoutes,
  normalizeModelRouting,
  normalizeRouteEntry,
  publicProviderRegistry,
  validateRouteEntry,
} from './provider-registry.mjs';
import {
  buildClaudexStatus,
  claudexProviderTestInvocation,
  claudexRuntimeStatusInvocation,
  createExclusiveOperation,
  parseClaudexTestOutput,
  parseClaudexRuntimeOutput,
  readRuntimeProofCache,
  runningMasterContainer,
  sanitizeClaudexLastTest,
} from './claudex-control.mjs';
import {
  appendUsageHistory,
  compactUsageHistoryFile,
  queryUsageHistory,
  usageHistoryEntryToSnapshot,
} from './usage-history.mjs';
import {
  evaluateTimerTrigger,
  evaluateUsageResetTrigger,
  evaluateUsageThresholdTrigger,
  timerTriggerDue,
  usageResetReady,
  usageThresholdReached,
} from './trigger-control.mjs';
import {
  CLAUDE_CREDENTIAL_SERVICES,
  CLAUDE_FACTORY_ENV_PROFILE,
  createClaudeCredentialStore,
} from './claude-credentials.mjs';
import {
  bindingsFile as usageBindingsFile,
  createHostUsageSource,
  readBindings as readUsageBindings,
  writeBindings as writeUsageBindings,
} from './claude-usage-source.mjs';
import { createClaudeLoginManager, scrubClaudeLoginEnv } from './claude-login.mjs';
import {
  isAllowedRequestHost,
  isPrivateSource,
  isSamePrivateOrigin,
} from './local-control-security.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MF_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(MF_DIR, '..');
const STATE = join(MF_DIR, 'state');
const CONTROL = join(STATE, 'control');
const AUTH_ROOT_PATH = join(MF_DIR, 'auth');
// Resolve through the deploy worktree's auth symlink, but never let a failed
// resolution decide the auth root by omission: fall back to the literal path so
// the store still finds the vault, and let the store handle the link itself.
const AUTH_ROOT = (() => {
  try {
    return realpathSync(AUTH_ROOT_PATH);
  } catch {
    return AUTH_ROOT_PATH;
  }
})();
const LEDGER = join(REPO_ROOT, 'factory', 'usage', 'ledger.jsonl');
const CONTROL_LOG = join(STATE, 'logs', 'control.log');
const PROVIDER_TESTS_FILE = join(CONTROL, 'provider-tests.json');
const CLAUDEX_MARKER = join(MF_DIR, 'auth', 'master', 'ccr', 'factory-status.json');
const USAGE_HISTORY_FILE = join(CONTROL, 'usage-history.json');
const PORT = Number(process.env.MF_CONTROL_PORT || 8790);
const HOST = process.env.MF_CONTROL_HOST || '10.0.0.4';
const MF_PROJECT = 'bettertrack-multifactory';
const SF_PROJECT = 'bettertrack-factory';
const inflight = new Map(); // operation name → started_at
const mfExclusive = createExclusiveOperation();
const claudeCredentials = createClaudeCredentialStore({ authRoot: AUTH_ROOT });
// Quota telemetry rides on the interactive login, not on the factory's
// inference-only setup tokens — see claude-usage-source.mjs for why.
const hostUsage = createHostUsageSource();
const USAGE_BINDINGS_FILE = usageBindingsFile(AUTH_ROOT);
const claudeLogin = createClaudeLoginManager({
  store: claudeCredentials,
  cwd: MF_DIR,
});
await claudeCredentials.materializeAll().catch(() => {
  // The dashboard must still come up to surface/recover a credential-store
  // problem. Runtime readiness remains fail-closed until materialization works.
});
process.once('exit', () => {
  void claudeLogin.dispose();
});
let signalShutdownStarted = false;
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    if (signalShutdownStarted) return;
    signalShutdownStarted = true;
    void claudeLogin.dispose().finally(() => process.exit(exitCode));
  });
}

const run = (cmd, args, opts = {}) =>
  new Promise((res) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...opts },
      (err, stdout, stderr) =>
        res({
          ok: !err,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          err: err?.message,
        }),
    );
    // Close stdin so CLIs that append piped stdin (codex exec, agy) don't block
    // waiting for EOF — none of these calls feed data in.
    child.stdin?.end();
  });

const clog = async (line) => {
  try {
    await mkdir(dirname(CONTROL_LOG), { recursive: true });
    await appendFile(CONTROL_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* best-effort log — must never break an action */
  }
};

// ---- state dir readers ----------------------------------------------------------
const readText = async (p) => {
  try {
    return (await readFile(p, 'utf8')).trim();
  } catch {
    return null;
  }
};
const readJson = async (p) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
};
const ageSeconds = async (p) => {
  try {
    return Math.round((Date.now() - (await stat(p)).mtimeMs) / 1000);
  } catch {
    return null;
  }
};

async function desiredWorkers() {
  const n = parseInt((await readText(join(CONTROL, 'workers'))) || '2', 10);
  return n >= 1 && n <= 4 ? n : 2;
}

async function readProtocolState() {
  const workers = [];
  // Show every worker that has protocol files plus all configured ones — after
  // shrinking the count, old workers disappear once autorun cleans their files.
  let ids = new Set();
  for (let w = 1; w <= (await desiredWorkers()); w++) ids.add(w);
  try {
    for (const f of await readdir(join(STATE, 'status'))) {
      const m = /^worker-(\d+)\.json$/.exec(f);
      if (m) ids.add(Number(m[1]));
    }
  } catch {
    /* status dir may not exist yet */
  }
  for (const w of [...ids].sort((a, b) => a - b)) {
    workers.push({
      id: w,
      status: await readJson(join(STATE, 'status', `worker-${w}.json`)),
      heartbeatAge: await ageSeconds(join(STATE, 'status', `worker-${w}.hb`)),
      assignment: await readJson(join(STATE, 'assignments', `worker-${w}.json`)),
    });
  }
  let queue = [];
  try {
    const files = (await readdir(join(STATE, 'merge-queue')))
      .filter((f) => /^\d+-pr\d+\.json$/.test(f))
      .sort();
    queue = (await Promise.all(files.map((f) => readJson(join(STATE, 'merge-queue', f))))).filter(
      Boolean,
    );
  } catch {
    /* queue dir may not exist before first start */
  }
  const eventsRaw = await readText(join(STATE, 'logs', 'events.log'));
  return {
    mode: (await readText(join(CONTROL, 'mode'))) || 'run',
    phase: (await readText(join(CONTROL, 'phase'))) || null,
    masterHeartbeatAge: await ageSeconds(join(STATE, 'status', 'master.hb')),
    stopFile: existsSync(join(STATE, 'STOP')),
    workers,
    queue,
    events: eventsRaw ? eventsRaw.split('\n').slice(-120) : [],
  };
}

// ---- docker ----------------------------------------------------------------------
const composeCache = new Map();
const COMPOSE_STATUS_TTL = Number(process.env.MF_DOCKER_STATUS_TTL_MS || 2000);
const CLAUDEX_RUNTIME_STATUS_TTL = Number(process.env.MF_CLAUDEX_STATUS_TTL_MS || 20000);
let claudexRuntimeCache = {
  containerId: null,
  at: 0,
  data: null,
  pending: null,
};

function invalidateClaudexRuntimeCache() {
  claudexRuntimeCache = {
    containerId: null,
    at: 0,
    data: null,
    pending: null,
  };
}

function reserveMfOperation(name, { invalidateRuntime = false, invalidateDocker = false } = {}) {
  if (!mfExclusive.reserve(name)) return false;
  if (invalidateRuntime) invalidateClaudexRuntimeCache();
  if (invalidateDocker) composeCache.delete(MF_PROJECT);
  inflight.set(name, Date.now());
  return true;
}

function releaseMfOperation(name, { invalidateRuntime = false, invalidateDocker = false } = {}) {
  if (mfExclusive.current() !== name) return false;
  if (invalidateRuntime) invalidateClaudexRuntimeCache();
  if (invalidateDocker) composeCache.delete(MF_PROJECT);
  inflight.delete(name);
  return mfExclusive.release(name);
}

const mfBusyResult = () => ({
  ok: false,
  busy: true,
  message: `multi-factory operation already in progress (${mfExclusive.current() || 'unknown'})`,
});

async function withMfOperation(name, task, options = {}) {
  if (!reserveMfOperation(name, options)) return mfBusyResult();
  try {
    return await task();
  } finally {
    releaseMfOperation(name, options);
  }
}

async function composePs(project, { fresh = false } = {}) {
  const cached = composeCache.get(project);
  if (!fresh && cached && Date.now() - cached.at < COMPOSE_STATUS_TTL) return cached.data;
  const r = await run('docker', ['compose', '-p', project, 'ps', '-a', '--format', 'json']);
  if (!r.ok) {
    const data = { error: r.stderr || r.err, containers: [] };
    composeCache.set(project, { at: Date.now(), data });
    return data;
  }
  const containers = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((c) => ({
      id: c.ID || null,
      name: c.Name,
      service: c.Service,
      state: c.State,
      status: c.Status,
    }));
  const data = { containers };
  composeCache.set(project, { at: Date.now(), data });
  return data;
}

async function claudexRuntimeProof(multiDocker) {
  const master = runningMasterContainer(multiDocker);
  if (!master) {
    invalidateClaudexRuntimeCache();
    return null;
  }
  const cached = readRuntimeProofCache(
    claudexRuntimeCache,
    master.id,
    Date.now(),
    CLAUDEX_RUNTIME_STATUS_TTL,
  );
  if (cached.hit) return cached.data;
  if (claudexRuntimeCache.pending && claudexRuntimeCache.containerId === master.id)
    return claudexRuntimeCache.pending;
  const operation = `claudex-runtime-status:${master.id || 'uncached'}`;
  if (!reserveMfOperation(operation)) return null;
  const pending = (async () => {
    try {
      const invocation = claudexRuntimeStatusInvocation({
        mfDir: MF_DIR,
        project: MF_PROJECT,
        override: process.env.MF_COMPOSE_OVERRIDE || '',
      });
      const result = await run(invocation.cmd, invocation.args, {
        timeout: 60000,
        cwd: MF_DIR,
      });
      const data = result.ok ? parseClaudexRuntimeOutput(result.stdout) : null;
      claudexRuntimeCache = {
        containerId: master.id,
        at: Date.now(),
        data,
        pending: null,
      };
      return data;
    } catch {
      claudexRuntimeCache = {
        containerId: master.id,
        at: Date.now(),
        data: null,
        pending: null,
      };
      return null;
    } finally {
      releaseMfOperation(operation);
    }
  })();
  claudexRuntimeCache = {
    containerId: master.id,
    at: 0,
    data: null,
    pending,
  };
  return pending;
}

// ---- GitHub (cached — the dashboard must never rate-limit the factory) ------------
let ghCache = { at: 0, data: null };
async function github() {
  if (Date.now() - ghCache.at < 30000 && ghCache.data) return ghCache.data;
  const gh = (args) => run('gh', args, { cwd: REPO_ROOT });
  const [issues, prs, merged, needsHuman, awaitingOwner] = await Promise.all([
    gh([
      'issue',
      'list',
      '--label',
      'autopilot',
      '--state',
      'open',
      '--json',
      'number,title,labels,body',
      '--limit',
      '50',
    ]),
    gh([
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,headRefName,statusCheckRollup,mergeStateStatus,isDraft',
      '--limit',
      '30',
    ]),
    gh([
      'pr',
      'list',
      '--state',
      'merged',
      '--json',
      'number,title,mergedAt,headRefName',
      '--limit',
      '25',
    ]),
    gh([
      'issue',
      'list',
      '--label',
      'needs-human',
      '--state',
      'open',
      '--json',
      'number,title',
      '--limit',
      '30',
    ]),
    gh([
      'issue',
      'list',
      '--label',
      'awaiting-owner',
      '--state',
      'open',
      '--json',
      'number,title',
      '--limit',
      '30',
    ]),
  ]);
  const parse = (r, fb) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      return fb;
    }
  };
  const meta = (body) => {
    const m = /<!--\s*mf-meta([\s\S]*?)-->/.exec(body || '');
    if (!m) return null;
    const deps = /depends-on:\s*([0-9,\s]+)/i.exec(m[1]);
    return {
      dependsOn: deps
        ? deps[1]
            .split(/[,\s]+/)
            .filter(Boolean)
            .map(Number)
        : [],
      touches: [...m[1].matchAll(/touches:\s*(\S+)/gi)].map((t) => t[1]),
    };
  };
  const rollup = (p) => {
    const cs = p.statusCheckRollup || [];
    if (cs.some((c) => /FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED/.test(c.conclusion || '')))
      return 'failing';
    if (
      cs.length === 0 ||
      cs.some((c) => !c.conclusion || /IN_PROGRESS|QUEUED|PENDING/.test(c.status || ''))
    )
      return 'pending';
    return 'passing';
  };
  ghCache = {
    at: Date.now(),
    data: {
      issues: parse(issues, []).map((i) => ({
        number: i.number,
        title: i.title,
        labels: (i.labels || []).map((l) => l.name),
        meta: meta(i.body),
      })),
      prs: parse(prs, []).map((p) => ({
        number: p.number,
        title: p.title,
        branch: p.headRefName,
        checks: rollup(p),
        mergeState: p.isDraft ? 'draft' : String(p.mergeStateStatus || 'unknown').toLowerCase(),
      })),
      merged: parse(merged, []),
      needsHuman: parse(needsHuman, []),
      awaitingOwner: parse(awaitingOwner, []),
      sources: {
        needsHuman: {
          available: needsHuman.ok,
          error: needsHuman.ok ? null : needsHuman.stderr.slice(0, 200) || 'query failed',
        },
        awaitingOwner: {
          available: awaitingOwner.ok,
          error: awaitingOwner.ok ? null : awaitingOwner.stderr.slice(0, 200) || 'query failed',
        },
      },
      error: [issues, prs].find((r) => !r.ok)?.stderr?.slice(0, 200) || null,
    },
  };
  return ghCache.data;
}

// ---- ledger ------------------------------------------------------------------------
async function ledger() {
  try {
    const lines = (await readFile(LEDGER, 'utf8')).split('\n').filter(Boolean);
    const rows = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const today = new Date().toISOString().slice(0, 10);
    const sum = (rs) =>
      Math.round(rs.reduce((total, row) => total + (ledgerEquivalentUsd(row) ?? 0), 0) * 100) / 100;
    const multi = rows.filter((r) => r.factory === 'multi');
    const byIssue = {};
    for (const r of multi) {
      const estimate = ledgerEquivalentUsd(r);
      if (estimate == null) continue;
      byIssue[r.issue] = Math.round(((byIssue[r.issue] || 0) + estimate) * 100) / 100;
    }
    return {
      todayAll: sum(rows.filter((r) => (r.ts || '').startsWith(today))),
      multiTotal: sum(multi),
      multiToday: sum(multi.filter((r) => (r.ts || '').startsWith(today))),
      multiByIssue: byIssue,
      records: rows.length,
      pricedRecords: rows.filter((row) => ledgerEquivalentUsd(row) != null).length,
      basis: 'api-equivalent',
    };
  } catch {
    return null;
  }
}

// ---- subscription usage (5h window + weekly, scoped to the master account) ------------
// Credentials never leave this process. Named-profile readings are cached and
// historized separately so switching accounts cannot splice two subscriptions
// into one graph or display the previous account's stale fallback.
const usageCaches = new Map();
const usageLastGood = new Map();
let factoryEnvOauthCache = { mtimeMs: null, token: null };
// The oauth/usage endpoint rate-limits aggressively — poll at most every 5 min
// (owner-approved drift of a few %) and serve the last good reading on errors.
const USAGE_TTL = Number(process.env.MF_USAGE_TTL_MS || 300000);
async function factoryEnvOauthToken() {
  const envPath = join(REPO_ROOT, 'factory', '.env');
  let token = null;
  try {
    const info = await stat(envPath);
    if (factoryEnvOauthCache.mtimeMs === info.mtimeMs) return factoryEnvOauthCache.token;
    const env = await readFile(envPath, 'utf8');
    const match = /^\s*CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m.exec(env);
    if (match) {
      token = match[1].trim();
      if (
        token.length >= 2 &&
        ((token.startsWith('"') && token.endsWith('"')) ||
          (token.startsWith("'") && token.endsWith("'")))
      ) {
        token = token.slice(1, -1);
      }
      if (!token) token = null;
    }
    factoryEnvOauthCache = { mtimeMs: info.mtimeMs, token };
  } catch {
    factoryEnvOauthCache = { mtimeMs: null, token: null };
  }
  return token;
}

function unavailableClaudeCredentialState() {
  return {
    version: 1,
    profiles: [],
    assignments: {
      default: 'factory-env',
      master: null,
      'worker-1': null,
      'worker-2': null,
      'worker-3': null,
      'worker-4': null,
    },
    unavailable: true,
    error: 'Claude credential storage is unavailable.',
  };
}

// A credential store that cannot be read empties the accounts panel and drops
// every lane back to the legacy .env account. That is far too quiet a failure to
// swallow: it stayed invisible for hours once. Report each distinct reason once
// so the log says what broke, without one bad read spamming every poll.
let loggedCredentialFailure = null;

async function publicClaudeCredentialState() {
  try {
    const state = await claudeCredentials.list();
    loggedCredentialFailure = null;
    return state;
  } catch (error) {
    const reason = `${error?.code || 'UNKNOWN'}: ${error?.message || 'unreadable'}`;
    if (loggedCredentialFailure !== reason) {
      loggedCredentialFailure = reason;
      void clog(`claude credential store unreadable at ${AUTH_ROOT} — ${reason}`);
    }
    return unavailableClaudeCredentialState();
  }
}

async function masterClaudeCredential() {
  const publicState = await publicClaudeCredentialState();
  if (publicState.unavailable) {
    return {
      token: null,
      profileId: 'unavailable',
      name: 'Claude credential unavailable',
      source: 'unavailable',
    };
  }
  const assignments = publicState.assignments || {};
  const profileId = assignments.master || assignments.default || 'factory-env';
  if (profileId !== 'factory-env') {
    let token = null;
    try {
      token = await claudeCredentials.tokenForService('master');
    } catch {
      // Named selections fail closed. Never fall through to the legacy
      // Factory .env account when the selected profile cannot be read.
    }
    const profile = (publicState.profiles || []).find((entry) => entry.id === profileId);
    return {
      token,
      profileId,
      name: profile?.name || 'Selected Claude account',
      source: 'profile',
    };
  }
  try {
    await claudeCredentials.tokenForService('master');
  } catch {
    return {
      token: null,
      profileId: 'factory-env',
      name: 'Factory .env unavailable',
      source: 'unavailable',
    };
  }
  return {
    token: await factoryEnvOauthToken(),
    profileId: 'factory-env',
    name: 'Factory .env',
    source: 'legacy',
  };
}

function usageHistoryFile(profileId = 'factory-env') {
  if (profileId === 'factory-env') return USAGE_HISTORY_FILE;
  const safe = String(profileId).replace(/[^A-Za-z0-9_-]/g, '');
  return join(CONTROL, `usage-history-claude-${safe || 'unknown'}.json`);
}

// Last-good telemetry for a profile, from disk. usageLastGood only survives as
// long as this process does, so without this a restart during an upstream
// throttle leaves the panel showing a raw status code with no numbers at all.
// Strictly per profile: one account's figures must never stand in for another's.
async function persistedUsageLastGood(cacheKey) {
  try {
    const { entries } = await queryUsageHistory(usageHistoryFile(cacheKey), 720);
    const snapshot = usageHistoryEntryToSnapshot(entries[entries.length - 1]);
    if (snapshot) usageLastGood.set(cacheKey, snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

// Anthropic answers a throttled usage poll with an exact Retry-After. Guessing
// a backoff instead both wastes calls into a closed window and leaves the panel
// unable to say when numbers return, so honour the header and carry the deadline
// through to the client.
function usageRetryMs(res) {
  const header = Number(res.headers?.get?.('retry-after'));
  if (!Number.isFinite(header) || header <= 0) return 600000;
  return Math.min(Math.max(header * 1000 + 5000, 60000), 3600000);
}

// Why an account has no readable quota, in the owner's terms. Never a bare
// status code: every one of these has a different fix.
const USAGE_BLOCK_REASON = {
  unbound: 'Not linked to this Mac’s Claude login',
  absent: 'No Claude login on this machine',
  unscoped: 'The signed-in login lacks the user:profile scope',
  expired: 'The signed-in login has expired — open Claude Code once to refresh it',
  'identity-unknown': 'Cannot confirm which account is signed in',
};

async function usageTelemetryToken(profileId) {
  const bindings = await readUsageBindings(USAGE_BINDINGS_FILE);
  const bound = bindings[profileId]?.email || null;
  const result = await hostUsage.tokenFor(bound);
  return { ...result, boundTo: bound };
}

async function usageForCredential(credential, scope) {
  const cacheKey = credential.profileId;
  const cached = usageCaches.get(cacheKey);
  if (cached && Date.now() - cached.at < (cached.ttl || USAGE_TTL) && cached.data)
    return cached.data;
  let data = { error: 'no OAuth token found' };
  // The endpoint's budget is per token and small — Anthropic has handed back
  // Retry-After values up to an hour. The lane actually doing the work earns the
  // fresh reading; a second account is a "how much is left over there" glance
  // and does not justify spending the same rate on it.
  let ttl = scope === 'master' ? USAGE_TTL : Math.max(USAGE_TTL * 3, 900000);
  // Deliberately NOT credential.token: the factory's setup token is inference-only
  // and /api/oauth/usage answers it 403. Sending it anyway would spend the shared
  // rate budget on a call that cannot succeed.
  const telemetry = await usageTelemetryToken(cacheKey);
  const token = telemetry.token;
  const account = {
    profileId: credential.profileId,
    name: credential.name,
    scope,
  };
  if (!token) {
    // Blocked before any request. Short TTL so linking an account shows up on
    // the next poll rather than after the full quota window.
    data = {
      error:
        telemetry.reason === 'other-account'
          ? `This Mac is signed in as ${telemetry.signedInAs}`
          : USAGE_BLOCK_REASON[telemetry.reason] || 'Quota telemetry is unavailable',
      telemetry: { reason: telemetry.reason, boundTo: telemetry.boundTo || null },
      account,
    };
    usageCaches.set(cacheKey, { at: Date.now(), ttl: 30000, data });
    return data;
  }
  if (token) {
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = await res.json();
        data = {
          fiveHour: j.five_hour
            ? { pct: j.five_hour.utilization, resetsAt: j.five_hour.resets_at }
            : null,
          sevenDay: j.seven_day
            ? { pct: j.seven_day.utilization, resetsAt: j.seven_day.resets_at }
            : null,
          scoped: (j.limits || [])
            .filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
            .map((l) => ({ name: l.scope.model.display_name, pct: l.percent })),
          account,
        };
      } else {
        if (res.status === 429) ttl = usageRetryMs(res);
        const retryAt = res.status === 429 ? Date.now() + ttl : undefined;
        const lastGood = usageLastGood.get(cacheKey) || (await persistedUsageLastGood(cacheKey));
        data = lastGood
          ? { ...lastGood, account, stale: true, ...(retryAt ? { retryAt } : {}) }
          : { error: `usage API ${res.status}`, ...(retryAt ? { retryAt } : {}) };
      }
    } catch (e) {
      const lastGood = usageLastGood.get(cacheKey) || (await persistedUsageLastGood(cacheKey));
      data = lastGood
        ? { ...lastGood, account, stale: true }
        : { error: String(e.message || e).slice(0, 80) };
    }
  }
  if (!data.error && !data.stale) {
    usageLastGood.set(cacheKey, data);
    const historyFile = usageHistoryFile(cacheKey);
    await appendUsageHistory(historyFile, data).catch(() => {});
    await compactUsageHistoryFile(historyFile).catch(() => {});
  }
  if (data.error) data = { ...data, account };
  usageCaches.set(cacheKey, { at: Date.now(), ttl, data });
  return data;
}

async function usage() {
  return usageForCredential(await masterClaudeCredential(), 'master');
}

// Every account the factory can currently draw on, not just the master lane's.
// With work split across two subscriptions, "how much is left" is a question
// about both of them, and the answer decides which one the owner assigns next.
// Caching is shared with usage(): the master account is polled once, not twice.
async function usageAccounts() {
  const state = await publicClaudeCredentialState();
  if (state.unavailable) return [];
  const assignments = state.assignments || {};
  const lanesFor = (profileId) =>
    CLAUDE_CREDENTIAL_SERVICES.filter(
      (service) => (assignments[service] ?? assignments.default) === profileId,
    );
  const selected = new Set(
    CLAUDE_CREDENTIAL_SERVICES.map((service) => assignments[service] ?? assignments.default).filter(
      Boolean,
    ),
  );
  const wanted = [
    ...(state.profiles || []).map((profile) => ({ profileId: profile.id, name: profile.name })),
    ...(selected.has(CLAUDE_FACTORY_ENV_PROFILE)
      ? [{ profileId: CLAUDE_FACTORY_ENV_PROFILE, name: 'Factory .env' }]
      : []),
  ];
  return Promise.all(
    wanted.map(async (entry) => {
      let token = null;
      try {
        token =
          entry.profileId === CLAUDE_FACTORY_ENV_PROFILE
            ? await factoryEnvOauthToken()
            : await claudeCredentials.tokenForProfile(entry.profileId);
      } catch {
        // An unreadable credential is reported as an account without telemetry,
        // never as a missing account: the owner still needs to see it exists.
      }
      const usageData = await usageForCredential(
        { ...entry, token, source: 'profile' },
        'account',
      ).catch(() => ({ error: 'usage unavailable' }));
      return {
        profileId: entry.profileId,
        name: entry.name,
        lanes: lanesFor(entry.profileId),
        usage: usageData,
      };
    }),
  );
}

compactUsageHistoryFile(USAGE_HISTORY_FILE).catch(() => {});
const usageHistorySampler = setInterval(
  () => usageAccounts().catch(() => {}),
  Math.max(USAGE_TTL, 60_000),
);
usageHistorySampler.unref();

// ---- difficulty → model routing (state/control/models.json) ---------------------------
// Read fresh by mflib.sh before every agent run, so saving here applies from the
// NEXT role run without restarting containers. Defaults mirror mflib.sh.
const MODELS_FILE = join(CONTROL, 'models.json');
const DIFFS = DIFFICULTIES;
const MODEL_DEFAULTS = {
  version: 1,
  difficulties: {
    easy: { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    normal: { provider: 'claude', model: 'claude-opus-4-8', effort: 'medium' },
    intermediate: { provider: 'claude', model: 'claude-opus-4-8', effort: 'high' },
    hard: { provider: 'claude', model: 'claude-opus-4-8', effort: 'max' },
    max: { provider: 'claude', model: 'claude-fable-5', effort: 'max' },
  },
  roles: { composer: 'hard', checker: 'hard', reviewFloor: 'intermediate' },
};
async function readModels() {
  const raw = (await readJson(MODELS_FILE)) || {};
  return normalizeModelRouting(raw, MODEL_DEFAULTS);
}

async function persistClaudexLastTest(value) {
  const sanitized = sanitizeClaudexLastTest(value);
  if (!sanitized) return;
  await mkdir(CONTROL, { recursive: true });
  const out = { claudex: sanitized };
  const tmp = `${PROVIDER_TESTS_FILE}.tmp${Date.now()}`;
  await writeFile(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  await rename(tmp, PROVIDER_TESTS_FILE);
}

// ---- provider connection status (host-side — this is what the auth sync copies) --------
let provCache = { at: 0, data: null };
async function providerStatus(multiDocker) {
  const home = process.env.HOME || '';
  // Connection status is cheap (file existence) — always fresh, so logging in a
  // provider flips it to connected on the very next snapshot instead of after the
  // cache TTL. codex = ~/.codex/auth.json; gemini is factory-ready only once the
  // CONTAINER has the agy token (on macOS the host token lives in the keychain,
  // so host presence alone doesn't mean the containers can use it — they get it
  // via `autorun.sh --login-gemini`).
  const codex = existsSync(join(home, '.codex', 'auth.json'));
  const containerCodex = existsSync(join(MF_DIR, 'auth', 'master', 'codex', 'auth.json'));
  const gemini =
    existsSync(
      join(MF_DIR, 'auth', 'master', 'gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    ) || existsSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
  // The expensive agy model probe stays cached at 10 min. Claude profile
  // presence is a cheap private-file read and remains fresh after a login or
  // assignment change.
  if (Date.now() - provCache.at >= 600000 || !provCache.data) {
    let agyModels = provCache.data?.agyModels || [];
    const hostGemini = gemini || existsSync(join(home, '.gemini', 'oauth_creds.json'));
    if (hostGemini) {
      const r = await run('agy', ['models'], { timeout: 20000 });
      if (r.ok) {
        const list = r.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length) agyModels = list;
      }
    }
    provCache = { at: Date.now(), data: { agyModels } };
  }
  const claudeState = await publicClaudeCredentialState();
  const selectedClaude = await masterClaudeCredential();
  const claudeConnected = !!selectedClaude.token;
  const marker = await readJson(CLAUDEX_MARKER);
  const persistedTests = (await readJson(PROVIDER_TESTS_FILE)) || {};
  const masterRunning = (multiDocker?.containers || []).some(
    (container) => container.service === 'master' && /running/i.test(container.state),
  );
  const claudex = buildClaudexStatus({
    codexAuthPresent: containerCodex,
    marker,
    lastTest: persistedTests.claudex,
    masterRunning,
    runtimeProof:
      masterRunning && containerCodex ? await claudexRuntimeProof(multiDocker) : undefined,
  });
  return {
    claude: {
      connected: claudeConnected,
      profileCount: (claudeState.profiles || []).length,
      selectedProfileId: selectedClaude.profileId,
    },
    codex: { connected: codex },
    claudex,
    gemini: { connected: gemini },
    agyModels: provCache.data.agyModels,
  };
}

// ---- triggers: usage- and time-based automation ---------------------------------------
// Persisted in state/control/triggers.json so a server restart keeps them.
// usage rule: fire action when metric ≥ threshold; onReset==='start' waits for the
// next window (resets_at moves / utilization collapses) and starts the factory,
// repeat re-arms the rule for the window after that. timer rule: fire action at fireAt.
const TRIGGERS_FILE = join(CONTROL, 'triggers.json');
async function readTriggers() {
  return (await readJson(TRIGGERS_FILE)) || [];
}
async function writeTriggers(list) {
  await mkdir(CONTROL, { recursive: true });
  const tmp = `${TRIGGERS_FILE}.tmp${Date.now()}`;
  await writeFile(tmp, JSON.stringify(list, null, 1));
  await rename(tmp, TRIGGERS_FILE);
}
const TRIGGER_ACTIONS = new Set(['mode-close-down', 'mode-run-out', 'stop']);
let triggerBusy = false;
async function triggerFactoryState() {
  const docker = await composePs(MF_PROJECT, { fresh: true });
  return {
    running: docker.containers.some((container) => /running|paused/i.test(container.state)),
    // A failed Docker status read is not proof that the factory is down.
    // Treat it like a retryable collision so persisted trigger state survives.
    slotBusy: mfExclusive.current() !== null || !!docker.error,
  };
}
async function evalTriggers() {
  if (triggerBusy) return;
  triggerBusy = true;
  try {
    const list = await readTriggers();
    if (!list.length) return;
    let changed = false;
    const needsUsage = list.some((t) => t.type === 'usage' && (t.armed || t.waitingReset));
    const u = needsUsage ? await usage() : null;
    for (const t of list) {
      const now = Date.now();
      if (timerTriggerDue(t, now)) {
        const state = await triggerFactoryState();
        const outcome = await evaluateTimerTrigger(t, {
          now,
          ...state,
          performAction: doAction,
        });
        if (outcome.changed) {
          changed = true;
          if (state.running) {
            await clog(`trigger[${t.id}] timer → ${t.action}`);
          } else {
            await clog(`trigger[${t.id}] timer fired but factory not running`);
          }
        }
      }
      if (t.type === 'usage' && t.armed) {
        const metric = t.metric === 'seven_day' ? u?.sevenDay : u?.fiveHour;
        if (usageThresholdReached(t, metric)) {
          const state = await triggerFactoryState();
          const outcome = await evaluateUsageThresholdTrigger(t, metric, {
            now,
            ...state,
            performAction: doAction,
          });
          if (outcome.changed) {
            changed = true;
            await clog(
              `trigger[${t.id}] ${t.metric} ${metric.pct}% ≥ ${t.threshold}% → ${t.action}${
                state.running
                  ? ''
                  : outcome.attempted
                    ? ' (factory down — mode written for next start)'
                    : ' (factory already down)'
              }`,
            );
          }
        }
      } else if (t.type === 'usage' && t.waitingReset) {
        const metric = t.metric === 'seven_day' ? u?.sevenDay : u?.fiveHour;
        if (usageResetReady(t, metric)) {
          const state = await triggerFactoryState();
          const outcome = await evaluateUsageResetTrigger(t, metric, {
            ...state,
            performAction: doAction,
          });
          if (!outcome.changed) continue;
          changed = true;
          if (!state.running) {
            await clog(`trigger[${t.id}] new ${t.metric} window → start`);
          }
          if (t.repeat) {
            await clog(`trigger[${t.id}] re-armed (repeat)`);
          }
        }
      }
    }
    if (changed) await writeTriggers(list);
  } catch {
    /* evaluator must survive transient errors */
  } finally {
    triggerBusy = false;
  }
}
setInterval(evalTriggers, 15000);

// ---- usage analytics (ledger aggregations for the Usage tab) --------------------------
const analyticsCache = new Map();
async function usageAnalytics(options = {}) {
  const codexRange = parseUsageRange(options.codexRange ?? 14);
  const codexModel =
    typeof options.codexModel === 'string' && options.codexModel.length <= 120
      ? options.codexModel
      : 'all';
  const filters = Object.fromEntries(
    ['provider', 'providerFamily', 'harness', 'model', 'role', 'issue'].map((key) => [
      key,
      typeof options[key] === 'string' && options[key].length <= 120 ? options[key] : 'all',
    ]),
  );
  const cacheKey = JSON.stringify([codexRange ?? 'all', codexModel, filters]);
  const cached = analyticsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60000) return cached.data;
  let rows = [];
  try {
    rows = (await readFile(LEDGER, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    /* no ledger yet */
  }
  const data = buildUsageAnalytics(rows, {
    codexRange: codexRange ?? 'all',
    codexModel,
    openAiRange: codexRange ?? 'all',
    ...filters,
  });
  analyticsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// ---- snapshot ------------------------------------------------------------------------
let lastAutoAction = null;
async function snapshot() {
  const [protocol, mf, sf, gh, led, usg, triggers, desired, masterActivity, models] =
    await Promise.all([
      readProtocolState(),
      composePs(MF_PROJECT),
      composePs(SF_PROJECT),
      github(),
      ledger(),
      usage(),
      readTriggers(),
      desiredWorkers(),
      readJson(join(STATE, 'status', 'master.json')),
      readModels(),
    ]);
  const providers = await providerStatus(mf);
  const claudeCredentialState = await publicClaudeCredentialState();
  // After usage() above, so the master account's poll is a cache hit here
  // rather than a second call into a rate-limited endpoint.
  const accountUsage = await usageAccounts().catch(() => []);
  // The signed-in login is what makes quota readable at all; the panel needs to
  // name it so "why is this blank" has an answer on screen.
  const usageHost = await hostUsage
    .state()
    .then(async (state) => ({ state, signedInAs: (await hostUsage.identity())?.email || null }))
    .catch(() => ({ state: 'absent', signedInAs: null }));
  const usageBindings = await readUsageBindings(USAGE_BINDINGS_FILE).catch(() => ({}));
  return {
    now: new Date().toISOString(),
    protocol: { ...protocol, masterActivity },
    ledger: led,
    docker: { multi: mf, single: sf },
    github: gh,
    usage: usg,
    triggers,
    workers: { desired, visible: protocol.workers.length },
    inflight: [...inflight.keys()],
    lastAutoAction,
    models,
    providers,
    providerRegistry: publicProviderRegistry(),
    credentials: {
      version: 1,
      providers: {
        claude: {
          ...claudeCredentialState,
          accountUsage,
          usageHost,
          usageBindings,
          legacyConfigured: !!(await factoryEnvOauthToken()),
          login: claudeLogin.publicState(),
        },
      },
    },
  };
}

// ---- actions ------------------------------------------------------------------------
async function setMode(mode) {
  await mkdir(CONTROL, { recursive: true });
  const tmp = join(CONTROL, `.mode.tmp${Date.now()}`);
  await writeFile(tmp, `${mode}\n`);
  await rename(tmp, join(CONTROL, 'mode'));
  await clog(`mode → ${mode}`);
  return { ok: true, message: `mode set to ${mode}` };
}

function spawnLogged(name, cmd, args, cwd) {
  const options = { invalidateRuntime: true, invalidateDocker: true };
  if (!reserveMfOperation(name, options)) return mfBusyResult();
  let child;
  try {
    child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    releaseMfOperation(name, options);
    return { ok: false, message: `${name} failed to start: ${error.message}` };
  }
  const sink = (d) => clog(`[${name}] ${String(d).trimEnd()}`);
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  let finished = false;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    releaseMfOperation(name, options);
    void clog(`[${name}] ${message}`);
  };
  child.on('error', (error) => finish(`failed: ${error.message}`));
  child.on('close', (code) => finish(`exited ${code}`));
  void clog(`[${name}] started`);
  return { ok: true, message: `${name} started (see state/logs/control.log)` };
}

async function testClaudeCredential({ profileId, model, effort }) {
  let token = null;
  try {
    if (profileId === 'factory-env') token = await factoryEnvOauthToken();
    else token = await claudeCredentials.tokenForProfile(profileId);
  } catch {
    return { ok: false, message: 'That Claude account has no usable credential.' };
  }
  if (!token) return { ok: false, message: 'That Claude account has no usable credential.' };

  const selected = normalizeRouteEntry({
    provider: 'claude',
    model,
    effort: effort || 'high',
  });
  if (!selected) return { ok: false, message: 'Invalid Claude model or effort.' };
  const env = scrubClaudeLoginEnv(process.env);
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  const result = await run(
    'claude',
    [
      '-p',
      'Reply with exactly: ok',
      '--model',
      selected.model,
      ...(selected.effort ? ['--effort', selected.effort] : []),
    ],
    { timeout: 90000, cwd: MF_DIR, env },
  );
  return result.ok
    ? {
        ok: true,
        message: `Claude account works via ${selected.model}${selected.effort ? ` @ ${selected.effort}` : ''}.`,
      }
    : {
        ok: false,
        message: 'Claude account test failed. Reconnect it or check its subscription access.',
      };
}

async function doAction(action, payload = {}) {
  // Down-watchdog suppression: an owner-driven stop/down is not an incident;
  // any start re-arms the watchdog (see the factory-down watchdog section).
  if (action === 'stop' || action === 'down') watchdogSuppressedByStop = true;
  if (action === 'start' || action === 'restart' || action === 'start-dry')
    watchdogSuppressedByStop = false;
  switch (action) {
    case 'claude-login-start':
      return claudeLogin.start({ name: payload.name });
    case 'claude-login-code':
      return claudeLogin.submitCode(payload.code);
    case 'claude-login-cancel':
      return claudeLogin.cancel();
    case 'claude-profile-assign': {
      try {
        const state = await claudeCredentials.assign({
          target: payload.target,
          profileId: payload.profileId == null ? null : String(payload.profileId),
        });
        if (payload.target === 'default' || payload.target === 'master') {
          usageCaches.clear();
        }
        await clog(
          `Claude account assignment ${String(payload.target)} → ${payload.profileId || 'inherit default'}`,
        );
        return {
          ok: true,
          message: `Claude account assigned to ${payload.target}; the next Claude role will use it.`,
          state,
        };
      } catch {
        return { ok: false, message: 'Claude account assignment is invalid.' };
      }
    }
    case 'claude-usage-link': {
      // Binds one saved account to whichever Claude login this Mac is signed in
      // as, so its quota becomes readable. Stores the identity only — the token
      // is re-read from the Keychain on every poll and never copied into the vault.
      const profileId = String(payload.profileId || '');
      const state = await publicClaudeCredentialState();
      if (!state.profiles?.some((profile) => profile.id === profileId))
        return { ok: false, message: 'Unknown Claude account.' };
      const who = await hostUsage.identity();
      if (!who?.email) {
        const reason = await hostUsage.state();
        return {
          ok: false,
          message:
            USAGE_BLOCK_REASON[reason] ||
            'This Mac has no Claude login that can read usage. Sign in with Claude Code first.',
        };
      }
      const bindings = await readUsageBindings(USAGE_BINDINGS_FILE);
      bindings[profileId] = { email: who.email, linkedAt: new Date().toISOString() };
      await writeUsageBindings(USAGE_BINDINGS_FILE, bindings);
      usageCaches.delete(profileId);
      const name = state.profiles.find((profile) => profile.id === profileId)?.name || 'account';
      await clog(`Claude usage telemetry linked: ${name} → ${who.email}`);
      return { ok: true, message: `${name} usage now reads from the ${who.email} login.` };
    }
    case 'claude-usage-unlink': {
      const profileId = String(payload.profileId || '');
      const bindings = await readUsageBindings(USAGE_BINDINGS_FILE);
      if (!bindings[profileId]) return { ok: false, message: 'That account is not linked.' };
      delete bindings[profileId];
      await writeUsageBindings(USAGE_BINDINGS_FILE, bindings);
      usageCaches.delete(profileId);
      await clog(`Claude usage telemetry unlinked for ${profileId}`);
      return { ok: true, message: 'Usage telemetry unlinked.' };
    }
    case 'claude-profile-remove': {
      try {
        await claudeCredentials.remove(String(payload.profileId || ''));
        await clog(`Claude account profile removed: ${String(payload.profileId || '')}`);
        return { ok: true, message: 'Claude account removed from MultiFactory.' };
      } catch {
        return {
          ok: false,
          message: 'Claude account could not be removed. Clear its lane assignments first.',
        };
      }
    }
    case 'claude-profile-test': {
      const routes = await readModels();
      const route =
        DIFFS.flatMap((difficulty) => entryRoutes(routes.difficulties[difficulty])).find(
          (entry) => entry.provider === 'claude',
        ) || defaultRouteForProvider('claude');
      return testClaudeCredential({
        profileId: String(payload.profileId || ''),
        model: typeof payload.model === 'string' ? payload.model : route?.model,
        effort: typeof payload.effort === 'string' ? payload.effort : route?.effort,
      });
    }
    case 'start':
      return spawnLogged('start', 'bash', ['autorun.sh'], MF_DIR);
    case 'restart':
      return spawnLogged('restart', 'bash', ['-c', './autorun.sh --down && ./autorun.sh'], MF_DIR);
    case 'set-workers': {
      const n = parseInt(payload.value, 10);
      if (!(n >= 1 && n <= 4)) return { ok: false, message: 'workers must be 1–4' };
      await mkdir(CONTROL, { recursive: true });
      const tmp = join(CONTROL, `.workers.tmp${Date.now()}`);
      await writeFile(tmp, `${n}\n`);
      await rename(tmp, join(CONTROL, 'workers'));
      await clog(`workers → ${n}`);
      return { ok: true, message: `workers set to ${n} — applies on next start/restart` };
    }
    case 'trigger-add': {
      const t = payload.trigger || {};
      const id = Math.random().toString(36).slice(2, 8);
      let rule = null;
      if (t.type === 'timer') {
        const mins = Number(t.minutes);
        if (!(mins >= 1 && mins <= 24 * 60))
          return { ok: false, message: 'minutes must be 1–1440' };
        if (!TRIGGER_ACTIONS.has(t.action)) return { ok: false, message: 'bad action' };
        rule = {
          id,
          type: 'timer',
          minutes: mins,
          fireAt: new Date(Date.now() + mins * 60000).toISOString(),
          action: t.action,
          armed: true,
          created_at: new Date().toISOString(),
        };
      } else if (t.type === 'usage') {
        const th = Number(t.threshold);
        if (!(th >= 1 && th <= 100)) return { ok: false, message: 'threshold must be 1–100%' };
        if (!TRIGGER_ACTIONS.has(t.action)) return { ok: false, message: 'bad action' };
        rule = {
          id,
          type: 'usage',
          metric: t.metric === 'seven_day' ? 'seven_day' : 'five_hour',
          threshold: th,
          action: t.action,
          onReset: t.onReset === 'start' ? 'start' : 'none',
          repeat: !!t.repeat,
          armed: true,
          created_at: new Date().toISOString(),
        };
      } else {
        return { ok: false, message: 'bad trigger type' };
      }
      const list = await readTriggers();
      list.push(rule);
      await writeTriggers(list);
      await clog(`trigger[${id}] added: ${JSON.stringify(rule)}`);
      return { ok: true, message: `trigger armed (${id})` };
    }
    case 'trigger-remove': {
      const list = await readTriggers();
      const next = list.filter((t) => t.id !== payload.id);
      if (next.length === list.length) return { ok: false, message: 'trigger not found' };
      await writeTriggers(next);
      await clog(`trigger[${payload.id}] removed`);
      return { ok: true, message: 'trigger removed' };
    }
    case 'set-models': {
      // Accepts the legacy flat shape and the v2 slotted shape. A difficulty
      // that carries slots must carry all three; its flat keys are rewritten to
      // mirror `completion` so stale readers (and mflib's flat fallback) stay
      // faithful. validateRouteEntry enforces the Opus-5 ≤ xhigh cap per slot.
      const m = payload.models || {};
      const out = { version: 1, difficulties: {}, roles: {} };
      let hasSlots = false;
      for (const d of DIFFS) {
        const e = m.difficulties?.[d];
        const slots = {};
        for (const slot of SLOTS) {
          if (e?.[slot] == null) continue;
          const normalizedSlot = normalizeRouteEntry(e[slot]);
          if (!normalizedSlot)
            return { ok: false, message: `invalid provider/model/effort for '${d}.${slot}'` };
          slots[slot] = normalizedSlot;
        }
        const slotCount = Object.keys(slots).length;
        if (slotCount && slotCount < SLOTS.length)
          return {
            ok: false,
            message: `'${d}' must define all of ${SLOTS.join('/')} — or none for the legacy flat shape`,
          };
        const flatSource = slotCount ? slots.completion : e;
        if (!validateRouteEntry(flatSource))
          return { ok: false, message: `invalid provider/model/effort for '${d}'` };
        out.difficulties[d] = { ...normalizeRouteEntry(flatSource), ...slots };
        if (slotCount) hasSlots = true;
      }
      // roles.<role>: a difficulty string keeps its legacy meaning (resolve
      // through that tier); a {provider, model, effort} object pins the role
      // to that exact route (mflib.sh role_pin_cfg). reviewFloor is always a
      // difficulty name. Present-but-invalid entries are rejected — never
      // silently defaulted — so a save can never quietly drop or rewrite a pin.
      const roles = m.roles || {};
      const isRecord = (v) => v && typeof v === 'object' && !Array.isArray(v);
      out.roles = { composer: 'hard', checker: 'hard', reviewFloor: 'intermediate' };
      const knownRoles = new Set([...PINNABLE_ROLES, 'reviewFloor']);
      for (const [role, value] of Object.entries(isRecord(roles) ? roles : {})) {
        if (value == null) continue;
        if (!knownRoles.has(role))
          return {
            ok: false,
            message: `unknown role '${role}' — expected one of ${[...knownRoles].join('/')}`,
          };
        if (typeof value === 'string' && DIFFS.includes(value)) {
          out.roles[role] = value;
          continue;
        }
        if (role !== 'reviewFloor' && isRecord(value)) {
          const pin = normalizeRouteEntry(value);
          if (!pin)
            return {
              ok: false,
              message: `invalid pinned provider/model/effort for role '${role}'`,
            };
          out.roles[role] = pin; // Opus-5 ≤ xhigh already enforced by normalizeRouteEntry
          out.version = 2; // pins are v2 schema
          continue;
        }
        return {
          ok: false,
          message: `role '${role}' must be a difficulty (${DIFFS.join('/')})${role === 'reviewFloor' ? '' : ' or a {provider, model, effort} pin'}`,
        };
      }
      if (hasSlots) out.version = 2;
      // The composer master-role dispatches through its pin when one is set,
      // otherwise through the writer slot of its difficulty (mf_role_slot:
      // composer→writer) — gate whichever route will actually run.
      const composerRoleValue = out.roles.composer;
      const composerEntry = isRecord(composerRoleValue)
        ? composerRoleValue
        : out.difficulties[composerRoleValue].writer || out.difficulties[composerRoleValue];
      if (!composerRouteAllowed(composerEntry))
        return {
          ok: false,
          message:
            'composer route (pin or writer slot) must use Claude Fable, Claude Opus, or GPT-5.6 Sol',
        };
      await mkdir(CONTROL, { recursive: true });
      const tmp = `${MODELS_FILE}.tmp${Date.now()}`;
      await writeFile(tmp, JSON.stringify(out, null, 2));
      await rename(tmp, MODELS_FILE);
      const routeText = (r) => `${r.provider}/${r.model}${r.effort ? '@' + r.effort : ''}`;
      await clog(
        `models → ${DIFFS.map((d) => {
          const entry = out.difficulties[d];
          return entry.writer
            ? `${d}:[w:${routeText(entry.writer)} r1:${routeText(entry.reviewer1)} c:${routeText(entry.completion)}]`
            : `${d}:${routeText(entry)}`;
        }).join(' ')}${Object.entries(out.roles)
          .filter(([, v]) => isRecord(v))
          .map(([r, v]) => ` ${r}=pin:${routeText(v)}`)
          .join('')}`,
      );
      return { ok: true, message: 'model routing saved — applies from the next agent run' };
    }
    case 'test-provider': {
      const p = String(payload.provider || '');
      const routes = await readModels();
      const configured =
        DIFFS.flatMap((d) => entryRoutes(routes.difficulties[d])).find((e) => e.provider === p) ||
        Object.values(routes.roles || {}).find(
          (v) => v && typeof v === 'object' && v.provider === p,
        ) ||
        defaultRouteForProvider(p);
      const requested = {
        provider: p,
        model: typeof payload.model === 'string' ? payload.model : configured?.model,
        ...(p === 'gemini'
          ? {}
          : {
              effort:
                typeof payload.effort === 'string' ? payload.effort : configured?.effort || 'high',
            }),
      };
      const selected = normalizeRouteEntry(requested);
      if (!selected) return { ok: false, message: 'invalid provider/model/effort' };
      let r;
      if (p === 'claude') {
        const credential = await masterClaudeCredential();
        if (!credential.token)
          return { ok: false, message: 'The master lane has no usable Claude credential.' };
        const env = scrubClaudeLoginEnv(process.env);
        env.CLAUDE_CODE_OAUTH_TOKEN = credential.token;
        env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
        r = await run(
          'claude',
          [
            '-p',
            'Reply with exactly: ok',
            '--model',
            selected.model,
            ...(selected.effort ? ['--effort', selected.effort] : []),
          ],
          { timeout: 90000, cwd: MF_DIR, env },
        );
      } else if (p === 'codex')
        r = await run(
          'codex',
          [
            'exec',
            '--skip-git-repo-check',
            '--ephemeral',
            '--json',
            '-s',
            'read-only',
            '-C',
            MF_DIR,
            '-m',
            selected.model,
            ...(selected.effort ? ['-c', `model_reasoning_effort=${selected.effort}`] : []),
            'Reply with exactly: ok',
          ],
          { timeout: 90000 },
        );
      else if (p === 'claudex') {
        return withMfOperation(
          'test-provider-claudex',
          async () => {
            const mf = await composePs(MF_PROJECT, { fresh: true });
            const master = mf.containers.find((container) => container.service === 'master');
            if (master && /paused/i.test(master.state))
              return { ok: false, message: 'resume the paused master before testing ClaudeX' };
            const otherLive = mf.containers.some(
              (container) =>
                container.service !== 'master' && /running|paused/i.test(container.state),
            );
            const masterRunning = !!master && /running/i.test(master.state);
            if (!masterRunning && otherLive)
              return {
                ok: false,
                message:
                  'factory containers are partially running; restart them before testing ClaudeX',
              };
            const invocation = claudexProviderTestInvocation({
              mfDir: MF_DIR,
              project: MF_PROJECT,
              model: selected.model,
              effort: selected.effort,
              override: process.env.MF_COMPOSE_OVERRIDE || '',
              running: masterRunning,
            });
            const result = await run(invocation.cmd, invocation.args, {
              timeout: 300000,
              cwd: MF_DIR,
            });
            const parsed = result.ok
              ? parseClaudexTestOutput(result.stdout, selected.model)
              : { ok: false, reason: 'provider-test-failed' };
            const testedAt = new Date().toISOString();
            if (!parsed.ok) {
              await persistClaudexLastTest({
                ok: false,
                model: selected.model,
                effort: selected.effort,
                testedAt,
                runtimeReady: false,
                reason: parsed.reason,
              });
              await clog(`test-provider claudex ${selected.model}@${selected.effort} → FAILED`);
              return {
                ok: false,
                message: `claudex test failed (${parsed.reason || 'provider-test-failed'})`,
              };
            }
            await persistClaudexLastTest({
              ...parsed.result,
              effort: selected.effort,
              testedAt: parsed.result.testedAt || testedAt,
            });
            await clog(`test-provider claudex ${selected.model}@${selected.effort} → ok`);
            return {
              ok: true,
              message: `claudex works via ${parsed.result.modelUsage[0]}@${selected.effort}`,
            };
          },
          { invalidateRuntime: true, invalidateDocker: true },
        );
      } else if (p === 'gemini')
        r = await run('agy', ['-p', 'Reply with exactly: ok', '--model', selected.model], {
          timeout: 120000,
          cwd: MF_DIR,
        });
      else return { ok: false, message: 'unknown provider' };
      if (p === 'codex' && r.ok) {
        const events = r.stdout
          .split('\n')
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        r.ok =
          events.some((e) => e.type === 'turn.completed') &&
          !events.some((e) => e.type === 'error' || /\.failed$|\.cancelled$/.test(e.type || ''));
        if (!r.ok) r.stderr = 'Codex stream had no clean turn.completed event';
      }
      await clog(
        `test-provider ${p} ${selected.model}${selected.effort ? '@' + selected.effort : ''} → ${r.ok ? 'ok' : 'FAILED'}`,
      );
      const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
      return r.ok
        ? {
            ok: true,
            message: `${p} works via ${selected.model}${selected.effort ? '@' + selected.effort : ''}${p === 'codex' ? '' : ` — replied: ${last.slice(0, 40)}`}`,
          }
        : {
            ok: false,
            message: `${p} test failed: ${(r.stderr || r.err || 'no output').slice(0, 160)}`,
          };
    }
    case 'start-dry':
      return spawnLogged('start-dry', 'bash', ['autorun.sh', '--dry'], MF_DIR);
    case 'stop':
      return withMfOperation(
        'stop',
        async () => {
          await clog('stop');
          return {
            ...(await run('docker', ['compose', '-p', MF_PROJECT, 'stop'], {
              timeout: 120000,
            })),
            message: 'multi-factory stopped',
          };
        },
        { invalidateRuntime: true, invalidateDocker: true },
      );
    case 'down':
      return withMfOperation(
        'down',
        async () => {
          await clog('down');
          return {
            ...(await run('docker', ['compose', '-p', MF_PROJECT, 'down', '--remove-orphans'], {
              timeout: 120000,
            })),
            message: 'multi-factory removed',
          };
        },
        { invalidateRuntime: true, invalidateDocker: true },
      );
    case 'pause':
      return withMfOperation(
        'pause',
        async () => {
          await clog('pause');
          return {
            ...(await run('docker', ['compose', '-p', MF_PROJECT, 'pause'])),
            message: 'paused',
          };
        },
        { invalidateRuntime: true, invalidateDocker: true },
      );
    case 'unpause':
      return withMfOperation(
        'unpause',
        async () => {
          await clog('unpause');
          return {
            ...(await run('docker', ['compose', '-p', MF_PROJECT, 'unpause'])),
            message: 'resumed',
          };
        },
        { invalidateRuntime: true, invalidateDocker: true },
      );
    case 'mode-run':
      return setMode('run');
    case 'mode-run-out':
      return setMode('run-out');
    case 'mode-close-down':
      return setMode('close-down');
    case 'single-stop':
      await clog('single-stop');
      return {
        ...(await run('docker', ['compose', '-p', SF_PROJECT, 'stop'], { timeout: 120000 })),
        message: 'single factory stopped',
      };
    default:
      return { ok: false, message: `unknown action: ${action}` };
  }
}

// ---- auto-down when drained (completes run-out / close-down) --------------------------
let drainedSince = 0;
let autoDownBusy = false;
setInterval(async () => {
  if (autoDownBusy) return; // compose down takes ~10s; don't re-fire mid-teardown
  let operationReserved = false;
  try {
    const phase = await readText(join(CONTROL, 'phase'));
    if (phase !== 'drained') {
      drainedSince = 0;
      return;
    }
    const { containers } = await composePs(MF_PROJECT);
    const anyRunning = containers.some((c) => /running|paused/i.test(c.state));
    if (!anyRunning) {
      drainedSince = 0;
      return;
    }
    if (!drainedSince) {
      drainedSince = Date.now();
      return;
    } // debounce one interval
    if (Date.now() - drainedSince < 8000 || inflight.size) return;
    const options = { invalidateRuntime: true, invalidateDocker: true };
    if (!reserveMfOperation('auto-down', options)) return;
    operationReserved = true;
    autoDownBusy = true;
    lastAutoAction = { action: 'auto-down (phase=drained)', at: new Date().toISOString() };
    await clog('auto-down: phase=drained — downing compose project');
    await run('docker', ['compose', '-p', MF_PROJECT, 'down', '--remove-orphans'], {
      timeout: 120000,
    });
    drainedSince = 0;
  } catch {
    /* watcher must survive transient docker/fs errors */
  } finally {
    if (operationReserved)
      releaseMfOperation('auto-down', { invalidateRuntime: true, invalidateDocker: true });
    autoDownBusy = false;
  }
}, 5000);

// ---- factory-down watchdog -------------------------------------------------------
// 2026-07-28 incident: the compose project was destroyed mid-run while
// control/phase still said "running" — the pipeline sat dead for 1.5h with no
// signal to the owner. When the owner-intended state (mode=run, phase
// running/draining) disagrees with the actual runtime (zero running/paused
// multi-factory containers) continuously for MF_DOWN_WATCHDOG_GRACE_MS, ping
// the factory webhook ONCE per episode; recovery (containers back, phase or
// mode moved) re-arms it. The webhook URL comes from factory/.env — the
// containers' own notify() channel — parsed read-only; absence disables the
// ping silently (the mismatch still lands in control.log and the dashboard).
const WATCHDOG_GRACE_MS = Number(process.env.MF_DOWN_WATCHDOG_GRACE_MS || 300000);
let downSince = 0;
let downNotified = false;
// A DELIBERATE owner stop/down leaves mode=run and phase=running behind (only
// the master writes phase, and it is gone) — the watchdog must stay quiet
// until the next start. Set/cleared in doAction.
let watchdogSuppressedByStop = false;
async function factoryWebhookUrl() {
  const env = await readText(join(REPO_ROOT, 'factory', '.env'));
  if (!env) return '';
  for (const line of env.split('\n')) {
    const m = /^\s*(?:export\s+)?FACTORY_WEBHOOK_URL\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(
      line,
    );
    if (m) return m[1] ?? m[2] ?? m[3] ?? '';
  }
  return '';
}
setInterval(async () => {
  try {
    const mode = (await readText(join(CONTROL, 'mode'))) || 'run';
    const phase = await readText(join(CONTROL, 'phase'));
    const shouldRun = mode === 'run' && (phase === 'running' || phase === 'draining');
    if (!shouldRun) {
      downSince = 0;
      downNotified = false;
      return;
    }
    // Deliberate stop/down and in-flight operations (start builds can exceed
    // the grace window) are not incidents.
    if (watchdogSuppressedByStop || inflight.size) {
      downSince = 0;
      downNotified = false;
      return;
    }
    const ps = await composePs(MF_PROJECT);
    // A docker-CLI failure (daemon stopped, Docker Desktop updating) says
    // nothing about the factory — freeze the episode rather than misread it.
    if (ps.error) return;
    const { containers } = ps;
    const anyRunning = containers.some((c) => /running|paused/i.test(c.state));
    if (anyRunning) {
      // Containers back means whatever stopped them is over — including a
      // terminal-side ./autorun.sh start the dashboard never saw. Clearing the
      // stop suppression here keeps the watchdog armed for the next incident.
      watchdogSuppressedByStop = false;
      downSince = 0;
      downNotified = false;
      return;
    }
    if (!downSince) {
      downSince = Date.now();
      return;
    }
    if (downNotified || Date.now() - downSince < WATCHDOG_GRACE_MS) return;
    downNotified = true;
    const minutes = Math.round((Date.now() - downSince) / 60000);
    const url = await factoryWebhookUrl();
    await clog(
      `down-watchdog: mode=${mode} phase=${phase} but no multi-factory containers for ${minutes}m${url ? ' — pinging owner webhook' : ' (no webhook configured)'}`,
    );
    if (url)
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `🏭 BetterTrack factory: ⚠️ control says ${phase.toUpperCase()} (mode=${mode}) but no multi-factory containers exist for ${minutes}m — the factory looks killed mid-run. Check the dashboard on :8790.`,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
  } catch {
    /* watchdog must survive transient docker/fs errors */
  }
}, 15000);

// ---- http ------------------------------------------------------------------------------
const sseClients = new Set();
setInterval(async () => {
  if (!sseClients.size) return;
  try {
    const data = `data: ${JSON.stringify(await snapshot())}\n\n`;
    for (const res of sseClients) res.write(data);
  } catch {
    /* a failed snapshot skips one SSE beat, never kills the stream */
  }
}, 2000);

// LAN-only guard (owner order 2026-07-08): when bound beyond loopback via
// MF_CONTROL_HOST, accept ONLY private/loopback sources — anything arriving
// from a public address (e.g. an accidental router port-forward) is dropped
// before any handler runs. The router forwards no 8790 today; this is the belt.
const CREDENTIAL_ACTIONS = new Set([
  'claude-login-start',
  'claude-login-code',
  'claude-login-cancel',
  'claude-profile-assign',
  'claude-profile-remove',
  'claude-profile-test',
  'claude-usage-link',
  'claude-usage-unlink',
]);
const handleRequest = async (req, res) => {
  if (!isPrivateSource(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }
  if (!isAllowedRequestHost(req.headers.host, HOST)) {
    res.writeHead(421, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('misdirected request');
    return;
  }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(join(__dirname, 'index.html')));
    } else if (
      req.method === 'GET' &&
      (url.pathname === '/legacy' || url.pathname === '/legacy/')
    ) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(join(__dirname, 'legacy.html')));
    } else if (req.method === 'GET' && url.pathname === '/api/usage/history') {
      const credential = await masterClaudeCredential();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          await queryUsageHistory(
            usageHistoryFile(credential.profileId),
            url.searchParams.get('hours') || '168',
          ),
        ),
      );
    } else if (req.method === 'GET' && url.pathname === '/api/usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          await usageAnalytics({
            codexRange: url.searchParams.get('range') || '14',
            codexModel: url.searchParams.get('model') || 'all',
            provider: url.searchParams.get('provider') || 'all',
            providerFamily:
              url.searchParams.get('providerFamily') || url.searchParams.get('family') || 'all',
            harness: url.searchParams.get('harness') || 'all',
            model: url.searchParams.get('model') || 'all',
            role: url.searchParams.get('role') || 'all',
            issue: url.searchParams.get('issue') || 'all',
          }),
        ),
      );
    } else if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await snapshot()));
    } else if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(await snapshot())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
    } else if (req.method === 'POST' && url.pathname === '/api/action') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on('end', async () => {
        try {
          const { action, ...payload } = JSON.parse(body || '{}');
          if (CREDENTIAL_ACTIONS.has(action)) {
            const jsonRequest = /^application\/json(?:;|$)/i.test(
              String(req.headers['content-type'] || ''),
            );
            if (
              !isPrivateSource(req.socket.remoteAddress) ||
              !jsonRequest ||
              !isSamePrivateOrigin(req.headers, HOST)
            ) {
              res.writeHead(403, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  message: 'Claude account controls require this private-network dashboard origin.',
                }),
              );
              return;
            }
          }
          const result = await doAction(String(action || ''), payload);
          res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: !!result.ok,
              message: result.message || result.stderr || result.err || 'done',
            }),
          );
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, message: String(e) }));
        }
      });
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
};

const server = createServer(handleRequest);

server.listen(PORT, HOST, () => {
  console.log(`multi-factory control → http://${HOST}:${PORT} (private-source-only guard active)`);
});

// Node binds one address family per listener, so an IPv4 bind alone makes
// http://localhost:8790 fail with a connection refusal on macOS, which resolves
// `localhost` to ::1 first — the console looks down when it is healthy. Add the
// IPv6 counterpart of whatever was asked for: loopback pairs with ::1, and the
// all-interfaces LAN bind (the mode the owner runs) pairs with ::. Any other
// explicit MF_CONTROL_HOST is honoured verbatim and gets no second listener,
// and the private-source guard above still runs for every request on both.
const HOST6 =
  HOST === '127.0.0.1' || HOST === 'localhost' ? '::1' : HOST === '0.0.0.0' ? '::' : null;
if (HOST6) {
  const server6 = createServer(handleRequest);
  server6.on('error', (e) => {
    // EADDRINUSE is expected where the IPv4 bind already covers both families.
    if (e.code !== 'EADDRINUSE' && e.code !== 'EAFNOSUPPORT')
      console.error(`control: IPv6 listener failed — ${e.code || e.message}`);
  });
  server6.listen(PORT, HOST6, () => {
    console.log(`multi-factory control → http://[${HOST6}]:${PORT} (dual-stack)`);
  });
}
