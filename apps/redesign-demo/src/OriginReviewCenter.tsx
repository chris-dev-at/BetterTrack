import { useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-review-center.css';

export type OriginReviewKind =
  | 'import'
  | 'automation'
  | 'collaboration'
  | 'sync'
  | 'tax'
  | 'oauth'
  | 'ai';

export type OriginReviewStatus = 'pending' | 'approved' | 'rejected';
export type OriginReviewPriority = 'urgent' | 'high' | 'normal' | 'low';
export type OriginReviewDecision = 'approved' | 'rejected';

export type OriginReviewReceipt = {
  decision: OriginReviewDecision;
  decidedAt: string;
  decidedBy: string;
  reference: string;
  note?: string;
};

export type OriginReviewSource =
  | string
  | {
      label: string;
      detail?: string;
      actor?: string;
      connectionId?: string;
    };

export type OriginReviewPortfolio =
  | string
  | {
      id?: string;
      name: string;
      path?: string;
    };

export type OriginReviewEntry = {
  id: string;
  kind: OriginReviewKind;
  title: string;
  summary: string;
  portfolio: OriginReviewPortfolio;
  source: OriginReviewSource;
  requestedAt: string;
  requestedBy?: string;
  status?: OriginReviewStatus;
  priority?: OriginReviewPriority;
  risk?: 'low' | 'medium' | 'high';
  affectedCount?: number;
  tags?: string[];
  approveLabel?: string;
  rejectLabel?: string;
  diff?: Array<{
    label: string;
    before?: string;
    after: string;
    tone?: 'neutral' | 'positive' | 'negative' | 'warning';
    detail?: string;
  }>;
  calculations?: Array<{
    label: string;
    value: string;
    detail?: string;
    tone?: 'neutral' | 'positive' | 'negative' | 'warning';
  }>;
  lineage?: Array<{
    label: string;
    detail: string;
    at?: string;
    state?: 'verified' | 'derived' | 'external' | 'warning';
  }>;
  permissions?: Array<{
    label: string;
    detail?: string;
    outcome: 'allowed' | 'review' | 'blocked';
  }>;
  policies?: Array<{
    title: string;
    description: string;
    status: 'pass' | 'warning' | 'blocked';
  }>;
  receipt?: OriginReviewReceipt;
};

export type OriginReviewCenterProps = {
  items: OriginReviewEntry[];
  initialSelectedId?: string | null;
  onClose: () => void;
  onApprove: (item: OriginReviewEntry, receipt: OriginReviewReceipt) => void;
  onReject: (item: OriginReviewEntry, receipt: OriginReviewReceipt) => void;
};

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'all';
type KindFilter = OriginReviewKind | 'all';

const kindMeta: Record<
  OriginReviewKind,
  { label: string; shortLabel: string; icon: IconName; description: string }
> = {
  import: {
    label: 'Import review',
    shortLabel: 'Import',
    icon: 'upload',
    description: 'Staged records, duplicates, and mapping decisions',
  },
  automation: {
    label: 'Automation',
    shortLabel: 'Automate',
    icon: 'repeat',
    description: 'Scheduled portfolio and cash-flow changes',
  },
  collaboration: {
    label: 'Collaboration',
    shortLabel: 'People',
    icon: 'people',
    description: 'Proposals and access-sensitive portfolio changes',
  },
  sync: {
    label: 'Connection sync',
    shortLabel: 'Sync',
    icon: 'refresh',
    description: 'Provider changes and conflict resolution',
  },
  tax: {
    label: 'Tax & basis',
    shortLabel: 'Tax',
    icon: 'document',
    description: 'Missing basis, lot treatment, and tax assumptions',
  },
  oauth: {
    label: 'Application access',
    shortLabel: 'OAuth',
    icon: 'link',
    description: 'Third-party software requesting portfolio permissions',
  },
  ai: {
    label: 'AI proposal',
    shortLabel: 'AI',
    icon: 'sparkles',
    description: 'Scoped plans drafted by Ask BetterTrack',
  },
};

const priorityRank: Record<OriginReviewPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function portfolioName(portfolio: OriginReviewPortfolio) {
  return typeof portfolio === 'string' ? portfolio : portfolio.name;
}

function portfolioPath(portfolio: OriginReviewPortfolio) {
  return typeof portfolio === 'string' ? undefined : portfolio.path;
}

function sourceLabel(source: OriginReviewSource) {
  return typeof source === 'string' ? source : source.label;
}

function sourceDetail(source: OriginReviewSource) {
  if (typeof source === 'string') return undefined;
  return [source.actor, source.detail].filter(Boolean).join(' · ') || undefined;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IE', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function statusFor(
  item: OriginReviewEntry,
  localReceipts: Record<string, OriginReviewReceipt>,
): OriginReviewStatus {
  return localReceipts[item.id]?.decision ?? item.receipt?.decision ?? item.status ?? 'pending';
}

function receiptFor(
  item: OriginReviewEntry,
  localReceipts: Record<string, OriginReviewReceipt>,
): OriginReviewReceipt | null {
  const explicit = localReceipts[item.id] ?? item.receipt;
  if (explicit) return explicit;
  if (item.status && item.status !== 'pending') {
    return {
      decision: item.status,
      decidedAt: item.requestedAt,
      decidedBy: 'Workspace reviewer',
      reference: `RVW-${item.id
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 8)
        .toUpperCase()}`,
    };
  }
  return null;
}

function statusLabel(status: OriginReviewStatus) {
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  return 'Open';
}

function permissionIcon(outcome: 'allowed' | 'review' | 'blocked'): IconName {
  if (outcome === 'allowed') return 'check';
  if (outcome === 'blocked') return 'lock';
  return 'shield';
}

export function OriginReviewCenter({
  items,
  initialSelectedId,
  onClose,
  onApprove,
  onReject,
}: OriginReviewCenterProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(
    (initialSelectedId && items.some((item) => item.id === initialSelectedId)
      ? initialSelectedId
      : items.find((item) => (item.status ?? 'pending') === 'pending')?.id) ??
      items[0]?.id ??
      null,
  );
  const [localReceipts, setLocalReceipts] = useState<Record<string, OriginReviewReceipt>>({});
  const [confirming, setConfirming] = useState<OriginReviewDecision | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const dialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose: () => {
      if (confirming) {
        setConfirming(null);
        setAcknowledged(false);
        setDecisionNote('');
      } else {
        onClose();
      }
    },
    initialFocusSelector: '[data-review-initial-focus]',
  });

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...items]
      .filter((item) => {
        const status = statusFor(item, localReceipts);
        if (statusFilter !== 'all' && status !== statusFilter) return false;
        if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
        if (!normalizedQuery) return true;
        const haystack = [
          item.title,
          item.summary,
          portfolioName(item.portfolio),
          portfolioPath(item.portfolio),
          sourceLabel(item.source),
          sourceDetail(item.source),
          item.requestedBy,
          ...(item.tags ?? []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .sort((left, right) => {
        const statusDelta =
          (statusFor(left, localReceipts) === 'pending' ? 0 : 1) -
          (statusFor(right, localReceipts) === 'pending' ? 0 : 1);
        if (statusDelta !== 0) return statusDelta;
        return priorityRank[left.priority ?? 'normal'] - priorityRank[right.priority ?? 'normal'];
      });
  }, [items, kindFilter, localReceipts, query, statusFilter]);

  useEffect(() => {
    if (filteredItems.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!filteredItems.some((item) => item.id === selectedId)) {
      setSelectedId(filteredItems[0]!.id);
    }
  }, [filteredItems, selectedId]);

  useEffect(() => {
    setConfirming(null);
    setAcknowledged(false);
    setDecisionNote('');
  }, [selectedId]);

  const selected = selectedId ? (items.find((item) => item.id === selectedId) ?? null) : null;
  const selectedStatus = selected ? statusFor(selected, localReceipts) : 'pending';
  const selectedReceipt = selected ? receiptFor(selected, localReceipts) : null;
  const approvalBlocked =
    selected?.policies?.some((policy) => policy.status === 'blocked') === true ||
    selected?.permissions?.some((permission) => permission.outcome === 'blocked') === true;

  const counts = useMemo(() => {
    const next = { pending: 0, approved: 0, rejected: 0, urgent: 0 };
    items.forEach((item) => {
      const status = statusFor(item, localReceipts);
      next[status] += 1;
      if (status === 'pending' && (item.priority === 'urgent' || item.priority === 'high')) {
        next.urgent += 1;
      }
    });
    return next;
  }, [items, localReceipts]);

  function openConfirmation(decision: OriginReviewDecision) {
    if (!selected || selectedStatus !== 'pending') return;
    setConfirming(decision);
    setAcknowledged(false);
    setDecisionNote('');
  }

  function cancelConfirmation() {
    setConfirming(null);
    setAcknowledged(false);
    setDecisionNote('');
  }

  function finalizeDecision() {
    if (!selected || !confirming) return;
    if (confirming === 'approved' && (!acknowledged || approvalBlocked)) return;
    if (confirming === 'rejected' && decisionNote.trim().length < 3) return;

    const receipt: OriginReviewReceipt = {
      decision: confirming,
      decidedAt: new Date().toISOString(),
      decidedBy: 'You · Demo workspace',
      reference: `RVW-${selected.id
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 6)
        .toUpperCase()}-${Date.now().toString().slice(-6)}`,
      ...(decisionNote.trim() ? { note: decisionNote.trim() } : {}),
    };

    setLocalReceipts((current) => ({ ...current, [selected.id]: receipt }));
    setStatusFilter(confirming);
    if (confirming === 'approved') onApprove(selected, receipt);
    else onReject(selected, receipt);
    cancelConfirmation();
  }

  return (
    <div
      className="orc-layer"
      data-accessible-dialog-layer
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="presentation"
    >
      <section
        aria-label="Review Center"
        aria-modal="true"
        className="orc-shell"
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        tabIndex={-1}
      >
        <header className="orc-header">
          <div className="orc-header__identity">
            <span className="orc-header__mark">
              <Icon name="inbox" size={19} />
              {counts.pending > 0 ? <i>{counts.pending}</i> : null}
            </span>
            <span>
              <h1>Review Center</h1>
            </span>
          </div>
          <button
            aria-label="Close Review Center"
            className="orc-close"
            onClick={onClose}
            type="button"
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="orc-toolbar">
          <label className="orc-search">
            <Icon name="search" size={15} />
            <input
              aria-label="Search review items"
              data-review-initial-focus
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search source, portfolio, proposal…"
              type="search"
              value={query}
            />
            <kbd>⌘ F</kbd>
          </label>
          <div aria-label="Filter by status" className="orc-status-filters">
            {(
              [
                ['pending', 'Open', counts.pending],
                ['approved', 'Approved', counts.approved],
                ['rejected', 'Rejected', counts.rejected],
                ['all', 'All', items.length],
              ] as Array<[StatusFilter, string, number]>
            ).map(([id, label, count]) => (
              <button
                aria-pressed={statusFilter === id}
                className={statusFilter === id ? 'is-active' : undefined}
                key={id}
                onClick={() => setStatusFilter(id)}
                type="button"
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <label className="orc-kind-filter">
            <Icon name="filter" size={14} />
            <span>Type</span>
            <select
              aria-label="Filter by review type"
              onChange={(event) => setKindFilter(event.target.value as KindFilter)}
              value={kindFilter}
            >
              <option value="all">All review types</option>
              {(Object.keys(kindMeta) as OriginReviewKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {kindMeta[kind].label}
                </option>
              ))}
            </select>
          </label>
          {(query || kindFilter !== 'all' || statusFilter !== 'pending') && (
            <button
              className="orc-clear-filters"
              onClick={() => {
                setQuery('');
                setKindFilter('all');
                setStatusFilter('pending');
              }}
              type="button"
            >
              Clear
            </button>
          )}
        </div>

        <div className="orc-workspace">
          <aside className="orc-queue" aria-label="Review queue">
            <div className="orc-queue__list">
              {filteredItems.length > 0 ? (
                filteredItems.map((item) => {
                  const meta = kindMeta[item.kind];
                  const status = statusFor(item, localReceipts);
                  const priority = item.priority ?? 'normal';
                  return (
                    <button
                      aria-label={`Open ${item.title}`}
                      aria-pressed={selectedId === item.id}
                      className={cx(
                        'orc-queue-item',
                        status === 'pending' && 'is-pending',
                        selectedId === item.id && 'is-selected',
                        status !== 'pending' && 'is-resolved',
                      )}
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      type="button"
                    >
                      <span className={cx('orc-kind-icon', `orc-kind-icon--${item.kind}`)}>
                        <Icon name={meta.icon} size={16} />
                      </span>
                      <span className="orc-queue-item__body">
                        <span className="orc-queue-item__topline">
                          <small>{meta.shortLabel}</small>
                          <i
                            aria-label={`${priority} priority`}
                            className={`orc-priority orc-priority--${priority}`}
                          />
                          <time>{formatDateTime(item.requestedAt)}</time>
                        </span>
                        <strong>{item.title}</strong>
                        <span className="orc-queue-item__context">
                          <Icon name="portfolio" size={11} />
                          {portfolioName(item.portfolio)}
                        </span>
                      </span>
                      <Icon name="chevron-right" size={13} />
                    </button>
                  );
                })
              ) : (
                <div className="orc-empty orc-empty--queue">
                  <span>
                    <Icon name={items.length === 0 ? 'check' : 'search'} size={22} />
                  </span>
                  <strong>
                    {items.length === 0 ? 'Everything is reviewed' : 'No matching decisions'}
                  </strong>
                  <p>
                    {items.length === 0
                      ? 'New imports, proposals, and permission requests will appear here.'
                      : 'Try a broader search or clear the current filters.'}
                  </p>
                </div>
              )}
            </div>
          </aside>

          <main className="orc-detail" aria-live="polite">
            {selected ? (
              <>
                <div className="orc-detail__scroll">
                  <header className="orc-detail-header">
                    <div className="orc-detail-header__eyebrow">
                      <span className={cx('orc-kind-icon', `orc-kind-icon--${selected.kind}`)}>
                        <Icon name={kindMeta[selected.kind].icon} size={17} />
                      </span>
                      <span>
                        <small>{kindMeta[selected.kind].label}</small>
                      </span>
                      <span className={`orc-status orc-status--${selectedStatus}`}>
                        {selectedStatus === 'approved' ? <Icon name="check" size={11} /> : null}
                        {selectedStatus === 'rejected' ? <Icon name="x" size={11} /> : null}
                        {statusLabel(selectedStatus)}
                      </span>
                    </div>
                    <h2>{selected.title}</h2>
                    <p>{selected.summary}</p>
                    <div aria-label="Review context" className="orc-detail-header__context">
                      <span>
                        <Icon name="portfolio" size={13} />
                        <strong>{portfolioName(selected.portfolio)}</strong>
                      </span>
                      <span>
                        <Icon name="link" size={13} />
                        <strong>{sourceLabel(selected.source)}</strong>
                      </span>
                      <span>
                        <Icon name="calendar" size={13} />
                        <time>{formatDateTime(selected.requestedAt)}</time>
                      </span>
                      <span>
                        <Icon name="activity" size={13} />
                        <strong>
                          {selected.affectedCount != null
                            ? `${selected.affectedCount} ${
                                selected.affectedCount === 1 ? 'record' : 'records'
                              }`
                            : `${selected.risk ?? 'Low'} risk`}
                        </strong>
                        <em>{selected.priority ?? 'Normal'} priority</em>
                      </span>
                    </div>
                  </header>

                  {selected.risk === 'high' || approvalBlocked ? (
                    <section
                      className={cx(
                        'orc-risk-callout',
                        approvalBlocked ? 'is-blocked' : 'is-warning',
                      )}
                    >
                      <span>
                        <Icon name={approvalBlocked ? 'lock' : 'shield'} size={17} />
                      </span>
                      <div>
                        <strong>
                          {approvalBlocked
                            ? 'Approval is blocked by policy'
                            : 'This decision has a high downstream impact'}
                        </strong>
                        <p>
                          {approvalBlocked
                            ? 'Resolve the blocked permission or policy check before this change can be approved.'
                            : 'Review the source, calculation assumptions, and affected records before continuing.'}
                        </p>
                      </div>
                    </section>
                  ) : null}

                  <section className="orc-section">
                    <div className="orc-section__heading">
                      <h3>Before and after</h3>
                    </div>
                    {selected.diff?.length ? (
                      <div className="orc-diff">
                        {selected.diff.map((change) => (
                          <article key={`${change.label}-${change.after}`}>
                            <span>
                              <small>{change.label}</small>
                              {change.detail ? <em>{change.detail}</em> : null}
                            </span>
                            <span className="orc-diff__before">
                              <small>Current</small>
                              <strong>{change.before ?? 'Not present'}</strong>
                            </span>
                            <Icon name="arrow-right" size={14} />
                            <span
                              className={cx('orc-diff__after', `is-${change.tone ?? 'neutral'}`)}
                            >
                              <small>Proposed</small>
                              <strong>{change.after}</strong>
                            </span>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="orc-section-empty">
                        <Icon name="document" size={17} />
                        <span>
                          <strong>No direct ledger diff</strong>
                          <small>
                            This review changes access, policy, or synchronization state rather than
                            a financial record.
                          </small>
                        </span>
                      </div>
                    )}
                  </section>

                  <details className="orc-supporting">
                    <summary>
                      <span>
                        <Icon name="shield" size={17} />
                        <span>
                          <strong>Evidence & controls</strong>
                          <small>Calculations, sources and policy checks</small>
                        </span>
                      </span>
                      <span>
                        <span className="orc-supporting__closed-label">Review details</span>
                        <span className="orc-supporting__open-label">Hide details</span>
                        <Icon name="chevron-down" size={14} />
                      </span>
                    </summary>

                    <div className="orc-evidence-grid">
                      <section className="orc-section orc-calculations">
                        <div className="orc-section__heading">
                          <h3>Calculations</h3>
                          <Icon name="activity" size={16} />
                        </div>
                        {selected.calculations?.length ? (
                          <dl>
                            {selected.calculations.map((calculation) => (
                              <div key={`${calculation.label}-${calculation.value}`}>
                                <dt>
                                  {calculation.label}
                                  {calculation.detail ? <small>{calculation.detail}</small> : null}
                                </dt>
                                <dd className={`is-${calculation.tone ?? 'neutral'}`}>
                                  {calculation.value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : (
                          <div className="orc-section-empty orc-section-empty--compact">
                            <Icon name="help" size={15} />
                            <span>
                              <strong>No derived amounts</strong>
                              <small>
                                The decision is evaluated from permissions and policy only.
                              </small>
                            </span>
                          </div>
                        )}
                      </section>

                      <section className="orc-section orc-lineage">
                        <div className="orc-section__heading">
                          <h3>Source lineage</h3>
                          <Icon name="link" size={16} />
                        </div>
                        {selected.lineage?.length ? (
                          <ol>
                            {selected.lineage.map((event, index) => (
                              <li
                                className={`is-${event.state ?? 'verified'}`}
                                key={`${event.label}-${index}`}
                              >
                                <i>{index + 1}</i>
                                <span>
                                  <strong>{event.label}</strong>
                                  <small>{event.detail}</small>
                                  {event.at ? <time>{formatDateTime(event.at)}</time> : null}
                                </span>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <div className="orc-section-empty orc-section-empty--compact">
                            <Icon name="link" size={15} />
                            <span>
                              <strong>Direct workspace request</strong>
                              <small>
                                Source identity and decision receipt remain attached to the audit
                                trail.
                              </small>
                            </span>
                          </div>
                        )}
                      </section>
                    </div>

                    <section className="orc-section">
                      <div className="orc-section__heading">
                        <h3>Permission and policy</h3>
                        <span className={cx('orc-policy-result', approvalBlocked && 'is-blocked')}>
                          <Icon name={approvalBlocked ? 'lock' : 'shield'} size={13} />
                          {approvalBlocked ? 'Action blocked' : 'Manual decision required'}
                        </span>
                      </div>
                      <div className="orc-governance">
                        <div className="orc-permissions">
                          {(
                            selected.permissions ?? [
                              {
                                label: 'Review this proposal',
                                detail: 'Your role can approve or reject this change.',
                                outcome: 'allowed' as const,
                              },
                              {
                                label: 'Automatic execution',
                                detail: 'Disabled. A human receipt is required.',
                                outcome: 'review' as const,
                              },
                            ]
                          ).map((permission) => (
                            <span className={`is-${permission.outcome}`} key={permission.label}>
                              <i>
                                <Icon name={permissionIcon(permission.outcome)} size={13} />
                              </i>
                              <span>
                                <strong>{permission.label}</strong>
                                {permission.detail ? <small>{permission.detail}</small> : null}
                              </span>
                              <em>
                                {permission.outcome === 'allowed'
                                  ? 'Allowed'
                                  : permission.outcome === 'blocked'
                                    ? 'Blocked'
                                    : 'Review'}
                              </em>
                            </span>
                          ))}
                        </div>
                        <div className="orc-policies">
                          {(
                            selected.policies ?? [
                              {
                                title: 'Human approval policy',
                                description: 'No write is applied before an explicit decision.',
                                status: 'pass' as const,
                              },
                            ]
                          ).map((policy) => (
                            <article className={`is-${policy.status}`} key={policy.title}>
                              <Icon
                                name={
                                  policy.status === 'pass'
                                    ? 'check'
                                    : policy.status === 'blocked'
                                      ? 'lock'
                                      : 'help'
                                }
                                size={14}
                              />
                              <span>
                                <strong>{policy.title}</strong>
                                <small>{policy.description}</small>
                              </span>
                            </article>
                          ))}
                        </div>
                      </div>
                    </section>
                  </details>
                </div>

                <footer className="orc-decision">
                  {selectedStatus !== 'pending' && selectedReceipt ? (
                    <div
                      className={`orc-receipt orc-receipt--${selectedReceipt.decision}`}
                      role="status"
                    >
                      <span className="orc-receipt__mark">
                        <Icon
                          name={selectedReceipt.decision === 'approved' ? 'check' : 'x'}
                          size={18}
                        />
                      </span>
                      <span>
                        <small>DECISION RECEIPT</small>
                        <strong>
                          {selectedReceipt.decision === 'approved'
                            ? 'Change approved'
                            : 'Change rejected'}
                        </strong>
                        <p>
                          {selectedReceipt.decidedBy} · {formatDateTime(selectedReceipt.decidedAt)}
                        </p>
                        {selectedReceipt.note ? <em>“{selectedReceipt.note}”</em> : null}
                      </span>
                      <span className="orc-receipt__reference">
                        <small>REFERENCE</small>
                        <code>{selectedReceipt.reference}</code>
                        <span>
                          <Icon name="shield" size={11} /> Audit attached
                        </span>
                      </span>
                    </div>
                  ) : confirming ? (
                    <div className={`orc-confirm orc-confirm--${confirming}`}>
                      <span className="orc-confirm__identity">
                        <i>
                          <Icon name={confirming === 'approved' ? 'check' : 'x'} size={16} />
                        </i>
                        <span>
                          <small>CONFIRM DECISION</small>
                          <strong>
                            {confirming === 'approved'
                              ? 'Approve and apply this change?'
                              : 'Reject this proposed change?'}
                          </strong>
                          <p>
                            {confirming === 'approved'
                              ? 'The parent workspace will receive an approval receipt and apply its connected mutation.'
                              : 'The financial state will remain unchanged and the reason will be recorded.'}
                          </p>
                        </span>
                      </span>
                      {confirming === 'approved' ? (
                        <label className="orc-confirm__acknowledgement">
                          <input
                            checked={acknowledged}
                            onChange={(event) => setAcknowledged(event.target.checked)}
                            type="checkbox"
                          />
                          <span>
                            <strong>I reviewed the source, diff, and policy checks.</strong>
                            <small>This produces an accountable decision receipt.</small>
                          </span>
                        </label>
                      ) : (
                        <label className="orc-confirm__reason">
                          <span>Reason for rejection</span>
                          <textarea
                            autoFocus
                            onChange={(event) => setDecisionNote(event.target.value)}
                            placeholder="Explain what should be corrected…"
                            rows={2}
                            value={decisionNote}
                          />
                        </label>
                      )}
                      <div className="orc-confirm__actions">
                        <button onClick={cancelConfirmation} type="button">
                          Cancel
                        </button>
                        <button
                          className={confirming === 'approved' ? 'is-primary' : 'is-danger'}
                          disabled={
                            (confirming === 'approved' && (!acknowledged || approvalBlocked)) ||
                            (confirming === 'rejected' && decisionNote.trim().length < 3)
                          }
                          onClick={finalizeDecision}
                          type="button"
                        >
                          <Icon name={confirming === 'approved' ? 'check' : 'x'} size={13} />
                          {confirming === 'approved' ? 'Confirm approval' : 'Confirm rejection'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="orc-decision__actions">
                      <button
                        className="orc-reject-button"
                        onClick={() => openConfirmation('rejected')}
                        type="button"
                      >
                        <Icon name="x" size={13} />
                        {selected.rejectLabel ?? 'Reject'}
                      </button>
                      <button
                        className="orc-approve-button"
                        disabled={approvalBlocked}
                        onClick={() => openConfirmation('approved')}
                        type="button"
                      >
                        <Icon name={approvalBlocked ? 'lock' : 'check'} size={13} />
                        {approvalBlocked
                          ? 'Resolve blocked policy'
                          : (selected.approveLabel ?? 'Approve change')}
                      </button>
                    </div>
                  )}
                </footer>
              </>
            ) : (
              <div className="orc-empty orc-empty--detail">
                <span>
                  <Icon name={items.length === 0 ? 'check' : 'inbox'} size={26} />
                </span>
                <strong>
                  {items.length === 0 ? 'Your review queue is clear' : 'Choose a decision'}
                </strong>
                <p>
                  {items.length === 0
                    ? 'BetterTrack will collect the next import, proposal, or permission request here.'
                    : 'Select an item to inspect its change, evidence, and safety boundary.'}
                </p>
              </div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
