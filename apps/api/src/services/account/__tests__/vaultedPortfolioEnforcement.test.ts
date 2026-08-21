import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  PARANOID_KILLED_CAPABILITIES,
  type ParanoidKilledCapability,
} from '@bettertrack/contracts';

import type { AuthUser } from '../../../http/types';
import { bindParanoidJob, type JobDefinition } from '../../../jobs';
import {
  invokeRegisteredServiceSubject,
  PARANOID_JOB_POLICIES,
  PARANOID_KILL_REGISTRY,
  type ParanoidModeGuard,
  type ParanoidServiceBinding,
  type ParanoidServiceGuardResolvers,
  type ParanoidServiceSubject,
  type VaultedPortfolioFeatureRegistryEntry,
} from '../paranoidEnforcement';
import {
  createVaultedPortfolioGuard,
  createVaultedPortfolioRouteGuard,
  isVaultedPortfolioTransitionCarveout,
  VAULTED_PORTFOLIO_ERROR_CODE,
  VAULTED_PORTFOLIO_FEATURE_REGISTRY,
  VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY,
  vaultedPortfolioTargetForRequest,
  type VaultedPortfolioSubject,
} from '../vaultedPortfolioEnforcement';

const OWNER_ID = '018f0000-0000-7000-8000-000000000001';
const OTHER_OWNER_ID = '018f0000-0000-7000-8000-000000000002';
const VAULT_ID = '018f0000-0000-7000-8000-000000000003';
const VAULTED_ID = '018f0000-0000-7000-8000-000000000004';
const SIBLING_PLAIN_ID = '018f0000-0000-7000-8000-000000000005';
const CONTROL_PLAIN_ID = '018f0000-0000-7000-8000-000000000006';
const FOREIGN_VAULTED_ID = '018f0000-0000-7000-8000-000000000007';
const MISSING_ID = '018f0000-0000-7000-8000-000000000008';
const CONTROL_OWNER_ID = '018f0000-0000-7000-8000-000000000009';

// TEST VECTOR: identity-only states exercise the boundary without storing any
// plaintext portfolio content or embedding a credential-shaped fixture.
const SUBJECTS = new Map<string, VaultedPortfolioSubject>([
  [VAULTED_ID, { exists: true, userId: OWNER_ID, vaultId: VAULT_ID }],
  [SIBLING_PLAIN_ID, { exists: true, userId: OWNER_ID, vaultId: null }],
  [CONTROL_PLAIN_ID, { exists: true, userId: CONTROL_OWNER_ID, vaultId: null }],
  [FOREIGN_VAULTED_ID, { exists: true, userId: OTHER_OWNER_ID, vaultId: VAULT_ID }],
  [MISSING_ID, { exists: false, userId: null, vaultId: null }],
]);

function subject(portfolioId: string): Promise<VaultedPortfolioSubject> {
  return Promise.resolve(
    SUBJECTS.get(portfolioId) ?? { exists: false, userId: null, vaultId: null },
  );
}

const NORMAL_MODE_GUARD: ParanoidModeGuard = {
  async isParanoid() {
    return false;
  },
  async assertAllowed() {},
  async runAllowed(_userId, _capability, action) {
    return action();
  },
  async runAllowedMany(_userIds, _capability, action) {
    return action();
  },
  async runAllowedWithOptional(_required, optional, _capability, action) {
    return action(new Set(optional));
  },
};

const MATRIX_RESOLVERS: ParanoidServiceGuardResolvers = {
  portfolioOwner: subject,
  assetOwner: subject,
  importBatchPortfolio: async (_userId, batchId) => subject(batchId),
  standingOrderPortfolio: async (_userId, standingOrderId) => subject(standingOrderId),
  cashBudgetPortfolio: async (_userId, budgetId) => subject(budgetId),
  cashMovementPortfolio: async (_userId, movementId) => subject(movementId),
};

const MATRIX_SERVICE_SUBJECTS = new Set<ParanoidServiceSubject>([
  'portfolioIdFirst',
  'portfolioIdFirstAllowMissing',
  'portfolioIdSecond',
  'optionalPortfolioIdSecond',
  'portfolioIdFieldSecond',
  'userAndPortfolioIdFields',
  'importBatchIdSecond',
  'portfolioAudienceTarget',
  'optionalPortfolioIdOptionSecond',
  'standingOrderIdSecond',
  'cashBudgetIdSecond',
  'cashMovementIdSecond',
  'paranoidWebhookSubjects',
]);

