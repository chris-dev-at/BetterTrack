import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  PROBLEM_KINDS,
  PROBLEM_STATUSES,
  type Problem,
  type ProblemKind,
  type ProblemStatus,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { useAdminMutation } from '../useAdminMutation';
import { useLiveRefresh } from '../useLiveRefresh';
import { useResource } from '../useResource';
import { LiveRefreshControl } from '../components/LiveRefreshControl';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import { TEXT_MICRO, TEXT_MONO, TEXT_MUTED, TEXT_NUM, type Tone } from '../components/tokens';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  KeyValueList,
  PageHeader,
  Panel,
  SelectField,
  Spinner,
  cx,
} from '../components/ui';

const KIND_TONE: Record<ProblemKind, Tone> = {
  error: 'red',
  job: 'amber',
  provider: 'sky',
};

type KindFilter = ProblemKind | 'all';
type StatusFilter = ProblemStatus | 'all';

const DEFAULT_STATUS: StatusFilter = 'open';

function readKind(raw: string | null): KindFilter {
  return raw !== null && (PROBLEM_KINDS as readonly string[]).includes(raw)
    ? (raw as ProblemKind)
    : 'all';
}

function readStatus(raw: string | null): StatusFilter {
  if (raw === 'all') return 'all';
  return raw !== null && (PROBLEM_STATUSES as readonly string[]).includes(raw)
    ? (raw as ProblemStatus)
    : DEFAULT_STATUS;
}

/**
 * Operations → Problems (§13.5 V5-P2 arc (d); folded into the W4 workspace).
 *
 * The capture and the resolve/reopen flow are unchanged — both are already
 * audit-logged in `problemService`, which is exactly why they survive the
 * "read-only unless the action already exists and is audited" rule W4 works
 * under. What W4 changes is the surroundings: the workspace tab strip, the
 * sharp token layer, filters that live in the URL (so a triage view is a link a
 * second operator can open), and the shared `useAdminMutation` seam in place of
 * the page's own `busyId`/`setActionError` pair.
 */
export function ProblemsPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();

  const kind = readKind(params.get('kind'));
  const status = readStatus(params.get('status'));

  const patchQuery = useCallback(
    (patch: Record<string, string | null>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const resource = useResource(
    (signal) =>
      api.listProblems(
        {
          ...(kind === 'all' ? {} : { kind }),
          ...(status === 'all' ? {} : { status }),
        },
        signal,
      ),
    [kind, status],
  );
  const { data, loading, error, reload } = resource;

  const live = useLiveRefresh(reload);

  const resolve = useAdminMutation((id: string) => api.resolveProblem(id), {
    errorKey: 'admin.problems.actionError',
    onSuccess: reload,
  });
  const reopen = useAdminMutation((id: string) => api.reopenProblem(id), {
    errorKey: 'admin.problems.actionError',
    onSuccess: reload,
  });

  const mutate = useCallback(
    (id: string, next: ProblemStatus) => {
      void (next === 'resolved' ? resolve.runFor(id, id) : reopen.runFor(id, id));
    },
    [resolve, reopen],
  );

  const counts =
    loading || error !== null || !data?.openCount
      ? undefined
      : { '/admin/problems': data.openCount };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        actions={<LiveRefreshControl busy={loading} live={live} />}
        description={t('admin.problems.subtitle')}
        eyebrow={t('admin.nav.sections.operations')}
        title={t('admin.problems.title')}
      />

      <WorkspaceTabs {...(counts ? { counts } : {})} />

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            label={t('admin.problems.filters.kind')}
            onChange={(event) =>
              patchQuery({ kind: event.target.value === 'all' ? null : event.target.value })
            }
            options={[
              { value: 'all', label: t('admin.problems.filters.all') },
              ...PROBLEM_KINDS.map((value) => ({
                value,
                label: t(`admin.problems.kind.${value}`),
              })),
            ]}
            value={kind}
          />
          <SelectField
            label={t('admin.problems.filters.status')}
            onChange={(event) =>
              patchQuery({
                status: event.target.value === DEFAULT_STATUS ? null : event.target.value,
              })
            }
            options={[
              { value: 'all', label: t('admin.problems.filters.all') },
              ...PROBLEM_STATUSES.map((value) => ({
                value,
                label: t(`admin.problems.status.${value}`),
              })),
            ]}
            value={status}
          />
          {data ? (
            <span className={cx(TEXT_MICRO, 'pb-2')}>
              {t('admin.problems.openCount', { count: data.openCount })}
            </span>
          ) : null}
        </div>
      </Panel>

      {resolve.error ? <Alert tone="error">{resolve.error}</Alert> : null}
      {reopen.error ? <Alert tone="error">{reopen.error}</Alert> : null}

      <section aria-busy={loading} aria-label={t('admin.problems.title')}>
        {loading && data === null ? <Spinner /> : null}
        {/* Keeps the page's own wording rather than the generic read banner:
            "couldn't load problems" is what an operator needs to read here, and
            it is the copy this surface has always shown. */}
        {error ? (
          <Alert tone="error">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('admin.problems.loadError')}</span>
              <Button onClick={reload} size="sm" variant="secondary">
                {t('common.retry')}
              </Button>
            </div>
          </Alert>
        ) : null}

        {data && data.problems.length === 0 ? (
          <EmptyState>{t('admin.problems.empty')}</EmptyState>
        ) : null}

        {data && data.problems.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {data.problems.map((problem) => (
              <ProblemRow
                busy={resolve.isPending(problem.id) || reopen.isPending(problem.id)}
                key={problem.id}
                onMutate={mutate}
                problem={problem}
              />
            ))}
          </ul>
        ) : null}
      </section>
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
    <li>
      <Panel padded={false}>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={KIND_TONE[problem.kind]}>
                  {t(`admin.problems.kind.${problem.kind}`)}
                </Badge>
                <Badge tone={problem.status === 'open' ? 'amber' : 'green'}>
                  {t(`admin.problems.status.${problem.status}`)}
                </Badge>
                <span className="text-[13px] font-medium text-neutral-100">{problem.title}</span>
              </div>
              {problem.message ? (
                <p className={cx('break-words', TEXT_MUTED)}>{problem.message}</p>
              ) : null}
            </div>
            <div className="shrink-0">
              {problem.status === 'open' ? (
                <Button
                  disabled={busy}
                  onClick={() => onMutate(problem.id, 'resolved')}
                  size="sm"
                  variant="secondary"
                >
                  {t('admin.problems.resolve')}
                </Button>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => onMutate(problem.id, 'open')}
                  size="sm"
                  variant="ghost"
                >
                  {t('admin.problems.reopen')}
                </Button>
              )}
            </div>
          </div>

          <KeyValueList
            rows={[
              {
                label: t('admin.problems.occurrencesLabel'),
                value: <span className={TEXT_NUM}>{problem.occurrenceCount}</span>,
              },
              {
                label: t('admin.problems.firstSeen'),
                value: new Date(problem.firstSeenAt).toLocaleString(),
              },
              {
                label: t('admin.problems.lastSeen'),
                value: new Date(problem.lastSeenAt).toLocaleString(),
              },
              {
                label: t('admin.problems.fingerprint'),
                value: <span className={TEXT_MONO}>{problem.fingerprint}</span>,
              },
            ]}
          />

          {problem.context != null ? (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">
                {t('admin.problems.context')}
              </summary>
              <pre className="mt-2 overflow-x-auto border border-neutral-800 bg-neutral-950 p-3 text-neutral-300">
                {JSON.stringify(problem.context, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </Panel>
    </li>
  );
}
