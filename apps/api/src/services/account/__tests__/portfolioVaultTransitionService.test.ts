import { createHash, createPrivateKey, sign } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import {
  encodeVaultDocEnvelope,
  PORTFOLIO_VAULT_MOVE_OUT_CHALLENGE_TTL_MS,
  portfolioVaultMoveInRequestSchema,
  portfolioVaultMoveOutRequestSchema,
  readVaultDocServerHeader,
  serializePortfolioVaultMoveOutProofTranscript,
  serializeVaultRetirementVersionSet,
  VAULT_CONTENT_CIPHER,
  type PortfolioVaultMoveInRequest,
  type PortfolioVaultMoveOutRequest,
  type Quote,
  type VaultDocKind,
  type VaultMirrorProvenance,
  type VaultStrictDocumentV1,
} from '@bettertrack/contracts';

import {
  alerts,
  assetIdentities,
  assets,
  auditLog,
  cashBudgetFires,
  cashBudgets,
  cashMovementTags,
  cashTags,
  dividends,
  exportJobs,
  importBatches,
  importRows,
  itemComments,
  itemFollows,
  itemReactions,
  mirrorChainMembers,
  mirrorChains,
  mirrorRows,
  notifications,
  portfolioCashMovements,
  portfolioCashSources,
  portfolioDailySnapshots,
  portfolioSettings,
  portfolioSnapshotState,
  portfolioVaultTransitionStates,
  portfolios,
  shareAudienceLinks,
  shareAudienceMembers,
  shareAudiences,
  sharedItemActivityPrefs,
  standingOrderRuns,
  standingOrders,
  transactions,
  vaultBlobHistory,
  vaultBlobs,
  vaultServerCandidates,
  vaults,
} from '../../../data/schema';
import * as schema from '../../../data/schema';
import { createAlertRepository } from '../../../data/repositories/alertRepository';
import { createAuditRepository } from '../../../data/repositories/auditRepository';
import { withLockedPrivacyModes } from '../../../data/repositories/paranoidEnforcementRepository';
import { PARANOID_RETIRED_EXPORT_ERROR } from '../../../data/repositories/paranoidTransitionRepository';
import { withPortfolioVaultTransitionTransaction } from '../../../data/repositories/portfolioVaultTransitionRepository';
import { createVaultBlobRepository } from '../../../data/repositories/vaultBlobRepository';
import {
  assertVaultedPortfolioHasNoCleartext,
  vaultedPortfolioStubName,
} from '../../../data/repositories/vaultedPortfolioProbe';
import { createTestApp, type SeededUser, type TestHarness } from '../../../testing/createTestApp';
import { createStubMarketData } from '../../../testing/marketDataStubs';
import { AuditAction, createAuditService, type AuditService } from '../../audit/auditService';
import { runAlertsEvaluation } from '../../alerts/alertEvaluator';
import {
  ACCOUNT_VAULT_DELETE_NAMESPACE,
  LOGIN_ACCOUNT_NAMESPACE,
  PORTFOLIO_VAULT_MOVE_IN_NAMESPACE,
  PORTFOLIO_VAULT_MOVE_OUT_NAMESPACE,
} from '../../auth/loginThrottle';
import { generateTotpCode, TOTP_STEP_SECONDS } from '../../auth/totp';
import {
  fenceRetiredLiveAssets,
  readLiveAssetRetirementGeneration,
  reconcilePortfolioVaultLiveAssetRetirements,
  releaseRetiredLiveAssets,
} from '../../liveMode';
import { progressiveKeys } from '../../security/progressiveLimiter';
import type { VaultDeleteReauth } from '../paranoidDiscardReauth';
import {
  VAULTED_PORTFOLIO_ERROR_CODE,
  VAULTED_PORTFOLIO_FEATURE_REGISTRY,
} from '../vaultedPortfolioEnforcement';
import {
  createPortfolioVaultMoveOutFinalizer,
  createPortfolioVaultTransitionService,
  PORTFOLIO_VAULT_TRANSITION_HTTP_ERRORS,
  type PortfolioVaultMoveInStage,
  type PortfolioVaultMoveOutPostCommitPlan,
  type PortfolioVaultMoveOutStage,
  type PortfolioVaultTransitionServiceDeps,
  type PortfolioVaultTransitionService,
} from '../portfolioVaultTransitionService';
import {
  issuePortfolioVaultMoveOutChallenge,
  portfolioVaultRestoreDocumentDigest,
  verifyPortfolioVaultMoveOutChallenge,
} from '../portfolioVaultPhraseProof';

const REAL_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