function matrixServiceArgs(
  binding: ParanoidServiceBinding,
  userId: string,
  portfolioId: string,
): unknown[] {
  switch (binding.subject) {
    case 'portfolioIdFirst':
    case 'portfolioIdFirstAllowMissing':
      return [portfolioId];
    case 'portfolioIdSecond':
    case 'optionalPortfolioIdSecond':
      return [userId, portfolioId];
    case 'portfolioIdFieldSecond':
      return [userId, { portfolioId }];
    case 'userAndPortfolioIdFields':
      return [{ userId, portfolioId }];
    case 'portfolioAudienceTarget':
      return [userId, 'portfolio', portfolioId];
    case 'optionalPortfolioIdOptionSecond':
      return [userId, { portfolioId }];
    case 'importBatchIdSecond':
    case 'standingOrderIdSecond':
    case 'cashBudgetIdSecond':
    case 'cashMovementIdSecond':
      // The matrix resolver treats the resource id as its owning portfolio id.
      return [userId, portfolioId];
    case 'paranoidWebhookSubjects':
      return [{ type: 'portfolio.changed', userId, portfolioId }];
    default:
      throw new Error(
        `matrix has no portfolio adapter for ${binding.service}.${binding.methods.join(',')}:${binding.subject}`,
      );
  }
}

function matrixEvidenceBytes(entry: VaultedPortfolioFeatureRegistryEntry): Buffer {
  return Buffer.from(
    JSON.stringify({
      routes: entry.evidence.routes.map(({ capability, rule }) => ({
        capability,
        method: rule.method ?? null,
        exact: rule.exact ?? null,
        prefix: rule.prefix ?? null,
        pattern: rule.pattern?.source ?? null,
      })),
      services: entry.evidence.services.map(
        ({ capability, service, methods, subject: serviceSubject, action }) => ({
          capability,
          service,
          methods,
          subject: serviceSubject,
          action: action ?? 'throw',
        }),
      ),
      jobs: entry.evidence.jobs,
      scopes: entry.evidence.scopes,
      webhookEvents: entry.evidence.webhookEvents,
    }),
    'utf8',
  );
}

