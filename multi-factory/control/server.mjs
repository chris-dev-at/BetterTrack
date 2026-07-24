#!/usr/bin/env node
// multi-factory/control/server.mjs — ControlWebView backend (run on the HOST).
//
//   node multi-factory/control/server.mjs       →  http://127.0.0.1:8790
//
// Zero-dependency Node (≥20). Serves the live dashboard (index.html + SSE) and
// executes the owner's controls: start / dry-run / pause / unpause / stop /
// down / mode changes (run | run-out | close-down). It is the host-side half of
// the drain modes: when the master reports control/phase=drained it downs the
// compose project automatically. Binds 127.0.0.1 only.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat, rename, mkdir, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildUsageAnalytics, parseUsageRange } from './usage-analytics.mjs';
import {
  DIFFICULTIES,
  defaultRouteForProvider,
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
} from './usage-history.mjs';
import {
  evaluateTimerTrigger,
  evaluateUsageResetTrigger,
  evaluateUsageThresholdTrigger,
  timerTriggerDue,
  usageResetReady,
  usageThresholdReached,
} from './trigger-control.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MF_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(MF_DIR, '..');
const STATE = join(MF_DIR, 'state');
const CONTROL = join(STATE, 'control');
const LEDGER = join(REPO_ROOT, 'factory', 'usage', 'ledger.jsonl');
const CONTROL_LOG = join(STATE, 'logs', 'control.log');
const PROVIDER_TESTS_FILE = join(CONTROL, 'provider-tests.json');
const CLAUDEX_MARKER = join(MF_DIR, 'auth', 'master', 'ccr', 'factory-status.json');
const USAGE_HISTORY_FILE = join(CONTROL, 'usage-history.json');
const PORT = Number(process.env.MF_CONTROL_PORT || 8790);
const MF_PROJECT = 'bettertrack-multifactory';
const SF_PROJECT = 'bettertrack-factory';
const inflight = new Map(); // operation name → started_at
const mfExclusive = createExclusiveOperation();

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
  const [issues, prs, merged, needsHuman] = await Promise.all([
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
      'number,title,headRefName,statusCheckRollup',
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
      })),
      merged: parse(merged, []),
      needsHuman: parse(needsHuman, []),
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
    const sum = (rs) => Math.round(rs.reduce((a, r) => a + (r.cost_usd || 0), 0) * 100) / 100;
    const multi = rows.filter((r) => r.factory === 'multi');
    const byIssue = {};
    for (const r of multi)
      byIssue[r.issue] = Math.round(((byIssue[r.issue] || 0) + (r.cost_usd || 0)) * 100) / 100;
    return {
      todayAll: sum(rows.filter((r) => (r.ts || '').startsWith(today))),
      multiTotal: sum(multi),
      multiToday: sum(multi.filter((r) => (r.ts || '').startsWith(today))),
      multiByIssue: byIssue,
      records: rows.length,
    };
  } catch {
    return null;
  }
}

