import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  MIRROR_MAX_MEMBERS,
  type MirrorInvite,
  type MirrorMember,
  type MirrorMemberRole,
  type PortfolioMirrorBadge,
  type PortfolioForkProvenance,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import {
  acceptMirrorInvite,
  createMirrorChain,
  convertMirrorChain,
  declineMirrorInvite,
  dissolveMirrorChain,
  getMirrorActivity,
  getMirrorMembers,
  inviteMirrorMember,
  leaveMirrorChain,
  listMirrorInvites,
  removeMirrorMember,
  renameMirrorChain,
  revokeMirrorInvite,
  setMirrorMemberRole,
  transferMirrorOwnership,
} from '../../lib/mirrorApi';
import { listFriends } from '../../lib/socialApi';
import { useAuth } from '../AuthContext';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';
import { formatDate } from '../../lib/format';

/**
 * MIRRORCHAIN — the group-portfolio surface (V5-P7 M5,
 * `docs/mirrorchain-design.md` §§4–7, §11). Everything chain-related lives
 * behind ONE affordance (the avatar stack on the portfolio header of a synced
 * copy); tapping it opens the {@link MemberSheet} — the entire management
 * surface — from which owner/managers reach Invite, Kick, Grant/Revoke,
 * Transfer, and (owner) Dissolve. Non-chain portfolios never render any of
 * this; the header is byte-identical to today (design §1 routing).
 */

const CHAINS_KEY = ['mirror', 'chains'] as const;
const chainMembersKey = (chainId: string) => ['mirror', 'chain', chainId, 'members'] as const;
const chainActivityKey = (chainId: string) => ['mirror', 'chain', chainId, 'activity'] as const;
const MIRROR_INVITES_KEY = ['mirror', 'invites'] as const;

function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

// ─── Avatar stack ────────────────────────────────────────────────────────────

/**
 * The one affordance on a synced-copy portfolio header (design §11). Renders a
 * horizontally overlapped stack of members' profile icons (up to `visibleMax`
 * before a "+N" chip), plus the chain name and the sync-state badge
 * ("Syncing… n %" until caught up). Click opens the {@link MemberSheet} —
 * that sheet is the entire chain-management surface (§11).
 */
export function MirrorAvatarStack({
  badge,
  members,
  onClick,
  visibleMax = 4,
}: {
  badge: PortfolioMirrorBadge;
  members?: readonly MirrorMember[];
  onClick: () => void;
  visibleMax?: number;
}) {
  const t = useT();
  const shown = members?.slice(0, visibleMax) ?? [];
  const hidden = Math.max(0, badge.memberCount - shown.length);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-left text-sm hover:border-neutral-700 hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      aria-label={t('mirrorchain.avatarStack.openAria', {
        name: badge.chainName,
        count: badge.memberCount,
      })}
    >
      <span className="flex -space-x-2" aria-hidden="true">
        {shown.length === 0 ? (
          <Avatar name={badge.chainName} size="sm" className="ring-2 ring-neutral-900" />
        ) : (
          shown.map((m) => (
            <Avatar
              key={m.userId ?? m.username}
              name={m.username}
              iconId={m.profileIcon}
              size="sm"
              className="ring-2 ring-neutral-900"
            />
          ))
        )}
        {hidden > 0 ? (
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-xs font-medium text-neutral-200 ring-2 ring-neutral-900">
            +{hidden}
          </span>
        ) : null}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-medium text-neutral-100">{badge.chainName}</span>
        <span className="text-xs text-neutral-500">
          {badge.sync.synced
            ? t('mirrorchain.avatarStack.membersCount', { count: badge.memberCount })
            : t('mirrorchain.avatarStack.syncing', { percent: badge.sync.percent })}
        </span>
      </span>
    </button>
  );
}

// ─── Fork provenance line ────────────────────────────────────────────────────

/**
 * The one-line provenance shown on a forked portfolio's header (design §6):
 * "Forked from ⟨chain⟩ · ⟨date⟩". Rendered from the membership tombstone that
 * survives the sever (the fork is a fully working, editable portfolio; the
 * chain link is broken, the history stays).
 */
