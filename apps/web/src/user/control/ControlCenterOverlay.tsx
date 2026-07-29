import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useT, type TranslateFn } from '../../i18n';
import { cx } from '../../lib/cx';
import { Button, Icon, Input, type IconName } from '../../ui/origin';
import { PrivacyPanel } from '../hub/HubPages';
import { AccountSettingsPage } from '../settings/AccountSettingsPage';
import { ApiAccessPage } from '../settings/ApiAccessPage';
import { ConnectionsPage } from '../settings/ConnectionsPage';
import { DeleteAccountPage } from '../settings/DeleteAccountPage';
import { NewPortfolioDefaultsPage } from '../settings/NewPortfolioDefaultsPage';
import { SecuritySettingsPage } from '../settings/SecuritySettingsPage';
import { NotificationSettingsPage } from '../settings/SettingsSection';
import { WebhooksSection } from '../settings/WebhooksSection';

/**
 * The Control Center overlay (R2): the settings-absorbing popup that replaced
 * the old page of links and the standalone `/settings` shell. `/control` and
 * `/control/:panel` render one large modal over the (dimmed) app shell — left
 * pane a filterable, grouped panel nav, right pane the ACTIVE panel's existing
 * page component mounted in place. Nothing was moved: each panel is the very
 * component the retired `/settings/*` routes rendered, so their standalone
 * tests keep passing and every legacy path redirects onto its panel.
 *
 * Surfaces that are genuinely their own page — the Developer platform, the
 * Review inbox, Data management — stay pages and appear as clearly marked
 * link rows that LEAVE the popup (the ↗ affordance).
 */

interface ControlPanel {
  /** URL segment: `/control/<id>`. */
  id: string;
  labelKey: string;
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
      { id: 'account', labelKey: 'control.account', icon: 'user', Component: AccountSettingsPage },
      {
        id: 'connections',
        labelKey: 'control.connections',
        icon: 'link',
        Component: ConnectionsPage,
      },
      {
        id: 'delete-account',
        labelKey: 'control.deleteAccount',
        icon: 'trash',
        Component: DeleteAccountPage,
        danger: true,
      },
    ],
  },
  {
    titleKey: 'control.groups.preferences',
    panels: [
      {
        id: 'portfolio-defaults',
        labelKey: 'control.portfolioDefaults',
        icon: 'percent',
        Component: NewPortfolioDefaultsPage,
      },
      {
        id: 'notifications',
        labelKey: 'control.notifications',
        icon: 'bell',
        Component: NotificationSettingsPage,
      },
      { id: 'privacy', labelKey: 'control.privacy', icon: 'lock', Component: PrivacyPanel },
    ],
  },
  {
    titleKey: 'control.groups.security',
    panels: [
      {
        id: 'security',
        labelKey: 'control.security',
        icon: 'shield',
        Component: SecuritySettingsPage,
      },
    ],
  },
  {
    titleKey: 'control.groups.automation',
    panels: [
      { id: 'api', labelKey: 'control.apiKeys', icon: 'key', Component: ApiAccessPage },
      {
        id: 'webhooks',
        labelKey: 'control.webhooks',
        icon: 'webhook',
        Component: WebhooksSection,
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

/** Elements the Tab trap cycles through — the panel itself is the fallback. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Is a nested modal (a delete confirm, the one-time token modal…) open above
 * us? Then Escape belongs to IT — the inner dialog closes itself first and the
 * overlay stays put. Portalled and in-tree dialogs both count.
 */
function hasNestedDialog(panel: HTMLElement | null): boolean {
  return [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(
    (el) => el !== panel,
  );
}

function matches(t: TranslateFn, labelKey: string, needle: string): boolean {
  return needle === '' || t(labelKey).toLowerCase().includes(needle);
}

export function ControlCenterOverlay() {
  const t = useT();
  const navigate = useNavigate();
  const params = useParams();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');

  const active = PANELS.find((panel) => panel.id === params.panel) ?? PANELS[0]!;

  /** Esc / ✕ / scrim: back where the user came from, else the Home canvas. */
  const close = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/', { replace: true });
  }, [navigate]);

  // Focus into the dialog on open, restore it on close; body scroll is locked
  // while the popup owns the screen (mirrors ODialog's discipline).
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (hasNestedDialog(panelRef.current)) return;
      close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  /** Focus trap: Tab cycles inside the panel, never back into the shell. */
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const stops = focusableIn(panel);
    if (stops.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const needle = filter.trim().toLowerCase();
  const groups = useMemo(
    () =>
      CONTROL_GROUPS.map((group) => ({
        titleKey: group.titleKey,
        panels: group.panels.filter((panel) => matches(t, panel.labelKey, needle)),
      })).filter((group) => group.panels.length > 0),
    [needle, t],
  );
  const links = CONTROL_LINKS.filter((link) => matches(t, link.labelKey, needle));
  const empty = groups.length === 0 && links.length === 0;

  const Active = active.Component;

  return createPortal(
    // Portalled to <body>, i.e. OUTSIDE the shell's `.bt-app` canvas — which is
    // where the app's ink, type scale, gold focus ring and scrollbar styling
    // live. The root carries `bt-app` itself and `bt-cc-root` neutralises its
    // page paint (this is an overlay, not a canvas).
    <div className="bt-app bt-cc-root">
      <button aria-label={t('common.close')} className="bt-scrim" onClick={close} type="button" />
      <div className="bt-cc">
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className="bt-cc__panel"
          onKeyDown={onKeyDown}
          ref={panelRef}
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

            <div className="bt-cc__content" key={active.id}>
              <Active />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
