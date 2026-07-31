import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  WEBHOOK_EVENT_TYPES,
  isParanoidKilledWebhookEventType,
  type CreateWebhookSubscriptionResponse,
  type WebhookEventType,
  type WebhookSubscription,
} from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { formatDate } from '../../../lib/format';
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from '../../../lib/webhooksApi';
import { Skeleton } from '../../../ui';
import { Badge, Button, Field, Input, type BadgeTone } from '../../../ui/origin';
import { Dialog } from '../../components/Dialog';
import { Alert } from '../../components/ui';
import { useResolvedPrivacyMode } from '../../vault/usePrivacyMode';
import {
  PanelForm,
  PanelGroup,
  PanelHead,
  PanelList,
  PanelListItem,
  PanelNote,
  Row,
} from './panelKit';

const WEBHOOKS_KEY = ['settings', 'webhooks'] as const;
const deliveriesKey = (id: string) => ['settings', 'webhooks', id, 'deliveries'] as const;
// Which catalog entries a paranoid account can never receive comes from
// `isParanoidKilledWebhookEventType` (contracts), NOT from a list restated
// here: the server's PD3b enforcement registry is the truth and the API carries
// the drift-guard test that keeps the two equal, so a kill-listed event added
// later cannot silently stay offerable in this form.

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

