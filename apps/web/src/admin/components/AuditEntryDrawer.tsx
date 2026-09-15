import type { ReactNode } from 'react';

import type { AuditLogEntry } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { Modal } from './Modal';
import { TEXT_MICRO, TEXT_MONO, TEXT_MUTED, type Tone } from './tokens';
import { Badge, KeyValueList, cx } from './ui';

/**
 * The audit row detail overlay (#1908 §4).
 *
 * It replaces the six-column table's truncated `JSON.stringify` cell: the cell
 * keeps a short summary and this holds the detail, because a `max-w-xs truncate`
 * cell whose `title` tooltip carried the same stringified blob was the only way
 * to read `meta` — including the one call site that already records a structured
 * before/after (`oauthService`), which was unreadable through it.
 *
 * Built on the shared console `Modal`, which is already on the overlay-stack
 * Escape arbitration (#1302). Deliberately NOT a new overlay primitive: a second
 * one would need its own Escape ordering, its own focus trap and its own entry
 * in the mobile gate's primitive registry.
 *
 * It is its own module rather than a block inside `AuditPage`, because the
 * per-account mirror in People 360's Activity tab renders the same rows and must
 * not grow a second renderer for them.
 *
 * NOTHING here filters: what it shows is what the row holds. Secret redaction
 * and the paranoid resource-path redaction both happen on the WRITE path, so a
 * value this drawer can render is a value that was already safe to store — and a
 * renderer-side filter would have left the real one in the database for the full
 * 400-day retention (§10).
 */
export function AuditEntryDrawer({
  entry,
  onClose,
}: {
  entry: AuditLogEntry | null;
  onClose: () => void;
}) {
  const t = useT();
  if (!entry) return null;

  const diff = fieldDiff(entry.meta);
  const remainder = metaRemainder(entry.meta);

  return (
    <Modal title={t('admin.audit.drawer.title')} onClose={onClose} size="lg">
      <div className="flex flex-col gap-4">
        <KeyValueList
          rows={[
            { label: t('admin.audit.columns.when'), value: formatDateTime(entry.createdAt) },
            {
              label: t('admin.audit.columns.action'),
              value: <span className={TEXT_MONO}>{entry.action}</span>,
            },
            { label: t('admin.audit.columns.actor'), value: <ActorValue entry={entry} /> },
            {
              label: t('admin.audit.columns.target'),
              value: entry.targetType ? (
                <span className="flex flex-wrap items-baseline justify-end gap-2">
                  <span>{entry.targetType}</span>
                  {entry.targetId ? <span className={TEXT_MONO}>{entry.targetId}</span> : null}
                </span>
              ) : (
                EMPTY
              ),
            },
            {
              label: t('admin.audit.columns.ip'),
              value: entry.ip ? <span className={TEXT_MONO}>{entry.ip}</span> : EMPTY,
            },
            {
              label: t('admin.audit.drawer.entryId'),
              value: <span className={TEXT_MONO}>{entry.id}</span>,
            },
          ]}
        />

        {diff ? <DiffTable diff={diff} /> : null}

        {/* The REMAINDER, always — never instead of the diff and never dropped.
            `before`/`after` are rarely the whole row: `feature_flag.changed`
            parks the flag NAME in `meta.key` beside them, and an ADMIN-W5
            moderating write parks `moderationId` there. Rendering only the diff
            put both out of reach of the whole console, which is a regression
            against the row cell's old `title` tooltip — it at least stringified
            everything. */}
        {remainder === null ? (
          diff ? null : (
            <section className="flex flex-col gap-2">
              <h3 className={TEXT_MICRO}>{t('admin.audit.drawer.meta')}</h3>
              <p className={TEXT_MUTED}>{t('admin.audit.drawer.noMeta')}</p>
            </section>
          )
        ) : (
          <section className="flex flex-col gap-2">
            <h3 className={TEXT_MICRO}>{t('admin.audit.drawer.meta')}</h3>
            <MetaTree value={remainder} depth={0} />
          </section>
        )}
      </div>
    </Modal>
  );
}

const EMPTY = '—';

