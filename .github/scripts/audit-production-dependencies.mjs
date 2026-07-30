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
  const advisoryIds = new Set();

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
    advisoryIds.add(advisoryId);
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
      !waiver.reason.trim()
    ) {
      issues.push(`Waiver ${advisoryId} needs a non-empty reason.`);
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
    if (!advisoryIds.has(advisoryId)) {
      issues.push(`Waiver ${advisoryId} is no longer needed and must be removed.`);
      continue;
    }

    activeWaivers.add(advisoryId);
  }

  for (const advisoryId of advisoryIds) {
    if (!activeWaivers.has(advisoryId)) {
      issues.push(`Production dependency advisory ${advisoryId} has no active waiver.`);
    }
  }

  return {
    issues: issues.sort(),
    waived: [...activeWaivers].sort(),
  };
}

function runProductionAudit() {
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

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pnpm audit produced invalid JSON: ${error.message}`);
  }
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
