import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dependencyAuditWaivers } from '../security/dependency-audit-waivers.mjs';

const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function expiryFor(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return undefined;
  }

  const expiry = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(expiry.valueOf()) || expiry.toISOString().slice(0, 10) !== value) {
    return undefined;
  }

  return expiry;
}

export function evaluateDependencyAudit(audit, waivers, now = new Date()) {
  const issues = [];
  const advisoryModules = new Map();

  if (
    !audit ||
    typeof audit !== 'object' ||
    !audit.advisories ||
    typeof audit.advisories !== 'object'
  ) {
    return {
      issues: ['pnpm audit did not return an advisory map.'],
      waived: [],
    };
  }

  for (const advisory of Object.values(audit.advisories)) {
    const advisoryId = advisory?.github_advisory_id;
    if (typeof advisoryId !== 'string' || !GHSA_ID.test(advisoryId)) {
      issues.push('pnpm audit returned an advisory without a valid GitHub advisory ID.');
      continue;
    }

    const moduleName = advisory?.module_name;
    if (typeof moduleName !== 'string' || !moduleName.trim()) {
      issues.push(`pnpm audit returned ${advisoryId} without a valid module name.`);
      continue;
    }

    const modulesForAdvisory = advisoryModules.get(advisoryId) ?? new Set();
    modulesForAdvisory.add(moduleName);
    advisoryModules.set(advisoryId, modulesForAdvisory);
  }

  const activeWaivers = new Set();
  for (const [advisoryId, waiver] of Object.entries(waivers)) {
    if (!GHSA_ID.test(advisoryId)) {
      issues.push(`Waiver key ${advisoryId} is not a GitHub advisory ID.`);
      continue;
    }

    if (
      !waiver ||
      typeof waiver !== 'object' ||
      typeof waiver.reason !== 'string' ||
      !waiver.reason.trim() ||
      typeof waiver.moduleName !== 'string' ||
      !waiver.moduleName.trim()
    ) {
      issues.push(`Waiver ${advisoryId} needs a non-empty reason and expected module name.`);
      continue;
    }

    const expiry = expiryFor(waiver.expires);
    if (!expiry) {
      issues.push(`Waiver ${advisoryId} needs a valid YYYY-MM-DD expiry.`);
      continue;
    }
    if (expiry < now) {
      issues.push(`Waiver ${advisoryId} expired on ${waiver.expires}.`);
      continue;
    }
    const modulesForAdvisory = advisoryModules.get(advisoryId);
    if (!modulesForAdvisory) {
      issues.push(`Waiver ${advisoryId} is no longer needed and must be removed.`);
      continue;
    }
    if (modulesForAdvisory.size !== 1 || !modulesForAdvisory.has(waiver.moduleName)) {
      issues.push(
        `Waiver ${advisoryId} is for ${waiver.moduleName}, but pnpm audit reports ${[...modulesForAdvisory].sort().join(', ')}.`,
      );
      continue;
    }

    activeWaivers.add(advisoryId);
  }

  for (const advisoryId of advisoryModules.keys()) {
    if (!activeWaivers.has(advisoryId)) {
      issues.push(`Production dependency advisory ${advisoryId} has no active waiver.`);
    }
  }

  return {
    issues: issues.sort(),
    waived: [...activeWaivers].sort(),
  };
}

/**
 * A usable audit result carries an advisory map. The registry's audit endpoint
 * occasionally answers with an error body or an empty/partial document (six
 * PR runs failed on "did not return an advisory map" in one night,
 * 2026-09-03/04, with the same lockfile auditing clean minutes later); that is
 * a transient to retry, never a reason to pass.
 */
export function auditLooksComplete(audit) {
  return (
    typeof audit === 'object' &&
    audit !== null &&
    typeof audit.advisories === 'object' &&
    audit.advisories !== null
  );
}

/** Attempts are bounded and spaced; the last failure is reported as-is. */
export const AUDIT_ATTEMPTS = 3;
export const AUDIT_RETRY_DELAYS_MS = [10_000, 30_000];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runProductionAuditOnce() {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(pnpm, ['audit', '--prod', '--json'], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (!result.stdout.trim()) {
    throw new Error(`pnpm audit produced no JSON output. ${result.stderr.trim()}`.trim());
  }

  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pnpm audit produced invalid JSON: ${error.message}`);
  }
  if (!auditLooksComplete(audit)) {
    throw new Error(`pnpm audit did not return an advisory map. ${result.stderr.trim()}`.trim());
  }
  return audit;
}

function runProductionAudit({ attempts = AUDIT_ATTEMPTS, delays = AUDIT_RETRY_DELAYS_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return runProductionAuditOnce();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      console.error(
        `pnpm audit attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${Math.round(delay / 1000)}s.`,
      );
      sleepSync(delay);
    }
  }
  // Fail closed, exactly as before: an audit that never produced a usable
  // document is reported as the transient it was, not as a pass.
  throw lastError;
}

export function main() {
  const result = evaluateDependencyAudit(runProductionAudit(), dependencyAuditWaivers);
  if (result.issues.length > 0) {
    console.error('Production dependency audit failed:');
    for (const issue of result.issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Production dependency audit passed with ${result.waived.length} active reviewed waivers.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
