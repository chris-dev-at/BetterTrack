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
import { Badge, Button, Field, Input, type BadgeTone } from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';

const WEBHOOKS_KEY = ['settings', 'webhooks'] as const;

/** Monospace surface for the show-once secret, URLs and event ids. */
const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';
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
  const [acknowledged, setAcknowledged] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(result.secret);
      setCopied(true);
      setAcknowledged(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      title={t('settings.api.webhooks.secretModal.title')}
      description={t('settings.api.webhooks.secretModal.description')}
      onClose={onClose}
      dismissable={acknowledged}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <code
            className="bt-panel bt-panel--soft bt-num flex-1 overflow-x-auto"
            style={{ fontFamily: MONO_FONT, padding: '8px 11px', color: 'var(--bt-pos)' }}
          >
            {result.secret}
          </code>
          <Button onClick={copy}>
            {copied ? t('settings.api.copied') : t('settings.api.copy')}
          </Button>
        </div>
        <Alert tone="info">{t('settings.api.webhooks.secretModal.storeWarning')}</Alert>
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setAcknowledged(true);
              onClose();
            }}
            variant="primary"
          >
            {t('common.savedOneTimeSecret')}
          </Button>
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
      <h3 className="bt-h3">{t('settings.api.webhooks.createTitle')}</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Field className="max-w-xl" htmlFor="webhook-url" label={t('settings.api.webhooks.urlLabel')}>
        <Input
          id="webhook-url"
          maxLength={2048}
          name="webhook-url"
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t('settings.api.webhooks.urlPlaceholder')}
          required
          type="url"
          value={url}
        />
      </Field>
      <Field
        className="max-w-sm"
        htmlFor="webhook-description"
        label={t('settings.api.webhooks.descriptionLabel')}
      >
        <Input
          id="webhook-description"
          maxLength={200}
          name="webhook-description"
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('settings.api.webhooks.descriptionPlaceholder')}
          value={description}
        />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="bt-label">{t('settings.api.webhooks.eventsLegend')}</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <label key={type} className="bt-soft flex cursor-pointer items-center gap-2 py-1">
              <input
                type="checkbox"
                checked={events.has(type)}
                onChange={() => toggle(type)}
                className="h-4 w-4"
                style={{ accentColor: 'var(--bt-gold)' }}
              />
              <span>{t(`settings.api.webhooks.event.${EVENT_LABEL_KEY[type]}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Button disabled={mutation.isPending} type="submit">
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
    return <p className="bt-field__error">{t('settings.api.webhooks.deliveries.loadError')}</p>;

  const deliveries = query.data?.deliveries ?? [];
  if (deliveries.length === 0)
    return <p className="bt-meta">{t('settings.api.webhooks.deliveries.empty')}</p>;

  return (
    <ul className="flex flex-col gap-1.5">
      {deliveries.map((d) => (
        <li key={d.id} className="bt-row-sub flex flex-wrap items-center gap-2">
          <Badge tone={d.status === 'success' ? 'pos' : 'neg'}>
            {d.status === 'success'
              ? t('settings.api.webhooks.deliveries.success')
              : t('settings.api.webhooks.deliveries.failed')}
          </Badge>
          <span style={{ fontFamily: MONO_FONT }}>{d.eventType}</span>
          {d.responseStatus != null ? <span className="bt-num">· {d.responseStatus}</span> : null}
          <span style={{ color: 'var(--bt-faint)' }}>· {formatDate(d.createdAt)}</span>
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

  const statusBadge: { text: string; tone: BadgeTone } = !subscription.enabled
    ? subscription.disabledReason === 'auto'
      ? { text: t('settings.api.webhooks.status.disabledAuto'), tone: 'neg' }
      : { text: t('settings.api.webhooks.status.pausedManual'), tone: 'gold' }
    : { text: t('settings.api.webhooks.status.active'), tone: 'pos' };

  return (
    <li className="bt-band__row flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2">
            <Badge tone={statusBadge.tone}>{statusBadge.text}</Badge>
            <span className="bt-row-title truncate" style={{ fontFamily: MONO_FONT }}>
              {subscription.url}
            </span>
          </span>
          {subscription.description ? (
            <span className="bt-row-sub">{subscription.description}</span>
          ) : null}
          <span className="flex flex-wrap gap-1">
            {subscription.eventTypes.map((type) => (
              <Badge
                key={type}
                outline
                style={{ fontFamily: MONO_FONT, fontSize: 11, minHeight: 18 }}
              >
                {type}
              </Badge>
            ))}
          </span>
          {!subscription.enabled && subscription.disabledReason === 'auto' ? (
            <span className="bt-field__error">
              {t('settings.api.webhooks.disabledAutoHint', {
                count: subscription.consecutiveFailures,
              })}
            </span>
          ) : null}
          <span className="bt-row-sub">
            {subscription.lastDeliveryAt
              ? t('settings.api.webhooks.lastDelivery', {
                  at: formatDate(subscription.lastDeliveryAt),
                })
              : t('settings.api.webhooks.neverDelivered')}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {error ? <span className="bt-field__error">{error}</span> : null}
          <Button onClick={() => setShowDeliveries((v) => !v)} size="sm" variant="quiet">
            {showDeliveries
              ? t('settings.api.webhooks.hideDeliveries')
              : t('settings.api.webhooks.viewDeliveries')}
          </Button>
          <Button
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!subscription.enabled)}
            size="sm"
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
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
                size="sm"
                variant="danger"
              >
                {remove.isPending
                  ? t('settings.api.webhooks.deleting')
                  : t('settings.api.webhooks.confirmDelete')}
              </Button>
              <Button
                disabled={remove.isPending}
                onClick={() => setConfirming(false)}
                size="sm"
                variant="quiet"
              >
                {t('common.cancel')}
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirming(true)} size="sm" variant="danger">
              {t('settings.api.webhooks.delete')}
            </Button>
          )}
        </div>
      </div>
      {showDeliveries ? (
        <div className="bt-panel bt-panel--soft" style={{ padding: 12 }}>
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
    <div className="flex flex-col gap-5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center justify-between gap-2 text-left"
        style={{ background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer' }}
      >
        <span className="flex flex-col gap-1">
          <span className="bt-h2">{t('settings.api.webhooks.sectionTitle')}</span>
          <span className="bt-meta">{t('settings.api.webhooks.sectionDescription')}</span>
        </span>
        <span aria-hidden style={{ color: 'var(--bt-faint)' }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded ? (
        <>
          <section className="bt-panel bt-panel--pad">
            <CreateWebhookForm onCreated={setMinted} />
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="bt-h3">{t('settings.api.webhooks.listTitle')}</h3>
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
              <ul className="bt-panel bt-band">
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
