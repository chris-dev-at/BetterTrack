import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import {
  REGISTRATION_MODES,
  type AdminStats,
  type AppSettingsResponse,
  type RegistrationMode,
  type RegistrationToken,
} from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../../lib/format';
import { useAdminMutation } from '../useAdminMutation';
import { useResource } from '../useResource';
import { ListPagination, useOffsetSnapBack } from '../components/ListPagination';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import {
  Alert,
  AsyncReadState,
  Badge,
  Button,
  CopyField,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  PanelHeader,
  Td,
  TextField,
  Th,
  cx,
} from '../components/ui';
import { EDGE_TOP, TEXT_MICRO, TEXT_MUTED, TEXT_NUM } from '../components/tokens';

const TOKEN_STATUS_TONE: Record<RegistrationToken['status'], 'green' | 'amber' | 'neutral'> = {
  active: 'green',
  exhausted: 'neutral',
  expired: 'neutral',
  revoked: 'amber',
};

/** The subset of `useResource`'s handle the sections below consume. */
interface ReadHandle<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  retryable: boolean;
  reload: () => void;
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
function modeMeta(t: TranslateFn): ModeMeta[] {
  return [
    {
      mode: 'closed',
      title: t('admin.settings.registration.modes.closed.title'),
      description: t('admin.settings.registration.modes.closed.description'),
    },
    {
      mode: 'invite_token',
      title: t('admin.settings.registration.modes.inviteToken.title'),
      description: t('admin.settings.registration.modes.inviteToken.description'),
    },
    {
      mode: 'approval',
      title: t('admin.settings.registration.modes.approval.title'),
      description: t('admin.settings.registration.modes.approval.description'),
    },
    {
      mode: 'open',
      title: t('admin.settings.registration.modes.open.title'),
      description: t('admin.settings.registration.modes.open.description'),
    },
  ];
}

/**
 * People → Registration (#1406 W1, completed by W2).
 *
 * W1 moved the approval queue and the access tokens here off `/admin/settings`
 * and left the mode selector behind, with links in both directions. W2 finishes
 * the regrouping per the Chief's ruling of 2026-08-29: the selector lives HERE,
 * beside the queue, and `/admin/settings` no longer owns it. "Which door is
 * open" and "who is knocking" are one question, and splitting them across two
 * workspaces was precisely the discombobulation the owner named.
 */
export function RegistrationPage() {
  const t = useT();
  const settings = useResource((signal) => api.getSettings(signal), []);
  const stats = useResource((signal) => api.getStats(signal), []);
  // A failed settings read is NOT the same as a mode that happens to be off: the
  // sections below must say "we could not tell" rather than "this is inactive",
  // which would read as a deliberate configuration. Reading `loading` and
  // `error` here — not only inside the section — is what makes that distinction
  // exist at all.
  const modeSettled = !settings.loading && settings.error === null;
  const mode = modeSettled ? (settings.data?.registrationMode ?? null) : null;
  const modeKnown = mode !== null;

  // Counts are decorative: while the stats read is in flight or has failed the
  // strip renders no chips at all, so a missing number can never be mistaken for
  // a confident zero ("nothing is waiting for a decision").
  const counts = stats.loading || stats.error !== null ? undefined : tabCounts(stats.data);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={t('admin.nav.sections.people')}
        title={t('admin.registration.title')}
        description={t('admin.registration.subtitle')}
      />

      <WorkspaceTabs counts={counts} />

      <RegistrationModeSection resource={settings} />
      <ApprovalQueueSection
        active={modeKnown ? mode === 'approval' : 'unknown'}
        onDecided={stats.reload}
      />
      <RegistrationTokensSection active={modeKnown ? mode === 'invite_token' : 'unknown'} />
    </div>
  );
}

function tabCounts(stats: AdminStats | null): Record<string, number> | undefined {
  if (!stats) return undefined;
  return {
    '/admin/users': stats.userCount,
    '/admin/registration': stats.pendingRegistrationCount,
    '/admin/invites': stats.pendingInviteCount,
  };
}

