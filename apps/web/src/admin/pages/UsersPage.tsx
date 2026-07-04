import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import type {
  AdminStats,
  AdminUser,
  CreateUserResponse,
  ResetPasswordResponse,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useAuth } from '../AuthContext';
import { formatDateTime } from '../format';
import { useResource } from '../useResource';
import { EmailLogTable } from '../components/EmailLogTable';
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
  | { type: 'reset'; user: AdminUser }
  | { type: 'reset-done'; user: AdminUser; result: ResetPasswordResponse }
  | { type: 'delete'; user: AdminUser }
  | { type: 'emails'; user: AdminUser };

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

export function UsersPage() {
  const { user: currentAdmin } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Debounce the search box so each keystroke doesn't hit the API.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  const stats = useResource((signal) => api.getStats(signal), []);
  const users = useResource((signal) => api.listUsers(search || undefined, signal), [search]);

  async function toggleStatus(target: AdminUser) {
    setRowError(null);
    setBusyId(target.id);
    try {
      await api.updateUser(target.id, {
        status: target.status === 'active' ? 'disabled' : 'active',
      });
      users.reload();
      stats.reload();
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusyId(null);
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

      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {users.loading ? (
        <Spinner label="Loading users…" />
      ) : users.error ? (
        <Alert tone="error">
          {users.error}{' '}
          <button className="underline" onClick={users.reload}>
            Retry
          </button>
        </Alert>
      ) : !users.data || users.data.users.length === 0 ? (
        <EmptyState>
          {search ? 'No users match your search.' : 'No users yet. Create the first one.'}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Username</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Last login</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {users.data.users.map((u) => {
                const isSelf = u.id === currentAdmin?.id;
                const busy = busyId === u.id;
                return (
                  <tr key={u.id} className="hover:bg-neutral-900/50">
                    <td className="px-4 py-3 text-neutral-200">{u.email}</td>
                    <td className="px-4 py-3 text-neutral-400">{u.username}</td>
                    <td className="px-4 py-3">
                      <Badge tone={u.role === 'admin' ? 'sky' : 'neutral'}>{u.role}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-neutral-400">{formatDateTime(u.lastLoginAt)}</td>
                    <td className="px-4 py-3 text-neutral-400">{formatDateTime(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          disabled={busy || isSelf}
                          title={isSelf ? 'You cannot disable your own account.' : undefined}
                          onClick={() => void toggleStatus(u)}
                        >
                          {u.status === 'active' ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setDialog({ type: 'reset', user: u })}
                        >
                          Reset password
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setDialog({ type: 'emails', user: u })}
                        >
                          Emails
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy || isSelf}
                          title={isSelf ? 'You cannot delete your own account.' : undefined}
                          onClick={() => setDialog({ type: 'delete', user: u })}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
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
        <Modal title="User created" onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-400">
              Share this temporary password with{' '}
              <span className="text-neutral-200">{dialog.result.user.email}</span>. It is shown only
              once and the user must change it on first login.
            </p>
            <CopyField label="Temporary password" value={dialog.result.tempPassword} />
            <Button onClick={() => setDialog(null)}>Done</Button>
          </div>
        </Modal>
      )}

      {dialog?.type === 'reset' && (
        <ResetPasswordDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDone={(result) => setDialog({ type: 'reset-done', user: dialog.user, result })}
        />
      )}

      {dialog?.type === 'reset-done' && (
        <Modal title="Password reset" onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-400">
              New temporary password for{' '}
              <span className="text-neutral-200">{dialog.user.email}</span>. Shown only once; the
              user must change it on next login.
            </p>
            <CopyField label="Temporary password" value={dialog.result.tempPassword} />
            <Button onClick={() => setDialog(null)}>Done</Button>
          </div>
        </Modal>
      )}

      {dialog?.type === 'emails' && (
        <UserEmailsDialog user={dialog.user} onClose={() => setDialog(null)} />
      )}

      {dialog?.type === 'delete' && (
        <DeleteUserDialog
          user={dialog.user}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            users.reload();
            stats.reload();
            setDialog(null);
          }}
        />
      )}
    </div>
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

/** Per-user email send log (PROJECTPLAN.md §6.10, §6.12). */
function UserEmailsDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const load = useCallback(
    (params: { cursor?: string }, signal?: AbortSignal) =>
      api.listUserEmails(user.id, params, signal),
    [user.id],
  );
  return (
    <Modal title={`Emails to ${user.username}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-400">
          Every send attempt to <span className="text-neutral-200">{user.email}</span>. No bodies or
          secrets are stored.
        </p>
        <EmailLogTable load={load} emptyLabel="No emails sent to this user yet." />
      </div>
    </Modal>
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

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: (result: ResetPasswordResponse) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setError(null);
    setSubmitting(true);
    try {
      onDone(await api.resetPassword(user.id));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Reset password" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm text-neutral-400">
          Generate a new temporary password for{' '}
          <span className="text-neutral-200">{user.email}</span>? Their current password stops
          working immediately.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={submitting} onClick={() => void confirm()}>
            {submitting ? 'Resetting…' : 'Reset password'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteUserDialog({
  user,
  onClose,
  onDeleted,
}: {
  user: AdminUser;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const matches = confirmText === user.username;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.deleteUser(user.id, confirmText);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Delete user" onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-sm text-neutral-400">
          This permanently deletes <span className="text-neutral-200">{user.email}</span> and all of
          their data. This cannot be undone. Type the username{' '}
          <code className="rounded bg-neutral-950 px-1 py-0.5 font-mono text-neutral-200">
            {user.username}
          </code>{' '}
          to confirm.
        </p>
        <TextField
          label="Confirm username"
          name="confirm-username"
          autoComplete="off"
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" disabled={!matches || submitting}>
            {submitting ? 'Deleting…' : 'Delete user'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
