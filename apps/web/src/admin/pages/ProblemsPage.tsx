import { useCallback, useState } from 'react';

import type { Problem, ProblemKind, ProblemStatus } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useResource } from '../useResource';
import { Alert, Badge, Button, PageHeader, Spinner } from '../components/ui';

const KIND_TONE: Record<ProblemKind, 'red' | 'amber' | 'sky'> = {
  error: 'red',
  job: 'amber',
  provider: 'sky',
};

type KindFilter = ProblemKind | 'all';
type StatusFilter = ProblemStatus | 'all';

/**
 * Admin Problems page (PROJECTPLAN.md §13.5 V5-P2 arc (d), the Sentry
 * replacement). Lists captured problems — unhandled errors, permanently-failed
 * jobs and provider failures — next to Health, with kind/status filters,
 * occurrence counts, an expandable detail (scrubbed message + context) and a
 * resolve/reopen flow. All copy is localized through `admin.problems.*`.
 */
export function ProblemsPage() {
  const t = useT();
  const [kind, setKind] = useState<KindFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const resource = useResource(
    (signal) =>
      api.listProblems(
        {
          kind: kind === 'all' ? undefined : kind,
          status: status === 'all' ? undefined : status,
        },
        signal,
      ),
    [kind, status],
  );
  const { data, loading, error, reload } = resource;

  const mutate = useCallback(
    async (id: string, next: ProblemStatus) => {
      setBusyId(id);
      setActionError(null);
      try {
        if (next === 'resolved') await api.resolveProblem(id);
        else await api.reopenProblem(id);
        reload();
      } catch {
        setActionError(t('admin.problems.actionError'));
      } finally {
        setBusyId(null);
      }
    },
    [reload, t],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <PageHeader title={t('admin.problems.title')} description={t('admin.problems.subtitle')} />
        <Button variant="secondary" className="self-start" onClick={reload}>
          {t('admin.problems.refresh')}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          <span className="uppercase tracking-wide text-neutral-500">
            {t('admin.problems.filters.kind')}
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as KindFilter)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
          >
            <option value="all">{t('admin.problems.filters.all')}</option>
            <option value="error">{t('admin.problems.kind.error')}</option>
            <option value="job">{t('admin.problems.kind.job')}</option>
            <option value="provider">{t('admin.problems.kind.provider')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          <span className="uppercase tracking-wide text-neutral-500">
            {t('admin.problems.filters.status')}
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100"
          >
            <option value="all">{t('admin.problems.filters.all')}</option>
            <option value="open">{t('admin.problems.status.open')}</option>
            <option value="resolved">{t('admin.problems.status.resolved')}</option>
          </select>
        </label>
        {data ? (
          <span className="text-xs text-neutral-400">
            {t('admin.problems.openCount', { count: data.openCount })}
          </span>
        ) : null}
      </div>

      {loading && !data ? <Spinner label={t('common.loading')} /> : null}
      {error ? <Alert tone="error">{t('admin.problems.loadError')}</Alert> : null}
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}

      {data && data.problems.length === 0 ? (
        <p className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-6 text-center text-sm text-neutral-400">
          {t('admin.problems.empty')}
        </p>
      ) : null}

      {data && data.problems.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {data.problems.map((problem) => (
            <ProblemRow
              key={problem.id}
              problem={problem}
              busy={busyId === problem.id}
              onMutate={mutate}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ProblemRow({
  problem,
  busy,
  onMutate,
}: {
  problem: Problem;
  busy: boolean;
  onMutate: (id: string, next: ProblemStatus) => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[problem.kind]}>{t(`admin.problems.kind.${problem.kind}`)}</Badge>
            <Badge tone={problem.status === 'open' ? 'amber' : 'green'}>
              {t(`admin.problems.status.${problem.status}`)}
            </Badge>
            <span className="text-sm font-medium text-neutral-100">{problem.title}</span>
          </div>
          {problem.message ? (
            <p className="break-words text-xs text-neutral-400">{problem.message}</p>
          ) : null}
        </div>
        <div className="shrink-0">
          {problem.status === 'open' ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => onMutate(problem.id, 'resolved')}
            >
              {t('admin.problems.resolve')}
            </Button>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => onMutate(problem.id, 'open')}>
              {t('admin.problems.reopen')}
            </Button>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs text-neutral-400 sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide text-neutral-500">
            {t('admin.problems.occurrencesLabel')}
          </dt>
          <dd className="text-neutral-200">{problem.occurrenceCount}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide text-neutral-500">
            {t('admin.problems.firstSeen')}
          </dt>
          <dd className="text-neutral-200">{new Date(problem.firstSeenAt).toLocaleString()}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide text-neutral-500">
            {t('admin.problems.lastSeen')}
          </dt>
          <dd className="text-neutral-200">{new Date(problem.lastSeenAt).toLocaleString()}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="uppercase tracking-wide text-neutral-500">
            {t('admin.problems.fingerprint')}
          </dt>
          <dd className="truncate font-mono text-neutral-300">{problem.fingerprint}</dd>
        </div>
      </dl>

      {problem.context != null ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">
            {t('admin.problems.context')}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-neutral-950 p-3 text-neutral-300">
            {JSON.stringify(problem.context, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}
