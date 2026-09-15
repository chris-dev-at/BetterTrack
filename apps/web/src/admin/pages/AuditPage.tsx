import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  AUDIT_PRESETS,
  AUDIT_SIGNAL_WINDOWS,
  type AuditLogEntry,
  type AuditPreset,
  type AuditSignalWindow,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import * as api from '../../lib/adminApi';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
import { adminSignOutReason } from '../sessionExpiry';
import { formatDateTime } from '../../lib/format';
import { useResource } from '../useResource';
import { ActorValue, AuditEntryDrawer, stringify } from '../components/AuditEntryDrawer';
import { TEXT_MICRO, TEXT_MONO, TEXT_MUTED, TEXT_NUM } from '../components/tokens';
import {
  Alert,
  AsyncReadState,
  Button,
  DataTable,
  EmptyState,
  KeyValueList,
  PageHeader,
  Panel,
  PanelHeader,
  Spinner,
  Td,
  TextField,
  Th,
  cx,
} from '../components/ui';

/** Compact one-line rendering of an audit entry's freeform metadata. */
function metaSummary(meta: unknown): string {
  if (meta === null || meta === undefined) return '—';
  if (typeof meta === 'string') return meta;
  if (typeof meta === 'object' && !Array.isArray(meta)) {
    // A converted config write carries `{ before, after }`; the useful one-liner
    // is WHICH fields moved, not the whole pair stringified into a truncated
    // cell. The drawer holds the detail.
    //
    // The pair is rarely the whole row, so the summary names the REMAINING keys
    // alongside it (`feature_flag.changed` keeps the flag name in `meta.key`,
    // a W5 moderating write keeps `moderationId`). Summarising the pair alone
    // hid them from the cell as well as from the drawer.
    const record = meta as Record<string, unknown>;
    const after = record.after;
    const changed =
      after !== null && typeof after === 'object' && !Array.isArray(after)
        ? Object.keys(after as Record<string, unknown>)
        : [];
    if (changed.length > 0) {
      // Deduped: a sibling key can share a name with a changed field
      // (`feature_flag.changed` carries `enabled` at the top level AND inside
      // the pair), and naming it twice reads as two different things moving.
      const rest = Object.keys(record).filter((key) => key !== 'before' && key !== 'after');
      return [...new Set([...changed, ...rest])].join(', ');
    }
  }
  return stringify(meta);
}

/** The URL keys this page owns. A filtered view has to be a shareable link. */
const FILTER_KEYS = [
  'action',
  'actorId',
  'targetId',
  'targetType',
  'from',
  'to',
  'preset',
] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const isPreset = (value: string | null): value is AuditPreset =>
  value !== null && (AUDIT_PRESETS as readonly string[]).includes(value);

const isWindow = (value: string | null): value is AuditSignalWindow =>
  value !== null && (AUDIT_SIGNAL_WINDOWS as readonly string[]).includes(value);

