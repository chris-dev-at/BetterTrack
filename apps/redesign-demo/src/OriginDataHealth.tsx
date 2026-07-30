import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-data-health.css';

export type OriginDataHealthPortfolio = {
  id: string;
  name: string;
};

export type OriginDataHealthProps = {
  portfolio: OriginDataHealthPortfolio;
  onClose: () => void;
  onOpenImport: () => void;
  onOpenFiles: () => void;
  onOpenTax: () => void;
  onOpenConnections: () => void;
  onOpenReview: () => void;
  onSubmitReview: (entry: OriginReviewEntry) => void;
  onToast: (message: string) => void;
};

type HealthView = 'issues' | 'policies' | 'audit';
type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';
type IssueStatus = 'open' | 'evidence-requested' | 'pending-review' | 'resolved' | 'ignored';
type IssueKind =
  | 'missing-cost-basis'
  | 'stale-valuation'
  | 'duplicate-activity'
  | 'unlinked-document'
  | 'currency-mismatch';
type IssueDestination = 'import' | 'files' | 'tax' | 'connections' | 'review';
type ActionKind = 'resolve' | 'ignore' | 'evidence';
type AuditTone = 'success' | 'attention' | 'neutral';

type LineageStep = {
  label: string;
  detail: string;
  at: string;
  state: 'verified' | 'derived' | 'external' | 'warning';
};

type ResolutionReceipt = {
  id: string;
  action: 'resolved' | 'ignored' | 'evidence-requested' | 'review-submitted';
  at: string;
  actor: string;
  reason: string;
  reviewId?: string;
};

type HealthIssue = {
  id: string;
  kind: IssueKind;
  title: string;
  summary: string;
  objectType: string;
  objectName: string;
  objectReference: string;
  affectedField: string;
  source: string;
  sourceDetail: string;
  severity: IssueSeverity;
  status: IssueStatus;
  observedValue: string;
  expectedValue: string;
  impact: string;
  recommendation: string;
  destination: IssueDestination;
  requiresReview: boolean;
  updatedAt: string;
  lineage: LineageStep[];
  receipt?: ResolutionReceipt;
};

type CheckPolicy = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  severity: IssueSeverity;
  cadence: 'Every sync' | 'Daily' | 'Weekly';
  threshold: number;
  unit: string;
};

type HealthAuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  object: string;
  receipt: string;
  tone: AuditTone;
};

type PersistedHealthState = {
  version: 1;
  scopeId: string;
  issues: HealthIssue[];
  policies: CheckPolicy[];
  audit: HealthAuditEvent[];
  lastRunAt: string;
};

type PendingWorkflow = {
  issueId: string;
  kind: ActionKind;
} | null;

const severityRank: Record<IssueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const statusLabels: Record<IssueStatus, string> = {
  open: 'Open',
  'evidence-requested': 'Evidence requested',
  'pending-review': 'In review',
  resolved: 'Resolved',
  ignored: 'Ignored',
};

const destinationMeta: Record<IssueDestination, { label: string; helper: string; icon: IconName }> =
  {
    import: {
      label: 'Open source import',
      helper: 'Inspect the source row and mapping',
      icon: 'upload',
    },
    files: {
      label: 'Open portfolio files',
      helper: 'Find or attach supporting evidence',
      icon: 'folder',
    },
    tax: {
      label: 'Open tax & lots',
      helper: 'Review basis and lot treatment',
      icon: 'document',
    },
    connections: {
      label: 'Open connection',
      helper: 'Inspect source currency and mapping',
      icon: 'link',
    },
    review: {
      label: 'Open Review',
      helper: 'Approve or reject the proposed correction',
      icon: 'inbox',
    },
  };

function makeId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function nowLabel() {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}

function storageKey(portfolio: OriginDataHealthPortfolio) {
  const safe = portfolio.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `bt-origin-data-health-v1-${safe || 'portfolio'}`;
}

