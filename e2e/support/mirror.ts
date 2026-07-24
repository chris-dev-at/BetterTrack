import { expect, type APIResponse, type Page } from '@playwright/test';

import { API_BASE_URL } from './config';
import type { E2EUser } from './users';

/**
 * MIRRORCHAIN e2e helpers (V5-P7 M6, `docs/mirrorchain-design.md` §§2–11). The
 * six done-when scenarios in `mirrorchain.spec.ts` drive the chain lifecycle and
 * replication through the REAL HTTP surface — the same endpoints the SPA calls —
 * using each user's browser cookie jar (`page.request` shares the session +
 * CSRF context). Replication is job-driven (BullMQ), so every cross-copy
 * assertion polls on sync/ledger state rather than sleeping (design §2). The
 * genuinely user-facing checks (the attribution chip, the fork provenance line)
 * are asserted against the rendered UI in the specs themselves.
 */

const V1 = `${API_BASE_URL}/api/v1`;
/** Every mutation needs the CSRF belt-and-suspenders header (§6.13). */
const CSRF_HEADERS = { 'X-Requested-With': 'BetterTrack' };

/** A fixed past trade day so no market-history assist perturbs the entered price. */
export const TRADE_DATE = '2024-01-15';
const TRADE_DATE_ISO = `${TRADE_DATE}T00:00:00.000Z`;

// ─── Minimal response shapes (kept structural so the specs stay self-contained,
//     matching the existing e2e style — no cross-package contract import). ─────

interface MirrorSync {
  appliedSeq: number;
  lastSeq: number;
  percent: number;
  synced: boolean;
}
interface ChainSummary {
  chainId: string;
  name: string;
  status: string;
  portfolioId: string | null;
  role: string;
  memberCount: number;
  sync: MirrorSync;
}
interface RosterMember {
  userId: string | null;
  username: string;
  role: string;
  isSelf: boolean;
  sync: MirrorSync;
}
export interface MemberList {
  chainId: string;
  name: string;
  status: string;
  role: string;
  memberCap: number;
  members: RosterMember[];
}
interface MirrorRowInfo {
  mirrorId: string;
  version: number;
  addedBy: { userId: string | null; username: string; profileIcon: string | null };
}
export interface LedgerTx {
  id: string;
  side: string;
  quantity: number;
  price: number;
  fee: number;
  executedAt: string;
  note: string | null;
  mirror?: MirrorRowInfo;
}
interface ActivityEntry {
  seq: number;
  kind: string;
  actorUsername: string;
}

// ─── Low-level authenticated calls (each through a user's cookie jar) ─────────

async function bodyText(res: APIResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<no body>';
  }
}

export async function apiGet<T>(user: E2EUser, path: string): Promise<T> {
  const res = await user.page.request.get(`${V1}${path}`);
  expect(res.ok(), `GET ${path} → ${res.status()} ${await bodyText(res)}`).toBeTruthy();
  return (await res.json()) as T;
}

export function apiSend(
  user: E2EUser,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  data?: Record<string, unknown>,
): Promise<APIResponse> {
  return user.page.request.fetch(`${V1}${path}`, {
    method,
    headers: CSRF_HEADERS,
    ...(data === undefined ? {} : { data }),
  });
}

/** The `{ error: { code } }` envelope's code, or undefined for a non-error body. */
export async function errorCode(res: APIResponse): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: { code?: string } };
    return body.error?.code;
  } catch {
    return undefined;
  }
}

// ─── Friendship / chain setup ─────────────────────────────────────────────────

/** The invitee's user id, resolved from the inviter's real friends list. */
export async function friendUserId(user: E2EUser, username: string): Promise<string> {
  const { friends } = await apiGet<{ friends: Array<{ user: { id: string; username: string } }> }>(
    user,
    '/social/friends',
  );
  const match = friends.find((f) => f.user.username === username);
  if (!match) throw new Error(`${username} is not in ${user.username}'s friends list`);
  return match.user.id;
}

/** "New group portfolio" (design §11 create) — an empty origin copy. */
export async function createEmptyChain(
  owner: E2EUser,
  name: string,
): Promise<{ chainId: string; portfolioId: string }> {
  const res = await apiSend(owner, 'POST', '/mirrorchain/chains', { name });
  expect(res.status(), `create chain → ${await bodyText(res)}`).toBe(201);
  const summary = (await res.json()) as ChainSummary;
  if (!summary.portfolioId) throw new Error('chain create returned a null portfolioId');
  return { chainId: summary.chainId, portfolioId: summary.portfolioId };
}

/**
 * Invite `invitee` (owner/manager → friend, design §4) and drive their §4
 * one-screen accept. Returns the invitee's freshly materialized copy portfolioId.
 */
export async function inviteAndJoin(
  owner: E2EUser,
  chainId: string,
  invitee: E2EUser,
): Promise<string> {
  const inviteeId = await friendUserId(owner, invitee.username);
  const sent = await apiSend(owner, 'POST', `/mirrorchain/chains/${chainId}/invites`, {
    userId: inviteeId,
  });
  expect(sent.ok(), `invite → ${sent.status()} ${await bodyText(sent)}`).toBeTruthy();

  let inviteId = '';
  await expect
    .poll(
      async () => {
        const list = await apiGet<{ incoming: Array<{ id: string; chainId: string }> }>(
          invitee,
          '/mirrorchain/invites',
        );
        inviteId = list.incoming.find((i) => i.chainId === chainId)?.id ?? '';
        return inviteId;
      },
      { timeout: 15_000, intervals: [500, 1000] },
    )
    .not.toBe('');

  const accepted = await apiSend(invitee, 'POST', `/mirrorchain/invites/${inviteId}/accept`);
  expect(accepted.ok(), `accept → ${accepted.status()} ${await bodyText(accepted)}`).toBeTruthy();
  const result = (await accepted.json()) as { portfolioId: string };
  return result.portfolioId;
}

