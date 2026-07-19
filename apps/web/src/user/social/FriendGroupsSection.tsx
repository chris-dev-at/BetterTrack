import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';

import type { FriendGroup } from '@bettertrack/contracts';

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
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, TextField, cx } from '../components/ui';
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
  return (
    <Dialog title={t('social.groups.deleteTitle', { name: group.name })} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">{t('social.groups.deleteWarning')}</p>
        {error ? <Alert tone="error">{t('social.groups.deleteError')}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={pending}
            className="bg-red-700 hover:bg-red-600 disabled:bg-red-900"
          >
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

  return (
    <li className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-neutral-100">{group.name}</span>
          <span className="truncate text-xs text-neutral-500">
            {t('social.groups.memberCount', { count: group.memberCount })}
          </span>
        </span>
        <svg
          className={cx(
            'h-4 w-4 shrink-0 text-neutral-500 transition-transform',
            open && 'rotate-90',
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-neutral-800 p-4">
          {/* Rename */}
          <form
            className="flex items-end gap-2"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (canRename) renameMutation.mutate(trimmed);
            }}
          >
            <div className="flex-1">
              <TextField
                label={t('social.groups.nameLabel')}
                name="groupName"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
            </div>
            <Button type="submit" variant="secondary" disabled={!canRename}>
              {renameMutation.isPending ? t('common.saving') : t('social.groups.renameAction')}
            </Button>
          </form>

          {/* Members */}
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {t('social.groups.membersHeading')}
            </h4>
            {group.members.length === 0 ? (
              <p className="text-sm text-neutral-500">{t('social.groups.membersEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {group.members.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-center gap-3 rounded-lg border border-neutral-800 px-3 py-2"
                  >
                    <Avatar name={m.username} iconId={m.profileIcon} size="sm" />
                    <span className="flex-1 truncate text-sm text-neutral-200">{m.username}</span>
                    <Button
                      variant="secondary"
                      onClick={() => removeMutation.mutate(m.id)}
                      disabled={removeMutation.isPending}
                      className="text-red-300 hover:text-red-200"
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
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {t('social.groups.addMemberHeading')}
            </h4>
            {candidates.length === 0 ? (
              <p className="text-sm text-neutral-500">{t('social.groups.addMemberNone')}</p>
            ) : (
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
                {candidates.map((f) => (
                  <li
                    key={f.user.id}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-neutral-800"
                  >
                    <Avatar name={f.user.username} iconId={f.user.profileIcon} size="sm" />
                    <span className="flex-1 truncate text-sm text-neutral-200">
                      {f.user.username}
                    </span>
                    <Button
                      variant="secondary"
                      onClick={() => addMutation.mutate(f.user.id)}
                      disabled={addMutation.isPending}
                    >
                      {t('social.groups.add')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {addMutation.isError || removeMutation.isError || renameMutation.isError ? (
            <Alert tone="error">{t('social.groups.mutateError')}</Alert>
          ) : null}

          <div className="flex justify-end border-t border-neutral-800 pt-3">
            <Button
              variant="secondary"
              onClick={() => setConfirmDelete(true)}
              className="text-red-300 hover:text-red-200"
            >
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

  const { data, isLoading, isError } = useQuery({
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

  function handleCreate(e: FormEvent) {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {t('social.groups.title')}
        </h2>
        <p className="mt-1 text-sm text-neutral-500">{t('social.groups.subtitle')}</p>
      </div>

      <form onSubmit={handleCreate} className="flex items-end gap-2">
        <div className="flex-1">
          <TextField
            label={t('social.groups.newLabel')}
            name="newGroupName"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('social.groups.newPlaceholder')}
            maxLength={60}
          />
        </div>
        <Button type="submit" disabled={createMutation.isPending || !newName.trim()}>
          {createMutation.isPending ? t('social.groups.creating') : t('social.groups.create')}
        </Button>
      </form>
      {createMutation.isError ? <Alert tone="error">{t('social.groups.createError')}</Alert> : null}

      {isLoading ? (
        <Skeleton height="h-16" />
      ) : isError || !data ? (
        <Alert tone="error">{t('social.groups.loadError')}</Alert>
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
