import { useState } from 'react';
import type { FormEvent } from 'react';

import type { AdminInvite, CreateInviteResponse, InviteStatus } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../../lib/format';
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

const STATUS_TONE: Record<InviteStatus, 'amber' | 'green' | 'red' | 'neutral'> = {
  pending: 'amber',
  used: 'green',
  revoked: 'red',
  expired: 'neutral',
};

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

export function InvitesPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreateInviteResponse | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AdminInvite | null>(null);

  const invites = useResource((signal) => api.listInvites(signal), []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const result = await api.createInvite({ email: email.trim() });
      setEmail('');
      setCreated(result);
      invites.reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(invite: AdminInvite) {
    if (busyId !== null) return;
    setRowError(null);
    setBusyId(invite.id);
    try {
      await api.revokeInvite(invite.id);
      invites.reload();
      setRevoking(null);
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invites"
        description="Invite people by email, then share the one-time link."
      />

      <form
        onSubmit={onCreate}
        className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <TextField
            label="Email"
            name="invite-email"
            type="email"
            autoComplete="off"
            placeholder="person@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create invite'}
        </Button>
      </form>
      {formError ? <Alert tone="error">{formError}</Alert> : null}

      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {invites.loading ? (
        <Spinner label="Loading invites…" />
      ) : invites.error ? (
        <Alert tone="error">
          {invites.error}{' '}
          <button className="underline" onClick={invites.reload}>
            Retry
          </button>
        </Alert>
      ) : !invites.data || invites.data.invites.length === 0 ? (
        <EmptyState>No invites yet. Create one above.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-400">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Expires</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {invites.data.invites.map((invite) => (
                <tr key={invite.id} className="hover:bg-neutral-900/50">
                  <td className="px-4 py-3 text-neutral-200">{invite.email}</td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[invite.status]}>{invite.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-neutral-400">{formatDateTime(invite.createdAt)}</td>
                  <td className="px-4 py-3 text-neutral-400">{formatDateTime(invite.expiresAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      {invite.status === 'pending' ? (
                        revoking?.id === invite.id ? (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <span className="text-xs text-neutral-400">
                              {t('admin.confirmations.revokeInvite.prompt', {
                                email: invite.email,
                              })}
                            </span>
                            <Button
                              variant="danger"
                              disabled={busyId === invite.id}
                              onClick={() => void revoke(invite)}
                            >
                              {busyId === invite.id
                                ? t('admin.confirmations.revokeInvite.pending')
                                : t('admin.confirmations.revokeInvite.confirm')}
                            </Button>
                            <Button
                              variant="secondary"
                              disabled={busyId === invite.id}
                              onClick={() => setRevoking(null)}
                            >
                              {t('common.cancel')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="danger"
                            disabled={busyId !== null}
                            onClick={() => setRevoking(invite)}
                          >
                            {t('admin.actions.revoke')}
                          </Button>
                        )
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {created ? <CreatedInviteDialog result={created} onClose={() => setCreated(null)} /> : null}
    </div>
  );
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
        <p className="text-sm text-neutral-400">
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
