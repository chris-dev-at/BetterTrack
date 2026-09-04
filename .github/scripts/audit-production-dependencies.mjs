import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { dependencyAuditWaivers } from '../security/dependency-audit-waivers.mjs';

const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const AUDIT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5_000, 15_000];

// pnpm's own fetch budget (60s timeout, 2 retries) spends over four minutes
// before it reports a socket timeout. Bounding it to a single 60s try per
// attempt keeps all three attempts below what one unbounded attempt costs.
const AUDIT_FETCH_ENV = {
  npm_config_fetch_retries: '0',
  npm_config_fetch_timeout: '60000',
};

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
 * A registry failure reaches us as a JSON error envelope on stdout, which is
 * shaped nothing like an audit report. Separating the two keeps an unreachable
 * registry from being reported as a malformed advisory map, and marks it as the
 * one failure worth retrying.
 */
export function interpretAuditOutput({ stdout = '', stderr = '', status = 0 } = {}) {
  const output = stdout.trim();
  if (!output) {
    return {
      kind: 'unusable',
      detail: `pnpm audit produced no JSON output (exit code ${status}). ${stderr.trim()}`.trim(),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    return { kind: 'unusable', detail: `pnpm audit produced invalid JSON: ${error.message}` };
  }

  const registryError = parsed?.error;
  if (registryError && typeof registryError === 'object') {
    const code = typeof registryError.code === 'string' ? registryError.code : 'unknown error';
    const message = typeof registryError.message === 'string' ? registryError.message.trim() : '';
    return {
      kind: 'registry-error',
      detail: `pnpm audit could not reach the advisory registry (${code})${message ? `: ${message}` : ''}`,
    };
  }

  return { kind: 'report', audit: parsed };
}

async function runProductionAudit() {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  let lastDetail = '';

  for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
    const result = spawnSync(pnpm, ['audit', '--prod', '--json'], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, ...AUDIT_FETCH_ENV },
    });

    if (result.error) {
      throw result.error;
    }

    const interpreted = interpretAuditOutput(result);
    if (interpreted.kind === 'report') {
      return interpreted.audit;
    }
    if (interpreted.kind === 'unusable') {
      throw new Error(interpreted.detail);
    }

    lastDetail = interpreted.detail;
    if (attempt < AUDIT_ATTEMPTS) {
      console.error(`${lastDetail} — retrying (attempt ${attempt + 1} of ${AUDIT_ATTEMPTS}).`);
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  // Fail closed: an audit we could not run is not an audit that passed.
  throw new Error(
    `${lastDetail}. The registry stayed unreachable across ${AUDIT_ATTEMPTS} attempts, so production dependencies were never audited.`,
  );
}

export async function main() {
  let audit;
  try {
    audit = await runProductionAudit();
  } catch (error) {
    console.error('Production dependency audit could not run:');
    console.error(`- ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateDependencyAudit(audit, dependencyAuditWaivers);
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
  await main();
}
