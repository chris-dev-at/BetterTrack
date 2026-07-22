import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  WEBHOOK_EVENT_TYPES,
  type CreateWebhookSubscriptionResponse,
  type WebhookEventType,
  type WebhookSubscription,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDate } from '../../lib/format';
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from '../../lib/webhooksApi';
import { EmptyState, Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, TextField, cx } from '../components/ui';

const WEBHOOKS_KEY = ['settings', 'webhooks'] as const;
const deliveriesKey = (id: string) => ['settings', 'webhooks', id, 'deliveries'] as const;

/** Maps each catalog event type to its i18n label subkey (camelCase of the type). */
const EVENT_LABEL_KEY: Record<WebhookEventType, string> = {
  'alert.triggered': 'alertTriggered',
  'friend.request': 'friendRequest',
  'friend.accepted': 'friendAccepted',
  'portfolio.shared': 'portfolioShared',
  'watchlist.shared': 'watchlistShared',
  'conglomerate.shared': 'conglomerateShared',
  'friend.activity': 'friendActivity',
  'follow.published': 'followPublished',
  'follow.alert.created': 'followAlertCreated',
  'follow.alert.fired': 'followAlertFired',
  'account.temp_password': 'accountTempPassword',
  'account.data_export': 'accountDataExport',
  'earnings.reminder': 'earningsReminder',
  'chat.message': 'chatMessage',
  'dividend.event': 'dividendEvent',
  'budget.exceeded': 'budgetExceeded',
  'mirror.invite': 'mirrorInvite',
  'mirror.member_joined': 'mirrorMemberJoined',
  'mirror.member_left': 'mirrorMemberLeft',
  'mirror.member_removed': 'mirrorMemberRemoved',
  'mirror.removed': 'mirrorRemoved',
  'mirror.ownership_transferred': 'mirrorOwnershipTransferred',
  'mirror.chain_dissolved': 'mirrorChainDissolved',
  'mirror.sync_stalled': 'mirrorSyncStalled',
};

