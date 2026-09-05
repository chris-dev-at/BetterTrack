import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  ADMIN_USER_NOTE_MAX_LENGTH,
  type AdminUser,
  type AdminUserNoteListResponse,
  type AdminUserAccessResponse,
  type AdminUserSharingResponse,
  type AdminUserSupportResponse,
  type AuditLogEntry,
  type ResetPasswordResponse,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useT, type TranslateFn } from '../../i18n';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
import { formatDateTime } from '../../lib/format';
import { useAdminMutation } from '../useAdminMutation';
import { useResource } from '../useResource';
import { EmailLogTable } from '../components/EmailLogTable';
import { Modal } from '../components/Modal';
import {
  Alert,
  AsyncReadState,
  Badge,
  Button,
  CopyField,
  DataTable,
  EmptyState,
  KeyValueList,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  StatTile,
  TabPanel,
  Tabs,
  Td,
  TextAreaField,
  TextField,
  Th,
  INLINE_LINK,
  cx,
} from '../components/ui';
import { TEXT_MUTED, TEXT_NUM } from '../components/tokens';

/** The subset of `useResource`'s handle the tab components below consume. */
interface ReadHandle<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  retryable: boolean;
  reload: () => void;
}

function errorMessage(err: unknown, t: TranslateFn): string {
  void err;
  return t('common.genericError');
}

type Dialog =
  | { type: 'reset' }
  | { type: 'reset-done'; result: ResetPasswordResponse }
  | { type: 'delete' }
  | { type: 'snapshot'; text: string };

const TAB_KEYS = ['summary', 'access', 'support', 'sharing', 'activity', 'notes'] as const;
type TabKey = (typeof TAB_KEYS)[number];

function isTabKey(value: string | null): value is TabKey {
  return value !== null && (TAB_KEYS as readonly string[]).includes(value);
}

/**
 * People → User 360 (#1406 W2).
 *
 * One account across six tabs, recovered verbatim from the binding decision:
 * Summary / Access / Support / Sharing / Activity / Notes. Each tab is a `?tab=`
 * value so a support conversation can link straight to the evidence.
 *
 * What this page deliberately CANNOT do, because the server deliberately cannot:
 * impersonate, read a vault or a Drive, browse portfolios, download a data
 * export, or revoke a session / key / grant. `disabled` remains the one
 * suspension, and it already kills sessions and bearer credentials as a side
 * effect. Every tab below a read is a read.
 */
