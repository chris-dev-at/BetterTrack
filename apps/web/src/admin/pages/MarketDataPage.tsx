import { useT } from '../../i18n';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import { TEXT_MUTED } from '../components/tokens';
import { Alert, Badge, KeyValueList, PageHeader, Panel, PanelHeader, cx } from '../components/ui';

/**
 * Operations → Market data — the W5 placeholder (#1406, §16 ruling 2026-08-29).
 *
 * The ruling put the financial-data-integrity inspector in Operations as a tab,
 * because this workspace already owns the provider, queue and cache signals the
 * inspector reads — and kept it OUT of the package that folds the workspace.
 * The tab exists so the IA is honest about where the feature will live; nothing
 * here reads an instrument, enqueues a job, or touches a price.
 *
 * Like the W6 placeholder in People, this states the guardrails the DECISION
 * already fixed rather than showing an empty box. The guardrails are the
 * interesting part of W5: an inspector that could edit a price row would be a
 * money-math surface behind a browser session, and the two enqueues it IS
 * allowed are only safe because the jobs behind them are already idempotent.
 * Writing that down here is what stops the next implementer from relaxing it.
 */
export function MarketDataPage() {
  const t = useT();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description={t('admin.marketData.subtitle')}
        eyebrow={t('admin.nav.sections.operations')}
        title={t('admin.marketData.title')}
      />

      <WorkspaceTabs />

      <Alert tone="info">{t('admin.marketData.notShipped')}</Alert>

      <Panel padded={false}>
        <PanelHeader
          actions={<Badge tone="amber">{t('admin.common.soon')}</Badge>}
          description={t('admin.marketData.plannedDescription')}
          title={t('admin.marketData.plannedTitle')}
        />
        <div className="p-4">
          <KeyValueList
            rows={[
              {
                label: t('admin.marketData.rows.inspector'),
                value: t('admin.marketData.rows.inspectorValue'),
              },
              {
                label: t('admin.marketData.rows.detection'),
                value: t('admin.marketData.rows.detectionValue'),
              },
              {
                label: t('admin.marketData.rows.imports'),
                value: t('admin.marketData.rows.importsValue'),
              },
              {
                label: t('admin.marketData.rows.writes'),
                value: t('admin.marketData.rows.writesValue'),
              },
              {
                label: t('admin.marketData.rows.never'),
                value: t('admin.marketData.rows.neverValue'),
              },
            ]}
          />
          <p className={cx('mt-4', TEXT_MUTED)}>{t('admin.marketData.why')}</p>
        </div>
      </Panel>
    </div>
  );
}
