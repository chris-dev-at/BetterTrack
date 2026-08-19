import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useT, type TranslateFn } from '../../i18n';
import { cx } from '../../lib/cx';
import { Button, Icon, Input, type IconName } from '../../ui/origin';
import { useOverlayEscape } from '../../ui/overlayStack';
import { useFocusTrap } from '../../ui/useFocusTrap';
import { AccountPanel } from './panels/AccountPanel';
import { ApiKeysPanel } from './panels/ApiKeysPanel';
import { AppearancePanel } from './panels/AppearancePanel';
import { AuthorizedAppsPanel } from './panels/AuthorizedAppsPanel';
import { ConnectionsPanel } from './panels/ConnectionsPanel';
import { DefaultsPanel } from './panels/DefaultsPanel';
import { DeleteAccountPanel } from './panels/DeleteAccountPanel';
import { FeedbackPanel } from './panels/FeedbackPanel';
import { NotificationLogPanel } from './panels/NotificationLogPanel';
import { NotificationsPanel } from './panels/NotificationsPanel';
import { OAuthAppsPanel } from './panels/OAuthAppsPanel';
import { ProfilePanel } from './panels/ProfilePanel';
import { SessionsPanel } from './panels/SessionsPanel';
import { SignInPanel } from './panels/SignInPanel';
import { WebhooksPanel } from './panels/WebhooksPanel';
import { usePhoneShell } from '../hooks/useCompactShell';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';
import { resolveControlPanelId } from './matchControlPanel';

/**
 * The privacy panel is the one panel that reaches into the vault stack, so it
 * loads on demand behind the overlay's own boundary — the shell around it
 * (and the page behind the popup) never unmounts for it.
 */
const LazyPrivacyPanel = lazy(() =>
  import('./panels/PrivacyPanel').then((module) => ({ default: module.PrivacyPanel })),
);

function PrivacyPanelBoundary() {
  return (
    <Suspense fallback={null}>
      <LazyPrivacyPanel />
    </Suspense>
  );
}

/**
 * The Control Center overlay (R2): the settings-absorbing popup that replaced
 * the old page of links and the standalone `/settings` shell. `/control` and
 * `/control/:panel` render one large modal over the (dimmed) app shell — left
 * pane a filterable, grouped panel nav, right pane the ACTIVE panel.
 *
 * It opens on top of the page the user was already on, which stays mounted and
 * visible behind the scrim (owner: the popup must not blank the canvas). The
 * shell owns that composition — it renders the page routes against the last
 * non-popup location and this component beside them ({@link matchControlPanel}).
 *
 * The panels are no longer the old `/settings/*` PAGE components mounted in
 * place: they were built for a full canvas (page-sized title stacks, stacked
 * cards, a paragraph under every control) and the popup had to claw the size
 * back with CSS. Each panel is now a popup-native component under `./panels/`
 * built on one grammar (`./panels/panelKit.tsx`) — same hooks, same endpoints,
 * same query keys, same confirmations, rebuilt as dense rows.
 *
 * The structure is grouped by what the user is DOING, not by which file exists,
 * and every panel answers ONE question:
 *   Account            — who am I, and how does the app render for me?
 *   Security           — how do I prove it's me? where am I signed in?
 *   Preferences        — how does the app behave for me?
 *   Connections & API  — what is plugged into my account?
 *   Danger zone        — the one irreversible action, on its own.
 *
 * Surfaces that are genuinely their own page — the Developer platform, the
 * Review inbox, Data management — stay pages and appear as clearly marked
 * link rows that LEAVE the popup (the ↗ affordance).
 */

interface ControlPanel {
  /** URL segment: `/control/<id>`. */
  id: string;
  labelKey: string;
  /** Localized setting/action names that make this panel discoverable. */
  keywordKeys: readonly [string, ...string[]];
  icon: IconName;
  Component: ComponentType;
  /** Destructive destination — rendered in negative ink, never in gold. */
  danger?: boolean;
}

interface ControlLink {
  to: string;
  labelKey: string;
  icon: IconName;
  /** Present in the structure, build lands later — carries the gold dot. */
  parked?: boolean;
}

