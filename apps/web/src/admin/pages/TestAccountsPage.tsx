import { useT } from '../../i18n';
import { useResource } from '../useResource';
import * as api from '../../lib/adminApi';
import type { AdminStats } from '@bettertrack/contracts';
import { WorkspaceTabs } from '../components/WorkspaceTabs';
import { Alert, Badge, KeyValueList, PageHeader, Panel, PanelHeader, cx } from '../components/ui';
import { TEXT_MUTED } from '../components/tokens';

/**
 * People → Test accounts — the W6 placeholder (#1406, Chief ruling 2026-08-29).
 *
 * The ruling put the test-account factory in the People workspace and kept it
 * OUT of W2: the tab exists so the IA is honest about where the feature will
 * live, the backend is a later package, and nothing here creates, extends or
 * deletes an account.
 *
 * The page states the recovered guardrails rather than showing an empty box,
 * because the interesting part of W6 is not the button — it is the constraints
 * the owner already ruled on (empty by default, one clearly-named synthetic
 * preset never cloned from real data, 1 h / 24 h / 7 d with a hard cap and no
 * "never"). Writing them down here is what stops the next implementer from
 * quietly relaxing them.
 */
export function TestAccountsPage() {
  const t = useT();
  const stats = useResource((signal) => api.getStats(signal), []);
  // Decorative counts: absent while the stats read is loading or failed, so a
  // missing number never reads as a confident zero.
  const counts = stats.loading || stats.error !== null ? undefined : tabCounts(stats.data);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={t('admin.nav.sections.people')}
        title={t('admin.testAccounts.title')}
        description={t('admin.testAccounts.subtitle')}
      />

      <WorkspaceTabs counts={counts} />

      <Alert tone="info">{t('admin.testAccounts.notShipped')}</Alert>

      <Panel padded={false}>
        <PanelHeader
          title={t('admin.testAccounts.plannedTitle')}
          description={t('admin.testAccounts.plannedDescription')}
          actions={<Badge tone="amber">{t('admin.common.soon')}</Badge>}
        />
        <div className="p-4">
          <KeyValueList
            rows={[
              {
                label: t('admin.testAccounts.rows.lifetime'),
                value: t('admin.testAccounts.rows.lifetimeValue'),
              },
              {
                label: t('admin.testAccounts.rows.contents'),
                value: t('admin.testAccounts.rows.contentsValue'),
              },
              {
                label: t('admin.testAccounts.rows.analytics'),
                value: t('admin.testAccounts.rows.analyticsValue'),
              },
              {
                label: t('admin.testAccounts.rows.notifications'),
                value: t('admin.testAccounts.rows.notificationsValue'),
              },
              {
                label: t('admin.testAccounts.rows.cleanup'),
                value: t('admin.testAccounts.rows.cleanupValue'),
              },
            ]}
          />
          <p className={cx('mt-4', TEXT_MUTED)}>{t('admin.testAccounts.why')}</p>
        </div>
      </Panel>
    </div>
  );
}

function tabCounts(stats: AdminStats | null): Record<string, number> | undefined {
  if (!stats) return undefined;
  return {
    '/admin/users': stats.userCount,
    '/admin/registration': stats.pendingRegistrationCount,
    '/admin/invites': stats.pendingInviteCount,
  };
}
