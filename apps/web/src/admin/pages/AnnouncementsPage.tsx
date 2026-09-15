import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TITLE_MAX,
  type Announcement,
  type AnnouncementDeliveryState,
  type AnnouncementSeverity,
  type UpdateAnnouncementRequest,
} from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import * as api from '../../lib/adminApi';
import { DISPLAY_TIME_ZONE, formatDateTime } from '../../lib/format';
import { useAdminCallFailure } from '../sessionExpiry';
import { useResource } from '../useResource';
import { AnnouncementPreview } from '../components/AnnouncementPreview';
import { Modal } from '../components/Modal';
import {
  CORNERS,
  EDGE_STRONG,
  FOCUS,
  RULE_Y,
  SURFACE_HEADER,
  SURFACE_HOVER,
  TAP_TARGET,
  TEXT_MICRO,
  TEXT_MUTED,
  TEXT_NUM,
  TEXT_ROW_PRIMARY,
  TEXT_SECTION,
  type Tone,
} from '../components/tokens';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  EmptyState,
  PageHeader,
  Panel,
  PanelHeader,
  SelectField,
  Spinner,
  Td,
  TextAreaField,
  TextField,
  Th,
  cx,
} from '../components/ui';

/**
 * Admin composer for announcements (§13.4 V4-P5b; rebuilt by ADMIN-W7a #1909).
 *
 * EN + DE title/body, severity, a display window, and the flag that arms it.
 * Delivery is banner + inbox — one inbox row per user, deduped by the shared
 * eventKey.
 *
 * ── What #1909 changed here ─────────────────────────────────────────────────
 *
 *  • **The checkbox no longer lies.** It used to read "Active (publishes to
 *    every user on save)", which was true — saving walked the entire user table
 *    inside the request — while the helper text under `startsAt` said "Empty =
 *    start immediately (once active)", implying a filled-in start meant "later".
 *    It did not: `startsAt` deferred the banner and nothing else, so scheduling
 *    a notice for Monday mailed everybody on Friday. Publication now belongs to
 *    the `announcements.publishDue` job and the window governs both halves, so
 *    the control says what it does: publish when the window opens.
 *  • **Every row states where it actually is.** `deliveryState` is derived on
 *    the server (two consoles with two clock skews must not disagree with each
 *    other or with the job) and rendered verbatim — a scheduled announcement
 *    reads "Will publish on …", never "active".
 *  • **Times are explicit.** The `datetime-local` widget speaks the browser's
 *    zone and nothing else, while every readout in this console renders in
 *    {@link DISPLAY_TIME_ZONE} (§5.5). Left alone, an operator would type 09:00
 *    and the table beside it would answer 10:00. Both ends now speak the
 *    display zone, the field says so, and the wire value is always UTC.
 *  • **The page is on the W2 token layer.** It hand-rolled `rounded-lg
 *    bg-neutral-900` — the drift failure mode `tokens.ts` names by example —
 *    and imported none of the console's own language.
 */

const SEVERITY_TONE: Record<AnnouncementSeverity, Tone> = {
  info: 'neutral',
  warning: 'amber',
  critical: 'red',
};

/** Delivery state → badge tone. Only a live publication is "good"; a closed
 *  window is neutral history, and a draft is deliberately quiet. */
const STATE_TONE: Record<AnnouncementDeliveryState, Tone> = {
  draft: 'neutral',
  scheduled: 'sky',
  publishing: 'amber',
  published: 'green',
  expired: 'neutral',
};

/**
 * Displayable failures are catalog copy, never the server's envelope (#1814):
 * API envelopes are authored in English and are not locale-aware, so rendering
 * `err.message` leaked sentences like "The mail service is unavailable." into a
 * German console. The structural outcomes (auth loss, the 2FA trap) are handled
 * by `useAdminCallFailure` before this is reached.
 */
function errorMessage(t: TranslateFn): string {
  return t('common.genericError');
}

// ── Time: display-zone wall clock in, UTC on the wire ───────────────────────

