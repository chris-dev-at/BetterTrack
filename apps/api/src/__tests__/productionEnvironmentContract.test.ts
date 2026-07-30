import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COMPOSE_MANAGED_ENV_KEYS,
  ENV_SCHEMA_KEYS,
  INTENTIONALLY_NOT_PROPAGATED_ENV_KEYS,
  PRODUCTION_SUPPORTED_ENV_KEYS,
  type EnvSchemaKey,
  loadConfig,
} from '../config/env';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const infraDir = resolve(repoRoot, 'infra');
const composeSource = readFileSync(resolve(infraDir, 'docker-compose.yml'), 'utf8');
const productionExampleSource = readFileSync(resolve(infraDir, '.env.production.example'), 'utf8');
const developmentExampleSource = readFileSync(resolve(infraDir, '.env.example'), 'utf8');

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function rootEnvironmentAnchor(source: string): Map<string, string> {
  const lines = source.split('\n');
  const header = lines.indexOf('x-api-worker-environment: &api-worker-environment');
  if (header < 0) throw new Error('shared API/worker environment anchor is missing');

  const entries = new Map<string, string>();
  for (const line of lines.slice(header + 1)) {
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('#')) break;
    const entry = /^ {2}([A-Z][A-Z0-9_]*):(?: (.*))?$/.exec(line);
    if (!entry) continue;
    entries.set(entry[1]!, entry[2] ?? '');
  }
  return entries;
}

interface ServiceEnvironment {
  mergeAliases: string[];
  directEntries: Map<string, string>;
}

function serviceEnvironment(source: string, serviceName: string): ServiceEnvironment {
  const lines = source.split('\n');
  const serviceStart = lines.findIndex((line) => line === `  ${serviceName}:`);
  if (serviceStart < 0) throw new Error(`Compose service ${serviceName} is missing`);

  const serviceEnd = lines.findIndex(
    (line, index) => index > serviceStart && (/^ {2}[a-z][\w-]*:$/.test(line) || /^\w/.test(line)),
  );
  const serviceLines = lines.slice(serviceStart, serviceEnd < 0 ? undefined : serviceEnd);
  const environmentStart = serviceLines.indexOf('    environment:');
  if (environmentStart < 0) throw new Error(`Compose service ${serviceName} has no environment`);

  const environmentLines = serviceLines.slice(environmentStart + 1);
  const mergeAliases: string[] = [];
  const directEntries = new Map<string, string>();
  for (const line of environmentLines) {
    if (line !== '' && !line.startsWith('      ') && !line.startsWith('      #')) break;
    const merge = /^ {6}<<: \*([\w-]+)$/.exec(line);
    if (merge) {
      mergeAliases.push(merge[1]!);
      continue;
    }
    const entry = /^ {6}([A-Z][A-Z0-9_]*):(?: (.*))?$/.exec(line);
    if (entry) directEntries.set(entry[1]!, entry[2] ?? '');
  }
  return { mergeAliases, directEntries };
}

interface ExampleEntry {
  key: string;
  value: string;
  purpose: string;
  secret: 'yes' | 'no';
  rotation: string;
  line: number;
}

function annotatedExampleEntries(source: string): ExampleEntry[] {
  const lines = source.split('\n');
  const entries: ExampleEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!assignment) continue;

    const purpose = /^# Purpose: (.+)$/.exec(lines[index - 2] ?? '');
    const policy = /^# Secret: (yes|no)\. Rotation: (.+)$/.exec(lines[index - 1] ?? '');
    if (!purpose || !policy) {
      throw new Error(
        `${assignment[1]} at .env.production.example:${index + 1} needs adjacent Purpose and Secret/Rotation annotations`,
      );
    }
    entries.push({
      key: assignment[1]!,
      value: assignment[2]!,
      purpose: purpose[1]!,
      secret: policy[1]! as 'yes' | 'no',
      rotation: policy[2]!,
      line: index + 1,
    });
  }
  return entries;
}

