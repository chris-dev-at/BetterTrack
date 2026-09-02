import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  FEEDBACK_STATUSES,
  FEEDBACK_DECLINED_REASON_MAX_LENGTH,
  FEEDBACK_SHIPPED_VERSION_MAX_LENGTH,
  FEEDBACK_THREAD_MESSAGE_MAX_LENGTH,
  type AdminFeedbackSubmission,
  type FeedbackStatus,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import * as api from '../../lib/adminApi';
import {
  EDGE,
  EDGE_BOTTOM,
  EDGE_TOP,
  LINK,
  SURFACE_PANEL,
  SURFACE_WELL,
  TEXT_MICRO,
  TEXT_MUTED,
  TEXT_NUM,
  TEXT_SECTION,
} from '../components/tokens';
import {
  Alert,
  AsyncReadState,
  Badge,
  Button,
  EmptyState,
  KeyValueList,
  SelectField,
  TextAreaField,
  TextField,
  cx,
} from '../components/ui';
import { formatDuration } from '../formatDuration';
import { useAdminMutation } from '../useAdminMutation';
import { useResource } from '../useResource';
import { CATEGORY_TONE, STATUS_TONE, ageSeconds, diagnosticEntries } from './supportFormat';

/**
 * The right half of the Support split pane (#1406 W3) — one conversation, its
 * lifecycle controls, and just enough about the submitter to answer them.
 *
 * The status control is the point of FEEDBACK-7 (#1341): `declined` requires a
 * reason and `shipped` requires a version, and both are asked for *in the same
 * gesture* rather than discovered as a 400 after the fact. The shared contract
 * enforces the pairing server-side; this pane's job is to make writing the
 * sentence feel intended, because that sentence is what the submitter reads.
 */
