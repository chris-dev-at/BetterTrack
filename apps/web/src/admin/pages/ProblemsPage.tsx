import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  PROBLEM_KINDS,
  PROBLEM_STATUSES,
  problemContextSchema,
  type Problem,
  type ProblemContext,
  type ProblemKind,
  type ProblemListResponse,
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

/**
 * Rows per request. The list is paged rather than "the newest 50, forever":
 * nothing but a resolve ever took a row out of the default view, so before
 * paging every row past the first page was unreachable AND unresolvable.
 */
const PAGE_SIZE = 25;

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

  // `offset` is the page currently being fetched; `rows` is everything loaded
  // so far. A filter change resets both — a page of `error` rows must never be
  // appended under a `job` filter.
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<Problem[]>([]);
  useEffect(() => {
    setOffset(0);
    setRows([]);
  }, [kind, status]);

  const resource = useResource(
    (signal) =>
      api.listProblems(
        {
          ...(kind === 'all' ? {} : { kind }),
          ...(status === 'all' ? {} : { status }),
          limit: PAGE_SIZE,
          offset,
        },
        signal,
      ),
    [kind, status, offset],
  );
  const { data, loading, error, reload } = resource;

  // Apply each response ONCE: `offset` changes a render before its response
  // arrives, and re-running on the previous page's data would append it twice.
  const applied = useRef<ProblemListResponse | null>(null);
  useEffect(() => {
    if (data === null || applied.current === data) return;
    applied.current = data;
    setRows((current) =>
      offset === 0 ? data.problems : [...current.slice(0, offset), ...data.problems],
    );
  }, [data, offset]);

  const live = useLiveRefresh(reload);

  // The mutation patches its own row from the response, so a resolve deep in
  // the list is reflected without collapsing the loaded pages back to the
  // first; the reload behind it refreshes the counts and the current page.
  const patchRow = useCallback((updated: Problem) => {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
  }, []);

  const resolve = useAdminMutation(async (id: string) => patchRow(await api.resolveProblem(id)), {
    errorKey: 'admin.problems.actionError',
    onSuccess: reload,
  });
  const reopen = useAdminMutation(async (id: string) => patchRow(await api.reopenProblem(id)), {
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
          {data && data.total > rows.length ? (
            <span className={cx(TEXT_MICRO, 'pb-2')}>
              {t('admin.problems.shownCount', { shown: rows.length, total: data.total })}
            </span>
          ) : null}
        </div>
      </Panel>

      {/* The capture budget refused rows in this window: what is listed below
          is then a TRUNCATED incident, and reading it as the whole one is the
          exact mistake this banner exists to prevent. */}
      {data && data.droppedCaptures > 0 ? (
        <Alert tone="info">{t('admin.problems.dropped', { count: data.droppedCaptures })}</Alert>
      ) : null}

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

        {data && rows.length === 0 ? <EmptyState>{t('admin.problems.empty')}</EmptyState> : null}

        {rows.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {rows.map((problem) => (
              <ProblemRow
                busy={resolve.isPending(problem.id) || reopen.isPending(problem.id)}
                key={problem.id}
                onMutate={mutate}
                problem={problem}
              />
            ))}
          </ul>
        ) : null}

        {data?.hasMore ? (
          <div className="mt-3 flex justify-center">
            <Button
              disabled={loading}
              onClick={() => setOffset(rows.length)}
              size="sm"
              variant="secondary"
            >
              {t('admin.problems.loadMore')}
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** Context keys the row renders itself, so they are not repeated in the JSON. */
const RENDERED_CONTEXT_KEYS = new Set(['method', 'route', 'status', 'requestId', 'stack']);

/**
 * Split the stored context into the request facts the row renders as their own
 * lines, the stack it collapses, and whatever else is left for the JSON block.
 * Parsed through the contract schema rather than cast: `context` is `jsonb`, so
 * an older row (captured before the request facts existed) simply has none.
 */
function readContext(context: unknown): {
  detail: ProblemContext | null;
  rest: Record<string, unknown> | null;
} {
  const parsed = problemContextSchema.safeParse(context);
  if (!parsed.success) return { detail: null, rest: null };
  // The known keys get their own lines; `rest` is everything a non-request
  // capture kind (job/provider/import) carries, shown as JSON below.
  const rest = Object.fromEntries(
    Object.entries(parsed.data).filter(([key]) => !RENDERED_CONTEXT_KEYS.has(key)),
  );
  return { detail: parsed.data, rest: Object.keys(rest).length > 0 ? rest : null };
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
  const { detail, rest } = readContext(problem.context);
  const stack = detail?.stack ?? null;

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
                {/* A problem an admin cleared that then happened again: the
                    capture reopened it, and it must READ as a regression rather
                    than as one more open row. */}
                {problem.regressed ? (
                  <Badge tone="red">{t('admin.problems.regressed')}</Badge>
                ) : null}
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
              // The request facts first: for an unhandled 500 they are what
              // names the broken endpoint, and `requestId` is the handle back
              // to the log line for the same request.
              ...(detail?.route
                ? [
                    {
                      label: t('admin.problems.route'),
                      value: (
                        <span className={TEXT_MONO}>
                          {detail.method ? `${detail.method} ` : ''}
                          {detail.route}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(typeof detail?.status === 'number'
                ? [
                    {
                      label: t('admin.problems.httpStatus'),
                      value: <span className={TEXT_NUM}>{detail.status}</span>,
                    },
                  ]
                : []),
              ...(detail?.requestId
                ? [
                    {
                      label: t('admin.problems.requestId'),
                      value: <span className={TEXT_MONO}>{detail.requestId}</span>,
                    },
                  ]
                : []),
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

          {/* Collapsed, never inline: the stack is the thing to hand a
              developer, and expanded by default it would bury every other row
              on the page. */}
          {stack ? (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">
                {t('admin.problems.stack')}
              </summary>
              <pre className="mt-2 overflow-x-auto border border-neutral-800 bg-neutral-950 p-3 text-neutral-300">
                {stack}
              </pre>
            </details>
          ) : null}

          {rest !== null || (detail === null && problem.context != null) ? (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200">
                {t('admin.problems.context')}
              </summary>
              <pre className="mt-2 overflow-x-auto border border-neutral-800 bg-neutral-950 p-3 text-neutral-300">
                {JSON.stringify(rest ?? problem.context, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </Panel>
    </li>
  );
}
