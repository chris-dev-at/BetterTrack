import { useCallback, useEffect, useState } from 'react';

import { AI_DAILY_CAP_MAX, AI_DAILY_CAP_MIN } from '@bettertrack/contracts';
import type { AiSettingsResponse, AiTestConnectionResponse } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../format';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner, TextField } from '../components/ui';

/**
 * Admin LLM-settings page (PROJECTPLAN.md §13.5 V5-P12, §16 2026-07-22 — LOCAL
 * AI ONLY). The whole surface is the owner's local Ollama: a plain endpoint URL,
 * a model name, and a per-user daily cap. There is NO cloud provider, NO API
 * token, and no secret input anywhere — by design. A test-connection probe lists
 * the models the endpoint serves (autocomplete for the model field), and a save
 * takes effect on the next request with no redeploy.
 */

interface FormState {
  endpoint: string;
  model: string;
  dailyCap: string;
}

function fromSettings(settings: AiSettingsResponse): FormState {
  return {
    endpoint: settings.endpoint ?? '',
    model: settings.model ?? '',
    dailyCap: String(settings.dailyCap),
  };
}

export function AiSettingsPage() {
  const t = useT();
  const resource = useResource((signal) => api.getAiSettings(signal), []);
  const { loading, error, reload } = resource;

  const [form, setForm] = useState<FormState | null>(null);
  const [settings, setSettings] = useState<AiSettingsResponse | null>(null);
  const [testResult, setTestResult] = useState<AiTestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the form once from the first successful load; re-seeding after a save is
  // done explicitly below so a background reload never clobbers in-progress edits.
  useEffect(() => {
    if (resource.data && form === null) {
      setForm(fromSettings(resource.data));
      setSettings(resource.data);
    }
  }, [resource.data, form]);

  const patch = useCallback((next: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...next } : prev));
    setSaved(false);
  }, []);

  const capNumber = form ? Number(form.dailyCap) : NaN;
  const capValid =
    Number.isInteger(capNumber) && capNumber >= AI_DAILY_CAP_MIN && capNumber <= AI_DAILY_CAP_MAX;

  const test = useCallback(async () => {
    if (!form) return;
    setTesting(true);
    setActionError(null);
    setTestResult(null);
    try {
      // Probe the endpoint currently in the form (before saving), so the admin can
      // verify + pick a model. An empty endpoint tests the stored/effective one.
      const endpoint = form.endpoint.trim() === '' ? undefined : form.endpoint.trim();
      setTestResult(await api.testAiConnection({ endpoint }));
    } catch {
      setActionError(t('admin.ai.testError'));
    } finally {
      setTesting(false);
    }
  }, [form, t]);

  const save = useCallback(async () => {
    if (!form || !capValid) return;
    setSaving(true);
    setActionError(null);
    setSaved(false);
    try {
      const updated = await api.updateAiSettings({
        endpoint: form.endpoint.trim() === '' ? null : form.endpoint.trim(),
        model: form.model.trim() === '' ? null : form.model.trim(),
        dailyCap: capNumber,
      });
      setSettings(updated);
      setForm(fromSettings(updated));
      setSaved(true);
    } catch {
      setActionError(t('admin.ai.saveError'));
    } finally {
      setSaving(false);
    }
  }, [form, capValid, capNumber, t]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('admin.ai.title')} description={t('admin.ai.subtitle')} />

      {loading && !form ? <Spinner label={t('admin.ai.title')} /> : null}
      {error && !form ? (
        <Alert tone="error">
          {t('admin.ai.loadError')}{' '}
          <button className="underline" onClick={reload}>
            {t('admin.ai.retry')}
          </button>
        </Alert>
      ) : null}

      {form ? (
        <div className="flex flex-col gap-6">
          {/* Status */}
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <span className="text-sm font-medium text-neutral-300">
              {t('admin.ai.statusLabel')}
            </span>
            <Badge tone={settings?.configured ? 'green' : 'neutral'}>
              {settings?.configured ? t('admin.ai.configured') : t('admin.ai.notConfigured')}
            </Badge>
            <span className="ml-auto text-xs text-neutral-500">
              {settings?.updatedAt
                ? `${t('admin.ai.lastChanged')}: ${formatDateTime(settings.updatedAt)}`
                : t('admin.ai.neverChanged')}
            </span>
          </div>

          {actionError ? <Alert tone="error">{actionError}</Alert> : null}
          {saved ? <Alert tone="success">{t('admin.ai.savedNotice')}</Alert> : null}

          {/* Provider config */}
          <div className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <p className="text-xs text-neutral-500">{t('admin.ai.localOnlyNote')}</p>

            <TextField
              label={t('admin.ai.endpointLabel')}
              hint={t('admin.ai.endpointHint')}
              name="ai-endpoint"
              type="url"
              inputMode="url"
              placeholder="http://localhost:11434"
              value={form.endpoint}
              onChange={(e) => patch({ endpoint: e.target.value })}
            />

            <div className="flex flex-col gap-1.5">
              <TextField
                label={t('admin.ai.modelLabel')}
                hint={t('admin.ai.modelHint')}
                name="ai-model"
                list="ai-model-options"
                placeholder="llama3.1:8b"
                value={form.model}
                onChange={(e) => patch({ model: e.target.value })}
              />
              <datalist id="ai-model-options">
                {(testResult?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>

            <TextField
              label={t('admin.ai.capLabel')}
              hint={t('admin.ai.capHint')}
              name="ai-daily-cap"
              type="number"
              min={AI_DAILY_CAP_MIN}
              max={AI_DAILY_CAP_MAX}
              step={1}
              value={form.dailyCap}
              onChange={(e) => patch({ dailyCap: e.target.value })}
            />
            {!capValid ? (
              <p className="text-xs text-red-400">
                {t('admin.ai.capInvalid', { min: AI_DAILY_CAP_MIN, max: AI_DAILY_CAP_MAX })}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button variant="secondary" disabled={testing} onClick={test}>
                {testing ? t('admin.ai.testing') : t('admin.ai.testButton')}
              </Button>
              <Button disabled={saving || !capValid} onClick={save}>
                {saving ? t('admin.ai.saving') : t('admin.ai.saveButton')}
              </Button>
            </div>

            {/* Test-connection result */}
            {testResult ? (
              testResult.ok ? (
                <Alert tone="success">
                  {testResult.models.length > 0
                    ? t('admin.ai.testOkModels', { count: testResult.models.length })
                    : t('admin.ai.testOkNoModels')}
                  {testResult.models.length > 0 ? (
                    <span className="mt-1 block font-mono text-xs text-emerald-300/80">
                      {testResult.models.join(', ')}
                    </span>
                  ) : null}
                </Alert>
              ) : (
                <Alert tone="error">
                  {t('admin.ai.testFailed')}
                  {testResult.error ? (
                    <span className="ml-1 font-mono text-xs">({testResult.error})</span>
                  ) : null}
                </Alert>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