// ---- subscription usage (5h window + weekly, via host OAuth token) --------------------
// The token is read server-side (macOS keychain first, factory/.env as fallback)
// and never leaves this process — the page only ever sees percentages/timestamps.
let usageCache = { at: 0, ttl: 0, data: null };
let usageLastGood = null;
// The oauth/usage endpoint rate-limits aggressively — poll at most every 5 min
// (owner-approved drift of a few %) and serve the last good reading on errors.
const USAGE_TTL = Number(process.env.MF_USAGE_TTL_MS || 300000);
async function hostOauthToken() {
  const r = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']);
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout);
      const t = j.claudeAiOauth?.accessToken || j.accessToken;
      if (t) return t;
    } catch {
      /* fall through to .env */
    }
  }
  try {
    const env = await readFile(join(REPO_ROOT, 'factory', '.env'), 'utf8');
    const m = /^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m.exec(env);
    if (m) return m[1].trim();
  } catch {
    /* no fallback token */
  }
  return null;
}
async function usage() {
  if (Date.now() - usageCache.at < (usageCache.ttl || USAGE_TTL) && usageCache.data)
    return usageCache.data;
  let data = { error: 'no OAuth token found' };
  let ttl = USAGE_TTL;
  const token = await hostOauthToken();
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
        };
      } else {
        data = usageLastGood
          ? { ...usageLastGood, stale: true }
          : { error: `usage API ${res.status}` };
        if (res.status === 429) ttl = 600000; // back off harder when rate-limited
      }
    } catch (e) {
      data = usageLastGood
        ? { ...usageLastGood, stale: true }
        : { error: String(e.message || e).slice(0, 80) };
    }
  }
  if (!data.error && !data.stale) {
    usageLastGood = data;
    await appendUsageHistory(USAGE_HISTORY_FILE, data).catch(() => {});
  }
  usageCache = { at: Date.now(), ttl, data };
  return data;
}
compactUsageHistoryFile(USAGE_HISTORY_FILE).catch(() => {});
const usageHistorySampler = setInterval(() => usage().catch(() => {}), Math.max(USAGE_TTL, 60_000));
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
  // The expensive probes (keychain read for claude, `agy models` list) stay
  // cached at 10 min.
  if (Date.now() - provCache.at >= 600000 || !provCache.data) {
    const claude = !!(await hostOauthToken());
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
    provCache = { at: Date.now(), data: { claudeConnected: claude, agyModels } };
  }
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
    claude: { connected: provCache.data.claudeConnected },
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
              `trigger[${t.id}] ${t.metric} ${metric.pct}% ≥ ${t.threshold}% → ${t.action}${state.running ? '' : ' (factory already down)'}`,
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

async function doAction(action, payload = {}) {
  switch (action) {
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
      const m = payload.models || {};
      const out = { version: 1, difficulties: {}, roles: {} };
      for (const d of DIFFS) {
        const e = m.difficulties?.[d];
        if (!validateRouteEntry(e))
          return { ok: false, message: `invalid provider/model/effort for '${d}'` };
        out.difficulties[d] = normalizeRouteEntry(e);
      }
      const roles = m.roles || {};
      out.roles = {
        composer: DIFFS.includes(roles.composer) ? roles.composer : 'hard',
        checker: DIFFS.includes(roles.checker) ? roles.checker : 'hard',
        reviewFloor: DIFFS.includes(roles.reviewFloor) ? roles.reviewFloor : 'intermediate',
      };
      await mkdir(CONTROL, { recursive: true });
      const tmp = `${MODELS_FILE}.tmp${Date.now()}`;
      await writeFile(tmp, JSON.stringify(out, null, 2));
      await rename(tmp, MODELS_FILE);
      await clog(
        `models → ${DIFFS.map((d) => `${d}:${out.difficulties[d].provider}/${out.difficulties[d].model}${out.difficulties[d].effort ? '@' + out.difficulties[d].effort : ''}`).join(' ')}`,
      );
      return { ok: true, message: 'model routing saved — applies from the next agent run' };
    }
    case 'test-provider': {
      const p = String(payload.provider || '');
      const routes = await readModels();
      const configured =
        DIFFS.map((d) => routes.difficulties[d]).find((e) => e.provider === p) ||
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
      if (p === 'claude')
        r = await run(
          'claude',
          [
            '-p',
            'Reply with exactly: ok',
            '--model',
            selected.model,
            ...(selected.effort ? ['--effort', selected.effort] : []),
          ],
          { timeout: 90000, cwd: MF_DIR },
        );
      else if (p === 'codex')
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
const PRIVATE_SRC =
  /^(::1|::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/;
function isPrivateSource(addr) {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || PRIVATE_SRC.test(a);
}

const server = createServer(async (req, res) => {
  if (!isPrivateSource(req.socket.remoteAddress)) {
    req.socket.destroy();
    return;
  }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html')));
    } else if (req.method === 'GET' && url.pathname === '/api/usage/history') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          await queryUsageHistory(USAGE_HISTORY_FILE, url.searchParams.get('hours') || '168'),
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
});

const HOST = process.env.MF_CONTROL_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`multi-factory control → http://${HOST}:${PORT} (private-source-only guard active)`);
});
