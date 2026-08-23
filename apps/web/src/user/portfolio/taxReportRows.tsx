import type { ReactNode } from 'react';

import type {
  TaxYearDeSummary,
  TaxYearPosition,
  TaxYearSell,
  TaxYearSummary,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import type { TranslateFn } from '../../i18n';
import { EM_DASH, formatDate, formatDateTime, formatQuantity } from '../../lib/format';
import { MoneyText } from '../../ui';
import { Panel } from '../../ui/origin';

/**
 * The presentational half of the tax report, shared by both derivations.
 *
 * `TaxReportPage` (server figures) and the lazily-loaded `ParanoidTaxReport`
 * (client-derived figures from the decrypted vault) render the SAME rows from
 * the same contract shapes — extracted here so the paranoid branch can live in
 * its own chunk without either page importing the other, and so a table change
 * can never apply to one mode only.
 */

/** One sell inside a year's drill-down (#369 uncovered sells render their real basis). */
function SellRow({ sell }: { sell: TaxYearSell }) {
  return (
    <tr>
      <td className="bt-muted">{formatDate(sell.executedAt)}</td>
      <td className="is-num bt-soft">{formatQuantity(sell.quantity)}</td>
      <td className="is-num bt-soft">
        <MoneyText amount={sell.proceedsEur} currency="EUR" />
      </td>
      <td className="is-num bt-soft">
        <MoneyText amount={sell.costBasisEur} currency="EUR" />
      </td>
      <td className="is-num">
        <MoneyText amount={sell.realizedPnlEur} currency="EUR" signed />
      </td>
      <td className="is-num bt-soft">
        {sell.taxAmountEur === null ? (
          <span className="bt-muted">{EM_DASH}</span>
        ) : (
          <MoneyText amount={sell.taxAmountEur} currency="EUR" />
        )}
      </td>
    </tr>
  );
}

/** One asset's block inside a year's drill-down. */
export function PositionBlock({ position, t }: { position: TaxYearPosition; t: TranslateFn }) {
  return (
    <Panel className="flex flex-col gap-2" soft>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <span className="bt-row-title">{position.asset.symbol}</span>
          <span className="bt-row-sub truncate">{position.asset.name}</span>
        </span>
        <span className="flex items-center gap-4">
          <span className="bt-meta">
            {t('portfolio.taxReport.realized')}{' '}
            <MoneyText amount={position.realizedPnlEur} currency="EUR" signed />
          </span>
          <span className="bt-meta">
            {t('portfolio.taxReport.tax')}{' '}
            <span className="bt-soft">
              <MoneyText amount={position.taxEur} currency="EUR" />
            </span>
          </span>
        </span>
      </div>
      {position.sells.length > 0 ? (
        <div className="bt-table-wrap">
          <table className="bt-table" style={{ fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col">{t('portfolio.taxReport.sell.date')}</th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.quantity')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.proceeds')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.costBasis')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.realized')}
                </th>
                <th className="is-num" scope="col">
                  {t('portfolio.taxReport.sell.tax')}
                </th>
              </tr>
            </thead>
            <tbody>
              {position.sells.map((sell) => (
                <SellRow key={sell.transactionId} sell={sell} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}

/** One label/value pair inside the compact DE year block. */
function DeStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * The German year-end block (V5-P4): the Sparer-Pauschbetrag consumed, both
 * loss pots entering → leaving the year, and the KapESt/Soli split — one
 * compact grid, shown only on years that actually carry DE-taxed rows
 * (anti-bloat: absent everywhere else).
 */
export function DeYearBlock({ de, t }: { de: TaxYearDeSummary; t: TranslateFn }) {
  const pot = (inEur: number, outEur: number) => (
    <>
      <MoneyText amount={inEur} currency="EUR" />
      <span aria-hidden="true" className="bt-muted">
        {' → '}
      </span>
      <MoneyText amount={outEur} currency="EUR" />
    </>
  );
  return (
    <Panel className="flex flex-col gap-2" soft>
      <span className="bt-row-title">{t('portfolio.taxReport.de.title')}</span>
      <dl className="bt-kv">
        <DeStat label={t('portfolio.taxReport.de.allowanceUsed')}>
          <MoneyText amount={de.allowanceUsedEur} currency="EUR" />
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.allowanceRemaining')}>
          <MoneyText amount={de.allowanceRemainingEur} currency="EUR" />
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.aktienPot')}>
          {pot(de.aktienPotInEur, de.aktienPotOutEur)}
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.sonstigePot')}>
          {pot(de.sonstigePotInEur, de.sonstigePotOutEur)}
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.kapest')}>
          <MoneyText amount={de.kapestEur} currency="EUR" />
        </DeStat>
        <DeStat label={t('portfolio.taxReport.de.soli')}>
          <MoneyText amount={de.soliEur} currency="EUR" />
        </DeStat>
      </dl>
    </Panel>
  );
}

/** One year's summary row with an expand toggle to its drill-down. */
export function YearRow({
  summary,
  expanded,
  onToggle,
  detail,
}: {
  summary: TaxYearSummary;
  expanded: boolean;
  onToggle: () => void;
  /** The drill-down content rendered while expanded (server-fetched or client-derived). */
  detail: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <tr>
        <td>
          <button
            aria-expanded={expanded}
            aria-label={t(
              expanded ? 'portfolio.taxReport.collapseYear' : 'portfolio.taxReport.expandYear',
              { year: summary.year },
            )}
            className="bt-row-title"
            onClick={onToggle}
            style={{
              alignItems: 'center',
              background: 'none',
              border: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              gap: 8,
              padding: 0,
            }}
            type="button"
          >
            <span aria-hidden="true" className="bt-muted">
              {expanded ? '▾' : '▸'}
            </span>
            {summary.year}
          </button>
          {summary.lastChangedAt ? (
            <span className="bt-meta ml-2">
              {t('portfolio.taxReport.lastEdited', {
                date: formatDateTime(summary.lastChangedAt),
              })}
            </span>
          ) : null}
        </td>
        <td className="is-num">
          <MoneyText amount={summary.realizedPnlEur} currency="EUR" signed />
        </td>
        <td className="is-num bt-soft">
          <MoneyText amount={summary.dividendsGrossEur} currency="EUR" />
        </td>
        <td className="is-num bt-soft">
          <MoneyText amount={summary.taxWithheldEur} currency="EUR" />
        </td>
        <td className="is-num bt-pos">
          {summary.taxRefundedEur > 0 ? (
            <MoneyText amount={summary.taxRefundedEur} currency="EUR" />
          ) : (
            <span className="bt-muted">{EM_DASH}</span>
          )}
        </td>
        <td className="is-num">
          <MoneyText amount={summary.taxNetEur} currency="EUR" />
        </td>
      </tr>
      {expanded ? (
        <tr style={{ background: 'var(--bt-bg-raised)' }}>
          <td colSpan={6} style={{ padding: 0 }}>
            {detail}
          </td>
        </tr>
      ) : null}
    </>
  );
}