function plainExampleKeys(source: string): string[] {
  return source
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

function productionComposeInputs(): Set<string> {
  const inputs = new Set<string>();
  for (const filename of readdirSync(infraDir)) {
    if (!/^docker-compose(?:\.[\w-]+)?\.yml$/.test(filename)) continue;
    if (filename === 'docker-compose.dev.yml') continue;

    const source = readFileSync(resolve(infraDir, filename), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
      inputs.add(match[1]!);
    }
  }
  return inputs;
}

const REVIEW_MISSING_KEYS = [
  'ADMIN_SESSION_LIFETIME_HOURS',
  'APP_ORIGIN',
  'BT_AI_DAILY_CAP',
  'BT_GOOGLE_AUTHORIZE_ENDPOINT',
  'BT_GOOGLE_CLIENT_ID',
  'BT_GOOGLE_CLIENT_SECRET',
  'BT_GOOGLE_JWKS_URI',
  'BT_GOOGLE_TOKEN_ENDPOINT',
  'BT_OLLAMA_ENDPOINT',
  'BT_OLLAMA_MODEL',
  'BT_SENTRY_DSN',
  'BT_SENTRY_ENVIRONMENT',
  'BT_SENTRY_ERROR_SAMPLE_RATE',
  'BT_SENTRY_TRACES_SAMPLE_RATE',
  'BT_TELEGRAM_BOT_TOKEN',
  'BT_TELEGRAM_DISCORD_ENABLED',
  'BT_VAULT_HISTORY_MAX_AGE_DAYS',
  'BT_VAULT_HISTORY_MAX_VERSIONS',
  'BT_VAULT_MAX_BYTES',
  'BT_VAULT_RATE_LIMIT',
  'BT_VAULT_RATE_WINDOW_SEC',
  'MARKET_INTEL_ENABLED',
  'MIRROR_MAX_MEMBERS',
  'PROVIDER_MAX_CONCURRENCY',
  'PROVIDER_MIN_SPACING_MS',
  'REALTIME_ENABLED',
  'TOTP_ENCRYPTION_KEY',
  'TOTP_ISSUER',
] as const satisfies readonly EnvSchemaKey[];

describe('production environment contract (#982)', () => {
  const sharedEnvironment = rootEnvironmentAnchor(composeSource);
  const apiEnvironment = serviceEnvironment(composeSource, 'api');
  const workerEnvironment = serviceEnvironment(composeSource, 'worker');
  const intentionalKeys = new Set(Object.keys(INTENTIONALLY_NOT_PROPAGATED_ENV_KEYS));
  const composeManagedKeys = new Set(Object.keys(COMPOSE_MANAGED_ENV_KEYS));
  const supportedKeys = new Set<string>(PRODUCTION_SUPPORTED_ENV_KEYS);

  it('partitions every schema key into supported or intentionally not propagated', () => {
    expect(sorted(new Set([...supportedKeys, ...intentionalKeys]))).toEqual(
      sorted(ENV_SCHEMA_KEYS),
    );
    expect(sorted([...supportedKeys].filter((key) => intentionalKeys.has(key)))).toEqual([]);
    expect(sorted([...composeManagedKeys].filter((key) => !supportedKeys.has(key)))).toEqual([]);
    for (const reason of Object.values(INTENTIONALLY_NOT_PROPAGATED_ENV_KEYS)) {
      expect(reason.trim().length).toBeGreaterThan(20);
    }
    for (const reason of Object.values(COMPOSE_MANAGED_ENV_KEYS)) {
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('resolves every review omission through the shared environment or an explicit reason', () => {
    for (const key of REVIEW_MISSING_KEYS) {
      expect(
        sharedEnvironment.has(key) || intentionalKeys.has(key),
        `${key} is still silently omitted`,
      ).toBe(true);
    }
  });

  it('defines the complete production schema contract in one Compose anchor', () => {
    expect(sorted(sharedEnvironment.keys())).toEqual(sorted(supportedKeys));

    for (const key of supportedKeys) {
      if (composeManagedKeys.has(key)) continue;
      expect(
        sharedEnvironment.get(key),
        `${key} must be forwarded from the host environment`,
      ).toContain('${' + key);
    }
  });

  it('gives API and worker identical effective environments with no hidden service keys', () => {
    for (const environment of [apiEnvironment, workerEnvironment]) {
      expect(environment.mergeAliases).toEqual(['api-worker-environment']);
      expect(sorted(environment.directEntries.keys())).toEqual([]);
    }

    const apiEffective = new Set([
      ...sharedEnvironment.keys(),
      ...apiEnvironment.directEntries.keys(),
    ]);
    const workerEffective = new Set([
      ...sharedEnvironment.keys(),
      ...workerEnvironment.directEntries.keys(),
    ]);
    expect(sorted(apiEffective)).toEqual(sorted(workerEffective));
    expect(sorted(apiEffective)).toEqual(sorted(supportedKeys));
  });
});

describe('production environment example (#982)', () => {
  const entries = annotatedExampleEntries(productionExampleSource);
  const exampleKeys = entries.map((entry) => entry.key);
  const schemaKeys = new Set<string>(ENV_SCHEMA_KEYS);
  const supportedKeys = new Set<string>(PRODUCTION_SUPPORTED_ENV_KEYS);
  const composeInputs = productionComposeInputs();

  it('documents every supported schema key once and no intentionally excluded key', () => {
    expect(new Set(exampleKeys).size).toBe(exampleKeys.length);
    expect(sorted(exampleKeys.filter((key) => schemaKeys.has(key)))).toEqual(sorted(supportedKeys));
  });

  it('annotates every variable and keeps secret examples inert', () => {
    for (const entry of entries) {
      expect(entry.purpose.length, `${entry.key}:${entry.line} purpose`).toBeGreaterThan(10);
      expect(entry.rotation.length, `${entry.key}:${entry.line} rotation`).toBeGreaterThan(5);
      if (entry.secret === 'yes') {
        expect(
          entry.value === '' || entry.value.includes('CHANGE_ME'),
          `${entry.key}:${entry.line} must be blank or an unmistakable placeholder`,
        ).toBe(true);
      }
    }
  });

  it('fails on shipped secret placeholders and parses once required secrets are replaced', () => {
    const exampleEnvironment = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
    expect(() => loadConfig(exampleEnvironment)).toThrow(
      'SESSION_SECRET: replace the example placeholder before production',
    );

    const withSessionSecret = {
      ...exampleEnvironment,
      // Keep committed fixtures deliberately repetitive so they cannot resemble
      // real secret material while still satisfying the schema length floor.
      SESSION_SECRET: '0000000000000000',
    };
    expect(() => loadConfig(withSessionSecret)).toThrow('BT_DATA_ENCRYPTION_KEY:');

    expect(() =>
      loadConfig({
        ...withSessionSecret,
        BT_DATA_ENCRYPTION_KEY: '11111111111111111111111111111111',
      }),
    ).not.toThrow();
  });

  it('allows non-schema assignments only when the production Compose topology consumes them', () => {
    expect(
      sorted(exampleKeys.filter((key) => !schemaKeys.has(key) && !composeInputs.has(key))),
    ).toEqual([]);
  });

  it('documents every owner-supplied Compose input except deploy-generated build metadata', () => {
    const deployGenerated = new Set(['GIT_BUILD_TIME', 'GIT_SHA']);
    expect(
      sorted(
        [...composeInputs].filter((key) => !exampleKeys.includes(key) && !deployGenerated.has(key)),
      ),
    ).toEqual([]);
  });

  it('keeps the focused development example on known schema or deployment keys', () => {
    expect(
      sorted(
        plainExampleKeys(developmentExampleSource).filter(
          (key) => !schemaKeys.has(key) && !composeInputs.has(key),
        ),
      ),
    ).toEqual([]);
  });
});
