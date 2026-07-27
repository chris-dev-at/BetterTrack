import {
  taxYearReportResponseSchema,
  type TaxExportLocale,
  type TaxYearReportResponse,
} from '@bettertrack/contracts';

import { localizedMessage } from '../../../i18n';
import type { VaultSyncEngine } from '../sync';
import { asMoneyFailure, type VaultMoneyOutcome } from '../engine/errors';
import {
  assertTaxReportScope,
  assertVaultSnapshotCurrent,
  validatedVaultSnapshot,
} from '../engine/session';
import type { ClientTaxReport } from '../engine/types';

interface PrintCopy {
  title: string;
  summary: string;
  germany: string;
  positions: string;
  empty: string;
  year: string;
  realized: string;
  dividends: string;
  withheld: string;
  refunded: string;
  net: string;
  tax: string;
  date: string;
  quantity: string;
  proceeds: string;
  costBasis: string;
  gross: string;
  allowance: string;
  shareLossPot: string;
  otherLossPot: string;
  kapest: string;
  soli: string;
  disclaimer: string;
}

export interface PrintableTaxReport {
  title: string;
  mediaType: 'text/html;charset=utf-8';
  html: string;
  report: TaxYearReportResponse;
}

/**
 * A chrome-free print-to-PDF document. It consumes the identical in-memory
 * report object as the CSV path and contains no fetch or persistence step.
 */
export function createPrintableTaxReport(
  sync: VaultSyncEngine,
  portfolioId: string,
  tax: ClientTaxReport,
  locale: TaxExportLocale = 'en',
  portfolioName?: string,
): VaultMoneyOutcome<PrintableTaxReport> {
  try {
    const snapshot = validatedVaultSnapshot(sync);
    assertTaxReportScope(snapshot, portfolioId, tax);
    taxYearReportResponseSchema.parse(tax.report);
    const report = tax.report;
    const copy = printCopy(locale);
    const title = `${copy.title} ${report.year}`;
    const html = renderDocument(report, copy, locale, title, portfolioName);
    assertVaultSnapshotCurrent(sync, snapshot);
    return {
      ok: true,
      value: { title, mediaType: 'text/html;charset=utf-8', html, report },
    };
  } catch (cause) {
    return { ok: false, error: asMoneyFailure(cause) };
  }
}