function seedIssues(portfolio: OriginDataHealthPortfolio): HealthIssue[] {
  return [
    {
      id: 'health_basis_vwce_2024',
      kind: 'missing-cost-basis',
      title: 'Acquisition cost is incomplete',
      summary: '8.43 VWCE units arrived without an original acquisition price.',
      objectType: 'Holding lot',
      objectName: 'Vanguard FTSE All-World · Lot 2024-09-18',
      objectReference: 'LOT-VWCE-240918-03',
      affectedField: 'lot.acquisitionCost',
      source: 'Flatex',
      sourceDetail: 'Depot AT · ••9204 · CSV import row 184',
      severity: 'critical',
      status: 'open',
      observedValue: 'Not supplied',
      expectedValue: 'EUR acquisition amount + fees',
      impact: '€1,036.40 of unrealised return and Austrian tax basis cannot be verified.',
      recommendation: 'Attach the original contract note or enter a documented basis correction.',
      destination: 'tax',
      requiresReview: true,
      updatedAt: 'Today · 05:18',
      lineage: [
        {
          label: 'Imported activity',
          detail: 'Inbound transfer of 8.43 VWCE units',
          at: '18 Sep 2024 · 09:14',
          state: 'external',
        },
        {
          label: 'Source field',
          detail: 'Einstandswert was empty in Flatex row 184',
          at: '27 Jul 2026 · 05:17',
          state: 'warning',
        },
        {
          label: 'Portfolio calculation',
          detail: 'Market value is included; return and tax basis are excluded',
          at: '27 Jul 2026 · 05:18',
          state: 'derived',
        },
      ],
    },
    {
      id: 'health_valuation_riverside',
      kind: 'stale-valuation',
      title: 'Property valuation exceeds policy age',
      summary: 'The Riverside property valuation is 148 days old; policy allows 90 days.',
      objectType: 'Private asset valuation',
      objectName: 'Riverside property · Independent valuation',
      objectReference: 'VAL-RIVER-2026-0228',
      affectedField: 'valuation.asOf',
      source: 'Portfolio files',
      sourceDetail: 'Riverside valuation · February 2026.pdf',
      severity: 'high',
      status: 'evidence-requested',
      observedValue: '28 Feb 2026 · €428,000',
      expectedValue: 'Valuation dated within 90 days',
      impact:
        'Portfolio allocation and controlled wealth totals use a potentially stale €428,000 value.',
      recommendation: 'Upload a current appraisal or confirm a defensible valuation carry-forward.',
      destination: 'files',
      requiresReview: false,
      updatedAt: 'Yesterday · 16:42',
      lineage: [
        {
          label: 'Evidence document',
          detail: 'Signed independent valuation, checksum verified',
          at: '28 Feb 2026 · 11:20',
          state: 'verified',
        },
        {
          label: 'Asset link',
          detail: 'Document linked to Riverside property',
          at: '28 Feb 2026 · 11:23',
          state: 'verified',
        },
        {
          label: 'Freshness check',
          detail: '148 days old against a 90-day portfolio policy',
          at: '27 Jul 2026 · 05:18',
          state: 'warning',
        },
      ],
      receipt: {
        id: 'HLT-EVD-2048',
        action: 'evidence-requested',
        at: '26 Jul 2026 · 16:42',
        actor: 'You',
        reason: 'Requested an updated appraisal from the property manager.',
      },
    },
    {
      id: 'health_duplicate_aapl',
      kind: 'duplicate-activity',
      title: 'Two activities may describe one trade',
      summary:
        'An Apple buy from Drive overlaps a broker-synced execution by time, units, and price.',
      objectType: 'Portfolio activity',
      objectName: 'Apple · Buy 4 shares · 12 Jun 2026',
      objectReference: 'ACT-AAPL-260612-118',
      affectedField: 'activity.identity',
      source: 'Google Drive + Flatex',
      sourceDetail: 'Contract note row 22 ↔ broker execution FLX-832911',
      severity: 'high',
      status: 'open',
      observedValue: '2 records · 4 shares each · €188.14',
      expectedValue: '1 canonical activity',
      impact: 'Apple units and invested capital may be overstated by €752.56.',
      recommendation: 'Merge into the broker execution and retain the Drive document as evidence.',
      destination: 'import',
      requiresReview: true,
      updatedAt: 'Today · 05:18',
      lineage: [
        {
          label: 'Broker sync',
          detail: 'Execution FLX-832911 imported as canonical activity',
          at: '12 Jun 2026 · 15:34',
          state: 'external',
        },
        {
          label: 'Drive extraction',
          detail: 'Contract note row 22 created a second activity',
          at: '13 Jun 2026 · 08:05',
          state: 'external',
        },
        {
          label: 'Identity check',
          detail: '99.7% match across ISIN, quantity, unit price, and execution minute',
          at: '27 Jul 2026 · 05:18',
          state: 'warning',
        },
      ],
    },
    {
      id: 'health_unlinked_document',
      kind: 'unlinked-document',
      title: 'Statement has no portfolio object link',
      summary:
        'A current Trade Republic statement is stored but not linked to activities or holdings.',
      objectType: 'Portfolio document',
      objectName: 'Trade Republic statement · June 2026.pdf',
      objectReference: 'DOC-TR-JUN26-082',
      affectedField: 'document.objectLinks',
      source: 'Google Drive',
      sourceDetail: '/BetterTrack/Statements/Trade Republic',
      severity: 'medium',
      status: 'open',
      observedValue: '0 object links',
      expectedValue: 'At least 1 activity or account link',
      impact:
        'The file remains searchable, but it cannot support reconciliation or audit evidence.',
      recommendation: 'Open Files and link the statement to its account and June activities.',
      destination: 'files',
      requiresReview: false,
      updatedAt: 'Today · 05:18',
      lineage: [
        {
          label: 'Drive watch',
          detail: 'File detected in the watched statement folder',
          at: '02 Jul 2026 · 07:10',
          state: 'external',
        },
        {
          label: 'Document scan',
          detail: 'Checksum verified; classified as broker statement',
          at: '02 Jul 2026 · 07:11',
          state: 'verified',
        },
        {
          label: 'Object linking',
          detail: 'No matching account or activity links were confirmed',
          at: '27 Jul 2026 · 05:18',
          state: 'warning',
        },
      ],
    },
    {
      id: 'health_currency_revolut',
      kind: 'currency-mismatch',
      title: 'Source currency conflicts with activity',
      summary: 'A Revolut cash withdrawal is tagged USD while the connected account reports EUR.',
      objectType: 'Cash activity',
      objectName: 'Revolut cash · Withdrawal · 18 Jul 2026',
      objectReference: 'ACT-CASH-260718-041',
      affectedField: 'activity.currency',
      source: 'Revolut',
      sourceDetail: 'Personal EUR · ••4031 · API transaction rv_92411',
      severity: 'medium',
      status: 'open',
      observedValue: 'USD 240.00',
      expectedValue: 'EUR 240.00',
      impact: 'Cash balance differs from the source by €34.61 after foreign-exchange conversion.',
      recommendation: 'Confirm the source account currency and correct the activity denomination.',
      destination: 'connections',
      requiresReview: true,
      updatedAt: 'Today · 05:18',
      lineage: [
        {
          label: 'Connection account',
          detail: 'Revolut account base currency reports EUR',
          at: '18 Jul 2026 · 12:02',
          state: 'external',
        },
        {
          label: 'Imported activity',
          detail: 'Transaction payload currency was interpreted as USD',
          at: '18 Jul 2026 · 12:03',
          state: 'warning',
        },
        {
          label: 'Reconciliation',
          detail: 'Calculated cash differs from source closing balance by €34.61',
          at: '27 Jul 2026 · 05:18',
          state: 'derived',
        },
      ],
    },
  ].map((issue) => ({
    ...issue,
    summary: issue.summary.replace('portfolio', portfolio.name),
  })) as HealthIssue[];
}