interface ControlGroup {
  titleKey: string;
  panels: readonly ControlPanel[];
}

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    titleKey: 'control.groups.account',
    panels: [
      {
        id: 'account',
        labelKey: 'control.account',
        keywordKeys: [
          'settings.account.identity',
          'language.title',
          'settings.baseCurrency.title',
          'profile.icon.title',
          'settings.export.title',
        ],
        icon: 'user',
        Component: AccountPanel,
      },
      {
        id: 'appearance',
        labelKey: 'control.appearance',
        keywordKeys: [
          'settings.appearance.theme.title',
          'settings.appearance.theme.light',
          'settings.appearance.theme.dark',
          'settings.uiScale.title',
        ],
        icon: 'sun',
        Component: AppearancePanel,
      },
      {
        id: 'profile',
        labelKey: 'control.profile',
        keywordKeys: ['profile.groups.page', 'profile.bioLabel', 'profile.toggleLabel'],
        icon: 'globe',
        Component: ProfilePanel,
      },
    ],
  },
  {
    titleKey: 'control.groups.security',
    panels: [
      {
        id: 'sign-in',
        labelKey: 'control.signIn',
        keywordKeys: [
          'settings.password.title',
          'control.searchTerms.twoFactor',
          'settings.security.twoFactor.title',
          'settings.security.passkeys.title',
          'settings.security.pin.title',
        ],
        icon: 'shield',
        Component: SignInPanel,
      },
      {
        id: 'sessions',
        labelKey: 'control.sessions',
        keywordKeys: [
          'settings.security.sessions.title',
          'settings.security.sessions.logOutAllOthers',
        ],
        icon: 'user-lock',
        Component: SessionsPanel,
      },
    ],
  },
  {
    titleKey: 'control.groups.preferences',
    panels: [
      {
        id: 'defaults',
        labelKey: 'control.portfolioDefaults',
        keywordKeys: ['settings.taxes.title', 'settings.taxes.reportLink'],
        icon: 'percent',
        Component: DefaultsPanel,
      },
      {
        id: 'notifications',
        labelKey: 'control.notifications',
        keywordKeys: [
          'settings.notifications.groups.channels',
          'settings.notifications.digest.title',
          'settings.notifications.quietHours.title',
          'settings.notifications.mute.label',
          'settings.notifications.webPush.title',
        ],
        icon: 'bell',
        Component: NotificationsPanel,
      },
      {
        id: 'notification-log',
        labelKey: 'control.notificationLog',
        keywordKeys: [
          'settings.notifications.views.archived',
          'settings.notifications.markAllRead',
          'settings.notifications.deleteArchived',
        ],
        icon: 'inbox',
        Component: NotificationLogPanel,
      },
      {
        id: 'feedback',
        labelKey: 'control.feedback',
        keywordKeys: [
          'feedback.title',
          'feedback.settingsLabel',
          'feedback.categoryOption.feature',
          'feedback.categoryOption.bug',
        ],
        icon: 'pen',
        Component: FeedbackPanel,
      },
      {
        id: 'privacy',
        labelKey: 'control.privacy',
        keywordKeys: [
          'privacy.discreet.title',
          'vault.settings.title',
          'vault.settings.changePassphrase',
          'vault.settings.recoveryKit',
        ],
        icon: 'lock',
        Component: PrivacyPanelBoundary,
      },
    ],
  },
  {
    titleKey: 'control.groups.integrations',
    panels: [
      {
        id: 'connections',
        labelKey: 'control.connections',
        keywordKeys: [
          'settings.security.google.title',
          'settings.connections.drive.title',
          'settings.connections.slotsTitle',
        ],
        icon: 'link',
        Component: ConnectionsPanel,
      },
      {
        id: 'api',
        labelKey: 'control.apiKeys',
        keywordKeys: [
          'settings.api.keys.sectionTitle',
          'settings.api.keys.createTitle',
          'settings.api.scopesLegend',
        ],
        icon: 'key',
        Component: ApiKeysPanel,
      },
      {
        id: 'oauth-apps',
        labelKey: 'control.oauthApps',
        keywordKeys: [
          'settings.api.oauth.yourApps',
          'settings.api.oauth.registerTitle',
          'settings.api.oauth.redirectUrisLegend',
        ],
        icon: 'terminal',
        Component: OAuthAppsPanel,
      },
      {
        id: 'authorized-apps',
        labelKey: 'control.authorizedApps',
        keywordKeys: ['settings.api.grants.sectionDescription', 'settings.api.grants.revokeAccess'],
        icon: 'share',
        Component: AuthorizedAppsPanel,
      },
      {
        id: 'webhooks',
        labelKey: 'control.webhooks',
        keywordKeys: [
          'settings.api.webhooks.createTitle',
          'settings.api.webhooks.eventsLegend',
          'settings.api.webhooks.viewDeliveries',
          'settings.api.webhooks.pause',
        ],
        icon: 'webhook',
        Component: WebhooksPanel,
      },
    ],
  },
  {
    // The one irreversible action never shares a group with routine settings.
    titleKey: 'control.groups.danger',
    panels: [
      {
        id: 'delete-account',
        labelKey: 'control.deleteAccount',
        keywordKeys: ['settings.dangerZone.link'],
        icon: 'trash',
        Component: DeleteAccountPanel,
        danger: true,
      },
    ],
  },
];

