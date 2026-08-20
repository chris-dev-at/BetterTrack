import { useMemo, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';

import {
  FEEDBACK_THREAD_MESSAGE_MAX_LENGTH,
  type FeedbackStatus,
  type FeedbackThreadResponse,
  type MyFeedbackResponse,
  type MyFeedbackSubmission,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import {
  getFeedbackThread,
  listMyFeedback,
  markFeedbackRead,
  sendFeedbackMessage,
} from '../../lib/feedbackApi';
import { Badge, Button, Textarea, type BadgeTone } from '../../ui/origin';
import { Alert } from './ui';
import { Dialog } from './Dialog';

const MY_FEEDBACK_QUERY_KEY = ['feedback', 'mine'] as const;
const THREAD_PAGE_SIZE = 100;

function threadQueryKey(id: string) {
  return ['feedback', 'thread', id] as const;
}

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

function outcomeHeadline(
  submission: MyFeedbackSubmission,
  t: ReturnType<typeof useT>,
): string | null {
  if (submission.status === 'declined' && submission.declinedReason) {
    return t('feedback.status.declinedWithReason', { reason: submission.declinedReason });
  }
  if (submission.status === 'shipped' && submission.shippedVersion) {
    return t('feedback.status.shippedWithVersion', { version: submission.shippedVersion });
  }
  return null;
}

function submissionPreview(submission: MyFeedbackSubmission): string {
  return submission.subject ?? submission.message;
}

function clearUnreadReplyCount(
  current: MyFeedbackResponse | undefined,
  feedbackId: string,
): MyFeedbackResponse | undefined {
  if (!current) return current;
  return {
    ...current,
    submissions: current.submissions.map((submission) =>
      submission.id === feedbackId ? { ...submission, unreadReplyCount: 0 } : submission,
    ),
  };
}

function MySubmissionRow({
  submission,
  onOpen,
}: {
  submission: MyFeedbackSubmission;
  onOpen: () => void;
}) {
  const t = useT();
  const headline = outcomeHeadline(submission, t);

  return (
    <li className="bt-cc-list__item">
      <button
        className="bt-phone-surface flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-3 gap-y-2 text-left"
        onClick={onOpen}
        type="button"
      >
        <div className="bt-cc-list__main">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(submission.status)}>
              {t(`feedback.status.${submission.status}`)}
            </Badge>
            {submission.unreadReplyCount > 0 ? (
              <Badge
                aria-label={t('feedback.unreadReplies', { count: submission.unreadReplyCount })}
                tone="blue"
              >
                {submission.unreadReplyCount}
              </Badge>
            ) : null}
          </div>
          {headline ? <p className="bt-row-title break-words">{headline}</p> : null}
          <p className="bt-meta line-clamp-2 break-words">{submissionPreview(submission)}</p>
          <p className="bt-cc-list__meta">
            {t('feedback.lastStatusChange', {
              date: formatDateTime(submission.lastStatusChangeAt),
            })}
          </p>
        </div>
        <span aria-hidden="true" className="bt-muted pt-1">
          ›
        </span>
      </button>
    </li>
  );
}

function FeedbackThread({
  submission,
  onBack,
  markReadError,
}: {
  submission: MyFeedbackSubmission;
  onBack: () => void;
  markReadError: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const key = threadQueryKey(submission.id);
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) =>
      getFeedbackThread(submission.id, { cursor: pageParam, limit: THREAD_PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: false,
  });

  // The endpoint follows chat's newest-first paging idiom. Render each whole
  // conversation oldest-to-newest so a submitter reads it in natural order.
  const messages = useMemo(() => {
    const flat = (query.data?.pages ?? []).flatMap((page) => page.messages);
    return [...flat].reverse();
  }, [query.data]);

  const replyMutation = useMutation({
    mutationFn: (body: string) => sendFeedbackMessage(submission.id, { body }),
    onSuccess: ({ message }) => {
      setDraft('');
      queryClient.setQueryData<InfiniteData<FeedbackThreadResponse>>(key, (current) => {
        const firstPage = current?.pages[0];
        if (!current || !firstPage || firstPage.messages.some((row) => row.id === message.id)) {
          return current;
        }
        return {
          ...current,
          pages: [
            { ...firstPage, messages: [message, ...firstPage.messages] },
            ...current.pages.slice(1),
          ],
        };
      });
    },
  });

  const trimmedDraft = draft.trim();
  const headline = outcomeHeadline(submission, t);

  return (
    <div className="bt-phone-surface flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Button onClick={onBack} size="sm" variant="quiet">
          {t('feedback.backToSubmissions')}
        </Button>
        <Badge tone={statusTone(submission.status)}>
          {t(`feedback.status.${submission.status}`)}
        </Badge>
      </div>

      {markReadError ? <Alert tone="error">{t('feedback.markReadError')}</Alert> : null}

      <section className="bt-band flex flex-col gap-2 p-3">
        <p className="bt-cc-list__meta">{t('feedback.yourSubmission')}</p>
        {headline ? <p className="bt-row-title break-words">{headline}</p> : null}
        <p className="whitespace-pre-wrap break-words">{submission.message}</p>
        <p className="bt-cc-list__meta">
          {t('feedback.lastStatusChange', { date: formatDateTime(submission.lastStatusChangeAt) })}
        </p>
      </section>

      {query.isLoading ? (
        <p className="bt-meta">{t('feedback.threadLoading')}</p>
      ) : query.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="error">{t('feedback.threadLoadError')}</Alert>
          <Button onClick={() => void query.refetch()} size="sm" variant="quiet">
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div
          aria-atomic="false"
          aria-label={t('feedback.threadLogAria')}
          aria-live="polite"
          className="flex min-w-0 flex-col gap-3"
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
          {messages.length === 0 ? (
            <p className="bt-meta">{t('feedback.threadEmpty')}</p>
          ) : (
            <ol className="bt-cc-list">
              {messages.map((message) => (
                <li
                  className="bt-cc-list__item flex-col gap-1"
                  data-testid="feedback-thread-message"
                  key={message.id}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="bt-row-title">
                      {t(
                        message.authorSide === 'admin'
                          ? 'feedback.threadAuthorAdmin'
                          : 'feedback.threadAuthorYou',
                      )}
                    </span>
                    <span className="bt-cc-list__meta">{formatDateTime(message.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <form
        className="bt-t-rule flex flex-col gap-2 pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmedDraft.length > 0) replyMutation.mutate(trimmedDraft);
        }}
      >
        <Textarea
          aria-label={t('feedback.reply')}
          maxLength={FEEDBACK_THREAD_MESSAGE_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('feedback.replyPlaceholder')}
          rows={3}
          value={draft}
        />
        <div className="flex flex-wrap items-center justify-end gap-3">
          {replyMutation.isError ? <Alert tone="error">{t('feedback.replyError')}</Alert> : null}
          <Button
            disabled={trimmedDraft.length === 0 || replyMutation.isPending}
            type="submit"
            variant="primary"
          >
            {replyMutation.isPending ? t('feedback.sendingReply') : t('feedback.sendReply')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Caller-owned feedback history and its support thread. It deliberately lives
 * in the same Settings panel as the submission form: an empty history can send
 * someone straight to that form instead of stranding them at a dead end.
 */
export function MyFeedbackSubmissionsDialog({
  onClose,
  onWriteFeedback,
}: {
  onClose: () => void;
  onWriteFeedback: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MyFeedbackSubmission | null>(null);
  const submissionsQuery = useQuery({
    queryKey: MY_FEEDBACK_QUERY_KEY,
    queryFn: ({ signal }) => listMyFeedback(signal),
    retry: false,
  });
  const markReadMutation = useMutation({
    mutationFn: (feedbackId: string) => markFeedbackRead(feedbackId),
    onMutate: async (feedbackId) => {
      // Abort an in-flight stale list response before clearing the visible badge.
      await queryClient.cancelQueries({ queryKey: MY_FEEDBACK_QUERY_KEY });
      const previous = queryClient.getQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY);
      queryClient.setQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY, (current) =>
        clearUnreadReplyCount(current, feedbackId),
      );
      return { previous };
    },
    onError: (_error, _feedbackId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(MY_FEEDBACK_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (_result, feedbackId) => {
      queryClient.setQueryData<MyFeedbackResponse>(MY_FEEDBACK_QUERY_KEY, (current) =>
        clearUnreadReplyCount(current, feedbackId),
      );
      void queryClient.invalidateQueries({ queryKey: MY_FEEDBACK_QUERY_KEY });
    },
  });

  function openThread(submission: MyFeedbackSubmission) {
    setSelected(submission);
    markReadMutation.mutate(submission.id);
  }

  return (
    <Dialog
      description={selected ? undefined : t('feedback.mySubmissionsDescription')}
      onClose={onClose}
      phoneSheet
      title={selected ? t('feedback.threadTitle') : t('feedback.mySubmissionsTitle')}
      widthClassName="max-w-2xl"
    >
      {selected ? (
        <FeedbackThread
          markReadError={markReadMutation.isError}
          onBack={() => setSelected(null)}
          submission={selected}
        />
      ) : submissionsQuery.isLoading ? (
        <p className="bt-meta">{t('feedback.mySubmissionsLoading')}</p>
      ) : submissionsQuery.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="error">{t('feedback.mySubmissionsLoadError')}</Alert>
          <Button onClick={() => void submissionsQuery.refetch()} size="sm" variant="quiet">
            {t('common.retry')}
          </Button>
        </div>
      ) : (submissionsQuery.data?.submissions.length ?? 0) === 0 ? (
        <div className="bt-phone-surface flex flex-col items-start gap-3">
          <p className="bt-row-title">{t('feedback.mySubmissionsEmptyTitle')}</p>
          <p className="bt-meta">{t('feedback.mySubmissionsEmptyDescription')}</p>
          <Button onClick={onWriteFeedback} variant="primary">
            {t('feedback.mySubmissionsEmptyAction')}
          </Button>
        </div>
      ) : (
        <ol aria-label={t('feedback.mySubmissionsListAria')} className="bt-cc-list">
          {submissionsQuery.data?.submissions.map((submission) => (
            <MySubmissionRow
              key={submission.id}
              onOpen={() => openThread(submission)}
              submission={submission}
            />
          ))}
        </ol>
      )}
    </Dialog>
  );
}
