import { useEffect, useMemo, useRef, useState } from 'react';

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SORTS,
  FEEDBACK_STATUSES,
  type AdminFeedbackSubmission,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import {
  EDGE,
  EDGE_ACTIVE,
  EDGE_ACTIVE_IDLE,
  EDGE_BOTTOM,
  EDGE_TOP,
  SURFACE_HOVER,
  SURFACE_PANEL,
  TEXT_MICRO,
  TEXT_MUTED,
  TEXT_NUM,
  TEXT_ROW_PRIMARY,
} from '../components/tokens';
import {
  AsyncReadState,
  Badge,
  Button,
  EmptyState,
  SelectField,
  TextField,
  cx,
} from '../components/ui';
import { useResource } from '../useResource';
import { formatDuration } from '../formatDuration';
import { CATEGORY_TONE, STATUS_TONE, ageSeconds } from './supportFormat';
import {
  SUPPORT_UNREAD_FILTERS,
  clampFocus,
  deriveFocusIndex,
  supportKeyIntent,
  supportListParams,
  type SupportQuery,
} from './supportPaneState';

/**
 * The left half of the Support split pane (#1406 W3): filters over a dense,
 * keyboard-walkable queue.
 *
 * The rows are a `listbox`, not a nav: selecting one swaps the pane beside it
 * rather than navigating away, which is exactly what single-select listbox
 * semantics describe. Focus is roving — only the highlighted row is tabbable —
 * so Tab still leaves the list in one press instead of walking 25 rows.
 *
 * The queue read and the keys that walk it both live here, because the
 * component that owns a list is the one accountable for what its rows do and
 * for what the operator sees when the read fails.
 */