export function MirrorForkProvenanceLine({ fork }: { fork: PortfolioForkProvenance }) {
  const t = useT();
  return (
    <p className="text-xs text-neutral-500">
      {t('mirrorchain.fork.provenance', {
        chain: fork.chainName,
        date: formatDate(fork.endedAt),
      })}
    </p>
  );
}

// ─── Attribution chip ────────────────────────────────────────────────────────

/**
 * Small actor chip rendered on chain rows in the transaction / dividend / cash
 * lists (design §10/§11): who added the row. On a shared copy viewed by a
 * non-member, the server replaces the actor with the generic "group member"
 * chip — a member may expose their own book, never their co-members'
 * identities (design §10, enforced server-side).
 */
export function MirrorAttributionChip({
  attribution,
}: {
  attribution: { username: string; profileIcon: string | null };
}) {
  const t = useT();
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-neutral-800 py-0.5 pl-0.5 pr-2 text-xs text-neutral-300"
      title={t('mirrorchain.attribution.by', { username: attribution.username })}
    >
      <Avatar
        name={attribution.username}
        iconId={attribution.profileIcon}
        size="sm"
        className="!h-4 !w-4"
      />
      <span className="truncate max-w-[9rem]">{attribution.username}</span>
    </span>
  );
}

// ─── Sync progress badge ─────────────────────────────────────────────────────

export function MirrorSyncBadge({ badge }: { badge: PortfolioMirrorBadge }) {
  const t = useT();
  if (badge.sync.synced) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
      {t('mirrorchain.avatarStack.syncing', { percent: badge.sync.percent })}
    </span>
  );
}

// ─── Member sheet (the entire management surface) ────────────────────────────