/** `2026-06-01` → the instant that day starts, which is the inclusive `from`. */
const isoFromDayInput = (day: string): string | null => {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/**
 * The `until` input is INCLUSIVE to the operator and half-open on the wire: an
 * operator asking for "until 2 June" means "including everything on 2 June", so
 * the exclusive bound the contract wants is the start of 3 June. The conversion
 * lives here rather than in the contract, because `[from, to)` is the right
 * shape for a paged range and the wrong words for a date picker.
 */
const isoFromUntilInput = (day: string): string | null => {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : new Date(parsed + DAY_MS).toISOString();
};

const dayInputFromIso = (iso: string | null, exclusive: boolean): string => {
  if (!iso) return '';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  return new Date(exclusive ? parsed - DAY_MS : parsed).toISOString().slice(0, 10);
};

/**
 * Security & API → Audit log (§6.12; ADMIN-W6, #1908).
 *
 * What this wave changed: the console's only durable security record — 153 call
 * sites over a 114-entry vocabulary — was read back through a six-column table
 * with NO filters, a raw actor UUID, and `meta` stringified into a truncated
 * cell. It now has filters that live in the URL (so a view is a link a second
 * operator can open, exactly as Users / Problems / Support / User 360 do), the
 * actor resolved to a username, break-glass events visible whether or not anyone
 * thought to look for them, and a row drawer instead of a tooltip.
 *
 * Paging stays KEYSET on `desc(id)` and there is deliberately no filtered total
 * — see `auditQuerySchema` for why that is a decision and not an omission.
 */
export function AuditPage() {
  const t = useT();
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [params, setParams] = useSearchParams();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<AuditLogEntry | null>(null);
  const [signalsOpen, setSignalsOpen] = useState(false);
  // Failures are recorded as a FLAG, not as a message (#1848). The message is
  // chosen at render time from the catalogue, so it is in the reader's locale
  // and stays right when the locale changes under an error that is on screen.
  const [initialError, setInitialError] = useState(false);
  const [paginationError, setPaginationError] = useState(false);

  const presetParam = params.get('preset');
  const preset = isPreset(presetParam) ? presetParam : undefined;
  const windowParam = params.get('signalWindow');
  const signalWindow: AuditSignalWindow = isWindow(windowParam) ? windowParam : '24h';
  const query = params.toString();

  const filters = useMemo(
    () => {
      const current = new URLSearchParams(query);
      const value = (key: FilterKey) => current.get(key) ?? undefined;
      const presetValue = current.get('preset');
      return {
        ...(value('action') ? { action: value('action')! } : {}),
        ...(value('actorId') ? { actorId: value('actorId')! } : {}),
        ...(value('targetId') ? { targetId: value('targetId')! } : {}),
        ...(value('targetType') ? { targetType: value('targetType')! } : {}),
        ...(value('from') ? { from: value('from')! } : {}),
        ...(value('to') ? { to: value('to')! } : {}),
        ...(isPreset(presetValue) ? { preset: presetValue } : {}),
      };
    },
    // Keyed on the SERIALIZED query: `useSearchParams` hands back a new
    // `URLSearchParams` instance on every render, so keying on the object itself
    // would re-issue the read on renders that changed no filter at all.
    [query],
  );

  const patchQuery = useCallback(
    (patch: Partial<Record<FilterKey | 'signalWindow', string | null>>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === undefined || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const loadPage = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      try {
        const page = await api.listAudit(
          { ...filters, ...(after ? { cursor: after } : {}) },
          signal,
        );
        if (signal?.aborted) return;
        setEntries((prev) => (after ? [...prev, ...page.entries] : page.entries));
        setCursor(page.nextCursor);
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (err instanceof ApiError && err.isNotAuthorized) {
          // Same 401-or-404 rule as `useResource`, and the same reason: on the
          // admin origin this is normally the V5-P13c window closing, so the login
          // screen names it instead of bouncing silently — unless the 404 named a
          // domain outcome, which is a row talking and not this session.
          clearSession(adminSignOutReason(err));
          return;
        }
        if (isAdminTwoFactorSetupRequired(err)) {
          requireTwoFactorSetup();
          return;
        }
        // API envelopes are authored by the server and are not locale-aware —
        // the rule `useResource` states and this page was the console's last
        // offender against (#1814, #1848). Nothing the server wrote is shown.
        if (after) setPaginationError(true);
        else setInitialError(true);
      }
    },
    [clearSession, requireTwoFactorSetup, filters],
  );

  const loadInitial = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setInitialError(false);
      setPaginationError(false);
      await loadPage(null, signal);
      if (!signal?.aborted) setLoading(false);
    },
    [loadPage],
  );

  // A filter change re-runs this through `loadPage`'s identity, which resets the
  // cursor with it: a page of `user.*` rows must never be shown under a
  // `preset=break_glass` filter.
  useEffect(() => {
    const controller = new AbortController();
    void loadInitial(controller.signal);
    return () => controller.abort();
  }, [loadInitial]);

  /**
   * The Signals read. It is NOT gated on the section being expanded: the
   * break-glass banner below is the point — the product's highest-privilege
   * event has to be visible without anyone thinking to look for it.
   */
  const signals = useResource(
    (signal) => api.getSecuritySignals(signalWindow, signal),
    [signalWindow],
  );

  async function retryInitial() {
    await loadInitial();
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setPaginationError(false);
    await loadPage(cursor);
    setLoadingMore(false);
  }

  const retryAction = (onClick: () => Promise<void>) => (
    <Button variant="secondary" onClick={() => void onClick()}>
      {t('common.retry')}
    </Button>
  );

  const errorMessage = (message: string, onRetry: () => Promise<void>) => (
    <Alert tone="error">
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        {retryAction(onRetry)}
      </div>
    </Alert>
  );

  const anyFilter = FILTER_KEYS.some((key) => params.get(key));
  const breakGlassTotal = signals.data?.breakGlassRetentionTotal ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('admin.audit.title')}
        description={t('admin.audit.subtitle')}
        eyebrow={t('admin.nav.sections.securityApi')}
      />

      {/* Standing, never behind a fold: a break-glass 2FA reset is the single
          highest-privilege event in the product and used to render as "system". */}
      {breakGlassTotal > 0 ? (
        <Alert tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {t('admin.audit.breakGlass.banner', {
                count: breakGlassTotal,
                suffix: signals.data?.breakGlassRetentionCapped ? '+' : '',
              })}{' '}
              {t('admin.audit.breakGlass.explainer')}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => patchQuery({ preset: 'break_glass' })}
            >
              {t('admin.audit.breakGlass.show')}
            </Button>
          </div>
        </Alert>
      ) : null}

      <Panel padded={false}>
        <PanelHeader
          title={t('admin.audit.signals.title')}
          description={t('admin.audit.signals.subtitle')}
          actions={
            <>
              {AUDIT_SIGNAL_WINDOWS.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={signalWindow === value ? 'primary' : 'secondary'}
                  aria-pressed={signalWindow === value}
                  onClick={() => patchQuery({ signalWindow: value })}
                >
                  {t(`admin.audit.signals.window.${value}`)}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={signalsOpen}
                onClick={() => setSignalsOpen((open) => !open)}
              >
                {signalsOpen ? t('admin.audit.signals.hide') : t('admin.audit.signals.show')}
              </Button>
            </>
          }
        />
        {signalsOpen ? (
          <div className="p-4">
            <AsyncReadState
              loading={signals.loading}
              error={signals.error}
              retryable={signals.retryable}
              onRetry={signals.reload}
              loadingLabel={t('admin.audit.signals.loading')}
            />
            {signals.data ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <section className="flex flex-col gap-2">
                  <h3 className={TEXT_MICRO}>{t('admin.audit.signals.loginFailures')}</h3>
                  <KeyValueList
                    rows={[
                      {
                        label: t('admin.audit.signals.total'),
                        value: signals.data.loginFailures.total,
                      },
                      ...signals.data.loginFailures.byReason.map((row) => ({
                        label: t(`admin.audit.signals.reason.${row.reason}`),
                        value: row.count,
                      })),
                    ]}
                  />
                </section>
                <section className="flex flex-col gap-2">
                  <h3 className={TEXT_MICRO}>{t('admin.audit.signals.otherSignals')}</h3>
                  <KeyValueList
                    rows={[
                      {
                        label: t('admin.audit.signals.twoFactorVerifyFail'),
                        value: signals.data.twoFactorVerifyFail,
                      },
                      {
                        label: t('admin.audit.signals.passkeyLoginFail'),
                        value: signals.data.passkeyLoginFail,
                      },
                      {
                        label: t('admin.audit.signals.pinVerifyFail'),
                        value: signals.data.pinVerifyFail,
                      },
                      {
                        label: t('admin.audit.signals.reauthFail'),
                        value: signals.data.reauthFail,
                      },
                      {
                        label: t('admin.audit.signals.apiKeyScopeDenied'),
                        value: signals.data.apiKeyScopeDenied,
                      },
                      {
                        label: t('admin.audit.signals.adminLogins'),
                        value: signals.data.adminLogins,
                      },
                      {
                        label: t('admin.audit.signals.adminActors'),
                        value: signals.data.adminActors,
                      },
                      {
                        label: t('admin.audit.signals.breakGlass'),
                        value: signals.data.breakGlass,
                      },
                    ]}
                  />
                </section>
                <p className={cx(TEXT_MUTED, 'sm:col-span-2')}>
                  {t('admin.audit.signals.derived')}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <Panel>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={TEXT_MICRO}>{t('admin.audit.filters.presets')}</span>
            {AUDIT_PRESETS.map((value) => (
              <Button
                key={value}
                size="sm"
                variant={preset === value ? 'primary' : 'secondary'}
                aria-pressed={preset === value}
                onClick={() => patchQuery({ preset: preset === value ? null : value })}
              >
                {t(`admin.audit.preset.${value}`)}
              </Button>
            ))}
            {anyFilter ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  patchQuery(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))
                }
              >
                {t('admin.audit.filters.clear')}
              </Button>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextField
              label={t('admin.audit.filters.action')}
              hint={t('admin.audit.filters.actionHint')}
              name="audit-action"
              value={params.get('action') ?? ''}
              onChange={(event) => patchQuery({ action: event.target.value.trim() || null })}
            />
            <TextField
              label={t('admin.audit.filters.actor')}
              name="audit-actor"
              value={params.get('actorId') ?? ''}
              onChange={(event) => patchQuery({ actorId: event.target.value.trim() || null })}
            />
            <TextField
              label={t('admin.audit.filters.target')}
              name="audit-target"
              value={params.get('targetId') ?? ''}
              onChange={(event) => patchQuery({ targetId: event.target.value.trim() || null })}
            />
            <TextField
              label={t('admin.audit.filters.targetType')}
              name="audit-target-type"
              value={params.get('targetType') ?? ''}
              onChange={(event) => patchQuery({ targetType: event.target.value.trim() || null })}
            />
            <TextField
              label={t('admin.audit.filters.from')}
              name="audit-from"
              type="date"
              value={dayInputFromIso(params.get('from'), false)}
              onChange={(event) =>
                patchQuery({
                  from: event.target.value ? isoFromDayInput(event.target.value) : null,
                })
              }
            />
            <TextField
              label={t('admin.audit.filters.until')}
              name="audit-until"
              type="date"
              value={dayInputFromIso(params.get('to'), true)}
              onChange={(event) =>
                patchQuery({
                  to: event.target.value ? isoFromUntilInput(event.target.value) : null,
                })
              }
            />
          </div>
        </div>
      </Panel>

      {loading ? (
        <Spinner label={t('admin.audit.loading')} />
      ) : initialError ? (
        errorMessage(t('admin.audit.loadError'), retryInitial)
      ) : entries.length === 0 ? (
        <EmptyState>
          {anyFilter ? t('admin.audit.emptyFiltered') : t('admin.audit.empty')}
        </EmptyState>
      ) : (
        <>
          {paginationError ? errorMessage(t('admin.audit.loadMoreError'), loadMore) : null}
          <DataTable>
            <thead className="border-b border-neutral-800 bg-neutral-900">
              <tr>
                <Th>{t('admin.audit.columns.when')}</Th>
                <Th>{t('admin.audit.columns.action')}</Th>
                <Th>{t('admin.audit.columns.actor')}</Th>
                <Th>{t('admin.audit.columns.target')}</Th>
                <Th>{t('admin.audit.columns.ip')}</Th>
                <Th>{t('admin.audit.columns.details')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-neutral-900/50">
                  <Td className={cx('whitespace-nowrap text-neutral-400', TEXT_NUM)}>
                    {formatDateTime(entry.createdAt)}
                  </Td>
                  <Td className="font-medium text-neutral-200">{entry.action}</Td>
                  <Td>
                    <ActorValue entry={entry} />
                  </Td>
                  <Td className="text-neutral-400">
                    {entry.targetType ? (
                      <span>
                        {entry.targetType}
                        {entry.targetId ? (
                          <span className={cx(TEXT_MONO, 'text-neutral-500')}>
                            {' '}
                            {entry.targetId}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className={cx(TEXT_MONO, 'text-neutral-400')}>{entry.ip ?? '—'}</Td>
                  <Td>
                    <span className="flex items-center justify-between gap-2">
                      <span className="max-w-[16rem] truncate text-neutral-400">
                        {metaSummary(entry.meta)}
                      </span>
                      <Button size="sm" variant="ghost" onClick={() => setSelected(entry)}>
                        {t('admin.audit.drawer.open')}
                      </Button>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {cursor ? (
            <div className="flex justify-center">
              <Button variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? t('admin.audit.loadingMore') : t('admin.audit.loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
