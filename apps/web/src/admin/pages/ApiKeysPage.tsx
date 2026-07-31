import { useState } from 'react';
import type { FormEvent } from 'react';

import type { AdminApiKey, ApiKeyAuditResponse, ApiKeyTier } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../../lib/format';
import { useResource } from '../useResource';
import { Modal } from '../components/Modal';
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, TextField } from '../components/ui';

function errorMessage(err: unknown, t: TranslateFn): string {
  return err instanceof ApiError ? err.message : t('common.genericError');
}

/**
 * Admin → API keys (§13.5 V5-P10, issue 2/2): the key-governance surface. Two
 * panels — the admin-configurable rate tiers (name/limit/window; exactly one
 * default) and every user's minted key, where an admin (re)assigns a tier and
 * opens the bounded, PII-scrubbed per-key request-log audit trail.
 */
export function ApiKeysPage() {
  const t = useT();
  const tiers = useResource((signal) => api.listApiKeyTiers(signal), []);
  const keys = useResource((signal) => api.listAdminApiKeys(signal), []);

  return (
    <div className="space-y-8">
      <PageHeader title={t('admin.apiKeys.title')} description={t('admin.apiKeys.subtitle')} />
      <TiersPanel
        tiers={tiers.data?.tiers ?? []}
        loading={tiers.loading}
        error={tiers.error}
        onRetry={tiers.reload}
        onChanged={() => {
          tiers.reload();
          keys.reload();
        }}
      />
      <KeysPanel
        keys={keys.data?.keys ?? []}
        tiers={tiers.data?.tiers ?? []}
        loading={keys.loading}
        error={keys.error}
        onRetry={keys.reload}
        onChanged={() => keys.reload()}
      />
    </div>
  );
}

