import { useState } from 'react';

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  NOTIFICATION_VIEWS,
  type MarkReadRequest,
  type Notification,
  type NotificationView,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { cx } from '../../../lib/cx';
import {
  archiveNotification,
  deleteNotification,
  deleteNotifications,
  listNotifications,
  markNotificationsRead,
  unarchiveNotification,
} from '../../../lib/notificationsApi';
import { EmptyState, Skeleton } from '../../../ui';
import { Button } from '../../../ui/origin';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { PanelHead, PanelList, PanelListItem } from './panelKit';

/**
 * Control Center → Notification log (PROJECTPLAN.md §6.10, §6.11; #437) rebuilt
 * for the popup (R2). The INBOX only — routing, cadence and quiet hours live in
 * the Notifications panel. Same infinite query, same mutations, same
 * invalidation of the whole `notifications` family (so the bell's badge and
 * dropdown follow along), same destructive confirmations: what changed is that
 * the page's heading stack and card-per-row became one head, one actions row and
 * a dense two-line list.
 */

const NOTIFICATIONS_LIST_KEY = ['notifications', 'list'] as const;
const NOTIFICATIONS_LIST_LIMIT = 20;
const NOTIFICATIONS_POLL_INTERVAL_MS = 30_000;

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** ISO timestamp → short relative label ("5m ago", "in 2h" never occurs — all past). */
function formatRelativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  if (Math.abs(diffMinutes) < 60) return relativeTimeFormatter.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return relativeTimeFormatter.format(diffHours, 'hour');
  const diffDays = Math.round(diffHours / 24);
  return relativeTimeFormatter.format(diffDays, 'day');
}

/** Whether a mark-read mutation currently in flight targets this specific notification. */
function isMarkReadPendingFor(
  mutation: { isPending: boolean; variables: MarkReadRequest | undefined },
  id: string,
): boolean {
  if (!mutation.isPending) return false;
  const vars = mutation.variables;
  return vars !== undefined && 'ids' in vars && vars.ids.includes(id);
}

/** A per-row archive/unarchive/delete action (#437). */
interface RowAction {
  kind: 'archive' | 'unarchive' | 'delete';
  id: string;
}

/**
 * One inbox row: two lines (title, then body + age) and its inline actions.
 * The title block stays a BUTTON — clicking the row is what marks it read, and
 * it disables itself once read or while its own mutation is in flight.
 */
