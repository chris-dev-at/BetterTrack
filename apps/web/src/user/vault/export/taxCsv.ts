import {
  taxYearReportResponseSchema,
  type TaxExportLocale,
  type TaxYearReportResponse,
} from '@bettertrack/contracts';

import { localizedMessage } from '../../../i18n';
import type { VaultSyncEngine } from '../sync';
import { asMoneyFailure, type VaultMoneyOutcome } from '../engine/errors';
import { assertVaultSnapshotCurrent, validatedVaultSnapshot } from '../engine/session';
import type { ClientTaxReport } from '../engine/types';

interface CsvCopy {
  section: string;
  summary: string[];
  germany: string[];
  positions: string[];
  sells: string[];
  dividends: string[];
  disclaimer: [string, string];
}

export interface ClientTaxCsv {
  filename: string;
  mediaType: 'text/csv;charset=utf-8';
  text: string;
}

/** Guarded client CSV generation over the same in-memory report used by print. */
export function createClientTaxCsv(
  sync: VaultSyncEngine,
  tax: ClientTaxReport,
  locale: TaxExportLocale = 'en',
): VaultMoneyOutcome<ClientTaxCsv> {
  try {
    const snapshot = validatedVaultSnapshot(sync);
    if (snapshot.vaultVersion !== tax.vaultVersion) {
      throw new DOMException('The vault changed during report generation.', 'AbortError');
    }
    const report = taxYearReportResponseSchema.parse(tax.report);
    const text = serializeTaxYearReportCsv(report, locale);
    assertVaultSnapshotCurrent(sync, snapshot);
    return {
      ok: true,
      value: {
        filename: `tax-report-${report.year}.csv`,
        mediaType: 'text/csv;charset=utf-8',
        text,
      },
    };
  } catch (cause) {
    return { ok: false, error: asMoneyFailure(cause) };
  }
}

function serializeTaxYearReportCsv(report: TaxYearReportResponse, locale: TaxExportLocale): string {
  const copy = csvCopy(locale);
  const lines: string[] = [];
  const summary = report.summary;

  lines.push(row([copy.section, copy.summary[0]!]));
  lines.push(row(copy.summary.slice(1)));
  lines.push(
    row([
      summary.year,
      money(summary.realizedPnlEur),
      money(summary.dividendsGrossEur),
      money(summary.taxWithheldEur),
      money(summary.taxRefundedEur),
      money(summary.taxNetEur),
    ]),
  );

  if (summary.de !== undefined) {
    lines.push('');
    lines.push(row([copy.section, copy.germany[0]!]));
    lines.push(row(copy.germany.slice(1)));
    lines.push(
      row([
        money(summary.de.allowanceUsedEur),
        money(summary.de.allowanceRemainingEur),
        money(summary.de.aktienPotInEur),
        money(summary.de.aktienPotOutEur),
        money(summary.de.sonstigePotInEur),
        money(summary.de.sonstigePotOutEur),
        money(summary.de.kapestEur),
        money(summary.de.soliEur),
      ]),
    );
  }

  lines.push('');
  lines.push(row([copy.section, copy.positions[0]!]));
  lines.push(row(copy.positions.slice(1)));
  for (const position of report.positions) {
    lines.push(
      row([
        position.asset.symbol,
        position.asset.name,
        money(position.realizedPnlEur),
        money(position.dividendsGrossEur),
        money(position.taxEur),
      ]),
    );
  }

  lines.push('');
  lines.push(row([copy.section, copy.sells[0]!]));
  lines.push(row(copy.sells.slice(1)));
  for (const position of report.positions) {
    for (const sell of position.sells) {
      lines.push(
        row([
          position.asset.symbol,
          position.asset.name,
          sell.executedAt.slice(0, 10),
          quantity(sell.quantity),
          money(sell.proceedsEur),
          money(sell.costBasisEur),
          money(sell.realizedPnlEur),
          sell.taxMode ?? '',
          sell.taxAmountEur === null ? '' : money(sell.taxAmountEur),
        ]),
      );
    }
  }

  lines.push('');
  lines.push(row([copy.section, copy.dividends[0]!]));
  lines.push(row(copy.dividends.slice(1)));
  for (const position of report.positions) {
    for (const dividend of position.dividends) {
      lines.push(
        row([
          position.asset.symbol,
          position.asset.name,
          dividend.executedAt.slice(0, 10),
          money(dividend.grossAmountEur),
          dividend.taxMode,
          dividend.taxAmountEur === null ? '' : money(dividend.taxAmountEur),
        ]),
      );
    }
  }

  lines.push('');
  lines.push(row([copy.section, copy.disclaimer[0]]));
  lines.push(row([copy.disclaimer[1]]));
  return `${lines.join('\r\n')}\r\n`;
}

function row(values: ReadonlyArray<string | number>): string {
  return values.map(field).join(',');
}

function field(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function money(value: number): string {
  return value.toFixed(2);
}

function quantity(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/, '');
}

/**
 * Registered labels stay byte-for-byte aligned with the server CSV serializer;
 * only the data source differs for a paranoid client.
 */
function csvCopy(locale: TaxExportLocale): CsvCopy {
  const message = (key: string) => localizedMessage(locale, `vaultExports.tax.${key}`);
  return {
    section: message('section'),
    summary: [
      message('summary'),
      message('year'),
      message('realizedEur'),
      message('dividendsGrossEur'),
      message('withheldEur'),
      message('refundedEur'),
      message('netEur'),
    ],
    germany: [
      message('germany'),
      message('allowanceUsedEur'),
      message('allowanceRemainingEur'),
      message('shareLossPotInEur'),
      message('shareLossPotOutEur'),
      message('otherLossPotInEur'),
      message('otherLossPotOutEur'),
      message('kapestEur'),
      message('soliEur'),
    ],
    positions: [
      message('positions'),
      message('symbol'),
      message('name'),
      message('realizedEur'),
      message('dividendsGrossEur'),
      message('taxEur'),
    ],
    sells: [
      message('sells'),
      message('symbol'),
      message('name'),
      message('date'),
      message('quantity'),
      message('proceedsEur'),
      message('costBasisEur'),
      message('realizedEur'),
      message('taxMode'),
      message('taxEur'),
    ],
    dividends: [
      message('dividends'),
      message('symbol'),
      message('name'),
      message('date'),
      message('grossEur'),
      message('taxMode'),
      message('taxEur'),
    ],
    disclaimer: [message('disclaimerLabel'), message('disclaimer')],
  };
}