/** The full member sheet (design §11): roster + role-gated actions + activity. */
export function MemberSheet({ chainId, onClose }: { chainId: string; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<null | ConfirmAction>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const membersQuery = useQuery({
    queryKey: chainMembersKey(chainId),
    queryFn: ({ signal }) => getMirrorMembers(chainId, signal),
  });
  const activityQuery = useQuery({
    queryKey: chainActivityKey(chainId),
    queryFn: ({ signal }) => getMirrorActivity(chainId, { limit: 20 }, signal),
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: CHAINS_KEY });
    void queryClient.invalidateQueries({ queryKey: chainMembersKey(chainId) });
    void queryClient.invalidateQueries({ queryKey: chainActivityKey(chainId) });
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  }

  if (membersQuery.isLoading) {
    return (
      <Dialog
        title={t('mirrorchain.memberSheet.title')}
        onClose={onClose}
        widthClassName="max-w-2xl"
      >
        <p className="text-sm text-neutral-500">{t('common.loading')}</p>
      </Dialog>
    );
  }
  if (membersQuery.isError || !membersQuery.data) {
    return (
      <Dialog
        title={t('mirrorchain.memberSheet.title')}
        onClose={onClose}
        widthClassName="max-w-2xl"
      >
        <Alert tone="error">{t('mirrorchain.memberSheet.loadError')}</Alert>
      </Dialog>
    );
  }

  const data = membersQuery.data;
  const canInvite = data.role === 'owner' || data.role === 'manager';
  const canRename = canInvite;
  const canDissolve = data.role === 'owner';

  return (
    <Dialog
      title={data.name}
      description={t('mirrorchain.memberSheet.subtitle')}
      onClose={onClose}
      widthClassName="max-w-2xl"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-neutral-500">
            {t('mirrorchain.memberSheet.roster', {
              count: data.members.length,
              max: data.memberCap,
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            {canInvite ? (
              <Button
                variant="primary"
                onClick={() => setInviteOpen(true)}
                disabled={data.members.length >= data.memberCap}
              >
                {t('mirrorchain.actions.invite')}
              </Button>
            ) : null}
            {canRename ? (
              <Button variant="secondary" onClick={() => setRenameOpen(true)}>
                {t('mirrorchain.actions.rename')}
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setConfirmKind({ kind: 'leave' })}>
              {t('mirrorchain.actions.leave')}
            </Button>
            {canDissolve ? (
              <Button
                variant="secondary"
                onClick={() => setConfirmKind({ kind: 'dissolve' })}
                className="border-red-700 text-red-300 hover:bg-red-900/40"
              >
                {t('mirrorchain.actions.dissolve')}
              </Button>
            ) : null}
          </div>
        </div>

        <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
          {data.members.map((member) => (
            <MemberRow
              key={member.userId ?? member.username}
              member={member}
              viewerRole={data.role}
              onAction={(action) => setConfirmKind({ kind: action, target: member })}
            />
          ))}
        </ul>

        <ActivitySection query={activityQuery} />
      </div>

      {inviteOpen ? (
        <InviteDialog
          chainId={chainId}
          existingMemberUserIds={
            new Set(data.members.map((m) => m.userId).filter(Boolean) as string[])
          }
          onClose={() => setInviteOpen(false)}
          onDone={() => {
            setInviteOpen(false);
            invalidate();
            void queryClient.invalidateQueries({ queryKey: MIRROR_INVITES_KEY });
          }}
        />
      ) : null}
      {renameOpen ? (
        <RenameChainDialog
          chainId={chainId}
          current={data.name}
          onClose={() => setRenameOpen(false)}
          onDone={() => {
            setRenameOpen(false);
            invalidate();
          }}
        />
      ) : null}
      {confirmKind ? (
        <ConfirmActionDialog
          chainId={chainId}
          chainName={data.name}
          action={confirmKind}
          onClose={() => setConfirmKind(null)}
          onDone={() => {
            setConfirmKind(null);
            invalidate();
            if (confirmKind.kind === 'leave' || confirmKind.kind === 'dissolve') onClose();
          }}
        />
      ) : null}
    </Dialog>
  );
}

type ConfirmAction =
  | { kind: 'leave' }
  | { kind: 'dissolve' }
  | { kind: 'kick'; target: MirrorMember }
  | { kind: 'grantManage'; target: MirrorMember }
  | { kind: 'revokeManage'; target: MirrorMember }
  | { kind: 'transfer'; target: MirrorMember };

function MemberRow({
  member,
  viewerRole,
  onAction,
}: {
  member: MirrorMember;
  viewerRole: MirrorMemberRole;
  onAction: (action: ConfirmAction['kind']) => void;
}) {
  const t = useT();
  const canManageRoles = viewerRole === 'owner' && !member.isSelf && member.role !== 'owner';
  const canTransfer = viewerRole === 'owner' && !member.isSelf && member.role !== 'owner';
  // §5 kick rules: owner kicks anyone-but-self-and-owner; manager kicks only members.
  const canKick =
    !member.isSelf &&
    member.role !== 'owner' &&
    (viewerRole === 'owner' || (viewerRole === 'manager' && member.role === 'member'));

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar name={member.username} iconId={member.profileIcon} size="md" />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium text-neutral-100">
            {member.username}
            {member.isSelf ? (
              <span className="ml-2 text-xs text-neutral-500">
                ({t('mirrorchain.memberRow.you')})
              </span>
            ) : null}
          </span>
          <span className="text-xs text-neutral-500">
            {t(`mirrorchain.role.${member.role}`)} ·{' '}
            {t('mirrorchain.memberRow.joined', {
              date: formatDate(member.joinedAt),
            })}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!member.sync.synced ? (
          <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
            {t('mirrorchain.avatarStack.syncing', { percent: member.sync.percent })}
          </span>
        ) : null}
        {canManageRoles ? (
          member.role === 'manager' ? (
            <Button variant="secondary" onClick={() => onAction('revokeManage')}>
              {t('mirrorchain.actions.revokeManage')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onAction('grantManage')}>
              {t('mirrorchain.actions.grantManage')}
            </Button>
          )
        ) : null}
        {canTransfer ? (
          <Button variant="secondary" onClick={() => onAction('transfer')}>
            {t('mirrorchain.actions.transfer')}
          </Button>
        ) : null}
        {canKick ? (
          <Button
            variant="secondary"
            className="border-red-700 text-red-300 hover:bg-red-900/40"
            onClick={() => onAction('kick')}
          >
            {t('mirrorchain.actions.kick')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// ─── Activity feed (inside the member sheet) ─────────────────────────────────

function ActivitySection({
  query,
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof getMirrorActivity>>>>;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {t('mirrorchain.activity.title')}
      </h3>
      {query.isLoading ? (
        <p className="text-sm text-neutral-500">{t('common.loading')}</p>
      ) : query.isError || !query.data ? (
        <Alert tone="error">{t('mirrorchain.activity.loadError')}</Alert>
      ) : query.data.entries.length === 0 ? (
        <p className="text-sm text-neutral-500">{t('mirrorchain.activity.empty')}</p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
          {query.data.entries.map((entry) => (
            <li
              key={entry.seq}
              className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm"
            >
              <span className="text-neutral-200">{entry.summary}</span>
              <span className="text-xs text-neutral-500">{formatDate(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Invite dialog (friend picker → send) ────────────────────────────────────

function InviteDialog({
  chainId,
  existingMemberUserIds,
  onClose,
  onDone,
}: {
  chainId: string;
  existingMemberUserIds: Set<string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const friendsQuery = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
    staleTime: 30_000,
  });
  const invite = useMutation({
    mutationFn: (userId: string) => inviteMirrorMember(chainId, { userId }),
    onSuccess: onDone,
  });

  const friends = useMemo(() => {
    const list = friendsQuery.data?.friends ?? [];
    const q = query.trim().toLowerCase();
    return list
      .filter((f) => !existingMemberUserIds.has(f.user.id))
      .filter((f) => (q ? f.user.username.toLowerCase().includes(q) : true));
  }, [friendsQuery.data, existingMemberUserIds, query]);

  return (
    <Dialog title={t('mirrorchain.invite.title')} onClose={onClose} widthClassName="max-w-md">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-400">{t('mirrorchain.invite.body')}</p>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('mirrorchain.invite.searchPlaceholder')}
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-sky-400 focus:outline-none"
        />
        {friendsQuery.isLoading ? (
          <p className="text-sm text-neutral-500">{t('common.loading')}</p>
        ) : friends.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('mirrorchain.invite.empty')}</p>
        ) : (
          <ul className="max-h-72 divide-y divide-neutral-800 overflow-y-auto rounded-md border border-neutral-800">
            {friends.map((friendship) => (
              <li
                key={friendship.user.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="flex items-center gap-2">
                  <Avatar
                    name={friendship.user.username}
                    iconId={friendship.user.profileIcon}
                    size="sm"
                  />
                  <span className="text-sm text-neutral-100">{friendship.user.username}</span>
                </span>
                <Button
                  variant="primary"
                  onClick={() => invite.mutate(friendship.user.id)}
                  disabled={invite.isPending}
                >
                  {invite.variables === friendship.user.id && invite.isPending
                    ? t('mirrorchain.invite.sending')
                    : t('mirrorchain.actions.sendInvite')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {invite.isError ? <Alert tone="error">{inviteErrorMessage(invite.error, t)}</Alert> : null}
      </div>
    </Dialog>
  );
}

function inviteErrorMessage(error: unknown, t: TranslateFn): string {
  if (error instanceof ApiError) {
    if (error.code === 'MIRROR_NOT_FRIENDS') return t('mirrorchain.invite.errorNotFriends');
    if (error.code === 'MIRROR_MEMBER_CAP_REACHED')
      return t('mirrorchain.invite.errorCapReached', { max: MIRROR_MAX_MEMBERS });
    if (error.code === 'MIRROR_INVITE_EXISTS') return t('mirrorchain.invite.errorAlreadyInvited');
    if (error.code === 'MIRROR_ALREADY_MEMBER') return t('mirrorchain.invite.errorAlreadyMember');
  }
  return t('mirrorchain.invite.errorGeneric');
}

// ─── Rename dialog ───────────────────────────────────────────────────────────

function RenameChainDialog({
  chainId,
  current,
  onClose,
  onDone,
}: {
  chainId: string;
  current: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(current);
  const rename = useMutation({
    mutationFn: () => renameMirrorChain(chainId, { name: name.trim() }),
    onSuccess: onDone,
  });
  const disabled = rename.isPending || !name.trim() || name.trim() === current;
  return (
    <Dialog title={t('mirrorchain.rename.title')} onClose={onClose} widthClassName="max-w-md">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) rename.mutate();
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
          maxLength={120}
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-sky-400 focus:outline-none"
        />
        {rename.isError ? (
          <Alert tone="error">
            {isForbidden(rename.error)
              ? t('mirrorchain.errors.forbidden')
              : t('mirrorchain.rename.error')}
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={rename.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={disabled}>
            {rename.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ─── Confirm action dialogs (leave / kick / dissolve / transfer / grant / revoke) ─

function ConfirmActionDialog({
  chainId,
  chainName,
  action,
  onClose,
  onDone,
}: {
  chainId: string;
  chainName: string;
  action: ConfirmAction;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const mutation = useMutation({
    mutationFn: async () => {
      switch (action.kind) {
        case 'leave':
          await leaveMirrorChain(chainId);
          return;
        case 'dissolve':
          await dissolveMirrorChain(chainId);
          return;
        case 'kick':
          await removeMirrorMember(chainId, action.target.userId!);
          return;
        case 'grantManage':
          await setMirrorMemberRole(chainId, action.target.userId!, { role: 'manager' });
          return;
        case 'revokeManage':
          await setMirrorMemberRole(chainId, action.target.userId!, { role: 'member' });
          return;
        case 'transfer':
          await transferMirrorOwnership(chainId, { toUserId: action.target.userId! });
          return;
      }
    },
    onSuccess: onDone,
  });
  const title = t(`mirrorchain.confirm.${action.kind}.title`);
  const body = t(`mirrorchain.confirm.${action.kind}.body`, {
    chain: chainName,
    username: 'target' in action ? action.target.username : '',
  });
  const confirmLabel = t(`mirrorchain.confirm.${action.kind}.confirm`);
  const danger = action.kind === 'dissolve' || action.kind === 'kick' || action.kind === 'leave';
  return (
    <Dialog title={title} onClose={onClose} widthClassName="max-w-md">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-neutral-300">{body}</p>
        {mutation.isError ? (
          <Alert tone="error">
            {isForbidden(mutation.error)
              ? t('mirrorchain.errors.forbidden')
              : t('mirrorchain.errors.generic')}
          </Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className={cx(danger && 'bg-red-700 hover:bg-red-600 disabled:bg-red-900')}
          >
            {mutation.isPending ? t('common.processing') : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Create + convert entry points ────────────────────────────────────────────

/**
 * The "New group portfolio" affordance (design §11). Opens with a chain-name
 * prompt; on create, the friend-picker invite step opens immediately (§11).
 */
export function CreateChainDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (chainId: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => createMirrorChain({ name: name.trim() }),
    onSuccess: (summary) => onCreated(summary.chainId),
  });
  const disabled = create.isPending || !name.trim();
  return (
    <Dialog
      title={t('mirrorchain.create.title')}
      description={t('mirrorchain.create.body')}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) create.mutate();
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('mirrorchain.create.namePlaceholder')}
          maxLength={120}
          autoFocus
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-sky-400 focus:outline-none"
        />
        {create.isError ? <Alert tone="error">{t('mirrorchain.create.error')}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={disabled}>
            {create.isPending ? t('common.creating') : t('mirrorchain.create.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * "Make this a group portfolio" (design §11 convert). Confirms turning the
 * existing portfolio into the origin copy of a new chain (§2 genesis); on
 * success the friend-picker invite step opens immediately.
 */
export function ConvertChainDialog({
  portfolioId,
  portfolioName,
  onClose,
  onConverted,
}: {
  portfolioId: string;
  portfolioName: string;
  onClose: () => void;
  onConverted: (chainId: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(portfolioName);
  const convert = useMutation({
    mutationFn: () => convertMirrorChain({ portfolioId, name: name.trim() || undefined }),
    onSuccess: (summary) => onConverted(summary.chainId),
  });
  const disabled = convert.isPending || !name.trim();
  return (
    <Dialog
      title={t('mirrorchain.convert.title')}
      description={t('mirrorchain.convert.body')}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled) convert.mutate();
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-sky-400 focus:outline-none"
        />
        {convert.isError ? (
          <Alert tone="error">{convertErrorMessage(convert.error, t)}</Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={convert.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={disabled}>
            {convert.isPending ? t('common.processing') : t('mirrorchain.convert.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function convertErrorMessage(error: unknown, t: TranslateFn): string {
  if (error instanceof ApiError) {
    if (error.code === 'MIRROR_ALREADY_SYNCED') return t('mirrorchain.convert.errorAlreadySynced');
    if (error.code === 'MIRROR_ASSET_NOT_SYNCABLE')
      return t('mirrorchain.convert.errorCustomAsset');
  }
  return t('mirrorchain.convert.errorGeneric');
}

// ─── Accept-invite (the §4 acknowledgment) ────────────────────────────────────

/**
 * The §4 one-screen acknowledgment — the confirmation IS the accept. Exact copy
 * comes from the design note; ships EN + DE (the i18n key set below). This is
 * the ONLY thing the invitee sees before their copy materializes; the join
 * shows the syncing state in the switcher (design §4 zero-config).
 */
export function AcceptInviteDialog({
  invite,
  onClose,
  onAccepted,
}: {
  invite: MirrorInvite;
  onClose: () => void;
  onAccepted: (chainId: string, portfolioId: string) => void;
}) {
  const t = useT();
  const accept = useMutation({
    mutationFn: () => acceptMirrorInvite(invite.id),
    onSuccess: (result) => onAccepted(result.chainId, result.portfolioId),
  });
  const decline = useMutation({
    mutationFn: () => declineMirrorInvite(invite.id),
    onSuccess: onClose,
  });
  return (
    <Dialog
      title={t('mirrorchain.accept.title', { chain: invite.chainName })}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-200">
          {t('mirrorchain.accept.acknowledgment', { chain: invite.chainName })}
        </p>
        {accept.isError || decline.isError ? (
          <Alert tone="error">{t('mirrorchain.errors.generic')}</Alert>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => decline.mutate()}
            disabled={decline.isPending || accept.isPending}
          >
            {decline.isPending ? t('common.processing') : t('mirrorchain.accept.decline')}
          </Button>
          <Button
            variant="primary"
            onClick={() => accept.mutate()}
            disabled={accept.isPending || decline.isPending}
          >
            {accept.isPending ? t('common.processing') : t('mirrorchain.accept.accept')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Data hooks ──────────────────────────────────────────────────────────────

/** Fetch the caller's mirror invites (used by Social requests + notifications). */
export function useMirrorInvites() {
  return useQuery({
    queryKey: MIRROR_INVITES_KEY,
    queryFn: ({ signal }) => listMirrorInvites(signal),
    staleTime: 15_000,
  });
}

/** Revoke a pending outgoing invite (owner/manager). */
export function useRevokeMirrorInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => revokeMirrorInvite(inviteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MIRROR_INVITES_KEY });
    },
  });
}

/**
 * Hook that pairs the current user's mirror invite list to the caller's UI —
 * exports a helper so the Social requests + notification bell surfaces render
 * incoming mirror invites the same as friend requests.
 */
export function useIsMirrorInvitee(inviteId: string): boolean {
  const auth = useAuth();
  const invites = useMirrorInvites();
  const userId = auth.user?.id;
  const invite = invites.data?.incoming.find((i) => i.id === inviteId);
  return !!invite && !!userId;
}
