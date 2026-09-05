import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type FormEvent } from 'react';

import {
  FRIEND_GROUPS_MAX,
  FRIEND_GROUP_MEMBERS_MAX,
  type FriendGroup,
} from '@bettertrack/contracts';

import {
  addGroupMember,
  createGroup,
  deleteGroup,
  listFriends,
  listGroups,
  removeGroupMember,
  renameGroup,
} from '../../lib/socialApi';
import { useT } from '../../i18n';
import { EmptyState } from '../../ui';
import { Button, Field, Icon, Input, SkeletonBlock } from '../../ui/origin';
import { Alert } from '../components/ui';
import { AsyncReadState } from '../components/AsyncReadState';
import { Avatar } from '../components/Avatar';
import { Dialog } from '../components/Dialog';

/**
 * Friend groups (§13.5 V5-P8) — named circles the owner can share to as a
 * `group` audience (sits between specific-friends and all-friends). Compact by
 * the anti-bloat rule: one collapsed section inside the Friends page with an
 * inline creator and per-group expanders for renaming, membership and deletion.
 * A group is private to its owner; only accepted friends can be added, and
 * deleting a group makes every share pointing at it go dark (warned before
 * confirm).
 */

const GROUPS_STALE_MS = 30_000;

// ─── Delete confirmation (warns the owner shares will go dark) ────────────────