describe('vaulted portfolio enforcement registry', () => {
  it('derives every section 11 row and its executable boundary evidence from the kill registry', () => {
    expect(VAULTED_PORTFOLIO_FEATURE_REGISTRY.map((entry) => entry.sectionItem)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    const ids = VAULTED_PORTFOLIO_FEATURE_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.flatMap((entry) => entry.capabilities).sort(),
    ).toEqual([...PARANOID_KILLED_CAPABILITIES].sort());
    for (const entry of VAULTED_PORTFOLIO_FEATURE_REGISTRY) {
      const entryCapabilities = entry.capabilities as readonly ParanoidKilledCapability[];
      expect(entry.description.trim(), entry.id).not.toBe('');
      expect(entry.matrix).toMatchObject({
        siblingPlain: 'allow',
        vaultFree: 'allow',
        allowedParity: 'byte-identical',
      });

      const centralRows = PARANOID_KILL_REGISTRY.filter((row) =>
        entryCapabilities.includes(row.capability),
      );
      expect(
        centralRows.map((row) => row.capability).sort(),
        `${entry.id} must be backed by the executable kill registry`,
      ).toEqual([...entry.capabilities].sort());
      expect(
        [...new Set(centralRows.flatMap((row) => row.scopes))].sort(),
        `${entry.id} scope evidence`,
      ).toEqual([...entry.scopes].sort());
      const actualJobModes = [
        ...new Set(
          PARANOID_JOB_POLICIES.filter(
            (policy) =>
              policy.policy.capability !== null &&
              entryCapabilities.includes(policy.policy.capability),
          ).map((policy) => policy.policy.mode),
        ),
      ].sort();
      expect(actualJobModes, `${entry.id} job-mode evidence`).toEqual([...entry.jobModes].sort());
      expect(
        entry.evidence.routes.length +
          entry.evidence.services.length +
          entry.evidence.jobs.length +
          entry.evidence.scopes.length +
          entry.evidence.webhookEvents.length,
        `${entry.id} must contain executable evidence`,
      ).toBeGreaterThan(0);
      const evidenceCapabilities = [
        ...entry.evidence.routes.map((evidence) => evidence.capability),
        ...entry.evidence.services.map((evidence) => evidence.capability),
        ...entry.evidence.jobs.map((evidence) => evidence.capability),
        ...entry.evidence.scopes.map((evidence) => evidence.capability),
        ...entry.evidence.webhookEvents.map((evidence) => evidence.capability),
      ];
      expect(
        [...new Set(evidenceCapabilities)].sort(),
        `${entry.id} evidence must cover every grouped capability`,
      ).toEqual([...entry.capabilities].sort());
      if (entry.matrix.vaulted === 'skip') {
        expect(
          entry.evidence.jobs.length + entry.evidence.webhookEvents.length,
          `${entry.id} skip policy needs an executable deferred/event rail`,
        ).toBeGreaterThan(0);
      } else {
        expect(
          entry.evidence.routes.length +
            entry.evidence.services.length +
            entry.evidence.scopes.length,
          `${entry.id} refusal policy needs an executable request/service/scope rail`,
        ).toBeGreaterThan(0);
      }
    }

    // Identity-preserving census: the seven-row matrix contains references to
    // every executable registry object. It cannot be kept green by a second
    // hand-written feature list after a route/service/job/scope/event is added.
    const routeKey = ({
      capability,
      rule,
    }: (typeof VAULTED_PORTFOLIO_FEATURE_REGISTRY)[number]['evidence']['routes'][number]) =>
      JSON.stringify([
        capability,
        rule.method ?? null,
        rule.exact ?? null,
        rule.prefix ?? null,
        rule.pattern?.source ?? null,
        rule.pattern?.flags ?? null,
      ]);
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.flatMap((entry) => entry.evidence.routes)
        .map(routeKey)
        .sort(),
    ).toEqual(
      PARANOID_KILL_REGISTRY.flatMap((row) =>
        row.routes.map((rule) => routeKey({ capability: row.capability, rule })),
      ).sort(),
    );
    const serviceKey = (
      evidence: (typeof VAULTED_PORTFOLIO_FEATURE_REGISTRY)[number]['evidence']['services'][number],
    ) =>
      JSON.stringify([
        evidence.capability,
        evidence.service,
        evidence.subject,
        evidence.methods,
        evidence.action ?? null,
      ]);
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.flatMap((entry) => entry.evidence.services)
        .map(serviceKey)
        .sort(),
    ).toEqual(
      PARANOID_KILL_REGISTRY.flatMap((row) => row.services)
        .map(serviceKey)
        .sort(),
    );
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.flatMap((entry) => entry.evidence.scopes)
        .map(({ capability, scope }) => `${capability}:${scope}`)
        .sort(),
    ).toEqual(
      PARANOID_KILL_REGISTRY.flatMap((row) =>
        row.scopes.map((scope) => `${row.capability}:${scope}`),
      ).sort(),
    );
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.flatMap((entry) => entry.evidence.jobs)
        .map(({ capability, name, mode }) => `${capability}:${name}:${mode}`)
        .sort(),
    ).toEqual(
      PARANOID_JOB_POLICIES.filter((entry) => entry.policy.capability !== null)
        .map(({ surface, policy }) => `${policy.capability!}:${surface.name}:${policy.mode}`)
        .sort(),
    );
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.flatMap((entry) => entry.evidence.webhookEvents)
        .map(({ capability, eventType }) => `${capability}:${eventType}`)
        .sort(),
    ).toEqual(
      PARANOID_KILL_REGISTRY.flatMap((row) =>
        row.webhookEventTypes.map((eventType) => `${row.capability}:${eventType}`),
      ).sort(),
    );
  });

  it.each(VAULTED_PORTFOLIO_FEATURE_REGISTRY)(
    'executes the registry-selected vaulted/plain/control boundary for section $sectionItem ($id)',
    async (entry) => {
      const guard = createVaultedPortfolioGuard({ portfolioSubject: subject });
      const resultBytes = matrixEvidenceBytes(entry);
      const serviceBoundary = entry.evidence.services.find(
        (binding) =>
          MATRIX_SERVICE_SUBJECTS.has(binding.subject) &&
          (entry.matrix.vaulted === 'skip' ? binding.action === 'skip' : binding.action !== 'skip'),
      );
      expect(resultBytes.byteLength, `${entry.id} executable evidence bytes`).toBeGreaterThan(2);

      const portfolioJob = entry.evidence.jobs.find((job) => job.mode === 'portfolio');
      const runServiceBoundary = serviceBoundary
        ? async (userId: string, portfolioId: string): Promise<Buffer | undefined> =>
            invokeRegisteredServiceSubject(
              serviceBoundary,
              matrixServiceArgs(serviceBoundary, userId, portfolioId),
              NORMAL_MODE_GUARD,
              MATRIX_RESOLVERS,
              guard,
              async () => resultBytes,
            )
        : null;
      const runPortfolioJob = portfolioJob
        ? async (_userId: string, portfolioId: string): Promise<Buffer | undefined> => {
            let output: Buffer | undefined;
            const definition = {
              name: portfolioJob.name,
              async handler() {
                output = resultBytes;
              },
            } as JobDefinition;
            const guardedDefinition = bindParanoidJob(definition, {
              mode: 'portfolio',
              runIfAllowed: (targetPortfolioId, action) =>
                guard.runJobIfAllowed(targetPortfolioId, action),
            });
            await guardedDefinition.handler(
              { data: { portfolioId } } as never,
              { logger: { info: vi.fn() } } as never,
            );
            return output;
          }
        : null;
      const runScopeBoundary =
        entry.evidence.scopes.length > 0
          ? async (userId: string, portfolioId: string): Promise<Buffer> => {
              const middleware = createVaultedPortfolioRouteGuard(guard);
              const error = await new Promise<unknown>((resolve) => {
                middleware(
                  {
                    method: 'GET',
                    path: `/portfolios/${portfolioId}`,
                    authUser: { id: userId } as AuthUser,
                  } as Request,
                  {} as Response,
                  ((nextError?: unknown) => resolve(nextError)) as NextFunction,
                );
              });
              if (error) throw error;
              return resultBytes;
            }
          : null;

      // Selection is policy/evidence-driven, never keyed by a §11 row id:
      // deferred work uses a real bound portfolio job; request-time features
      // use their real registered service subject; the scope-only row uses the
      // actual global portfolio route guard.
      const runBoundary =
        entry.matrix.vaulted === 'skip'
          ? (runPortfolioJob ?? runServiceBoundary)
          : (runServiceBoundary ?? runScopeBoundary);
      expect(runBoundary, `${entry.id} needs an executable behavioral boundary`).not.toBeNull();

      if (entry.matrix.vaulted === 'refuse') {
        await expect(runBoundary!(OWNER_ID, VAULTED_ID)).rejects.toMatchObject({
          statusCode: 403,
          code: VAULTED_PORTFOLIO_ERROR_CODE,
        });
      } else {
        await expect(runBoundary!(OWNER_ID, VAULTED_ID)).resolves.toBeUndefined();
      }

      const sibling = await runBoundary!(OWNER_ID, SIBLING_PLAIN_ID);
      const control = await runBoundary!(CONTROL_OWNER_ID, CONTROL_PLAIN_ID);
      expect(Buffer.isBuffer(sibling), `${entry.id} sibling output`).toBe(true);
      expect(Buffer.isBuffer(control), `${entry.id} vault-free output`).toBe(true);
      expect(sibling!.equals(control!)).toBe(true);
    },
  );
});

