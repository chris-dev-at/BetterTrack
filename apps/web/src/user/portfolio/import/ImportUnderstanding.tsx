import type { ImportColumnMapping, ImportUnderstanding } from '@bettertrack/contracts';

import type { TranslateFn } from '../../../i18n';
import { Badge } from '../../../ui/origin';

/**
 * "Here is what I understood about your file" — the wizard's answer to §16
 * 2026-07-31 point 3 (*report what was understood, ask only about what could
 * not be*). Rendered only for a batch the GENERIC pipeline staged; a file a
 * broker mapper claimed labelled no columns and shows nothing here.
 *
 * ── THE AI BOUNDARY, IN THE UI ───────────────────────────────────────────────
 *
 * A column carrying `source: 'ai'` is a PROPOSAL, and this component is where
 * that word has to mean something to a person. Proposals are pulled OUT of the
 * table of columns in force and shown in their own block, labelled as
 * suggestions that are **not being used**, because that is literally true on
 * the server: an AI entry never enters `fieldWinners`, and `fieldWinners` is
 * the only thing values are read from. So the honest rendering is not "here is
 * a mapping we are unsure about" but "here is a guess we did not act on".
 *
 * There is deliberately no accept button yet. A confirm would have to re-stage
 * the file against the confirmed mapping, and the API has no endpoint for that
 * (the upload is not retained) — offering a control that silently did nothing,
 * or worse appeared to change the import, would be the actual violation. Until
 * that endpoint exists the proposal is information, and the user's lever is the
 * manual one: fix the export's headers, or import through a broker mapper.
 */

const CONFIDENCE_PERCENT = 100;

function confidenceLabel(mapping: ImportColumnMapping): string {
  return `${Math.round(mapping.confidence * CONFIDENCE_PERCENT)}%`;
}

function ColumnRow({ mapping, t }: { mapping: ImportColumnMapping; t: TranslateFn }) {
  return (
    <tr>
      <td className="bt-row-title">{mapping.header}</td>
      <td className="bt-soft">{t(`portfolio.import.field.${mapping.field}`)}</td>
      <td className="is-num bt-muted">{confidenceLabel(mapping)}</td>
      <td>
        {mapping.needsReview ? (
          <Badge tone="gold">{t('portfolio.import.understanding.needsReview')}</Badge>
        ) : (
          <Badge tone="pos">{t('portfolio.import.understanding.confident')}</Badge>
        )}
        <div className="bt-meta mt-1 max-w-64">{mapping.reason}</div>
        {mapping.alternative ? (
          <div className="bt-meta max-w-64">
            {t('portfolio.import.understanding.alternative', {
              header: mapping.alternative.header,
            })}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function ImportUnderstandingPanel({
  understanding,
  t,
}: {
  understanding: ImportUnderstanding;
  t: TranslateFn;
}) {
  // Proposals are separated from the mappings in force. Both halves are shown;
  // only the first half is what the import actually reads.
  const inForce = understanding.mappings.filter((m) => m.source !== 'ai');
  const proposals = understanding.mappings.filter((m) => m.source === 'ai');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Badge>
          {t('portfolio.import.understanding.delimiter', {
            delimiter: understanding.delimiter === '\t' ? '\\t' : understanding.delimiter,
          })}
        </Badge>
        <Badge>
          {t('portfolio.import.understanding.encoding', { encoding: understanding.encoding })}
        </Badge>
        <Badge>
          {t('portfolio.import.understanding.numbers', {
            locale: t(`portfolio.import.numberLocale.${understanding.numberLocale}`),
          })}
        </Badge>
        <Badge tone={understanding.dateLocaleAmbiguous ? 'neg' : 'neutral'}>
          {t('portfolio.import.understanding.dates', {
            locale: t(`portfolio.import.dateLocale.${understanding.dateLocale}`),
          })}
        </Badge>
      </div>

      {understanding.dateLocaleAmbiguous ? (
        <p className="bt-meta" role="alert">
          {t('portfolio.import.understanding.ambiguousDates')}
        </p>
      ) : null}

      <div className="bt-table-wrap bt-table-wrap--panel">
        <table className="bt-table" style={{ minWidth: '34rem' }}>
          <thead>
            <tr>
              <th scope="col">{t('portfolio.import.understanding.column')}</th>
              <th scope="col">{t('portfolio.import.understanding.readAs')}</th>
              <th className="is-num" scope="col">
                {t('portfolio.import.understanding.confidence')}
              </th>
              <th scope="col">{t('portfolio.import.understanding.evidence')}</th>
            </tr>
          </thead>
          <tbody>
            {inForce.map((mapping) => (
              <ColumnRow key={mapping.header} mapping={mapping} t={t} />
            ))}
          </tbody>
        </table>
      </div>

      {understanding.unmappedHeaders.length > 0 ? (
        <p className="bt-meta">
          {t('portfolio.import.understanding.unmapped', {
            headers: understanding.unmappedHeaders.join(', '),
          })}
        </p>
      ) : null}

      {proposals.length > 0 ? (
        <div className="bt-panel bt-panel--soft bt-panel--pad flex flex-col gap-2">
          <h3 className="bt-h3">{t('portfolio.import.understanding.proposalsTitle')}</h3>
          <p className="bt-meta" style={{ maxWidth: 640 }}>
            {t('portfolio.import.understanding.proposalsBody')}
          </p>
          <ul className="bt-band flex flex-col">
            {proposals.map((mapping) => (
              <li className="flex flex-wrap items-baseline gap-2 py-2" key={mapping.header}>
                <span className="bt-row-title">{mapping.header}</span>
                <span className="bt-muted">{'→'}</span>
                <span className="bt-soft">{t(`portfolio.import.field.${mapping.field}`)}</span>
                <Badge outline tone="gold">
                  {t('portfolio.import.understanding.suggestionOnly')}
                </Badge>
                {mapping.alternativeOf ? (
                  <span className="bt-meta">
                    {t('portfolio.import.understanding.wouldDisplace', {
                      header: mapping.alternativeOf.header,
                    })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