/**
 * The registration-mode selector, in its new home (Chief ruling, 2026-08-29).
 *
 * Saving is explicit rather than save-on-click: flipping the front door of the
 * product open is not something an operator should be able to do by brushing a
 * radio button, and the unsaved-changes marker makes the pending state visible.
 */
function RegistrationModeSection({ resource }: { resource: ReadHandle<AppSettingsResponse> }) {
  const t = useT();
  const modes = modeMeta(t);

  if (modes.length !== REGISTRATION_MODES.length) {
    throw new Error('Registration-mode UI is out of sync with the contract enum.');
  }

  const { data } = resource;
  const [selected, setSelected] = useState<RegistrationMode>('closed');
  const [baseline, setBaseline] = useState<RegistrationMode | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setSelected(data.registrationMode);
    setBaseline(data.registrationMode);
  }, [data]);

  const save = useAdminMutation(
    async (next: RegistrationMode) => {
      const result = await api.updateSettings({ registrationMode: next });
      setSelected(result.registrationMode);
      setBaseline(result.registrationMode);
      setSaved(true);
    },
    {
      errorKey: 'admin.registration.modeSaveError',
      // Same `PATCH /admin/settings` route as SettingsPage: no row id, so a 404
      // is the closed admin session, not a missing setting (V5-P13c).
      notFound: 'session',
    },
  );

  const dirty = baseline !== null && selected !== baseline;

  return (
    <Panel padded={false}>
      <PanelHeader
        title={t('admin.settings.registration.title')}
        description={t('admin.registration.modeAppliesImmediately')}
      />
      <div className="p-4">
        {resource.loading && !data ? (
          <AsyncReadState
            error={resource.error}
            loading={resource.loading}
            loadingLabel={t('admin.settings.loading')}
            onRetry={resource.reload}
            retryable={resource.retryable}
          />
        ) : resource.error ? (
          <AsyncReadState
            error={resource.error}
            loading={false}
            onRetry={resource.reload}
            retryable={resource.retryable}
          />
        ) : (
          <>
            <fieldset
              className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4"
              aria-label={t('admin.settings.registration.title')}
            >
              {modes.map((meta) => {
                const active = selected === meta.mode;
                const inputId = `registration-mode-${meta.mode}`;
                return (
                  <label
                    key={meta.mode}
                    htmlFor={inputId}
                    className={cx(
                      'flex cursor-pointer flex-col gap-1.5 border px-3 py-2.5 transition-colors',
                      active
                        ? 'border-sky-600 bg-sky-950/30'
                        : 'border-neutral-800 bg-neutral-950 hover:border-neutral-600',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        id={inputId}
                        type="radio"
                        name="registration-mode"
                        className="accent-sky-500"
                        value={meta.mode}
                        checked={active}
                        onChange={() => setSelected(meta.mode)}
                      />
                      <span className="text-[13px] font-semibold text-neutral-100">
                        {meta.title}
                      </span>
                    </span>
                    <span className={TEXT_MUTED}>{meta.description}</span>
                  </label>
                );
              })}
            </fieldset>

            {save.error ? (
              <div className="mt-3">
                <Alert tone="error">{save.error}</Alert>
              </div>
            ) : null}
            {saved && !dirty ? (
              <div className="mt-3">
                <Alert tone="success">{t('admin.settings.saved')}</Alert>
              </div>
            ) : null}

            <div className="mt-3 flex items-center gap-3">
              <Button
                size="sm"
                disabled={save.pending || !dirty}
                onClick={() => {
                  setSaved(false);
                  void save.run(selected);
                }}
              >
                {save.pending ? t('common.saving') : t('admin.settings.save')}
              </Button>
              {dirty ? <span className={TEXT_MICRO}>{t('admin.settings.unsaved')}</span> : null}
            </div>
          </>
        )}
      </div>
    </Panel>
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
function ApprovalQueueSection({
  active,
  onDecided,
}: {
  active: SectionActivity;
  onDecided: () => void;
}) {
  const t = useT();
  // Bounded read (#1814): the queue used to arrive whole, however long it was.
  const [offset, setOffset] = useState(0);
  const requests = useResource(
    (signal) => api.listRegistrationRequests({ offset }, signal),
    [offset],
  );
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
      onSuccess: () => {
        requests.reload();
        onDecided();
      },
    },
  );
  const hintKey = activityHintKey(active, 'admin.settings.approvals.inactive');
  const rows = requests.data?.requests ?? [];
  const page = requests.data?.page ?? null;
  // Deciding the only application on page 2 empties that window (#1848).
  useOffsetSnapBack(page, rows.length, setOffset);

  return (
    <Panel padded={false}>
      <PanelHeader
        title={t('admin.settings.approvals.title')}
        description={`${t('admin.settings.approvals.description')}${hintKey ? ` ${t(hintKey)}` : ''}`}
        // The badge counts the QUEUE, not the page (#1848): 60 pending under a
        // page of 25 read "25" directly above a footer saying "1–25 of 60".
        actions={page && page.total > 0 ? <Badge tone="sky">{page.total}</Badge> : undefined}
      />

      {decide.error ? (
        <div className="px-4 pt-3">
          <Alert tone="error">{decide.error}</Alert>
        </div>
      ) : null}

      {requests.loading || requests.error ? (
        <div className="p-4">
          <AsyncReadState
            error={requests.error}
            loading={requests.loading}
            loadingLabel={t('admin.settings.approvals.loading')}
            onRetry={requests.reload}
            retryable={requests.retryable}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState>{t('admin.settings.approvals.empty')}</EmptyState>
        </div>
      ) : (
        <DataTable minWidth="40rem">
          <thead className="border-b border-neutral-800">
            <tr>
              <Th>{t('admin.registration.columns.applicant')}</Th>
              <Th>{t('admin.registration.columns.applied')}</Th>
              <Th>{t('admin.registration.columns.via')}</Th>
              <Th className="w-48" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((req) => (
              <tr key={req.id}>
                <Td>
                  <span className="block font-medium text-neutral-100">{req.username}</span>
                  <span className="block text-[12px] text-neutral-500">{req.email}</span>
                </Td>
                <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
                  {formatDateTime(req.createdAt)}
                </Td>
                <Td>
                  {/* `provider` is now on the wire (#1406 W2) — before it was
                      stored but never exposed, so an operator could not tell a
                      Google applicant from a password one. */}
                  <Badge tone={req.provider ? 'sky' : 'neutral'}>
                    {req.provider ?? t('admin.registration.viaPassword')}
                  </Badge>
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      onClick={() => void decide.runFor(req.id, req.id, 'approve')}
                      disabled={decide.isPending(req.id)}
                    >
                      {t('admin.settings.approvals.approve')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void decide.runFor(req.id, req.id, 'reject')}
                      disabled={decide.isPending(req.id)}
                    >
                      {t('admin.settings.approvals.reject')}
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <ListPagination page={page} rowCount={rows.length} onOffset={setOffset} />
      <div className={cx('px-4 py-2.5', EDGE_TOP)}>
        <p className={TEXT_MUTED}>{t('admin.registration.decisionEffect')}</p>
      </div>
    </Panel>
  );
}

/**
 * Registration access tokens (§13.4 V4-P4a) — admin-issued, hash-only tokens that
 * gate the invite-token mode. Create single- or multi-use tokens with an optional
 * expiry; the register URL is shown once. Revoke kills a token immediately.
 */
function RegistrationTokensSection({ active }: { active: SectionActivity }) {
  const t = useT();
  // Bounded read (#1814): exhausted and revoked tokens are never pruned.
  const [offset, setOffset] = useState(0);
  const tokens = useResource((signal) => api.listRegistrationTokens({ offset }, signal), [offset]);

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
      // The new token is the newest row, so page 1 is where it will be.
      setOffset(0);
      setLabel('');
      setMaxUses('1');
      setExpiresInDays('');
    },
    {
      errorKey: 'admin.registration.createTokenError',
      // `POST /admin/registration-tokens` mints a row rather than addressing one,
      // so nothing here can be "already gone" — a 404 is auth loss.
      notFound: 'session',
      onSuccess: tokens.reload,
    },
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
  const rows = tokens.data?.tokens ?? [];
  const page = tokens.data?.page ?? null;
  // Revoking the last token on a page empties that window (#1848).
  useOffsetSnapBack(page, rows.length, setOffset);

  function onCreate(event: FormEvent) {
    event.preventDefault();
    setCreatedUrl(null);
    void create.run();
  }

  return (
    <Panel padded={false}>
      <PanelHeader
        title={t('admin.settings.tokens.title')}
        description={`${t('admin.settings.tokens.description')}${hintKey ? ` ${t(hintKey)}` : ''}`}
      />

      <form
        onSubmit={onCreate}
        className="flex flex-wrap items-end gap-3 border-b border-neutral-800 p-4"
      >
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
          className="w-24"
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
        />
        <TextField
          label={t('admin.settings.tokens.expiresInDays')}
          name="token-expires"
          type="number"
          min={1}
          className="w-32"
          value={expiresInDays}
          onChange={(e) => setExpiresInDays(e.target.value)}
          placeholder={t('admin.settings.tokens.never')}
        />
        <Button type="submit" size="sm" disabled={create.pending}>
          {create.pending ? t('common.creating') : t('admin.settings.tokens.create')}
        </Button>
      </form>

      {create.error || revoke.error || createdUrl ? (
        <div className="flex flex-col gap-3 border-b border-neutral-800 p-4">
          {create.error ? <Alert tone="error">{create.error}</Alert> : null}
          {revoke.error ? <Alert tone="error">{revoke.error}</Alert> : null}
          {createdUrl ? (
            <CopyField label={t('admin.settings.tokens.urlLabel')} value={createdUrl} />
          ) : null}
        </div>
      ) : null}

      {tokens.loading || tokens.error ? (
        <div className="p-4">
          <AsyncReadState
            error={tokens.error}
            loading={tokens.loading}
            loadingLabel={t('admin.settings.tokens.loading')}
            onRetry={tokens.reload}
            retryable={tokens.retryable}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState>{t('admin.settings.tokens.empty')}</EmptyState>
        </div>
      ) : (
        <DataTable minWidth="44rem">
          <thead className="border-b border-neutral-800">
            <tr>
              <Th>{t('admin.settings.tokens.label')}</Th>
              <Th>{t('admin.users.columns.status')}</Th>
              <Th>{t('admin.registration.columns.uses')}</Th>
              <Th>{t('admin.registration.columns.expires')}</Th>
              <Th className="w-56" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((token) => (
              <tr key={token.id}>
                <Td className="font-medium text-neutral-100">
                  {token.label ?? t('admin.settings.tokens.untitled')}
                </Td>
                <Td>
                  <Badge tone={TOKEN_STATUS_TONE[token.status]}>
                    {t(`admin.settings.tokens.status.${token.status}`)}
                  </Badge>
                </Td>
                <Td className={TEXT_NUM}>
                  {token.useCount} / {token.maxUses}
                </Td>
                <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
                  {token.expiresAt
                    ? formatDateTime(token.expiresAt)
                    : t('admin.settings.tokens.noExpiry')}
                </Td>
                <Td>
                  <div className="flex justify-end gap-2">
                    {token.status === 'active' ? (
                      revokingId === token.id ? (
                        <>
                          <span className={TEXT_MUTED}>
                            {t('admin.confirmations.revokeRegistrationToken.prompt', {
                              name: token.label ?? token.id,
                            })}
                          </span>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={revoke.busy}
                            onClick={() => void revoke.runFor(token.id, token.id)}
                          >
                            {revoke.isPending(token.id)
                              ? t('admin.confirmations.revokeRegistrationToken.pending')
                              : t('admin.confirmations.revokeRegistrationToken.confirm')}
                          </Button>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={revoke.busy}
                            onClick={() => setRevokingId(null)}
                          >
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
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
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <ListPagination page={page} rowCount={rows.length} onOffset={setOffset} />
      <div className={cx('px-4 py-2.5', EDGE_TOP)}>
        <p className={TEXT_MUTED}>{t('admin.registration.tokenUrlOnce')}</p>
      </div>
    </Panel>
  );
}
