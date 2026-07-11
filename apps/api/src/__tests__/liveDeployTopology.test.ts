import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the 2026-07-11 `alert.triggered` P1 — the class of bug
 * where every process is individually correct but the TOPOLOGY drops the event.
 *
 * Root cause then: the canonical live deploy loop (infra/live/updater.sh) built
 * and `up -d`'d only web+api. Compose never recreates a service it doesn't
 * list and each buildable service owns its own image tag, so the worker
 * container stayed frozen on its first-bring-up image across every auto-deploy.
 * When #427 cut the api over to the durable notifications pipeline, the frozen
 * pre-v2 worker kept publishing `alert.triggered` onto the retired ephemeral
 * bus that nothing subscribes to anymore: alerts flipped to `triggered` with no
 * inbox row and no push.
 *
 * Guard 1 pins the deploy loop: every compose service that builds app code must
 * be in BOTH the updater's `build` list and its final `up -d` list, so adding a
 * service to the stack without adding it to the deploy loop fails CI.
 *
 * Guard 2 pins the worker entry: the ONE process that consumes
 * `notifications.dispatch` must keep registering the consumer and the durable
 * bridge. These are source anchors on scripts/worker.ts (it opens connections at
 * import time, so it cannot be imported in a unit test); if a refactor renames
 * the wiring, update the anchors together with it — deliberately, not silently.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Top-level compose service names, and which of them have a `build:` block. */
function parseComposeServices(source: string): { all: string[]; buildable: string[] } {
  const all: string[] = [];
  const buildable: string[] = [];
  let inServices = false;
  let current: string | null = null;
  for (const line of source.split('\n')) {
    const topLevel = /^([a-zA-Z][\w-]*):\s*(#.*)?$/.exec(line);
    if (topLevel) {
      inServices = topLevel[1] === 'services';
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][\w-]*):\s*(#.*)?$/.exec(line);
    if (service) {
      current = service[1]!;
      all.push(current);
      continue;
    }
    if (current && /^ {4}build:/.test(line)) {
      buildable.push(current);
    }
  }
  return { all, buildable };
}

/** Union of the services named across every `dc <verb> …` line in the updater. */
function updaterServices(source: string, pattern: RegExp): Set<string> {
  const services = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    for (const name of match[1]!.trim().split(/\s+/)) services.add(name);
  }
  return services;
}

describe('live deploy loop covers the whole app stack (guard 1)', () => {
  const compose = parseComposeServices(read('infra/docker-compose.yml'));
  const updater = read('infra/live/updater.sh');
  const built = updaterServices(updater, /\bdc build ([a-z][\w -]*?)\s*>>/g);
  const upped = updaterServices(updater, /\bdc up -d ([a-z][\w -]*?)\s*>>/g);

  it('parses the expected stack (parser sanity — a silent no-match must not pass)', () => {
    expect(compose.buildable).toEqual(expect.arrayContaining(['web', 'landing', 'api', 'worker']));
    expect(compose.all).toEqual(expect.arrayContaining(['db', 'redis']));
    expect(built.size).toBeGreaterThan(0);
    expect(upped.size).toBeGreaterThan(0);
  });

  it('every buildable compose service is rebuilt AND recreated by the updater', () => {
    for (const service of compose.buildable) {
      expect(built, `updater.sh must "dc build" the '${service}' service`).toContain(service);
      expect(upped, `updater.sh must "dc up -d" the '${service}' service`).toContain(service);
    }
  });

  it('db and redis are brought up (migrate preflight), and the updater never lists itself', () => {
    expect(upped).toContain('db');
    expect(upped).toContain('redis');
    // The self-exclusion invariant from the script header: `up` recreating the
    // updater would kill the deploy loop mid-deploy.
    expect(upped).not.toContain('updater');
    expect(built).not.toContain('updater');
  });

  it('only known compose services are named (catches a typo that compose would reject at deploy time)', () => {
    const known = new Set(compose.all);
    for (const service of [...built, ...upped]) {
      expect(known, `'${service}' in updater.sh is not a compose service`).toContain(service);
    }
  });
});

describe('worker entry registers the durable notification consumer + bridge (guard 2)', () => {
  const workerEntry = read('apps/api/src/scripts/worker.ts');

  it('registers the notifications.dispatch consumer with the fully-built dispatcher', () => {
    expect(workerEntry).toContain('createNotificationsDispatchJob({ dispatcher })');
    expect(workerEntry).toContain('createNotificationDispatcher(');
  });

  it('bridges the notification center onto the durable queue (never the ephemeral bus)', () => {
    expect(workerEntry).toContain("registry.enqueue('notifications.dispatch', { event })");
  });

  it('hands the center to the scheduled jobs so the alert evaluator emits durably', () => {
    expect(workerEntry).toContain('createNotificationCenter(');
    expect(workerEntry).toMatch(/createJobDefinitions\(\{[\s\S]*?\bnotify\b[\s\S]*?\}\)/);
  });
});
