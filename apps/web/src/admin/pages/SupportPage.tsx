import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { SupportInbox } from '../support/SupportInbox';
import { SupportThread } from '../support/SupportThread';
import {
  SUPPORT_KEYS_OFF_ATTR,
  readSupportQuery,
  supportFiltersActive,
} from '../support/supportPaneState';
import { Button, PageHeader, cx } from '../components/ui';
import { EDGE, STACK, TEXT_MICRO, TEXT_MUTED, TEXT_NUM } from '../components/tokens';
import { useResource } from '../useResource';

/**
 * The Support workspace — a split-pane helpdesk (#1406 W3).
 *
 * Owner verdict, 2026-08-20: "Support desktop = split pane (inbox left / thread
 * right, full-page on mobile)". Below `lg` only one pane is VISIBLE at a time,
 * because a 390 px column cannot hold a queue and a conversation at once and
 * pretending otherwise produces two unusable halves. Both stay mounted — see
 * the note on the grid below for why that is load-bearing.
 *
 * Every piece of view state is a query parameter, so a thread is a link: an
 * operator can paste `?thread=…` into a note, or send a filtered queue to
 * themselves, and get the same screen back. The thread pane reads its
 * submission by id rather than looking it up in the loaded page, so that link
 * still opens when the recipient's filters exclude the row.
 *
 * This component owns the URL and nothing else. Each pane runs its own read and
 * renders its own loading and error states — a resource handed down to a child
 * is a resource whose failure nobody in this file is accountable for.
 */
export function SupportPage() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => readSupportQuery(params), [params]);

  /**
   * Bumped whenever a write in the thread pane invalidates the queue behind it
   * (a status change, an archive, a reply). The panes own their own reads, so
   * this token is how one pane asks the other to refetch without either of them
   * holding the other's resource.
   */
  const [reloadToken, setReloadToken] = useState(0);
  const invalidate = useCallback(() => setReloadToken((n) => n + 1), []);

  /**
   * The standing attention number, asked as its own one-row query so the figure
   * is the whole queue's rather than the current page's. It deliberately ignores
   * the operator's filters — "how much is waiting on me" must not change because
   * somebody typed in the search box.
   */
  const waiting = useResource(
    (signal) => api.listAdminFeedback({ unread: true, archived: false, limit: 1 }, signal),
    [reloadToken],
  );

  const patchQuery = useCallback(
    (patch: Record<string, string | number | boolean | null>, keepPage = false) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '' || value === false) next.delete(key);
            else next.set(key, String(value));
          }
          // Any filter change resets paging. Staying on page 3 of a result set
          // that just shrank shows an empty pane and reads as "no results",
          // which is a lie about the filter the operator just typed.
          if (!keepPage) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const openThread = useCallback(
    (id: string | null) => {
      // Opening the thread that is already open is not a navigation. Without
      // this guard a keypress handled by both the row and the window shortcut
      // pushes two identical history entries, and the operator's next Back
      // press appears to do nothing.
      if ((id ?? null) === (params.get('thread') ?? null)) return;
      // A thread change IS a navigation the operator should be able to undo, so
      // unlike a filter tweak it pushes a history entry.
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (id === null) next.delete('thread');
          else next.set('thread', id);
          return next;
        },
        { replace: false },
      );
    },
    [setParams, params],
  );

  return (
    <div className={cx(STACK, 'min-w-0')}>
      <PageHeader
        eyebrow={t('admin.nav.sections.support')}
        title={t('admin.support.title')}
        description={t('admin.support.subtitle')}
        actions={
          <Button variant="secondary" onClick={invalidate}>
            {t('admin.support.refresh')}
          </Button>
        }
      />

      <div className={cx('flex flex-wrap items-center gap-x-5 gap-y-1', EDGE, 'px-3 py-2')}>
        <span className={TEXT_MICRO}>
          {t('admin.support.stats.needsReply')}{' '}
          <span className={cx('ml-1 text-neutral-100', TEXT_NUM)}>
            {/*
             * An unavailable count is said out loud rather than rendered as a
             * confident zero: "nothing is waiting on you" and "we could not ask"
             * are opposite messages for an attention number.
             */}
            {waiting.loading
              ? t('admin.support.stats.counting')
              : waiting.error !== null
                ? t('admin.support.stats.unavailable')
                : (waiting.data?.pagination.total ?? 0)}
          </span>
        </span>
        <span className={cx(TEXT_MUTED, 'ml-auto hidden lg:inline')}>
          {t('admin.support.keyboardHint')}
        </span>
      </div>

      {/*
       * BOTH panes are always mounted; below `lg` one of them is hidden with
       * CSS so an open thread reads as full-page, which is the "full-page on
       * mobile" half of the owner's verdict.
       *
       * Mounting both is deliberate, not laziness. The inbox pane owns the
       * queue read, and that read is the ONLY one on this screen whose 404 is
       * allowed to mean "you are not an admin any more" (the two by-id reads
       * treat a 404 as "this row is gone" — see `useResource`'s notFound
       * policy). Unmounting the inbox on a phone would take that signal away,
       * and an operator whose admin rights were revoked while a thread was open
       * would sit on a stale pane instead of being signed out.
       */}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(19rem,24rem)_1fr]">
        <div className={cx('min-w-0', query.thread === null ? 'block' : 'hidden lg:block')}>
          <SupportInbox
            query={query}
            filtersActive={supportFiltersActive(query)}
            reloadToken={reloadToken}
            onOpen={openThread}
            onClose={() => openThread(null)}
            onPatchQuery={patchQuery}
          />
        </div>

        <div
          // The queue shortcuts stop at this boundary: `j`/`k`/`Enter` are
          // about the list, and this is the conversation.
          {...{ [SUPPORT_KEYS_OFF_ATTR]: 'off' }}
          className={cx('min-w-0', query.thread === null ? 'hidden lg:block' : 'block')}
        >
          <SupportThread
            threadId={query.thread}
            onClose={() => openThread(null)}
            onChanged={invalidate}
          />
        </div>
      </div>
    </div>
  );
}