/** Poll the caller's copy until it has caught up to the chain watermark (§4). */
export async function waitChainSynced(
  user: E2EUser,
  chainId: string,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { chains } = await apiGet<{ chains: ChainSummary[] }>(user, '/mirrorchain/chains');
        return chains.find((c) => c.chainId === chainId)?.sync.synced ?? false;
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
}

/** True while `chainId` is still an active membership of `user` (severed → false). */
export async function isChainMember(user: E2EUser, chainId: string): Promise<boolean> {
  const { chains } = await apiGet<{ chains: ChainSummary[] }>(user, '/mirrorchain/chains');
  return chains.some((c) => c.chainId === chainId);
}

export async function chainRole(user: E2EUser, chainId: string): Promise<string | undefined> {
  const { chains } = await apiGet<{ chains: ChainSummary[] }>(user, '/mirrorchain/chains');
  return chains.find((c) => c.chainId === chainId)?.role;
}

export function members(user: E2EUser, chainId: string): Promise<MemberList> {
  return apiGet<MemberList>(user, `/mirrorchain/chains/${chainId}/members`);
}

/** The activity feed = the oplog rendered per the caller's copy (design §6/§11). */
export async function activity(user: E2EUser, chainId: string): Promise<ActivityEntry[]> {
  const { entries } = await apiGet<{ entries: ActivityEntry[] }>(
    user,
    `/mirrorchain/chains/${chainId}/activity?limit=100`,
  );
  return entries;
}

// ─── Ledger ─────────────────────────────────────────────────────────────────

/** Resolve a catalog symbol to its materialized `assets` row id (§6.2 search). */
export async function assetIdFor(user: E2EUser, query: string, symbol: string): Promise<string> {
  const { results } = await apiGet<{ results: Array<{ id: string; symbol: string }> }>(
    user,
    `/search?q=${encodeURIComponent(query)}`,
  );
  const match = results.find((r) => r.symbol === symbol) ?? results[0];
  if (!match) throw new Error(`no catalog asset for "${query}"`);
  return match.id;
}

/** Record a plain buy through the normal ledger endpoint; returns the local row id. */
export async function recordBuy(
  user: E2EUser,
  portfolioId: string,
  input: { assetId: string; quantity: number; price: number },
): Promise<string> {
  const res = await apiSend(user, 'POST', `/portfolios/${portfolioId}/transactions`, {
    assetId: input.assetId,
    side: 'buy',
    quantity: input.quantity,
    price: input.price,
    fee: 0,
    executedAt: TRADE_DATE_ISO,
    note: null,
  });
  expect(res.status(), `record buy → ${await bodyText(res)}`).toBe(201);
  const body = (await res.json()) as { transactions: LedgerTx[] };
  return body.transactions[0]!.id;
}

export async function listTransactions(user: E2EUser, portfolioId: string): Promise<LedgerTx[]> {
  const { items } = await apiGet<{ items: LedgerTx[] }>(
    user,
    `/portfolios/${portfolioId}/transactions?limit=200`,
  );
  return items;
}

/** Poll a copy's ledger until a row matching `match` appears; returns that row. */
export async function waitForTransaction(
  user: E2EUser,
  portfolioId: string,
  match: (tx: LedgerTx) => boolean,
  timeout = 30_000,
): Promise<LedgerTx> {
  let found: LedgerTx | undefined;
  await expect
    .poll(
      async () => {
        found = (await listTransactions(user, portfolioId)).find(match);
        return Boolean(found);
      },
      { timeout, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return found as LedgerTx;
}

// ─── UI: record a buy on a specific copy through the real "+ Transaction" dialog ─

/**
 * Drive the real transaction dialog on the `?portfolio=<id>` copy (mirrors
 * `flows.recordSapTrade`, buy-only, portfolio-targeted). Used by the flagship
 * "member buy propagates, attributed" spec so the write is a genuine member UI
 * action, not an API poke.
 */
export async function recordSapBuyOnCopyUi(
  page: Page,
  portfolioId: string,
  opts: { quantity: string; price: string },
): Promise<void> {
  await page.goto(`/portfolio?portfolio=${portfolioId}`);
  await page.getByRole('button', { name: '+ Transaction' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Search assets' }).fill('SAP');
  await dialog.getByRole('button', { name: 'Select SAP.DE', exact: true }).click();
  // Unlink the date↔price assist so the entered price is taken verbatim; the
  // toggle only exists once a series is available, so its absence is fine.
  await dialog
    .getByRole('button', { name: 'Unlink date and price' })
    .click({ timeout: 20_000 })
    .catch(() => {});
  await dialog.getByLabel('Date for SAP.DE').fill(TRADE_DATE);
  await dialog.getByLabel('Quantity for SAP.DE').fill(opts.quantity);
  await dialog.getByLabel('Price for SAP.DE').fill(opts.price);
  await dialog.getByRole('button', { name: 'Record buy' }).click();
  await expect(dialog).toBeHidden();
}