interface DatabaseLockWait {
  pid: number;
  query: string;
  waitEventType: string | null;
  blockingPids: number[];
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function backendPid(client: ReturnType<typeof postgres>): Promise<number> {
  const [row] = await client<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  if (!row) throw new Error('Postgres did not return a backend pid');
  return Number(row.pid);
}

async function waitForStarted(
  started: Deferred,
  owner: Promise<unknown>,
  description: string,
): Promise<void> {
  await Promise.race([
    started.promise,
    owner.then(() => {
      throw new Error(`${description} finished before reaching its hold point`);
    }),
  ]);
}

async function waitForAccountUpdateLock(
  observer: ReturnType<typeof postgres>,
  blockedByPid: number,
): Promise<DatabaseLockWait> {
  const deadline = Date.now() + 5_000;
  let observed: DatabaseLockWait[] = [];
  while (Date.now() < deadline) {
    observed = await observer<DatabaseLockWait[]>`
      SELECT
        pid,
        query,
        wait_event_type AS "waitEventType",
        pg_blocking_pids(pid) AS "blockingPids"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
    `;
    const waiting = observed.find(
      (row) =>
        row.blockingPids.map(Number).includes(blockedByPid) &&
        /from\s+"?users"?/iu.test(row.query) &&
        /for update/iu.test(row.query),
    );
    if (waiting) return waiting;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for the E4 users-row lock; observed ${JSON.stringify(
      observed.map(({ pid, query, waitEventType, blockingPids }) => ({
        pid,
        query,
        waitEventType,
        blockingPids,
      })),
    )}`,
  );
}

/** Exercise production row locks even though Vitest normally selects the PGlite lock emulator. */
async function withProductionPrivacyLocks<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

// Deterministic TEST VECTOR UUIDs and bytes. The strings below are fixtures,
// not credentials or production ciphertext.
const id = (value: number) => `019c8400-0000-7000-8000-${value.toString(16).padStart(12, '0')}`;

const TEST_VECTOR = {
  vaultId: id(1),
  headerDocId: id(2),
  commonDocId: id(3),
  targetPortfolioId: id(4),
  siblingPortfolioId: id(5),
  assetId: id(6),
  alertId: id(7),
  targetSourceId: id(8),
  siblingSourceId: id(9),
  targetDepositId: id(10),
  targetTransactionId: id(11),
  targetBuyMovementId: id(12),
  targetDividendId: id(13),
  targetDividendMovementId: id(14),
  siblingDepositId: id(15),
  siblingTransactionId: id(16),
  targetOrderId: id(17),
  targetOrderRunId: id(18),
  siblingOrderId: id(19),
  cashTagId: id(20),
  targetMovementTagId: id(21),
  targetBudgetId: id(22),
  targetBudgetFireId: id(23),
  siblingBudgetId: id(24),
  targetBatchId: id(25),
  targetImportRowId: id(26),
  siblingBatchId: id(27),
  mirrorChainId: id(28),
  mirrorMembershipId: id(29),
  mirrorId: id(30),
  audienceId: id(31),
  audienceLinkId: id(32),
  commentId: id(33),
  reactionId: id(34),
  deviceId: id(35),
  keyId: id(36),
  exportJobId: id(37),
  moveOutId: id(38),
  replayMoveOutId: id(39),
  foreignPortfolioId: id(40),
  provenanceChainId: id(41),
  provenanceMembershipId: id(42),
  provenanceMirrorId: id(43),
  provenanceLocalId: id(44),
  targetSettingEntityId: id(45),
  exclusiveAssetId: id(46),
  exclusiveAssetTransactionId: id(47),
  secondExclusiveAssetId: id(48),
  secondExclusiveAssetTransactionId: id(49),
  tombstonedAssetId: id(50),
  ownerExportJobId: id(51),
  foreignExportJobId: id(52),
  at: new Date('2026-08-21T10:00:00.000Z'),
  depositAt: new Date('2026-08-20T08:00:00.000Z'),
  buyAt: new Date('2026-08-20T09:00:00.000Z'),
  dividendAt: new Date('2026-08-20T10:00:00.000Z'),
} as const;

const TARGET_NAME = 'TEST VECTOR destructive-core target';
const SIBLING_NAME = 'TEST VECTOR plain sibling';
const DOC_VERSION = 7;
const OWNER_EXPORT_PATH = '/tmp/TEST_VECTOR-owner-cleartext-export.zip';
const FOREIGN_EXPORT_PATH = '/tmp/TEST_VECTOR-foreign-cleartext-export.zip';
const OWNER_EXPORT_TOKEN_HASH = 'TEST_VECTOR_owner_export_download_token_hash';
const FOREIGN_EXPORT_TOKEN_HASH = 'TEST_VECTOR_foreign_export_download_token_hash';

function encryptedDocumentSetHash(portfolioVersion = DOC_VERSION): string {
  return createHash('sha256')
    .update(
      serializeVaultRetirementVersionSet([
        { docId: TEST_VECTOR.headerDocId, docVersion: 3 },
        { docId: TEST_VECTOR.commonDocId, docVersion: 4 },
        { docId: TEST_VECTOR.targetPortfolioId, docVersion: portfolioVersion },
      ]),
    )
    .digest('base64url');
}
// RFC 8032 Ed25519 TEST VECTOR 1. Public standard material, never a secret.
const TEST_VECTOR_RETIREMENT_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
);
const TEST_VECTOR_RETIREMENT_PUBLIC = Buffer.from(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
);
const TEST_VECTOR_RETIREMENT_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    TEST_VECTOR_RETIREMENT_SEED,
  ]),
  format: 'der',
  type: 'pkcs8',
});
const TEST_VECTOR_RETIREMENT_PUBLIC_KEY = Buffer.concat([
  Buffer.from('302a300506032b6570032100', 'hex'),
  TEST_VECTOR_RETIREMENT_PUBLIC,
]).toString('base64url');
const TEST_VECTOR_CHALLENGE_NONCE = 'TEST_VECTOR_move_out_challenge_nonce';

type StrictEntity = VaultStrictDocumentV1['entities'][number];

function strictEntity<K extends StrictEntity['kind']>(
  entityId: string,
  kind: K,
  data: Extract<StrictEntity, { kind: K }>['data'],
): Extract<StrictEntity, { kind: K }> {
  return {
    id: entityId,
    kind,
    rev: 0,
    editedAt: TEST_VECTOR.at.toISOString(),
    editedBy: TEST_VECTOR.deviceId,
    deletedAt: null,
    data,
  } as Extract<StrictEntity, { kind: K }>;
}

function envelope(docId: string, docKind: VaultDocKind, docVersion: number): Buffer {
  const kindOffset = docKind === 'portfolio' ? 10 : docKind === 'common' ? 20 : 30;
  return Buffer.from(
    encodeVaultDocEnvelope(
      {
        formatVersion: 2,
        cipher: VAULT_CONTENT_CIPHER,
        iv: 'AA',
        keyId: TEST_VECTOR.keyId,
        keySlots: [
          {
            keyId: TEST_VECTOR.keyId,
            slot: 'seed-v1',
            wrappedKc: 'TEST_VECTOR_wrapped_content_key',
          },
        ],
        vaultId: TEST_VECTOR.vaultId,
        docId,
        docKind,
        accountBinding: 'A'.repeat(43),
        docVersion,
        schemaVersion: 1,
        deviceId: TEST_VECTOR.deviceId,
        writeId: id(100 + docVersion + kindOffset),
        writtenAt: TEST_VECTOR.at.toISOString(),
      },
      new Uint8Array([0, 255, 19, docVersion]),
    ),
  );
}

let h: TestHarness;
let user: SeededUser;
let viewer: SeededUser;

beforeEach(async () => {
  h = await createTestApp({ portfolioVaultTransitionNow: () => TEST_VECTOR.at });
  user = await h.seedUser({
    email: 'portfolio-vault-transition@bettertrack.test',
    username: 'portfolio_vault_transition',
  });
  viewer = await h.seedUser({
    email: 'portfolio-vault-viewer@bettertrack.test',
    username: 'portfolio_vault_viewer',
  });
  await seedFullGraph();
});

// NOTE: no redis.quit() here — the redis handle is the shared module-level
// singleton; quitting it in real-Redis (integration) mode kills every later
// suite in the singleFork process (the #1456 landmine class).

async function seedFullGraph(): Promise<void> {
  await h.db.insert(vaults).values({
    id: TEST_VECTOR.vaultId,
    userId: user.id,
    name: 'TEST VECTOR vault alias',
    headerDocId: TEST_VECTOR.headerDocId,
    commonDocId: TEST_VECTOR.commonDocId,
    media: ['server'],
    retirementProofPublicKey: TEST_VECTOR_RETIREMENT_PUBLIC_KEY,
    keyFingerprint: 'TEST-VECTOR-FINGERPRINT',
  });
  await h.db.insert(portfolios).values([
    {
      id: TEST_VECTOR.targetPortfolioId,
      userId: user.id,
      name: TARGET_NAME,
      visibility: 'friends',
      sortOrder: 1,
      defaultPayFromCash: true,
      kind: 'business',
    },
    {
      id: TEST_VECTOR.siblingPortfolioId,
      userId: user.id,
      name: SIBLING_NAME,
      visibility: 'friends',
      sortOrder: 2,
      defaultPayFromCash: true,
      kind: 'savings',
    },
  ]);
  await h.db.insert(assets).values({
    id: TEST_VECTOR.assetId,
    providerId: 'test-vector-provider',
    providerRef: 'test-vector-asset',
    type: 'stock',
    symbol: 'TVEC',
    name: 'TEST VECTOR catalog asset',
    currency: 'EUR',
  });
  await h.db.insert(alerts).values({
    id: TEST_VECTOR.alertId,
    userId: user.id,
    assetId: TEST_VECTOR.assetId,
    kind: 'price_above',
    threshold: '123',
    repeat: true,
    status: 'active',
  });
  await h.db.insert(portfolioCashSources).values([
    {
      id: TEST_VECTOR.targetSourceId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      name: 'Target Main',
      type: 'cash',
      isMain: true,
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingSourceId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      name: 'Sibling Main',
      type: 'cash',
      isMain: true,
      createdAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(transactions).values([
    {
      id: TEST_VECTOR.targetTransactionId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      assetId: TEST_VECTOR.assetId,
      side: 'buy',
      quantity: '1',
      price: '10',
      fee: '0',
      executedAt: TEST_VECTOR.buyAt,
    },
    {
      id: TEST_VECTOR.siblingTransactionId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      assetId: TEST_VECTOR.assetId,
      side: 'buy',
      quantity: '2',
      price: '20',
      fee: '0',
      executedAt: TEST_VECTOR.buyAt,
    },
  ]);
  await h.db.insert(dividends).values({
    id: TEST_VECTOR.targetDividendId,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    assetId: TEST_VECTOR.assetId,
    cashSourceId: TEST_VECTOR.targetSourceId,
    grossAmountEur: '5',
    executedAt: TEST_VECTOR.dividendAt,
    taxMode: 'none',
    createdAt: TEST_VECTOR.at,
  });
  await h.db.insert(portfolioCashMovements).values([
    {
      id: TEST_VECTOR.targetDepositId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      sourceId: TEST_VECTOR.targetSourceId,
      kind: 'deposit',
      amountEur: '100',
      executedAt: TEST_VECTOR.depositAt,
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.targetBuyMovementId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      sourceId: TEST_VECTOR.targetSourceId,
      kind: 'buy',
      amountEur: '-10',
      transactionId: TEST_VECTOR.targetTransactionId,
      executedAt: TEST_VECTOR.buyAt,
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.targetDividendMovementId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      sourceId: TEST_VECTOR.targetSourceId,
      kind: 'dividend',
      amountEur: '5',
      dividendId: TEST_VECTOR.targetDividendId,
      executedAt: TEST_VECTOR.dividendAt,
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingDepositId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      sourceId: TEST_VECTOR.siblingSourceId,
      kind: 'deposit',
      amountEur: '200',
      executedAt: TEST_VECTOR.depositAt,
      createdAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(portfolioSettings).values([
    {
      portfolioId: TEST_VECTOR.targetPortfolioId,
      key: 'TEST_VECTOR_TARGET',
      value: { enabled: true },
      updatedAt: TEST_VECTOR.at,
    },
    {
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      key: 'TEST_VECTOR_SIBLING',
      value: { untouched: true },
      updatedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(standingOrders).values([
    {
      id: TEST_VECTOR.targetOrderId,
      userId: user.id,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      kind: 'cash-add',
      amount: '10',
      currency: 'EUR',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingOrderId,
      userId: user.id,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      kind: 'cash-add',
      amount: '20',
      currency: 'EUR',
      cadence: 'daily',
      startDate: '2026-08-21',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(standingOrderRuns).values({
    id: TEST_VECTOR.targetOrderRunId,
    standingOrderId: TEST_VECTOR.targetOrderId,
    periodKey: '2026-08-21',
    bookedAt: TEST_VECTOR.at,
  });
  await h.db.insert(cashTags).values({
    id: TEST_VECTOR.cashTagId,
    userId: user.id,
    name: 'TEST VECTOR common cash tag',
    color: '#123456',
    createdAt: TEST_VECTOR.at,
    updatedAt: TEST_VECTOR.at,
  });
  await h.db.insert(cashMovementTags).values({
    id: TEST_VECTOR.targetMovementTagId,
    movementId: TEST_VECTOR.targetDepositId,
    tagId: TEST_VECTOR.cashTagId,
    createdAt: TEST_VECTOR.at,
  });
  await h.db.insert(cashBudgets).values([
    {
      id: TEST_VECTOR.targetBudgetId,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      tagId: TEST_VECTOR.cashTagId,
      amount: '50',
      currency: 'EUR',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingBudgetId,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      tagId: TEST_VECTOR.cashTagId,
      amount: '75',
      currency: 'EUR',
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(cashBudgetFires).values({
    id: TEST_VECTOR.targetBudgetFireId,
    budgetId: TEST_VECTOR.targetBudgetId,
    periodKey: '2026-08',
    firedAt: TEST_VECTOR.at,
  });
  await h.db.insert(importBatches).values([
    {
      id: TEST_VECTOR.targetBatchId,
      ownerId: user.id,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      brokerId: 'test-vector',
      filename: 'target.csv',
      status: 'applied',
      cashSourceId: TEST_VECTOR.targetSourceId,
      createdAt: TEST_VECTOR.at,
      appliedAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.siblingBatchId,
      ownerId: user.id,
      portfolioId: TEST_VECTOR.siblingPortfolioId,
      brokerId: 'test-vector',
      filename: 'sibling.csv',
      status: 'applied',
      cashSourceId: TEST_VECTOR.siblingSourceId,
      createdAt: TEST_VECTOR.at,
      appliedAt: TEST_VECTOR.at,
    },
  ]);
  await h.db.insert(importRows).values({
    id: TEST_VECTOR.targetImportRowId,
    batchId: TEST_VECTOR.targetBatchId,
    rowIndex: 1,
    raw: 'TEST VECTOR raw import row',
    flag: 'mapped',
  });
  await h.db.insert(portfolioDailySnapshots).values({
    portfolioId: TEST_VECTOR.targetPortfolioId,
    date: '2026-08-20',
    valueEur: '100',
    costBasisEur: '90',
    plEur: '10',
    flowEur: '0',
    cashBySource: { [TEST_VECTOR.targetSourceId]: '95' },
    assetValues: { [TEST_VECTOR.assetId]: '10' },
    computedAt: TEST_VECTOR.at,
  });
  await h.db.insert(portfolioSnapshotState).values({
    portfolioId: TEST_VECTOR.targetPortfolioId,
    computedThrough: '2026-08-20',
    updatedAt: TEST_VECTOR.at,
  });
  await h.db.insert(mirrorChains).values({
    id: TEST_VECTOR.mirrorChainId,
    name: 'TEST VECTOR ended mirrorchain',
    createdBy: user.id,
    createdByUsername: user.username,
  });
  await h.db.insert(mirrorChainMembers).values({
    id: TEST_VECTOR.mirrorMembershipId,
    chainId: TEST_VECTOR.mirrorChainId,
    userId: user.id,
    username: user.username,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    role: 'owner',
    status: 'left',
    endedAt: TEST_VECTOR.at,
  });
  await h.db.insert(mirrorRows).values({
    chainId: TEST_VECTOR.mirrorChainId,
    kind: 'transaction',
    mirrorId: TEST_VECTOR.mirrorId,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    localId: TEST_VECTOR.targetTransactionId,
    createdBy: user.id,
    createdByUsername: user.username,
  });
  await h.db.insert(shareAudiences).values({
    id: TEST_VECTOR.audienceId,
    ownerId: user.id,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
    audience: 'public_link',
  });
  await h.db.insert(shareAudienceMembers).values({
    audienceId: TEST_VECTOR.audienceId,
    friendId: viewer.id,
  });
  await h.db.insert(shareAudienceLinks).values({
    id: TEST_VECTOR.audienceLinkId,
    audienceId: TEST_VECTOR.audienceId,
    tokenHash: 'TEST VECTOR share token hash',
  });
  await h.db.insert(itemFollows).values({
    userId: viewer.id,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
  });
  await h.db.insert(sharedItemActivityPrefs).values({
    viewerId: viewer.id,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
  });
  await h.db.insert(itemComments).values({
    id: TEST_VECTOR.commentId,
    kind: 'portfolio',
    subjectId: TEST_VECTOR.targetPortfolioId,
    authorId: viewer.id,
    body: 'TEST VECTOR comment',
  });
  await h.db.insert(itemReactions).values({
    id: TEST_VECTOR.reactionId,
    userId: viewer.id,
    targetType: 'comment',
    commentId: TEST_VECTOR.commentId,
    emoji: '👍',
  });
}

interface StageOptions {
  includeHeader?: boolean;
  includeCommon?: boolean;
  includePortfolio?: boolean;
  portfolioVersion?: number;
  requestedVersion?: number;
  vaultVerified?: boolean;
  expiresAt?: Date;
}

async function attestCapture(
  portfolioDataRevision: string,
  options: StageOptions = {},
): Promise<PortfolioVaultMoveInRequest> {
  const portfolioVersion = options.portfolioVersion ?? DOC_VERSION;
  const requestedVersion = options.requestedVersion ?? DOC_VERSION;
  const vaultVerified = options.vaultVerified ?? true;
  await h.db
    .update(vaults)
    .set({ mediaAttestedAt: vaultVerified ? TEST_VECTOR.at : null })
    .where(eq(vaults.id, TEST_VECTOR.vaultId));
  await h.db
    .update(portfolioVaultTransitionStates)
    .set({
      captureVaultId: TEST_VECTOR.vaultId,
      captureMediaAttestedAt: TEST_VECTOR.at,
      captureExpiresAt: options.expiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
    })
    .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId));

  for (const [docId, docKind, version, included] of [
    [TEST_VECTOR.headerDocId, 'header', 3, options.includeHeader ?? true],
    [TEST_VECTOR.commonDocId, 'common', 4, options.includeCommon ?? true],
    [
      TEST_VECTOR.targetPortfolioId,
      'portfolio',
      portfolioVersion,
      options.includePortfolio ?? true,
    ],
  ] as const) {
    if (!included) continue;
    const blob = envelope(docId, docKind, version);
    await h.db.insert(vaultBlobs).values({
      vaultId: TEST_VECTOR.vaultId,
      docId,
      docKind,
      portfolioId: docKind === 'portfolio' ? TEST_VECTOR.targetPortfolioId : null,
      version,
      formatVersion: 2,
      sizeBytes: blob.length,
      blob,
      createdAt: TEST_VECTOR.at,
      updatedAt: TEST_VECTOR.at,
    });
  }

  return {
    vaultId: TEST_VECTOR.vaultId,
    docVersion: requestedVersion,
    portfolioDataRevision,
    stepUp: { password: user.password },
  };
}

async function stageMoveIn(
  service: PortfolioVaultTransitionService = h.ctx.portfolioVaultTransitions,
  options: StageOptions = {},
): Promise<PortfolioVaultMoveInRequest> {
  const { portfolioDataRevision } = await service.revision(user.id, TEST_VECTOR.targetPortfolioId);
  return attestCapture(portfolioDataRevision, options);
}

async function readTargetCleartextGraph() {
  return Promise.all([
    h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(transactions)
      .where(eq(transactions.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db.select().from(dividends).where(eq(dividends.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(portfolioCashSources)
      .where(eq(portfolioCashSources.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(portfolioSettings)
      .where(eq(portfolioSettings.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(standingOrders)
      .where(eq(standingOrders.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(standingOrderRuns)
      .where(eq(standingOrderRuns.standingOrderId, TEST_VECTOR.targetOrderId)),
    h.db
      .select()
      .from(cashBudgets)
      .where(eq(cashBudgets.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(cashBudgetFires)
      .where(eq(cashBudgetFires.budgetId, TEST_VECTOR.targetBudgetId)),
    h.db
      .select()
      .from(cashMovementTags)
      .where(eq(cashMovementTags.movementId, TEST_VECTOR.targetDepositId)),
    h.db
      .select()
      .from(importBatches)
      .where(eq(importBatches.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db.select().from(importRows).where(eq(importRows.batchId, TEST_VECTOR.targetBatchId)),
    h.db
      .select()
      .from(portfolioDailySnapshots)
      .where(eq(portfolioDailySnapshots.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(portfolioSnapshotState)
      .where(eq(portfolioSnapshotState.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db.select().from(mirrorRows).where(eq(mirrorRows.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(shareAudiences)
      .where(eq(shareAudiences.subjectId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(shareAudienceMembers)
      .where(eq(shareAudienceMembers.audienceId, TEST_VECTOR.audienceId)),
    h.db
      .select()
      .from(shareAudienceLinks)
      .where(eq(shareAudienceLinks.audienceId, TEST_VECTOR.audienceId)),
    h.db.select().from(itemFollows).where(eq(itemFollows.subjectId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(sharedItemActivityPrefs)
      .where(eq(sharedItemActivityPrefs.subjectId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(itemComments)
      .where(eq(itemComments.subjectId, TEST_VECTOR.targetPortfolioId)),
    h.db.select().from(itemReactions).where(eq(itemReactions.id, TEST_VECTOR.reactionId)),
  ]);
}

async function readSiblingGraph() {
  return Promise.all([
    h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(transactions)
      .where(eq(transactions.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(portfolioCashSources)
      .where(eq(portfolioCashSources.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(portfolioCashMovements)
      .where(eq(portfolioCashMovements.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(portfolioSettings)
      .where(eq(portfolioSettings.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(standingOrders)
      .where(eq(standingOrders.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(cashBudgets)
      .where(eq(cashBudgets.portfolioId, TEST_VECTOR.siblingPortfolioId)),
    h.db
      .select()
      .from(importBatches)
      .where(eq(importBatches.portfolioId, TEST_VECTOR.siblingPortfolioId)),
  ]);
}

async function readTransitionBoundary() {
  const [
    target,
    sibling,
    vault,
    state,
    activeDocs,
    history,
    candidates,
    keptAlerts,
    identities,
    assetRows,
  ] = await Promise.all([
    readTargetCleartextGraph(),
    readSiblingGraph(),
    h.db.select().from(vaults).where(eq(vaults.id, TEST_VECTOR.vaultId)),
    h.db
      .select()
      .from(portfolioVaultTransitionStates)
      .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
    h.db
      .select()
      .from(vaultBlobs)
      .where(eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId))
      .orderBy(vaultBlobs.docId),
    h.db
      .select()
      .from(vaultBlobHistory)
      .where(eq(vaultBlobHistory.vaultId, TEST_VECTOR.vaultId))
      .orderBy(vaultBlobHistory.docId, vaultBlobHistory.version),
    h.db
      .select()
      .from(vaultServerCandidates)
      .where(eq(vaultServerCandidates.vaultId, TEST_VECTOR.vaultId))
      .orderBy(vaultServerCandidates.docId),
    h.db.select().from(alerts).where(eq(alerts.userId, user.id)).orderBy(alerts.id),
    h.db.select().from(assetIdentities).where(eq(assetIdentities.id, TEST_VECTOR.assetId)),
    h.db.select().from(assets).orderBy(assets.id),
  ]);
  return {
    target,
    sibling,
    vault,
    state,
    activeDocs,
    history,
    candidates,
    keptAlerts,
    identities,
    assetRows,
  };
}

function restoreDocument(portfolioId = TEST_VECTOR.targetPortfolioId): VaultStrictDocumentV1 {
  const iso = (date: Date) => date.toISOString();
  return {
    schemaVersion: 1,
    entities: [
      strictEntity(portfolioId, 'portfolio', {
        userId: user.id,
        name: TARGET_NAME,
        visibility: 'friends',
        sortOrder: 1,
        defaultPayFromCash: true,
        archivedAt: null,
        kind: 'business',
        vaultId: null,
        alias: null,
        vaultAlias: null,
      }),
      strictEntity(TEST_VECTOR.targetSourceId, 'cashSource', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        name: 'Target Main',
        type: 'cash',
        isMain: true,
        archivedAt: null,
        createdAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetTransactionId, 'transaction', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        assetId: TEST_VECTOR.assetId,
        side: 'buy',
        quantity: '1.00000000',
        price: '10.000000',
        fee: '0.000000',
        executedAt: iso(TEST_VECTOR.buyAt),
        note: null,
        taxMode: null,
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        allowUncovered: false,
        uncoveredEntryPrice: null,
        source: 'manual',
      }),
      strictEntity(TEST_VECTOR.targetDividendId, 'dividend', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        assetId: TEST_VECTOR.assetId,
        cashSourceId: TEST_VECTOR.targetSourceId,
        grossAmountEur: '5.000000',
        executedAt: iso(TEST_VECTOR.dividendAt),
        note: null,
        taxMode: 'none',
        taxCountry: null,
        taxAmountEur: null,
        taxParams: null,
        source: 'manual',
        createdAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetDepositId, 'cashMovement', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        sourceId: TEST_VECTOR.targetSourceId,
        kind: 'deposit',
        amountEur: '100.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: iso(TEST_VECTOR.depositAt),
        note: null,
        source: 'manual',
        dedupHash: null,
        originalCurrency: null,
        createdAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetBuyMovementId, 'cashMovement', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        sourceId: TEST_VECTOR.targetSourceId,
        kind: 'buy',
        amountEur: '-10.000000',
        transactionId: TEST_VECTOR.targetTransactionId,
        transferId: null,
        counterpartSourceId: null,
        dividendId: null,
        taxYear: null,
        executedAt: iso(TEST_VECTOR.buyAt),
        note: null,
        source: 'manual',
        dedupHash: null,
        originalCurrency: null,
        createdAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetDividendMovementId, 'cashMovement', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        sourceId: TEST_VECTOR.targetSourceId,
        kind: 'dividend',
        amountEur: '5.000000',
        transactionId: null,
        transferId: null,
        counterpartSourceId: null,
        dividendId: TEST_VECTOR.targetDividendId,
        taxYear: null,
        executedAt: iso(TEST_VECTOR.dividendAt),
        note: null,
        source: 'manual',
        dedupHash: null,
        originalCurrency: null,
        createdAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetSettingEntityId, 'portfolioSetting', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        key: 'TEST_VECTOR_TARGET',
        value: { enabled: true },
        updatedAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetOrderId, 'standingOrder', {
        userId: user.id,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        kind: 'cash-add',
        assetId: null,
        amount: '10.000000',
        currency: 'EUR',
        label: null,
        cadence: 'daily',
        anchorDay: null,
        startDate: '2026-08-21',
        endDate: null,
        status: 'active',
        lastRunAt: null,
        lastPeriodKey: null,
        createdAt: iso(TEST_VECTOR.at),
        updatedAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetOrderRunId, 'standingOrderRun', {
        standingOrderId: TEST_VECTOR.targetOrderId,
        periodKey: '2026-08-21',
        bookedAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetBatchId, 'importBatch', {
        ownerId: user.id,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        brokerId: 'test-vector',
        filename: 'target.csv',
        status: 'applied',
        cashSourceId: TEST_VECTOR.targetSourceId,
        createdAt: iso(TEST_VECTOR.at),
        appliedAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetImportRowId, 'importRow', {
        batchId: TEST_VECTOR.targetBatchId,
        rowIndex: 1,
        raw: 'TEST VECTOR raw import row',
        kind: null,
        flag: 'mapped',
        message: null,
        executedAt: null,
        isin: null,
        symbol: null,
        name: null,
        quantity: null,
        price: null,
        fee: null,
        amountEur: null,
        currency: null,
        note: null,
        assetId: null,
        contentHash: null,
        result: null,
        resultMessage: null,
      }),
      strictEntity(TEST_VECTOR.cashTagId, 'cashTag', {
        userId: user.id,
        name: 'TEST VECTOR common cash tag',
        color: '#123456',
        system: false,
        systemKey: null,
        createdAt: iso(TEST_VECTOR.at),
        updatedAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetMovementTagId, 'cashMovementTag', {
        movementId: TEST_VECTOR.targetDepositId,
        tagId: TEST_VECTOR.cashTagId,
        createdAt: iso(TEST_VECTOR.at),
      }),
      strictEntity(TEST_VECTOR.targetBudgetId, 'cashBudget', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        tagId: TEST_VECTOR.cashTagId,
        periodKey: null,
        amount: '50.000000',
        currency: 'EUR',
        createdAt: iso(TEST_VECTOR.at),
        updatedAt: iso(TEST_VECTOR.at),
      }),
    ],
    mergeLog: [],
    mirrorProvenance: [],
  };
}

function minimalDocument(
  movement?: Extract<StrictEntity, { kind: 'cashMovement' }>,
): VaultStrictDocumentV1 {
  return {
    schemaVersion: 1,
    entities: [
      strictEntity(TEST_VECTOR.targetPortfolioId, 'portfolio', {
        userId: user.id,
        name: TARGET_NAME,
        visibility: 'private',
        sortOrder: 1,
        defaultPayFromCash: false,
        archivedAt: null,
        kind: null,
        vaultId: null,
        alias: null,
        vaultAlias: null,
      }),
      strictEntity(TEST_VECTOR.targetSourceId, 'cashSource', {
        portfolioId: TEST_VECTOR.targetPortfolioId,
        name: 'Target Main',
        type: 'cash',
        isMain: true,
        archivedAt: null,
        createdAt: TEST_VECTOR.at.toISOString(),
      }),
      ...(movement ? [movement] : []),
    ],
    mergeLog: [],
    mirrorProvenance: [],
  };
}

function moveOutRequest(
  document: VaultStrictDocumentV1,
  moveOutId = TEST_VECTOR.moveOutId,
  lifecycleGeneration = 1,
  documentSetHash = encryptedDocumentSetHash(),
  challengeOverride?: string,
): PortfolioVaultMoveOutRequest {
  const documentDigest = portfolioVaultRestoreDocumentDigest(document);
  const challenge =
    challengeOverride ??
    issuePortfolioVaultMoveOutChallenge({
      secret: h.ctx.config.sessionSecrets[0]!,
      userId: user.id,
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      lifecycleGeneration,
      documentDigest,
      documentSetHash,
      now: TEST_VECTOR.at,
      nonce: TEST_VECTOR_CHALLENGE_NONCE,
    }).challenge;
  return {
    vaultId: TEST_VECTOR.vaultId,
    moveOutId,
    lifecycleGeneration,
    documentSetHash,
    document,
    vaultProof: {
      challenge,
      signature: sign(
        null,
        Buffer.from(
          serializePortfolioVaultMoveOutProofTranscript({
            portfolioId: TEST_VECTOR.targetPortfolioId,
            vaultId: TEST_VECTOR.vaultId,
            lifecycleGeneration,
            documentDigest,
            documentSetHash,
            challenge,
          }),
        ),
        TEST_VECTOR_RETIREMENT_PRIVATE_KEY,
      ).toString('base64url'),
    },
    stepUp: { password: user.password },
  };
}

const allowReauth = {
  async verifyVaultDelete() {},
  async recordVaultDeleteFailure() {
    return false;
  },
  async verifyPortfolioVaultTransition() {},
  async recordPortfolioVaultTransitionFailure() {
    return false;
  },
} satisfies VaultDeleteReauth;

const noOpAudit = {
  async record() {},
  async recordInTransaction() {},
  async list() {
    throw new Error('TEST VECTOR audit list is not used');
  },
  async listForTarget() {
    throw new Error('TEST VECTOR audit target list is not used');
  },
} as unknown as AuditService;

function transitionService(
  overrides: Partial<PortfolioVaultTransitionServiceDeps> = {},
): PortfolioVaultTransitionService {
  return createPortfolioVaultTransitionService({
    db: h.db,
    reauth: allowReauth,
    audit: noOpAudit,
    history: { maxVersions: 5, maxAgeMs: 86_400_000 },
    toCashEur: async (amount, currency) => {
      if (currency !== 'EUR') throw new Error('TEST VECTOR only carries EUR');
      return amount;
    },
    runPostCommit: async () => undefined,
    runAfterMoveOutUnlock: async () => undefined,
    now: () => TEST_VECTOR.at,
    ...overrides,
    proofSecret: overrides.proofSecret ?? h.ctx.config.sessionSecrets[0]!,
  });
}

function serviceWithMoveInFailure(stageToFail: PortfolioVaultMoveInStage) {
  return createPortfolioVaultTransitionService({
    db: h.db,
    reauth: allowReauth,
    audit: noOpAudit,
    proofSecret: h.ctx.config.sessionSecrets[0]!,
    history: { maxVersions: 5, maxAgeMs: 86_400_000 },
    toCashEur: async (amount, currency) => {
      if (currency !== 'EUR') throw new Error('TEST VECTOR only carries EUR');
      return amount;
    },
    runPostCommit: async () => undefined,
    runAfterMoveOutUnlock: async () => undefined,
    now: () => TEST_VECTOR.at,
    afterMoveInStage(stage) {
      if (stage === stageToFail) throw new Error(`TEST VECTOR failure after ${stage}`);
    },
  });
}

function serviceWithMoveOutFailure(stageToFail: PortfolioVaultMoveOutStage) {
  return createPortfolioVaultTransitionService({
    db: h.db,
    reauth: allowReauth,
    audit: noOpAudit,
    proofSecret: h.ctx.config.sessionSecrets[0]!,
    history: { maxVersions: 5, maxAgeMs: 86_400_000 },
    toCashEur: async (amount, currency) => {
      if (currency !== 'EUR') throw new Error('TEST VECTOR only carries EUR');
      return amount;
    },
    runPostCommit: async () => undefined,
    runAfterMoveOutUnlock: async () => undefined,
    now: () => TEST_VECTOR.at,
    afterMoveOutStage(stage) {
      if (stage === stageToFail) throw new Error(`TEST VECTOR failure after ${stage}`);
    },
  });
}

function serviceWithBeforeMoveInCommit(
  beforeMoveInCommit: (
    userId: string,
    portfolioId: string,
    plan: { customAssetIds: readonly string[] },
  ) => void | Promise<void>,
) {
  return createPortfolioVaultTransitionService({
    db: h.db,
    reauth: allowReauth,
    audit: noOpAudit,
    proofSecret: h.ctx.config.sessionSecrets[0]!,
    history: { maxVersions: 5, maxAgeMs: 86_400_000 },
    toCashEur: async (amount, currency) => {
      if (currency !== 'EUR') throw new Error('TEST VECTOR only carries EUR');
      return amount;
    },
    runPostCommit: async () => undefined,
    runAfterMoveOutUnlock: async () => undefined,
    now: () => TEST_VECTOR.at,
    beforeMoveInCommit,
  });
}

async function moveTargetIn() {
  const request = await stageMoveIn();
  return h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request);
}

async function seedReadyExports(): Promise<void> {
  await h.db.insert(exportJobs).values([
    {
      id: TEST_VECTOR.ownerExportJobId,
      userId: user.id,
      status: 'ready',
      filePath: OWNER_EXPORT_PATH,
      fileSize: 4_096,
      downloadTokenHash: OWNER_EXPORT_TOKEN_HASH,
      readyAt: TEST_VECTOR.at,
      expiresAt: new Date('2099-08-21T10:00:00.000Z'),
      createdAt: TEST_VECTOR.at,
    },
    {
      id: TEST_VECTOR.foreignExportJobId,
      userId: viewer.id,
      status: 'ready',
      filePath: FOREIGN_EXPORT_PATH,
      fileSize: 8_192,
      downloadTokenHash: FOREIGN_EXPORT_TOKEN_HASH,
      readyAt: TEST_VECTOR.at,
      expiresAt: new Date('2099-08-21T10:00:00.000Z'),
      createdAt: TEST_VECTOR.at,
    },
  ]);
}

async function readReadyExports() {
  return h.db.select().from(exportJobs).orderBy(exportJobs.id);
}

async function seedExclusiveManualAsset(): Promise<void> {
  await h.db.insert(assets).values({
    id: TEST_VECTOR.exclusiveAssetId,
    ownerId: user.id,
    providerId: 'manual',
    providerRef: TEST_VECTOR.exclusiveAssetId,
    type: 'custom',
    symbol: 'E4ONLY',
    name: 'TEST VECTOR exclusive manual asset',
    currency: 'EUR',
  });
  await h.db.insert(transactions).values({
    id: TEST_VECTOR.exclusiveAssetTransactionId,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    assetId: TEST_VECTOR.exclusiveAssetId,
    side: 'buy',
    quantity: '1',
    price: '3',
    fee: '0',
    executedAt: TEST_VECTOR.buyAt,
  });
}

async function seedSecondExclusiveManualAsset(): Promise<void> {
  await h.db.insert(assets).values({
    id: TEST_VECTOR.secondExclusiveAssetId,
    ownerId: user.id,
    providerId: 'manual',
    providerRef: TEST_VECTOR.secondExclusiveAssetId,
    type: 'custom',
    symbol: 'E4SECOND',
    name: 'TEST VECTOR second exclusive manual asset',
    currency: 'EUR',
  });
  await h.db.insert(transactions).values({
    id: TEST_VECTOR.secondExclusiveAssetTransactionId,
    portfolioId: TEST_VECTOR.targetPortfolioId,
    assetId: TEST_VECTOR.secondExclusiveAssetId,
    side: 'buy',
    quantity: '1',
    price: '4',
    fee: '0',
    executedAt: TEST_VECTOR.buyAt,
  });
}

function strictCustomAsset(
  assetId: string,
  symbol: string,
  name: string,
  deletedAt: string | null = null,
): Extract<StrictEntity, { kind: 'customAsset' }> {
  return {
    ...strictEntity(assetId, 'customAsset', {
      providerId: 'manual',
      providerRef: assetId,
      ownerId: user.id,
      type: 'custom',
      symbol,
      name,
      exchange: null,
      currency: 'EUR',
      meta: null,
      searchText: null,
    }),
    deletedAt,
  };
}

function restoreDocumentWithCustomAssets(): VaultStrictDocumentV1 {
  const base = restoreDocument();
  const scoped = base.entities.map((entity): StrictEntity => {
    if (entity.kind === 'transaction' && entity.id === TEST_VECTOR.targetTransactionId) {
      return { ...entity, data: { ...entity.data, assetId: TEST_VECTOR.exclusiveAssetId } };
    }
    if (entity.kind === 'standingOrder' && entity.id === TEST_VECTOR.targetOrderId) {
      return {
        ...entity,
        data: {
          ...entity.data,
          kind: 'buy-asset',
          assetId: TEST_VECTOR.secondExclusiveAssetId,
          currency: 'EUR',
        },
      };
    }
    return entity;
  });
  return {
    ...base,
    entities: [
      ...scoped,
      // Reverse wire order proves the callback plan is canonicalized.
      strictCustomAsset(
        TEST_VECTOR.secondExclusiveAssetId,
        'E4SECOND',
        'TEST VECTOR second exclusive manual asset',
      ),
      strictCustomAsset(
        TEST_VECTOR.tombstonedAssetId,
        'E4OLD',
        'TEST VECTOR tombstoned manual asset',
        TEST_VECTOR.at.toISOString(),
      ),
      strictCustomAsset(
        TEST_VECTOR.exclusiveAssetId,
        'E4ONLY',
        'TEST VECTOR exclusive manual asset',
      ),
    ],
  };
}

async function expectTransitionDrivenRegistryState(vaulted: boolean): Promise<void> {
  expect(VAULTED_PORTFOLIO_FEATURE_REGISTRY).toHaveLength(7);

  for (const entry of VAULTED_PORTFOLIO_FEATURE_REGISTRY) {
    const targetAction = vi.fn(async () => Buffer.from(`TEST VECTOR ${entry.id}`));
    const siblingAction = vi.fn(async () => Buffer.from(`TEST VECTOR ${entry.id}`));

    if (entry.matrix.vaulted === 'skip') {
      const targetJobAction = vi.fn(async () => undefined);
      const siblingJobAction = vi.fn(async () => undefined);

      await expect(
        h.ctx.vaultedPortfolioGuard.runJobIfAllowed(TEST_VECTOR.targetPortfolioId, targetJobAction),
      ).resolves.toBe(!vaulted);
      expect(targetJobAction).toHaveBeenCalledTimes(vaulted ? 0 : 1);
      await expect(
        h.ctx.vaultedPortfolioGuard.runJobIfAllowed(
          TEST_VECTOR.siblingPortfolioId,
          siblingJobAction,
        ),
      ).resolves.toBe(true);
      expect(siblingJobAction).toHaveBeenCalledOnce();
      continue;
    }

    const targetBoundary = h.ctx.vaultedPortfolioGuard.runOwnedPortfolioAllowed(
      user.id,
      TEST_VECTOR.targetPortfolioId,
      targetAction,
    );
    if (vaulted) {
      await expect(targetBoundary).rejects.toMatchObject({
        statusCode: 403,
        code: VAULTED_PORTFOLIO_ERROR_CODE,
      });
      expect(targetAction).not.toHaveBeenCalled();
    } else {
      await expect(targetBoundary).resolves.toEqual(Buffer.from(`TEST VECTOR ${entry.id}`));
      expect(targetAction).toHaveBeenCalledOnce();
    }

    await expect(
      h.ctx.vaultedPortfolioGuard.runOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.siblingPortfolioId,
        siblingAction,
      ),
    ).resolves.toEqual(Buffer.from(`TEST VECTOR ${entry.id}`));
    expect(siblingAction).toHaveBeenCalledOnce();
  }
}

describe('portfolio vault move-in destructive commit', () => {
  it('changes the revision on every captured-row mutation and refuses the stale CAS as a 412 class without deletion', async () => {
    const first = await h.ctx.portfolioVaultTransitions.revision(
      user.id,
      TEST_VECTOR.targetPortfolioId,
    );
    await h.db
      .update(portfolioSettings)
      .set({ value: { enabled: true, captureMutation: 1 } })
      .where(eq(portfolioSettings.portfolioId, TEST_VECTOR.targetPortfolioId));
    const second = await h.ctx.portfolioVaultTransitions.revision(
      user.id,
      TEST_VECTOR.targetPortfolioId,
    );
    expect(second.portfolioDataRevision).not.toBe(first.portfolioDataRevision);

    const request = await attestCapture(second.portfolioDataRevision);
    await h.db
      .update(portfolioSettings)
      .set({ value: { enabled: true, captureMutation: 2 } })
      .where(eq(portfolioSettings.portfolioId, TEST_VECTOR.targetPortfolioId));
    const before = await readTargetCleartextGraph();

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).rejects.toMatchObject({ code: 'REVISION_STALE' });
    expect(PORTFOLIO_VAULT_TRANSITION_HTTP_ERRORS.REVISION_STALE.status).toBe(412);
    expect(await readTargetCleartextGraph()).toEqual(before);
  });

  it('excludes purge-only snapshot and fire-marker churn from the capture revision', async () => {
    const before = await h.ctx.portfolioVaultTransitions.revision(
      user.id,
      TEST_VECTOR.targetPortfolioId,
    );

    // These rows are destroyed and deterministically re-derived; no byte from
    // them is accepted into the encrypted restore document. Background churn
    // here must therefore not manufacture a destructive-capture conflict.
    await h.db
      .update(cashBudgetFires)
      .set({ firedAt: new Date('2026-08-21T10:01:00.000Z') })
      .where(eq(cashBudgetFires.id, TEST_VECTOR.targetBudgetFireId));
    await h.db
      .update(portfolioDailySnapshots)
      .set({
        valueEur: '101',
        computedAt: new Date('2026-08-21T10:01:00.000Z'),
      })
      .where(eq(portfolioDailySnapshots.portfolioId, TEST_VECTOR.targetPortfolioId));
    await h.db
      .update(portfolioSnapshotState)
      .set({
        dirtyFrom: '2026-08-20',
        updatedAt: new Date('2026-08-21T10:01:00.000Z'),
      })
      .where(eq(portfolioSnapshotState.portfolioId, TEST_VECTOR.targetPortfolioId));

    await expect(
      h.ctx.portfolioVaultTransitions.revision(user.id, TEST_VECTOR.targetPortfolioId),
    ).resolves.toEqual(before);
  });

  it('serializes an overlapping guarded mutation, then refuses the stale capture without purging', async () => {
    const request = await stageMoveIn();
    const mutationStarted = deferred();
    const releaseMutation = deferred();
    const guardedMutation = withLockedPrivacyModes(h.db, [user.id], async (modes) => {
      expect(modes.get(user.id)).toBe('normal');
      await h.db
        .update(portfolioSettings)
        .set({ value: { enabled: true, captureMutation: 'overlapping' } })
        .where(eq(portfolioSettings.portfolioId, TEST_VECTOR.targetPortfolioId));
      mutationStarted.resolve();
      await releaseMutation.promise;
    });
    await waitForStarted(mutationStarted, guardedMutation, 'captured-row mutation');
    const boundaryAfterMutation = await readTargetCleartextGraph();

    let transitionSettled = false;
    const transition = h.ctx.portfolioVaultTransitions.moveIn(
      user.id,
      TEST_VECTOR.targetPortfolioId,
      request,
    );
    void transition
      .finally(() => {
        transitionSettled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    expect(transitionSettled).toBe(false);

    releaseMutation.resolve();
    await guardedMutation;
    await expect(transition).rejects.toMatchObject({ code: 'REVISION_STALE' });
    expect(await readTargetCleartextGraph()).toEqual(boundaryAfterMutation);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).resolves.toBeUndefined();
  });

  it('commits zero cleartext, revokes shares, preserves the sibling and alert, flips only the target kill state, and replays safely', async () => {
    const siblingBefore = await readSiblingGraph();
    const alertBefore = await h.db.select().from(alerts).where(eq(alerts.id, TEST_VECTOR.alertId));
    const assetIdentityBefore = await h.db
      .select()
      .from(assetIdentities)
      .where(eq(assetIdentities.id, TEST_VECTOR.assetId));
    const request = await stageMoveIn();

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).resolves.toEqual({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      docVersion: DOC_VERSION,
      lifecycleGeneration: 1,
      idempotent: false,
    });

    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();
    expect(await readSiblingGraph()).toEqual(siblingBefore);
    expect(await h.db.select().from(alerts).where(eq(alerts.id, TEST_VECTOR.alertId))).toEqual(
      alertBefore,
    );
    expect(
      await h.db.select().from(assetIdentities).where(eq(assetIdentities.id, TEST_VECTOR.assetId)),
    ).toEqual(assetIdentityBefore);

    const [stub] = await h.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    expect(stub).toMatchObject({
      name: vaultedPortfolioStubName(TEST_VECTOR.targetPortfolioId),
      visibility: 'private',
      vaultId: TEST_VECTOR.vaultId,
      vaultAlias: 'TEST VECTOR vault alias',
    });
    expect(
      await h.db
        .select()
        .from(shareAudiences)
        .where(eq(shareAudiences.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(shareAudienceMembers)
        .where(eq(shareAudienceMembers.audienceId, TEST_VECTOR.audienceId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(shareAudienceLinks)
        .where(eq(shareAudienceLinks.audienceId, TEST_VECTOR.audienceId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(itemFollows)
        .where(eq(itemFollows.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(itemComments)
        .where(eq(itemComments.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
    expect(
      await h.db.select().from(itemReactions).where(eq(itemReactions.id, TEST_VECTOR.reactionId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(sharedItemActivityPrefs)
        .where(eq(sharedItemActivityPrefs.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);

    expect(
      await h.ctx.vaultedPortfolioGuard.isOwnedPortfolioVaulted(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).toBe(true);
    expect(
      await h.ctx.vaultedPortfolioGuard.isOwnedPortfolioVaulted(
        user.id,
        TEST_VECTOR.siblingPortfolioId,
      ),
    ).toBe(false);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).rejects.toMatchObject({ code: 'VAULTED_PORTFOLIO' });
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.siblingPortfolioId,
      ),
    ).resolves.toBeUndefined();

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).resolves.toEqual({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      docVersion: DOC_VERSION,
      lifecycleGeneration: 1,
      idempotent: true,
    });
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();
    expect(await readSiblingGraph()).toEqual(siblingBefore);
  });

  it('keeps the existing global catalog-asset alert evaluable and firing after move-in', async () => {
    await expect(moveTargetIn()).resolves.toMatchObject({ lifecycleGeneration: 1 });
    const marketData = createStubMarketData({
      quote(ref) {
        expect(ref).toEqual({
          providerId: 'test-vector-provider',
          providerRef: 'test-vector-asset',
        });
        const value: Quote = {
          price: 150,
          currency: 'EUR',
          dayChangePct: null,
          asOf: TEST_VECTOR.at.toISOString(),
        };
        return { value, stale: false, asOf: TEST_VECTOR.at.getTime() };
      },
    });

    await expect(
      runAlertsEvaluation({
        alertRepo: createAlertRepository(h.db),
        marketData,
        redis: h.ctx.redis,
        notify: h.ctx.notify,
        paranoid: h.ctx.paranoidGuard,
        logger: h.ctx.logger,
        now: () => TEST_VECTOR.at.getTime(),
      }),
    ).resolves.toEqual({ evaluated: 1, fired: 1 });
    expect(marketData.calls.quote).toBe(1);
    expect(
      await h.db
        .select({ status: alerts.status, lastTriggeredAt: alerts.lastTriggeredAt })
        .from(alerts)
        .where(eq(alerts.id, TEST_VECTOR.alertId)),
    ).toEqual([{ status: 'active', lastTriggeredAt: TEST_VECTOR.at }]);
    expect(
      await h.db
        .select({
          userId: notifications.userId,
          type: notifications.type,
          payload: notifications.payload,
          hidden: notifications.hidden,
        })
        .from(notifications)
        .where(eq(notifications.userId, user.id)),
    ).toEqual([
      {
        userId: user.id,
        type: 'alert.triggered',
        payload: expect.objectContaining({
          alertId: TEST_VECTOR.alertId,
          assetId: TEST_VECTOR.assetId,
          kind: 'price_above',
        }),
        hidden: false,
      },
    ]);
  });

  it.each([
    ['unverified media', 'MEDIA_NOT_VERIFIED'],
    ['active mirrorchain', 'ACTIVE_MIRRORCHAIN'],
    ['pending import', 'PENDING_IMPORT'],
    ['pending export', 'PENDING_EXPORT'],
    ['expired capture', 'CAPTURE_EXPIRED'],
    ['missing portfolio document', 'DOCUMENT_MISSING'],
    ['changed portfolio document version', 'DOCUMENT_VERSION_MISMATCH'],
    ['stale document roster', 'DOCUMENT_SET_STALE'],
  ] as const)('refuses %s and preserves every cleartext row', async (scenario, code) => {
    const { portfolioDataRevision } = await h.ctx.portfolioVaultTransitions.revision(
      user.id,
      TEST_VECTOR.targetPortfolioId,
    );
    if (scenario === 'active mirrorchain') {
      await h.db
        .update(mirrorChainMembers)
        .set({ status: 'active', endedAt: null })
        .where(eq(mirrorChainMembers.id, TEST_VECTOR.mirrorMembershipId));
    } else if (scenario === 'pending import') {
      await h.db
        .update(importBatches)
        .set({ status: 'pending', appliedAt: null })
        .where(eq(importBatches.id, TEST_VECTOR.targetBatchId));
    } else if (scenario === 'pending export') {
      await h.db.insert(exportJobs).values({
        id: TEST_VECTOR.exportJobId,
        userId: user.id,
        status: 'pending',
        createdAt: TEST_VECTOR.at,
      });
    }

    const request = await attestCapture(portfolioDataRevision, {
      vaultVerified: scenario !== 'unverified media',
      expiresAt:
        scenario === 'expired capture'
          ? new Date('2000-01-01T00:00:00.000Z')
          : new Date('2099-01-01T00:00:00.000Z'),
      includePortfolio: scenario !== 'missing portfolio document',
      portfolioVersion: scenario === 'changed portfolio document version' ? 6 : DOC_VERSION,
      includeCommon: scenario !== 'stale document roster',
    });
    const before = await readTargetCleartextGraph();

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).rejects.toMatchObject({ code });
    expect(await readTargetCleartextGraph()).toEqual(before);
    expect(
      await h.ctx.vaultedPortfolioGuard.isOwnedPortfolioVaulted(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).toBe(false);
  });

  it('rejects absent and wrong step-up credentials, audits the wrong password, and purges nothing', async () => {
    const request = await stageMoveIn();
    const before = await readTargetCleartextGraph();
    const absent = { ...request, stepUp: {} };
    expect(portfolioVaultMoveInRequestSchema.safeParse(absent).success).toBe(false);
    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        absent as PortfolioVaultMoveInRequest,
      ),
    ).rejects.toMatchObject({ code: 'TRANSITION_CONFLICT' });
    expect(await readTargetCleartextGraph()).toEqual(before);

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { password: 'TEST_VECTOR_wrong_password' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(await readTargetCleartextGraph()).toEqual(before);
    expect(
      await h.db
        .select({ action: auditLog.action, targetId: auditLog.targetId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'portfolio.vault_move_in_reauth_fail'),
            eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([
      {
        action: 'portfolio.vault_move_in_reauth_fail',
        targetId: TEST_VECTOR.targetPortfolioId,
      },
    ]);
  });

  it('refuses stale TOTP and a spent recovery code, preserves the rich graph, and throttles only move-in', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(user.id);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(user.id, generateTotpCode(secret)))
      .response;
    if (!recoveryCodes) throw new Error('TEST VECTOR TOTP enrollment returned no recovery codes');
    expect(await h.ctx.twoFactor.consumeRecoveryCode(user.id, recoveryCodes[0]!)).toBe(true);

    const request = await stageMoveIn();
    const before = await readTargetCleartextGraph();
    h.ctx.config.rateLimits.loginAccount.limit = 2;

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: {
          code: generateTotpCode(secret, Date.now() - TOTP_STEP_SECONDS * 10 * 1_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(await readTargetCleartextGraph()).toEqual(before);

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { recoveryCode: recoveryCodes[0] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(await readTargetCleartextGraph()).toEqual(before);

    const moveInKeys = progressiveKeys(PORTFOLIO_VAULT_MOVE_IN_NAMESPACE, user.id);
    expect(await h.ctx.redis.get(moveInKeys.count)).toBe('2');
    for (const namespace of [
      PORTFOLIO_VAULT_MOVE_OUT_NAMESPACE,
      ACCOUNT_VAULT_DELETE_NAMESPACE,
      LOGIN_ACCOUNT_NAMESPACE,
    ]) {
      const keys = progressiveKeys(namespace, user.id);
      expect(await h.ctx.redis.mget(keys.cooldown, keys.count, keys.level)).toEqual([
        null,
        null,
        null,
      ]);
    }

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { password: 'TEST_VECTOR_third_wrong_credential' },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    expect(await h.ctx.redis.ttl(moveInKeys.cooldown)).toBeGreaterThan(0);
    expect(await readTargetCleartextGraph()).toEqual(before);

    const failures = await h.db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'portfolio.vault_move_in_reauth_fail'),
          eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
        ),
      );
    expect(failures).toHaveLength(3);
    expect(failures).toEqual(
      expect.arrayContaining([
        { meta: expect.objectContaining({ factor: 'totp', locked: false, kind: 'move-in' }) },
        {
          meta: expect.objectContaining({
            factor: 'recovery_code',
            locked: false,
            kind: 'move-in',
          }),
        },
        { meta: expect.objectContaining({ factor: 'password', locked: true, kind: 'move-in' }) },
      ]),
    );
  });

  it('rolls back a consumed recovery code on a later CAS refusal and lets outcome replay bypass the spent code', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(user.id);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(user.id, generateTotpCode(secret)))
      .response;
    if (!recoveryCodes) throw new Error('TEST VECTOR TOTP enrollment returned no recovery codes');
    const recoveryCode = recoveryCodes[0]!;
    const request = await stageMoveIn();
    const before = await readTargetCleartextGraph();

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        portfolioDataRevision: 'TEST_VECTOR_stale_capture_revision',
        stepUp: { recoveryCode },
      }),
    ).rejects.toMatchObject({ code: 'REVISION_STALE' });
    expect(await readTargetCleartextGraph()).toEqual(before);

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { recoveryCode },
      }),
    ).resolves.toMatchObject({ idempotent: false });
    expect(await h.ctx.twoFactor.consumeRecoveryCode(user.id, recoveryCode)).toBe(false);

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { recoveryCode },
      }),
    ).resolves.toMatchObject({ idempotent: true });
    expect(
      await h.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'portfolio.vault_move_in_reauth_fail')),
    ).toEqual([]);
  });

  it('retires every ready owner export at commit while preserving the foreign export and sibling graph', async () => {
    await seedReadyExports();
    const exportsBefore = await readReadyExports();
    const siblingBefore = await readSiblingGraph();
    const retirement: string[] = [];
    const prepareExportFile = vi.fn(async (artifact: { id: string; filePath: string }) => {
      retirement.push(`prepare:${artifact.id}:${artifact.filePath}`);
      return {
        rollback: async () => void retirement.push(`rollback:${artifact.id}`),
        commit: async () => void retirement.push(`commit:${artifact.id}`),
      };
    });
    const service = transitionService({ prepareExportFile });
    const request = await stageMoveIn(service);

    await expect(
      service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).resolves.toMatchObject({ idempotent: false });

    expect(prepareExportFile).toHaveBeenCalledOnce();
    expect(retirement).toEqual([
      `prepare:${TEST_VECTOR.ownerExportJobId}:${OWNER_EXPORT_PATH}`,
      `commit:${TEST_VECTOR.ownerExportJobId}`,
    ]);
    const exportsAfter = await readReadyExports();
    expect(exportsAfter.find(({ id }) => id === TEST_VECTOR.ownerExportJobId)).toMatchObject({
      status: 'failed',
      filePath: null,
      fileSize: null,
      downloadTokenHash: null,
      expiresAt: null,
      readyAt: null,
      error: PARANOID_RETIRED_EXPORT_ERROR,
    });
    expect(exportsAfter.find(({ id }) => id === TEST_VECTOR.foreignExportJobId)).toEqual(
      exportsBefore.find(({ id }) => id === TEST_VECTOR.foreignExportJobId),
    );
    expect(await readSiblingGraph()).toEqual(siblingBefore);
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();
  });

  it('rolls a prepared owner export back on a later refusal with every DB pointer and graph unchanged', async () => {
    await seedReadyExports();
    const retirement: string[] = [];
    const service = transitionService({
      prepareExportFile: async (artifact) => {
        retirement.push(`prepare:${artifact.id}`);
        return {
          rollback: async () => void retirement.push(`rollback:${artifact.id}`),
          commit: async () => void retirement.push(`commit:${artifact.id}`),
        };
      },
      beforeMoveInCommit: async () => {
        throw new Error('TEST VECTOR refusal after export preparation');
      },
    });
    const request = await stageMoveIn(service);
    const boundaryBefore = await readTransitionBoundary();
    const exportsBefore = await readReadyExports();

    await expect(
      service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).rejects.toMatchObject({ code: 'TRANSITION_CONFLICT' });

    expect(retirement).toEqual([
      `prepare:${TEST_VECTOR.ownerExportJobId}`,
      `rollback:${TEST_VECTOR.ownerExportJobId}`,
    ]);
    expect(await readTransitionBoundary()).toEqual(boundaryBefore);
    expect(await readReadyExports()).toEqual(exportsBefore);
    expect(exportsBefore.find(({ id }) => id === TEST_VECTOR.ownerExportJobId)).toMatchObject({
      filePath: OWNER_EXPORT_PATH,
      downloadTokenHash: OWNER_EXPORT_TOKEN_HASH,
    });
    expect(exportsBefore.find(({ id }) => id === TEST_VECTOR.foreignExportJobId)).toMatchObject({
      filePath: FOREIGN_EXPORT_PATH,
      downloadTokenHash: FOREIGN_EXPORT_TOKEN_HASH,
    });
  });

  it('keeps an outcome-ambiguous export fail-closed, then retry clears its pointer and token without touching foreign or sibling state', async () => {
    await seedReadyExports();
    const retirement: string[] = [];
    const prepareExportFile = async (artifact: { id: string; filePath: string }) => {
      retirement.push(`prepare:${artifact.id}`);
      return {
        rollback: async () => void retirement.push(`rollback:${artifact.id}`),
        commit: async () => void retirement.push(`commit:${artifact.id}`),
      };
    };
    const failing = transitionService({
      prepareExportFile,
      withTransitionTransaction: async (db, transitionUserId, run) =>
        withPortfolioVaultTransitionTransaction(db, transitionUserId, async (tx) => {
          await run(tx);
          throw new Error('TEST VECTOR failure after the transaction body');
        }),
    });
    const request = await stageMoveIn(failing);
    const boundaryBefore = await readTransitionBoundary();
    const exportsBefore = await readReadyExports();
    const siblingBefore = await readSiblingGraph();

    await expect(failing.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request)).rejects.toThrow(
      'TEST VECTOR failure after the transaction body',
    );

    expect(retirement).toEqual([
      `prepare:${TEST_VECTOR.ownerExportJobId}`,
      `commit:${TEST_VECTOR.ownerExportJobId}`,
    ]);
    expect(await readTransitionBoundary()).toEqual(boundaryBefore);
    expect(await readReadyExports()).toEqual(exportsBefore);
    expect(await readSiblingGraph()).toEqual(siblingBefore);

    await expect(
      transitionService({ prepareExportFile }).moveIn(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        request,
      ),
    ).resolves.toMatchObject({ idempotent: false });

    expect(retirement).toEqual([
      `prepare:${TEST_VECTOR.ownerExportJobId}`,
      `commit:${TEST_VECTOR.ownerExportJobId}`,
      `prepare:${TEST_VECTOR.ownerExportJobId}`,
      `commit:${TEST_VECTOR.ownerExportJobId}`,
    ]);
    const exportsAfter = await readReadyExports();
    expect(exportsAfter.find(({ id }) => id === TEST_VECTOR.ownerExportJobId)).toMatchObject({
      status: 'failed',
      filePath: null,
      fileSize: null,
      downloadTokenHash: null,
      expiresAt: null,
      readyAt: null,
      error: PARANOID_RETIRED_EXPORT_ERROR,
    });
    expect(exportsAfter.find(({ id }) => id === TEST_VECTOR.foreignExportJobId)).toEqual(
      exportsBefore.find(({ id }) => id === TEST_VECTOR.foreignExportJobId),
    );
    expect(await readSiblingGraph()).toEqual(siblingBefore);
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();
  });

  it('refuses before the first delete when derived-state retirement fails and preserves target plus sibling', async () => {
    await seedExclusiveManualAsset();
    const beforeMoveInCommit = vi.fn(async () => {
      throw new Error('TEST VECTOR derived-state retirement failed');
    });
    const service = serviceWithBeforeMoveInCommit(beforeMoveInCommit);
    const request = await stageMoveIn(service);
    const before = await readTransitionBoundary();

    await expect(
      service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).rejects.toMatchObject({ code: 'TRANSITION_CONFLICT' });

    expect(beforeMoveInCommit).toHaveBeenCalledWith(user.id, TEST_VECTOR.targetPortfolioId, {
      customAssetIds: [TEST_VECTOR.exclusiveAssetId],
    });
    expect(await readTransitionBoundary()).toEqual(before);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).resolves.toBeUndefined();
  });

  it('hands the exact exclusive-manual-asset plan to derived-state retirement before purging', async () => {
    await seedExclusiveManualAsset();
    const beforeMoveInCommit = vi.fn(async () => undefined);
    const service = serviceWithBeforeMoveInCommit(beforeMoveInCommit);
    const request = await stageMoveIn(service);

    await expect(
      service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).resolves.toMatchObject({ idempotent: false });

    expect(beforeMoveInCommit).toHaveBeenCalledOnce();
    expect(beforeMoveInCommit).toHaveBeenCalledWith(user.id, TEST_VECTOR.targetPortfolioId, {
      customAssetIds: [TEST_VECTOR.exclusiveAssetId],
    });
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();
    expect(
      await h.db.select().from(assets).where(eq(assets.id, TEST_VECTOR.exclusiveAssetId)),
    ).toEqual([]);
  });

  it('TEST VECTOR: reopens a durable live generation after a post-purge database rollback', async () => {
    await seedExclusiveManualAsset();
    const rollback = vi.fn(async () =>
      releaseRetiredLiveAssets(h.ctx.redis, [TEST_VECTOR.exclusiveAssetId]),
    );
    const service = transitionService({
      beforeMoveInCommit: async (_userId, _portfolioId, plan) => {
        await fenceRetiredLiveAssets(h.ctx.redis, plan.customAssetIds);
        return { rollback };
      },
      afterMoveInStage(stage) {
        if (stage === 'purged') throw new Error('TEST VECTOR rollback after purge');
      },
    });
    const request = await stageMoveIn(service);
    // The capture window and verified encrypted document set are intentionally
    // durable before the destructive transaction starts. Only the commit-time
    // purge/receipt boundary must roll back on this injected failure.
    const boundaryBefore = await readTransitionBoundary();

    await expect(service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request)).rejects.toThrow(
      'TEST VECTOR rollback after purge',
    );

    expect(rollback).toHaveBeenCalledOnce();
    expect(
      await readLiveAssetRetirementGeneration(h.ctx.redis, TEST_VECTOR.exclusiveAssetId),
    ).toEqual({ epoch: 1, open: true });
    expect(await readTransitionBoundary()).toEqual(boundaryBefore);
  });

  it('TEST VECTOR: keeps the live generation closed after an outcome-ambiguous committed move-in', async () => {
    await seedExclusiveManualAsset();
    const service = transitionService({
      beforeMoveInCommit: async (callbackUserId, _callbackPortfolioId, plan) => {
        await fenceRetiredLiveAssets(h.ctx.redis, plan.customAssetIds);
        return {
          rollback: () =>
            reconcilePortfolioVaultLiveAssetRetirements({
              db: h.db,
              lockDb: h.db,
              redis: h.ctx.redis,
              userId: callbackUserId,
              assetIds: plan.customAssetIds,
            }),
        };
      },
      withTransitionTransaction: async (db, transitionUserId, run) => {
        await withPortfolioVaultTransitionTransaction(db, transitionUserId, run);
        throw new Error('TEST VECTOR ambiguous acknowledgement after COMMIT');
      },
    });
    const request = await stageMoveIn(service);

    await expect(service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request)).rejects.toThrow(
      'TEST VECTOR ambiguous acknowledgement after COMMIT',
    );

    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();
    expect(
      await readLiveAssetRetirementGeneration(h.ctx.redis, TEST_VECTOR.exclusiveAssetId),
    ).toEqual({ epoch: 1, open: false });
  });

  it('TEST VECTOR: a stale rollback reconciliation cannot reopen a later committed move-in', async () => {
    await seedExclusiveManualAsset();
    const commitReached = deferred();
    const allowCommit = deferred();
    const service = transitionService({
      beforeMoveInCommit: async (_userId, _portfolioId, plan) => {
        await fenceRetiredLiveAssets(h.ctx.redis, plan.customAssetIds);
        return {
          rollback: () =>
            reconcilePortfolioVaultLiveAssetRetirements({
              db: h.db,
              lockDb: h.db,
              redis: h.ctx.redis,
              userId: user.id,
              assetIds: plan.customAssetIds,
            }),
        };
      },
      async afterMoveInStage(stage) {
        if (stage !== 'receipt') return;
        commitReached.resolve();
        await allowCommit.promise;
      },
    });
    const request = await stageMoveIn(service);
    let moveIn: ReturnType<PortfolioVaultTransitionService['moveIn']> | undefined;
    let staleRollback: Promise<void> | undefined;

    try {
      moveIn = service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request);
      await waitForStarted(commitReached, moveIn, 'later move-in commit');
      expect(
        await readLiveAssetRetirementGeneration(h.ctx.redis, TEST_VECTOR.exclusiveAssetId),
      ).toEqual({ epoch: 1, open: false });

      staleRollback = reconcilePortfolioVaultLiveAssetRetirements({
        db: h.db,
        lockDb: h.db,
        redis: h.ctx.redis,
        userId: user.id,
        assetIds: [TEST_VECTOR.exclusiveAssetId],
      });
      let rollbackSettled = false;
      void staleRollback
        .finally(() => {
          rollbackSettled = true;
        })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rollbackSettled).toBe(false);

      allowCommit.resolve();
      await expect(moveIn).resolves.toMatchObject({ idempotent: false });
      await staleRollback;
    } finally {
      allowCommit.resolve();
      await Promise.allSettled([moveIn ?? Promise.resolve(), staleRollback ?? Promise.resolve()]);
    }

    expect(
      await readLiveAssetRetirementGeneration(h.ctx.redis, TEST_VECTOR.exclusiveAssetId),
    ).toEqual({ epoch: 1, open: false });
  });

  it.each(['verified', 'purged', 'receipt'] as const)(
    'rolls back a failure after the %s stage so the portfolio remains fully functional',
    async (stage) => {
      const service = serviceWithMoveInFailure(stage);
      const request = await stageMoveIn(service);
      const before = await readTransitionBoundary();

      await expect(service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request)).rejects.toThrow(
        `TEST VECTOR failure after ${stage}`,
      );

      expect(await readTransitionBoundary()).toEqual(before);
      await expect(
        h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
          user.id,
          TEST_VECTOR.targetPortfolioId,
        ),
      ).resolves.toBeUndefined();
    },
  );

  it('rolls the success audit back with a move-in failure after its receipt write', async () => {
    const service = transitionService({
      audit: createAuditService(createAuditRepository(h.db)),
      afterMoveInStage(stage) {
        if (stage === 'receipt') throw new Error('TEST VECTOR failure after audited move-in');
      },
    });
    const request = await stageMoveIn(service);
    const before = await readTransitionBoundary();

    await expect(service.moveIn(user.id, TEST_VECTOR.targetPortfolioId, request)).rejects.toThrow(
      'TEST VECTOR failure after audited move-in',
    );

    expect(await readTransitionBoundary()).toEqual(before);
    expect(
      await h.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actorId, user.id),
            eq(auditLog.action, AuditAction.PortfolioVaultMovedIn),
            eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([]);
  });

  it.skipIf(!REAL_DATABASE_URL)(
    'waits on a real guarded mutation lock, then observes its committed CAS change and refuses',
    async () => {
      if (!REAL_DATABASE_URL) throw new Error('Real Postgres is required for the row-lock test');
      const request = await stageMoveIn();
      const sharedClient = postgres(REAL_DATABASE_URL, { max: 1 });
      const observer = postgres(REAL_DATABASE_URL, { max: 1 });
      const sharedDb = drizzlePostgres(sharedClient, { schema });
      const releaseShared = deferred();
      const sharedStarted = deferred();
      let sharedHolder: Promise<unknown> | undefined;
      let transition: ReturnType<PortfolioVaultTransitionService['moveIn']> | undefined;
      let transitionSettled = false;
      let boundaryAfterMutation: Awaited<ReturnType<typeof readTargetCleartextGraph>> | undefined;

      try {
        await withProductionPrivacyLocks(async () => {
          const sharedPid = await backendPid(sharedClient);
          sharedHolder = withLockedPrivacyModes(sharedDb, [user.id], async (modes) => {
            expect(modes.get(user.id)).toBe('normal');
            sharedStarted.resolve();
            await releaseShared.promise;
          });
          await waitForStarted(sharedStarted, sharedHolder, 'normal guarded action');

          // This write commits while the normal action still holds KEY SHARE.
          // The destructive transition must queue on the owner row and only
          // compute its commit-time digest after this new captured fact exists.
          await h.db
            .update(portfolioSettings)
            .set({ value: { enabled: true, captureMutation: 'real-row-lock-overlap' } })
            .where(eq(portfolioSettings.portfolioId, TEST_VECTOR.targetPortfolioId));
          boundaryAfterMutation = await readTargetCleartextGraph();

          transition = h.ctx.portfolioVaultTransitions.moveIn(
            user.id,
            TEST_VECTOR.targetPortfolioId,
            request,
          );
          void transition
            .finally(() => {
              transitionSettled = true;
            })
            .catch(() => undefined);
          const lockWait = await waitForAccountUpdateLock(observer, sharedPid);
          expect(lockWait.waitEventType).toBe('Lock');
          expect(transitionSettled).toBe(false);

          releaseShared.resolve();
          await sharedHolder;
          await expect(transition).rejects.toMatchObject({ code: 'REVISION_STALE' });
        });
      } finally {
        releaseShared.resolve();
        await Promise.allSettled(
          [sharedHolder, transition].filter(
            (pending): pending is Promise<unknown> => pending !== undefined,
          ),
        );
        await Promise.all([sharedClient.end(), observer.end()]);
      }

      expect(boundaryAfterMutation).toBeDefined();
      expect(await readTargetCleartextGraph()).toEqual(boundaryAfterMutation);
      await expect(
        h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
          user.id,
          TEST_VECTOR.targetPortfolioId,
        ),
      ).resolves.toBeUndefined();
    },
    15_000,
  );
});

describe('portfolio vault transition-driven kill matrix', () => {
  it('flips all seven registry rows only at commit and preserves the sibling throughout rollback', async () => {
    const moveInFailure = serviceWithMoveInFailure('purged');
    const moveIn = await stageMoveIn(moveInFailure);

    await expect(
      moveInFailure.moveIn(user.id, TEST_VECTOR.targetPortfolioId, moveIn),
    ).rejects.toThrow('TEST VECTOR failure after purged');
    await expectTransitionDrivenRegistryState(false);

    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, moveIn),
    ).resolves.toMatchObject({ idempotent: false });
    await expectTransitionDrivenRegistryState(true);

    const document = restoreDocument();
    const moveOutFailure = serviceWithMoveOutFailure('receipt');
    await expect(
      moveOutFailure.moveOut(user.id, TEST_VECTOR.targetPortfolioId, moveOutRequest(document)),
    ).rejects.toThrow('TEST VECTOR failure after receipt');
    await expectTransitionDrivenRegistryState(true);

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        moveOutRequest(document),
      ),
    ).resolves.toMatchObject({ idempotent: false });
    await expectTransitionDrivenRegistryState(false);
  });
});

describe('portfolio vault move-out strict restore', () => {
  it('issues a short-lived challenge only for the locked current encrypted document set', async () => {
    await moveTargetIn();
    const document = minimalDocument();
    const documentDigest = portfolioVaultRestoreDocumentDigest(document);
    const documentSetHash = encryptedDocumentSetHash();
    const before = await readTransitionBoundary();

    const issued = await h.ctx.portfolioVaultTransitions.moveOutChallenge(
      user.id,
      TEST_VECTOR.targetPortfolioId,
      {
        vaultId: TEST_VECTOR.vaultId,
        lifecycleGeneration: 1,
        documentDigest,
        documentSetHash,
      },
    );
    expect(issued).toMatchObject({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      lifecycleGeneration: 1,
      documentDigest,
      documentSetHash,
      expiresAt: new Date(
        TEST_VECTOR.at.getTime() + PORTFOLIO_VAULT_MOVE_OUT_CHALLENGE_TTL_MS,
      ).toISOString(),
    });
    expect(
      verifyPortfolioVaultMoveOutChallenge({
        secret: h.ctx.config.sessionSecrets[0]!,
        challenge: issued.challenge,
        userId: user.id,
        portfolioId: TEST_VECTOR.targetPortfolioId,
        vaultId: TEST_VECTOR.vaultId,
        lifecycleGeneration: 1,
        documentDigest,
        documentSetHash,
        now: TEST_VECTOR.at,
      }),
    ).toBe(true);
    expect(await readTransitionBoundary()).toEqual(before);

    await expect(
      h.ctx.portfolioVaultTransitions.moveOutChallenge(user.id, TEST_VECTOR.targetPortfolioId, {
        vaultId: TEST_VECTOR.vaultId,
        lifecycleGeneration: 1,
        documentDigest,
        documentSetHash: 'A'.repeat(43),
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_SET_STALE' });
    expect(await readTransitionBoundary()).toEqual(before);
  });

  it('refuses every invalid or expired phrase proof before step-up and preserves the locked boundary', async () => {
    await moveTargetIn();
    const document = minimalDocument();
    const valid = moveOutRequest(document);
    const verifyStepUp = vi.fn(async () => undefined);
    const proofService = transitionService({
      reauth: { ...allowReauth, verifyPortfolioVaultTransition: verifyStepUp },
    });
    const expiredService = transitionService({
      reauth: { ...allowReauth, verifyPortfolioVaultTransition: verifyStepUp },
      now: () => new Date(TEST_VECTOR.at.getTime() + PORTFOLIO_VAULT_MOVE_OUT_CHALLENGE_TTL_MS),
    });
    const changedDocument: VaultStrictDocumentV1 = {
      ...document,
      entities: document.entities.map((entity) =>
        entity.kind === 'portfolio'
          ? { ...entity, data: { ...entity.data, name: 'TEST VECTOR stale unlocked graph' } }
          : entity,
      ),
    };
    // The final base64url character can contain unused padding bits. Mutating
    // it from A to B may therefore decode to the exact same Ed25519 signature.
    // The first character always carries significant bits, so this guarantees
    // a different canonical byte sequence while keeping the input well-formed.
    const mutateSignificantBase64urlCharacter = (value: string) =>
      `${value.startsWith('A') ? 'B' : 'A'}${value.slice(1)}`;
    const cases: readonly [
      string,
      PortfolioVaultMoveOutRequest,
      PortfolioVaultTransitionService,
    ][] = [
      [
        'signature',
        {
          ...valid,
          vaultProof: {
            ...valid.vaultProof,
            signature: mutateSignificantBase64urlCharacter(valid.vaultProof.signature),
          },
        },
        proofService,
      ],
      [
        'challenge',
        {
          ...valid,
          vaultProof: {
            ...valid.vaultProof,
            challenge: mutateSignificantBase64urlCharacter(valid.vaultProof.challenge),
          },
        },
        proofService,
      ],
      ['restore graph', { ...valid, document: changedDocument }, proofService],
      ['expiry', valid, expiredService],
    ];

    const before = await readTransitionBoundary();
    for (const [label, candidate, service] of cases) {
      await expect(
        service.moveOut(user.id, TEST_VECTOR.targetPortfolioId, candidate),
        label,
      ).rejects.toMatchObject({ code: 'POSSESSION_PROOF_INVALID' });
      expect(await readTransitionBoundary(), label).toEqual(before);
    }
    expect(verifyStepUp).not.toHaveBeenCalled();
  });

  it('CAS-refuses an older unlocked graph after the encrypted portfolio doc advances', async () => {
    await moveTargetIn();
    const document = minimalDocument();
    const staleRequest = moveOutRequest(document);
    const advancedVersion = DOC_VERSION + 1;
    const advanced = envelope(TEST_VECTOR.targetPortfolioId, 'portfolio', advancedVersion);
    await h.db
      .update(vaultBlobs)
      .set({
        version: advancedVersion,
        sizeBytes: advanced.length,
        blob: advanced,
        updatedAt: TEST_VECTOR.at,
      })
      .where(
        and(
          eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
          eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
        ),
      );
    await h.db
      .update(vaults)
      .set({ mediaAttestedAt: TEST_VECTOR.at })
      .where(eq(vaults.id, TEST_VECTOR.vaultId));
    const advancedBoundary = await readTransitionBoundary();

    await expect(
      h.ctx.portfolioVaultTransitions.moveOutChallenge(user.id, TEST_VECTOR.targetPortfolioId, {
        vaultId: TEST_VECTOR.vaultId,
        lifecycleGeneration: 1,
        documentDigest: portfolioVaultRestoreDocumentDigest(document),
        documentSetHash: staleRequest.documentSetHash,
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_SET_STALE' });
    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, staleRequest),
    ).rejects.toMatchObject({ code: 'DOCUMENT_SET_STALE' });
    expect(await readTransitionBoundary()).toEqual(advancedBoundary);
    expect(encryptedDocumentSetHash(advancedVersion)).not.toBe(staleRequest.documentSetHash);
  });

  it('replays the signed receipt after proof expiry and vault deletion without step-up or writes', async () => {
    await moveTargetIn();
    const document = minimalDocument();
    const request = moveOutRequest(document);
    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, request),
    ).resolves.toMatchObject({ idempotent: false });
    await h.db.delete(vaults).where(eq(vaults.id, TEST_VECTOR.vaultId));

    const verifyStepUp = vi.fn(async () => undefined);
    const replayService = transitionService({
      reauth: { ...allowReauth, verifyPortfolioVaultTransition: verifyStepUp },
      now: () => new Date(TEST_VECTOR.at.getTime() + PORTFOLIO_VAULT_MOVE_OUT_CHALLENGE_TTL_MS + 1),
    });
    const replay = { ...request, moveOutId: TEST_VECTOR.replayMoveOutId };
    await expect(
      replayService.moveOut(user.id, TEST_VECTOR.targetPortfolioId, replay),
    ).resolves.toEqual({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      moveOutId: TEST_VECTOR.moveOutId,
      lifecycleGeneration: 1,
      idempotent: true,
    });
    await expect(
      replayService.moveOutChallenge(user.id, TEST_VECTOR.targetPortfolioId, {
        vaultId: TEST_VECTOR.vaultId,
        lifecycleGeneration: 1,
        documentDigest: portfolioVaultRestoreDocumentDigest(document),
        documentSetHash: request.documentSetHash,
      }),
    ).resolves.toMatchObject({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      documentSetHash: request.documentSetHash,
    });
    expect(verifyStepUp).not.toHaveBeenCalled();
  });

  it('rejects absent and wrong move-out step-up credentials without writing the unlocked graph', async () => {
    await moveTargetIn();
    const request = moveOutRequest(minimalDocument());
    const boundary = async () =>
      Promise.all([
        h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
        h.db
          .select()
          .from(vaultBlobs)
          .where(
            and(
              eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
              eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
            ),
          ),
        h.db
          .select()
          .from(portfolioVaultTransitionStates)
          .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
      ]);
    const before = await boundary();
    const absent = { ...request, stepUp: {} };
    expect(portfolioVaultMoveOutRequestSchema.safeParse(absent).success).toBe(false);

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        absent as PortfolioVaultMoveOutRequest,
      ),
    ).rejects.toMatchObject({ code: 'RESTORE_INVALID' });
    expect(await boundary()).toEqual(before);

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { password: 'TEST_VECTOR_wrong_password' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(await boundary()).toEqual(before);
    expect(
      await h.db
        .select({ action: auditLog.action, targetId: auditLog.targetId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'portfolio.vault_move_out_reauth_fail'),
            eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([
      {
        action: 'portfolio.vault_move_out_reauth_fail',
        targetId: TEST_VECTOR.targetPortfolioId,
      },
    ]);
    expect(
      await h.db
        .select()
        .from(portfolioCashSources)
        .where(eq(portfolioCashSources.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
  });

  it('refuses stale TOTP and a spent recovery code, preserves the locked boundary, and throttles only move-out', async () => {
    await moveTargetIn();
    const { secret } = await h.ctx.twoFactor.enrollTotp(user.id);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(user.id, generateTotpCode(secret)))
      .response;
    if (!recoveryCodes) throw new Error('TEST VECTOR TOTP enrollment returned no recovery codes');
    expect(await h.ctx.twoFactor.consumeRecoveryCode(user.id, recoveryCodes[0]!)).toBe(true);

    const request = moveOutRequest(minimalDocument());
    const before = await readTransitionBoundary();
    h.ctx.config.rateLimits.loginAccount.limit = 2;

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: {
          code: generateTotpCode(secret, Date.now() - TOTP_STEP_SECONDS * 10 * 1_000),
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(await readTransitionBoundary()).toEqual(before);

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { recoveryCode: recoveryCodes[0] },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    expect(await readTransitionBoundary()).toEqual(before);

    const moveOutKeys = progressiveKeys(PORTFOLIO_VAULT_MOVE_OUT_NAMESPACE, user.id);
    expect(await h.ctx.redis.get(moveOutKeys.count)).toBe('2');
    for (const namespace of [
      PORTFOLIO_VAULT_MOVE_IN_NAMESPACE,
      ACCOUNT_VAULT_DELETE_NAMESPACE,
      LOGIN_ACCOUNT_NAMESPACE,
    ]) {
      const keys = progressiveKeys(namespace, user.id);
      expect(await h.ctx.redis.mget(keys.cooldown, keys.count, keys.level)).toEqual([
        null,
        null,
        null,
      ]);
    }

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...request,
        stepUp: { password: 'TEST_VECTOR_third_wrong_move_out_credential' },
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', statusCode: 429 });
    expect(await h.ctx.redis.ttl(moveOutKeys.cooldown)).toBeGreaterThan(0);
    expect(await readTransitionBoundary()).toEqual(before);

    const failures = await h.db
      .select({ meta: auditLog.meta })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'portfolio.vault_move_out_reauth_fail'),
          eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
        ),
      );
    expect(failures).toHaveLength(3);
    expect(failures).toEqual(
      expect.arrayContaining([
        { meta: expect.objectContaining({ factor: 'totp', locked: false, kind: 'move-out' }) },
        {
          meta: expect.objectContaining({
            factor: 'recovery_code',
            locked: false,
            kind: 'move-out',
          }),
        },
        { meta: expect.objectContaining({ factor: 'password', locked: true, kind: 'move-out' }) },
      ]),
    );
  });

  it('rolls back a consumed move-out recovery code on restore refusal, then reuses it and replays after consumption', async () => {
    await moveTargetIn();
    const { secret } = await h.ctx.twoFactor.enrollTotp(user.id);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(user.id, generateTotpCode(secret)))
      .response;
    if (!recoveryCodes) throw new Error('TEST VECTOR TOTP enrollment returned no recovery codes');
    const recoveryCode = recoveryCodes[0]!;
    const before = await readTransitionBoundary();

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...moveOutRequest(restoreDocument(TEST_VECTOR.foreignPortfolioId)),
        stepUp: { recoveryCode },
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_INVALID' });
    expect(await readTransitionBoundary()).toEqual(before);

    const successfulRequest = {
      ...moveOutRequest(minimalDocument()),
      stepUp: { recoveryCode },
    } satisfies PortfolioVaultMoveOutRequest;
    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        successfulRequest,
      ),
    ).resolves.toMatchObject({ moveOutId: TEST_VECTOR.moveOutId, idempotent: false });
    expect(await h.ctx.twoFactor.consumeRecoveryCode(user.id, recoveryCode)).toBe(false);

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...successfulRequest,
        moveOutId: TEST_VECTOR.replayMoveOutId,
      }),
    ).resolves.toMatchObject({ moveOutId: TEST_VECTOR.moveOutId, idempotent: true });
    expect(
      await h.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'portfolio.vault_move_out_reauth_fail')),
    ).toEqual([]);
  });

  it('accepts a fresh TOTP for move-out and unlocks the restored portfolio', async () => {
    await moveTargetIn();
    const { secret } = await h.ctx.twoFactor.enrollTotp(user.id);
    await h.ctx.twoFactor.confirmTotp(user.id, generateTotpCode(secret));

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, {
        ...moveOutRequest(minimalDocument()),
        stepUp: { code: generateTotpCode(secret) },
      }),
    ).resolves.toMatchObject({ moveOutId: TEST_VECTOR.moveOutId, idempotent: false });
    expect(
      await h.db
        .select({ vaultId: portfolios.vaultId })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null }]);
    expect(
      await h.db
        .select()
        .from(vaultBlobs)
        .where(
          and(
            eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([]);
  });

  it.each([
    ['stale media attestation', 'MEDIA_NOT_VERIFIED'],
    ['incomplete active document roster', 'DOCUMENT_SET_STALE'],
  ] as const)(
    'refuses %s before any restore write and keeps the locked boundary intact',
    async (scenario, code) => {
      await moveTargetIn();
      if (scenario === 'stale media attestation') {
        await h.db
          .update(vaults)
          .set({ mediaAttestedAt: null, mediaAttestedDriveConnectionId: null })
          .where(eq(vaults.id, TEST_VECTOR.vaultId));
      } else {
        await h.db
          .delete(vaultBlobs)
          .where(
            and(
              eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
              eq(vaultBlobs.docId, TEST_VECTOR.commonDocId),
            ),
          );
      }
      const before = await readTransitionBoundary();

      await expect(
        h.ctx.portfolioVaultTransitions.moveOut(
          user.id,
          TEST_VECTOR.targetPortfolioId,
          moveOutRequest(restoreDocument()),
        ),
      ).rejects.toMatchObject({ code });

      expect(await readTransitionBoundary()).toEqual(before);
      await expect(
        h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
          user.id,
          TEST_VECTOR.targetPortfolioId,
        ),
      ).rejects.toMatchObject({ code: 'VAULTED_PORTFOLIO' });
    },
  );

  it.each([
    'commonFacts',
    'portfolio',
    'portfolioDependencies',
    'ledger',
    'standingOrdersAndImports',
    'classification',
    'documentArchived',
    'receipt',
  ] as const)(
    'rolls back every restore, archive, membership, and receipt write after the %s stage',
    async (stage) => {
      await moveTargetIn();
      const service = serviceWithMoveOutFailure(stage);
      const before = await readTransitionBoundary();

      await expect(
        service.moveOut(user.id, TEST_VECTOR.targetPortfolioId, moveOutRequest(restoreDocument())),
      ).rejects.toThrow(`TEST VECTOR failure after ${stage}`);

      expect(await readTransitionBoundary()).toEqual(before);
      await expect(
        h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
          user.id,
          TEST_VECTOR.targetPortfolioId,
        ),
      ).rejects.toMatchObject({ code: 'VAULTED_PORTFOLIO' });
    },
  );

  it('rolls the success audit back with a move-out failure after its receipt write', async () => {
    await moveTargetIn();
    const service = transitionService({
      audit: createAuditService(createAuditRepository(h.db)),
      afterMoveOutStage(stage) {
        if (stage === 'receipt') throw new Error('TEST VECTOR failure after audited move-out');
      },
    });
    const before = await readTransitionBoundary();

    await expect(
      service.moveOut(user.id, TEST_VECTOR.targetPortfolioId, moveOutRequest(restoreDocument())),
    ).rejects.toThrow('TEST VECTOR failure after audited move-out');

    expect(await readTransitionBoundary()).toEqual(before);
    expect(
      await h.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actorId, user.id),
            eq(auditLog.action, AuditAction.PortfolioVaultMovedOut),
            eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([]);
  });

  it('replays one stable post-commit plan after an ambiguous callback failure without duplicating the restored graph', async () => {
    await seedExclusiveManualAsset();
    await seedSecondExclusiveManualAsset();
    await expect(moveTargetIn()).resolves.toMatchObject({ lifecycleGeneration: 1 });
    const document = restoreDocumentWithCustomAssets();
    const observedPlans: PortfolioVaultMoveOutPostCommitPlan[] = [];
    let postCommitAttempt = 0;
    const runPostCommit = vi.fn(
      async (
        callbackUserId: string,
        callbackPortfolioId: string,
        plan: PortfolioVaultMoveOutPostCommitPlan,
      ) => {
        observedPlans.push({ ...plan, customAssetIds: [...plan.customAssetIds] });
        const [restored, state, restoredAssets] = await Promise.all([
          h.db
            .select({ vaultId: portfolios.vaultId })
            .from(portfolios)
            .where(eq(portfolios.id, callbackPortfolioId)),
          h.db
            .select({
              moveOutId: portfolioVaultTransitionStates.moveOutId,
              completedAt: portfolioVaultTransitionStates.moveOutCompletedAt,
            })
            .from(portfolioVaultTransitionStates)
            .where(eq(portfolioVaultTransitionStates.portfolioId, callbackPortfolioId)),
          h.db
            .select({ id: assets.id })
            .from(assets)
            .where(inArray(assets.id, [...plan.customAssetIds]))
            .orderBy(assets.id),
        ]);
        expect(callbackUserId).toBe(user.id);
        expect(restored).toEqual([{ vaultId: null }]);
        expect(state).toEqual([{ moveOutId: TEST_VECTOR.moveOutId, completedAt: TEST_VECTOR.at }]);
        expect(restoredAssets).toEqual([
          { id: TEST_VECTOR.exclusiveAssetId },
          { id: TEST_VECTOR.secondExclusiveAssetId },
        ]);
        postCommitAttempt += 1;
        if (postCommitAttempt === 1) {
          throw new Error('TEST VECTOR first post-commit callback failed');
        }
      },
    );
    const service = transitionService({ runPostCommit });

    await expect(
      service.moveOut(user.id, TEST_VECTOR.targetPortfolioId, moveOutRequest(document)),
    ).rejects.toThrow('TEST VECTOR first post-commit callback failed');
    const pendingBytes = envelope(TEST_VECTOR.targetPortfolioId, 'portfolio', DOC_VERSION + 1);
    const pendingBlobs = createVaultBlobRepository(h.db);
    await expect(
      pendingBlobs.compareAndSwap({
        userId: user.id,
        vaultId: TEST_VECTOR.vaultId,
        docId: TEST_VECTOR.targetPortfolioId,
        header: readVaultDocServerHeader(pendingBytes),
        expectedVersion: null,
        blob: pendingBytes,
        retention: { maxVersions: 5, maxAgeMs: 86_400_000 },
        now: TEST_VECTOR.at,
      }),
    ).resolves.toEqual({ status: 'portfolio_binding_mismatch' });
    await expect(
      pendingBlobs.readCurrent(user.id, TEST_VECTOR.vaultId, TEST_VECTOR.targetPortfolioId),
    ).resolves.toEqual({ status: 'not_found' });
    await expect(
      pendingBlobs.readCurrent(user.id, TEST_VECTOR.vaultId, TEST_VECTOR.headerDocId),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(
      await h.db
        .select({
          vaultId: portfolios.vaultId,
          pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
        })
        .from(portfolios)
        .innerJoin(
          portfolioVaultTransitionStates,
          eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
        )
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null, pending: true }]);

    await expect(
      service.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        moveOutRequest(document, TEST_VECTOR.replayMoveOutId),
      ),
    ).resolves.toEqual({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      moveOutId: TEST_VECTOR.moveOutId,
      lifecycleGeneration: 1,
      idempotent: true,
    });

    const expectedPlan = {
      customAssetIds: [TEST_VECTOR.exclusiveAssetId, TEST_VECTOR.secondExclusiveAssetId],
      completedAt: TEST_VECTOR.at.toISOString(),
    } satisfies PortfolioVaultMoveOutPostCommitPlan;
    expect(observedPlans).toEqual([expectedPlan, expectedPlan]);
    expect(runPostCommit.mock.calls).toEqual([
      [user.id, TEST_VECTOR.targetPortfolioId, expectedPlan],
      [user.id, TEST_VECTOR.targetPortfolioId, expectedPlan],
    ]);
    expect(
      await h.db
        .select({
          vaultId: portfolios.vaultId,
          pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
        })
        .from(portfolios)
        .innerJoin(
          portfolioVaultTransitionStates,
          eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
        )
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null, pending: false }]);
    expect(
      await h.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          inArray(assets.id, [
            TEST_VECTOR.exclusiveAssetId,
            TEST_VECTOR.secondExclusiveAssetId,
            TEST_VECTOR.tombstonedAssetId,
          ]),
        )
        .orderBy(assets.id),
    ).toEqual([{ id: TEST_VECTOR.exclusiveAssetId }, { id: TEST_VECTOR.secondExclusiveAssetId }]);
    expect(
      await h.db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ id: TEST_VECTOR.targetTransactionId }]);
  });

  it('lets a fresh durable finalizer recover a pending move-out without another client request', async () => {
    await expect(moveTargetIn()).resolves.toMatchObject({ lifecycleGeneration: 1 });
    const document = restoreDocument();
    const failedRunPostCommit = vi.fn(async () => {
      throw new Error('TEST VECTOR initiating process stopped during post-commit work');
    });
    const initiatingRunAfterUnlock = vi.fn(async () => undefined);
    const initiatingService = transitionService({
      runPostCommit: failedRunPostCommit,
      runAfterMoveOutUnlock: initiatingRunAfterUnlock,
    });

    await expect(
      initiatingService.moveOut(user.id, TEST_VECTOR.targetPortfolioId, moveOutRequest(document)),
    ).rejects.toThrow('TEST VECTOR initiating process stopped during post-commit work');
    expect(failedRunPostCommit).toHaveBeenCalledTimes(1);
    expect(initiatingRunAfterUnlock).not.toHaveBeenCalled();
    expect(
      await h.db
        .select({
          vaultId: portfolios.vaultId,
          pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
        })
        .from(portfolios)
        .innerJoin(
          portfolioVaultTransitionStates,
          eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
        )
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null, pending: true }]);
    const committedRestoreGraph = await readTargetCleartextGraph();

    const recoveredRunPostCommit = vi.fn(async () => undefined);
    const recoveredRunAfterUnlock = vi.fn(async () => undefined);
    const freshFinalizer = createPortfolioVaultMoveOutFinalizer({
      db: h.db,
      runPostCommit: recoveredRunPostCommit,
      runAfterMoveOutUnlock: recoveredRunAfterUnlock,
    });

    await expect(freshFinalizer.finalizePending(1)).resolves.toEqual({
      processed: 1,
      failures: [],
    });
    await expect(freshFinalizer.finalizePending(1)).resolves.toEqual({
      processed: 0,
      failures: [],
    });
    const expectedPlan = {
      customAssetIds: [],
      completedAt: TEST_VECTOR.at.toISOString(),
    } satisfies PortfolioVaultMoveOutPostCommitPlan;
    expect(recoveredRunPostCommit.mock.calls).toEqual([
      [user.id, TEST_VECTOR.targetPortfolioId, expectedPlan],
    ]);
    expect(recoveredRunAfterUnlock.mock.calls).toEqual([
      [user.id, TEST_VECTOR.targetPortfolioId, expectedPlan],
    ]);
    expect(
      await h.db
        .select({
          vaultId: portfolios.vaultId,
          pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
        })
        .from(portfolios)
        .innerJoin(
          portfolioVaultTransitionStates,
          eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
        )
        .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ vaultId: null, pending: false }]);

    const finalizedRestoreGraph = await readTargetCleartextGraph();
    const [committedPortfolioRows, ...committedRestoreRows] = committedRestoreGraph;
    const [finalizedPortfolioRows, ...finalizedRestoreRows] = finalizedRestoreGraph;
    expect(committedPortfolioRows).toEqual([
      expect.objectContaining({
        id: TEST_VECTOR.targetPortfolioId,
        vaultId: null,
      }),
    ]);
    expect(finalizedPortfolioRows).toEqual(committedPortfolioRows);
    expect(finalizedRestoreRows).toEqual(committedRestoreRows);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      h.ctx.paranoidGuard.assertAllowed(user.id, 'portfolioServer'),
    ).resolves.toBeUndefined();
  });

  it('un-kills at the atomic restore commit while every derived finalization phase remains retryable', async () => {
    await expect(moveTargetIn()).resolves.toMatchObject({ lifecycleGeneration: 1 });
    const document = restoreDocument();
    const finalizationOrder: string[] = [];
    const runPostCommit = vi.fn(async () => {
      finalizationOrder.push('derived');
    });
    let afterDerivedAttempt = 0;
    const runAfterMoveOutUnlock = vi.fn(async (_userId: string, callbackPortfolioId: string) => {
      finalizationOrder.push('after-derived');
      expect(
        await h.db
          .select({
            vaultId: portfolios.vaultId,
            pending: portfolioVaultTransitionStates.moveOutPostCommitPending,
          })
          .from(portfolios)
          .innerJoin(
            portfolioVaultTransitionStates,
            eq(portfolioVaultTransitionStates.portfolioId, portfolios.id),
          )
          .where(eq(portfolios.id, callbackPortfolioId)),
      ).toEqual([{ vaultId: null, pending: true }]);
      await expect(
        h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(user.id, callbackPortfolioId),
      ).resolves.toBeUndefined();
      afterDerivedAttempt += 1;
      if (afterDerivedAttempt === 1) {
        throw new Error('TEST VECTOR first after-derived callback failed');
      }
    });
    const service = transitionService({ runPostCommit, runAfterMoveOutUnlock });
    const readPlainSibling = vi.fn(() =>
      h.db
        .select({ id: portfolios.id, name: portfolios.name })
        .from(portfolios)
        .where(eq(portfolios.id, TEST_VECTOR.siblingPortfolioId)),
    );

    await expect(
      service.moveOut(user.id, TEST_VECTOR.targetPortfolioId, moveOutRequest(document)),
    ).rejects.toThrow('TEST VECTOR first after-derived callback failed');
    expect(runPostCommit).toHaveBeenCalledTimes(1);
    expect(runAfterMoveOutUnlock).toHaveBeenCalledTimes(1);
    expect(finalizationOrder).toEqual(['derived', 'after-derived']);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      h.ctx.paranoidGuard.runAllowed(user.id, 'portfolioServer', readPlainSibling),
    ).resolves.toEqual([{ id: TEST_VECTOR.siblingPortfolioId, name: SIBLING_NAME }]);
    expect(readPlainSibling).toHaveBeenCalledTimes(1);
    await expectTransitionDrivenRegistryState(false);
    await expect(service.revision(user.id, TEST_VECTOR.targetPortfolioId)).rejects.toMatchObject({
      code: 'TRANSITION_CONFLICT',
    });

    await expect(
      service.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        moveOutRequest(document, TEST_VECTOR.replayMoveOutId),
      ),
    ).resolves.toMatchObject({ moveOutId: TEST_VECTOR.moveOutId, idempotent: true });
    expect(runPostCommit).toHaveBeenCalledTimes(2);
    expect(runAfterMoveOutUnlock).toHaveBeenCalledTimes(2);
    expect(finalizationOrder).toEqual(['derived', 'after-derived', 'derived', 'after-derived']);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).resolves.toBeUndefined();
    await expect(
      h.ctx.paranoidGuard.runAllowed(user.id, 'portfolioServer', readPlainSibling),
    ).resolves.toEqual([{ id: TEST_VECTOR.siblingPortfolioId, name: SIBLING_NAME }]);
    expect(readPlainSibling).toHaveBeenCalledTimes(2);
  });

  it('restores under the same UUID, atomically clears membership, finalizes, and replays without duplicates', async () => {
    await moveTargetIn();
    const document = restoreDocument();

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        moveOutRequest(document),
      ),
    ).resolves.toEqual({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      moveOutId: TEST_VECTOR.moveOutId,
      lifecycleGeneration: 1,
      idempotent: false,
    });

    const [restored] = await h.db
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId));
    expect(restored).toMatchObject({
      id: TEST_VECTOR.targetPortfolioId,
      userId: user.id,
      name: TARGET_NAME,
      vaultId: null,
      vaultAlias: null,
    });
    expect(
      await h.db
        .select({ id: transactions.id, assetId: transactions.assetId })
        .from(transactions)
        .where(eq(transactions.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ id: TEST_VECTOR.targetTransactionId, assetId: TEST_VECTOR.assetId }]);
    expect(
      await h.db
        .select({ id: assetIdentities.id })
        .from(assetIdentities)
        .where(eq(assetIdentities.id, TEST_VECTOR.assetId)),
    ).toEqual([{ id: TEST_VECTOR.assetId }]);
    expect(
      await h.db
        .select()
        .from(shareAudiences)
        .where(eq(shareAudiences.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(itemFollows)
        .where(eq(itemFollows.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
    expect(
      await h.db
        .select()
        .from(vaultBlobs)
        .where(
          and(
            eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([]);
    expect(
      await h.db
        .select({ version: vaultBlobHistory.version })
        .from(vaultBlobHistory)
        .where(
          and(
            eq(vaultBlobHistory.vaultId, TEST_VECTOR.vaultId),
            eq(vaultBlobHistory.docId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toEqual([{ version: DOC_VERSION }]);
    expect(
      await h.ctx.vaultedPortfolioGuard.isOwnedPortfolioVaulted(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).toBe(false);
    await expect(
      h.ctx.vaultedPortfolioGuard.assertOwnedPortfolioAllowed(
        user.id,
        TEST_VECTOR.targetPortfolioId,
      ),
    ).resolves.toBeUndefined();
    expect(
      await h.db
        .select()
        .from(portfolioSnapshotState)
        .where(eq(portfolioSnapshotState.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toHaveLength(1);

    await expect(
      h.ctx.portfolioVaultTransitions.revision(user.id, TEST_VECTOR.targetPortfolioId),
    ).resolves.toEqual({ portfolioDataRevision: expect.any(String) });

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        moveOutRequest(document, TEST_VECTOR.replayMoveOutId),
      ),
    ).resolves.toEqual({
      portfolioId: TEST_VECTOR.targetPortfolioId,
      vaultId: TEST_VECTOR.vaultId,
      moveOutId: TEST_VECTOR.moveOutId,
      lifecycleGeneration: 1,
      idempotent: true,
    });
    expect(
      await h.db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.actorId, user.id),
            eq(auditLog.action, 'portfolio.vault_moved_out'),
            eq(auditLog.targetId, TEST_VECTOR.targetPortfolioId),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await h.db
        .select({ id: portfolioCashSources.id })
        .from(portfolioCashSources)
        .where(eq(portfolioCashSources.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([{ id: TEST_VECTOR.targetSourceId }]);
    expect(
      await h.db
        .select({ id: portfolioCashMovements.id })
        .from(portfolioCashMovements)
        .where(eq(portfolioCashMovements.portfolioId, TEST_VECTOR.targetPortfolioId)),
    ).toHaveLength(3);
    expect(
      await h.db
        .select()
        .from(shareAudiences)
        .where(eq(shareAudiences.subjectId, TEST_VECTOR.targetPortfolioId)),
    ).toEqual([]);
  });

  it('rejects a delayed move-out from an earlier stay in the same vault without touching the newer lifecycle', async () => {
    await expect(moveTargetIn()).resolves.toMatchObject({ lifecycleGeneration: 1 });
    const document = restoreDocument();
    const staleRequest = moveOutRequest(document, TEST_VECTOR.moveOutId, 1);
    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, staleRequest),
    ).resolves.toMatchObject({ lifecycleGeneration: 1, idempotent: false });

    // Recreate the verified doc roster for a second stay. The old portfolio
    // version remains in bounded history; identical bytes are legal for the
    // same client-owned version and make generation the only lifecycle signal.
    await h.db.delete(vaultBlobs).where(eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId));
    const secondMoveIn = await stageMoveIn();
    await expect(
      h.ctx.portfolioVaultTransitions.moveIn(user.id, TEST_VECTOR.targetPortfolioId, secondMoveIn),
    ).resolves.toMatchObject({ lifecycleGeneration: 2, idempotent: false });
    const newerLifecycle = await readTransitionBoundary();

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(user.id, TEST_VECTOR.targetPortfolioId, staleRequest),
    ).rejects.toMatchObject({ code: 'TRANSITION_CONFLICT' });
    expect(await readTransitionBoundary()).toEqual(newerLifecycle);
    await expect(
      assertVaultedPortfolioHasNoCleartext(h.db, TEST_VECTOR.targetPortfolioId),
    ).resolves.toBeUndefined();

    await expect(
      h.ctx.portfolioVaultTransitions.moveOut(
        user.id,
        TEST_VECTOR.targetPortfolioId,
        moveOutRequest(document, TEST_VECTOR.replayMoveOutId, 2),
      ),
    ).resolves.toMatchObject({ lifecycleGeneration: 2, idempotent: false });
  });

  it.each(['invalid scope', 'insolvent ledger', 'forged provenance'] as const)(
    'refuses a %s before any restore write',
    async (scenario) => {
      await moveTargetIn();
      let document: VaultStrictDocumentV1;
      if (scenario === 'invalid scope') {
        document = restoreDocument(TEST_VECTOR.foreignPortfolioId);
      } else if (scenario === 'insolvent ledger') {
        const withdrawal = strictEntity(TEST_VECTOR.targetDepositId, 'cashMovement', {
          portfolioId: TEST_VECTOR.targetPortfolioId,
          sourceId: TEST_VECTOR.targetSourceId,
          kind: 'withdrawal',
          amountEur: '-1.000000',
          transactionId: null,
          transferId: null,
          counterpartSourceId: null,
          dividendId: null,
          taxYear: null,
          executedAt: TEST_VECTOR.depositAt.toISOString(),
          note: null,
          source: 'manual',
          dedupHash: null,
          originalCurrency: null,
          createdAt: TEST_VECTOR.at.toISOString(),
        });
        document = minimalDocument(withdrawal);
      } else {
        const provenance: VaultMirrorProvenance = {
          chainId: TEST_VECTOR.provenanceChainId,
          membershipId: TEST_VECTOR.provenanceMembershipId,
          kind: 'transaction',
          mirrorId: TEST_VECTOR.provenanceMirrorId,
          portfolioId: TEST_VECTOR.targetPortfolioId,
          localId: TEST_VECTOR.provenanceLocalId,
        };
        document = minimalDocument();
        document.mirrorProvenance = [provenance];
      }
      const before = await Promise.all([
        h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
        h.db
          .select()
          .from(vaultBlobs)
          .where(
            and(
              eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
              eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
            ),
          ),
        h.db
          .select()
          .from(portfolioVaultTransitionStates)
          .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
      ]);

      await expect(
        h.ctx.portfolioVaultTransitions.moveOut(
          user.id,
          TEST_VECTOR.targetPortfolioId,
          moveOutRequest(document),
        ),
      ).rejects.toMatchObject({
        code:
          scenario === 'invalid scope'
            ? 'RESTORE_INVALID'
            : scenario === 'insolvent ledger'
              ? 'RESTORE_SOLVENCY'
              : 'RESTORE_PROVENANCE',
      });

      expect(
        await Promise.all([
          h.db.select().from(portfolios).where(eq(portfolios.id, TEST_VECTOR.targetPortfolioId)),
          h.db
            .select()
            .from(vaultBlobs)
            .where(
              and(
                eq(vaultBlobs.vaultId, TEST_VECTOR.vaultId),
                eq(vaultBlobs.docId, TEST_VECTOR.targetPortfolioId),
              ),
            ),
          h.db
            .select()
            .from(portfolioVaultTransitionStates)
            .where(eq(portfolioVaultTransitionStates.portfolioId, TEST_VECTOR.targetPortfolioId)),
        ]),
      ).toEqual(before);
      expect(
        await h.db
          .select()
          .from(portfolioCashSources)
          .where(eq(portfolioCashSources.portfolioId, TEST_VECTOR.targetPortfolioId)),
      ).toEqual([]);
      expect(
        await h.db
          .select()
          .from(vaultBlobHistory)
          .where(eq(vaultBlobHistory.docId, TEST_VECTOR.targetPortfolioId)),
      ).toEqual([]);
    },
  );
});
