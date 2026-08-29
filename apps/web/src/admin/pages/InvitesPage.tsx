import { useState } from 'react';
import type { FormEvent } from 'react';

import type {
  AdminInvite,
  AdminStats,
  CreateInviteResponse,
  InviteStatus,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../../lib/format';
import { useAdminMutation } from '../useAdminMutation';
import { useResource } from '../useResource';
import { Modal } from '../components/Modal';
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
import { EDGE_TOP, TEXT_MUTED, TEXT_NUM } from '../components/tokens';

const STATUS_TONE: Record<InviteStatus, 'amber' | 'green' | 'red' | 'neutral'> = {
  pending: 'amber',
  used: 'green',
  revoked: 'red',
  expired: 'neutral',
};

/**
 * People → Invites (#1406 W2).
 *
 * Per-email, 7-day tokenized invites — distinct from the registration ACCESS
 * TOKENS on the Registration tab, which are not bound to an address and may be
 * multi-use. This page was the console's last untranslated surface; folding it
 * into the People strip meant translating it, so every string here now resolves
 * through the catalog in EN and DE like its neighbours.
 */
export function InvitesPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [created, setCreated] = useState<CreateInviteResponse | null>(null);
  const [revoking, setRevoking] = useState<AdminInvite | null>(null);

  const invites = useResource((signal) => api.listInvites(signal), []);
  const stats = useResource((signal) => api.getStats(signal), []);

  const create = useAdminMutation(
    async (address: string) => {
      const result = await api.createInvite({ email: address });
      setEmail('');
      setCreated(result);
    },
    {
      errorKey: 'admin.invites.createError',
      onSuccess: () => {
        invites.reload();
        stats.reload();
      },
    },
  );

  const revoke = useAdminMutation((id: string) => api.revokeInvite(id), {
    errorKey: 'admin.invites.revokeError',
    // An invite that vanished between listing and revoking is already gone as
    // far as the operator cares — a banner, not a forced sign-out.
    notFound: 'surface',
    notFoundErrorKey: 'admin.invites.gone',
    onSuccess: () => {
      setRevoking(null);
      invites.reload();
      stats.reload();
    },
  });

  const rows = invites.data?.invites ?? [];
  // Decorative counts: absent while the stats read is loading or failed, so a
  // missing number never reads as a confident zero.
  const counts = stats.loading || stats.error !== null ? undefined : tabCounts(stats.data);

  function onCreate(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    void create.run(address);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={t('admin.nav.sections.people')}
        title={t('admin.invites.title')}
        description={t('admin.invites.subtitle')}
      />

      <WorkspaceTabs counts={counts} />

      <Panel padded={false}>
        <PanelHeader
          title={t('admin.invites.create')}
          description={t('admin.invites.createHint')}
        />
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[16rem] flex-1">
            <TextField
              label={t('admin.users.emailLabel')}
              name="invite-email"
              type="email"
              autoComplete="off"
              placeholder={t('admin.invites.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full"
            />
          </div>
          <Button type="submit" size="sm" disabled={create.pending}>
            {create.pending ? t('common.creating') : t('admin.invites.createAction')}
          </Button>
        </form>
        {create.error ? (
          <div className="px-4 pb-4">
            <Alert tone="error">{create.error}</Alert>
          </div>
        ) : null}
      </Panel>

      {revoke.error ? <Alert tone="error">{revoke.error}</Alert> : null}

      <Panel padded={false}>
        <PanelHeader title={t('admin.invites.listTitle')} />
        {invites.loading || invites.error ? (
          <div className="p-4">
            <AsyncReadState
              error={invites.error}
              loading={invites.loading}
              loadingLabel={t('admin.invites.loading')}
              onRetry={invites.reload}
              retryable={invites.retryable}
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState>{t('admin.invites.empty')}</EmptyState>
          </div>
        ) : (
          <DataTable minWidth="44rem">
            <thead className="border-b border-neutral-800">
              <tr>
                <Th>{t('admin.users.emailLabel')}</Th>
                <Th>{t('admin.users.columns.status')}</Th>
                <Th>{t('admin.users.columns.created')}</Th>
                <Th>{t('admin.registration.columns.expires')}</Th>
                <Th className="w-56" />
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {rows.map((invite) => (
                <tr key={invite.id}>
                  <Td className="font-medium text-neutral-100">{invite.email}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[invite.status]}>
                      {t(`admin.invites.status.${invite.status}`)}
                    </Badge>
                  </Td>
                  <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
                    {formatDateTime(invite.createdAt)}
                  </Td>
                  <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
                    {formatDateTime(invite.expiresAt)}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      {invite.status === 'pending' ? (
                        revoking?.id === invite.id ? (
                          <>
                            <span className={TEXT_MUTED}>
                              {t('admin.confirmations.revokeInvite.prompt', {
                                email: invite.email,
                              })}
                            </span>
                            <Button
                              variant="danger"
                              size="sm"
                              disabled={revoke.busy}
                              onClick={() => void revoke.runFor(invite.id, invite.id)}
                            >
                              {revoke.isPending(invite.id)
                                ? t('admin.confirmations.revokeInvite.pending')
                                : t('admin.confirmations.revokeInvite.confirm')}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={revoke.busy}
                              onClick={() => setRevoking(null)}
                            >
                              {t('common.cancel')}
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={revoking !== null || revoke.busy}
                            onClick={() => {
                              revoke.clearError();
                              setRevoking(invite);
                            }}
                          >
                            {t('admin.actions.revoke')}
                          </Button>
                        )
                      ) : (
                        <span className={TEXT_MUTED}>—</span>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <div className={cx('px-4 py-2.5', EDGE_TOP)}>
          <p className={TEXT_MUTED}>{t('admin.invites.ttlNote')}</p>
        </div>
      </Panel>

      {created ? <CreatedInviteDialog result={created} onClose={() => setCreated(null)} /> : null}
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

function CreatedInviteDialog({
  result,
  onClose,
}: {
  result: CreateInviteResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Modal
      title={t('admin.oneTimeCredentials.invite.title')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13px] text-neutral-400">
          {t('admin.oneTimeCredentials.invite.description', {
            email: result.invite.email,
            expiresAt: formatDateTime(result.invite.expiresAt),
          })}
        </p>
        <CopyField
          label={t('admin.oneTimeCredentials.invite.label')}
          value={result.inviteUrl}
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
