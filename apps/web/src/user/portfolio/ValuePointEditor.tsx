import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ValuePoint } from '@bettertrack/contracts';

import { getValuePoints, putValuePoints } from '../../lib/portfolioApi';
import { Skeleton } from '../../ui';
import { Dialog } from '../components/Dialog';
import { Alert, Button, cx } from '../components/ui';

export interface ValuePointEditorAsset {
  id: string;
  symbol: string;
  name: string;
  currency: string;
}

export interface ValuePointEditorProps {
  asset: ValuePointEditorAsset;
  onClose: () => void;
  /** Called after a successful save so the page can refetch holdings + history. */
  onSaved: () => void;
  /** Today as ISO `YYYY-MM-DD`, injectable for deterministic tests. */
  today?: string;
}

interface EditRow {
  key: string;
  date: string;
  value: string;
}

const inputClass = cx(
  'w-full rounded-md bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
  'ring-1 ring-inset ring-neutral-700 placeholder:text-neutral-600',
  'focus:outline-none focus:ring-2 focus:ring-sky-500',
);

let rowSeq = 0;
function nextKey(): string {
  rowSeq += 1;
  return `vp-${rowSeq}`;
}

function isoToday(today?: string): string {
  if (today) return today;
  return new Date().toISOString().slice(0, 10);
}

function toEditRows(points: ValuePoint[]): EditRow[] {
  return points.map((p) => ({ key: nextKey(), date: p.date, value: String(p.value) }));
}

/** Validate the editable rows into a wire set, or return a human error. */
function validate(rows: EditRow[]): { points?: ValuePoint[]; error?: string } {
  const seen = new Set<string>();
  const points: ValuePoint[] = [];
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      return { error: 'Every row needs a valid date.' };
    }
    if (seen.has(row.date)) {
      return { error: `Only one value per day — ${row.date} is repeated.` };
    }
    seen.add(row.date);
    const value = Number(row.value);
    if (row.value.trim() === '' || !Number.isFinite(value) || value < 0) {
      return { error: `Value for ${row.date} must be 0 or more.` };
    }
    points.push({ date: row.date, value });
  }
  // Ascending by date — honest, ordered, and matches the GET response order.
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { points };
}

/**
 * Value-point editor for a custom asset (PROJECTPLAN.md §6.9, §7.3
 * `ValuePointEditor`). A list of (date, value) rows — add / edit / delete, one
 * per day — saved as a single full replace (`PUT`). Between points the value
 * carries forward (step function), so sparse data stays honest.
 */
export function ValuePointEditor({ asset, onClose, onSaved, today }: ValuePointEditorProps) {
  const [rows, setRows] = useState<EditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['custom-asset', asset.id, 'value-points'],
    queryFn: ({ signal }) => getValuePoints(asset.id, signal),
    staleTime: 0,
  });

  // Seed the editable rows once the existing points load.
  useEffect(() => {
    if (data) setRows(toEditRows(data.points));
  }, [data]);

  function updateRow(key: string, patch: Partial<EditRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((rs) => [...rs, { key: nextKey(), date: isoToday(today), value: '' }]);
    setError(null);
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
  }

  async function handleSave() {
    const { points, error: validationError } = validate(rows);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await putValuePoints(asset.id, points!);
      onSaved();
      onClose();
    } catch {
      setError('Could not save value points. Please try again.');
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={`Value points — ${asset.symbol}`}
      description="Record what this investment is worth over time. Between points the value carries forward."
      onClose={onClose}
      widthClassName="max-w-lg"
    >
      {isLoading ? (
        <div className="flex flex-col gap-2">
          <Skeleton height="h-9" />
          <Skeleton height="h-9" />
        </div>
      ) : isError ? (
        <Alert tone="error">Could not load value points. Please try again.</Alert>
      ) : (
        <div className="flex flex-col gap-4">
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No value points yet. Add one to start tracking this investment&rsquo;s worth.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              <li className="grid grid-cols-[1fr_1fr_auto] gap-2 px-1 text-xs uppercase tracking-wide text-neutral-500">
                <span>Date</span>
                <span>Value ({asset.currency})</span>
                <span className="sr-only">Remove</span>
              </li>
              {rows.map((row) => (
                <li key={row.key} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <input
                    type="date"
                    value={row.date}
                    onChange={(e) => updateRow(row.key, { date: e.target.value })}
                    aria-label="Value point date"
                    className={inputClass}
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    step="any"
                    min="0"
                    value={row.value}
                    onChange={(e) => updateRow(row.key, { value: e.target.value })}
                    aria-label="Value point amount"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(row.key)}
                    aria-label={`Remove value point ${row.date}`}
                    className="rounded p-2 text-neutral-500 hover:bg-neutral-800 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={addRow}
            className="self-start text-sm text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            + Add value point
          </button>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving…' : 'Save value points'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
