import { describe, expect, it } from 'vitest';

import { KNOWN_SECRET_PLACEHOLDERS } from '../../services/password/knownPlaceholders';
import {
  runSeedCommand,
  type SeedAccount,
  type SeedDependencies,
  type SeedOptions,
  type SeedOutput,
  seedOptionsFromEnv,
} from '../seed';

interface SeedHarness {
  dependencies: SeedDependencies;
  output: SeedOutput;
  created: Array<{
    email: string;
    username: string;
    passwordHash: string;
    role?: 'user' | 'admin';
    mustChangePassword?: boolean;
  }>;
  hashedPasswords: string[];
  lookups: string[];
  portfolioOwners: string[];
  info: string[];
  errors: string[];
  catalogCalls: number;
  oauthCalls: number;
}

function harness(existing: readonly SeedAccount[] = []): SeedHarness {
  const rows = new Map(existing.map((account) => [account.email, account]));
  const created: SeedHarness['created'] = [];
  const hashedPasswords: string[] = [];
  const lookups: string[] = [];
  const portfolioOwners: string[] = [];
  const info: string[] = [];
  const errors: string[] = [];
  const state = { catalogCalls: 0, oauthCalls: 0 };

  const dependencies: SeedDependencies = {
    users: {
      async findByEmail(email) {
        lookups.push(email);
        return rows.get(email);
      },
      async create(input) {
        created.push(input);
        const account = {
          id: `created-${created.length}`,
          email: input.email,
          username: input.username,
        };
        rows.set(account.email, account);
        return account;
      },
    },
    portfolios: {
      async createDefault(userId) {
        portfolioOwners.push(userId);
        return { id: `portfolio-${userId}` };
      },
    },
    hasher: {
      async hash(password) {
        hashedPasswords.push(password);
        return `hash-${hashedPasswords.length}`;
      },
    },
    async seedCatalog() {
      state.catalogCalls += 1;
      return { created: 2, existing: 3, refreshed: 1 };
    },
    async seedOAuthClients() {
      state.oauthCalls += 1;
      return [{ clientId: 'bettertrack-mobile', action: 'created', scopes: ['portfolio:read'] }];
    },
  };

  return {
    dependencies,
    output: {
      info: (message) => info.push(message),
      error: (message) => errors.push(message),
    },
    created,
    hashedPasswords,
    lookups,
    portfolioOwners,
    info,
    errors,
    get catalogCalls() {
      return state.catalogCalls;
    },
    get oauthCalls() {
      return state.oauthCalls;
    },
  };
}

function options(overrides: Partial<SeedOptions> = {}): SeedOptions {
  return {
    nodeEnv: 'production',
    adminEmail: 'admin@example.test',
    adminPassword: 'S3ed-admin-correct-horse-943',
    demoEnabled: false,
    ...overrides,
  };
}

describe('seed command credential gates', () => {
  it('rejects the published Grafana <strong> placeholder before hashing or writing', async () => {
    const test = harness();
    const result = await runSeedCommand(
      options({ adminPassword: '<strong>' }),
      test.dependencies,
      test.output,
    );

    expect(result).toBe(1);
    expect(test.created).toEqual([]);
    expect(test.hashedPasswords).toEqual([]);
    expect(test.portfolioOwners).toEqual([]);
    expect(test.catalogCalls).toBe(0);
    expect(test.oauthCalls).toBe(0);
    expect(test.errors.join('\n')).toContain('known published placeholder');
    expect(test.errors.join('\n')).not.toContain('<strong>');
  });

  it('rejects every maintained published placeholder before creating anything in production', async () => {
    const placeholders = new Set([
      ...KNOWN_SECRET_PLACEHOLDERS,
      'CHANGE_ME_IMMEDIATELY_AFTER_FIRST_LOGIN',
      'CHANGE_ME_64_RANDOM_HEX_BYTES_PLEASE',
    ]);

    for (const password of placeholders) {
      const test = harness();
      const result = await runSeedCommand(
        options({ adminPassword: password }),
        test.dependencies,
        test.output,
      );

      expect(result).toBe(1);
      expect(test.created).toEqual([]);
      expect(test.hashedPasswords).toEqual([]);
      expect(test.catalogCalls).toBe(0);
      expect(test.oauthCalls).toBe(0);
      expect(test.errors.join('\n')).toContain('known published placeholder');
      expect(test.errors.join('\n')).not.toContain(password);
    }
  });

  it('rejects short and common production admin passwords before any write', async () => {
    for (const password of ['short', 'football']) {
      const test = harness();
      const result = await runSeedCommand(
        options({ adminPassword: password }),
        test.dependencies,
        test.output,
      );

      expect(result).toBe(1);
      expect(test.created).toEqual([]);
      expect(test.hashedPasswords).toEqual([]);
      expect(test.catalogCalls).toBe(0);
      expect(test.errors.join('\n')).toContain('does not meet the password policy');
      expect(test.errors.join('\n')).not.toContain(password);
    }
  });

  it('keeps non-production first-admin passwords permissive', async () => {
    const test = harness();
    const result = await runSeedCommand(
      options({ nodeEnv: 'development', adminPassword: 'password' }),
      test.dependencies,
      test.output,
    );

    expect(result).toBe(0);
    expect(test.created).toHaveLength(1);
    expect(test.created[0]).toMatchObject({
      email: 'admin@example.test',
      role: 'admin',
      mustChangePassword: false,
    });
    expect(test.hashedPasswords).toEqual(['password']);
    expect([...test.info, ...test.errors].join('\n')).not.toContain('password');
  });

  it('skips an existing admin before inspecting the current bootstrap password', async () => {
    const existingAdmin = {
      id: 'admin-1',
      email: 'admin@example.test',
      username: 'admin',
    };

    for (const adminPassword of [
      undefined,
      'CHANGE_ME_IMMEDIATELY_AFTER_FIRST_LOGIN',
      'password',
      'short',
    ]) {
      const test = harness([existingAdmin]);
      const result = await runSeedCommand(
        options({ adminPassword }),
        test.dependencies,
        test.output,
      );

      expect(result).toBe(0);
      expect(test.created).toEqual([]);
      expect(test.hashedPasswords).toEqual([]);
      expect(test.info.join('\n')).toContain('already exists — skipping seed');
      expect(test.catalogCalls).toBe(1);
      expect(test.oauthCalls).toBe(1);
    }
  });
});

