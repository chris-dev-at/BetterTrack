import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
import { useAiCapability } from '../../lib/aiApi';
import { Parked } from '../../ui/origin';

/**
 * Registry of parked destinations (PRODUCT_BLUEPRINT.md §10): every feature of
 * the target product is present in the structure today — surfaces whose build
 * lands later render a designed parking notice instead of disappearing. Copy
 * lives under `parked.<key>.*` in the i18n catalogs; `pointCount` says how many
 * `p1…pN` bullet keys exist; `links` route to the closest live capability.
 */
export interface ParkedSpec {
  key: string;
  pointCount: number;
  links?: ReadonlyArray<{ to: string; labelKey: string }>;
  /**
   * The page advertises shipped AI features (§6.18): with no local provider
   * configured every AI surface disappears, so the body falls back to the
   * `bodyUnavailable` copy and the links into those surfaces are dropped —
   * the page never walks the user to a screen that renders nothing.
   */
  aiGated?: boolean;
}

export const PARKED_PAGES = {
  portfolioPlan: {
    key: 'portfolioPlan',
    pointCount: 4,
    links: [
      { to: '/workbench/forecasts', labelKey: 'parked.links.forecasts' },
      { to: '/portfolio/rebalance', labelKey: 'parked.links.rebalancePage' },
      { to: '/portfolio/private-markets', labelKey: 'parked.links.privateMarkets' },
    ],
  },
  portfolioFiles: { key: 'portfolioFiles', pointCount: 3 },
  automate: {
    key: 'automate',
    pointCount: 3,
    links: [{ to: '/workbench/forecasts', labelKey: 'parked.links.standingOrders' }],
  },
  portfolioPeople: {
    key: 'portfolioPeople',
    pointCount: 3,
    links: [{ to: '/people', labelKey: 'parked.links.friends' }],
  },
  portfolioEvents: { key: 'portfolioEvents', pointCount: 3 },
  portfolioStructure: { key: 'portfolioStructure', pointCount: 3 },
  cashImport: {
    key: 'cashImport',
    pointCount: 3,
    links: [
      { to: '/portfolio/cash/movements', labelKey: 'parked.links.cashMovements' },
      { to: '/portfolio/cash/labels', labelKey: 'parked.links.cashRules' },
    ],
  },
  dataHealth: { key: 'dataHealth', pointCount: 4 },
  privateMarkets: { key: 'privateMarkets', pointCount: 3 },
  rebalance: {
    key: 'rebalance',
    pointCount: 3,
    links: [{ to: '/workbench/blueprints', labelKey: 'parked.links.blueprints' }],
  },
  studio: {
    key: 'studio',
    pointCount: 4,
    links: [
      { to: '/workbench/backtests', labelKey: 'parked.links.backtests' },
      { to: '/workbench/forecasts', labelKey: 'parked.links.forecasts' },
    ],
  },
  assetEvents: { key: 'assetEvents', pointCount: 3 },
  screener: {
    key: 'screener',
    pointCount: 3,
    links: [{ to: '/assets/search', labelKey: 'parked.links.search' }],
  },
  discover: {
    key: 'discover',
    pointCount: 3,
    links: [{ to: '/assets/search', labelKey: 'parked.links.search' }],
  },
  teams: {
    key: 'teams',
    pointCount: 3,
    links: [{ to: '/people', labelKey: 'parked.links.friends' }],
  },
  approvals: { key: 'approvals', pointCount: 3 },
  review: { key: 'review', pointCount: 4 },
  dataManagement: {
    key: 'dataManagement',
    pointCount: 3,
    // The Coming-Soon "Imports & exports" settings stub is gone (R2) — point at
    // the live broker/CSV import instead of a page that redirects back here.
    links: [{ to: '/portfolio/import', labelKey: 'parked.links.importsExports' }],
  },
  // `paranoid` lived here until PD8 shipped the real experience (wizard, gate,
  // day-to-day surfaces). Its copy is deleted with it — a parked page for a
  // built feature is a promise the app already keeps.
  mcp: { key: 'mcp', pointCount: 3 },
  developerLogs: { key: 'developerLogs', pointCount: 3 },
  oauthApps: { key: 'oauthApps', pointCount: 3 },
  ask: {
    key: 'ask',
    pointCount: 4,
    links: [
      { to: '/portfolio/analysis', labelKey: 'parked.links.aiInsights' },
      { to: '/workbench/blueprints/new', labelKey: 'parked.links.nlBuilder' },
    ],
    aiGated: true,
  },
} satisfies Record<string, ParkedSpec>;

export type ParkedPageKey = keyof typeof PARKED_PAGES;

export function ParkedPage({ page }: { page: ParkedPageKey }) {
  const spec: ParkedSpec = PARKED_PAGES[page];
  // Only the AI-advertising page pays for the capability read; every other
  // parked surface renders without it.
  if (spec.aiGated) return <AiGatedParked spec={spec} />;
  return <ParkedSurface spec={spec} aiAvailable />;
}

/** §6.18's single gate, applied to a page that talks about the AI features. */
function AiGatedParked({ spec }: { spec: ParkedSpec }) {
  const capability = useAiCapability();
  return <ParkedSurface aiAvailable={capability.data?.available === true} spec={spec} />;
}

function ParkedSurface({ spec, aiAvailable }: { spec: ParkedSpec; aiAvailable: boolean }) {
  const t = useT();
  const hidden = Boolean(spec.aiGated) && !aiAvailable;
  const links = hidden ? undefined : spec.links;
  const points = Array.from({ length: spec.pointCount }, (_, index) =>
    t(`parked.${spec.key}.p${index + 1}`),
  );
  return (
    <Parked
      actions={
        links?.length ? (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
            {links.map((link) => (
              <Link className="bt-btn bt-btn--sm" key={link.to} to={link.to}>
                {t(link.labelKey)}
              </Link>
            ))}
          </span>
        ) : undefined
      }
      body={t(`parked.${spec.key}.${hidden ? 'bodyUnavailable' : 'body'}`)}
      flag={t('parked.flag')}
      foot={t('parked.foot')}
      points={points}
      title={t(`parked.${spec.key}.title`)}
    />
  );
}
