import { useT } from '../../../../i18n';
import { PageHead, SectionHead } from '../../../../ui/origin';

import { VaultKeyDiagram } from './VaultKeyDiagram';

/**
 * `/vault/how-it-works` (`docs/VAULTS_V2_DESIGN.md` §4): the §2 diagram rendered
 * properly, what the server sees, what a breach yields, what a stolen device
 * yields in each storage mode, the lost-words consequence and the ticker
 * caveat.
 *
 * It is deliberately a full page, not a tooltip: the wizard and the settings
 * section both link here, and a user deciding whether to hand their money data
 * to a 12-word phrase deserves the whole argument in one place.
 */
export function VaultHowItWorksPage() {
  const t = useT();

  return (
    <div className="bt-money-surface flex flex-col">
      <PageHead sub={t('vault.v2.explainer.sub')} title={t('vault.v2.explainer.title')} />

      <section aria-label={t('vault.v2.explainer.keys.heading')} className="bt-section">
        <SectionHead title={t('vault.v2.explainer.keys.heading')} />
        <div className="bt-panel flex flex-col gap-4">
          <p className="bt-row-sub">{t('vault.v2.explainer.keys.body')}</p>
          <VaultKeyDiagram />
          <ul className="bt-band">
            {(['passphrase', 'contentKey', 'device', 'slots'] as const).map((point) => (
              <li className="bt-band__row bt-row-sub" key={point}>
                {t(`vault.v2.explainer.keys.points.${point}`)}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-label={t('vault.v2.explainer.server.heading')} className="bt-section">
        <SectionHead title={t('vault.v2.explainer.server.heading')} />
        <div className="bt-panel bt-band">
          {(['sees', 'seesNot', 'sizes'] as const).map((point) => (
            <div className="bt-band__row bt-settings-row" key={point}>
              <span className="bt-row-title">
                {t(`vault.v2.explainer.server.rows.${point}.label`)}
              </span>
              <span className="bt-row-sub">
                {t(`vault.v2.explainer.server.rows.${point}.value`)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section aria-label={t('vault.v2.explainer.outcomes.heading')} className="bt-section">
        <SectionHead
          sub={t('vault.v2.explainer.outcomes.sub')}
          title={t('vault.v2.explainer.outcomes.heading')}
        />
        <div className="flex flex-col gap-3">
          {(['breach', 'deviceWrapped', 'deviceRaw', 'lostWords'] as const).map((scenario) => (
            <div className="bt-panel bt-panel--soft flex flex-col gap-1" key={scenario}>
              <p className="bt-row-title">{t(`vault.v2.explainer.outcomes.${scenario}.title`)}</p>
              <p className="bt-row-sub">{t(`vault.v2.explainer.outcomes.${scenario}.body`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-label={t('vault.v2.explainer.caveats.heading')} className="bt-section">
        <SectionHead title={t('vault.v2.explainer.caveats.heading')} />
        <div className="bt-panel bt-danger-zone flex flex-col gap-2">
          {(['tickers', 'aliases', 'metadata', 'membership', 'qrPin', 'noRecovery'] as const).map(
            (caveat) => (
              <p className="bt-row-sub" key={caveat}>
                {t(`vault.v2.explainer.caveats.${caveat}`)}
              </p>
            ),
          )}
        </div>
      </section>
    </div>
  );
}

export default VaultHowItWorksPage;