export function SupportInbox({
  query,
  filtersActive,
  reloadToken,
  onOpen,
  onClose,
  onPatchQuery,
}: {
  query: SupportQuery;
  filtersActive: boolean;
  /** Bumped by the thread pane when a write invalidates this queue. */
  reloadToken: number;
  onOpen: (id: string) => void;
  onClose: () => void;
  onPatchQuery: (
    patch: Record<string, string | number | boolean | null>,
    keepPage?: boolean,
  ) => void;
}) {
  const t = useT();

  const listParams = useMemo(() => supportListParams(query), [query]);
  const resource = useResource(
    (signal) => api.listAdminFeedback(listParams, signal),
    [
      query.q,
      query.category,
      query.status,
      query.version,
      query.unread,
      query.archived,
      query.sort,
      query.page,
      reloadToken,
    ],
  );
  const rows = resource.data?.submissions ?? [];
  const page = resource.data?.pagination ?? null;
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);

  // Focus (the highlight) and selection (the open thread) are different things:
  // j/k walks the queue without opening anything, so an operator can scan it
  // without marking six threads read on the way past.
  const [focusIndex, setFocusIndex] = useState(-1);
  useEffect(() => {
    setFocusIndex((previous) => deriveFocusIndex(ids, query.thread, previous));
  }, [ids, query.thread]);

  // The rules live in `supportPaneState`; this only carries them out.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const intent = supportKeyIntent(event);
      if (intent.kind === 'none') return;
      if (intent.kind === 'blur') {
        (event.target as HTMLElement | null)?.blur();
        return;
      }
      if (intent.kind === 'move') {
        if (ids.length === 0) return;
        event.preventDefault();
        setFocusIndex((previous) =>
          clampFocus((previous < 0 ? 0 : previous) + intent.delta, ids.length),
        );
        return;
      }
      if (intent.kind === 'open') {
        const id = ids[focusIndex];
        if (id === undefined) return;
        event.preventDefault();
        onOpen(id);
        return;
      }
      // Escape closes the open thread rather than clearing filters: the pane is
      // what the operator just opened, and it is the only thing Escape can undo
      // without discarding typed input.
      if (query.thread !== null) {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [ids, focusIndex, onOpen, onClose, query.thread]);

  // The URL owns the search term; the input is a local draft of it so each
  // keystroke does not become a request (and a history entry).
  const [draft, setDraft] = useState(query.q);
  useEffect(() => setDraft(query.q), [query.q]);
  useEffect(() => {
    if (draft === query.q) return;
    const id = setTimeout(() => onPatchQuery({ q: draft.trim() }), 300);
    return () => clearTimeout(id);
  }, [draft, query.q, onPatchQuery]);

  return (
    <section className={cx(EDGE, SURFACE_PANEL, 'flex min-w-0 flex-col')}>
      <div className={cx('flex flex-col gap-2 px-3 py-3', EDGE_BOTTOM)}>
        <TextField
          label={t('admin.support.filters.search')}
          hideLabel
          name="support-search"
          type="search"
          placeholder={t('admin.support.filters.searchPlaceholder')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />

        <div className="grid grid-cols-2 gap-2">
          <SelectField
            label={t('admin.support.filters.status')}
            name="support-status"
            value={query.status}
            onChange={(event) => onPatchQuery({ status: event.target.value })}
            options={[
              { value: '', label: t('admin.support.filters.allStatuses') },
              ...FEEDBACK_STATUSES.map((status) => ({
                value: status,
                label: t(`admin.feedback.status.${status}`),
              })),
            ]}
          />
          <SelectField
            label={t('admin.support.filters.category')}
            name="support-category"
            value={query.category}
            onChange={(event) => onPatchQuery({ category: event.target.value })}
            options={[
              { value: '', label: t('admin.support.filters.allCategories') },
              ...FEEDBACK_CATEGORIES.map((category) => ({
                value: category,
                label: t(`admin.feedback.category.${category}`),
              })),
            ]}
          />
          <SelectField
            label={t('admin.support.filters.unread')}
            name="support-unread"
            value={query.unread}
            onChange={(event) => onPatchQuery({ unread: event.target.value })}
            options={SUPPORT_UNREAD_FILTERS.map((value) => ({
              value,
              label: t(`admin.support.filters.unreadOption.${value}`),
            }))}
          />
          <SelectField
            label={t('admin.support.filters.sort')}
            name="support-sort"
            value={query.sort}
            onChange={(event) => onPatchQuery({ sort: event.target.value })}
            options={FEEDBACK_SORTS.map((sort) => ({
              value: sort,
              label: t(`admin.feedback.sort.${sort}`),
            }))}
          />
          <TextField
            label={t('admin.support.filters.version')}
            name="support-version"
            placeholder={t('admin.support.filters.versionPlaceholder')}
            defaultValue={query.version}
            onBlur={(event) => onPatchQuery({ version: event.target.value.trim() })}
          />
          <SelectField
            label={t('admin.support.filters.queue')}
            name="support-queue"
            value={query.archived ? 'archived' : 'active'}
            onChange={(event) => onPatchQuery({ archived: event.target.value === 'archived' })}
            options={[
              { value: 'active', label: t('admin.support.filters.queueActive') },
              { value: 'archived', label: t('admin.support.filters.queueArchived') },
            ]}
          />
        </div>

        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() =>
              onPatchQuery({ q: null, status: null, category: null, version: null, unread: null })
            }
          >
            {t('admin.support.filters.reset')}
          </Button>
        ) : null}
      </div>

      {resource.loading || resource.error ? (
        <div className="px-3 py-4">
          <AsyncReadState
            loading={resource.loading}
            error={resource.error}
            retryable={resource.retryable}
            onRetry={resource.reload}
            loadingLabel={t('admin.support.inbox.loading')}
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState>
            {filtersActive
              ? t('admin.support.inbox.emptyFiltered')
              : query.archived
                ? t('admin.support.inbox.emptyArchived')
                : t('admin.support.inbox.empty')}
          </EmptyState>
        </div>
      ) : (
        <ul
          // A listbox of submissions; the roving tabindex below is what keeps
          // Tab from walking every row.
          role="listbox"
          aria-label={t('admin.support.inbox.label')}
          className="max-h-[62vh] overflow-y-auto"
        >
          {rows.map((row, index) => (
            <InboxRow
              key={row.id}
              row={row}
              selected={query.thread === row.id}
              focused={focusIndex === index}
              onFocus={() => setFocusIndex(index)}
              onOpen={() => onOpen(row.id)}
            />
          ))}
        </ul>
      )}

      {page !== null && page.totalPages > 1 ? (
        <nav
          aria-label={t('admin.support.inbox.pagination.navigation')}
          className={cx('flex items-center justify-between gap-2 px-3 py-2', EDGE_TOP)}
        >
          <span className={cx(TEXT_MICRO, TEXT_NUM)}>
            {t('admin.support.inbox.pagination.range', {
              page: page.page,
              pages: page.totalPages,
              total: page.total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page.page <= 1 || resource.loading}
              onClick={() => onPatchQuery({ page: Math.max(1, page.page - 1) }, true)}
            >
              {t('admin.support.inbox.pagination.previous')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page.page >= page.totalPages || resource.loading}
              onClick={() => onPatchQuery({ page: page.page + 1 }, true)}
            >
              {t('admin.support.inbox.pagination.next')}
            </Button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function InboxRow({
  row,
  selected,
  focused,
  onFocus,
  onOpen,
}: {
  row: AdminFeedbackSubmission;
  selected: boolean;
  focused: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLLIElement | null>(null);

  // Keyboard navigation is useless if the highlighted row is off-screen. Only
  // move the viewport when this row actually holds the highlight, so a mouse
  // user's scroll position is never yanked.
  useEffect(() => {
    if (!focused) return;
    // Optional call, not an assumption: `scrollIntoView` is absent in jsdom and
    // in older embedded webviews, and a missing scroll convenience must never
    // take the whole queue down with it.
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);

  const seconds = ageSeconds(row.lastStatusChangeAt);
  const age = seconds === null ? '' : formatDuration(t, seconds);
  const unread = row.unreadCount > 0;
  const lastWord =
    row.lastAuthorSide === null
      ? t('admin.support.inbox.noReplies')
      : row.lastAuthorSide === 'admin'
        ? t('admin.support.inbox.lastWordYou')
        : t('admin.support.inbox.lastWordSubmitter');

  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      // Roving tabindex: exactly one row is reachable with Tab, and it is the
      // one the arrow keys are pointing at.
      tabIndex={focused ? 0 : -1}
      onClick={onOpen}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen();
      }}
      className={cx(
        'flex cursor-pointer flex-col gap-1 px-3 py-2 outline-none',
        'border-b border-neutral-800 last:border-b-0',
        selected ? EDGE_ACTIVE : EDGE_ACTIVE_IDLE,
        selected ? 'bg-neutral-800/60' : SURFACE_HOVER,
        focused ? 'ring-1 ring-inset ring-sky-500/60' : null,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {unread ? (
          <span
            className="h-1.5 w-1.5 shrink-0 bg-sky-400"
            aria-label={t('admin.support.inbox.unread')}
          />
        ) : null}
        <span className={cx('min-w-0 flex-1 truncate', TEXT_ROW_PRIMARY)}>
          {row.subject ?? t('admin.support.inbox.noSubject')}
        </span>
        <span className={cx('shrink-0', TEXT_MUTED, TEXT_NUM)}>{age}</span>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge tone={CATEGORY_TONE[row.category]}>
          {t(`admin.feedback.category.${row.category}`)}
        </Badge>
        <Badge tone={STATUS_TONE[row.status]}>{t(`admin.feedback.status.${row.status}`)}</Badge>
        {row.deletedByUser ? (
          <Badge tone="neutral">{t('admin.feedback.deletedByUser')}</Badge>
        ) : null}
        {row.archivedAt !== null ? (
          <Badge tone="neutral">{t('admin.feedback.archived')}</Badge>
        ) : null}
      </div>

      <div className={cx('truncate', TEXT_MUTED)}>
        {row.submitter.username}
        {' · '}
        {lastWord}
      </div>
    </li>
  );
}
