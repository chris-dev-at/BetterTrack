import type { MyFeedbackResponse } from '@bettertrack/contracts';

/** The one cache entry every "my submissions" read and write goes through. */
export const MY_FEEDBACK_QUERY_KEY = ['feedback', 'mine'] as const;

export function feedbackThreadQueryKey(id: string) {
  return ['feedback', 'thread', id] as const;
}

/** One submission's unread count in the cached list, or `null` when it is not there. */
export function unreadReplyCountOf(
  current: MyFeedbackResponse | undefined,
  feedbackId: string,
): number | null {
  return current?.submissions.find((row) => row.id === feedbackId)?.unreadReplyCount ?? null;
}

/**
 * Rewrites ONE submission's unread count and leaves every other row exactly as
 * the cache holds it now.
 *
 * This is the whole of the mark-read rollback. The first draft (#1448) snapshot
 * the entire list in `onMutate` and wrote that snapshot back in `onError`, so a
 * failed read on submission A, settling after submission B had been opened and
 * cleared, resurrected B's badge from A's stale snapshot. Restoring a single
 * field of a single row cannot reach a sibling.
 */
export function withUnreadReplyCount(
  current: MyFeedbackResponse | undefined,
  feedbackId: string,
  count: number,
): MyFeedbackResponse | undefined {
  if (!current) return current;
  let changed = false;
  const submissions = current.submissions.map((row) => {
    if (row.id !== feedbackId || row.unreadReplyCount === count) return row;
    changed = true;
    return { ...row, unreadReplyCount: count };
  });
  return changed ? { ...current, submissions } : current;
}

/** The list without one submission — a withdrawn row leaves at once. */
export function withoutSubmission(
  current: MyFeedbackResponse | undefined,
  feedbackId: string,
): MyFeedbackResponse | undefined {
  if (!current) return current;
  const submissions = current.submissions.filter((row) => row.id !== feedbackId);
  return submissions.length === current.submissions.length ? current : { ...current, submissions };
}
