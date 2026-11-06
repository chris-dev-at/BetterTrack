import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import {
  FEEDBACK_THREAD_CURSOR_UNKNOWN,
  FEEDBACK_THREAD_MESSAGE_MAX_LENGTH,
  type FeedbackStatus,
  type FeedbackThreadResponse,
  type MyFeedbackResponse,
  type MyFeedbackSubmission,
} from '@bettertrack/contracts';

import { useT, type TranslateFn } from '../../../i18n';
import { ApiError } from '../../../lib/apiClient';
import { formatDateTime } from '../../../lib/format';
import {
  getFeedbackThread,
  listMyFeedback,
  markFeedbackRead,
  sendFeedbackMessage,
  withdrawFeedback,
} from '../../../lib/feedbackApi';
import { Badge, Button, Textarea, type BadgeTone } from '../../../ui/origin';
import { AsyncReadState } from '../../components/AsyncReadState';
import { Alert } from '../../components/ui';
import { PanelNote } from './panelKit';
import {
  MY_FEEDBACK_QUERY_KEY,
  feedbackThreadQueryKey,
  unreadReplyCountOf,
  withUnreadReplyCount,
  withoutSubmission,
} from './myFeedbackCache';

/**
 * `/control/feedback?submission=<id>` opens that submission's conversation.
 * Notifications and e-mails about a status change or a reply link here, so the
 * parameter is a public contract: rename it only together with every producer.
 */
export const FEEDBACK_SUBMISSION_PARAM = 'submission';

/** The API caps one thread page at 100; half keeps a first paint light. */
const THREAD_PAGE_SIZE = 50;

function statusTone(status: FeedbackStatus): BadgeTone {
  switch (status) {
    case 'declined':
      return 'neg';
    case 'shipped':
      return 'pos';
    case 'working_on_it':
      return 'gold';
    case 'triaged':
      return 'blue';
    case 'new':
    case 'saved_as_future_idea':
      return 'neutral';
  }
}

/**
 * The fact that closes the loop, when there is one: a declined submission's
 * reason, a shipped one's version. It is the row's headline, never a detail.
 */
function outcomeHeadline(submission: MyFeedbackSubmission, t: TranslateFn): string | null {
  if (submission.status === 'declined' && submission.declinedReason) {
    return t('feedback.status.declinedWithReason', { reason: submission.declinedReason });
  }
  if (submission.status === 'shipped' && submission.shippedVersion) {
    return t('feedback.status.shippedWithVersion', { version: submission.shippedVersion });
  }
  return null;
}

function submissionTitle(submission: MyFeedbackSubmission): string {
  return submission.subject ?? submission.message;
}

function unreadRepliesLabel(count: number, t: TranslateFn): string {
  return t(count === 1 ? 'feedback.unreadRepliesOne' : 'feedback.unreadRepliesOther', { count });
}

function StatusBadge({ status }: { status: FeedbackStatus }) {
  const t = useT();
  return (
    <Badge data-status={status} tone={statusTone(status)}>
      {t(`feedback.status.${status}`)}
    </Badge>
  );
}

function SubmissionMeta({ submission }: { submission: MyFeedbackSubmission }) {
  const t = useT();
  return (
    <span className="bt-cc-list__meta">
      {t(`feedback.categoryOption.${submission.category}`)}
      {' · '}
      {t('feedback.submittedAt', { date: formatDateTime(submission.createdAt) })}
      {' · '}
      {t('feedback.lastStatusChange', { date: formatDateTime(submission.lastStatusChangeAt) })}
    </span>
  );
}

// ─── List ────────────────────────────────────────────────────────────────────

