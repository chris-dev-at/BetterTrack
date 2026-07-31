#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { createClaudeCredentialStore } from './claude-credentials.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const authRootPath = resolve(here, '..', 'auth');
const authRoot = existsSync(authRootPath) ? realpathSync(authRootPath) : authRootPath;
const rawWorkers = process.argv[2] || '2';
const workers = Number.parseInt(rawWorkers, 10);

if (!Number.isInteger(workers) || workers < 1 || workers > 4) {
  console.error('Claude credential sync: workers must be 1–4');
  process.exit(2);
}

const store = createClaudeCredentialStore({ authRoot });
for (const service of [
  'master',
  ...Array.from({ length: workers }, (_, index) => `worker-${index + 1}`),
]) {
  await store.materialize(service);
}

console.log(`Claude credential assignments materialized for master + ${workers} worker(s)`);