function seedPolicies(): CheckPolicy[] {
  return [
    {
      id: 'policy-cost-basis',
      label: 'Cost-basis completeness',
      description: 'Flag acquired units that do not have a documented cost, fees, and currency.',
      enabled: true,
      severity: 'critical',
      cadence: 'Every sync',
      threshold: 100,
      unit: '% required',
    },
    {
      id: 'policy-valuation-age',
      label: 'Private asset freshness',
      description: 'Flag property, private equity, and collectible values older than this limit.',
      enabled: true,
      severity: 'high',
      cadence: 'Daily',
      threshold: 90,
      unit: 'days',
    },
    {
      id: 'policy-duplicate-confidence',
      label: 'Duplicate activity confidence',
      description:
        'Compare identifiers, time, units, price, and source evidence before surfacing a pair.',
      enabled: true,
      severity: 'high',
      cadence: 'Every sync',
      threshold: 96,
      unit: '% match',
    },
    {
      id: 'policy-document-links',
      label: 'Evidence link coverage',
      description: 'Require imported statements and contracts to link to a portfolio object.',
      enabled: true,
      severity: 'medium',
      cadence: 'Daily',
      threshold: 1,
      unit: 'minimum link',
    },
    {
      id: 'policy-currency',
      label: 'Currency reconciliation',
      description:
        'Compare activity currency with account, instrument, and source settlement currency.',
      enabled: true,
      severity: 'medium',
      cadence: 'Every sync',
      threshold: 0.01,
      unit: 'EUR tolerance',
    },
    {
      id: 'policy-income-evidence',
      label: 'Income evidence coverage',
      description: 'Require a source record or document for dividends above the configured value.',
      enabled: false,
      severity: 'low',
      cadence: 'Weekly',
      threshold: 500,
      unit: 'EUR',
    },
  ];
}

function seedState(portfolio: OriginDataHealthPortfolio): PersistedHealthState {
  return {
    version: 1,
    scopeId: portfolio.id,
    issues: seedIssues(portfolio),
    policies: seedPolicies(),
    audit: [
      {
        id: 'audit-health-initial',
        at: '27 Jul 2026 · 05:18',
        actor: 'BetterTrack checks',
        action: 'Portfolio checks completed',
        detail: '5 exceptions found across 542 monitored fields and 4 connected sources.',
        object: portfolio.name,
        receipt: 'HLT-RUN-1047',
        tone: 'attention',
      },
      {
        id: 'audit-health-evidence',
        at: '26 Jul 2026 · 16:42',
        actor: 'You',
        action: 'Evidence requested',
        detail: 'Requested a current appraisal for Riverside property.',
        object: 'Riverside property',
        receipt: 'HLT-EVD-2048',
        tone: 'neutral',
      },
      {
        id: 'audit-health-policy',
        at: '19 Jul 2026 · 10:06',
        actor: 'You',
        action: 'Check policy changed',
        detail: 'Private asset freshness changed from 180 to 90 days.',
        object: portfolio.name,
        receipt: 'HLT-POL-0812',
        tone: 'neutral',
      },
    ],
    lastRunAt: '27 Jul 2026 · 05:18',
  };
}

function loadState(portfolio: OriginDataHealthPortfolio): PersistedHealthState {
  try {
    const raw = window.localStorage.getItem(storageKey(portfolio));
    if (!raw) return seedState(portfolio);
    const parsed = JSON.parse(raw) as PersistedHealthState;
    if (parsed.version !== 1 || parsed.scopeId !== portfolio.id) return seedState(portfolio);
    return parsed;
  } catch {
    return seedState(portfolio);
  }
}

function isAttention(status: IssueStatus) {
  return status === 'open' || status === 'evidence-requested' || status === 'pending-review';
}

function statusIcon(status: IssueStatus): IconName {
  if (status === 'resolved') return 'check';
  if (status === 'pending-review') return 'inbox';
  if (status === 'evidence-requested') return 'document';
  if (status === 'ignored') return 'eye-off';
  return 'activity';
}

function workflowTitle(kind: ActionKind) {
  if (kind === 'resolve') return 'Propose resolution';
  if (kind === 'ignore') return 'Ignore this finding';
  return 'Request portfolio evidence';
}

function workflowHelper(kind: ActionKind, requiresReview: boolean) {
  if (kind === 'resolve' && requiresReview) {
    return 'This correction changes portfolio truth. It will be staged in Review with its reason and field-level diff.';
  }
  if (kind === 'resolve') {
    return 'Record why the issue is resolved. A durable receipt will remain in this portfolio audit.';
  }
  if (kind === 'ignore') {
    return 'The check will remain visible as ignored. Future check runs can reopen it if source facts change.';
  }
  return 'Record what evidence is needed and from whom. The portfolio object stays flagged until evidence is linked.';
}