/** Rows that leave the popup for a full page (marked with the ↗ affordance). */
export const CONTROL_LINKS: readonly ControlLink[] = [
  { to: '/developer', labelKey: 'control.developer', icon: 'code' },
  { to: '/review', labelKey: 'nav.review', icon: 'inbox', parked: true },
  { to: '/control/data', labelKey: 'control.dataManagement', icon: 'database', parked: true },
];

/** Flat lookup; the first entry (Account) is what a bare `/control` opens on. */
const PANELS: readonly ControlPanel[] = CONTROL_GROUPS.flatMap((group) => group.panels);

function findPanel(id: string | undefined, paranoid = false): ControlPanel {
  if (id === undefined) return PANELS[0]!;
  const resolved = resolveControlPanelId(id);
  return (
    PANELS.find((panel) => panel.id === resolved && (!paranoid || panel.id !== 'profile')) ??
    PANELS[0]!
  );
}

function matches(
  t: TranslateFn,
  labelKey: string,
  needle: string,
  keywordKeys: readonly string[] = [],
): boolean {
  return (
    needle === '' || [labelKey, ...keywordKeys].some((key) => t(key).toLowerCase().includes(needle))
  );
}

export interface ControlCenterOverlayProps {
  /**
   * Which panel to show. The shell passes it, because the popup is no longer a
   * route element — it is rendered *beside* the page routes so the page stays on
   * screen behind it. Falls back to the `:panel` route param, which keeps the
   * component mountable at a route (its own test suite does exactly that).
   */
  panel?: string;
  /**
   * Where to land when the popup closes with NO history behind it — a bookmark,
   * a pasted link, a fresh tab. The shell passes the page it drew behind the
   * popup, so closing reveals that page instead of jumping somewhere else.
   */
  closeTo?: string;
  /** The page shown behind this overlay, retained for contextual child actions. */
  screen?: string;
}

