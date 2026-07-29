import { Link } from 'react-router-dom';

import { useT } from '../../i18n';
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
  portfolioSettings: {
    key: 'portfolioSettings',
    pointCount: 3,
    links: [
      { to: '/control/portfolio-defaults', labelKey: 'parked.links.taxDefaults' },
      { to: '/portfolio/structure', labelKey: 'parked.links.structure' },
      { to: '/portfolio/events', labelKey: 'parked.links.events' },
      { to: '/portfolio/health', labelKey: 'parked.links.health' },
    ],
  },
  portfolioEvents: { key: 'portfolioEvents', pointCount: 3 },
  portfolioStructure: { key: 'portfolioStructure', pointCount: 3 },
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
  paranoid: {
    key: 'paranoid',
    pointCount: 4,
    links: [{ to: '/control/security', labelKey: 'parked.links.security' }],
  },
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
  },
} satisfies Record<string, ParkedSpec>;

export type ParkedPageKey = keyof typeof PARKED_PAGES;

export function ParkedPage({ page }: { page: ParkedPageKey }) {
  const t = useT();
  const spec: ParkedSpec = PARKED_PAGES[page];
  const points = Array.from({ length: spec.pointCount }, (_, index) =>
    t(`parked.${spec.key}.p${index + 1}`),
  );
  return (
    <Parked
      actions={
        spec.links?.length ? (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
            {spec.links.map((link) => (
              <Link className="bt-btn bt-btn--sm" key={link.to} to={link.to}>
                {t(link.labelKey)}
              </Link>
            ))}
          </span>
        ) : undefined
      }
      body={t(`parked.${spec.key}.body`)}
      flag={t('parked.flag')}
      foot={t('parked.foot')}
      points={points}
      title={t(`parked.${spec.key}.title`)}
    />
  );
}
