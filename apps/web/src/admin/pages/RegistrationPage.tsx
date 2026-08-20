import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';

import type { RegistrationMode, RegistrationToken } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useAdminMutation } from '../useAdminMutation';
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
} from '../components/ui';

const TOKEN_STATUS_TONE: Record<RegistrationToken['status'], 'green' | 'amber' | 'neutral'> = {
  active: 'green',
  exhausted: 'neutral',
  expired: 'neutral',
  revoked: 'amber',
};

const MODE_LABEL_KEY: Record<RegistrationMode, string> = {
  closed: 'admin.settings.registration.modes.closed.title',
  invite_token: 'admin.settings.registration.modes.inviteToken.title',
  approval: 'admin.settings.registration.modes.approval.title',
  open: 'admin.settings.registration.modes.open.title',
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Who gets in (#1406 W1, People workspace).
 *
 * The approval queue and the registration access tokens used to hang off the
 * global-settings page, where they sat beside the beta toggle rather than beside
 * the people they admit. W1's IA moves both here and leaves `/admin/settings`
 * owning the mode switch itself, so this page reads the active mode and links
 * back to it instead of duplicating the selector.
 *
 * Both write paths run through the shared `useAdminMutation` seam.
 */
export function RegistrationPage() {
  const t = useT();
  const settings = useResource((signal) => api.getSettings(signal), []);
  const mode = settings.data?.registrationMode ?? null;
  // A failed settings read is NOT the same as a mode that happens to be off: the
  // sections below must say "we could not tell" rather than "this is inactive",
  // which would read as a deliberate configuration.
  const modeKnown = mode !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('admin.registration.title')}
        description={t('admin.registration.subtitle')}
      />

      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
        <span className="text-sm text-neutral-400">{t('admin.registration.currentMode')}</span>
        {settings.loading && !settings.data ? (
          <Spinner label={t('admin.settings.loading')} />
        ) : settings.error ? (
          <Alert tone="error">
            {settings.error}{' '}
            <button className="underline" onClick={settings.reload}>
              {t('common.retry')}
            </button>
          </Alert>
        ) : mode ? (
          <Badge tone={mode === 'closed' ? 'neutral' : 'sky'}>{t(MODE_LABEL_KEY[mode])}</Badge>
        ) : null}
        <Link
          className="ml-auto text-sm text-sky-400 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          to="/admin/settings"
        >
          {t('admin.registration.changeMode')}
        </Link>
      </section>

      <ApprovalQueueSection active={modeKnown ? mode === 'approval' : 'unknown'} />
      <RegistrationTokensSection active={modeKnown ? mode === 'invite_token' : 'unknown'} />
    </div>
  );
}

/** Whether the surrounding mode gates this section on, off, or is itself unknown. */
type SectionActivity = boolean | 'unknown';

/**
 * The trailing hint after a section description: nothing when the mode is on, an
 * "inactive" note when it is off, and an honest "could not read the mode" note
 * when the settings read failed.
 */
function activityHintKey(active: SectionActivity, inactiveKey: string): string | null {
  if (active === true) return null;
  return active === 'unknown' ? 'admin.registration.modeUnknown' : inactiveKey;
}

/**
 * Approval queue (§13.4 V4-P4a) — pending applications from the approval mode.
 * Approve creates the account (and emails the applicant); reject drops it (and
 * emails the applicant). Either way the row leaves the queue.
 */