function renderDocument(
  report: TaxYearReportResponse,
  copy: PrintCopy,
  locale: TaxExportLocale,
  title: string,
  portfolioName?: string,
): string {
  const summary = report.summary;
  const money = (value: number) => eur(value, locale);
  const summaryRows: Array<readonly [string, string]> = [
    [copy.year, String(summary.year)],
    [copy.realized, money(summary.realizedPnlEur)],
    [copy.dividends, money(summary.dividendsGrossEur)],
    [copy.withheld, money(summary.taxWithheldEur)],
    [copy.refunded, money(summary.taxRefundedEur)],
    [copy.net, money(summary.taxNetEur)],
  ];
  const germany =
    summary.de === undefined
      ? ''
      : section(
          copy.germany,
          table([
            [
              copy.allowance,
              `${money(summary.de.allowanceUsedEur)} / ${money(summary.de.allowanceRemainingEur)}`,
            ],
            [
              copy.shareLossPot,
              `${money(summary.de.aktienPotInEur)} / ${money(summary.de.aktienPotOutEur)}`,
            ],
            [
              copy.otherLossPot,
              `${money(summary.de.sonstigePotInEur)} / ${money(summary.de.sonstigePotOutEur)}`,
            ],
            [copy.kapest, money(summary.de.kapestEur)],
            [copy.soli, money(summary.de.soliEur)],
          ]),
        );
  const positions =
    report.positions.length === 0
      ? `<p>${escapeHtml(copy.empty)}</p>`
      : report.positions
          .map((position) => {
            const totals = table([
              [copy.realized, money(position.realizedPnlEur)],
              [copy.dividends, money(position.dividendsGrossEur)],
              [copy.tax, money(position.taxEur)],
            ]);
            const sells = position.sells.map((sell) => [
              sell.executedAt.slice(0, 10),
              quantity(sell.quantity, locale),
              money(sell.proceedsEur),
              money(sell.costBasisEur),
              money(sell.realizedPnlEur),
              sell.taxAmountEur === null ? '—' : money(sell.taxAmountEur),
            ]);
            const dividends = position.dividends.map((dividend) => [
              dividend.executedAt.slice(0, 10),
              money(dividend.grossAmountEur),
              dividend.taxAmountEur === null ? '—' : money(dividend.taxAmountEur),
            ]);
            return `<article><h3>${escapeHtml(position.asset.symbol)} · ${escapeHtml(
              position.asset.name,
            )}</h3>${totals}${
              sells.length === 0
                ? ''
                : dataTable(
                    [
                      copy.date,
                      copy.quantity,
                      copy.proceeds,
                      copy.costBasis,
                      copy.realized,
                      copy.tax,
                    ],
                    sells,
                  )
            }${
              dividends.length === 0 ? '' : dataTable([copy.date, copy.gross, copy.tax], dividends)
            }</article>`;
          })
          .join('');

  return `<!doctype html>
<html lang="${escapeHtml(locale)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body{font:14px system-ui,sans-serif;color:#171717;margin:16mm}h1,h2,h3{margin:.4em 0}
header,section,article{margin-bottom:18px}table{border-collapse:collapse;width:100%}
td{border-bottom:1px solid #d4d4d4;padding:5px 8px}td:last-child{text-align:right}
th{border-bottom:1px solid #a3a3a3;padding:5px 8px;text-align:left}
th:not(:first-child),td:not(:first-child){text-align:right}
article{border:1px solid #d4d4d4;border-radius:6px;padding:12px;break-inside:avoid}
footer{border-top:1px solid #d4d4d4;padding-top:10px;color:#525252;font-size:12px}
@media print{@page{margin:16mm}body{margin:0}}
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1>${
    portfolioName === undefined ? '' : `<p>${escapeHtml(portfolioName)}</p>`
  }</header>
${section(copy.summary, table(summaryRows))}
${germany}
${section(copy.positions, positions)}
<footer>${escapeHtml(copy.disclaimer)}</footer>
</body>
</html>`;
}

function section(title: string, body: string): string {
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function table(rows: ReadonlyArray<readonly [string, string]>): string {
  return `<table><tbody>${rows
    .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function dataTable(headers: readonly string[], rows: readonly string[][]): string {
  return `<table><thead><tr>${headers
    .map((header) => `<th>${escapeHtml(header)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function eur(value: number, locale: TaxExportLocale): string {
  const formatted = new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value === 0 ? 0 : value);
  return `${formatted} €`;
}

function quantity(value: number, locale: TaxExportLocale): string {
  return new Intl.NumberFormat(locale === 'de' ? 'de-AT' : 'en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8,
  }).format(value === 0 ? 0 : value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function printCopy(locale: TaxExportLocale): PrintCopy {
  const message = (key: string) => localizedMessage(locale, `vaultExports.tax.${key}`);
  return {
    title: message('title'),
    summary: message('summary'),
    germany: message('germany'),
    positions: message('positions'),
    empty: message('empty'),
    year: message('year'),
    realized: message('realized'),
    dividends: message('dividendsGross'),
    withheld: message('withheld'),
    refunded: message('refunded'),
    net: message('net'),
    tax: message('tax'),
    date: message('date'),
    quantity: message('quantity'),
    proceeds: message('proceeds'),
    costBasis: message('costBasis'),
    gross: message('gross'),
    allowance: message('allowance'),
    shareLossPot: message('shareLossPot'),
    otherLossPot: message('otherLossPot'),
    kapest: message('kapest'),
    soli: message('soli'),
    disclaimer: message('disclaimer'),
  };
}
