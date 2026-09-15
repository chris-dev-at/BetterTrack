import type { CashTag, ImportRow, ImportRowFlag } from '@bettertrack/contracts';

import type { TranslateFn } from '../../../i18n';
import { EM_DASH, formatDate, formatQuantity } from '../../../lib/format';
import { MoneyText } from '../../../ui';
import { Badge, type BadgeTone } from '../../../ui/origin';

/**
 * The staged rows exactly as the server holds them — the last thing a user sees
 * before anything is written.
 *
 * Everything in this table is READ from the preview payload; nothing is
 * recomputed client-side. That is the point: apply replays the decisions
 * staging persisted (the resolved asset, the content hash, the cash-rule tag
 * ids), so a table that derived its own view of any of them could show one
 * thing and book another. The two columns added for #964 are both server
 * facts —
 *
 *  - `ruleTagIds`: the cash-rule tags the row was PRE-TAGGED with at staging.
 *    Apply replays exactly these ids rather than re-running the rules, so what
 *    is rendered here is what the booked movement gets, even if the rule is
 *    edited in between. Ids are joined to names from the caller's own tag list.
 *  - `resolvedBy: 'user'`: this row's asset was pinned by a person, not matched
 *    exactly by the pipeline. Badged so a reviewer can tell the two apart at a
 *    glance instead of trusting every green row equally.
 */

const FLAG_TONES: Record<ImportRowFlag, BadgeTone> = {
  mapped: 'pos',
  duplicate: 'gold',
  unmapped: 'blue',
  error: 'neg',
};

/** The instrument cell: resolved catalog asset, or the file's own identity. */
function InstrumentCell({ row, t }: { row: ImportRow; t: TranslateFn }) {
  if (row.asset) {
    return (
      <span className="flex flex-col">
        <span className="flex items-baseline gap-2">
          <span className="bt-row-title">{row.asset.symbol}</span>
          <span className="bt-row-sub truncate">{row.asset.name}</span>
        </span>
        {row.resolvedBy === 'user' ? (
          <span>
            <Badge outline tone="blue">
              {t('portfolio.import.pinnedByYou')}
            </Badge>
          </span>
        ) : null}
      </span>
    );
  }
  const identity = row.name ?? row.symbol ?? row.isin;
  return identity ? (
    <span className="bt-muted truncate">{identity}</span>
  ) : (
    <span className="bt-muted">{EM_DASH}</span>
  );
}

function TagChips({
  ids,
  tagsById,
  t,
}: {
  ids: readonly string[];
  tagsById: Map<string, CashTag>;
  t: TranslateFn;
}) {
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const tag = tagsById.get(id);
        return (
          <Badge key={id} outline tone={tag ? 'neutral' : 'gold'}>
            {tag ? tag.name : t('portfolio.import.unknownTag')}
          </Badge>
        );
      })}
    </span>
  );
}

export function ImportPreviewTable({
  rows,
  tagsById,
  t,
}: {
  rows: ImportRow[];
  tagsById: Map<string, CashTag>;
  t: TranslateFn;
}) {
  // The tag column only earns its width when at least one row carries tags.
  const anyTags = rows.some((r) => (r.ruleTagIds?.length ?? 0) > 0);

  return (
    <div className="bt-table-wrap bt-table-wrap--panel">
      <table className="bt-table" style={{ minWidth: anyTags ? '52rem' : '44rem' }}>
        <thead>
          <tr>
            <th scope="col">{t('portfolio.import.table.row')}</th>
            <th scope="col">{t('portfolio.import.table.date')}</th>
            <th scope="col">{t('portfolio.import.table.type')}</th>
            <th scope="col">{t('portfolio.import.table.instrument')}</th>
            <th className="is-num" scope="col">
              {t('portfolio.import.table.quantity')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.import.table.price')}
            </th>
            <th className="is-num" scope="col">
              {t('portfolio.import.table.amount')}
            </th>
            {anyTags ? <th scope="col">{t('portfolio.import.table.tags')}</th> : null}
            <th scope="col">{t('portfolio.import.table.status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="bt-muted">{row.rowIndex}</td>
              <td className="bt-muted">{row.executedAt ? formatDate(row.executedAt) : EM_DASH}</td>
              <td className="bt-soft">
                {row.kind ? t(`portfolio.import.kind.${row.kind}`) : EM_DASH}
              </td>
              <td className="max-w-56">
                <InstrumentCell row={row} t={t} />
              </td>
              <td className="is-num bt-soft">
                {row.quantity === null ? EM_DASH : formatQuantity(row.quantity)}
              </td>
              <td className="is-num bt-soft">
                {row.price === null || !row.currency ? (
                  EM_DASH
                ) : (
                  <MoneyText amount={row.price} currency={row.currency} />
                )}
              </td>
              <td className="is-num bt-soft">
                {row.amountEur === null ? (
                  EM_DASH
                ) : (
                  /* The row's OWN currency, exactly as ImportReview renders it.
                     A decided row is already EUR (the cash ledger is EUR-only)
                     and reads the same either way; an UNDECIDED one still
                     carries the file's raw amount in the file's own currency, so
                     a hard-coded € made the Review and Confirm steps of one
                     wizard show the same row in two different currencies
                     immediately before money is booked. */
                  <MoneyText amount={row.amountEur} currency={row.currency ?? 'EUR'} />
                )}
              </td>
              {anyTags ? (
                <td>
                  {row.ruleTagIds && row.ruleTagIds.length > 0 ? (
                    <TagChips ids={row.ruleTagIds} tagsById={tagsById} t={t} />
                  ) : (
                    <span className="bt-muted">{EM_DASH}</span>
                  )}
                </td>
              ) : null}
              <td>
                <Badge tone={FLAG_TONES[row.flag]}>{t(`portfolio.import.flag.${row.flag}`)}</Badge>
                {row.message ? <div className="bt-meta mt-1 max-w-64">{row.message}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
