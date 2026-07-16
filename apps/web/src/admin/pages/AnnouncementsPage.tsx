import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import {
  ANNOUNCEMENT_SEVERITIES,
  type Announcement,
  type AnnouncementSeverity,
  type UpdateAnnouncementRequest,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../format';
import { useResource } from '../useResource';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  PageHeader,
  Spinner,
  TextField,
  cx,
} from '../components/ui';

/**
 * Admin composer for announcements (§13.4 V4-P5b): EN + DE title/body,
 * severity, active window (start + end, both optional), plus the active toggle
 * the admin flips independently to publish. Delivery is banner + inbox — the
 * fan-out inserts one inbox row per user via the shared eventKey (idempotent).
 * Delete cascades per-user dismissals away.
 *
 * The user-facing chrome (banner "Dismiss" label) is a distinct SPA surface —
 * the composer's own strings stay in EN (admin-only surface, mirrors the other
 * admin pages).
 */

const SEVERITY_TONE: Record<AnnouncementSeverity, 'neutral' | 'amber' | 'red'> = {
  info: 'neutral',
  warning: 'amber',
  critical: 'red',
};

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}

/** ISO string → the `YYYY-MM-DDTHH:mm` value <input type=datetime-local> wants. */
function toInputDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert the datetime-local widget's local string back to a UTC ISO string. */
function fromInputDateTime(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

interface ComposerState {
  id: string | null;
  severity: AnnouncementSeverity;
  titleEn: string;
  bodyEn: string;
  titleDe: string;
  bodyDe: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

const EMPTY_COMPOSER: ComposerState = {
  id: null,
  severity: 'info',
  titleEn: '',
  bodyEn: '',
  titleDe: '',
  bodyDe: '',
  startsAt: '',
  endsAt: '',
  active: false,
};

function fromAnnouncement(row: Announcement): ComposerState {
  return {
    id: row.id,
    severity: row.severity,
    titleEn: row.titleEn,
    bodyEn: row.bodyEn,
    titleDe: row.titleDe,
    bodyDe: row.bodyDe,
    startsAt: toInputDateTime(row.startsAt),
    endsAt: toInputDateTime(row.endsAt),
    active: row.active,
  };
}

export function AnnouncementsPage() {
  const announcements = useResource((signal) => api.listAnnouncements(signal), []);
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  function resetComposer() {
    setComposer(EMPTY_COMPOSER);
    setFormError(null);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const startsAt = fromInputDateTime(composer.startsAt);
      const endsAt = fromInputDateTime(composer.endsAt);
      if (composer.id) {
        // Edit — always send the full known body; refine skips fields as needed.
        const patch: UpdateAnnouncementRequest = {
          severity: composer.severity,
          titleEn: composer.titleEn.trim(),
          bodyEn: composer.bodyEn.trim(),
          titleDe: composer.titleDe.trim(),
          bodyDe: composer.bodyDe.trim(),
          startsAt,
          endsAt,
          active: composer.active,
        };
        await api.updateAnnouncement(composer.id, patch);
        setSaved('Announcement updated.');
      } else {
        await api.createAnnouncement({
          severity: composer.severity,
          titleEn: composer.titleEn.trim(),
          bodyEn: composer.bodyEn.trim(),
          titleDe: composer.titleDe.trim(),
          bodyDe: composer.bodyDe.trim(),
          startsAt: startsAt ?? undefined,
          endsAt: endsAt ?? undefined,
          active: composer.active,
        });
        setSaved(composer.active ? 'Announcement created and published.' : 'Announcement created.');
      }
      resetComposer();
      announcements.reload();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(row: Announcement) {
    setRowError(null);
    setBusyId(row.id);
    try {
      await api.updateAnnouncement(row.id, { active: !row.active });
      announcements.reload();
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function removeAnnouncement(row: Announcement) {
    setRowError(null);
    setBusyId(row.id);
    try {
      await api.deleteAnnouncement(row.id);
      announcements.reload();
      // If the composer was editing this row, clear it too.
      if (composer.id === row.id) resetComposer();
    } catch (err) {
      setRowError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Announcements"
        description="Compose in-app announcements. EN and DE are both required — each user sees the version matching their language. Active announcements appear as a dismissible banner AND land in the notification inbox once per user."
      />

      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-900 p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium text-neutral-300" htmlFor="severity">
            Severity
          </label>
          <select
            id="severity"
            className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
            value={composer.severity}
            onChange={(e) =>
              setComposer({ ...composer, severity: e.target.value as AnnouncementSeverity })
            }
          >
            {ANNOUNCEMENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              className="h-4 w-4 accent-sky-600"
              checked={composer.active}
              onChange={(e) => setComposer({ ...composer, active: e.target.checked })}
            />
            Active (publishes to every user on save)
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <TextField
              label="English title"
              name="titleEn"
              value={composer.titleEn}
              onChange={(e) => setComposer({ ...composer, titleEn: e.target.value })}
              required
              maxLength={120}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-neutral-300" htmlFor="bodyEn">
                English body
              </label>
              <textarea
                id="bodyEn"
                className="min-h-[7rem] rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
                value={composer.bodyEn}
                onChange={(e) => setComposer({ ...composer, bodyEn: e.target.value })}
                maxLength={2000}
                required
              />
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <TextField
              label="German title"
              name="titleDe"
              value={composer.titleDe}
              onChange={(e) => setComposer({ ...composer, titleDe: e.target.value })}
              required
              maxLength={120}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-neutral-300" htmlFor="bodyDe">
                German body
              </label>
              <textarea
                id="bodyDe"
                className="min-h-[7rem] rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-sky-500"
                value={composer.bodyDe}
                onChange={(e) => setComposer({ ...composer, bodyDe: e.target.value })}
                maxLength={2000}
                required
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-300" htmlFor="startsAt">
              Starts at (optional)
            </label>
            <input
              id="startsAt"
              type="datetime-local"
              className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
              value={composer.startsAt}
              onChange={(e) => setComposer({ ...composer, startsAt: e.target.value })}
            />
            <p className="text-xs text-neutral-500">Empty = start immediately (once active).</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-300" htmlFor="endsAt">
              Ends at (optional)
            </label>
            <input
              id="endsAt"
              type="datetime-local"
              className="rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100 ring-1 ring-inset ring-neutral-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
              value={composer.endsAt}
              onChange={(e) => setComposer({ ...composer, endsAt: e.target.value })}
            />
            <p className="text-xs text-neutral-500">Empty = no auto-off.</p>
          </div>
        </div>

        {formError ? <Alert tone="error">{formError}</Alert> : null}
        {saved ? <Alert tone="success">{saved}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting
              ? composer.id
                ? 'Saving…'
                : 'Creating…'
              : composer.id
                ? 'Save changes'
                : 'Create announcement'}
          </Button>
          {composer.id ? (
            <Button type="button" variant="ghost" onClick={resetComposer} disabled={submitting}>
              Cancel edit
            </Button>
          ) : null}
        </div>
      </form>

      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {announcements.loading ? (
        <Spinner label="Loading announcements…" />
      ) : announcements.error ? (
        <Alert tone="error">
          {announcements.error}{' '}
          <button className="underline" onClick={announcements.reload}>
            Retry
          </button>
        </Alert>
      ) : !announcements.data || announcements.data.announcements.length === 0 ? (
        <EmptyState>No announcements yet. Compose one above.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-800">
          <table className="w-full min-w-[50rem] text-left text-sm">
            <thead className="bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="px-4 py-3 font-medium">Severity</th>
                <th className="px-4 py-3 font-medium">Title (EN)</th>
                <th className="px-4 py-3 font-medium">Window</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {announcements.data.announcements.map((row) => (
                <tr
                  key={row.id}
                  className={cx(
                    'hover:bg-neutral-900/50',
                    composer.id === row.id ? 'bg-neutral-900/50' : '',
                  )}
                >
                  <td className="px-4 py-3">
                    <Badge tone={SEVERITY_TONE[row.severity]}>{row.severity}</Badge>
                  </td>
                  <td className="px-4 py-3 text-neutral-200">{row.titleEn}</td>
                  <td className="px-4 py-3 text-neutral-400">
                    <div>
                      Starts: {row.startsAt ? formatDateTime(row.startsAt) : <em>immediately</em>}
                    </div>
                    <div>Ends: {row.endsAt ? formatDateTime(row.endsAt) : <em>never</em>}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <Badge tone={row.active ? 'green' : 'neutral'}>
                        {row.active ? 'active' : 'inactive'}
                      </Badge>
                      {row.publishedAt ? (
                        <span className="text-xs text-neutral-500">
                          Published {formatDateTime(row.publishedAt)}
                        </span>
                      ) : (
                        <span className="text-xs text-neutral-500">Never published</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="secondary"
                        disabled={busyId === row.id}
                        onClick={() => setComposer(fromAnnouncement(row))}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busyId === row.id}
                        onClick={() => void toggleActive(row)}
                      >
                        {row.active ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busyId === row.id}
                        onClick={() => void removeAnnouncement(row)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