export function ControlCenterOverlay({
  panel,
  closeTo = '/',
  screen,
}: ControlCenterOverlayProps = {}) {
  const t = useT();
  const navigate = useNavigate();
  const params = useParams();
  const titleId = useId();
  const { containerRef: rootRef, onKeyDown } = useFocusTrap<HTMLDivElement>({
    inertBackground: true,
  });
  const [filter, setFilter] = useState('');
  const phone = usePhoneShell();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';

  const active = findPanel(panel ?? params.panel, paranoid);

  /** Esc / ✕ / scrim: back where the user came from, else {@link closeTo}. */
  const close = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(closeTo, { replace: true });
  }, [closeTo, navigate]);

  useOverlayEscape(true, close, rootRef);

  // The shared trap owns initial focus, background inerting and restoration;
  // body scroll stays locked while the popup owns the screen.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const needle = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      CONTROL_GROUPS.map((group) => ({
        titleKey: group.titleKey,
        panels: group.panels.filter(
          (panel) =>
            (!paranoid || panel.id !== 'profile') &&
            matches(t, panel.labelKey, needle, panel.keywordKeys),
        ),
      })).filter((group) => group.panels.length > 0),
    [needle, paranoid, t],
  );
  const links = CONTROL_LINKS.filter((link) => matches(t, link.labelKey, needle));
  const empty = groups.length === 0 && links.length === 0;

  const Active = active.Component;

  return createPortal(
    // Portalled to <body>, i.e. OUTSIDE the shell's `.bt-app` canvas — which is
    // where the app's ink, type scale, gold focus ring and scrollbar styling
    // live. The root carries `bt-app` itself and `bt-cc-root` neutralises its
    // page paint (this is an overlay, not a canvas).
    <div className="bt-app bt-cc-root" onKeyDown={onKeyDown} ref={rootRef} tabIndex={-1}>
      <div aria-hidden="true" className="bt-scrim" onClick={close} />
      <div className="bt-cc">
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className="bt-cc__panel"
          role="dialog"
          tabIndex={-1}
        >
          <div className="bt-cc__head">
            <h2 className="bt-dialog__title" id={titleId}>
              {t('control.title')}
            </h2>
            <Button
              aria-label={t('common.close')}
              icon="x"
              iconOnly
              onClick={close}
              size="sm"
              variant="quiet"
            />
          </div>

          <div className="bt-cc__body">
            {phone ? (
              <nav aria-label={t('control.navAria')} className="bt-cc__phone-nav">
                <select
                  aria-label={t('control.navAria')}
                  className="bt-select"
                  onChange={(event) =>
                    navigate(`/control/${event.target.value}`, { replace: true })
                  }
                  value={active.id}
                >
                  {groups.map((group) => (
                    <optgroup key={group.titleKey} label={t(group.titleKey)}>
                      {group.panels.map((panel) => (
                        <option key={panel.id} value={panel.id}>
                          {t(panel.labelKey)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {links.length > 0 ? (
                  <div className="bt-cc__phone-links">
                    {links.map((link) => (
                      <Link
                        className="bt-cc__phone-link"
                        key={link.to}
                        title={t('control.leavesPopup')}
                        to={link.to}
                      >
                        <Icon name={link.icon} size={15} />
                        <span>{t(link.labelKey)}</span>
                        {link.parked ? (
                          <span
                            aria-label={t('common.parked')}
                            className="bt-dot bt-dot--gold"
                            role="img"
                            title={t('common.parked')}
                          />
                        ) : null}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </nav>
            ) : (
              <nav aria-label={t('control.navAria')} className="bt-cc__nav">
                <div className="bt-cc__filter">
                  <Input
                    aria-label={t('control.filterAria')}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t('control.filterPlaceholder')}
                    type="search"
                    value={filter}
                  />
                </div>

                {groups.map((group) => (
                  <div className="bt-cc__group" key={group.titleKey}>
                    <p className="bt-label bt-cc__group-title">{t(group.titleKey)}</p>
                    {group.panels.map((panel) => {
                      const current = panel.id === active.id;
                      return (
                        <Link
                          aria-current={current ? 'page' : undefined}
                          className={cx(
                            'bt-cc__item',
                            current && 'is-active',
                            panel.danger && 'is-danger',
                          )}
                          key={panel.id}
                          // `replace`: the whole overlay session occupies ONE
                          // history entry — closing (Esc, scrim, ✕, browser Back)
                          // leaves in a single step no matter how many panels
                          // were visited, instead of unwinding them one by one.
                          replace
                          to={`/control/${panel.id}`}
                        >
                          <Icon name={panel.icon} size={16} />
                          <span className="bt-cc__item-label">{t(panel.labelKey)}</span>
                        </Link>
                      );
                    })}
                  </div>
                ))}

                {links.length > 0 ? (
                  <div className="bt-cc__group">
                    <p className="bt-label bt-cc__group-title">{t('control.groups.links')}</p>
                    {links.map((link) => (
                      <Link
                        className="bt-cc__item bt-cc__item--link"
                        key={link.to}
                        title={t('control.leavesPopup')}
                        to={link.to}
                      >
                        <Icon name={link.icon} size={16} />
                        <span className="bt-cc__item-label">
                          {t(link.labelKey)}
                          {link.parked ? (
                            <span
                              aria-label={t('common.parked')}
                              className="bt-dot bt-dot--gold"
                              role="img"
                              style={{ display: 'inline-block', marginLeft: 8 }}
                              title={t('common.parked')}
                            />
                          ) : null}
                        </span>
                        <Icon className="bt-cc__item-out" name="arrow-up-right" size={14} />
                      </Link>
                    ))}
                  </div>
                ) : null}

                {empty ? <p className="bt-cc__empty">{t('control.noMatches')}</p> : null}
              </nav>
            )}

            <div className="bt-cc__content" key={active.id}>
              {active.id === 'feedback' ? <FeedbackPanel screen={screen} /> : <Active />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