describe('vaulted portfolio guard semantics', () => {
  it('lets foreign and missing owner-scoped targets reach the existing opaque authorization', async () => {
    const guard = createVaultedPortfolioGuard({ portfolioSubject: subject });
    const foreignAction = vi.fn(async () => 'foreign repository 404');
    const missingAction = vi.fn(async () => 'missing repository 404');

    await expect(
      guard.runOwnedPortfolioAllowed(OWNER_ID, FOREIGN_VAULTED_ID, foreignAction),
    ).resolves.toBe('foreign repository 404');
    await expect(guard.runOwnedPortfolioAllowed(OWNER_ID, MISSING_ID, missingAction)).resolves.toBe(
      'missing repository 404',
    );
    expect(foreignAction).toHaveBeenCalledOnce();
    expect(missingAction).toHaveBeenCalledOnce();
  });

  it('fails job work closed for a missing row and holds the optional lock through actions', async () => {
    let lockHeld = false;
    const action = vi.fn(async () => {
      expect(lockHeld).toBe(true);
    });
    const guard = createVaultedPortfolioGuard({
      portfolioSubject: subject,
      withLockedPortfolioSubject: async (portfolioId, run) => {
        lockHeld = true;
        try {
          return await run(await subject(portfolioId));
        } finally {
          lockHeld = false;
        }
      },
    });

    await expect(guard.runJobIfAllowed(MISSING_ID, action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    await expect(guard.runJobIfAllowed(SIBLING_PLAIN_ID, action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledOnce();
    expect(lockHeld).toBe(false);
  });
});

describe('vaulted portfolio HTTP target defense', () => {
  it('extracts path, validated query, and body targets without swallowing shared non-portfolios', () => {
    expect(
      vaultedPortfolioTargetForRequest({ method: 'GET', path: `/portfolios/${VAULTED_ID}/cash` }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'path' });
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'GET',
        path: `/api/v1/analytics/portfolios/${VAULTED_ID}`,
      }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'path' });
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'GET',
        path: `/social/shared/${VAULTED_ID}`,
      }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'path' });
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'GET',
        path: `/social/shared/conglomerates/${VAULTED_ID}`,
      }),
    ).toBeNull();
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'GET',
        path: '/aggregate',
        valid: { query: { portfolioId: VAULTED_ID } },
      }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'query' });
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'POST',
        path: '/imports',
        body: { portfolioId: VAULTED_ID },
      }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'body' });
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'POST',
        path: '/social/item-follows',
        body: { kind: 'portfolio', subjectId: VAULTED_ID },
      }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'body' });
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'POST',
        path: `/social/items/portfolio/${VAULTED_ID}/comments`,
      }),
    ).toEqual({ portfolioId: VAULTED_ID, source: 'path' });
  });

  it('leaves malformed uuid values to the normal route validators', () => {
    expect(
      vaultedPortfolioTargetForRequest({ method: 'GET', path: '/portfolios/not-a-uuid' }),
    ).toBeNull();
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'GET',
        path: '/aggregate',
        query: { portfolioId: 'bad' },
      }),
    ).toBeNull();
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'POST',
        path: '/imports',
        body: { portfolioId: 'bad' },
      }),
    ).toBeNull();
  });

  it('allows only the ruled revision and move-out exit routes for a vaulted id', () => {
    expect(
      VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY.map(({ method, operation }) => ({
        method,
        operation,
      })),
    ).toEqual([
      { method: 'GET', operation: 'revision' },
      { method: 'POST', operation: 'move-out' },
    ]);
    expect(
      VAULTED_PORTFOLIO_FEATURE_REGISTRY.filter(
        (entry) => (entry.transitionCarveouts?.length ?? 0) > 0,
      ).map((entry) => ({ id: entry.id, carveouts: entry.transitionCarveouts })),
    ).toEqual([
      {
        id: 'portfolio-api-access',
        carveouts: VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY,
      },
    ]);
    for (const entry of VAULTED_PORTFOLIO_TRANSITION_CARVEOUT_REGISTRY) {
      expect(entry.reason.trim(), `${entry.method} ${entry.operation} needs a rationale`).not.toBe(
        '',
      );
    }
    expect(
      isVaultedPortfolioTransitionCarveout(
        'GET',
        `/api/v1/portfolios/${VAULTED_ID}/vault/revision`,
      ),
    ).toBe(true);
    expect(
      isVaultedPortfolioTransitionCarveout('POST', `/portfolios/${VAULTED_ID}/vault/move-out`),
    ).toBe(true);
    expect(
      isVaultedPortfolioTransitionCarveout('POST', `/portfolios/${VAULTED_ID}/vault/move-in`),
    ).toBe(false);
    expect(
      isVaultedPortfolioTransitionCarveout('GET', `/portfolios/${VAULTED_ID}/vault/move-out`),
    ).toBe(false);
    expect(
      vaultedPortfolioTargetForRequest({
        method: 'POST',
        path: `/portfolios/${VAULTED_ID}/vault/move-out`,
      }),
    ).toBeNull();
  });

  it('returns VAULTED_PORTFOLIO from middleware only for the owned locked stub', async () => {
    const guard = createVaultedPortfolioGuard({ portfolioSubject: subject });
    const middleware = createVaultedPortfolioRouteGuard(guard);
    const invoke = (path: string): Promise<unknown> =>
      new Promise((resolve) => {
        middleware(
          {
            method: 'GET',
            path,
            authUser: { id: OWNER_ID } as AuthUser,
          } as Request,
          {} as Response,
          ((error?: unknown) => resolve(error)) as NextFunction,
        );
      });

    await expect(invoke(`/portfolios/${VAULTED_ID}`)).resolves.toMatchObject({
      statusCode: 403,
      code: VAULTED_PORTFOLIO_ERROR_CODE,
    });
    // Default closed: a future portfolio route is refused by the portfolio
    // boundary before it has a chance to acquire an explicit feature policy.
    await expect(invoke(`/portfolios/${VAULTED_ID}/future-operation`)).resolves.toMatchObject({
      statusCode: 403,
      code: VAULTED_PORTFOLIO_ERROR_CODE,
    });
    await expect(invoke(`/portfolios/${SIBLING_PLAIN_ID}`)).resolves.toBeUndefined();
    await expect(invoke(`/portfolios/${FOREIGN_VAULTED_ID}`)).resolves.toBeUndefined();
    await expect(invoke(`/portfolios/${VAULTED_ID}/vault/revision`)).resolves.toBeUndefined();
  });
});