export function OriginDataHealth({
  portfolio,
  onClose,
  onOpenImport,
  onOpenFiles,
  onOpenTax,
  onOpenConnections,
  onOpenReview,
  onSubmitReview,
  onToast,
}: OriginDataHealthProps) {
  const [state, setState] = useState<PersistedHealthState>(() => loadState(portfolio));
  const [view, setView] = useState<HealthView>('issues');
  const [selectedId, setSelectedId] = useState<string>('health_basis_vwce_2024');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'attention' | IssueStatus | 'all'>('attention');
  const [severityFilter, setSeverityFilter] = useState<IssueSeverity | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [workflow, setWorkflow] = useState<PendingWorkflow>(null);
  const [workflowReason, setWorkflowReason] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const workspaceDialogRef = useAccessibleDialog<HTMLElement>({
    open: true,
    onClose,
    initialFocusSelector: '[aria-label="Close data health"]',
  });
  const workflowDialogRef = useAccessibleDialog<HTMLFormElement>({
    open: Boolean(workflow),
    onClose: () => setWorkflow(null),
    initialFocusSelector: 'textarea',
  });
  const loadedScopeRef = useRef(portfolio.id);

  useEffect(() => {
    loadedScopeRef.current = portfolio.id;
    setState(loadState(portfolio));
    setSelectedId('health_basis_vwce_2024');
    setWorkflow(null);
  }, [portfolio.id, portfolio.name]);

  useEffect(() => {
    if (state.scopeId !== loadedScopeRef.current) return;
    try {
      window.localStorage.setItem(storageKey(portfolio), JSON.stringify(state));
    } catch {
      // The demo remains fully usable when storage is unavailable.
    }
  }, [portfolio, state]);

  const sources = useMemo(
    () => Array.from(new Set(state.issues.map((issue) => issue.source))).sort(),
    [state.issues],
  );

  const filteredIssues = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return state.issues
      .filter((issue) => {
        if (statusFilter === 'attention' && !isAttention(issue.status)) return false;
        if (
          statusFilter !== 'all' &&
          statusFilter !== 'attention' &&
          issue.status !== statusFilter
        ) {
          return false;
        }
        if (severityFilter !== 'all' && issue.severity !== severityFilter) return false;
        if (sourceFilter !== 'all' && issue.source !== sourceFilter) return false;
        if (!normalized) return true;
        return [
          issue.title,
          issue.summary,
          issue.objectName,
          issue.objectReference,
          issue.affectedField,
          issue.source,
          issue.sourceDetail,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalized);
      })
      .sort((a, b) => {
        if (isAttention(a.status) !== isAttention(b.status)) return isAttention(a.status) ? -1 : 1;
        return severityRank[a.severity] - severityRank[b.severity];
      });
  }, [query, severityFilter, sourceFilter, state.issues, statusFilter]);

  useEffect(() => {
    if (!filteredIssues.some((issue) => issue.id === selectedId)) {
      setSelectedId(filteredIssues[0]?.id ?? '');
    }
  }, [filteredIssues, selectedId]);

  const selectedIssue = state.issues.find((issue) => issue.id === selectedId) ?? null;
  const attentionIssues = state.issues.filter((issue) => isAttention(issue.status));
  const reviewCount = state.issues.filter((issue) => issue.status === 'pending-review').length;
  const resolvedCount = state.issues.filter((issue) => issue.status === 'resolved').length;

  const metrics = useMemo(() => {
    const unresolvedKinds = new Set(attentionIssues.map((issue) => issue.kind));
    const completeness =
      98.7 -
      (unresolvedKinds.has('missing-cost-basis') ? 2.1 : 0) -
      (unresolvedKinds.has('unlinked-document') ? 0.7 : 0);
    const freshness = unresolvedKinds.has('stale-valuation') ? 94.2 : 99.1;
    const reconciliation =
      99.8 -
      (unresolvedKinds.has('duplicate-activity') ? 1.3 : 0) -
      (unresolvedKinds.has('currency-mismatch') ? 0.8 : 0);
    return {
      completeness: Math.max(completeness, 0).toFixed(1),
      freshness: freshness.toFixed(1),
      reconciliation: Math.max(reconciliation, 0).toFixed(1),
    };
  }, [attentionIssues]);

  function openDestination(destination: IssueDestination) {
    if (destination === 'import') onOpenImport();
    if (destination === 'files') onOpenFiles();
    if (destination === 'tax') onOpenTax();
    if (destination === 'connections') onOpenConnections();
    if (destination === 'review') onOpenReview();
  }

  function beginWorkflow(kind: ActionKind) {
    if (!selectedIssue) return;
    setWorkflow({ issueId: selectedIssue.id, kind });
    setWorkflowReason('');
  }

  function submitWorkflow(event: FormEvent) {
    event.preventDefault();
    if (!workflow || !workflowReason.trim()) return;
    const issue = state.issues.find((candidate) => candidate.id === workflow.issueId);
    if (!issue) return;

    const at = nowLabel();
    const receiptId = `HLT-${workflow.kind === 'resolve' ? 'RES' : workflow.kind === 'ignore' ? 'IGN' : 'EVD'}-${Math.floor(
      1000 + Math.random() * 8999,
    )}`;
    let nextStatus: IssueStatus;
    let receiptAction: ResolutionReceipt['action'];
    let auditAction: string;
    let toast: string;
    let reviewId: string | undefined;

    if (workflow.kind === 'resolve' && issue.requiresReview) {
      nextStatus = 'pending-review';
      receiptAction = 'review-submitted';
      auditAction = 'Correction submitted to Review';
      toast = 'Field correction staged in Review.';
      reviewId = makeId('health_review');
      const review: OriginReviewEntry = {
        id: reviewId,
        kind:
          issue.kind === 'missing-cost-basis' || issue.kind === 'currency-mismatch'
            ? 'tax'
            : 'sync',
        title: `Correct ${issue.affectedField}`,
        summary: `${issue.title}. ${workflowReason.trim()}`,
        portfolio: {
          id: portfolio.id,
          name: portfolio.name,
          path: `${portfolio.name} / Data health`,
        },
        source: {
          label: 'Portfolio data health',
          detail: `${issue.source} · ${issue.objectReference}`,
          actor: 'You',
        },
        requestedAt: new Date().toISOString(),
        requestedBy: 'You',
        status: 'pending',
        priority:
          issue.severity === 'critical' ? 'urgent' : issue.severity === 'high' ? 'high' : 'normal',
        risk: issue.severity === 'critical' || issue.severity === 'high' ? 'high' : 'medium',
        affectedCount: 1,
        tags: ['data-health', issue.kind, issue.objectType.toLowerCase()],
        approveLabel: 'Apply correction',
        rejectLabel: 'Keep current value',
        diff: [
          {
            label: issue.affectedField,
            before: issue.observedValue,
            after: issue.expectedValue,
            tone: 'warning',
            detail: workflowReason.trim(),
          },
        ],
        lineage: issue.lineage.map((step) => ({
          label: step.label,
          detail: step.detail,
          at: step.at,
          state: step.state,
        })),
        policies: [
          {
            title: 'Portfolio truth changes require review',
            description: 'The correction remains staged until an authorised reviewer approves it.',
            status: 'warning',
          },
          {
            title: 'Source lineage preserved',
            description: `The original ${issue.source} value and this reason remain in the audit history.`,
            status: 'pass',
          },
        ],
      };
      onSubmitReview(review);
    } else if (workflow.kind === 'resolve') {
      nextStatus = 'resolved';
      receiptAction = 'resolved';
      auditAction = 'Issue resolved';
      toast = 'Portfolio issue resolved with receipt.';
    } else if (workflow.kind === 'ignore') {
      nextStatus = 'ignored';
      receiptAction = 'ignored';
      auditAction = 'Finding ignored';
      toast = 'Finding ignored; its lineage remains available.';
    } else {
      nextStatus = 'evidence-requested';
      receiptAction = 'evidence-requested';
      auditAction = 'Evidence requested';
      toast = 'Evidence request recorded on the portfolio object.';
    }

    const receipt: ResolutionReceipt = {
      id: receiptId,
      action: receiptAction,
      at,
      actor: 'You',
      reason: workflowReason.trim(),
      ...(reviewId ? { reviewId } : {}),
    };
    const updatedIssue: HealthIssue = {
      ...issue,
      status: nextStatus,
      updatedAt: at,
      receipt,
      ...(nextStatus === 'pending-review' ? { destination: 'review' as const } : {}),
    };
    const auditEvent: HealthAuditEvent = {
      id: makeId('health_audit'),
      at,
      actor: 'You',
      action: auditAction,
      detail: workflowReason.trim(),
      object: issue.objectName,
      receipt: receiptId,
      tone: nextStatus === 'resolved' ? 'success' : 'neutral',
    };
    setState((current) => ({
      ...current,
      issues: current.issues.map((candidate) =>
        candidate.id === issue.id ? updatedIssue : candidate,
      ),
      audit: [auditEvent, ...current.audit],
    }));
    setWorkflow(null);
    setWorkflowReason('');
    onToast(toast);
  }

  function updatePolicy(id: string, patch: Partial<CheckPolicy>) {
    let changed: CheckPolicy | undefined;
    const receipt = `HLT-POL-${Math.floor(1000 + Math.random() * 8999)}`;
    setState((current) => {
      const policies = current.policies.map((policy) => {
        if (policy.id !== id) return policy;
        changed = { ...policy, ...patch };
        return changed;
      });
      if (!changed) return current;
      const event: HealthAuditEvent = {
        id: makeId('health_audit'),
        at: nowLabel(),
        actor: 'You',
        action: 'Check policy changed',
        detail: `${changed.label} · ${changed.enabled ? 'enabled' : 'disabled'} · ${changed.threshold} ${changed.unit} · ${changed.cadence}`,
        object: portfolio.name,
        receipt,
        tone: 'neutral',
      };
      return { ...current, policies, audit: [event, ...current.audit] };
    });
  }

  function rerunChecks() {
    if (isRunning) return;
    setIsRunning(true);
    setRunResult(null);
    window.setTimeout(() => {
      const receipt = `HLT-RUN-${Math.floor(1000 + Math.random() * 8999)}`;
      const at = nowLabel();
      const active = state.issues.filter((issue) => isAttention(issue.status)).length;
      const enabled = state.policies.filter((policy) => policy.enabled).length;
      const result = `${active} portfolio exceptions remain across ${enabled} enabled checks. No new source changes.`;
      setState((current) => ({
        ...current,
        lastRunAt: at,
        audit: [
          {
            id: makeId('health_audit'),
            at,
            actor: 'BetterTrack checks',
            action: 'Portfolio checks completed',
            detail: result,
            object: portfolio.name,
            receipt,
            tone: active > 0 ? 'attention' : 'success',
          },
          ...current.audit,
        ],
      }));
      setRunResult(result);
      setIsRunning(false);
      onToast('Portfolio checks finished.');
    }, 950);
  }

  const workflowIssue = workflow
    ? state.issues.find((candidate) => candidate.id === workflow.issueId)
    : null;

  return (
    <section
      aria-label={`${portfolio.name} data health`}
      aria-modal="true"
      className="origin-data-health"
      ref={workspaceDialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="odh-global-header">
        <div className="odh-brand" aria-label="BetterTrack">
          <span className="odh-brand__mark" aria-hidden="true" />
          <span>
            <strong>
              better<span>track</span>
            </strong>
            <small>Data health</small>
          </span>
        </div>
        <div className="odh-breadcrumb" aria-label="Current location">
          <span>Portfolios</span>
          <Icon name="chevron-right" size={12} />
          <strong>{portfolio.name}</strong>
          <Icon name="chevron-right" size={12} />
          <span>Data health</span>
        </div>
        <div className="odh-global-actions">
          <span className="odh-saved">
            <i />
            Saved locally
          </span>
          <button onClick={onClose} type="button" aria-label="Close data health">
            <Icon name="x" size={15} />
          </button>
        </div>
      </header>

      <main className="odh-page">
        <div className="odh-page-heading">
          <div>
            <span className="odh-kicker">Portfolio truth · field-level checks</span>
            <h1>Data health</h1>
            <p>
              Every finding below belongs to a holding, activity, valuation, document, or source in{' '}
              <strong>{portfolio.name}</strong>. Corrections keep their original value, reason, and
              review trail.
            </p>
          </div>
          <div className="odh-page-heading__actions">
            <span>
              Last checked <strong>{state.lastRunAt}</strong>
            </span>
            <button
              className="odh-button odh-button--primary"
              disabled={isRunning}
              onClick={rerunChecks}
              type="button"
            >
              <Icon className={isRunning ? 'is-spinning' : ''} name="refresh" size={13} />
              {isRunning ? 'Checking portfolio…' : 'Run checks'}
            </button>
          </div>
        </div>

        {runResult ? (
          <div className="odh-run-result" role="status">
            <Icon name="check" size={14} />
            <span>
              <strong>Check run complete</strong>
              {runResult}
            </span>
            <button onClick={() => setRunResult(null)} type="button" aria-label="Dismiss result">
              <Icon name="x" size={12} />
            </button>
          </div>
        ) : null}

        <div className="odh-metrics" aria-label="Portfolio data health metrics">
          <article>
            <span className="odh-metric-icon">
              <Icon name="database" size={15} />
            </span>
            <div>
              <span>Completeness</span>
              <strong>{metrics.completeness}%</strong>
              <small>527 of 542 required fields</small>
            </div>
            <i style={{ '--odh-value': `${metrics.completeness}%` } as React.CSSProperties} />
          </article>
          <article>
            <span className="odh-metric-icon">
              <Icon name="clock" size={15} />
            </span>
            <div>
              <span>Freshness</span>
              <strong>{metrics.freshness}%</strong>
              <small>1 private value outside policy</small>
            </div>
            <i style={{ '--odh-value': `${metrics.freshness}%` } as React.CSSProperties} />
          </article>
          <article>
            <span className="odh-metric-icon">
              <Icon name="repeat" size={15} />
            </span>
            <div>
              <span>Reconciliation</span>
              <strong>{metrics.reconciliation}%</strong>
              <small>€34.61 unexplained across sources</small>
            </div>
            <i style={{ '--odh-value': `${metrics.reconciliation}%` } as React.CSSProperties} />
          </article>
          <article className="odh-metric-attention">
            <span className="odh-metric-icon">
              <Icon name="activity" size={15} />
            </span>
            <div>
              <span>Needs attention</span>
              <strong>{attentionIssues.length}</strong>
              <small>
                {reviewCount} in review · {resolvedCount} resolved
              </small>
            </div>
          </article>
        </div>

        <nav className="odh-tabs" aria-label="Data health sections" role="tablist">
          <button
            aria-selected={view === 'issues'}
            className={view === 'issues' ? 'is-active' : ''}
            onClick={() => setView('issues')}
            role="tab"
            type="button"
          >
            Issues
            <span>{attentionIssues.length}</span>
          </button>
          <button
            aria-selected={view === 'policies'}
            className={view === 'policies' ? 'is-active' : ''}
            onClick={() => setView('policies')}
            role="tab"
            type="button"
          >
            Check policies
            <span>{state.policies.filter((policy) => policy.enabled).length}</span>
          </button>
          <button
            aria-selected={view === 'audit'}
            className={view === 'audit' ? 'is-active' : ''}
            onClick={() => setView('audit')}
            role="tab"
            type="button"
          >
            Audit history
            <span>{state.audit.length}</span>
          </button>
        </nav>

        {view === 'issues' ? (
          <section className="odh-issues-view" role="tabpanel">
            <div className="odh-toolbar">
              <label className="odh-search">
                <Icon name="search" size={14} />
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search portfolio objects, fields, sources…"
                  type="search"
                  value={query}
                />
              </label>
              <label>
                <span>Status</span>
                <select
                  onChange={(event) =>
                    setStatusFilter(event.target.value as 'attention' | IssueStatus | 'all')
                  }
                  value={statusFilter}
                >
                  <option value="attention">Needs attention</option>
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="evidence-requested">Evidence requested</option>
                  <option value="pending-review">In review</option>
                  <option value="resolved">Resolved</option>
                  <option value="ignored">Ignored</option>
                </select>
              </label>
              <label>
                <span>Severity</span>
                <select
                  onChange={(event) =>
                    setSeverityFilter(event.target.value as IssueSeverity | 'all')
                  }
                  value={severityFilter}
                >
                  <option value="all">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
              <label>
                <span>Source</span>
                <select
                  onChange={(event) => setSourceFilter(event.target.value)}
                  value={sourceFilter}
                >
                  <option value="all">All sources</option>
                  {sources.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="odh-issue-workspace">
              <aside className="odh-issue-list" aria-label="Portfolio issue queue">
                <div className="odh-issue-list__heading">
                  <span>
                    <strong>{filteredIssues.length}</strong> portfolio objects
                  </span>
                  <small>Ordered by risk</small>
                </div>
                {filteredIssues.length ? (
                  filteredIssues.map((issue) => (
                    <button
                      className={issue.id === selectedId ? 'is-selected' : ''}
                      key={issue.id}
                      onClick={() => setSelectedId(issue.id)}
                      type="button"
                    >
                      <span
                        aria-label={`${issue.severity} severity`}
                        className={`odh-severity-dot is-${issue.severity}`}
                      />
                      <span className="odh-issue-list__copy">
                        <span className="odh-issue-list__meta">
                          <em>{issue.objectType}</em>
                          <i className={`is-${issue.status}`}>
                            <Icon name={statusIcon(issue.status)} size={10} />
                            {statusLabels[issue.status]}
                          </i>
                        </span>
                        <strong>{issue.title}</strong>
                        <span>{issue.objectName}</span>
                        <small>
                          {issue.affectedField} · {issue.source}
                        </small>
                      </span>
                      <Icon name="chevron-right" size={13} />
                    </button>
                  ))
                ) : (
                  <div className="odh-empty">
                    <Icon name="search" size={18} />
                    <strong>No portfolio objects match</strong>
                    <span>Clear a filter or search a different field.</span>
                    <button
                      onClick={() => {
                        setQuery('');
                        setStatusFilter('all');
                        setSeverityFilter('all');
                        setSourceFilter('all');
                      }}
                      type="button"
                    >
                      Clear filters
                    </button>
                  </div>
                )}
              </aside>

              {selectedIssue ? (
                <article className="odh-issue-detail">
                  <div className="odh-detail-heading">
                    <div>
                      <span className="odh-object-label">{selectedIssue.objectType}</span>
                      <h2>{selectedIssue.title}</h2>
                      <p>{selectedIssue.summary}</p>
                    </div>
                    <div className="odh-detail-heading__badges">
                      <span className={`odh-severity is-${selectedIssue.severity}`}>
                        {selectedIssue.severity}
                      </span>
                      <span className={`odh-status is-${selectedIssue.status}`}>
                        <Icon name={statusIcon(selectedIssue.status)} size={11} />
                        {statusLabels[selectedIssue.status]}
                      </span>
                    </div>
                  </div>

                  <div className="odh-object-strip">
                    <span className="odh-object-strip__icon">
                      <Icon
                        name={
                          selectedIssue.objectType.includes('Document')
                            ? 'document'
                            : selectedIssue.objectType.includes('Cash')
                              ? 'cash'
                              : selectedIssue.objectType.includes('Valuation')
                                ? 'house'
                                : 'assets'
                        }
                        size={16}
                      />
                    </span>
                    <span>
                      <small>Portfolio object</small>
                      <strong>{selectedIssue.objectName}</strong>
                      <em>
                        {portfolio.name} · {selectedIssue.objectReference}
                      </em>
                    </span>
                    <button
                      onClick={() => openDestination(selectedIssue.destination)}
                      type="button"
                    >
                      Inspect object
                      <Icon name="arrow-right" size={12} />
                    </button>
                  </div>

                  <div className="odh-field-diff">
                    <div className="odh-field-diff__heading">
                      <span>
                        <Icon name="code" size={13} />
                        Affected field
                      </span>
                      <code>{selectedIssue.affectedField}</code>
                    </div>
                    <div>
                      <span>
                        <small>Observed</small>
                        <strong>{selectedIssue.observedValue}</strong>
                        <em>{selectedIssue.source}</em>
                      </span>
                      <Icon name="arrow-right" size={14} />
                      <span>
                        <small>Expected</small>
                        <strong>{selectedIssue.expectedValue}</strong>
                        <em>Portfolio policy</em>
                      </span>
                    </div>
                  </div>

                  <div className="odh-impact">
                    <span>
                      <Icon name="activity" size={14} />
                    </span>
                    <div>
                      <small>Why it matters</small>
                      <strong>{selectedIssue.impact}</strong>
                      <p>{selectedIssue.recommendation}</p>
                    </div>
                  </div>

                  <section className="odh-lineage">
                    <div className="odh-section-heading">
                      <span>
                        <strong>Field lineage</strong>
                        <small>How this value entered and affects {portfolio.name}</small>
                      </span>
                      <span className="odh-source-chip">
                        <Icon name="database" size={11} />
                        {selectedIssue.source}
                      </span>
                    </div>
                    <ol>
                      {selectedIssue.lineage.map((step) => (
                        <li className={`is-${step.state}`} key={`${step.label}-${step.at}`}>
                          <i>
                            <Icon
                              name={
                                step.state === 'verified'
                                  ? 'check'
                                  : step.state === 'warning'
                                    ? 'activity'
                                    : step.state === 'external'
                                      ? 'download'
                                      : 'repeat'
                              }
                              size={11}
                            />
                          </i>
                          <span>
                            <strong>{step.label}</strong>
                            <small>{step.detail}</small>
                          </span>
                          <time>{step.at}</time>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {selectedIssue.receipt ? (
                    <section className="odh-receipt">
                      <span className="odh-receipt__icon">
                        <Icon name="document" size={15} />
                      </span>
                      <span>
                        <small>Latest workflow receipt</small>
                        <strong>
                          {selectedIssue.receipt.id} ·{' '}
                          {selectedIssue.receipt.action.replaceAll('-', ' ')}
                        </strong>
                        <p>{selectedIssue.receipt.reason}</p>
                        <em>
                          {selectedIssue.receipt.actor} · {selectedIssue.receipt.at}
                        </em>
                      </span>
                      {selectedIssue.receipt.reviewId ? (
                        <button onClick={onOpenReview} type="button">
                          Open Review
                          <Icon name="arrow-right" size={11} />
                        </button>
                      ) : null}
                    </section>
                  ) : null}

                  <div className="odh-detail-actions">
                    <div>
                      <button
                        className="odh-button odh-button--primary"
                        disabled={
                          selectedIssue.status === 'resolved' ||
                          selectedIssue.status === 'pending-review'
                        }
                        onClick={() => beginWorkflow('resolve')}
                        type="button"
                      >
                        <Icon name="check" size={13} />
                        {selectedIssue.requiresReview
                          ? 'Propose correction'
                          : 'Resolve with receipt'}
                      </button>
                      <button
                        className="odh-button odh-button--secondary"
                        disabled={selectedIssue.status === 'resolved'}
                        onClick={() => beginWorkflow('evidence')}
                        type="button"
                      >
                        <Icon name="document" size={13} />
                        Request evidence
                      </button>
                      <button
                        className="odh-button odh-button--quiet"
                        disabled={
                          selectedIssue.status === 'resolved' || selectedIssue.status === 'ignored'
                        }
                        onClick={() => beginWorkflow('ignore')}
                        type="button"
                      >
                        Ignore
                      </button>
                    </div>
                    <button
                      className="odh-destination"
                      onClick={() => openDestination(selectedIssue.destination)}
                      type="button"
                    >
                      <span>
                        <Icon name={destinationMeta[selectedIssue.destination].icon} size={14} />
                      </span>
                      <span>
                        <strong>{destinationMeta[selectedIssue.destination].label}</strong>
                        <small>{destinationMeta[selectedIssue.destination].helper}</small>
                      </span>
                      <Icon name="arrow-right" size={13} />
                    </button>
                  </div>
                </article>
              ) : (
                <div className="odh-no-selection">
                  <Icon name="database" size={22} />
                  <strong>Select a portfolio object</strong>
                  <span>
                    Its field diff, source lineage, and contextual resolution will appear here.
                  </span>
                </div>
              )}
            </div>
          </section>
        ) : null}

        {view === 'policies' ? (
          <section className="odh-policies" role="tabpanel">
            <div className="odh-view-heading">
              <div>
                <span className="odh-kicker">Automated portfolio checks</span>
                <h2>Detection policies</h2>
                <p>
                  Policies inspect facts already inside <strong>{portfolio.name}</strong>. They do
                  not alter activities, holdings, or source data.
                </p>
              </div>
              <button
                className="odh-button odh-button--secondary"
                disabled={isRunning}
                onClick={rerunChecks}
                type="button"
              >
                <Icon className={isRunning ? 'is-spinning' : ''} name="refresh" size={13} />
                Test enabled policies
              </button>
            </div>
            <div className="odh-policy-table">
              <div className="odh-policy-table__head">
                <span>Check</span>
                <span>Risk</span>
                <span>Cadence</span>
                <span>Threshold</span>
                <span>State</span>
              </div>
              {state.policies.map((policy) => (
                <article className={!policy.enabled ? 'is-disabled' : ''} key={policy.id}>
                  <div>
                    <span className="odh-policy-icon">
                      <Icon
                        name={
                          policy.id.includes('basis')
                            ? 'cash'
                            : policy.id.includes('valuation')
                              ? 'clock'
                              : policy.id.includes('document')
                                ? 'document'
                                : policy.id.includes('currency')
                                  ? 'globe'
                                  : 'repeat'
                        }
                        size={14}
                      />
                    </span>
                    <span>
                      <strong>{policy.label}</strong>
                      <small>{policy.description}</small>
                    </span>
                  </div>
                  <label>
                    <span className="odh-mobile-label">Risk</span>
                    <select
                      aria-label={`${policy.label} severity`}
                      disabled={!policy.enabled}
                      onChange={(event) =>
                        updatePolicy(policy.id, {
                          severity: event.target.value as IssueSeverity,
                        })
                      }
                      value={policy.severity}
                    >
                      <option value="critical">Critical</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>
                  <label>
                    <span className="odh-mobile-label">Cadence</span>
                    <select
                      aria-label={`${policy.label} cadence`}
                      disabled={!policy.enabled}
                      onChange={(event) =>
                        updatePolicy(policy.id, {
                          cadence: event.target.value as CheckPolicy['cadence'],
                        })
                      }
                      value={policy.cadence}
                    >
                      <option value="Every sync">Every sync</option>
                      <option value="Daily">Daily</option>
                      <option value="Weekly">Weekly</option>
                    </select>
                  </label>
                  <label className="odh-threshold">
                    <span className="odh-mobile-label">Threshold</span>
                    <input
                      aria-label={`${policy.label} threshold`}
                      disabled={!policy.enabled}
                      min="0"
                      onChange={(event) =>
                        updatePolicy(policy.id, {
                          threshold: Number(event.target.value),
                        })
                      }
                      step={policy.threshold < 1 ? '0.01' : '1'}
                      type="number"
                      value={policy.threshold}
                    />
                    <small>{policy.unit}</small>
                  </label>
                  <label className="odh-toggle">
                    <input
                      checked={policy.enabled}
                      onChange={(event) =>
                        updatePolicy(policy.id, { enabled: event.target.checked })
                      }
                      type="checkbox"
                    />
                    <span />
                    <em>{policy.enabled ? 'Enabled' : 'Off'}</em>
                  </label>
                </article>
              ))}
            </div>
            <div className="odh-policy-note">
              <Icon name="shield" size={16} />
              <span>
                <strong>
                  Checks surface exceptions; they never silently rewrite portfolio truth.
                </strong>
                Any correction that changes values, activity identity, or tax basis is staged in
                Review with its field diff and source lineage.
              </span>
              <button onClick={onOpenReview} type="button">
                Open Review
                <Icon name="arrow-right" size={11} />
              </button>
            </div>
          </section>
        ) : null}

        {view === 'audit' ? (
          <section className="odh-audit" role="tabpanel">
            <div className="odh-view-heading">
              <div>
                <span className="odh-kicker">Persistent portfolio history</span>
                <h2>Data health audit</h2>
                <p>
                  Check runs, policy changes, requests, ignored findings, and resolutions for{' '}
                  <strong>{portfolio.name}</strong>.
                </p>
              </div>
              <span className="odh-audit-count">
                <strong>{state.audit.length}</strong>
                recorded events
              </span>
            </div>
            <div className="odh-audit-list">
              <div className="odh-audit-list__head">
                <span>Event</span>
                <span>Portfolio object</span>
                <span>Actor & time</span>
                <span>Receipt</span>
              </div>
              {state.audit.map((event) => (
                <article key={event.id}>
                  <span className={`odh-audit-dot is-${event.tone}`}>
                    <Icon
                      name={
                        event.tone === 'success'
                          ? 'check'
                          : event.tone === 'attention'
                            ? 'activity'
                            : 'document'
                      }
                      size={11}
                    />
                  </span>
                  <span>
                    <strong>{event.action}</strong>
                    <small>{event.detail}</small>
                  </span>
                  <span>
                    <em className="odh-mobile-label">Portfolio object</em>
                    <strong>{event.object}</strong>
                  </span>
                  <span>
                    <em className="odh-mobile-label">Actor & time</em>
                    <strong>{event.actor}</strong>
                    <small>{event.at}</small>
                  </span>
                  <code>{event.receipt}</code>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      {workflow && workflowIssue ? (
        <div className="odh-modal-layer" role="presentation">
          <form
            aria-labelledby="odh-workflow-title"
            aria-modal="true"
            className="odh-modal"
            onSubmit={submitWorkflow}
            ref={workflowDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="odh-modal__header">
              <span className="odh-modal__icon">
                <Icon
                  name={
                    workflow.kind === 'resolve'
                      ? 'check'
                      : workflow.kind === 'ignore'
                        ? 'eye-off'
                        : 'document'
                  }
                  size={17}
                />
              </span>
              <span>
                <small>{workflowIssue.objectType}</small>
                <h2 id="odh-workflow-title">{workflowTitle(workflow.kind)}</h2>
              </span>
              <button onClick={() => setWorkflow(null)} type="button" aria-label="Close workflow">
                <Icon name="x" size={14} />
              </button>
            </div>
            <div className="odh-modal__object">
              <span>
                <small>Portfolio object</small>
                <strong>{workflowIssue.objectName}</strong>
              </span>
              <code>{workflowIssue.affectedField}</code>
            </div>
            <p>{workflowHelper(workflow.kind, workflowIssue.requiresReview)}</p>
            <label className="odh-reason">
              <span>
                {workflow.kind === 'evidence'
                  ? 'Evidence request'
                  : workflow.kind === 'ignore'
                    ? 'Reason for ignoring'
                    : 'Resolution reason'}
              </span>
              <textarea
                autoFocus
                onChange={(event) => setWorkflowReason(event.target.value)}
                placeholder={
                  workflow.kind === 'evidence'
                    ? 'Describe the document or source confirmation needed, and who should provide it…'
                    : workflow.kind === 'ignore'
                      ? 'Explain why this finding is acceptable for this portfolio…'
                      : 'Explain the source evidence and why the proposed value is correct…'
                }
                rows={4}
                value={workflowReason}
              />
              <small>
                This reason is stored in the portfolio audit and cannot be silently removed.
              </small>
            </label>
            {workflow.kind === 'resolve' && workflowIssue.requiresReview ? (
              <div className="odh-review-preview">
                <span>
                  <Icon name="inbox" size={14} />
                </span>
                <span>
                  <strong>Review proposal required</strong>
                  <small>
                    {workflowIssue.observedValue} → {workflowIssue.expectedValue}
                  </small>
                </span>
                <em>Portfolio truth change</em>
              </div>
            ) : null}
            <div className="odh-modal__actions">
              <button
                className="odh-button odh-button--quiet"
                onClick={() => setWorkflow(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="odh-button odh-button--primary"
                disabled={!workflowReason.trim()}
                type="submit"
              >
                {workflow.kind === 'resolve' && workflowIssue.requiresReview
                  ? 'Submit to Review'
                  : workflow.kind === 'resolve'
                    ? 'Resolve & issue receipt'
                    : workflow.kind === 'ignore'
                      ? 'Ignore with receipt'
                      : 'Record evidence request'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