/**
 * The one-time secret modal — the plaintext is available here and never again.
 * Stays a {@link Dialog} (`role="dialog" aria-modal="true"`): the Control
 * Center's Escape handler defers to nested modals via exactly that selector.
 */
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
            className="bt-panel bt-panel--soft bt-cc-mono flex-1"
            style={{ padding: '8px 11px', color: 'var(--bt-pos)' }}
          >
            {result.secret}
          </code>
          <Button onClick={copy} size="sm">
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
            size="sm"
            variant="primary"
          >
            {t('common.savedOneTimeSecret')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Create-webhook form: a URL, an optional label, and ≥1 of the 24 event types.
 * The two text fields sit in the popup's narrow form column; the event catalog
 * needs the whole pane, so its grid is a full-width sibling INSIDE the form
 * (a fieldset outside the form would lose its form association).
 */
function CreateWebhookForm({
  onCreated,
}: {
  onCreated: (result: CreateWebhookSubscriptionResponse) => void;
}) {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <PanelForm>
        <Field htmlFor="webhook-url" label={t('settings.api.webhooks.urlLabel')}>
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
        <Field htmlFor="webhook-description" label={t('settings.api.webhooks.descriptionLabel')}>
          <Input
            id="webhook-description"
            maxLength={200}
            name="webhook-description"
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('settings.api.webhooks.descriptionPlaceholder')}
            value={description}
          />
        </Field>
      </PanelForm>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="bt-label">{t('settings.api.webhooks.eventsLegend')}</legend>
        <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {WEBHOOK_EVENT_TYPES.filter(
            (type) => !paranoid || !isParanoidKilledWebhookEventType(type),
          ).map((type) => (
            <label
              className="bt-soft flex cursor-pointer items-center gap-2 text-[12.5px]"
              key={type}
            >
              <input
                checked={events.has(type)}
                className="h-4 w-4"
                onChange={() => toggle(type)}
                style={{ accentColor: 'var(--bt-gold)' }}
                type="checkbox"
              />
              <span>{t(`settings.api.webhooks.event.${EVENT_LABEL_KEY[type]}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {/* The panel's single primary action. */}
      <Button
        className="self-start"
        disabled={mutation.isPending}
        size="sm"
        type="submit"
        variant="primary"
      >
        {mutation.isPending
          ? t('settings.api.webhooks.creating')
          : t('settings.api.webhooks.create')}
      </Button>
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

  if (query.isPending) return <Skeleton height="h-12" />;
  if (query.isError)
    return <p className="bt-field__error">{t('settings.api.webhooks.deliveries.loadError')}</p>;

  const deliveries = query.data?.deliveries ?? [];
  if (deliveries.length === 0)
    return <PanelNote>{t('settings.api.webhooks.deliveries.empty')}</PanelNote>;

  return (
    <ul className="flex flex-col gap-1">
      {deliveries.map((d) => (
        <li className="bt-cc-row__hint flex flex-wrap items-center gap-2" key={d.id}>
          <Badge tone={d.status === 'success' ? 'pos' : 'neg'}>
            {d.status === 'success'
              ? t('settings.api.webhooks.deliveries.success')
              : t('settings.api.webhooks.deliveries.failed')}
          </Badge>
          <span className="bt-cc-mono">{d.eventType}</span>
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
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
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
    <PanelListItem
      actions={
        <>
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
        </>
      }
      main={
        <>
          <span className="flex min-w-0 items-center gap-2">
            <Badge tone={statusBadge.tone}>{statusBadge.text}</Badge>
            <span className="bt-cc-mono truncate">{subscription.url}</span>
          </span>
          {subscription.description ? (
            <span className="bt-cc-row__hint">{subscription.description}</span>
          ) : null}
          {/* An event this privacy mode never fires is MARKED, never dropped —
              the same rule the scope chips follow: the subscription really does
              carry it and it starts delivering again the moment paranoid mode
              is disabled, so a shortened list would misstate the endpoint. */}
          <span className="flex flex-wrap gap-1">
            {subscription.eventTypes.map((type) => {
              const inactive = paranoid && isParanoidKilledWebhookEventType(type);
              const label = inactive ? t('settings.api.webhooks.eventInactive') : undefined;
              return (
                <Badge className="bt-cc-mono" key={type} outline title={label}>
                  <span className={inactive ? 'line-through opacity-70' : undefined}>{type}</span>
                  {inactive ? (
                    <span className="bt-cc-row__hint ml-1 no-underline">({label})</span>
                  ) : null}
                </Badge>
              );
            })}
          </span>
          {/* A real constraint: repeated failures switch delivery off for good
              until the user re-enables it. */}
          {!subscription.enabled && subscription.disabledReason === 'auto' ? (
            <span className="bt-field__error">
              {t('settings.api.webhooks.disabledAutoHint', {
                count: subscription.consecutiveFailures,
              })}
            </span>
          ) : null}
          <span className="bt-cc-row__hint">
            {subscription.lastDeliveryAt
              ? t('settings.api.webhooks.lastDelivery', {
                  at: formatDate(subscription.lastDeliveryAt),
                })
              : t('settings.api.webhooks.neverDelivered')}
          </span>
        </>
      }
    >
      {showDeliveries ? (
        <div className="w-full pt-2">
          <DeliveriesList id={subscription.id} />
        </div>
      ) : null}
    </PanelListItem>
  );
}

/**
 * Control Center → Webhooks (§13.5 V5-P10; R2). Subscribe your own URLs to your
 * events; every delivery is HMAC-signed, the signing secret is shown ONCE, and a
 * receiver that keeps failing is auto-disabled until you re-enable it.
 *
 * R2 behaviour change (the only one): the outer collapse is GONE. It existed
 * because this section was nested inside the API-access page and paid for itself
 * by not fetching until opened; it is now the whole panel, so it renders
 * expanded and the list query is unconditional (no `enabled` gate).
 */
export function WebhooksPanel() {
  const t = useT();
  const [minted, setMinted] = useState<CreateWebhookSubscriptionResponse | null>(null);

  const query = useQuery({
    queryKey: WEBHOOKS_KEY,
    queryFn: ({ signal }) => listWebhooks(signal),
    staleTime: 15_000,
  });
  const subscriptions = query.data?.subscriptions ?? [];

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.webhooks')} />
      {/* Kept prose: every delivery is HMAC-signed, so a receiver can verify it. */}
      <PanelNote>{t('settings.api.webhooks.sectionDescription')}</PanelNote>

      <PanelGroup label={t('settings.api.webhooks.createTitle')}>
        <Row stack>
          <CreateWebhookForm onCreated={setMinted} />
        </Row>
      </PanelGroup>

      <PanelGroup label={t('settings.api.webhooks.listTitle')}>
        {query.isPending ? (
          <Row stack>
            <Skeleton height="h-16" />
          </Row>
        ) : query.isError ? (
          <Row stack>
            <Alert tone="error">{t('settings.api.webhooks.loadError.title')}</Alert>
          </Row>
        ) : subscriptions.length === 0 ? (
          <Row stack>
            <PanelNote>{t('settings.api.webhooks.empty.title')}</PanelNote>
          </Row>
        ) : (
          <PanelList>
            {subscriptions.map((subscription) => (
              <WebhookRow key={subscription.id} subscription={subscription} />
            ))}
          </PanelList>
        )}
      </PanelGroup>

      {minted ? <SecretModal onClose={() => setMinted(null)} result={minted} /> : null}
    </div>
  );
}
