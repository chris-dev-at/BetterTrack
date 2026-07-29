import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { Icon, PageHead, Switch, type IconName } from '../../ui/origin';
import { useAuth } from '../AuthContext';
import { ParkedPage } from '../parked/ParkedPage';

/**
 * Suite utility destinations (PRODUCT_BLUEPRINT.md §4): Ask BetterTrack and
 * the Review inbox are parked workspaces with routes into today's closest live
 * capability; the Control Center is the live hub over settings, data and the
 * developer platform.
 */

export function AskPage() {
  const t = useT();
  return (
    <div>
      <PageHead sub={t('ask.subtitle')} title={t('ask.title')} />
      <ParkedPage page="ask" />
    </div>
  );
}

export function ReviewPage() {
  const t = useT();
  return (
    <div>
      <PageHead sub={t('review.subtitle')} title={t('review.title')} />
      <ParkedPage page="review" />
    </div>
  );
}

interface ControlEntry {
  to: string;
  icon: IconName;
  labelKey: string;
  subKey: string;
  parked?: boolean;
}

interface ControlGroup {
  titleKey: string;
  entries: ControlEntry[];
}

const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    titleKey: 'control.groups.account',
    entries: [
      {
        to: '/settings/account',
        icon: 'user',
        labelKey: 'control.account',
        subKey: 'control.accountSub',
      },
      {
        to: '/settings/notifications',
        icon: 'bell',
        labelKey: 'control.notifications',
        subKey: 'control.notificationsSub',
      },
      {
        to: '/settings/security',
        icon: 'shield',
        labelKey: 'control.security',
        subKey: 'control.securitySub',
      },
      {
        to: '/settings/taxes',
        icon: 'percent',
        labelKey: 'control.taxes',
        subKey: 'control.taxesSub',
      },
    ],
  },
  {
    titleKey: 'control.groups.data',
    entries: [
      {
        to: '/settings/connections',
        icon: 'link',
        labelKey: 'control.connections',
        subKey: 'control.connectionsSub',
      },
      {
        to: '/settings/imports',
        icon: 'upload',
        labelKey: 'control.imports',
        subKey: 'control.importsSub',
      },
      {
        to: '/settings/backups',
        icon: 'cloud',
        labelKey: 'control.backups',
        subKey: 'control.backupsSub',
      },
      {
        to: '/control/privacy',
        icon: 'lock',
        labelKey: 'control.privacy',
        subKey: 'control.privacySub',
      },
      {
        to: '/control/data',
        icon: 'database',
        labelKey: 'control.dataManagement',
        subKey: 'control.dataManagementSub',
        parked: true,
      },
    ],
  },
  {
    titleKey: 'control.groups.developer',
    entries: [
      {
        to: '/developer',
        icon: 'code',
        labelKey: 'control.developer',
        subKey: 'control.developerSub',
      },
      {
        to: '/settings/api',
        icon: 'key',
        labelKey: 'control.apiKeys',
        subKey: 'control.apiKeysSub',
      },
      {
        to: '/developer/webhooks',
        icon: 'webhook',
        labelKey: 'control.webhooks',
        subKey: 'control.webhooksSub',
      },
      {
        to: '/developer/mcp',
        icon: 'terminal',
        labelKey: 'control.mcp',
        subKey: 'control.mcpSub',
        parked: true,
      },
      {
        to: '/developer/logs',
        icon: 'document',
        labelKey: 'control.logs',
        subKey: 'control.logsSub',
        parked: true,
      },
    ],
  },
];

export function ControlCenterPage() {
  const t = useT();
  return (
    <div>
      <PageHead sub={t('control.subtitle')} title={t('control.title')} />
      <div style={{ display: 'grid', gap: 26 }}>
        {CONTROL_GROUPS.map((group) => (
          <section aria-label={t(group.titleKey)} key={group.titleKey}>
            <p className="bt-label" style={{ marginBottom: 10 }}>
              {t(group.titleKey)}
            </p>
            <div className="bt-panel bt-band">
              {group.entries.map((entry) => (
                <Link
                  className="bt-band__row"
                  key={entry.to}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 13,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                  to={entry.to}
                >
                  <Icon name={entry.icon} size={17} style={{ color: 'var(--bt-muted)' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="bt-row-title">
                      {t(entry.labelKey)}
                      {entry.parked ? (
                        <span
                          aria-label={t('common.parked')}
                          className="bt-dot bt-dot--gold"
                          role="img"
                          style={{ display: 'inline-block', marginLeft: 8 }}
                          title={t('common.parked')}
                        />
                      ) : null}
                    </span>
                    <span className="bt-row-sub" style={{ display: 'block' }}>
                      {t(entry.subKey)}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={15} style={{ color: 'var(--bt-faint)' }} />
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * Privacy modes (§13.5 V5-P13): the live discreet-mode switch — every absolute
 * amount masked app-wide — next to the parked paranoid-vault surface whose
 * client foundations are already merged.
 */
export function PrivacyPage() {
  const t = useT();
  const { user, toggleDiscreetMode } = useAuth();
  const discreet = user?.discreetMode === true;

  return (
    <div>
      <PageHead sub={t('privacy.subtitle')} title={t('privacy.title')} />
      <div className="bt-panel bt-panel--pad" style={{ maxWidth: 760, marginBottom: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Icon name={discreet ? 'eye-off' : 'eye'} size={19} style={{ color: 'var(--bt-gold)' }} />
          <div style={{ flex: 1 }}>
            <p className="bt-row-title">{t('privacy.discreet.title')}</p>
            <p className="bt-row-sub">{t('privacy.discreet.body')}</p>
          </div>
          <Switch
            aria-label={t('privacy.discreet.title')}
            checked={discreet}
            onChange={() => {
              void toggleDiscreetMode().catch(() => {
                // Optimistic flip rolled back; the switch simply reflects state.
              });
            }}
          />
        </div>
      </div>
      <ParkedPage page="paranoid" />
    </div>
  );
}