/** The actor cell's shared rendering, so the table and the drawer agree. */
export function ActorValue({ entry }: { entry: AuditLogEntry }) {
  const t = useT();
  const tone = ACTOR_TONE[entry.actorKind];

  if (entry.actor) {
    return (
      <span className="flex flex-wrap items-center justify-end gap-2">
        <span className="wrap-anywhere">{entry.actor.username}</span>
        <Badge tone={entry.actor.kind === 'admin' ? 'sky' : 'neutral'}>
          {t(`admin.audit.actorRole.${entry.actor.kind}`)}
        </Badge>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <Badge tone={tone}>{t(`admin.audit.actorKind.${entry.actorKind}`)}</Badge>
    </span>
  );
}

/**
 * Break-glass is red and nothing else is. The whole point of the kind is that
 * the product's highest-privilege event stops rendering like routine noise.
 */
const ACTOR_TONE: Record<AuditLogEntry['actorKind'], Tone> = {
  account: 'neutral',
  shell: 'red',
  unattributed: 'neutral',
};

type DiffState = 'changed' | 'added' | 'removed' | 'unchanged';

interface DiffRow {
  field: string;
  state: DiffState;
  before: unknown;
  after: unknown;
}

const DIFF_TONE: Record<DiffState, Tone> = {
  changed: 'amber',
  added: 'green',
  removed: 'red',
  unchanged: 'neutral',
};

/**
 * Read `{ before, after }` out of `meta`, or `null` when the row does not carry
 * one — in which case the tree below renders whatever the row does hold.
 *
 * `unchanged` is a real state, not a theoretical one: `oauth.client_updated`
 * records its whole triple on both sides whether or not each field moved, so a
 * reader has to be able to see that the scopes stayed put while the name changed.
 */
function fieldDiff(meta: unknown): DiffRow[] | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const record = meta as Record<string, unknown>;
  const before = record.before;
  const after = record.after;
  const beforeIsObject = isPlainObject(before);
  const afterIsObject = isPlainObject(after);
  if (!beforeIsObject && !afterIsObject) return null;

  const beforeRecord = beforeIsObject ? (before as Record<string, unknown>) : {};
  const afterRecord = afterIsObject ? (after as Record<string, unknown>) : {};
  const fields = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  if (fields.length === 0) return null;

  return fields.map((field) => {
    const hadBefore = Object.hasOwn(beforeRecord, field);
    const hasAfter = Object.hasOwn(afterRecord, field);
    const state: DiffState = !hadBefore
      ? 'added'
      : !hasAfter
        ? 'removed'
        : stringify(beforeRecord[field]) === stringify(afterRecord[field])
          ? 'unchanged'
          : 'changed';
    return { field, state, before: beforeRecord[field], after: afterRecord[field] };
  });
}

/**
 * Everything in `meta` that is NOT the `{ before, after }` pair — the keys the
 * diff table does not speak for.
 *
 * Returns `null` only when there is genuinely nothing left to show, so a row
 * whose whole payload IS the pair renders the diff alone rather than an empty
 * "Details" heading. A non-object `meta` (a bare string, an array) is its own
 * remainder: the diff never claimed it.
 */
function metaRemainder(meta: unknown): unknown {
  if (meta === null || meta === undefined) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const rest = Object.fromEntries(
    Object.entries(meta as Record<string, unknown>).filter(
      ([key]) => key !== 'before' && key !== 'after',
    ),
  );
  return Object.keys(rest).length > 0 ? rest : null;
}

function DiffTable({ diff }: { diff: DiffRow[] }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <h3 className={TEXT_MICRO}>{t('admin.audit.drawer.diff')}</h3>
      <div className="overflow-x-auto border border-neutral-800">
        <table className="w-full text-left" style={{ minWidth: '28rem' }}>
          <thead className="border-b border-neutral-800 bg-neutral-900">
            <tr>
              <th className={cx('px-3 py-2', TEXT_MICRO)}>{t('admin.audit.drawer.field')}</th>
              <th className={cx('px-3 py-2', TEXT_MICRO)}>{t('admin.audit.drawer.before')}</th>
              <th className={cx('px-3 py-2', TEXT_MICRO)}>{t('admin.audit.drawer.after')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {diff.map((row) => (
              <tr key={row.field} data-diff-state={row.state}>
                <td className="px-3 py-2 align-top">
                  <span className="flex flex-col items-start gap-1">
                    <span className="wrap-anywhere text-[13px] text-neutral-200">{row.field}</span>
                    <Badge tone={DIFF_TONE[row.state]}>
                      {t(`admin.audit.drawer.state.${row.state}`)}
                    </Badge>
                  </span>
                </td>
                <td className={cx('px-3 py-2 align-top wrap-anywhere', TEXT_MONO)}>
                  {row.state === 'added' ? EMPTY : stringify(row.before)}
                </td>
                <td className={cx('px-3 py-2 align-top wrap-anywhere', TEXT_MONO)}>
                  {row.state === 'removed' ? EMPTY : stringify(row.after)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * How deep the tree renders before it stops. `meta` is free-form jsonb; the
 * write path already bounds it, and this bounds the RENDER so a pathological
 * row cannot recurse the console instead of informing it.
 */
const MAX_TREE_DEPTH = 6;

function MetaTree({ value, depth }: { value: unknown; depth: number }): ReactNode {
  if (depth >= MAX_TREE_DEPTH || !isPlainObject(value)) {
    return <span className={cx('wrap-anywhere', TEXT_MONO)}>{stringify(value)}</span>;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className={TEXT_MONO}>{'{}'}</span>;

  return (
    <dl
      className={cx(
        'flex flex-col gap-1 border-l border-neutral-800 pl-3',
        depth === 0 ? 'border-l-0 pl-0' : null,
      )}
    >
      {entries.map(([key, child]) => (
        <div key={key} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <dt className={cx(TEXT_MICRO, 'sm:w-40 sm:shrink-0 wrap-anywhere')}>{key}</dt>
          <dd className="min-w-0 flex-1 text-[13px] text-neutral-200">
            <MetaTree value={child} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

const isPlainObject = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One-line rendering of a leaf value; arrays and failures degrade, never throw. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? EMPTY;
  } catch {
    return EMPTY;
  }
}
