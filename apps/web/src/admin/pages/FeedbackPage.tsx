import { useState } from 'react';

import type {
  AdminFeedbackSubmission,
  FeedbackCategory,
  FeedbackSort,
  FeedbackStatus,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { isAdminTwoFactorSetupRequired, useAuth } from '../AuthContext';
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner } from '../components/ui';
import { useResource } from '../useResource';

type CategoryFilter = FeedbackCategory | 'all';

const CATEGORY_TONE = {
  feature: 'sky',
  bug: 'red',
  other: 'neutral',
} as const;

const STATUS_TONE = {
  new: 'amber',
  triaged: 'sky',
  working_on_it: 'amber',
  saved_as_future_idea: 'neutral',
  declined: 'red',
  shipped: 'green',
} as const;

const DIAGNOSTIC_KEYS = [
  'platform',
  'appVersion',
  'osVersion',
  'device',
  'locale',
  'screen',
] as const;

/** Owner inbox for authenticated feedback from both the web and native clients. */
export function FeedbackPage() {
  const t = useT();
  const { clearSession, requireTwoFactorSetup } = useAuth();
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sort, setSort] = useState<FeedbackSort>('category');
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resource = useResource(
    (signal) =>
      api.listAdminFeedback(
        { category: category === 'all' ? undefined : category, sort, page },
        signal,
      ),
    [category, sort, page],
  );
  const { data, loading, error, reload } = resource;

  function changeCategory(next: CategoryFilter) {
    setCategory(next);
    setPage(1);
    // Clearing a narrowed queue deliberately restores the owner-defined default.
    if (next === 'all') setSort('category');
  }

  function changeSort(next: FeedbackSort) {
    setSort(next);
    setPage(1);
  }

  async function changeStatus(id: string, status: FeedbackStatus) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.updateFeedbackStatus(id, { status });
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.isNotAuthorized) {
        clearSession();
        return;
      }
      if (isAdminTwoFactorSetupRequired(err)) {
        requireTwoFactorSetup();
        return;
      }
      setActionError(t('admin.feedback.actionError'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader title={t('admin.feedback.title')} description={t('admin.feedback.subtitle')} />
        <Button variant="secondary" className="self-start" onClick={reload}>
          {t('admin.feedback.refresh')}
        </Button>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-sm text-neutral-300">
          <span>{t('admin.feedback.filters.category')}</span>
          <select
            value={category}
            onChange={(event) => changeCategory(event.target.value as CategoryFilter)}
            className="min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          >
            <option value="all">{t('admin.feedback.filters.all')}</option>
            <option value="feature">{t('admin.feedback.category.feature')}</option>
            <option value="bug">{t('admin.feedback.category.bug')}</option>
            <option value="other">{t('admin.feedback.category.other')}</option>
          </select>
        </label>

        <label className="flex min-w-0 flex-col gap-1 text-sm text-neutral-300">
          <span>{t('admin.feedback.filters.sort')}</span>
          <select
            value={sort}
            onChange={(event) => changeSort(event.target.value as FeedbackSort)}
            className="min-w-0 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100"
          >
            <option value="category">{t('admin.feedback.sort.category')}</option>
            <option value="newest">{t('admin.feedback.sort.newest')}</option>
          </select>
        </label>
      </div>

      {loading && !data ? <Spinner label={t('admin.feedback.loading')} /> : null}
      {error ? <Alert tone="error">{t('admin.feedback.loadError')}</Alert> : null}
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {data?.submissions.length === 0 ? <EmptyState>{t('admin.feedback.empty')}</EmptyState> : null}

      {data && data.submissions.length > 0 ? (
        <ul data-testid="feedback-list" className="flex min-w-0 flex-col gap-3">
          {data.submissions.map((submission) => (
            <FeedbackRow
              key={submission.id}
              submission={submission}
              busy={busyId === submission.id}
              onStatus={changeStatus}
            />
          ))}
        </ul>
      ) : null}

      {data && data.pagination.totalPages > 1 ? (
        <nav
          aria-label={t('admin.feedback.pagination.navigation')}
          className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="text-center text-sm text-neutral-400 sm:text-left">
            {t('admin.feedback.pagination.summary', {
              page: data.pagination.page,
              pages: data.pagination.totalPages,
              total: data.pagination.total,
            })}
          </span>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              disabled={page <= 1 || loading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t('admin.feedback.pagination.previous')}
            </Button>
            <Button
              variant="secondary"
              disabled={page >= data.pagination.totalPages || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              {t('admin.feedback.pagination.next')}
            </Button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}

function FeedbackRow({
  submission,
  busy,
  onStatus,
}: {
  submission: AdminFeedbackSubmission;
  busy: boolean;
  onStatus: (id: string, status: FeedbackStatus) => Promise<void>;
}) {
  const t = useT();
  const diagnostics = diagnosticEntries(submission.context);

  return (
    <li className="min-w-0 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={CATEGORY_TONE[submission.category]}>
                {t(`admin.feedback.category.${submission.category}`)}
              </Badge>
              <Badge tone={STATUS_TONE[submission.status]}>
                {t(`admin.feedback.status.${submission.status}`)}
              </Badge>
            </div>
            {submission.subject ? (
              <h2 className="break-words text-base font-semibold text-neutral-100">
                {submission.subject}
              </h2>
            ) : null}
          </div>

          <label className="flex shrink-0 flex-col gap-1 text-xs text-neutral-400">
            <span>{t('admin.feedback.fields.status')}</span>
            <select
              aria-label={t('admin.feedback.statusControl', {
                user: submission.submitter.username,
              })}
              value={submission.status}
              disabled={busy}
              onChange={(event) =>
                void onStatus(submission.id, event.target.value as FeedbackStatus)
              }
              className="rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100"
            >
              <option value="new">{t('admin.feedback.status.new')}</option>
              <option value="triaged">{t('admin.feedback.status.triaged')}</option>
              <option value="working_on_it">{t('admin.feedback.status.working_on_it')}</option>
              <option value="saved_as_future_idea">
                {t('admin.feedback.status.saved_as_future_idea')}
              </option>
              {!['new', 'triaged', 'working_on_it', 'saved_as_future_idea'].includes(
                submission.status,
              ) ? (
                <option value={submission.status}>
                  {t(`admin.feedback.status.${submission.status}`)}
                </option>
              ) : null}
            </select>
          </label>
        </div>

        <section className="min-w-0">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
            {t('admin.feedback.fields.message')}
          </h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-200">
            {submission.message}
          </p>
        </section>

        <dl className="grid min-w-0 grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="uppercase tracking-wide text-neutral-400">
              {t('admin.feedback.fields.submittedBy')}
            </dt>
            <dd className="mt-1 min-w-0 text-neutral-200">
              <span className="block break-all">{submission.submitter.username}</span>
              <span className="block break-all text-neutral-400">{submission.submitter.email}</span>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="uppercase tracking-wide text-neutral-400">
              {t('admin.feedback.fields.createdAt')}
            </dt>
            <dd className="mt-1 text-neutral-200">{formatDateTime(submission.createdAt)}</dd>
          </div>
        </dl>

        {diagnostics.length > 0 ? (
          <section className="min-w-0 border-t border-neutral-800 pt-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
              {t('admin.feedback.diagnostics.title')}
            </h3>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {diagnostics.map(([key, value]) => (
                <div key={key} className="min-w-0 rounded-md bg-neutral-950 px-3 py-2 text-xs">
                  <dt className="text-neutral-400">{t(`admin.feedback.diagnostics.${key}`)}</dt>
                  <dd className="mt-0.5 break-words text-neutral-200">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </div>
    </li>
  );
}

function diagnosticEntries(
  context: AdminFeedbackSubmission['context'],
): Array<[key: (typeof DIAGNOSTIC_KEYS)[number], value: string]> {
  if (!context) return [];
  return DIAGNOSTIC_KEYS.flatMap((key) => {
    const value = context[key];
    if (typeof value === 'string' && value.trim() !== '') return [[key, value]];
    if (typeof value === 'number' && Number.isFinite(value)) return [[key, String(value)]];
    return [];
  });
}
