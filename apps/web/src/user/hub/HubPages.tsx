import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { Icon, PageHead, type IconName } from '../../ui/origin';
import { ParkedPage } from '../parked/ParkedPage';

/**
 * Suite utility destinations (PRODUCT_BLUEPRINT.md §4): Ask BetterTrack and
 * the Review inbox are parked workspaces with routes into today's closest live
 * capability. The Control Center itself is no longer a page — it is the
 * settings-absorbing overlay in `../control/ControlCenterOverlay.tsx`; what
 * stays here are the surfaces that are genuinely their own page (the Developer
 * platform). The Privacy panel moved to `../control/panels/PrivacyPanel.tsx`
 * when the overlay's panels were rebuilt for popup density (R2).
 */

export function AskPage() {
  const t = useT();
  return (
    <div className="bt-phone-surface bt-hub-page">
      <PageHead title={t('ask.title')} />
      <ParkedPage page="ask" />
    </div>
  );
}

export function ReviewPage() {
  const t = useT();
  return (
    <div className="bt-phone-surface bt-hub-page">
      <PageHead title={t('review.title')} />
      <ParkedPage page="review" />
    </div>
  );
}

interface DeveloperEntry {
  to: string;
  icon: IconName;
  labelKey: string;
  subKey: string;
  parked?: boolean;
}

/**
 * The Developer platform's own destinations. API keys and webhooks are Control
 * Center panels (they are settings); everything below is a page of its own.
 */
const DEVELOPER_ENTRIES: readonly DeveloperEntry[] = [
  {
    to: '/control/api',
    icon: 'key',
    labelKey: 'control.apiKeys',
    subKey: 'control.apiKeysSub',
  },
  {
    to: '/control/webhooks',
    icon: 'webhook',
    labelKey: 'control.webhooks',
    subKey: 'control.webhooksSub',
  },
  {
    to: '/control/feedback',
    icon: 'pen',
    labelKey: 'control.feedback',
    subKey: 'control.feedbackSub',
  },
  {
    to: '/developer/oauth-apps',
    icon: 'grid',
    labelKey: 'control.oauthApps',
    subKey: 'control.oauthAppsSub',
    parked: true,
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
];

/**
 * `/developer` — the Developer platform overview. A page of its own (the
 * Control Center links out to it), because integrations are a workspace rather
 * than a settings panel; the two live settings surfaces it owns (API keys,
 * webhooks) open back inside the Control Center overlay.
 */
export function DeveloperPlatformPage() {
  const t = useT();
  return (
    <div className="bt-phone-surface bt-hub-page">
      <PageHead sub={t('control.developerSub')} title={t('control.groups.developer')} />
      <div className="bt-panel bt-band">
        {DEVELOPER_ENTRIES.map((entry) => (
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
    </div>
  );
}
