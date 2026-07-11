/**
 * Playwright webServer wrapper for the BullMQ worker (issue #426, flow 6).
 *
 * The alerts evaluator only runs inside the worker process, and the e2e stack
 * never started one — so no alert could ever fire under Playwright. The issue
 * explicitly permits wiring the worker in as an extra `webServer` entry, but a
 * bare worker has no HTTP port for Playwright's readiness poll. This thin
 * wrapper (test infra only — it lives under `e2e/**`, touches no app source)
 * opens a trivial health endpoint so Playwright can detect boot, then spawns
 * `pnpm --filter @bettertrack/api worker` and shares its lifecycle: it exits
 * when the worker exits and forwards termination signals so Playwright can stop
 * it cleanly between runs.
 *
 * The health endpoint answers 200 as soon as the wrapper is up — a beat before
 * the worker has finished connecting — which is fine: the alerts evaluator's
 * first tick is a full minute out, far longer than the worker's boot.
 */
import { spawn } from 'node:child_process';
import http from 'node:http';

const port = Number(process.env.E2E_WORKER_HEALTH_PORT ?? 3100);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
server.listen(port, () => {
  console.log(`[e2e worker wrapper] health endpoint on :${port}`);
});

const child = spawn('pnpm', ['--filter', '@bettertrack/api', 'worker'], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  console.log(`[e2e worker wrapper] worker exited (code=${code}, signal=${signal})`);
  server.close();
  process.exit(code ?? 0);
});

function shutdown(signal) {
  child.kill(signal);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