/** The one-time secret modal — the plaintext is available here and never again. */
function SecretModal({
  result,
  onClose,
}: {
  result: CreateWebhookSubscriptionResponse;
  onClose: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      title={t('settings.api.webhooks.secretModal.title')}
      description={t('settings.api.webhooks.secretModal.description')}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md bg-neutral-950 px-3 py-2 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-neutral-700">
            {result.secret}
          </code>
          <Button variant="secondary" onClick={copy}>
            {copied ? t('settings.api.copied') : t('settings.api.copy')}
          </Button>
        </div>
        <Alert tone="info">{t('settings.api.webhooks.secretModal.storeWarning')}</Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>{t('settings.api.done')}</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Create-webhook form: a URL, an optional label, and ≥1 event type. */
function CreateWebhookForm({
  onCreated,
}: {
  onCreated: (result: CreateWebhookSubscriptionResponse) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<Set<WebhookEventType>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof createWebhook>[0]) => createWebhook(input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY });
      setUrl('');
      setDescription('');
      setEvents(new Set());
      setError(null);
      onCreated(result);
    },
    onError: () => setError(t('settings.api.webhooks.createError')),
  });

  function toggle(type: WebhookEventType) {
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (url.trim().length === 0) {
      setError(t('settings.api.webhooks.urlRequired'));
      return;
    }
    if (events.size === 0) {
      setError(t('settings.api.webhooks.eventRequired'));
      return;
    }
    mutation.mutate({
      url: url.trim(),
      description: description.trim() === '' ? undefined : description.trim(),
      eventTypes: [...events],
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-neutral-100">
        {t('settings.api.webhooks.createTitle')}
      </h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label={t('settings.api.webhooks.urlLabel')}
        name="webhook-url"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        maxLength={2048}
        placeholder={t('settings.api.webhooks.urlPlaceholder')}
        required
      />
      <TextField
        label={t('settings.api.webhooks.descriptionLabel')}
        name="webhook-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={200}
        placeholder={t('settings.api.webhooks.descriptionPlaceholder')}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-neutral-300">
          {t('settings.api.webhooks.eventsLegend')}
        </legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <label
              key={type}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm text-neutral-200 hover:bg-neutral-800"
            >
              <input
                type="checkbox"
                checked={events.has(type)}
                onChange={() => toggle(type)}
                className="h-4 w-4 accent-sky-500"
              />
              <span>{t(`settings.api.webhooks.event.${EVENT_LABEL_KEY[type]}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? t('settings.api.webhooks.creating')
            : t('settings.api.webhooks.create')}
        </Button>
      </div>
    </form>
  );
}

/** The recent-deliveries list for one subscription (fetched on demand). */
function DeliveriesList({ id }: { id: string }) {
  const t = useT();
  const query = useQuery({
    queryKey: deliveriesKey(id),
    queryFn: ({ signal }) => listWebhookDeliveries(id, signal),
    staleTime: 5_000,
  });

  if (query.isPending) return <Skeleton height="h-16" />;
  if (query.isError)
    return (
      <p className="text-xs text-red-400">{t('settings.api.webhooks.deliveries.loadError')}</p>
    );

  const deliveries = query.data?.deliveries ?? [];
  if (deliveries.length === 0)
    return (
      <p className="text-xs text-neutral-500">{t('settings.api.webhooks.deliveries.empty')}</p>
    );

  return (
    <ul className="flex flex-col gap-1">
      {deliveries.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          <span
            className={cx(
              'rounded px-1.5 py-0.5 font-medium',
              d.status === 'success'
                ? 'bg-emerald-950 text-emerald-300'
                : 'bg-red-950 text-red-300',
            )}
          >
            {d.status === 'success'
              ? t('settings.api.webhooks.deliveries.success')
              : t('settings.api.webhooks.deliveries.failed')}
          </span>
          <span className="font-mono">{d.eventType}</span>
          {d.responseStatus != null ? <span>· {d.responseStatus}</span> : null}
          <span className="text-neutral-500">· {formatDate(d.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/** One subscription row with pause/enable, delete (two-step), and a deliveries toggle. */
function WebhookRow({ subscription }: { subscription: WebhookSubscription }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [showDeliveries, setShowDeliveries] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateWebhook(subscription.id, { enabled }),
    onSuccess: () => void invalidate(),
    onError: () => setError(t('settings.api.webhooks.updateFailed')),
  });

  const remove = useMutation({
    mutationFn: () => deleteWebhook(subscription.id),
    onSuccess: () => void invalidate(),
    onError: () => setError(t('settings.api.webhooks.deleteFailed')),
  });

  const statusBadge = !subscription.enabled
    ? subscription.disabledReason === 'auto'
      ? { text: t('settings.api.webhooks.status.disabledAuto'), tone: 'bg-red-950 text-red-300' }
      : {
          text: t('settings.api.webhooks.status.pausedManual'),
          tone: 'bg-amber-950 text-amber-300',
        }
    : { text: t('settings.api.webhooks.status.active'), tone: 'bg-emerald-950 text-emerald-300' };

  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span
              className={cx('rounded px-1.5 py-0.5 text-[0.65rem] font-medium', statusBadge.tone)}
            >
              {statusBadge.text}
            </span>
            <span className="truncate font-mono text-sm text-neutral-100">{subscription.url}</span>
          </span>
          {subscription.description ? (
            <span className="text-xs text-neutral-400">{subscription.description}</span>
          ) : null}
          <span className="flex flex-wrap gap-1">
            {subscription.eventTypes.map((type) => (
              <span
                key={type}
                className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[0.65rem] text-neutral-300"
              >
                {type}
              </span>
            ))}
          </span>
          {!subscription.enabled && subscription.disabledReason === 'auto' ? (
            <span className="text-xs text-red-400">
              {t('settings.api.webhooks.disabledAutoHint', {
                count: subscription.consecutiveFailures,
              })}
            </span>
          ) : null}
          <span className="text-xs text-neutral-500">
            {subscription.lastDeliveryAt
              ? t('settings.api.webhooks.lastDelivery', {
                  at: formatDate(subscription.lastDeliveryAt),
                })
              : t('settings.api.webhooks.neverDelivered')}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {error ? <span className="text-xs text-red-400">{error}</span> : null}
          <Button variant="ghost" onClick={() => setShowDeliveries((v) => !v)}>
            {showDeliveries
              ? t('settings.api.webhooks.hideDeliveries')
              : t('settings.api.webhooks.viewDeliveries')}
          </Button>
          <Button
            variant="ghost"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!subscription.enabled)}
          >
            {subscription.enabled
              ? toggle.isPending
                ? t('settings.api.webhooks.pausing')
                : t('settings.api.webhooks.pause')
              : toggle.isPending
                ? t('settings.api.webhooks.enabling')
                : t('settings.api.webhooks.enable')}
          </Button>
          {confirming ? (
            <>
              <Button
                variant="secondary"
                className={cx('text-red-300 ring-red-900 hover:bg-red-950')}
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending
                  ? t('settings.api.webhooks.deleting')
                  : t('settings.api.webhooks.confirmDelete')}
              </Button>
              <Button
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => setConfirming(false)}
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirming(true)}>
              {t('settings.api.webhooks.delete')}
            </Button>
          )}
        </div>
      </div>
      {showDeliveries ? (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3">
          <DeliveriesList id={subscription.id} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * "Webhooks" — Settings → API Access (§13.5 V5-P10). Subscribe URLs to your own
 * events; every delivery is HMAC-signed. Collapsed by default per the anti-bloat
 * rule, and its list only loads once opened, so it costs nothing when unused.
 */
export function WebhooksSection() {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [minted, setMinted] = useState<CreateWebhookSubscriptionResponse | null>(null);

  const query = useQuery({
    queryKey: WEBHOOKS_KEY,
    queryFn: ({ signal }) => listWebhooks(signal),
    enabled: expanded,
    staleTime: 15_000,
  });
  const subscriptions = query.data?.subscriptions ?? [];

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center justify-between gap-2 text-left"
      >
        <span className="flex flex-col gap-1">
          <span className="text-lg font-semibold text-neutral-100">
            {t('settings.api.webhooks.sectionTitle')}
          </span>
          <span className="text-sm text-neutral-500">
            {t('settings.api.webhooks.sectionDescription')}
          </span>
        </span>
        <span aria-hidden className="text-neutral-500">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded ? (
        <>
          <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
            <CreateWebhookForm onCreated={setMinted} />
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-neutral-100">
              {t('settings.api.webhooks.listTitle')}
            </h3>
            {query.isPending ? (
              <Skeleton height="h-20" />
            ) : query.isError ? (
              <EmptyState
                title={t('settings.api.webhooks.loadError.title')}
                description={t('settings.retryHint')}
              />
            ) : subscriptions.length === 0 ? (
              <EmptyState
                icon="🪝"
                title={t('settings.api.webhooks.empty.title')}
                description={t('settings.api.webhooks.empty.description')}
              />
            ) : (
              <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800 bg-neutral-900">
                {subscriptions.map((subscription) => (
                  <WebhookRow key={subscription.id} subscription={subscription} />
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      {minted ? <SecretModal result={minted} onClose={() => setMinted(null)} /> : null}
    </div>
  );
}