export function UserDetailPage() {
  const { userId } = useParams<{ userId: string }>();
  const { user: currentAdmin } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  const [params, setParams] = useSearchParams();

  const tabParam = params.get('tab');
  const tab: TabKey = isTabKey(tabParam) ? tabParam : 'summary';
  const selectTab = useCallback(
    (key: string) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (key === 'summary') next.delete('tab');
          else next.set('tab', key);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The single-user read W2 added. Before it existed this page downloaded the
  // whole account table on every open to find one row.
  const account = useResource((signal) => api.getUser(userId ?? '', signal), [userId]);
  const user = account.data;

  // The Support and Notes counts sit on the tab strip, so they load with the
  // page rather than on first tab click — the strip must not lie by omission.
  const support = useResource((signal) => api.getUserSupport(userId ?? '', signal), [userId]);
  const notes = useResource((signal) => api.listUserNotes(userId ?? '', signal), [userId]);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isSelf = user?.id === currentAdmin?.id;

  async function toggleStatus() {
    if (!user) return;
    setBanner(null);
    setBusy(true);
    try {
      await api.updateUser(user.id, { status: user.status === 'active' ? 'disabled' : 'active' });
      account.reload();
      setBanner({
        tone: 'success',
        text:
          user.status === 'active' ? t('admin.userDetail.disabled') : t('admin.userDetail.enabled'),
      });
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleChatBan() {
    if (!user) return;
    setBanner(null);
    setBusy(true);
    try {
      await api.updateUser(user.id, { chatBanned: !user.chatBanned });
      account.reload();
      setBanner({
        tone: 'success',
        text: user.chatBanned
          ? t('admin.userDetail.chatUnbanned')
          : t('admin.userDetail.chatBanned'),
      });
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err, t) });
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
          ? { tone: 'error', text: t('admin.userDetail.testEmailFailed') }
          : { tone: 'success', text: t('admin.userDetail.testEmailSent', { to: result.to }) },
      );
    } catch (err) {
      setBanner({ tone: 'error', text: errorMessage(err, t) });
    } finally {
      setBusy(false);
    }
  }

  if (account.loading && !user) return <Spinner label={t('admin.userDetail.loading')} />;
  if (account.error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <AsyncReadState
          error={account.error}
          loading={false}
          onRetry={account.reload}
          retryable={account.retryable}
        />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState>{t('admin.userDetail.gone')}</EmptyState>
      </div>
    );
  }

  // The strip's counts are decorative and must not out-run their reads: while
  // either is loading or failed its tab shows no chip, so a missing count is
  // never mistaken for "this account has no support history". The tabs
  // themselves render the full loading/error state when opened.
  const supportCount = support.loading || support.error !== null ? undefined : support.data?.total;
  const noteCount = notes.loading || notes.error !== null ? undefined : notes.data?.notes.length;

  const tabs = [
    { key: 'summary', label: t('admin.userDetail.tabs.summary') },
    { key: 'access', label: t('admin.userDetail.tabs.access') },
    {
      key: 'support',
      label: t('admin.userDetail.tabs.support'),
      ...(supportCount !== undefined ? { count: supportCount } : {}),
    },
    { key: 'sharing', label: t('admin.userDetail.tabs.sharing') },
    { key: 'activity', label: t('admin.userDetail.tabs.activity') },
    {
      key: 'notes',
      label: t('admin.userDetail.tabs.notes'),
      ...(noteCount !== undefined ? { count: noteCount } : {}),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <PageHeader
        eyebrow={t('admin.nav.sections.people')}
        title={user.username}
        description={user.email}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setDialog({ type: 'snapshot', text: supportSnapshot(user, support.data, t) })
              }
            >
              {t('admin.userDetail.actions.snapshot')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setDialog({ type: 'reset' })}
            >
              {t('admin.userDetail.actions.resetPassword')}
            </Button>
            <Button
              variant={user.status === 'active' ? 'danger' : 'secondary'}
              size="sm"
              disabled={busy || isSelf}
              title={isSelf ? t('admin.userDetail.actions.notYourself') : undefined}
              onClick={() => void toggleStatus()}
            >
              {user.status === 'active'
                ? t('admin.userDetail.actions.disable')
                : t('admin.userDetail.actions.enable')}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={user.role === 'admin' ? 'sky' : 'neutral'}>{user.role}</Badge>
        <Badge tone={user.status === 'active' ? 'green' : 'red'}>{user.status}</Badge>
        {user.privacyMode === 'paranoid' ? (
          <Badge tone="amber">{t('admin.users.privacy.paranoid')}</Badge>
        ) : null}
        {user.chatBanned ? <Badge tone="red">{t('admin.users.flags.chatBanned')}</Badge> : null}
        {user.mustChangePassword ? (
          <Badge tone="amber">{t('admin.users.flags.mustChangePassword')}</Badge>
        ) : null}
      </div>

      {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}

      <Tabs
        label={t('admin.userDetail.tabsLabel')}
        tabs={tabs}
        activeKey={tab}
        onSelect={selectTab}
        idPrefix="user360"
      />

      <TabPanel tabKey={tab} idPrefix="user360">
        {tab === 'summary' ? (
          <SummaryTab
            user={user}
            busy={busy}
            isSelf={isSelf}
            onSaved={(text) => {
              account.reload();
              setBanner({ tone: 'success', text });
            }}
            onError={(text) => setBanner({ tone: 'error', text })}
            onChatBan={() => void toggleChatBan()}
            onTestEmail={() => void sendTestEmail()}
            onDelete={() => setDialog({ type: 'delete' })}
          />
        ) : null}
        {tab === 'access' ? <AccessTab userId={user.id} /> : null}
        {tab === 'support' ? <SupportTab resource={support} /> : null}
        {tab === 'sharing' ? <SharingTab userId={user.id} /> : null}
        {tab === 'activity' ? <ActivityTab userId={user.id} email={user.email} /> : null}
        {tab === 'notes' ? <NotesTab userId={user.id} notes={notes} /> : null}
      </TabPanel>

      {dialog?.type === 'reset' && (
        <ResetPasswordDialog
          user={user}
          onClose={() => setDialog(null)}
          onDone={(result) => setDialog({ type: 'reset-done', result })}
        />
      )}
      {dialog?.type === 'reset-done' && (
        <ResetPasswordResultDialog
          user={user}
          result={dialog.result}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === 'delete' && (
        <DeleteUserDialog
          user={user}
          onClose={() => setDialog(null)}
          onDeleted={() => navigate('/admin/users')}
        />
      )}
      {dialog?.type === 'snapshot' && (
        <SnapshotDialog text={dialog.text} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/admin/users" className={cx('text-[12px]', INLINE_LINK)}>
      {t('admin.userDetail.back')}
    </Link>
  );
}

/**
 * The clipboard payload behind "copy support snapshot".
 *
 * Composed entirely from what is already rendered on this page, which is the
 * whole safety argument: it can never contain a holding, a decrypted byte or a
 * Drive identifier, because the page never receives one. For a paranoid account
 * it carries the mode and the opaque vault metadata and stops there — §16
 * (2026-07-21): "admin sees mode/media/blob metadata only".
 */
export function supportSnapshot(
  user: AdminUser,
  support: AdminUserSupportResponse | null,
  t: TranslateFn,
): string {
  // Every label resolves through the catalog. This renders ON SCREEN inside
  // translated modal chrome, so an English `key: value` dump under a German
  // heading is simply incoherent — and the literal-copy AST guard cannot see
  // inside a string builder, which is why `UserDetailPage.test.tsx` asserts
  // directly that no English label survives under DE.
  const field = (key: string) => t(`admin.userDetail.snapshot.fields.${key}`);
  const yesNo = (value: boolean) => (value ? t('common.yes') : t('common.no'));
  const lines = [
    t('admin.userDetail.snapshot.heading'),
    `${field('username')}: ${user.username}`,
    `${field('email')}: ${user.email}`,
    `${field('id')}: ${user.id}`,
    `${field('kind')}: ${user.role}`,
    `${field('state')}: ${user.status}`,
    `${field('mustChangePassword')}: ${yesNo(user.mustChangePassword)}`,
    `${field('chatBanned')}: ${yesNo(user.chatBanned)}`,
    `${field('created')}: ${formatDateTime(user.createdAt)}`,
    `${field('lastLogin')}: ${user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—'}`,
    // The enum VALUES stay verbatim: `paranoid` / `normal` are what the wire and
    // the database say, and a support paste is worth more when it quotes them.
    `${field('privacyMode')}: ${user.privacyMode ?? 'normal'}`,
  ];
  if (user.paranoid) {
    lines.push(
      `${field('vaultMedia')}: ${user.paranoid.mediaSet.join(' + ')}`,
      `${field('vaultVersion')}: ${user.paranoid.vault?.version ?? '—'}`,
      `${field('vaultSize')}: ${user.paranoid.vault ? `${user.paranoid.vault.sizeBytes} B` : '—'}`,
      `${field('vaultUpdated')}: ${
        user.paranoid.vault ? formatDateTime(user.paranoid.vault.updatedAt) : '—'
      }`,
      `${field('vaultHistory')}: ${user.paranoid.historyCount}`,
    );
  }
  if (support) {
    const open = t('admin.userDetail.snapshot.fields.openSuffix', { count: support.openCount });
    lines.push(`${field('supportSubmissions')}: ${support.total} (${open})`);
  }
  return lines.join('\n');
}

// ── Summary ─────────────────────────────────────────────────────────────────

function SummaryTab({
  user,
  busy,
  isSelf,
  onSaved,
  onError,
  onChatBan,
  onTestEmail,
  onDelete,
}: {
  user: AdminUser;
  busy: boolean;
  isSelf: boolean;
  onSaved: (text: string) => void;
  onError: (text: string) => void;
  onChatBan: () => void;
  onTestEmail: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.userDetail.account')}
        </h2>
        <KeyValueList
          rows={[
            { label: t('admin.users.usernameLabel'), value: user.username },
            { label: t('admin.users.emailLabel'), value: user.email },
            { label: t('admin.users.columns.role'), value: user.role },
            { label: t('admin.users.columns.status'), value: user.status },
            {
              label: t('admin.users.flags.mustChangePassword'),
              value: user.mustChangePassword ? t('common.yes') : t('common.no'),
            },
            {
              label: t('admin.users.flags.chatBanned'),
              value: user.chatBanned ? t('common.yes') : t('common.no'),
            },
            { label: t('admin.users.columns.created'), value: formatDateTime(user.createdAt) },
            {
              label: t('admin.users.columns.lastLogin'),
              value: user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—',
            },
          ]}
        />
      </Panel>

      {user.paranoid ? <ParanoidCard user={user} /> : <NormalPrivacyCard />}

      <Panel>
        <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.userDetail.profile')}
        </h2>
        <ProfileSection user={user} onSaved={onSaved} onError={onError} />
      </Panel>

      <Panel>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.userDetail.moreActions')}
        </h2>
        <p className={cx('mb-3', TEXT_MUTED)}>{t('admin.userDetail.moreActionsHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={onChatBan}>
            {user.chatBanned
              ? t('admin.userDetail.actions.chatUnban')
              : t('admin.userDetail.actions.chatBan')}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={onTestEmail}>
            {t('admin.userDetail.actions.testEmail')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={busy || isSelf}
            title={isSelf ? t('admin.userDetail.actions.notYourself') : undefined}
            onClick={onDelete}
          >
            {t('admin.userDetail.actions.delete')}
          </Button>
        </div>
      </Panel>
    </div>
  );
}

/**
 * The paranoid card. Every field on it is already on the wire and none of it
 * says anything about what the account holds: a mode, a media set, an opaque
 * version, a byte count, a timestamp, a history count. There is nothing further
 * to show and no support action that could open it — the key never leaves the
 * user's devices, and the card says so rather than leaving an operator hunting
 * for a button that does not exist.
 */
function ParanoidCard({ user }: { user: AdminUser }) {
  const t = useT();
  const paranoid = user.paranoid;
  if (!paranoid) return null;
  return (
    <Panel className="border-l-[3px] border-l-amber-500">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.userDetail.paranoid.title')}
        </h2>
        <Badge tone="amber">{t('admin.userDetail.paranoid.encrypted')}</Badge>
      </div>
      <KeyValueList
        rows={[
          { label: t('admin.userDetail.paranoid.mode'), value: 'paranoid' },
          { label: t('admin.userDetail.paranoid.media'), value: paranoid.mediaSet.join(' + ') },
          { label: t('admin.userDetail.paranoid.version'), value: paranoid.vault?.version ?? '—' },
          {
            label: t('admin.userDetail.paranoid.size'),
            value: paranoid.vault ? `${paranoid.vault.sizeBytes.toLocaleString()} B` : '—',
          },
          {
            label: t('admin.userDetail.paranoid.updated'),
            value: paranoid.vault ? formatDateTime(paranoid.vault.updatedAt) : '—',
          },
          { label: t('admin.userDetail.paranoid.history'), value: paranoid.historyCount },
        ]}
      />
      <p className={cx('mt-3', TEXT_MUTED)}>{t('admin.userDetail.paranoid.explainer')}</p>
    </Panel>
  );
}

function NormalPrivacyCard() {
  const t = useT();
  return (
    <Panel>
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
        {t('admin.userDetail.paranoid.title')}
      </h2>
      <p className={TEXT_MUTED}>{t('admin.userDetail.paranoid.normal')}</p>
    </Panel>
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
  const t = useT();
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [submitting, setSubmitting] = useState(false);

  // Re-hydrate the fields only when the server-side value actually changes (e.g.
  // after a save reloads the account). Comparing against the last synced value —
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
      onSaved(t('admin.userDetail.profileSaved'));
    } catch (err) {
      onError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <TextField
        label={t('admin.users.usernameLabel')}
        name="username"
        autoComplete="off"
        hint={t('admin.users.usernameHint')}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <TextField
        label={t('admin.users.emailLabel')}
        name="email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!dirty || submitting}>
          {submitting ? t('common.saving') : t('admin.userDetail.saveProfile')}
        </Button>
      </div>
    </form>
  );
}

// ── Access ──────────────────────────────────────────────────────────────────

function AccessTab({ userId }: { userId: string }) {
  const t = useT();
  const access = useResource((signal) => api.getUserAccess(userId, signal), [userId]);

  if (access.loading || access.error || !access.data) {
    return (
      <AsyncReadState
        error={access.error}
        loading={access.loading}
        loadingLabel={t('admin.userDetail.access.loading')}
        onRetry={access.reload}
        retryable={access.retryable}
      />
    );
  }

  const data: AdminUserAccessResponse = access.data;

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('admin.userDetail.access.readOnlyNotice')}</Alert>

      <Panel padded={false}>
        <PanelHeader
          title={t('admin.userDetail.access.sessions')}
          description={t('admin.userDetail.access.sessionsHint')}
        />
        {data.sessions.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t('admin.userDetail.access.noSessions')}</EmptyState>
          </div>
        ) : (
          <DataTable minWidth="36rem">
            <thead className="border-b border-neutral-800">
              <tr>
                <Th>{t('admin.userDetail.access.device')}</Th>
                <Th>{t('admin.userDetail.access.lastSeen')}</Th>
                <Th>{t('admin.userDetail.access.started')}</Th>
                <Th>{t('admin.userDetail.access.persistence')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {data.sessions.map((session) => (
                <tr key={session.id}>
                  <Td className="font-medium text-neutral-100">{session.device}</Td>
                  <Td className={TEXT_NUM}>{formatDateTime(session.lastSeenAt)}</Td>
                  <Td className={TEXT_NUM}>{formatDateTime(session.createdAt)}</Td>
                  <Td>
                    <Badge tone={session.persistent ? 'neutral' : 'sky'}>
                      {session.persistent
                        ? t('admin.userDetail.access.persistent')
                        : t('admin.userDetail.access.ephemeral')}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Panel padded={false}>
        <PanelHeader title={t('admin.userDetail.access.credentials')} />
        {data.apiKeys.length === 0 && data.oauthGrants.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t('admin.userDetail.access.noCredentials')}</EmptyState>
          </div>
        ) : (
          <DataTable minWidth="42rem">
            <thead className="border-b border-neutral-800">
              <tr>
                <Th>{t('admin.userDetail.access.credential')}</Th>
                <Th>{t('admin.userDetail.access.scopes')}</Th>
                <Th>{t('admin.userDetail.access.lastUsed')}</Th>
                <Th>{t('admin.users.columns.status')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {data.apiKeys.map((key) => (
                <tr key={key.id}>
                  <Td className="font-medium text-neutral-100">
                    {t('admin.userDetail.access.apiKey', { name: key.name })}
                  </Td>
                  <Td className={TEXT_MUTED}>{key.scopes.join(', ') || '—'}</Td>
                  <Td className={TEXT_NUM}>
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : '—'}
                  </Td>
                  <Td>
                    <Badge tone={key.revokedAt ? 'red' : 'green'}>
                      {key.revokedAt
                        ? t('admin.userDetail.access.revoked')
                        : t('admin.users.status.active')}
                    </Badge>
                  </Td>
                </tr>
              ))}
              {data.oauthGrants.map((grant) => (
                <tr key={grant.id}>
                  <Td className="font-medium text-neutral-100">
                    {t('admin.userDetail.access.oauthGrant', { name: grant.clientName })}
                    {grant.firstParty ? (
                      <Badge tone="sky">{t('admin.userDetail.access.firstParty')}</Badge>
                    ) : null}
                  </Td>
                  <Td className={TEXT_MUTED}>{grant.scopes.join(', ') || '—'}</Td>
                  <Td className={TEXT_NUM}>
                    {grant.lastUsedAt ? formatDateTime(grant.lastUsedAt) : '—'}
                  </Td>
                  <Td>
                    <Badge tone={grant.revokedAt ? 'red' : 'green'}>
                      {grant.revokedAt
                        ? t('admin.userDetail.access.revoked')
                        : t('admin.users.status.active')}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Panel>
        <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.userDetail.access.identities')}
        </h2>
        {data.identities.length === 0 ? (
          <p className={TEXT_MUTED}>{t('admin.userDetail.access.noIdentities')}</p>
        ) : (
          <KeyValueList
            rows={data.identities.map((identity) => ({
              label: identity.provider,
              value: `${
                identity.emailVerified
                  ? t('admin.userDetail.access.verified')
                  : t('admin.userDetail.access.unverified')
              } · ${formatDateTime(identity.linkedAt)}`,
            }))}
          />
        )}
      </Panel>
    </div>
  );
}

// ── Support ─────────────────────────────────────────────────────────────────

function SupportTab({ resource }: { resource: ReadHandle<AdminUserSupportResponse> }) {
  const t = useT();
  if (resource.loading || resource.error || !resource.data) {
    return (
      <AsyncReadState
        error={resource.error}
        loading={resource.loading}
        loadingLabel={t('admin.userDetail.support.loading')}
        onRetry={resource.reload}
        retryable={resource.retryable}
      />
    );
  }
  const { items, total, openCount } = resource.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label={t('admin.userDetail.support.total')} value={total} />
        <StatTile
          label={t('admin.userDetail.support.open')}
          value={openCount}
          tone={openCount > 0 ? 'amber' : 'neutral'}
        />
      </div>

      {items.length === 0 ? (
        <EmptyState>{t('admin.userDetail.support.empty')}</EmptyState>
      ) : (
        <Panel padded={false}>
          <PanelHeader
            title={t('admin.userDetail.support.submissions')}
            description={t('admin.userDetail.support.bodiesElsewhere')}
            actions={
              <Link to="/admin/support" className={cx('text-[12px]', INLINE_LINK)}>
                {t('admin.userDetail.support.openHelpdesk')}
              </Link>
            }
          />
          <DataTable minWidth="42rem">
            <thead className="border-b border-neutral-800">
              <tr>
                <Th>{t('admin.userDetail.support.subject')}</Th>
                <Th>{t('admin.userDetail.support.category')}</Th>
                <Th>{t('admin.users.columns.status')}</Th>
                <Th>{t('admin.users.columns.created')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {items.map((item) => (
                <tr key={item.id}>
                  <Td className="font-medium text-neutral-100">
                    {item.subject ?? t('admin.userDetail.support.noSubject')}
                    {item.unreadByAdmin ? (
                      <Badge tone="sky">{t('admin.userDetail.support.unread')}</Badge>
                    ) : null}
                    {item.deletedByUser ? (
                      <Badge tone="neutral">{t('admin.userDetail.support.deletedByUser')}</Badge>
                    ) : null}
                    {item.archived ? (
                      <Badge tone="neutral">{t('admin.userDetail.support.archived')}</Badge>
                    ) : null}
                  </Td>
                  <Td className={TEXT_MUTED}>{item.category}</Td>
                  <Td className={TEXT_MUTED}>{item.status}</Td>
                  <Td className={TEXT_NUM}>{formatDateTime(item.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      )}
    </div>
  );
}

// ── Sharing ─────────────────────────────────────────────────────────────────

function SharingTab({ userId }: { userId: string }) {
  const t = useT();
  const sharing = useResource((signal) => api.getUserSharing(userId, signal), [userId]);

  if (sharing.loading || sharing.error || !sharing.data) {
    return (
      <AsyncReadState
        error={sharing.error}
        loading={sharing.loading}
        loadingLabel={t('admin.userDetail.sharing.loading')}
        onRetry={sharing.reload}
        retryable={sharing.retryable}
      />
    );
  }
  const data: AdminUserSharingResponse = sharing.data;

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info">{t('admin.userDetail.sharing.boundary')}</Alert>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatTile label={t('admin.userDetail.sharing.portfolios')} value={data.portfolioCount} />
        <StatTile
          label={t('admin.userDetail.sharing.sharedPortfolios')}
          value={data.sharedPortfolioCount}
          tone={data.sharedPortfolioCount > 0 ? 'sky' : 'neutral'}
        />
        <StatTile
          label={t('admin.userDetail.sharing.audiences')}
          value={data.shareAudienceCount}
          tone={data.shareAudienceCount > 0 ? 'sky' : 'neutral'}
        />
        <StatTile
          label={t('admin.userDetail.sharing.activeLinks')}
          value={data.activeShareLinkCount}
          tone={data.activeShareLinkCount > 0 ? 'amber' : 'neutral'}
          detail={t('admin.userDetail.sharing.revokedLinks', { count: data.revokedShareLinkCount })}
        />
        <StatTile label={t('admin.userDetail.sharing.friends')} value={data.friendCount} />
        <StatTile label={t('admin.userDetail.sharing.followers')} value={data.followerCount} />
        <StatTile label={t('admin.userDetail.sharing.following')} value={data.followingCount} />
      </div>
      <p className={TEXT_MUTED}>{t('admin.userDetail.sharing.inventoryDeferred')}</p>
    </div>
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

function ActivityTab({ userId, email }: { userId: string; email: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <Panel padded={false}>
        <PanelHeader title={t('admin.userDetail.activity.audit')} />
        <div className="p-4">
          <UserAuditLog userId={userId} />
        </div>
      </Panel>
      <Panel padded={false}>
        <PanelHeader title={t('admin.userDetail.activity.email')} />
        <div className="p-4">
          <UserEmailLog userId={userId} email={email} />
        </div>
      </Panel>
    </div>
  );
}

/** One user's email send log, reusing the shared paginated table. */
function UserEmailLog({ userId, email }: { userId: string; email: string }) {
  const t = useT();
  const load = useCallback(
    (params: { cursor?: string }, signal?: AbortSignal) =>
      api.listUserEmails(userId, params, signal),
    [userId],
  );
  return <EmailLogTable load={load} emptyLabel={t('admin.emailLog.emptyForUser', { email })} />;
}

/** Compact per-user audit history, cursor-paged newest-first (§6.12). */
function UserAuditLog({ userId }: { userId: string }) {
  const t = useT();
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
          // Same 401-or-404 rule as `useResource`, and the same reason: on the
          // admin origin this is the V5-P13c window closing, so the login screen
          // names it instead of bouncing silently.
          clearSession('expired');
          return;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return;
        }
        setError('load-failed');
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

  if (loading) return <Spinner label={t('admin.userDetail.activity.loading')} />;
  if (error) return <Alert tone="error">{t('common.genericError')}</Alert>;
  if (entries.length === 0) return <EmptyState>{t('admin.userDetail.activity.empty')}</EmptyState>;

  return (
    <div className="flex flex-col gap-3">
      <DataTable minWidth="36rem">
        <thead className="border-b border-neutral-800">
          <tr>
            <Th>{t('admin.userDetail.activity.when')}</Th>
            <Th>{t('admin.userDetail.activity.action')}</Th>
            <Th>{t('admin.userDetail.activity.details')}</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {entries.map((entry) => (
            <tr key={entry.id}>
              <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
                {formatDateTime(entry.createdAt)}
              </Td>
              <Td className="font-medium text-neutral-200">{entry.action}</Td>
              <Td className="max-w-xs truncate text-neutral-500" title={metaSummary(entry.meta)}>
                {metaSummary(entry.meta)}
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? t('common.loading') : t('admin.userDetail.activity.loadMore')}
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

// ── Notes ───────────────────────────────────────────────────────────────────

/**
 * Operator notes: the one write W2 adds. Admin-private, additive, audited, and
 * never visible to the account they are about.
 */
function NotesTab({
  userId,
  notes,
}: {
  userId: string;
  /**
   * The PAGE-level notes read, passed down rather than re-fetched here: the tab
   * strip already shows its count, so a second request would be the same bytes
   * twice and could leave the strip and the list disagreeing after a write.
   */
  notes: ReadHandle<AdminUserNoteListResponse>;
}) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const reloadAll = useCallback(() => notes.reload(), [notes]);

  const add = useAdminMutation(
    async (body: string) => {
      await api.createUserNote(userId, { body });
      setDraft('');
    },
    {
      // `POST /admin/users/:id/notes` is addressed by the user row, which another
      // admin can delete while this pane is open — a banner, not a sign-out.
      notFound: 'surface',
      errorKey: 'admin.userDetail.notes.addError',
      onSuccess: reloadAll,
    },
  );

  const remove = useAdminMutation((noteId: string) => api.deleteUserNote(userId, noteId), {
    errorKey: 'admin.userDetail.notes.removeError',
    // A note that vanished between listing and deleting is already gone as far
    // as the operator cares — a banner, not a forced sign-out.
    notFound: 'surface',
    notFoundErrorKey: 'admin.userDetail.notes.gone',
    onSuccess: () => {
      setConfirmingId(null);
      reloadAll();
    },
  });

  const trimmed = draft.trim();
  const tooLong = trimmed.length > ADMIN_USER_NOTE_MAX_LENGTH;

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <h2 className="mb-1 text-[12px] font-semibold uppercase tracking-[0.1em] text-neutral-200">
          {t('admin.userDetail.notes.add')}
        </h2>
        <p className={cx('mb-3', TEXT_MUTED)}>{t('admin.userDetail.notes.privacy')}</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0 || tooLong) return;
            void add.run(trimmed);
          }}
        >
          <TextAreaField
            label={t('admin.userDetail.notes.label')}
            hideLabel
            name="note-body"
            rows={3}
            maxLength={ADMIN_USER_NOTE_MAX_LENGTH}
            placeholder={t('admin.userDetail.notes.placeholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          {add.error ? <Alert tone="error">{add.error}</Alert> : null}
          <div className="flex items-center justify-between gap-3">
            <span className={cx(TEXT_MUTED, TEXT_NUM)}>
              {t('admin.userDetail.notes.remaining', {
                count: ADMIN_USER_NOTE_MAX_LENGTH - trimmed.length,
              })}
            </span>
            <Button
              type="submit"
              size="sm"
              disabled={add.pending || trimmed.length === 0 || tooLong}
            >
              {add.pending ? t('common.saving') : t('admin.userDetail.notes.save')}
            </Button>
          </div>
        </form>
      </Panel>

      {remove.error ? <Alert tone="error">{remove.error}</Alert> : null}

      {notes.loading || notes.error ? (
        <AsyncReadState
          error={notes.error}
          loading={notes.loading}
          loadingLabel={t('admin.userDetail.notes.loading')}
          onRetry={notes.reload}
          retryable={notes.retryable}
        />
      ) : !notes.data || notes.data.notes.length === 0 ? (
        <EmptyState>{t('admin.userDetail.notes.empty')}</EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.data.notes.map((note) => (
            <li key={note.id}>
              <Panel className="border-l-[3px] border-l-neutral-700">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[12px] font-semibold text-amber-300">
                    {note.authorUsername ?? t('admin.userDetail.notes.unknownAuthor')}
                  </span>
                  <span className={cx(TEXT_MUTED, TEXT_NUM)}>{formatDateTime(note.createdAt)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-200">
                  {note.body}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  {confirmingId === note.id ? (
                    <>
                      <span className={TEXT_MUTED}>
                        {t('admin.userDetail.notes.confirmRemove')}
                      </span>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={remove.busy}
                        onClick={() => void remove.runFor(note.id, note.id)}
                      >
                        {remove.isPending(note.id)
                          ? t('admin.userDetail.notes.removing')
                          : t('admin.userDetail.notes.confirm')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={remove.busy}
                        onClick={() => setConfirmingId(null)}
                      >
                        {t('common.cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.busy}
                      onClick={() => {
                        remove.clearError();
                        setConfirmingId(note.id);
                      }}
                    >
                      {t('admin.userDetail.notes.remove')}
                    </Button>
                  )}
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

function SnapshotDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const t = useT();
  return (
    <Modal title={t('admin.userDetail.snapshot.title')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-neutral-400">{t('admin.userDetail.snapshot.description')}</p>
        <pre className="max-h-64 overflow-auto border border-neutral-700 bg-neutral-950 p-3 font-mono text-[12px] leading-relaxed text-neutral-200">
          {text}
        </pre>
        <CopyField label={t('admin.userDetail.snapshot.label')} value={text} />
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
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
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setError(null);
    setSubmitting(true);
    try {
      onDone(await api.resetPassword(user.id));
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={t('admin.userDetail.actions.resetPassword')} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-[13px] text-neutral-400">
          {t('admin.userDetail.resetConfirm', { email: user.email })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={submitting} onClick={() => void confirm()}>
            {submitting ? t('common.saving') : t('admin.userDetail.actions.resetPassword')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ResetPasswordResultDialog({
  user,
  result,
  onClose,
}: {
  user: AdminUser;
  result: ResetPasswordResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Modal
      title={t('admin.oneTimeCredentials.temporaryPassword.resetTitle')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-neutral-400">
          {t('admin.oneTimeCredentials.temporaryPassword.description', { email: user.email })}
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

function DeleteUserDialog({
  user,
  onClose,
  onDeleted,
}: {
  user: AdminUser;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
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
      setError(errorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={t('admin.userDetail.deleteTitle')} onClose={onClose}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        <p className="text-[13px] text-neutral-400">
          {t('admin.userDetail.deleteConfirm', { email: user.email, username: user.username })}
        </p>
        <TextField
          label={t('admin.userDetail.confirmUsername')}
          name="confirm-username"
          autoComplete="off"
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" type="submit" disabled={!matches || submitting}>
            {submitting ? t('admin.userDetail.deleting') : t('admin.userDetail.deleteAction')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
