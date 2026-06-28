import { useState } from 'react';
import type { FormEvent } from 'react';

import type { TestEmailResponse } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner, TextField } from '../components/ui';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

/**
 * Email channel diagnostics (PROJECTPLAN.md §6.12, §6.11). Shows whether the
 * SMTP channel is wired and lets an admin fire a throwaway test email to confirm
 * delivery — the account flows (invite / temp-password / welcome) ride the same
 * channel, so a green result here means those work too.
 */
export function EmailPage() {
  const status = useResource((signal) => api.getEmailStatus(signal), []);
  const [to, setTo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<TestEmailResponse | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const res = await api.sendTestEmail({ to: to.trim() || undefined });
      setResult(res);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Email"
        description="Check the SMTP channel and send a test message to confirm delivery."
      />

      <div className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <span className="text-sm text-neutral-400">Channel status</span>
        {status.loading ? (
          <Spinner label="Checking…" />
        ) : status.error ? (
          <Alert tone="error">{status.error}</Alert>
        ) : status.data?.enabled ? (
          <Badge tone="green">Enabled</Badge>
        ) : (
          <Badge tone="neutral">Disabled</Badge>
        )}
      </div>

      {status.data && !status.data.enabled ? (
        <Alert tone="info">
          The email channel is off. Set <code>SMTP_HOST</code> and <code>SMTP_FROM</code> (plus the
          rest of the SMTP env) and restart the API to enable it. A test sent while off is reported
          as skipped — nothing leaves the server.
        </Alert>
      ) : null}

      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4 sm:flex-row sm:items-end"
      >
        <div className="flex-1">
          <TextField
            label="Send test email to"
            name="test-email-to"
            type="email"
            autoComplete="off"
            placeholder="you@example.com"
            hint="Leave blank to send to your own account email."
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send test email'}
        </Button>
      </form>

      {formError ? <Alert tone="error">{formError}</Alert> : null}

      {result?.status === 'sent' ? (
        <Alert tone="success">Test email sent to {result.to}.</Alert>
      ) : null}
      {result?.status === 'skipped' ? (
        <Alert tone="info">
          Nothing was sent — the email channel is disabled. Configure SMTP to enable delivery.
        </Alert>
      ) : null}
      {result?.status === 'failed' ? (
        <Alert tone="error">
          Sending failed{result.code ? ` (${result.code})` : ''}. Check the SMTP configuration and
          try again.
        </Alert>
      ) : null}
    </div>
  );
}