function ApprovalQueueSection({ active }: { active: SectionActivity }) {
  const t = useT();
  const requests = useResource((signal) => api.listRegistrationRequests(signal), []);
  const decide = useAdminMutation(
    (id: string, decision: 'approve' | 'reject') =>
      decision === 'approve'
        ? api.approveRegistrationRequest(id)
        : api.rejectRegistrationRequest(id),
    {
      errorKey: 'admin.registration.decideError',
      // A 404 here means this one application is already gone — a colleague or
      // another tab acted first. Banner + reload, never a forced sign-out.
      notFound: 'surface',
      notFoundErrorKey: 'admin.registration.requestGone',
      onSuccess: requests.reload,
    },
  );
  const hintKey = activityHintKey(active, 'admin.settings.approvals.inactive');

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          {t('admin.settings.approvals.title')}
        </h2>
        <p className="text-sm text-neutral-400">
          {t('admin.settings.approvals.description')}
          {hintKey ? ` ${t(hintKey)}` : null}
        </p>
      </div>

      {decide.error ? <Alert tone="error">{decide.error}</Alert> : null}

      {requests.loading && !requests.data ? (
        <Spinner label={t('admin.settings.approvals.loading')} />
      ) : requests.error ? (
        <Alert tone="error">
          {requests.error}{' '}
          <button className="underline" onClick={requests.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : requests.data && requests.data.requests.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {requests.data.requests.map((req) => (
            <li
              key={req.id}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 px-3 py-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm text-neutral-100">{req.username}</span>
                <span className="break-words text-xs text-neutral-400">
                  {req.email} ·{' '}
                  {t('admin.settings.approvals.requested', {
                    date: formatDateTime(req.createdAt),
                  })}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <Button
                  onClick={() => void decide.runFor(req.id, req.id, 'approve')}
                  disabled={decide.isPending(req.id)}
                >
                  {t('admin.settings.approvals.approve')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void decide.runFor(req.id, req.id, 'reject')}
                  disabled={decide.isPending(req.id)}
                >
                  {t('admin.settings.approvals.reject')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>{t('admin.settings.approvals.empty')}</EmptyState>
      )}
    </section>
  );
}

/**
 * Registration access tokens (§13.4 V4-P4a) — admin-issued, hash-only tokens that
 * gate the invite-token mode. Create single- or multi-use tokens with an optional
 * expiry; the register URL is shown once. Revoke kills a token immediately.
 */
function RegistrationTokensSection({ active }: { active: SectionActivity }) {
  const t = useT();
  const tokens = useResource((signal) => api.listRegistrationTokens(signal), []);

  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const create = useAdminMutation(
    async () => {
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
    },
    { errorKey: 'admin.registration.createTokenError', onSuccess: tokens.reload },
  );

  const revoke = useAdminMutation((id: string) => api.revokeRegistrationToken(id), {
    errorKey: 'admin.registration.revokeTokenError',
    // A token that vanished between listing and revoking is already revoked as
    // far as the operator cares — a banner, not a sign-out.
    notFound: 'surface',
    notFoundErrorKey: 'admin.registration.tokenGone',
    onSuccess: () => {
      setRevokingId(null);
      tokens.reload();
    },
  });

  const hintKey = activityHintKey(active, 'admin.settings.tokens.inactive');

  function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreatedUrl(null);
    void create.run();
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">
          {t('admin.settings.tokens.title')}
        </h2>
        <p className="text-sm text-neutral-400">
          {t('admin.settings.tokens.description')}
          {hintKey ? ` ${t(hintKey)}` : null}
        </p>
      </div>

      <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
        <TextField
          label={t('admin.settings.tokens.label')}
          name="token-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('admin.settings.tokens.labelPlaceholder')}
        />
        <TextField
          label={t('admin.settings.tokens.maxUses')}
          name="token-max-uses"
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
        <TextField
          label={t('admin.settings.tokens.expiresInDays')}
          name="token-expires"
          type="number"
          min={1}
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
          placeholder={t('admin.settings.tokens.never')}
        />
        <Button type="submit" disabled={create.pending}>
          {create.pending ? t('common.creating') : t('admin.settings.tokens.create')}
        </Button>
      </form>

      {create.error ? <Alert tone="error">{create.error}</Alert> : null}
      {revoke.error ? <Alert tone="error">{revoke.error}</Alert> : null}
      {createdUrl ? (
        <CopyField label={t('admin.settings.tokens.urlLabel')} value={createdUrl} />
      ) : null}

      {tokens.loading && !tokens.data ? (
        <Spinner label={t('admin.settings.tokens.loading')} />
      ) : tokens.error ? (
        <Alert tone="error">
          {tokens.error}{' '}
          <button className="underline" onClick={tokens.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : tokens.data && tokens.data.tokens.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {tokens.data.tokens.map((token) => (
            <li
              key={token.id}
              className="flex items-center justify-between gap-3 rounded-md border border-neutral-800 px-3 py-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-sm text-neutral-100">
                  <span className="truncate">
                    {token.label ?? t('admin.settings.tokens.untitled')}
                  </span>
                  <Badge tone={TOKEN_STATUS_TONE[token.status]}>
                    {t(`admin.settings.tokens.status.${token.status}`)}
                  </Badge>
                </span>
                <span className="text-xs text-neutral-400">
                  {t('admin.settings.tokens.uses', {
                    used: token.useCount,
                    max: token.maxUses,
                  })}
                  {token.expiresAt
                    ? ` · ${t('admin.settings.tokens.expires', { date: formatDateTime(token.expiresAt) })}`
                    : ` · ${t('admin.settings.tokens.noExpiry')}`}
                </span>
              </span>
              {token.status === 'active' ? (
                revokingId === token.id ? (
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-xs text-neutral-400">
                      {t('admin.confirmations.revokeRegistrationToken.prompt', {
                        name: token.label ?? token.id,
                      })}
                    </span>
                    <Button
                      variant="secondary"
                      disabled={revoke.busy}
                      onClick={() => void revoke.runFor(token.id, token.id)}
                    >
                      {revoke.isPending(token.id)
                        ? t('admin.confirmations.revokeRegistrationToken.pending')
                        : t('admin.confirmations.revokeRegistrationToken.confirm')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={revoke.busy}
                      onClick={() => setRevokingId(null)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={revokingId !== null || revoke.busy}
                    onClick={() => {
                      revoke.clearError();
                      setRevokingId(token.id);
                    }}
                  >
                    {t('admin.actions.revoke')}
                  </Button>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>{t('admin.settings.tokens.empty')}</EmptyState>
      )}
    </section>
  );
}