function SubmissionRow({
  submission,
  onOpen,
  onWithdrawn,
}: {
  submission: MyFeedbackSubmission;
  onOpen: (id: string) => void;
  onWithdrawn: (id: string) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const withdrawRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreWithdrawFocus = useRef(false);
  const headline = outcomeHeadline(submission, t);
  const title = submissionTitle(submission);

  const withdraw = useMutation({
    mutationFn: () => withdrawFeedback(submission.id),
    onSuccess: () => {
      queryClient.setQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY, (current) =>
        withoutSubmission(current, submission.id),
      );
      queryClient.removeQueries({ queryKey: feedbackThreadQueryKey(submission.id) });
      void queryClient.invalidateQueries({ queryKey: MY_FEEDBACK_QUERY_KEY });
      onWithdrawn(submission.id);
    },
  });

  // The Withdraw button and the confirmation swap places, so the element that
  // held focus leaves the DOM. Hand focus to the counterpart explicitly.
  useLayoutEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
    } else if (restoreWithdrawFocus.current) {
      restoreWithdrawFocus.current = false;
      withdrawRef.current?.focus();
    }
  }, [confirming]);

  return (
    <li className="bt-cc-list__item" data-testid="feedback-submission-row">
      <div className="bt-cc-list__main">
        <button
          className="flex min-w-0 flex-col items-start gap-1 text-left"
          data-feedback-open={submission.id}
          onClick={() => onOpen(submission.id)}
          type="button"
        >
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={submission.status} />
            {submission.unreadReplyCount > 0 ? (
              <Badge data-testid="feedback-unread-badge" tone="blue">
                {unreadRepliesLabel(submission.unreadReplyCount, t)}
              </Badge>
            ) : null}
          </span>
          {headline ? (
            <span className="bt-cc-row__label break-words" data-testid="feedback-outcome">
              {headline}
            </span>
          ) : null}
          <span
            className={
              headline
                ? 'bt-cc-row__hint line-clamp-2 break-words'
                : 'bt-cc-row__label line-clamp-2 break-words'
            }
          >
            {title}
          </span>
          <SubmissionMeta submission={submission} />
        </button>
      </div>
      <div className="bt-cc-list__actions">
        {confirming ? null : (
          <Button
            aria-label={t('feedback.withdrawAria', { title })}
            onClick={() => {
              withdraw.reset();
              setConfirming(true);
            }}
            ref={withdrawRef}
            size="sm"
            variant="danger"
          >
            {t('feedback.withdraw')}
          </Button>
        )}
      </div>
      {confirming ? (
        <div className="flex w-full flex-col gap-2">
          <PanelNote warn>{t('feedback.withdrawConfirm')}</PanelNote>
          {withdraw.isError ? <Alert tone="error">{t('feedback.withdrawError')}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={withdraw.isPending}
              onClick={() => withdraw.mutate()}
              size="sm"
              variant="danger"
            >
              {withdraw.isPending ? t('feedback.withdrawing') : t('feedback.withdrawConfirmAction')}
            </Button>
            <Button
              disabled={withdraw.isPending}
              onClick={() => {
                restoreWithdrawFocus.current = true;
                setConfirming(false);
              }}
              ref={cancelRef}
              size="sm"
              variant="quiet"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The list read as the views consume it. The container owns the one `useQuery`
 * and hands its loading / error state down explicitly, so the read site itself
 * shows that both states reach the screen (the v5SurfaceInventory async-state
 * gate reads them there, not through a forwarded query object).
 */
interface MyFeedbackListRead {
  data: MyFeedbackResponse | undefined;
  loading: boolean;
  error: Error | null;
  retry: () => void;
}

function SubmissionList({
  list,
  onOpen,
  returnFocusTo,
}: {
  list: MyFeedbackListRead;
  onOpen: (id: string) => void;
  /** The row whose thread was just closed — its open button gets focus back. */
  returnFocusTo: RefObject<string | null>;
}) {
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [announcement, setAnnouncement] = useState('');
  // A failed BACKGROUND refetch keeps the rows already on screen; only a list
  // that never loaded gives way to the loading / error state.
  const submissions = list.data?.submissions;

  useLayoutEffect(() => {
    const id = returnFocusTo.current;
    if (id === null || !submissions) return;
    returnFocusTo.current = null;
    // Matched by dataset rather than a selector: the id came from the URL.
    const row = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[data-feedback-open]') ?? [],
    ).find((button) => button.dataset.feedbackOpen === id);
    (row ?? headingRef.current)?.focus();
  }, [returnFocusTo, submissions]);

  const onWithdrawn = useCallback(
    (_id: string) => {
      setAnnouncement(t('feedback.withdrawn'));
      // The row that held focus is gone; the group heading is the stable anchor.
      headingRef.current?.focus();
    },
    [t],
  );

  return (
    <section className="bt-cc-group" aria-labelledby="feedback-my-submissions-heading">
      <h3
        className="bt-cc-group__label"
        id="feedback-my-submissions-heading"
        ref={headingRef}
        tabIndex={-1}
      >
        {t('feedback.mySubmissionsTitle')}
      </h3>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      <div className="bt-cc-rows">
        {submissions === undefined ? (
          <div className="bt-cc-row bt-cc-row--stack">
            <AsyncReadState
              error={list.error}
              errorLabel={t('feedback.mySubmissionsLoadError')}
              loading={list.loading}
              loadingLabel={t('feedback.mySubmissionsLoading')}
              onRetry={list.retry}
              unavailableLabel={t('feedback.mySubmissionsUnavailable')}
            />
          </div>
        ) : submissions.length === 0 ? (
          <div className="bt-cc-row bt-cc-row--stack" data-testid="feedback-submissions-empty">
            <span className="bt-cc-row__label">{t('feedback.mySubmissionsEmptyTitle')}</span>
            <span className="bt-cc-row__hint">{t('feedback.mySubmissionsEmptyDescription')}</span>
          </div>
        ) : (
          <ul aria-label={t('feedback.mySubmissionsListAria')} className="bt-cc-list" ref={listRef}>
            {submissions.map((submission) => (
              <SubmissionRow
                key={submission.id}
                onOpen={onOpen}
                onWithdrawn={onWithdrawn}
                submission={submission}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ─── Thread ──────────────────────────────────────────────────────────────────

function isUnknownCursor(error: unknown): boolean {
  return error instanceof ApiError && error.code === FEEDBACK_THREAD_CURSOR_UNKNOWN;
}

function Conversation({ submission }: { submission: MyFeedbackSubmission }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const key = feedbackThreadQueryKey(submission.id);
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      getFeedbackThread(submission.id, { cursor: pageParam, limit: THREAD_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: false,
  });

  // A cursor the server no longer recognises (a stale page after the thread
  // changed under us) is answered with a 400 rather than page one. Start over
  // from the newest page instead of looping on the dead cursor.
  const unknownCursor = isUnknownCursor(query.error);
  useEffect(() => {
    if (!unknownCursor) return;
    void queryClient.resetQueries({ queryKey: feedbackThreadQueryKey(submission.id), exact: true });
  }, [unknownCursor, queryClient, submission.id]);

  // The endpoint pages newest-first. Read the whole conversation oldest-first.
  const messages = useMemo(
    () => [...(query.data?.pages ?? []).flatMap((page) => page.messages)].reverse(),
    [query.data],
  );

  const reply = useMutation({
    mutationFn: (body: string) => sendFeedbackMessage(submission.id, { body }),
    onSuccess: ({ message }) => {
      setDraft('');
      const current = queryClient.getQueryData<InfiniteData<FeedbackThreadResponse>>(key);
      const firstPage = current?.pages[0];
      if (!current || !firstPage) {
        void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      if (firstPage.messages.some((row) => row.id === message.id)) return;
      queryClient.setQueryData<InfiniteData<FeedbackThreadResponse>>(key, {
        ...current,
        pages: [
          { ...firstPage, messages: [message, ...firstPage.messages] },
          ...current.pages.slice(1),
        ],
      });
    },
  });

  const trimmedDraft = draft.trim();
  const loaded = query.data !== undefined;

  return (
    <>
      {query.isPending || (query.isError && !loaded) ? (
        <div className="bt-cc-row bt-cc-row--stack">
          <AsyncReadState
            error={unknownCursor ? null : query.error}
            errorLabel={t('feedback.threadLoadError')}
            loading={query.isPending || unknownCursor}
            loadingLabel={t('feedback.threadLoading')}
            onRetry={() => void query.refetch()}
            unavailableLabel={t('feedback.threadUnavailable')}
          />
        </div>
      ) : (
        <div
          aria-label={t('feedback.threadLogAria')}
          className="bt-cc-row bt-cc-row--stack"
          role="log"
        >
          {query.hasNextPage ? (
            <Button
              className="self-center"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              size="sm"
              variant="quiet"
            >
              {query.isFetchingNextPage ? t('common.loading') : t('feedback.loadEarlier')}
            </Button>
          ) : null}
          {query.isFetchNextPageError && !unknownCursor ? (
            <Alert tone="error">{t('feedback.threadLoadError')}</Alert>
          ) : null}
          {messages.length === 0 ? (
            <PanelNote>{t('feedback.threadEmpty')}</PanelNote>
          ) : (
            <ol className="bt-cc-list">
              {messages.map((message) => (
                <li
                  className="bt-cc-list__item"
                  data-author={message.authorSide}
                  data-testid="feedback-thread-message"
                  key={message.id}
                >
                  <div className="bt-cc-list__main">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="bt-cc-row__label">
                        {t(
                          message.authorSide === 'admin'
                            ? 'feedback.threadAuthorAdmin'
                            : 'feedback.threadAuthorYou',
                        )}
                      </span>
                      <span className="bt-cc-list__meta">{formatDateTime(message.createdAt)}</span>
                    </span>
                    <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <form
        className="bt-cc-row bt-cc-row--stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedDraft.length > 0 && loaded && !reply.isPending) reply.mutate(trimmedDraft);
        }}
      >
        <label className="bt-cc-row__label" htmlFor={`feedback-reply-${submission.id}`}>
          {t('feedback.reply')}
        </label>
        <Textarea
          id={`feedback-reply-${submission.id}`}
          maxLength={FEEDBACK_THREAD_MESSAGE_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('feedback.replyPlaceholder')}
          rows={3}
          value={draft}
        />
        {reply.isError ? <Alert tone="error">{t('feedback.replyError')}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={trimmedDraft.length === 0 || reply.isPending || !loaded}
            type="submit"
            variant="primary"
          >
            {reply.isPending ? t('feedback.sendingReply') : t('feedback.sendReply')}
          </Button>
        </div>
      </form>
    </>
  );
}

function ThreadView({
  feedbackId,
  list,
  onBack,
  onOpened,
  markReadFailed,
}: {
  feedbackId: string;
  list: MyFeedbackListRead;
  onBack: () => void;
  onOpened: (id: string) => void;
  markReadFailed: boolean;
}) {
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submission = list.data?.submissions.find((row) => row.id === feedbackId);
  const found = submission !== undefined;

  // Opening a thread moves focus to it, the way the list's rows lead into it.
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, [feedbackId]);

  // Mark read once per opened submission. Always — even when the cached list
  // says zero — because a reply can arrive after that list was fetched.
  useEffect(() => {
    if (found) onOpened(feedbackId);
  }, [found, feedbackId, onOpened]);

  const headline = submission ? outcomeHeadline(submission, t) : null;

  return (
    <section className="bt-cc-group" aria-labelledby="feedback-thread-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button icon="arrow-left" onClick={onBack} size="sm" variant="quiet">
          {t('feedback.backToSubmissions')}
        </Button>
        {submission ? <StatusBadge status={submission.status} /> : null}
      </div>
      <h3
        className="bt-cc-group__label"
        id="feedback-thread-heading"
        ref={headingRef}
        tabIndex={-1}
      >
        {t('feedback.threadTitle')}
      </h3>
      <div className="bt-cc-rows">
        {list.loading || (list.error !== null && list.data === undefined) ? (
          <div className="bt-cc-row bt-cc-row--stack">
            <AsyncReadState
              error={list.error}
              errorLabel={t('feedback.mySubmissionsLoadError')}
              loading={list.loading}
              loadingLabel={t('feedback.mySubmissionsLoading')}
              onRetry={list.retry}
              unavailableLabel={t('feedback.mySubmissionsUnavailable')}
            />
          </div>
        ) : !submission ? (
          <div className="bt-cc-row bt-cc-row--stack" data-testid="feedback-submission-missing">
            <PanelNote>{t('feedback.submissionMissing')}</PanelNote>
          </div>
        ) : (
          <>
            {markReadFailed ? (
              <div className="bt-cc-row bt-cc-row--stack">
                <Alert tone="error">{t('feedback.markReadError')}</Alert>
              </div>
            ) : null}
            <div className="bt-cc-row bt-cc-row--stack" data-testid="feedback-thread-submission">
              <span className="bt-cc-list__meta">{t('feedback.yourSubmission')}</span>
              {headline ? (
                <span className="bt-cc-row__label break-words" data-testid="feedback-outcome">
                  {headline}
                </span>
              ) : null}
              {submission.subject ? (
                <span className="bt-cc-row__label break-words">{submission.subject}</span>
              ) : null}
              <p className="whitespace-pre-wrap break-words">{submission.message}</p>
              <SubmissionMeta submission={submission} />
            </div>
            <Conversation key={submission.id} submission={submission} />
          </>
        )}
      </div>
    </section>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

/**
 * "My submissions" (FEEDBACK-8, #1342): the caller's own feedback, newest
 * first, with each one's status and the sentence that closes the loop
 * (declined reason, shipped version) on the row itself; a per-submission
 * conversation with the BetterTrack team; and withdraw.
 *
 * It renders inline in the Feedback panel — list, then the selected thread in
 * its place — and the selection lives in the URL ({@link FEEDBACK_SUBMISSION_PARAM})
 * so a notification can open a conversation directly.
 */
export function MyFeedbackSubmissions() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get(FEEDBACK_SUBMISSION_PARAM);
  const query = useQuery({
    queryKey: MY_FEEDBACK_QUERY_KEY,
    queryFn: ({ signal }) => listMyFeedback(signal),
    retry: false,
  });
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const returnFocusTo = useRef<string | null>(null);
  const [markReadFailedId, setMarkReadFailedId] = useState<string | null>(null);

  // ONE mutation hook serves every thread open, so its option callbacks run for
  // each call — and each call may only ever touch its own submission's row.
  const markRead = useMutation({
    mutationFn: (feedbackId: string) => markFeedbackRead(feedbackId),
    onMutate: async (feedbackId) => {
      setMarkReadFailedId((failed) => (failed === feedbackId ? null : failed));
      // Abort an in-flight list read so a stale response cannot land on top
      // of the cleared badge.
      await queryClient.cancelQueries({ queryKey: MY_FEEDBACK_QUERY_KEY });
      const previousCount = unreadReplyCountOf(
        queryClient.getQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY),
        feedbackId,
      );
      queryClient.setQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY, (current) =>
        withUnreadReplyCount(current, feedbackId, 0),
      );
      return { previousCount };
    },
    onError: (_error, feedbackId, context) => {
      setMarkReadFailedId(feedbackId);
      const previousCount = context?.previousCount ?? null;
      if (previousCount === null || previousCount === 0) return;
      // Per submission, never list-wide: restore THIS row's count, and only
      // while it still shows the optimistic zero this call wrote.
      queryClient.setQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY, (current) =>
        unreadReplyCountOf(current, feedbackId) === 0
          ? withUnreadReplyCount(current, feedbackId, previousCount)
          : current,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: MY_FEEDBACK_QUERY_KEY });
    },
  });
  const { mutate: markReadMutate } = markRead;

  const setSelected = useCallback(
    (id: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id === null) next.delete(FEEDBACK_SUBMISSION_PARAM);
          else next.set(FEEDBACK_SUBMISSION_PARAM, id);
          return next;
        },
        // Panel switches inside the Control Center replace their history entry
        // so closing leaves in one step; opening a thread follows suit.
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const onOpened = useCallback((id: string) => markReadMutate(id), [markReadMutate]);

  if (selectedId) {
    return (
      <ThreadView
        feedbackId={selectedId}
        markReadFailed={markReadFailedId === selectedId}
        onBack={() => {
          returnFocusTo.current = selectedId;
          setSelected(null);
        }}
        list={{ data: query.data, loading: query.isPending, error: query.error, retry }}
        onOpened={onOpened}
      />
    );
  }

  return (
    <SubmissionList
      list={{ data: query.data, loading: query.isPending, error: query.error, retry }}
      onOpen={setSelected}
      returnFocusTo={returnFocusTo}
    />
  );
}
