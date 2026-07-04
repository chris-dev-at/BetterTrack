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

const __dirname = dirname(fileURLToPath(import.meta.url));
const MF_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(MF_DIR, '..');
const STATE = join(MF_DIR, 'state');
const CONTROL = join(STATE, 'control');
const LEDGER = join(REPO_ROOT, 'factory', 'usage', 'ledger.jsonl');
const CONTROL_LOG = join(STATE, 'logs', 'control.log');
const PORT = Number(process.env.MF_CONTROL_PORT || 8790);
const MF_PROJECT = 'bettertrack-multifactory';
const SF_PROJECT = 'bettertrack-factory';

const run = (cmd, args, opts = {}) =>
  new Promise((res) => {
    execFile(
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
  });

const clog = async (line) => {
  try {
    await mkdir(dirname(CONTROL_LOG), { recursive: true });
    await appendFile(CONTROL_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
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

async function readProtocolState() {
  const workers = [];
  for (let w = 1; w <= Number(process.env.WORKERS || 2); w++) {
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
  } catch {}
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
async function composePs(project) {
  const r = await run('docker', ['compose', '-p', project, 'ps', '-a', '--format', 'json']);
  if (!r.ok) return { error: r.stderr || r.err, containers: [] };
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
    .map((c) => ({ name: c.Name, service: c.Service, state: c.State, status: c.Status }));
  return { containers };
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
    gh(['pr', 'list', '--state', 'merged', '--json', 'number,title,mergedAt', '--limit', '10']),
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

// ---- snapshot ------------------------------------------------------------------------
let lastAutoAction = null;
const inflight = new Map(); // action name → started_at
async function snapshot() {
  const [protocol, mf, sf, gh, led] = await Promise.all([
    readProtocolState(),
    composePs(MF_PROJECT),
    composePs(SF_PROJECT),
    github(),
    ledger(),
  ]);
  return {
    now: new Date().toISOString(),
    protocol,
    ledger: led,
    docker: { multi: mf, single: sf },
    github: gh,
    inflight: [...inflight.keys()],
    lastAutoAction,
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
  if (inflight.has(name)) return { ok: false, message: `${name} already in progress` };
  inflight.set(name, Date.now());
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = (d) => clog(`[${name}] ${String(d).trimEnd()}`);
  child.stdout.on('data', sink);
  child.stderr.on('data', sink);
  child.on('close', (code) => {
    inflight.delete(name);
    clog(`[${name}] exited ${code}`);
  });
  return { ok: true, message: `${name} started (see state/logs/control.log)` };
}

async function doAction(action) {
  switch (action) {
    case 'start':
      return spawnLogged('start', 'bash', ['autorun.sh'], MF_DIR);
    case 'start-dry':
      return spawnLogged('start-dry', 'bash', ['autorun.sh', '--dry'], MF_DIR);
    case 'stop':
      await clog('stop');
      return {
        ...(await run('docker', ['compose', '-p', MF_PROJECT, 'stop'], { timeout: 120000 })),
        message: 'multi-factory stopped',
      };
    case 'down':
      await clog('down');
      return {
        ...(await run('docker', ['compose', '-p', MF_PROJECT, 'down', '--remove-orphans'], {
          timeout: 120000,
        })),
        message: 'multi-factory removed',
      };
    case 'pause':
      await clog('pause');
      return {
        ...(await run('docker', ['compose', '-p', MF_PROJECT, 'pause'])),
        message: 'paused',
      };
    case 'unpause':
      await clog('unpause');
      return {
        ...(await run('docker', ['compose', '-p', MF_PROJECT, 'unpause'])),
        message: 'resumed',
      };
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
setInterval(async () => {
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
    lastAutoAction = { action: 'auto-down (phase=drained)', at: new Date().toISOString() };
    await clog('auto-down: phase=drained — downing compose project');
    await run('docker', ['compose', '-p', MF_PROJECT, 'down', '--remove-orphans'], {
      timeout: 120000,
    });
    drainedSince = 0;
  } catch {}
}, 5000);

// ---- http ------------------------------------------------------------------------------
const sseClients = new Set();
setInterval(async () => {
  if (!sseClients.size) return;
  try {
    const data = `data: ${JSON.stringify(await snapshot())}\n\n`;
    for (const res of sseClients) res.write(data);
  } catch {}
}, 2000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html')));
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
          const { action } = JSON.parse(body || '{}');
          const result = await doAction(String(action || ''));
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`multi-factory control → http://127.0.0.1:${PORT}`);
});
