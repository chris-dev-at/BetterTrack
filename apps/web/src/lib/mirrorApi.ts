import {
  mirrorAcceptInviteResponseSchema,
  mirrorActivityResponseSchema,
  mirrorChainListResponseSchema,
  mirrorChainSummarySchema,
  mirrorInviteListResponseSchema,
  mirrorMemberListResponseSchema,
  okResponseSchema,
  type ConvertMirrorChainRequest,
  type CreateMirrorChainRequest,
  type InviteMirrorMemberRequest,
  type MirrorAcceptInviteResponse,
  type MirrorActivityResponse,
  type MirrorChainListResponse,
  type MirrorChainSummary,
  type MirrorInviteListResponse,
  type MirrorMemberListResponse,
  type RenameMirrorChainRequest,
  type SetMirrorMemberRoleRequest,
  type TransferMirrorOwnershipRequest,
} from '@bettertrack/contracts';

import { apiRequest } from './apiClient';

/**
 * Typed client for the MIRRORCHAIN group-portfolio surface (V5-P7 M5,
 * `docs/mirrorchain-design.md` §§4–7, §11). The eight `mirror.*` notification
 * types the dispatcher fires + the invite-list entry point mirror this. Every
 * mutation goes through the session cookie + CSRF header; the router mounts
 * `requireUser` for us.
 */

/**
 * `GET /mirrorchain/chains` — the caller's active group-portfolio summaries.
 * One row per active membership; the portfolio switcher renders the sync-state
 * badge off this.
 */
export async function listMirrorChains(signal?: AbortSignal): Promise<MirrorChainListResponse> {
  const data = await apiRequest<unknown>('/mirrorchain/chains', { signal });
  return mirrorChainListResponseSchema.parse(data);
}

/** `POST /mirrorchain/chains` — "new group portfolio" (design §11 create). */
export async function createMirrorChain(
  body: CreateMirrorChainRequest,
): Promise<MirrorChainSummary> {
  const data = await apiRequest<unknown>('/mirrorchain/chains', { method: 'POST', body });
  return mirrorChainSummarySchema.parse(data);
}

/** `POST /mirrorchain/chains/convert` — "make this a group portfolio" (§2 genesis). */
export async function convertMirrorChain(
  body: ConvertMirrorChainRequest,
): Promise<MirrorChainSummary> {
  const data = await apiRequest<unknown>('/mirrorchain/chains/convert', { method: 'POST', body });
  return mirrorChainSummarySchema.parse(data);
}

/** `GET /mirrorchain/invites` — pending invites in + out (design §4 + Social requests). */
export async function listMirrorInvites(signal?: AbortSignal): Promise<MirrorInviteListResponse> {
  const data = await apiRequest<unknown>('/mirrorchain/invites', { signal });
  return mirrorInviteListResponseSchema.parse(data);
}

/**
 * `POST /mirrorchain/invites/:inviteId/accept` — the §4 one-screen acceptance:
 * the copy is materialized immediately (auto-named + Main-linked) and content
 * arrives via replay. The dialog shown before this call IS the accept.
 */
export async function acceptMirrorInvite(inviteId: string): Promise<MirrorAcceptInviteResponse> {
  const data = await apiRequest<unknown>(`/mirrorchain/invites/${inviteId}/accept`, {
    method: 'POST',
  });
  return mirrorAcceptInviteResponseSchema.parse(data);
}

/** `POST /mirrorchain/invites/:inviteId/decline` — decline (a re-invite is allowed). */
export async function declineMirrorInvite(inviteId: string): Promise<void> {
  const data = await apiRequest<unknown>(`/mirrorchain/invites/${inviteId}/decline`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `POST /mirrorchain/invites/:inviteId/revoke` — owner + managers only (§4). */
export async function revokeMirrorInvite(inviteId: string): Promise<void> {
  const data = await apiRequest<unknown>(`/mirrorchain/invites/${inviteId}/revoke`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/**
 * `GET /mirrorchain/chains/:chainId/members` — the member sheet (design §11):
 * roster + the caller's role + sync state per member.
 */
export async function getMirrorMembers(
  chainId: string,
  signal?: AbortSignal,
): Promise<MirrorMemberListResponse> {
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/members`, { signal });
  return mirrorMemberListResponseSchema.parse(data);
}

/**
 * `GET /mirrorchain/chains/:chainId/activity?before=&limit=` — the activity
 * feed (design §6/§11), newest-first, paginated by seq.
 */
export async function getMirrorActivity(
  chainId: string,
  opts: { before?: number; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MirrorActivityResponse> {
  const query: Record<string, string | number | undefined> = {};
  if (opts.before !== undefined) query.before = opts.before;
  if (opts.limit !== undefined) query.limit = opts.limit;
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/activity`, {
    query,
    signal,
  });
  return mirrorActivityResponseSchema.parse(data);
}

/** `POST /mirrorchain/chains/:chainId/invites` — invite a friend (owner + managers, §5). */
export async function inviteMirrorMember(
  chainId: string,
  body: InviteMirrorMemberRequest,
): Promise<void> {
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/invites`, {
    method: 'POST',
    body,
  });
  okResponseSchema.parse(data);
}

/** `PATCH /mirrorchain/chains/:chainId` — rename the chain (owner + managers, §5). */
export async function renameMirrorChain(
  chainId: string,
  body: RenameMirrorChainRequest,
): Promise<MirrorChainSummary> {
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}`, {
    method: 'PATCH',
    body,
  });
  return mirrorChainSummarySchema.parse(data);
}

/**
 * `POST /mirrorchain/chains/:chainId/transfer` — transfer ownership to an
 * active member (owner-only, §5). The old owner becomes a plain member.
 */
export async function transferMirrorOwnership(
  chainId: string,
  body: TransferMirrorOwnershipRequest,
): Promise<void> {
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/transfer`, {
    method: 'POST',
    body,
  });
  okResponseSchema.parse(data);
}

/**
 * `POST /mirrorchain/chains/:chainId/leave` — leave → keep an un-synced fork
 * (design §6). For the owner, this runs §7 succession first (M4).
 */
export async function leaveMirrorChain(chainId: string): Promise<void> {
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/leave`, {
    method: 'POST',
  });
  okResponseSchema.parse(data);
}

/** `DELETE /mirrorchain/chains/:chainId` — dissolve → every copy forks (owner-only, §6). */
export async function dissolveMirrorChain(chainId: string): Promise<void> {
  await apiRequest<unknown>(`/mirrorchain/chains/${chainId}`, { method: 'DELETE' });
}

/**
 * `PATCH /mirrorchain/chains/:chainId/members/:userId/role` — grant (`manager`)
 * or revoke (`member`) manage rights (owner-only, §5).
 */
export async function setMirrorMemberRole(
  chainId: string,
  userId: string,
  body: SetMirrorMemberRoleRequest,
): Promise<void> {
  const data = await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/members/${userId}/role`, {
    method: 'PATCH',
    body,
  });
  okResponseSchema.parse(data);
}

/**
 * `DELETE /mirrorchain/chains/:chainId/members/:userId` — kick → fork (§6).
 * The removed member keeps their copy, un-synced.
 */
export async function removeMirrorMember(chainId: string, userId: string): Promise<void> {
  await apiRequest<unknown>(`/mirrorchain/chains/${chainId}/members/${userId}`, {
    method: 'DELETE',
  });
}
