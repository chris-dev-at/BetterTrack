import {
  taxYearReportResponseSchema,
  type TaxExportLocale,
  type TaxYearReportResponse,
} from '@bettertrack/contracts';

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

/**
 * Kept byte-for-byte aligned with the server CSV labels. The client serializer
 * is deliberately independent production code because paranoid mode must never
 * fetch the server tax-report endpoint.
 */
const COPY: Record<TaxExportLocale, CsvCopy> = {
  en: {
    section: 'Section',
    summary: [
      'Summary',
      'Year',
      'Realized P/L (EUR)',
      'Dividends gross (EUR)',
      'Tax withheld (EUR)',
      'Tax refunded (EUR)',
      'Net tax (EUR)',
    ],
    germany: [
      'Germany (Abgeltungsteuer)',
      'Allowance used (EUR)',
      'Allowance remaining (EUR)',
      'Share-loss pot in (EUR)',
      'Share-loss pot out (EUR)',
      'Other-loss pot in (EUR)',
      'Other-loss pot out (EUR)',
      'KapESt (EUR)',
      'Soli (EUR)',
    ],
    positions: [
      'Positions',
      'Symbol',
      'Name',
      'Realized P/L (EUR)',
      'Dividends gross (EUR)',
      'Tax (EUR)',
    ],
    sells: [
      'Sells',
      'Symbol',
      'Name',
      'Date',
      'Quantity',
      'Proceeds (EUR)',
      'Cost basis (EUR)',
      'Realized P/L (EUR)',
      'Tax mode',
      'Tax (EUR)',
    ],
    dividends: ['Dividends', 'Symbol', 'Name', 'Date', 'Gross (EUR)', 'Tax mode', 'Tax (EUR)'],
    disclaimer: [
      'Disclaimer',
      'Estimates for your personal overview only — not tax advice, no guarantee of correctness, not a filing document.',
    ],
  },
  de: {
    section: 'Abschnitt',
    summary: [
      'Zusammenfassung',
      'Jahr',
      'Realisierter G/V (EUR)',
      'Dividenden brutto (EUR)',
      'Einbehaltene Steuer (EUR)',
      'Erstattete Steuer (EUR)',
      'Netto-Steuer (EUR)',
    ],
    germany: [
      'Deutschland (Abgeltungsteuer)',
      'Genutzter Pauschbetrag (EUR)',
      'Verbleibender Pauschbetrag (EUR)',
      'Aktien-Verlusttopf ein (EUR)',
      'Aktien-Verlusttopf aus (EUR)',
      'Sonstiger Verlusttopf ein (EUR)',
      'Sonstiger Verlusttopf aus (EUR)',
      'KapESt (EUR)',
      'Soli (EUR)',
    ],
    positions: [
      'Positionen',
      'Symbol',
      'Name',
      'Realisierter G/V (EUR)',
      'Dividenden brutto (EUR)',
      'Steuer (EUR)',
    ],
    sells: [
      'Verkäufe',
      'Symbol',
      'Name',
      'Datum',
      'Anzahl',
      'Erlös (EUR)',
      'Einstand (EUR)',
      'Realisierter G/V (EUR)',
      'Steuermodus',
      'Steuer (EUR)',
    ],
    dividends: [
      'Dividenden',
      'Symbol',
      'Name',
      'Datum',
      'Brutto (EUR)',
      'Steuermodus',
      'Steuer (EUR)',
    ],
    disclaimer: [
      'Haftungsausschluss',
      'Schätzwerte nur für deine persönliche Übersicht — keine Steuerberatung, keine Gewähr für Richtigkeit, kein Dokument für die Steuererklärung.',
    ],
  },
};

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
  const copy = COPY[locale];
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