function DeleteGroupDialog({
  group,
  onConfirm,
  onClose,
  pending,
  error,
}: {
  group: FriendGroup;
  onConfirm: () => void;
  onClose: () => void;
  pending: boolean;
  error: boolean;
}) {
  const t = useT();
  // Name how many shares go dark: deleting a circle six items point at must not
  // read exactly like deleting one nothing points at (#1710). The count is the
  // server's live `shareCount`, not a guess.
  const plural = group.shareCount === 0 ? 'none' : group.shareCount === 1 ? 'one' : 'other';
  return (
    <Dialog
      phoneSheet
      title={t('social.groups.deleteTitle', { name: group.name })}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <p className="bt-soft">
          {t(`social.groups.deleteWarning.${plural}`, { count: group.shareCount })}
        </p>
        {error ? <Alert tone="error">{t('social.groups.deleteError')}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={pending} onClick={onClose} variant="quiet">
            {t('common.cancel')}
          </Button>
          <Button disabled={pending} onClick={onConfirm} variant="danger">
            {pending ? t('social.groups.deleting') : t('common.delete')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── One group card (rename · members · delete) ───────────────────────────────

function GroupCard({ group }: { group: FriendGroup }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // One card per group, each with its own expander: a hard-coded input id would
  // repeat in the document as soon as two cards are open, and the second card's
  // label would focus the first card's field.
  const nameFieldId = useId();

  const friendsQuery = useQuery({
    queryKey: ['social', 'friends'],
    queryFn: ({ signal }) => listFriends(signal),
    staleTime: GROUPS_STALE_MS,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['social', 'groups'] });
  }

  const renameMutation = useMutation({
    mutationFn: (next: string) => renameGroup(group.id, next),
    onSuccess: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(group.id),
    onSuccess: () => {
      setConfirmDelete(false);
      invalidate();
    },
  });
  const addMutation = useMutation({
    mutationFn: (userId: string) => addGroupMember(group.id, userId),
    onSuccess: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeGroupMember(group.id, userId),
    onSuccess: invalidate,
  });

  const memberIds = useMemo(() => new Set(group.members.map((m) => m.id)), [group.members]);
  const candidates = (friendsQuery.data?.friends ?? []).filter((f) => !memberIds.has(f.user.id));

  const trimmed = name.trim();
  const canRename = trimmed.length > 0 && trimmed !== group.name && !renameMutation.isPending;
  // The server refuses an add past the roster ceiling; say so before the click
  // rather than turning the ceiling into an opaque "could not update" (#1780).
  const rosterFull = group.memberCount >= FRIEND_GROUP_MEMBERS_MAX;

  return (
    <li className="bt-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="bt-band__row flex w-full items-center gap-3 text-left"
        style={{
          background: 'none',
          border: 0,
          color: 'inherit',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="bt-row-title truncate">{group.name}</span>
          <span className="bt-row-sub truncate">
            {t(`social.groups.memberCount.${group.memberCount === 1 ? 'one' : 'other'}`, {
              count: group.memberCount,
            })}
          </span>
        </span>
        <Icon
          name="chevron-right"
          size={16}
          style={{
            color: 'var(--bt-faint)',
            flex: 'none',
            transform: open ? 'rotate(90deg)' : undefined,
            transition: 'transform var(--bt-t-fast)',
          }}
        />
      </button>

      {open ? (
        <div className="bt-t-rule flex flex-col gap-4" style={{ padding: 16 }}>
          {/* Rename */}
          <form
            className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (canRename) renameMutation.mutate(trimmed);
            }}
          >
            <Field className="flex-1" htmlFor={nameFieldId} label={t('social.groups.nameLabel')}>
              <Input
                id={nameFieldId}
                maxLength={60}
                name="groupName"
                onChange={(e) => setName(e.target.value)}
                value={name}
              />
            </Field>
            <Button disabled={!canRename} type="submit">
              {renameMutation.isPending ? t('common.saving') : t('social.groups.renameAction')}
            </Button>
          </form>

          {/* Members */}
          <div className="flex flex-col gap-2">
            <h4 className="bt-label">{t('social.groups.membersHeading')}</h4>
            {group.members.length === 0 ? (
              <p className="bt-meta">{t('social.groups.membersEmpty')}</p>
            ) : (
              <ul className="bt-band flex flex-col">
                {group.members.map((m) => (
                  <li key={m.id} className="flex items-center gap-3" style={{ padding: '8px 0' }}>
                    <Avatar name={m.username} iconId={m.profileIcon} size="sm" />
                    <span className="bt-soft flex-1 truncate">{m.username}</span>
                    <Button
                      disabled={removeMutation.isPending}
                      onClick={() => removeMutation.mutate(m.id)}
                      size="sm"
                      variant="quiet"
                    >
                      {t('common.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add a friend */}
          <div className="flex flex-col gap-2">
            <h4 className="bt-label">{t('social.groups.addMemberHeading')}</h4>
            <AsyncReadState
              loading={friendsQuery.isLoading}
              error={friendsQuery.error}
              errorLabel={t('social.groups.loadError')}
              onRetry={() => void friendsQuery.refetch()}
            />
            {rosterFull ? (
              <p className="bt-meta">
                {t('social.groups.memberLimitReached', { count: FRIEND_GROUP_MEMBERS_MAX })}
              </p>
            ) : !friendsQuery.isLoading && !friendsQuery.error && candidates.length === 0 ? (
              <p className="bt-meta">{t('social.groups.addMemberNone')}</p>
            ) : !friendsQuery.isLoading && !friendsQuery.error ? (
              <ul className="bt-band flex max-h-48 flex-col overflow-y-auto pr-1">
                {candidates.map((f) => (
                  <li
                    key={f.user.id}
                    className="flex items-center gap-3"
                    style={{ padding: '8px 0' }}
                  >
                    <Avatar name={f.user.username} iconId={f.user.profileIcon} size="sm" />
                    <span className="bt-soft flex-1 truncate">{f.user.username}</span>
                    <Button
                      disabled={addMutation.isPending}
                      onClick={() => addMutation.mutate(f.user.id)}
                      size="sm"
                    >
                      {t('social.groups.add')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {addMutation.isError || removeMutation.isError || renameMutation.isError ? (
            <Alert tone="error">{t('social.groups.mutateError')}</Alert>
          ) : null}

          <div className="bt-t-rule flex justify-end" style={{ paddingTop: 14 }}>
            <Button onClick={() => setConfirmDelete(true)} size="sm" variant="danger">
              {t('social.groups.delete')}
            </Button>
          </div>
        </div>
      ) : null}

      {confirmDelete ? (
        <DeleteGroupDialog
          group={group}
          onConfirm={() => deleteMutation.mutate()}
          onClose={() => (deleteMutation.isPending ? undefined : setConfirmDelete(false))}
          pending={deleteMutation.isPending}
          error={deleteMutation.isError}
        />
      ) : null}
    </li>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

export function FriendGroupsSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['social', 'groups'],
    queryFn: ({ signal }) => listGroups(signal),
    staleTime: GROUPS_STALE_MS,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => createGroup(name),
    onSuccess: () => {
      setNewName('');
      void queryClient.invalidateQueries({ queryKey: ['social', 'groups'] });
    },
  });

  // Same ceiling the server enforces (#1780), read from the contract so the two
  // can't drift: at the cap the inline creator is closed with the reason, not
  // left open to produce a refusal.
  const atGroupLimit = (data?.groups.length ?? 0) >= FRIEND_GROUPS_MAX;

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || atGroupLimit) return;
    createMutation.mutate(trimmed);
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="bt-h2">{t('social.groups.title')}</h2>
        <p className="bt-meta" style={{ marginTop: 2 }}>
          {t('social.groups.subtitle')}
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-end"
      >
        <Field className="flex-1" htmlFor="newGroupName" label={t('social.groups.newLabel')}>
          <Input
            disabled={atGroupLimit}
            id="newGroupName"
            maxLength={60}
            name="newGroupName"
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('social.groups.newPlaceholder')}
            value={newName}
          />
        </Field>
        <Button
          disabled={createMutation.isPending || !newName.trim() || atGroupLimit}
          type="submit"
        >
          {createMutation.isPending ? t('social.groups.creating') : t('social.groups.create')}
        </Button>
      </form>
      {atGroupLimit ? (
        <p className="bt-meta">{t('social.groups.limitReached', { count: FRIEND_GROUPS_MAX })}</p>
      ) : null}
      {createMutation.isError ? <Alert tone="error">{t('social.groups.createError')}</Alert> : null}

      {isLoading ? (
        <SkeletonBlock height={64} />
      ) : isError || !data ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="error">{t('social.groups.loadError')}</Alert>
          <Button onClick={() => void refetch()}>{t('common.retry')}</Button>
        </div>
      ) : data.groups.length === 0 ? (
        <EmptyState
          icon="👥"
          title={t('social.groups.emptyTitle')}
          description={t('social.groups.emptyDescription')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.groups.map((g) => (
            <GroupCard key={g.id} group={g} />
          ))}
        </ul>
      )}
    </section>
  );
}
