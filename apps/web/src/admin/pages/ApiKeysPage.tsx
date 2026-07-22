import { useState } from 'react';
import type { FormEvent } from 'react';

import type { AdminApiKey, ApiKeyAuditResponse, ApiKeyTier } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../format';
import { useResource } from '../useResource';
import { Modal } from '../components/Modal';
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, TextField } from '../components/ui';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

/**
 * Admin → API keys (§13.5 V5-P10, issue 2/2): the key-governance surface. Two
 * panels — the admin-configurable rate tiers (name/limit/window; exactly one
 * default) and every user's minted key, where an admin (re)assigns a tier and
 * opens the bounded, PII-scrubbed per-key request-log audit trail.
 */
export function ApiKeysPage() {
  const tiers = useResource((signal) => api.listApiKeyTiers(signal), []);
  const keys = useResource((signal) => api.listAdminApiKeys(signal), []);

  return (
    <div className="space-y-8">
      <PageHeader
        title="API keys"
        description="Configure per-key rate tiers and review each key's usage."
      />
      <TiersPanel
        tiers={tiers.data?.tiers ?? []}
        loading={tiers.loading}
        error={tiers.error}
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
        onChanged={() => keys.reload()}
      />
    </div>
  );
}

function TiersPanel({
  tiers,
  loading,
  error,
  onChanged,
}: {
  tiers: ApiKeyTier[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}) {
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
      setFormError('Enter a name, limit and window.');
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
      setFormError(errorMessage(err));
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
      setRowError(errorMessage(err));
    }
  }

  async function remove(tier: ApiKeyTier) {
    setRowError(null);
    try {
      await api.deleteApiKeyTier(tier.id);
      onChanged();
    } catch (err) {
      setRowError(errorMessage(err));
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Rate tiers</h2>
      <p className="text-sm text-slate-500">
        A tier is a request allowance (limit) per window. Unassigned keys use the default tier.
      </p>
      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {loading ? (
        <Spinner label="Loading tiers…" />
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : tiers.length === 0 ? (
        <EmptyState>No tiers defined yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Limit</th>
                <th className="py-2 pr-3">Window (s)</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier) => (
                <tr key={tier.id} className="border-t border-slate-200/60">
                  <td className="py-2 pr-3">
                    {tier.name} {tier.isDefault ? <Badge tone="sky">Default</Badge> : null}
                  </td>
                  <td className="py-2 pr-3">{tier.requestLimit}</td>
                  <td className="py-2 pr-3">{tier.windowSec}</td>
                  <td className="py-2 text-right">
                    {!tier.isDefault ? (
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        <Button variant="ghost" onClick={() => void makeDefault(tier)}>
                          Make default
                        </Button>
                        <Button variant="ghost" onClick={() => void remove(tier)}>
                          Delete
                        </Button>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_auto_auto] sm:items-end"
        onSubmit={onCreate}
      >
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          label="Limit"
          type="number"
          min={1}
          value={requestLimit}
          onChange={(e) => setRequestLimit(e.target.value)}
        />
        <TextField
          label="Window (s)"
          type="number"
          min={1}
          value={windowSec}
          onChange={(e) => setWindowSec(e.target.value)}
        />
        <label className="flex items-center gap-2 py-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-5 w-5"
          />
          Default
        </label>
        <Button type="submit" disabled={busy}>
          Add tier
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
  onChanged,
}: {
  keys: AdminApiKey[];
  tiers: ApiKeyTier[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}) {
  const [rowError, setRowError] = useState<string | null>(null);
  const [auditKey, setAuditKey] = useState<AdminApiKey | null>(null);

  async function assign(key: AdminApiKey, tierId: string) {
    setRowError(null);
    try {
      await api.assignApiKeyTier(key.id, tierId === '' ? null : tierId);
      onChanged();
    } catch (err) {
      setRowError(errorMessage(err));
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Keys</h2>
      {rowError ? <Alert tone="error">{rowError}</Alert> : null}
      {loading ? (
        <Spinner label="Loading keys…" />
      ) : error ? (
        <Alert tone="error">{error}</Alert>
      ) : keys.length === 0 ? (
        <EmptyState>No API keys have been created yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Owner</th>
                <th className="py-2 pr-3">Tier</th>
                <th className="py-2 pr-3">Last used</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-t border-slate-200/60">
                  <td className="py-2 pr-3">
                    {key.name} {key.revokedAt ? <Badge tone="amber">Revoked</Badge> : null}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{key.userId}</td>
                  <td className="py-2 pr-3">
                    <select
                      className="rounded border border-slate-300 bg-transparent px-2 py-1 text-sm"
                      value={key.tierId ?? ''}
                      onChange={(e) => void assign(key, e.target.value)}
                      disabled={Boolean(key.revokedAt)}
                      aria-label={`Tier for ${key.name}`}
                    >
                      <option value="">Default</option>
                      {tiers.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    {key.lastUsedAt ? formatDateTime(key.lastUsedAt) : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <Button variant="ghost" onClick={() => setAuditKey(key)}>
                      View audit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {auditKey ? <AuditModal apiKey={auditKey} onClose={() => setAuditKey(null)} /> : null}
    </section>
  );
}

function AuditModal({ apiKey, onClose }: { apiKey: AdminApiKey; onClose: () => void }) {
  const audit = useResource<ApiKeyAuditResponse>(
    (signal) => api.getApiKeyAudit(apiKey.id, signal),
    [apiKey.id],
  );

  return (
    <Modal title={`Request log — ${apiKey.name}`} onClose={onClose}>
      {audit.loading ? (
        <Spinner label="Loading audit…" />
      ) : audit.error ? (
        <Alert tone="error">{audit.error}</Alert>
      ) : !audit.data || audit.data.entries.length === 0 ? (
        <EmptyState>No recorded requests yet.</EmptyState>
      ) : (
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-2 pr-3">When</th>
                <th className="py-2 pr-3">Method</th>
                <th className="py-2 pr-3">Path</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.entries.map((entry) => (
                <tr key={entry.id} className="border-t border-slate-200/60">
                  <td className="whitespace-nowrap py-2 pr-3">{formatDateTime(entry.createdAt)}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{entry.method}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{entry.path}</td>
                  <td className="py-2">{entry.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