describe('demo seed opt-in and output safety', () => {
  it('defaults demo seeding off and recognizes only the explicit true flag', () => {
    const config = {
      nodeEnv: 'production' as const,
      admin: {
        email: 'admin@example.test',
        password: 'admin-secret',
        sessionLifetimeHours: 12,
      },
    };

    expect(seedOptionsFromEnv(config, {})).toMatchObject({
      demoEnabled: false,
      demoPassword: undefined,
    });
    expect(
      seedOptionsFromEnv(config, {
        BT_SEED_DEMO: 'true',
        BT_DEMO_PASSWORD: 'demo-secret',
      }),
    ).toMatchObject({
      demoEnabled: true,
      demoPassword: 'demo-secret',
    });
    expect(() => seedOptionsFromEnv(config, { BT_SEED_DEMO: 'yes' })).toThrow(
      'BT_SEED_DEMO must be exactly "true" or "false"',
    );
  });

  it('does not look up or create a demo account while the opt-in is off', async () => {
    const test = harness([{ id: 'admin-1', email: 'admin@example.test', username: 'admin' }]);

    expect(await runSeedCommand(options(), test.dependencies, test.output)).toBe(0);
    expect(test.lookups).toEqual(['admin@example.test']);
    expect(test.created).toEqual([]);
  });

  it('leaves an existing demo account untouched without requiring its password', async () => {
    const test = harness([
      { id: 'admin-1', email: 'admin@example.test', username: 'admin' },
      { id: 'demo-1', email: 'demo@bettertrack.local', username: 'demo' },
    ]);

    expect(
      await runSeedCommand(
        options({ adminPassword: undefined, demoEnabled: true, demoPassword: undefined }),
        test.dependencies,
        test.output,
      ),
    ).toBe(0);
    expect(test.created).toEqual([]);
    expect(test.hashedPasswords).toEqual([]);
    expect(test.portfolioOwners).toEqual([]);
    expect(test.info.join('\n')).toContain('Demo user demo@bettertrack.local already exists');
  });

  it('validates a requested new demo before creating the new admin', async () => {
    const test = harness();

    expect(
      await runSeedCommand(
        options({ demoEnabled: true, demoPassword: undefined }),
        test.dependencies,
        test.output,
      ),
    ).toBe(1);
    expect(test.created).toEqual([]);
    expect(test.hashedPasswords).toEqual([]);
    expect(test.errors.join('\n')).toContain('BT_DEMO_PASSWORD must be set');
  });

  it('uses env-supplied passwords without writing either credential to output', async () => {
    const adminPassword = 'S3ed-admin-correct-horse-943';
    const demoPassword = 'S3ed-demo-correct-horse-943';
    const test = harness();

    expect(
      await runSeedCommand(
        options({ adminPassword, demoEnabled: true, demoPassword }),
        test.dependencies,
        test.output,
      ),
    ).toBe(0);
    expect(test.created.map((row) => row.role)).toEqual(['admin', 'user']);
    expect(test.hashedPasswords).toEqual([adminPassword, demoPassword]);
    expect(test.portfolioOwners).toEqual(['created-2']);
    expect(test.catalogCalls).toBe(1);
    expect(test.oauthCalls).toBe(1);

    const commandOutput = [...test.info, ...test.errors].join('\n');
    expect(commandOutput).not.toContain(adminPassword);
    expect(commandOutput).not.toContain(demoPassword);
    expect(commandOutput).not.toContain('Temporary password');
  });

  it('reports an unexpected error type without exposing its message', async () => {
    const sensitiveDetail = 'postgres://operator:secret@example.test/bettertrack';
    const test = harness();
    test.dependencies.users.findByEmail = async () => {
      const error = new Error(`connection refused: ${sensitiveDetail}`);
      error.name = 'PostgresError';
      throw error;
    };

    expect(await runSeedCommand(options(), test.dependencies, test.output)).toBe(1);
    expect(test.errors.join('\n')).toContain('PostgresError');
    expect(test.errors.join('\n')).not.toContain(sensitiveDetail);
  });
});
