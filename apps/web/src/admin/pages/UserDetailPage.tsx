import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { AdminUser, AuditLogEntry, ResetPasswordResponse } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
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

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

type Dialog =
  | { type: 'reset' }
  | { type: 'reset-done'; result: ResetPasswordResponse }
  | { type: 'delete' };

/**
 * Per-user detail view (PROJECTPLAN.md §6.12, §13.2): the single home for every
 * user action — edit username/email, disable/enable, reset password, send a
 * test email, delete — plus this user's audit and email history.
 */
export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const { user: currentAdmin } = useAuth();
  const navigate = useNavigate();

  // No single-user GET endpoint exists; the list is the source of truth and is
  // small for a self-hosted deployment, so we find the row within it.
  const users = useResource((signal) => api.listUsers(undefined, signal), []);
  const user = users.data?.users.find((u) => u.id === userId) ?? null;

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isSelf = user?.id === currentAdmin?.id;

  async function toggleStatus() {
    if (!user) return;
    setBanner(null);
    setBusy(true);
    try {
      await api.updateUser(user.id, {
        status: user.status === 'active' ? 'disabled' : 'active',
      });
      users.reload();
      setBanner({
        tone: 'success',
        text: user.status === 'active' ? 'User disabled.' : 'User re-enabled.',
      });
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function sendTestEmail() {
    if (!user) return;
    setBanner(null);
    setBusy(true);
    try {
      const result = await api.sendTestEmail({ to: user.email });
      setBanner(
        result.status === 'failed'
          ? { tone: 'error', text: `Test email failed${result.code ? ` (${result.code})` : ''}.` }
          : { tone: 'success', text: `Test email ${result.status} to ${result.to}.` },
      );
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (users.loading) return <Spinner label="Loading user…" />;
  if (users.error) {
    return (
      <Alert tone="error">
        {users.error}{' '}
        <button className="underline" onClick={users.reload}>
          Retry
        </button>
      </Alert>
    );
  }
  if (!user) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState>This user no longer exists.</EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader title={user.username} description={user.email} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={user.role === 'admin' ? 'sky' : 'neutral'}>{user.role}</Badge>
          <Badge tone={user.status === 'active' ? 'green' : 'red'}>{user.status}</Badge>
          {user.mustChangePassword ? <Badge tone="amber">must change password</Badge> : null}
        </div>
      </div>

      {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}

      <ProfileSection
        user={user}
        onSaved={(text) => {
          users.reload();
          setBanner({ tone: 'success', text });
        }}
        onError={(text) => setBanner({ tone: 'error', text })}
      />

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <h2 className="text-sm font-semibold text-neutral-200">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy || isSelf}
            title={isSelf ? 'You cannot disable your own account.' : undefined}
            onClick={() => void toggleStatus()}
          >
            {user.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setDialog({ type: 'reset' })}>
            Reset password
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void sendTestEmail()}>
            Send test email
          </Button>
          <Button
            variant="danger"
            disabled={busy || isSelf}
            title={isSelf ? 'You cannot delete your own account.' : undefined}
            onClick={() => setDialog({ type: 'delete' })}
          >
            Delete
          </Button>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Detail label="Last login" value={formatDateTime(user.lastLoginAt)} />
          <Detail label="Created" value={formatDateTime(user.createdAt)} />
        </dl>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-200">Audit history</h2>
        <UserAuditLog userId={user.id} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-200">Email history</h2>
        <UserEmailLog userId={user.id} email={user.email} />
      </section>

      {dialog?.type === 'reset' && (
        <ResetPasswordDialog
          user={user}
          onClose={() => setDialog(null)}
          onDone={(result) => setDialog({ type: 'reset-done', result })}
        />
      )}

      {dialog?.type === 'reset-done' && (
        <Modal title="Password reset" onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-neutral-400">
              New temporary password for <span className="text-neutral-200">{user.email}</span>.
              Shown only once; the user must change it on next login.
            </p>
            <CopyField label="Temporary password" value={dialog.result.tempPassword} />
            <Button onClick={() => setDialog(null)}>Done</Button>
          </div>
        </Modal>
      )}

      {dialog?.type === 'delete' && (
        <DeleteUserDialog
          user={user}
          onClose={() => setDialog(null)}
          onDeleted={() => navigate('/admin/users')}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/admin/users" className="text-sm text-sky-400 hover:underline">
      ← Back to users
    </Link>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-300">{value}</dd>
    </div>
  );
}

/** Inline edit of username + email; only changed fields are sent (§6.12). */
function ProfileSection({
  user,
  onSaved,
  onError,
}: {
  user: AdminUser;
  onSaved: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [submitting, setSubmitting] = useState(false);

  // Re-hydrate the fields only when the server-side value actually changes (e.g.
  // after a save reloads the list). Comparing against the last synced value —
  // rather than re-setting on every render — means the initial mount and
  // background refetches that return the same data never clobber in-progress
  // edits (the source of the UserDetailPage email-edit flake, #337).
  const lastSynced = useRef({ username: user.username, email: user.email });
  useEffect(() => {
    if (lastSynced.current.username !== user.username) {
      lastSynced.current.username = user.username;
      setUsername(user.username);
    }
    if (lastSynced.current.email !== user.email) {
      lastSynced.current.email = user.email;
      setEmail(user.email);
    }
  }, [user.username, user.email]);

  const dirty = username.trim() !== user.username || email.trim() !== user.email;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    const patch: { username?: string; email?: string } = {};
    if (username.trim() !== user.username) patch.username = username.trim();
    if (email.trim() !== user.email) patch.email = email.trim();
    setSubmitting(true);
    try {
      await api.updateUser(user.id, patch);
      onSaved('Profile updated.');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
    >
      <h2 className="text-sm font-semibold text-neutral-200">Profile</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          label="Username"
          name="username"
          autoComplete="off"
          hint="3–40 characters: letters, numbers, dot, dash, underscore."
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty || submitting}>
          {submitting ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

/** One user's email send log, reusing the shared paginated table. */
function UserEmailLog({ userId, email }: { userId: string; email: string }) {
  const load = useCallback(
    (params: { cursor?: string }, signal?: AbortSignal) =>
      api.listUserEmails(userId, params, signal),
    [userId],
  );
  return <EmailLogTable load={load} emptyLabel={`No emails sent to ${email} yet.`} />;
}

/** Compact per-user audit history, cursor-paged newest-first (§6.12). */
function UserAuditLog({ userId }: { userId: string }) {
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      try {
        const page = await api.listUserAudit(userId, after ? { cursor: after } : {}, signal);
        if (signal?.aborted) return;
        setEntries((prev) => (after ? [...prev, ...page.entries] : page.entries));
        setCursor(page.nextCursor);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.isNotAuthorized) {
          clearSession();
          return;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      }
    },
    [userId, clearSession, requireTwoFactorSetup],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(null, controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    await load(cursor);
    setLoadingMore(false);
  }

  if (loading) return <Spinner label="Loading audit history…" />;
  if (error) return <Alert tone="error">{error}</Alert>;
  if (entries.length === 0) return <EmptyState>No audit entries for this user yet.</EmptyState>;

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {entries.map((entry) => (
              <tr key={entry.id} className="hover:bg-neutral-900/50">
                <td className="whitespace-nowrap px-4 py-3 text-neutral-400">
                  {formatDateTime(entry.createdAt)}
                </td>
                <td className="px-4 py-3 font-medium text-neutral-200">{entry.action}</td>
                <td
                  className="max-w-xs truncate px-4 py-3 text-neutral-500"
                  title={metaSummary(entry.meta)}
                >
                  {metaSummary(entry.meta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div className="flex justify-center">
          <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function metaSummary(meta: unknown): string {
  if (meta === null || meta === undefined) return '—';
  if (typeof meta === 'string') return meta;
  try {
    return JSON.stringify(meta);
  } catch {
    return '—';
  }
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
