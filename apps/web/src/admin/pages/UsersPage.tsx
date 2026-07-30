import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';

import type { AdminStats, CreateUserResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Modal } from '../components/Modal';
import {
  Alert,
  Badge,
  Button,
  CopyField,
  EmptyState,
  PageHeader,
  Spinner,
  TextField,
} from '../components/ui';

type Dialog =
  | { type: 'create' }
  | { type: 'created'; result: CreateUserResponse }
  | { type: 'bulkDisable'; userIds: string[] };

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

/**
 * Slimmed user list (PROJECTPLAN.md §6.12, §13.2): only the essential columns so
 * it remains usable on narrow screens. User details are opened through the
 * primary identity link, while bulk select drives bulk actions.
 */
export function UsersPage() {
  const t = useT();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Debounce the search box so each keystroke doesn't hit the API.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const stats = useResource((signal) => api.getStats(signal), []);
  const users = useResource((signal) => api.listUsers(search || undefined, signal), [search]);

  const rows = useMemo(() => users.data?.users ?? [], [users.data]);
  // Keep the selection in sync with what's actually on screen.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((u) => u.id));
      const next = new Set<string>();
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next;
    });
  }, [rows]);

  const allSelected = rows.length > 0 && rows.every((u) => selected.has(u.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((u) => u.id)));
  }

  async function bulkDisable(userIds: string[]) {
    if (userIds.length === 0 || bulkBusy) return;
    setBanner(null);
    setBulkBusy(true);
    try {
      const result = await api.bulkUserAction({
        action: 'disable',
        userIds,
      });
      users.reload();
      stats.reload();
      setSelected(new Set());
      setDialog(null);
      setBanner({
        tone: 'success',
        text:
          `Disabled ${result.disabled} user${result.disabled === 1 ? '' : 's'}` +
          (result.skipped > 0 ? `; skipped ${result.skipped}.` : '.'),
      });
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <PageHeader title="Users" description="Manage accounts, access, and credentials." />
        <Button onClick={() => setDialog({ type: 'create' })}>Create user</Button>
      </div>

      <StatsStrip data={stats.data} />

      <TextField
        label="Search"
        name="search"
        placeholder="Filter by email or username"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />

      {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
          <span className="text-sm text-neutral-300">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button
              variant="danger"
              disabled={bulkBusy || dialog?.type === 'bulkDisable'}
              onClick={() => {
                setBanner(null);
                setDialog({ type: 'bulkDisable', userIds: [...selected] });
              }}
            >
              {bulkBusy ? t('admin.actions.disabling') : t('admin.actions.disableSelected')}
            </Button>
          </div>
        </div>
      ) : null}

      {users.loading ? (
        <Spinner label="Loading users…" />
      ) : users.error ? (
        <Alert tone="error">
          {users.error}{' '}
          <button className="underline" onClick={users.reload}>
            Retry
          </button>
        </Alert>
      ) : rows.length === 0 ? (
        <EmptyState>
          {search ? 'No users match your search.' : 'No users yet. Create the first one.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all users"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {rows.map((u) => (
                <tr key={u.id} className="hover:bg-neutral-900/50">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${u.username}`}
                      checked={selected.has(u.id)}
                      onChange={() => toggleOne(u.id)}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      to={`/admin/users/${u.id}`}
                      className="block rounded-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                    >
                      <span className="block font-medium">{u.email}</span>
                      <span className="block text-xs text-neutral-500">{u.username}</span>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.role === 'admin' ? 'sky' : 'neutral'}>{u.role}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.type === 'create' && (
        <CreateUserDialog
          onClose={() => setDialog(null)}
          onCreated={(result) => {
            users.reload();
            stats.reload();
            setDialog({ type: 'created', result });
          }}
        />
      )}

      {dialog?.type === 'created' && (
        <CreatedUserDialog result={dialog.result} onClose={() => setDialog(null)} />
      )}

      {dialog?.type === 'bulkDisable' && (
        <Modal
          title={t('admin.confirmations.bulkDisable.title')}
          onClose={() => setDialog(null)}
          dismissable={!bulkBusy}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-400">
              {t(
                dialog.userIds.length === 1
                  ? 'admin.confirmations.bulkDisable.descriptionOne'
                  : 'admin.confirmations.bulkDisable.descriptionOther',
                { count: dialog.userIds.length },
              )}
            </p>
            {banner?.tone === 'error' ? <Alert tone="error">{banner.text}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" disabled={bulkBusy} onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={bulkBusy}
                onClick={() => void bulkDisable(dialog.userIds)}
              >
                {bulkBusy
                  ? t('admin.confirmations.bulkDisable.pending')
                  : t(
                      dialog.userIds.length === 1
                        ? 'admin.confirmations.bulkDisable.confirmOne'
                        : 'admin.confirmations.bulkDisable.confirmOther',
                      { count: dialog.userIds.length },
                    )}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreatedUserDialog({
  result,
  onClose,
}: {
  result: CreateUserResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Modal
      title={t('admin.oneTimeCredentials.temporaryPassword.title')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          {t('admin.oneTimeCredentials.temporaryPassword.description', {
            email: result.user.email,
          })}
        </p>
        <CopyField
          label={t('admin.oneTimeCredentials.temporaryPassword.label')}
          value={result.tempPassword}
          onCopied={() => setAcknowledged(true)}
        />
        <Button
          onClick={() => {
            setAcknowledged(true);
            onClose();
          }}
        >
          {t('common.savedOneTimeSecret')}
        </Button>
      </div>
    </Modal>
  );
}

function StatsStrip({ data }: { data: AdminStats | null }) {
  if (!data) return null;
  const cards = [
    { label: 'Users', value: data.userCount },
    { label: 'Active (≤30d)', value: data.activeUserCount },
    { label: 'Disabled', value: data.disabledUserCount },
    { label: 'Pending invites', value: data.pendingInviteCount },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
        >
          <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
          <div className="mt-1 text-2xl font-semibold text-neutral-100">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreateUserResponse) => void;
}) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.createUser({
        email: email.trim(),
        username: username.trim(),
        role: 'user',
      });
      onCreated(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create user" onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="off"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <TextField
          label="Username"
          name="username"
          autoComplete="off"
          hint="3–40 characters: letters, numbers, dot, dash, underscore."
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create user'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
