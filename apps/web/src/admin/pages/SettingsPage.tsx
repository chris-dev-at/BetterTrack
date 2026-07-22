import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import {
  REGISTRATION_MODES,
  type RegistrationMode,
  type RegistrationToken,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import {
  Alert,
  Badge,
  Button,
  CopyField,
  EmptyState,
  PageHeader,
  Spinner,
  TextField,
  cx,
} from '../components/ui';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface ModeMeta {
  mode: RegistrationMode;
  title: string;
  description: string;
}

/**
 * The four registration modes (PROJECTPLAN.md §6.12, §13.4 V4-P4a), in
 * enforcement order. All four are live: switching the mode takes effect
 * immediately (no restart).
 */
const MODE_META: ModeMeta[] = [
  {
    mode: 'closed',
    title: 'Closed',
    description: 'Only admin-created users and invite links. The default, fully enforced.',
  },
  {
    mode: 'invite_token',
    title: 'Invite / access-token',
    description: 'Self-serve registration page that requires a valid access token (below).',
  },
  {
    mode: 'approval',
    title: 'Approval',
    description: 'Open registration form; accounts wait in the approval queue (below).',
  },
  {
    mode: 'open',
    title: 'Open',
    description: 'Automatic registration — anyone can create an account and sign straight in.',
  },
];

// Guard against a mode being added to the contract without a UI entry here.
if (MODE_META.length !== REGISTRATION_MODES.length) {
  throw new Error('Registration-mode UI is out of sync with the contract enum.');
}

const TOKEN_STATUS_TONE: Record<RegistrationToken['status'], 'green' | 'amber' | 'neutral'> = {
  active: 'green',
  exhausted: 'neutral',
  expired: 'neutral',
  revoked: 'amber',
};

/**
 * Admin global settings (PROJECTPLAN.md §6.12, §8, §13.4 V4-P4a): the
 * registration-mode selector plus the two surfaces the self-serve modes need —
 * registration access tokens (invite-token mode) and the approval queue (approval
 * mode). Reads state via `GET /admin/settings` and persists edits via `PATCH`.
 */
export function SettingsPage() {
  const settings = useResource((signal) => api.getSettings(signal), []);
  const { data } = settings;

  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('closed');
  const [betaMode, setBetaMode] = useState(false);
  // The last-known persisted values, so we can flag unsaved edits without a refetch.
  const [baseline, setBaseline] = useState<{
    registrationMode: RegistrationMode;
    betaMode: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable form from the stored settings once they load.
  useEffect(() => {
    if (!data) return;
    setRegistrationMode(data.registrationMode);
    setBetaMode(data.betaMode);
    setBaseline({ registrationMode: data.registrationMode, betaMode: data.betaMode });
  }, [data]);

  const dirty =
    baseline != null &&
    (registrationMode !== baseline.registrationMode || betaMode !== baseline.betaMode);

  async function onSave() {
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const next = await api.updateSettings({ registrationMode, betaMode });
      setRegistrationMode(next.registrationMode);
      setBetaMode(next.betaMode);
      setBaseline({ registrationMode: next.registrationMode, betaMode: next.betaMode });
      setSaved(true);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Reflect the currently-saved mode (not the unsaved edit) in the section hints.
  const savedMode = baseline?.registrationMode ?? 'closed';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Global app configuration — how accounts come to exist and app-wide feature toggles."
      />

      {settings.loading ? (
        <Spinner label="Loading settings…" />
      ) : settings.error ? (
        <Alert tone="error">
          {settings.error}{' '}
          <button className="underline" onClick={settings.reload}>
            Retry
          </button>
        </Alert>
      ) : (
        <>
          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Registration mode
              </h2>
              <p className="text-sm text-neutral-500">
                How new accounts come to exist. Switching a mode takes effect immediately.
              </p>
            </div>

            <fieldset className="flex flex-col gap-2" aria-label="Registration mode">
              {MODE_META.map((meta) => {
                const selected = registrationMode === meta.mode;
                const inputId = `registration-mode-${meta.mode}`;
                return (
                  <label
                    key={meta.mode}
                    htmlFor={inputId}
                    className={cx(
                      'flex items-start gap-3 rounded-md border px-3 py-3',
                      'cursor-pointer border-neutral-700 hover:border-neutral-600',
                      selected ? 'border-sky-600 bg-sky-950/30' : null,
                    )}
                  >
                    <input
                      id={inputId}
                      type="radio"
                      name="registration-mode"
                      className="mt-1 accent-sky-500"
                      value={meta.mode}
                      checked={selected}
                      onChange={() => setRegistrationMode(meta.mode)}
                    />
                    <span className="flex flex-col gap-1">
                      <span className="text-sm font-medium text-neutral-100">{meta.title}</span>
                      <span className="text-sm text-neutral-500">{meta.description}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            {saveError ? <Alert tone="error">{saveError}</Alert> : null}
            {saved && !dirty ? <Alert tone="success">Settings saved.</Alert> : null}

            <div className="flex items-center gap-3">
              <Button onClick={() => void onSave()} disabled={saving || !dirty}>
                {saving ? 'Saving…' : 'Save settings'}
              </Button>
              {dirty ? <span className="text-sm text-neutral-500">Unsaved changes</span> : null}
            </div>
          </section>

          <RegistrationTokensSection active={savedMode === 'invite_token'} />
          <ApprovalQueueSection active={savedMode === 'approval'} />

          <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
                Feature toggles
              </h2>
              <p className="text-sm text-neutral-500">
                App-wide feature flags and access rules live here. More toggles land post-v1.
              </p>
            </div>

            <label
              htmlFor="beta-mode"
              className="flex items-start justify-between gap-3 rounded-md border border-neutral-700 px-3 py-3"
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-medium text-neutral-100">
                  Beta mode
                  <Badge tone="neutral">Placeholder</Badge>
                </span>
                <span className="text-sm text-neutral-500">
                  Gate experimental surfaces behind a beta flag. No app behaviour depends on it yet.
                </span>
              </span>
              <input
                id="beta-mode"
                type="checkbox"
                className="mt-1 h-4 w-4 accent-sky-500"
                checked={betaMode}
                onChange={(e) => setBetaMode(e.target.checked)}
              />
            </label>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Registration access tokens (§13.4 V4-P4a) — admin-issued, hash-only tokens that
 * gate the invite-token mode. Create single- or multi-use tokens with an optional
 * expiry; the register URL is shown once. Revoke kills a token immediately.
 */
function RegistrationTokensSection({ active }: { active: boolean }) {
  const tokens = useResource((signal) => api.listRegistrationTokens(signal), []);

  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCreatedUrl(null);
    setCreating(true);
    try {
      const uses = Number.parseInt(maxUses, 10);
      const days = expiresInDays.trim() === '' ? undefined : Number.parseInt(expiresInDays, 10);
      const res = await api.createRegistrationToken({
        ...(label.trim() ? { label: label.trim() } : {}),
        maxUses: Number.isFinite(uses) ? uses : 1,
        ...(days !== undefined && Number.isFinite(days) ? { expiresInDays: days } : {}),
      });
      setCreatedUrl(res.registerUrl);
      setLabel('');
      setMaxUses('1');
      setExpiresInDays('');
      tokens.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setError(null);
    try {
      await api.revokeRegistrationToken(id);
      tokens.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Registration tokens
        </h2>
        <p className="text-sm text-neutral-500">
          Access tokens for the invite-token registration mode.
          {active ? null : ' They only take effect while the mode above is Invite / access-token.'}
        </p>
      </div>

      <form
        onSubmit={onCreate}
        className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_12rem_auto] sm:items-end"
      >
        <TextField
          label="Label (optional)"
          name="token-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="beta wave 1"
        />
        <TextField
          label="Max uses"
          name="token-max-uses"
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
        <TextField
          label="Expires in days (optional)"
          name="token-expires"
          type="number"
          min={1}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
          placeholder="never"
        />
        <Button type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'Create token'}
        </Button>
      </form>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {createdUrl ? (
        <CopyField label="Registration URL (copy now — shown once)" value={createdUrl} />
      ) : null}

      {tokens.loading ? (
        <Spinner label="Loading tokens…" />
      ) : tokens.error ? (
        <Alert tone="error">{tokens.error}</Alert>
      ) : tokens.data && tokens.data.tokens.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {tokens.data.tokens.map((token) => (
            <li
              key={token.id}
              className="flex flex-col gap-2 rounded-md border border-neutral-800 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm text-neutral-100">
                  <span className="truncate">{token.label ?? 'Untitled token'}</span>
                  <Badge tone={TOKEN_STATUS_TONE[token.status]}>{token.status}</Badge>
                </span>
                <span className="text-xs text-neutral-500">
                  {token.useCount}/{token.maxUses} uses
                  {token.expiresAt
                    ? ` · expires ${formatDateTime(token.expiresAt)}`
                    : ' · no expiry'}
                </span>
              </span>
              {token.status === 'active' ? (
                <Button
                  variant="secondary"
                  className="self-start sm:self-auto"
                  onClick={() => void onRevoke(token.id)}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No registration tokens yet.</EmptyState>
      )}
    </section>
  );
}

/**
 * Approval queue (§13.4 V4-P4a) — pending applications from the approval mode.
 * Approve creates the account (and emails the applicant); reject drops it (and
 * emails the applicant). Either way the row leaves the queue.
 */
function ApprovalQueueSection({ active }: { active: boolean }) {
  const requests = useResource((signal) => api.listRegistrationRequests(signal), []);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function act(id: string, kind: 'approve' | 'reject') {
    setError(null);
    setBusyId(id);
    try {
      if (kind === 'approve') await api.approveRegistrationRequest(id);
      else await api.rejectRegistrationRequest(id);
      requests.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Approval queue
        </h2>
        <p className="text-sm text-neutral-500">
          Pending self-serve registrations awaiting review.
          {active ? null : ' New applications only arrive while the mode above is Approval.'}
        </p>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      {requests.loading ? (
        <Spinner label="Loading requests…" />
      ) : requests.error ? (
        <Alert tone="error">{requests.error}</Alert>
      ) : requests.data && requests.data.requests.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {requests.data.requests.map((req) => (
            <li
              key={req.id}
              className="flex flex-col gap-2 rounded-md border border-neutral-800 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-neutral-100">{req.username}</span>
                <span className="break-words text-xs text-neutral-500">
                  {req.email} · requested {formatDateTime(req.createdAt)}
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                <Button onClick={() => void act(req.id, 'approve')} disabled={busyId === req.id}>
                  Approve
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void act(req.id, 'reject')}
                  disabled={busyId === req.id}
                >
                  Reject
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>No pending registrations.</EmptyState>
      )}
    </section>
  );
}