const ZONED_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function partsAt(instant: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of ZONED_PARTS.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** The display zone's UTC offset at `instant`, in milliseconds. */
function zoneOffsetMs(instant: number): number {
  const p = partsAt(instant);
  return (
    Date.UTC(p.year!, (p.month ?? 1) - 1, p.day!, p.hour!, p.minute!, p.second!) -
    // `Date.UTC` has second resolution; drop the sub-second remainder so a DST
    // offset never picks up milliseconds of noise.
    (instant - (instant % 1000))
  );
}

/** ISO instant → the `YYYY-MM-DDTHH:mm` the widget wants, in the display zone. */
export function toInputDateTime(iso: string | null): string {
  if (!iso) return '';
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return '';
  const p = partsAt(instant);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)}T${pad(p.hour!)}:${pad(p.minute!)}`;
}

/**
 * The widget's display-zone wall clock → a UTC ISO instant.
 *
 * Read the typed value as if it were UTC, then subtract the zone's offset. The
 * offset depends on the instant (DST), and the instant depends on the offset,
 * so the correction is applied twice: the first pass lands within an hour of
 * the answer, which is always close enough for the second to read the right
 * side of a DST boundary.
 */
export function fromInputDateTime(local: string): string | null {
  if (!local) return null;
  const naive = Date.parse(`${local}:00Z`);
  if (Number.isNaN(naive)) return null;
  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) instant = naive - zoneOffsetMs(instant);
  return new Date(instant).toISOString();
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

/** The honest one-line answer to "where is this announcement right now?". */
function stateDetail(row: Announcement, t: TranslateFn): string {
  switch (row.deliveryState) {
    case 'scheduled':
      return t('admin.announcements.state.scheduledDetail', {
        date: formatDateTime(row.startsAt),
      });
    case 'published':
      return t('admin.announcements.state.publishedDetail', {
        date: formatDateTime(row.publishedAt),
      });
    case 'expired':
      return t('admin.announcements.state.expiredDetail', { date: formatDateTime(row.endsAt) });
    case 'publishing':
      return t('admin.announcements.state.publishingDetail');
    default:
      return t('admin.announcements.state.draftDetail');
  }
}

export function AnnouncementsPage() {
  const t = useT();
  const { locale } = useI18n();
  const onFailure = useAdminCallFailure();
  const announcements = useResource((signal) => api.listAnnouncements(signal), []);
  const [composer, setComposer] = useState<ComposerState>(EMPTY_COMPOSER);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Announcement | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 3000);
    return () => clearTimeout(timer);
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
        setSaved(t('admin.announcements.composer.updated'));
      } else {
        const created = await api.createAnnouncement({
          severity: composer.severity,
          titleEn: composer.titleEn.trim(),
          bodyEn: composer.bodyEn.trim(),
          titleDe: composer.titleDe.trim(),
          bodyDe: composer.bodyDe.trim(),
          startsAt: startsAt ?? undefined,
          endsAt: endsAt ?? undefined,
          active: composer.active,
        });
        // The confirmation reports what the SERVER decided, not what the form
        // hoped: "created and published" was the old lie on a row nothing had
        // delivered yet.
        setSaved(
          created.deliveryState === 'scheduled'
            ? t('admin.announcements.composer.createdScheduled')
            : created.deliveryState === 'publishing'
              ? t('admin.announcements.composer.createdQueued')
              : t('admin.announcements.composer.created'),
        );
      }
      resetComposer();
      announcements.reload();
    } catch (err) {
      // Create has no row id; edit addresses one a colleague may have deleted.
      if (!onFailure(err, composer.id ? 'surface' : 'session')) setFormError(errorMessage(t));
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
      if (!onFailure(err, 'surface')) setRowError(errorMessage(t));
    } finally {
      setBusyId(null);
    }
  }

  async function removeAnnouncement(row: Announcement) {
    if (busyId !== null) return;
    setRowError(null);
    setBusyId(row.id);
    try {
      await api.deleteAnnouncement(row.id);
      announcements.reload();
      // If the composer was editing this row, clear it too.
      if (composer.id === row.id) resetComposer();
      setDeleting(null);
    } catch (err) {
      if (!onFailure(err, 'surface')) setRowError(errorMessage(t));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.announcements.title')}
        description={t('admin.announcements.description')}
      />

      <Panel padded={false}>
        <PanelHeader
          title={
            composer.id
              ? t('admin.announcements.composer.headingEdit')
              : t('admin.announcements.composer.headingNew')
          }
          description={t('admin.announcements.composer.activeHint')}
        />
        <form onSubmit={onSubmit} className="flex flex-col gap-4 p-4">
          <div className="flex flex-wrap items-end gap-4">
            <SelectField
              label={t('admin.announcements.composer.severity')}
              name="severity"
              id="severity"
              className={TAP_TARGET}
              value={composer.severity}
              onChange={(e) =>
                setComposer({ ...composer, severity: e.target.value as AnnouncementSeverity })
              }
              options={ANNOUNCEMENT_SEVERITIES.map((s) => ({
                value: s,
                label: t(`announcements.severity.${s}`),
              }))}
            />
            <label
              className={cx(
                'flex cursor-pointer items-center gap-2 px-1 text-[13px] text-neutral-300',
                TAP_TARGET,
                CORNERS,
              )}
            >
              <input
                type="checkbox"
                className={cx('h-4 w-4 accent-sky-600', CORNERS, FOCUS)}
                checked={composer.active}
                onChange={(e) => setComposer({ ...composer, active: e.target.checked })}
              />
              {t('admin.announcements.composer.active')}
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-3">
              <TextField
                label={t('admin.announcements.composer.titleEn')}
                name="titleEn"
                className={TAP_TARGET}
                value={composer.titleEn}
                onChange={(e) => setComposer({ ...composer, titleEn: e.target.value })}
                required
                maxLength={ANNOUNCEMENT_TITLE_MAX}
              />
              <TextAreaField
                label={t('admin.announcements.composer.bodyEn')}
                id="bodyEn"
                className={cx('min-h-[7rem]', TAP_TARGET)}
                value={composer.bodyEn}
                onChange={(e) => setComposer({ ...composer, bodyEn: e.target.value })}
                maxLength={ANNOUNCEMENT_BODY_MAX}
                required
              />
            </div>
            <div className="flex flex-col gap-3">
              <TextField
                label={t('admin.announcements.composer.titleDe')}
                name="titleDe"
                className={TAP_TARGET}
                value={composer.titleDe}
                onChange={(e) => setComposer({ ...composer, titleDe: e.target.value })}
                required
                maxLength={ANNOUNCEMENT_TITLE_MAX}
              />
              <TextAreaField
                label={t('admin.announcements.composer.bodyDe')}
                id="bodyDe"
                className={cx('min-h-[7rem]', TAP_TARGET)}
                value={composer.bodyDe}
                onChange={(e) => setComposer({ ...composer, bodyDe: e.target.value })}
                maxLength={ANNOUNCEMENT_BODY_MAX}
                required
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('admin.announcements.composer.startsAt')}
              hint={t('admin.announcements.composer.startsAtHint')}
              id="startsAt"
              name="startsAt"
              type="datetime-local"
              className={TAP_TARGET}
              value={composer.startsAt}
              onChange={(e) => setComposer({ ...composer, startsAt: e.target.value })}
            />
            <TextField
              label={t('admin.announcements.composer.endsAt')}
              hint={t('admin.announcements.composer.endsAtHint')}
              id="endsAt"
              name="endsAt"
              type="datetime-local"
              className={TAP_TARGET}
              value={composer.endsAt}
              onChange={(e) => setComposer({ ...composer, endsAt: e.target.value })}
            />
          </div>
          <p className={TEXT_MUTED}>
            {t('admin.announcements.composer.timezone', { zone: DISPLAY_TIME_ZONE })}
          </p>

          <section className="flex flex-col gap-2">
            <h3 className={TEXT_MICRO}>{t('admin.announcements.preview.heading')}</h3>
            <p className={TEXT_MUTED}>{t('admin.announcements.preview.description')}</p>
            <AnnouncementPreview
              severity={composer.severity}
              titleEn={composer.titleEn}
              bodyEn={composer.bodyEn}
              titleDe={composer.titleDe}
              bodyDe={composer.bodyDe}
            />
          </section>

          {formError ? <Alert tone="error">{formError}</Alert> : null}
          {saved ? <Alert tone="success">{saved}</Alert> : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting
                ? composer.id
                  ? t('admin.announcements.composer.saving')
                  : t('admin.announcements.composer.creating')
                : composer.id
                  ? t('admin.announcements.composer.save')
                  : t('admin.announcements.composer.create')}
            </Button>
            {composer.id ? (
              <Button type="button" variant="ghost" onClick={resetComposer} disabled={submitting}>
                {t('admin.announcements.composer.cancel')}
              </Button>
            ) : null}
          </div>
        </form>
      </Panel>

      {rowError ? <Alert tone="error">{rowError}</Alert> : null}

      {announcements.loading ? (
        <Spinner label={t('admin.announcements.list.loading')} />
      ) : announcements.error ? (
        <Alert tone="error">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{announcements.error}</span>
            <Button variant="secondary" size="sm" onClick={announcements.reload}>
              {t('admin.announcements.list.retry')}
            </Button>
          </div>
        </Alert>
      ) : !announcements.data || announcements.data.announcements.length === 0 ? (
        <EmptyState>{t('admin.announcements.list.empty')}</EmptyState>
      ) : (
        <>
          <h2 className={TEXT_SECTION}>{t('admin.announcements.list.heading')}</h2>
          <DataTable minWidth="58rem">
            <thead className={cx(SURFACE_HEADER)}>
              <tr>
                <Th>{t('admin.announcements.list.columns.severity')}</Th>
                <Th>{t('admin.announcements.list.columns.title')}</Th>
                <Th>{t('admin.announcements.list.columns.window')}</Th>
                <Th>{t('admin.announcements.list.columns.delivery')}</Th>
                <Th>{t('admin.announcements.list.columns.reach')}</Th>
                <Th className="text-right">{t('admin.announcements.list.columns.actions')}</Th>
              </tr>
            </thead>
            <tbody className={RULE_Y}>
              {announcements.data.announcements.map((row) => (
                <tr
                  key={row.id}
                  className={cx(
                    SURFACE_HOVER,
                    composer.id === row.id ? cx(EDGE_STRONG, 'bg-neutral-900') : null,
                  )}
                >
                  <Td>
                    <Badge tone={SEVERITY_TONE[row.severity]}>
                      {t(`announcements.severity.${row.severity}`)}
                    </Badge>
                  </Td>
                  <Td className={TEXT_ROW_PRIMARY}>{row.titleEn}</Td>
                  <Td>
                    <div className={cx('flex flex-col', TEXT_NUM)}>
                      <span>
                        {row.startsAt
                          ? t('admin.announcements.list.starts', {
                              date: formatDateTime(row.startsAt),
                            })
                          : t('admin.announcements.list.startsImmediately')}
                      </span>
                      <span>
                        {row.endsAt
                          ? t('admin.announcements.list.ends', { date: formatDateTime(row.endsAt) })
                          : t('admin.announcements.list.endsNever')}
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <Badge tone={STATE_TONE[row.deliveryState]}>
                        {t(`admin.announcements.state.${row.deliveryState}`)}
                      </Badge>
                      <span className={TEXT_MUTED}>{stateDetail(row, t)}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className={cx('flex flex-col', TEXT_NUM)}>
                      <span>
                        {row.deliveredCount === null
                          ? t('admin.announcements.list.reachPending')
                          : t('admin.announcements.list.reachDelivered', {
                              delivered: row.deliveredCount,
                            })}
                      </span>
                      {row.failedCount ? (
                        <span className="text-red-400">
                          {t('admin.announcements.list.reachFailed', { failed: row.failedCount })}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => setComposer(fromAnnouncement(row))}
                      >
                        {t('admin.announcements.list.edit')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => void toggleActive(row)}
                      >
                        {row.active
                          ? t('admin.announcements.list.deactivate')
                          : t('admin.announcements.list.activate')}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => {
                          setRowError(null);
                          setDeleting(row);
                        }}
                      >
                        {t('admin.actions.delete')}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      {deleting ? (
        <Modal
          title={t('admin.confirmations.deleteAnnouncement.title')}
          onClose={() => setDeleting(null)}
          dismissable={busyId !== deleting.id}
        >
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-neutral-400">
              {t('admin.confirmations.deleteAnnouncement.description', {
                name: locale === 'de' ? deleting.titleDe : deleting.titleEn,
              })}
            </p>
            {rowError ? <Alert tone="error">{rowError}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={busyId === deleting.id}
                onClick={() => setDeleting(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={busyId === deleting.id}
                onClick={() => void removeAnnouncement(deleting)}
              >
                {busyId === deleting.id
                  ? t('admin.confirmations.deleteAnnouncement.pending')
                  : t('admin.confirmations.deleteAnnouncement.confirm')}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