function NotificationRow({
  notification,
  busy,
  onRead,
  onAction,
}: {
  notification: Notification;
  busy: boolean;
  onRead: () => void;
  onAction: (kind: RowAction['kind']) => void;
}) {
  const t = useT();
  const unread = notification.readAt === null;
  const archived = notification.archivedAt !== null;
  return (
    <PanelListItem
      main={
        <button
          type="button"
          onClick={onRead}
          disabled={!unread || busy}
          className="flex min-w-0 flex-col gap-0.5 text-left"
          style={{
            border: 0,
            padding: 0,
            background: 'none',
            color: 'inherit',
            font: 'inherit',
            cursor: unread && !busy ? 'pointer' : 'default',
          }}
        >
          <span className="flex min-w-0 items-center gap-2">
            {unread ? (
              <span
                aria-hidden="true"
                className="bt-dot bt-dot--gold"
                style={{ width: 6, height: 6 }}
              />
            ) : null}
            <span className={cx('truncate', unread ? 'bt-row-title' : 'bt-muted')}>
              {notification.title}
            </span>
          </span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="bt-row-sub truncate">{notification.body}</span>
            <span className="bt-label" style={{ fontSize: 10.5 }}>
              {formatRelativeTime(notification.createdAt)}
            </span>
          </span>
        </button>
      }
      actions={
        <>
          {archived ? (
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => onAction('unarchive')}
              disabled={busy}
              aria-label={t('settings.notifications.unarchiveAria', { title: notification.title })}
            >
              {t('settings.notifications.unarchive')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="quiet"
              onClick={() => onAction('archive')}
              disabled={busy}
              aria-label={t('settings.notifications.archiveAria', { title: notification.title })}
            >
              {t('settings.notifications.archive')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => onAction('delete')}
            disabled={busy}
            aria-label={t('settings.notifications.deleteAria', { title: notification.title })}
          >
            {t('common.delete')}
          </Button>
        </>
      }
    />
  );
}

/**
 * The destructive bulk-delete confirmations (#437): "all archived" and
 * "absolutely everything", each behind an explicit dialog — no silent wipes.
 */
function BulkDeleteDialog({
  scope,
  busy,
  onConfirm,
  onClose,
}: {
  scope: 'archived' | 'all';
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const base = scope === 'archived' ? 'confirmDeleteArchived' : 'confirmDeleteAll';
  return (
    <Dialog
      phoneSheet
      title={t(`settings.notifications.${base}.title`)}
      onClose={onClose}
      widthClassName="max-w-md"
    >
      <div className="flex flex-col gap-4">
        <Alert tone="error">{t(`settings.notifications.${base}.description`)}</Alert>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="quiet" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} disabled={busy}>
            {busy
              ? t('settings.notifications.deleting')
              : t('settings.notifications.confirmDeleteAction')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Control Center → Notification log: the full, paged inbox — newest first,
 * cursor-paginated "load more", with an Active | Archived | All view filter,
 * per-item mark-read / archive / unarchive / delete, mark-all, and the two bulk
 * deletions ("all archived", "everything") each behind an explicit destructive
 * confirm dialog. Every mutation invalidates the `notifications` query family so
 * the bell (`apps/web/src/user/components/NotificationBell.tsx`) updates too.
 */
export function NotificationLogPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const [view, setView] = useState<NotificationView>('active');
  const [confirmScope, setConfirmScope] = useState<'archived' | 'all' | null>(null);

  const query = useInfiniteQuery({
    queryKey: [...NOTIFICATIONS_LIST_KEY, view],
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      listNotifications({ cursor: pageParam, limit: NOTIFICATIONS_LIST_LIMIT, view }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: NOTIFICATIONS_POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const markReadMutation = useMutation({
    mutationFn: (body: MarkReadRequest) => markNotificationsRead(body),
    onSuccess: () => {
      void invalidate();
    },
  });

  // One mutation for the per-row actions so "busy" and errors stay per-row simple.
  const rowMutation = useMutation({
    mutationFn: (action: RowAction) =>
      action.kind === 'archive'
        ? archiveNotification(action.id)
        : action.kind === 'unarchive'
          ? unarchiveNotification(action.id)
          : deleteNotification(action.id),
    onSuccess: () => {
      void invalidate();
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (scope: 'archived' | 'all') => deleteNotifications(scope),
    onSuccess: () => {
      setConfirmScope(null);
      void invalidate();
    },
  });

  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const unreadCount = query.data?.pages[0]?.unreadCount ?? 0;
  const rowBusy = (id: string) =>
    isMarkReadPendingFor(markReadMutation, id) ||
    (rowMutation.isPending && rowMutation.variables?.id === id);

  const viewLabels: Record<NotificationView, string> = {
    active: t('settings.notifications.views.active'),
    archived: t('settings.notifications.views.archived'),
    all: t('settings.notifications.views.all'),
  };

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.notificationLog')} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label={t('settings.notifications.viewFilterAria')}
          className="bt-seg w-fit"
        >
          {NOTIFICATION_VIEWS.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={view === candidate}
              onClick={() => setView(candidate)}
              className={cx(view === candidate && 'is-active')}
            >
              {viewLabels[candidate]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="quiet"
            onClick={() => markReadMutation.mutate({ all: true })}
            disabled={unreadCount === 0 || markReadMutation.isPending}
          >
            {t('settings.notifications.markAllRead')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => setConfirmScope('archived')}
          >
            {t('settings.notifications.deleteArchived')}
          </Button>
          <Button
            data-testid="notification-delete-all-trigger"
            type="button"
            size="sm"
            variant="danger"
            onClick={() => setConfirmScope('all')}
          >
            {t('settings.notifications.deleteAll')}
          </Button>
        </div>
      </div>

      {markReadMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.markReadError')}</Alert>
      ) : null}
      {rowMutation.isError || bulkDeleteMutation.isError ? (
        <Alert tone="error">{t('settings.notifications.actionError')}</Alert>
      ) : null}

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-10" />
          <Skeleton height="h-10" />
          <Skeleton height="h-10" />
        </div>
      ) : query.isError && items.length === 0 ? (
        <EmptyState
          compact
          title={t('settings.notifications.listError.title')}
          description={t('settings.retryHint')}
        />
      ) : items.length === 0 ? (
        view === 'archived' ? (
          <EmptyState compact icon="🗂️" title={t('settings.notifications.emptyArchived.title')} />
        ) : (
          <EmptyState
            compact
            icon="🔔"
            title={t('settings.notifications.empty.title')}
            description={t('settings.notifications.empty.description')}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {query.isError ? (
            <Alert tone="error">{t('settings.notifications.refreshError')}</Alert>
          ) : null}
          <PanelList aria-label={t('settings.notifications.allTitle')}>
            {items.map((notification) => (
              <NotificationRow
                key={notification.id}
                notification={notification}
                busy={rowBusy(notification.id)}
                onRead={() => markReadMutation.mutate({ ids: [notification.id] })}
                onAction={(kind) => rowMutation.mutate({ kind, id: notification.id })}
              />
            ))}
          </PanelList>
          {query.hasNextPage ? (
            <Button
              type="button"
              size="sm"
              variant="quiet"
              className="self-center"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage
                ? t('common.loading')
                : t('settings.notifications.loadMore')}
            </Button>
          ) : null}
        </div>
      )}

      {confirmScope !== null ? (
        <BulkDeleteDialog
          scope={confirmScope}
          busy={bulkDeleteMutation.isPending}
          onConfirm={() => bulkDeleteMutation.mutate(confirmScope)}
          onClose={() => setConfirmScope(null)}
        />
      ) : null}
    </div>
  );
}