export function SupportThread({
  threadId,
  onClose,
  onChanged,
}: {
  threadId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();

  /**
   * Reply drafts, keyed by submission id.
   *
   * They live HERE rather than in the composer because closing the pane
   * unmounts the composer — and losing a half-written reply to a stray Escape
   * is exactly the kind of small betrayal that makes an operator stop trusting
   * the keyboard. This component stays mounted across `threadId` changes, so a
   * draft survives closing a thread, reading another, and coming back.
   */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const setDraft = useCallback((id: string, value: string) => {
    setDrafts((current) => ({ ...current, [id]: value }));
  }, []);
  const clearDraft = useCallback((id: string) => {
    setDrafts((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const submission = useResource(
    (signal) =>
      threadId === null ? Promise.resolve(null) : api.getAdminFeedback(threadId, signal),
    [threadId],
    // Row-scoped: a 404 is "this submission is gone", not "you are not an
    // admin". The inbox pane's list read keeps the `session` policy, so a
    // genuinely de-admined operator is still signed out from this same screen.
    { notFound: 'gone' },
  );
  /**
   * Opening a thread marks it read. Fired once per id and deliberately
   * unawaited-into-the-render: the marker is idempotent, so a failure costs an
   * unread dot that the next open clears, and blocking the conversation on a
   * bookkeeping write would be the wrong trade.
   */
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (threadId === null || markedRef.current === threadId) return;
    if (submission.data === null) return;
    markedRef.current = threadId;
    void api.markAdminFeedbackRead(threadId).then(onChanged, () => {
      // A failed marker must not strand the id: let the next open retry it.
      markedRef.current = null;
    });
  }, [threadId, submission.data, onChanged]);

  if (threadId === null) {
    return (
      <section className={cx(EDGE, SURFACE_PANEL, 'p-4')}>
        <EmptyState>{t('admin.support.thread.none')}</EmptyState>
      </section>
    );
  }

  if (submission.loading || submission.error) {
    return (
      <section className={cx(EDGE, SURFACE_PANEL, 'p-4')}>
        <AsyncReadState
          loading={submission.loading}
          error={submission.error}
          retryable={submission.retryable}
          onRetry={submission.reload}
          loadingLabel={t('admin.support.thread.loading')}
        />
      </section>
    );
  }

  const row = submission.data;
  if (row === null) {
    // A link to a submission that no longer exists is a dead end unless it says
    // so and offers the way back — the operator did not mistype, the row went.
    return (
      <section className={cx(EDGE, SURFACE_PANEL, 'p-4')}>
        <EmptyState>
          <p>{t('admin.support.thread.gone')}</p>
          <p className="mt-3">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('admin.support.thread.backToInbox')}
            </Button>
          </p>
        </EmptyState>
      </section>
    );
  }

  return (
    <section className={cx(EDGE, SURFACE_PANEL, 'flex min-w-0 flex-col')}>
      <ThreadHeader
        row={row}
        onClose={onClose}
        onChanged={onChanged}
        onReloadRow={submission.reload}
      />

      <div className="grid min-w-0 gap-0 xl:grid-cols-[1fr_17rem] xl:divide-x xl:divide-neutral-800">
        <Conversation
          row={row}
          draft={drafts[row.id] ?? ''}
          onDraftChange={setDraft}
          onDraftClear={clearDraft}
          onChanged={onChanged}
        />
        <SubmitterAside row={row} />
      </div>
    </section>
  );
}

// ── Header: identity, archive, copy-as-issue, and the status control ─────────

function ThreadHeader({
  row,
  onClose,
  onChanged,
  onReloadRow,
}: {
  row: AdminFeedbackSubmission;
  onClose: () => void;
  onChanged: () => void;
  onReloadRow: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const archive = useAdminMutation(
    (archived: boolean) => api.setAdminFeedbackArchived(row.id, archived),
    {
      errorKey: 'admin.support.thread.archiveError',
      onSuccess: () => {
        onReloadRow();
        onChanged();
      },
    },
  );

  const openedAge = ageSeconds(row.createdAt);
  const changedAge = ageSeconds(row.lastStatusChangeAt);

  /**
   * "Copy as issue" is the deferred GitHub hand-off in its v1 shape: sanitized
   * Markdown on the clipboard, composed from what this pane already shows. No
   * token, no network call, and deliberately no message bodies — a support
   * conversation is not automatically issue text, and pasting one into a public
   * tracker is the operator's decision to make sentence by sentence.
   */
  async function copyAsIssue() {
    const lines = [
      `### ${row.subject ?? t('admin.support.inbox.noSubject')}`,
      '',
      row.message,
      '',
      `- ${t('admin.support.filters.category')}: ${t(`admin.feedback.category.${row.category}`)}`,
      `- ${t('admin.support.filters.status')}: ${t(`admin.feedback.status.${row.status}`)}`,
      `- ${t('admin.feedback.fields.createdAt')}: ${formatDateTime(row.createdAt)}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <header className={cx('flex flex-col gap-3 px-4 py-3', EDGE_BOTTOM)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[15px] font-semibold text-neutral-50">
            {row.subject ?? t('admin.support.inbox.noSubject')}
          </h2>
          <p className={cx(TEXT_MUTED, TEXT_NUM)}>
            {row.submitter.username}
            {' · '}
            {row.submitter.email}
            {openedAge === null ? null : (
              <>
                {' · '}
                {t('admin.support.thread.opened', { age: formatDuration(t, openedAge) })}
              </>
            )}
            {changedAge === null ? null : (
              <>
                {' · '}
                {t('admin.support.thread.lastChange', { age: formatDuration(t, changedAge) })}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={onClose}>
            {t('admin.support.thread.backToInbox')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void copyAsIssue()}>
            {copied ? t('admin.support.thread.copied') : t('admin.support.thread.copyAsIssue')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={archive.busy}
            onClick={() => void archive.run(row.archivedAt === null)}
          >
            {row.archivedAt === null ? t('admin.feedback.archive') : t('admin.feedback.unarchive')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={CATEGORY_TONE[row.category]}>
          {t(`admin.feedback.category.${row.category}`)}
        </Badge>
        <Badge tone={STATUS_TONE[row.status]}>{t(`admin.feedback.status.${row.status}`)}</Badge>
        {row.archivedAt !== null ? (
          <Badge tone="neutral">{t('admin.feedback.archived')}</Badge>
        ) : null}
        {row.deletedByUser ? (
          <Badge tone="neutral">{t('admin.feedback.deletedByUser')}</Badge>
        ) : null}
      </div>

      {archive.error === null ? null : <Alert tone="error">{archive.error}</Alert>}

      {row.deletedByUser ? (
        // The submitter has tombstoned this thread: it is gone from their rail
        // and a reply would land where nobody can read it. Say so before the
        // operator writes one.
        <Alert tone="info">{t('admin.support.thread.deletedByUserNote')}</Alert>
      ) : null}

      <StatusControl row={row} onChanged={onChanged} onReloadRow={onReloadRow} />
    </header>
  );
}

// ── The status control, with its two required-detail branches ────────────────

function StatusControl({
  row,
  onChanged,
  onReloadRow,
}: {
  row: AdminFeedbackSubmission;
  onChanged: () => void;
  onReloadRow: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<FeedbackStatus>(row.status);
  const [reason, setReason] = useState(row.declinedReason ?? '');
  const [version, setVersion] = useState(row.shippedVersion ?? '');

  // The server row is the truth; re-seed the draft whenever it changes under us.
  useEffect(() => {
    setDraft(row.status);
    setReason(row.declinedReason ?? '');
    setVersion(row.shippedVersion ?? '');
  }, [row.status, row.declinedReason, row.shippedVersion, row.id]);

  const needsReason = draft === 'declined';
  const needsVersion = draft === 'shipped';
  const reasonMissing = needsReason && reason.trim() === '';
  const versionMissing = needsVersion && version.trim() === '';

  const dirty =
    draft !== row.status ||
    (needsReason && reason.trim() !== (row.declinedReason ?? '')) ||
    (needsVersion && version.trim() !== (row.shippedVersion ?? ''));

  const apply = useAdminMutation(
    () =>
      api.updateFeedbackStatus(row.id, {
        status: draft,
        // The contract rejects a detail that does not belong to the status, so
        // these are sent only on their own branch — never as a stale leftover
        // from a status the operator moved away from.
        ...(needsReason ? { declinedReason: reason.trim() } : {}),
        ...(needsVersion ? { shippedVersion: version.trim() } : {}),
      }),
    {
      errorKey: 'admin.support.thread.statusError',
      onSuccess: () => {
        onReloadRow();
        onChanged();
      },
    },
  );

  return (
    <div className={cx('flex flex-col gap-2 border-t border-neutral-800 pt-3')}>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label={t('admin.support.thread.statusLabel')}
          name="support-status-control"
          value={draft}
          onChange={(event) => setDraft(event.target.value as FeedbackStatus)}
          options={FEEDBACK_STATUSES.map((status) => ({
            value: status,
            label: t(`admin.feedback.status.${status}`),
          }))}
        />
        <Button
          size="sm"
          // Blocked in the UI before the request goes out: an operator should
          // never learn that "declined needs a reason" from a server error.
          disabled={!dirty || reasonMissing || versionMissing || apply.busy}
          onClick={() => void apply.run()}
        >
          {t('admin.support.thread.applyStatus')}
        </Button>
      </div>

      {needsReason ? (
        <TextAreaField
          label={t('admin.support.thread.declinedReason')}
          name="support-declined-reason"
          rows={3}
          required
          maxLength={FEEDBACK_DECLINED_REASON_MAX_LENGTH}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          hint={t('admin.support.thread.submitterWillSee')}
        />
      ) : null}

      {needsVersion ? (
        <TextField
          label={t('admin.support.thread.shippedVersion')}
          name="support-shipped-version"
          required
          maxLength={FEEDBACK_SHIPPED_VERSION_MAX_LENGTH}
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          hint={t('admin.support.thread.submitterWillSee')}
        />
      ) : null}

      {reasonMissing || versionMissing ? (
        <p className="text-[12px] text-amber-400" role="status">
          {reasonMissing
            ? t('admin.support.thread.reasonRequired')
            : t('admin.support.thread.versionRequired')}
        </p>
      ) : null}

      {apply.error === null ? null : <Alert tone="error">{apply.error}</Alert>}

      {/* What the submitter currently sees for a settled outcome, quoted back. */}
      {row.status === 'declined' && row.declinedReason !== null ? (
        <p className={TEXT_MUTED}>
          {t('admin.support.thread.currentlyShown', { text: row.declinedReason })}
        </p>
      ) : null}
      {row.status === 'shipped' && row.shippedVersion !== null ? (
        <p className={TEXT_MUTED}>
          {t('admin.support.thread.currentlyShown', { text: row.shippedVersion })}
        </p>
      ) : null}
    </div>
  );
}

// ── Conversation ─────────────────────────────────────────────────────────────

/**
 * The conversation column: the submission, its replies, and the composer.
 *
 * It runs its own thread read so the component that renders the messages is the
 * one that renders their loading and failure states — a resource passed in from
 * a parent is a resource whose failure this file would not be answering for.
 */
function Conversation({
  row,
  draft,
  onDraftChange,
  onDraftClear,
  onChanged,
}: {
  row: AdminFeedbackSubmission;
  draft: string;
  onDraftChange: (id: string, value: string) => void;
  onDraftClear: (id: string) => void;
  onChanged: () => void;
}) {
  const t = useT();
  const thread = useResource((signal) => api.getAdminFeedbackThread(row.id, {}, signal), [row.id], {
    notFound: 'gone',
  });

  // Newest-first on the wire; a conversation reads oldest-first.
  const messages = useMemo(
    () => [...(thread.data?.messages ?? [])].reverse(),
    [thread.data?.messages],
  );

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4">
        {/* The submission itself is the first thing said, and is not a message. */}
        <article className={cx(EDGE, SURFACE_WELL, 'px-3 py-2')}>
          <div className={cx('mb-1 flex flex-wrap items-baseline gap-2', TEXT_MICRO)}>
            <span className="text-neutral-300">{row.submitter.username}</span>
            <span className={TEXT_NUM}>{formatDateTime(row.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] text-neutral-200">
            {row.message}
          </p>
        </article>

        {thread.loading || thread.error ? (
          <AsyncReadState
            loading={thread.loading}
            error={thread.error}
            retryable={thread.retryable}
            onRetry={thread.reload}
            loadingLabel={t('admin.support.thread.messagesLoading')}
          />
        ) : messages.length === 0 ? (
          <p className={TEXT_MUTED}>{t('admin.support.thread.noReplies')}</p>
        ) : (
          <ol className="flex min-w-0 flex-col gap-2">
            {messages.map((message) => {
              const staff = message.authorSide === 'admin';
              return (
                <li
                  key={message.id}
                  className={cx(
                    'border px-3 py-2',
                    staff
                      ? 'border-sky-900 bg-sky-950/40 lg:ml-8'
                      : 'border-neutral-800 bg-neutral-950 lg:mr-8',
                  )}
                >
                  <div className={cx('mb-1 flex flex-wrap items-baseline gap-2', TEXT_MICRO)}>
                    <span className={staff ? 'text-sky-300' : 'text-neutral-300'}>
                      {staff ? t('admin.support.thread.authorYou') : row.submitter.username}
                    </span>
                    <span className={TEXT_NUM}>{formatDateTime(message.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[13px] text-neutral-200">
                    {message.body}
                  </p>
                </li>
              );
            })}
          </ol>
        )}

        {thread.data?.nextCursor ? (
          // Paging older messages is not built; say so rather than silently
          // truncating a conversation the operator is trying to read.
          <p className={TEXT_MUTED}>{t('admin.support.thread.olderTruncated')}</p>
        ) : null}
      </div>
      <ReplyComposer
        row={row}
        draft={draft}
        onDraftChange={onDraftChange}
        onSent={() => {
          onDraftClear(row.id);
          thread.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function ReplyComposer({
  row,
  draft,
  onDraftChange,
  onSent,
}: {
  row: AdminFeedbackSubmission;
  draft: string;
  onDraftChange: (id: string, value: string) => void;
  onSent: () => void;
}) {
  const t = useT();
  const body = draft;

  const send = useAdminMutation(() => api.sendAdminFeedbackReply(row.id, { body: body.trim() }), {
    errorKey: 'admin.support.thread.replyError',
    onSuccess: onSent,
  });

  const tooLong = body.length > FEEDBACK_THREAD_MESSAGE_MAX_LENGTH;
  const empty = body.trim() === '';

  return (
    <div className={cx('flex flex-col gap-2 px-4 py-3', EDGE_TOP)}>
      <TextAreaField
        label={t('admin.support.thread.replyLabel', { user: row.submitter.username })}
        name="support-reply"
        rows={3}
        value={body}
        onChange={(event) => onDraftChange(row.id, event.target.value)}
        placeholder={t('admin.support.thread.replyPlaceholder')}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={cx(TEXT_MUTED, TEXT_NUM)}>
          {t('admin.support.thread.replyCount', {
            count: body.length,
            max: FEEDBACK_THREAD_MESSAGE_MAX_LENGTH,
          })}
        </span>
        <Button size="sm" disabled={empty || tooLong || send.busy} onClick={() => void send.run()}>
          {t('admin.support.thread.sendReply')}
        </Button>
      </div>
      {send.error === null ? null : <Alert tone="error">{send.error}</Alert>}
    </div>
  );
}

// ── Submitter context ────────────────────────────────────────────────────────

function SubmitterAside({ row }: { row: AdminFeedbackSubmission }) {
  const t = useT();
  const history = useResource(
    (signal) => api.getUserSupport(row.submitter.id, signal),
    [row.submitter.id],
  );
  const diagnostics = diagnosticEntries(row.context);

  return (
    <aside className="flex min-w-0 flex-col gap-4 px-4 py-4">
      <div>
        <h3 className={TEXT_SECTION}>{t('admin.support.thread.submitter')}</h3>
        <div className="mt-2">
          <KeyValueList
            rows={[
              { label: t('admin.support.thread.account'), value: row.submitter.username },
              {
                label: t('admin.support.thread.openTickets'),
                value: history.data === null ? '—' : history.data.openCount,
              },
              {
                label: t('admin.support.thread.totalTickets'),
                value: history.data === null ? '—' : history.data.total,
              },
            ]}
          />
        </div>
        {/* The People workspace owns the account; this is the seam to it. */}
        <Link
          className={cx(LINK, 'mt-2 inline-block text-[12px]')}
          to={`/admin/users/${row.submitter.id}`}
        >
          {t('admin.support.thread.openInPeople')}
        </Link>
      </div>

      <div>
        <h3 className={TEXT_SECTION}>{t('admin.support.thread.history')}</h3>
        {history.loading || history.error ? (
          <div className="mt-2">
            <AsyncReadState
              loading={history.loading}
              error={history.error}
              retryable={history.retryable}
              onRetry={history.reload}
              loadingLabel={t('admin.userDetail.support.loading')}
            />
          </div>
        ) : (history.data?.items.length ?? 0) === 0 ? (
          <p className={cx('mt-2', TEXT_MUTED)}>{t('admin.support.thread.historyEmpty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {(history.data?.items ?? [])
              .filter((item) => item.id !== row.id)
              .slice(0, 6)
              .map((item) => (
                <li key={item.id} className={cx('truncate', TEXT_MUTED)}>
                  {item.subject ?? t('admin.support.inbox.noSubject')}
                </li>
              ))}
          </ul>
        )}
      </div>

      {diagnostics.length > 0 ? (
        <div>
          <h3 className={TEXT_SECTION}>{t('admin.feedback.diagnostics.title')}</h3>
          <div className="mt-2">
            <KeyValueList
              rows={diagnostics.map(([key, value]) => ({
                label: t(`admin.feedback.diagnostics.${key}`),
                value,
              }))}
            />
          </div>
          <p className={cx('mt-2', TEXT_MUTED)}>{t('admin.support.thread.diagnosticsNote')}</p>
        </div>
      ) : null}
    </aside>
  );
}