function TiersPanel({
  tiers,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  tiers: ApiKeyTier[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [requestLimit, setRequestLimit] = useState('120');
  const [windowSec, setWindowSec] = useState('60');
  const [isDefault, setIsDefault] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const limit = Number(requestLimit);
    const window = Number(windowSec);
    if (!name.trim() || !Number.isFinite(limit) || !Number.isFinite(window)) {
      setFormError(t('admin.apiKeys.validation'));
      return;
    }
    setBusy(true);
    try {
      await api.createApiKeyTier({
        name: name.trim(),
        requestLimit: limit,
        windowSec: window,
        isDefault,
      });
      setName('');
      setRequestLimit('120');
      setWindowSec('60');
      setIsDefault(false);
      onChanged();
    } catch (err) {
      setFormError(errorMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(tier: ApiKeyTier) {
    setRowError(null);
    try {
      await api.updateApiKeyTier(tier.id, { isDefault: true });
      onChanged();
    } catch (err) {
      setRowError(errorMessage(err, t));
    }
  }

  async function remove(tier: ApiKeyTier) {
    setRowError(null);
    try {
      await api.deleteApiKeyTier(tier.id);
      onChanged();
    } catch (err) {
      setRowError(errorMessage(err, t));
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t('admin.apiKeys.rateTiers.title')}</h2>
      <p className="text-sm text-slate-500">{t('admin.apiKeys.rateTiers.description')}</p>
      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {loading ? (
        <Spinner label={t('admin.apiKeys.rateTiers.loading')} />
      ) : error ? (
        <Alert tone="error">
          {error}{' '}
          <button className="underline" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : tiers.length === 0 ? (
        <EmptyState>{t('admin.apiKeys.rateTiers.empty')}</EmptyState>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-2">{t('admin.apiKeys.rateTiers.name')}</th>
              <th className="py-2">{t('admin.apiKeys.rateTiers.limit')}</th>
              <th className="py-2">{t('admin.apiKeys.rateTiers.window')}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.id} className="border-t border-slate-200/60">
                <td className="py-2">
                  {tier.name}{' '}
                  {tier.isDefault ? (
                    <Badge tone="sky">{t('admin.apiKeys.rateTiers.default')}</Badge>
                  ) : null}
                </td>
                <td className="py-2">{tier.requestLimit}</td>
                <td className="py-2">{tier.windowSec}</td>
                <td className="py-2 text-right">
                  {!tier.isDefault ? (
                    <span className="inline-flex gap-2">
                      <Button variant="ghost" onClick={() => void makeDefault(tier)}>
                        {t('admin.apiKeys.rateTiers.makeDefault')}
                      </Button>
                      <Button variant="ghost" onClick={() => void remove(tier)}>
                        {t('common.delete')}
                      </Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="flex flex-wrap items-end gap-3" onSubmit={onCreate}>
        <TextField
          label={t('admin.apiKeys.rateTiers.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={t('admin.apiKeys.rateTiers.limit')}
          type="number"
          min={1}
          value={requestLimit}
          onChange={(e) => setRequestLimit(e.target.value)}
        />
        <TextField
          label={t('admin.apiKeys.rateTiers.window')}
          type="number"
          min={1}
          value={windowSec}
          onChange={(e) => setWindowSec(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          {t('admin.apiKeys.rateTiers.default')}
        </label>
        <Button type="submit" disabled={busy}>
          {t('admin.apiKeys.rateTiers.add')}
        </Button>
      </form>
      {formError ? <Alert tone="error">{formError}</Alert> : null}
    </section>
  );
}

function KeysPanel({
  keys,
  tiers,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  keys: AdminApiKey[];
  tiers: ApiKeyTier[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [rowError, setRowError] = useState<string | null>(null);
  const [auditKey, setAuditKey] = useState<AdminApiKey | null>(null);

  async function assign(key: AdminApiKey, tierId: string) {
    setRowError(null);
    try {
      await api.assignApiKeyTier(key.id, tierId === '' ? null : tierId);
      onChanged();
    } catch (err) {
      setRowError(errorMessage(err, t));
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t('admin.apiKeys.keys.title')}</h2>
      {rowError ? <Alert tone="error">{rowError}</Alert> : null}
      {loading ? (
        <Spinner label={t('admin.apiKeys.keys.loading')} />
      ) : error ? (
        <Alert tone="error">
          {error}{' '}
          <button className="underline" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : keys.length === 0 ? (
        <EmptyState>{t('admin.apiKeys.keys.empty')}</EmptyState>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-2">{t('admin.apiKeys.keys.name')}</th>
              <th className="py-2">{t('admin.apiKeys.keys.owner')}</th>
              <th className="py-2">{t('admin.apiKeys.keys.tier')}</th>
              <th className="py-2">{t('admin.apiKeys.keys.lastUsed')}</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-t border-slate-200/60">
                <td className="py-2">
                  {key.name}{' '}
                  {key.revokedAt ? (
                    <Badge tone="amber">{t('admin.apiKeys.keys.revoked')}</Badge>
                  ) : null}
                </td>
                <td className="py-2 font-mono text-xs">{key.userId}</td>
                <td className="py-2">
                  <select
                    className="rounded border border-slate-300 bg-transparent px-2 py-1 text-sm"
                    value={key.tierId ?? ''}
                    onChange={(e) => void assign(key, e.target.value)}
                    disabled={Boolean(key.revokedAt)}
                    aria-label={t('admin.apiKeys.keys.tierAria', { name: key.name })}
                  >
                    <option value="">{t('admin.apiKeys.keys.defaultTier')}</option>
                    {tiers.map((tier) => (
                      <option key={tier.id} value={tier.id}>
                        {tier.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-2">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : '—'}</td>
                <td className="py-2 text-right">
                  <Button variant="ghost" onClick={() => setAuditKey(key)}>
                    {t('admin.apiKeys.keys.viewAudit')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {auditKey ? <AuditModal apiKey={auditKey} onClose={() => setAuditKey(null)} /> : null}
    </section>
  );
}

function AuditModal({ apiKey, onClose }: { apiKey: AdminApiKey; onClose: () => void }) {
  const t = useT();
  const audit = useResource<ApiKeyAuditResponse>(
    (signal) => api.getApiKeyAudit(apiKey.id, signal),
    [apiKey.id],
  );

  return (
    <Modal title={t('admin.apiKeys.audit.title', { name: apiKey.name })} onClose={onClose}>
      {audit.loading ? (
        <Spinner label={t('admin.apiKeys.audit.loading')} />
      ) : audit.error ? (
        <Alert tone="error">
          {audit.error}{' '}
          <button className="underline" onClick={audit.reload}>
            {t('common.retry')}
          </button>
        </Alert>
      ) : !audit.data || audit.data.entries.length === 0 ? (
        <EmptyState>{t('admin.apiKeys.audit.empty')}</EmptyState>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-2">{t('admin.apiKeys.audit.when')}</th>
              <th className="py-2">{t('admin.apiKeys.audit.method')}</th>
              <th className="py-2">{t('admin.apiKeys.audit.path')}</th>
              <th className="py-2">{t('admin.apiKeys.audit.status')}</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.entries.map((entry) => (
              <tr key={entry.id} className="border-t border-slate-200/60">
                <td className="py-2">{formatDateTime(entry.createdAt)}</td>
                <td className="py-2 font-mono text-xs">{entry.method}</td>
                <td className="py-2 font-mono text-xs">{entry.path}</td>
                <td className="py-2">{entry.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
