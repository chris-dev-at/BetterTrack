import { useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-automation.css';

export type OriginAutomationView = 'active' | 'builder' | 'runs';

export type OriginAutomationTrigger =
  | {
      type: 'schedule';
      cadence: 'monthly' | 'weekly' | 'quarterly';
      day: number;
      time: string;
      timezone: string;
    }
  | {
      type: 'drive-file';
      connection: string;
      folder: string;
      fileTypes: string[];
    }
  | {
      type: 'allocation-drift';
      thresholdPercent: number;
      evaluationCadence: 'daily' | 'weekly';
    }
  | {
      type: 'missing-basis';
      evaluationCadence: 'after-import' | 'daily';
      minimumPositionValue: number;
    }
  | {
      type: 'report-schedule';
      cadence: 'monthly' | 'quarterly';
      day: number;
      time: string;
      timezone: string;
    };

export interface OriginAutomationCondition {
  id: string;
  field: string;
  operator: 'greater-than' | 'less-than' | 'equals' | 'not-seen' | 'changed-by';
  value: string | number | boolean;
  description: string;
}

export type OriginAutomationAction =
  | {
      type: 'propose-purchase';
      asset: string;
      amount: number;
      fundingSource: string;
    }
  | {
      type: 'import-activities';
      destination: string;
      duplicatePolicy: 'skip-exact' | 'review-all';
    }
  | {
      type: 'propose-rebalance';
      model: string;
      tolerancePercent: number;
    }
  | {
      type: 'research-cost-basis';
      method: 'source-documents' | 'historical-close';
    }
  | {
      type: 'create-report';
      report: string;
      delivery: 'portfolio-inbox' | 'email';
    };

export type OriginAutomationReviewPolicy =
  | 'approve-every-run'
  | 'auto-within-guardrails'
  | 'exceptions-only';

export interface OriginAutomationDryRun {
  periodFrom: string;
  periodTo: string;
  evaluated: number;
  wouldRun: number;
  wouldSkip: number;
  wouldRequestReview: number;
  estimatedCashImpact: number;
  notes: string[];
}

export interface OriginAutomationProposal {
  id: string;
  portfolio: string;
  name: string;
  status: 'pending-review';
  createdAt: string;
  plainEnglishRule: string;
  trigger: OriginAutomationTrigger;
  conditions: OriginAutomationCondition[];
  proposedAction: OriginAutomationAction;
  reviewPolicy: OriginAutomationReviewPolicy;
  permissions: string[];
  nextEvaluation: string;
  dryRun: OriginAutomationDryRun;
}

export interface OriginAutomationRunReceipt {
  id: string;
  automationId: string;
  automationName: string;
  portfolio: string;
  status: 'completed' | 'blocked' | 'skipped';
  startedAt: string;
  completedAt: string;
  idempotencyKey: string;
  trigger: string;
  decision: string;
  cashBefore: number;
  cashAfter: number;
  amount: number;
  operations: number;
  checks: Array<{
    label: string;
    status: 'passed' | 'blocked' | 'not-applicable';
    detail: string;
  }>;
}

export interface OriginAutomationActivity {
  id: string;
  portfolio: string;
  type: 'proposal.created' | 'automation.paused' | 'automation.resumed' | 'automation.run';
  at: string;
  summary: string;
  proposalId?: string;
  receiptId?: string;
}

export interface OriginAutomationProps {
  portfolio: string;
  availableCash: number;
  onSubmitProposal: (result: OriginAutomationProposal) => void;
  onRecordActivity?: (activity: OriginAutomationActivity) => void;
  onToast?: (message: string) => void;
}

type AutomationStatus = 'active' | 'paused' | 'attention';
type BuilderPreset = 'dca' | 'drive' | 'drift' | 'basis' | 'report';
type TriggerKind = OriginAutomationTrigger['type'];
type ActionKind = OriginAutomationAction['type'];
type RunFilter = 'all' | OriginAutomationRunReceipt['status'];

type ExistingAutomation = {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  category: string;
  status: AutomationStatus;
  rule: {
    when: string;
    condition: string;
    then: string;
  };
  nextRun: string;
  lastRun: string;
  review: string;
  permissions: string[];
  successRate: number;
  runCount: number;
  debitAmount: number;
  affectedData: string[];
};

const existingSeed: ExistingAutomation[] = [
  {
    id: 'auto_dca_world',
    name: 'Monthly World ETF contribution',
    description: 'Disciplined savings plan with a cash floor and explicit trade approval.',
    icon: 'repeat',
    category: 'Invest',
    status: 'active',
    rule: {
      when: 'On the 2nd of every month at 09:00',
      condition: 'Available cash remains above €1,000 after the purchase',
      then: 'Prepare a €200 MSCI World purchase proposal',
    },
    nextRun: '02 Aug 2026 · 09:00',
    lastRun: '02 Jul · completed',
    review: 'Approval before every purchase',
    permissions: ['Read portfolio cash', 'Read asset identity', 'Create proposed transaction'],
    successRate: 100,
    runCount: 18,
    debitAmount: 200,
    affectedData: ['EUR cash', 'iShares Core MSCI World', 'Activity ledger'],
  },
  {
    id: 'auto_drive_import',
    name: 'Statement inbox',
    description: 'Normalize and reconcile new broker statements from a private Drive folder.',
    icon: 'folder',
    category: 'Import',
    status: 'active',
    rule: {
      when: 'A new statement appears in Finance vault',
      condition: 'The file is new; exact duplicates are skipped',
      then: 'Dry-run the import and surface conflicts for review',
    },
    nextRun: 'Watching continuously',
    lastRun: '26 Jul · 39 imported',
    review: 'Only conflicts need approval',
    permissions: ['Read connected Drive folder', 'Read portfolio ledger', 'Create import proposal'],
    successRate: 98.7,
    runCount: 32,
    debitAmount: 0,
    affectedData: ['Finance vault', 'Activity ledger', 'Asset aliases'],
  },
  {
    id: 'auto_drift',
    name: 'Allocation drift review',
    description: 'Watch the strategic model without silently moving money.',
    icon: 'pie',
    category: 'Monitor',
    status: 'paused',
    rule: {
      when: 'Every Monday morning',
      condition: 'Any Core 70/20/10 sleeve drifts by more than 4%',
      then: 'Prepare a rebalance proposal in Workbench',
    },
    nextRun: 'Paused',
    lastRun: '21 Jul · no action',
    review: 'Approval before any ledger change',
    permissions: ['Read holdings', 'Read target model', 'Create Workbench proposal'],
    successRate: 100,
    runCount: 26,
    debitAmount: 0,
    affectedData: ['Holdings', 'Core 70/20/10 model', 'Workbench'],
  },
  {
    id: 'auto_basis',
    name: 'Missing cost-basis investigator',
    description: 'Search connected evidence and prepare a traceable basis recommendation.',
    icon: 'search',
    category: 'Data quality',
    status: 'attention',
    rule: {
      when: 'A portfolio import completes',
      condition: 'One or more positions are missing cost basis',
      then: 'Search connected evidence and prepare documented fixes',
    },
    nextRun: 'Waiting for approval',
    lastRun: '26 Jul · 1 finding',
    review: 'Approval for every proposed basis',
    permissions: ['Read portfolio lots', 'Read linked statements', 'Create basis proposal'],
    successRate: 94.2,
    runCount: 12,
    debitAmount: 0,
    affectedData: ['Tax lots', 'Source documents', 'Audit trail'],
  },
  {
    id: 'auto_report',
    name: 'Monthly owner report',
    description: 'Create a consistent private snapshot for the portfolio inbox.',
    icon: 'document',
    category: 'Report',
    status: 'active',
    rule: {
      when: 'On the final calendar day of each month',
      condition: 'The reporting period has closed',
      then: 'Create the private performance, cash-flow, risk, and decisions report',
    },
    nextRun: '31 Jul 2026 · 18:00',
    lastRun: '30 Jun · delivered',
    review: 'Auto-deliver to private inbox',
    permissions: ['Read portfolio analytics', 'Read decision history', 'Create private report'],
    successRate: 100,
    runCount: 11,
    debitAmount: 0,
    affectedData: ['Performance', 'Cash flow', 'Risk', 'Portfolio inbox'],
  },
];

const initialReceipts: OriginAutomationRunReceipt[] = [
  {
    id: 'run_7f2901',
    automationId: 'auto_drive_import',
    automationName: 'Statement inbox',
    portfolio: 'Personal wealth',
    status: 'completed',
    startedAt: '2026-07-26T22:14:07.000Z',
    completedAt: '2026-07-26T22:14:11.000Z',
    idempotencyKey: 'drive_1zba4_statement_2026-07-26',
    trigger: 'New Drive file · TR_activity_July.csv',
    decision: '39 new activities created; 4 exact duplicates skipped.',
    cashBefore: 6284.19,
    cashAfter: 6284.19,
    amount: 0,
    operations: 43,
    checks: [
      { label: 'Connection access', status: 'passed', detail: 'Finance vault remains authorized.' },
      {
        label: 'File integrity',
        status: 'passed',
        detail: 'SHA-256 differs from all prior imports.',
      },
      {
        label: 'Duplicate guard',
        status: 'passed',
        detail: '4 activity fingerprints already existed.',
      },
      {
        label: 'Cash guard',
        status: 'not-applicable',
        detail: 'Import does not initiate spending.',
      },
    ],
  },
  {
    id: 'run_7f281c',
    automationId: 'auto_dca_world',
    automationName: 'Monthly World ETF contribution',
    portfolio: 'Personal wealth',
    status: 'completed',
    startedAt: '2026-07-02T07:00:02.000Z',
    completedAt: '2026-07-02T07:01:24.000Z',
    idempotencyKey: 'dca_world_2026-07',
    trigger: 'Monthly schedule · 02 Jul 2026 at 09:00',
    decision: 'Approved proposal recorded as a €200 simulated purchase.',
    cashBefore: 6484.19,
    cashAfter: 6284.19,
    amount: 200,
    operations: 2,
    checks: [
      { label: 'Approval', status: 'passed', detail: 'Approved by portfolio owner at 09:01.' },
      {
        label: 'Available cash',
        status: 'passed',
        detail: 'Cash remained above the €1,000 floor.',
      },
      { label: 'Duplicate guard', status: 'passed', detail: 'No receipt exists for July 2026.' },
      { label: 'Asset identity', status: 'passed', detail: 'ISIN IE00B4L5Y983 resolved.' },
    ],
  },
  {
    id: 'run_7f271a',
    automationId: 'auto_drift',
    automationName: 'Allocation drift review',
    portfolio: 'Personal wealth',
    status: 'skipped',
    startedAt: '2026-07-21T06:00:01.000Z',
    completedAt: '2026-07-21T06:00:03.000Z',
    idempotencyKey: 'drift_core_2026-W30',
    trigger: 'Weekly evaluation · Monday at 08:00',
    decision: 'Largest sleeve drift was 2.7%; threshold is 4.0%.',
    cashBefore: 6284.19,
    cashAfter: 6284.19,
    amount: 0,
    operations: 0,
    checks: [
      { label: 'Target model', status: 'passed', detail: 'Core 70/20/10 is current.' },
      { label: 'Threshold', status: 'blocked', detail: 'No sleeve exceeded 4.0% drift.' },
      { label: 'Approval', status: 'not-applicable', detail: 'No action was proposed.' },
    ],
  },
  {
    id: 'run_7f264b',
    automationId: 'auto_basis',
    automationName: 'Missing cost-basis investigator',
    portfolio: 'Personal wealth',
    status: 'blocked',
    startedAt: '2026-07-20T15:42:11.000Z',
    completedAt: '2026-07-20T15:42:14.000Z',
    idempotencyKey: 'basis_msft_lot_2020-11',
    trigger: 'Import completed · missing basis detected',
    decision: 'A historical-close estimate was found, but source evidence is required by policy.',
    cashBefore: 6284.19,
    cashAfter: 6284.19,
    amount: 0,
    operations: 0,
    checks: [
      { label: 'Position identity', status: 'passed', detail: 'Microsoft lot resolved.' },
      {
        label: 'Source evidence',
        status: 'blocked',
        detail: 'No trade confirmation is connected.',
      },
      { label: 'Write permission', status: 'not-applicable', detail: 'No basis was changed.' },
    ],
  },
];

const presetMeta: ReadonlyArray<{
  id: BuilderPreset;
  icon: IconName;
  title: string;
  description: string;
}> = [
  {
    id: 'dca',
    icon: 'repeat',
    title: 'Monthly DCA',
    description: 'Propose a guarded contribution',
  },
  { id: 'drive', icon: 'folder', title: 'Drive import', description: 'Reconcile new statements' },
  { id: 'drift', icon: 'pie', title: 'Allocation drift', description: 'Watch a target model' },
  { id: 'basis', icon: 'search', title: 'Missing basis', description: 'Research incomplete lots' },
  {
    id: 'report',
    icon: 'document',
    title: 'Scheduled report',
    description: 'Create a private snapshot',
  },
];

const triggerLabels: Record<TriggerKind, string> = {
  schedule: 'Calendar schedule',
  'drive-file': 'New Drive file',
  'allocation-drift': 'Allocation drift',
  'missing-basis': 'Missing cost basis',
  'report-schedule': 'Report schedule',
};

const actionLabels: Record<ActionKind, string> = {
  'propose-purchase': 'Propose a purchase',
  'import-activities': 'Prepare an import',
  'propose-rebalance': 'Propose a rebalance',
  'research-cost-basis': 'Research cost basis',
  'create-report': 'Create a report',
};

const euro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

function activityNow(
  portfolio: string,
  type: OriginAutomationActivity['type'],
  summary: string,
  related: Pick<OriginAutomationActivity, 'proposalId' | 'receiptId'> = {},
): OriginAutomationActivity {
  return {
    id: `act_${Math.random().toString(36).slice(2, 10)}`,
    portfolio,
    type,
    at: new Date().toISOString(),
    summary,
    ...related,
  };
}

function runStatusLabel(status: OriginAutomationRunReceipt['status']) {
  if (status === 'completed') return 'Completed';
  if (status === 'blocked') return 'Blocked safely';
  return 'Skipped';
}

function reviewPolicyLabel(policy: OriginAutomationReviewPolicy) {
  if (policy === 'approve-every-run') return 'Approve every proposed action';
  if (policy === 'auto-within-guardrails') return 'Run automatically inside guardrails';
  return 'Only exceptions need review';
}

export function OriginAutomation({
  portfolio,
  availableCash,
  onSubmitProposal,
  onRecordActivity,
  onToast,
}: OriginAutomationProps) {
  const [view, setView] = useState<OriginAutomationView>('active');
  const [automations, setAutomations] = useState<ExistingAutomation[]>(existingSeed);
  const [selectedAutomationId, setSelectedAutomationId] = useState(existingSeed[0]!.id);
  const [receipts, setReceipts] = useState<OriginAutomationRunReceipt[]>(
    initialReceipts.map((receipt) => ({ ...receipt, portfolio })),
  );
  const [selectedReceiptId, setSelectedReceiptId] = useState(initialReceipts[0]!.id);
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [automationFilter, setAutomationFilter] = useState<'all' | AutomationStatus>('all');
  const [ruleCopied, setRuleCopied] = useState(false);
  const [cashBalance, setCashBalance] = useState(Math.max(0, availableCash));
  const [pendingProposals, setPendingProposals] = useState<OriginAutomationProposal[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);

  const [preset, setPreset] = useState<BuilderPreset>('dca');
  const [ruleName, setRuleName] = useState('Monthly World ETF contribution');
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('schedule');
  const [triggerDay, setTriggerDay] = useState(2);
  const [triggerTime, setTriggerTime] = useState('09:00');
  const [driftThreshold, setDriftThreshold] = useState(4);
  const [driveFolder, setDriveFolder] = useState('/Finance vault/Broker statements');
  const [actionKind, setActionKind] = useState<ActionKind>('propose-purchase');
  const [amount, setAmount] = useState(200);
  const [asset, setAsset] = useState('iShares Core MSCI World · IE00B4L5Y983');
  const [cashGuardEnabled, setCashGuardEnabled] = useState(true);
  const [cashFloor, setCashFloor] = useState(1000);
  const [dedupeEnabled, setDedupeEnabled] = useState(true);
  const [onlyOnChange, setOnlyOnChange] = useState(true);
  const [reviewPolicy, setReviewPolicy] =
    useState<OriginAutomationReviewPolicy>('approve-every-run');
  const [submittedProposalId, setSubmittedProposalId] = useState<string | null>(null);

  const selectedAutomation =
    automations.find((automation) => automation.id === selectedAutomationId) ?? automations[0]!;
  const selectedReceipt =
    receipts.find((receipt) => receipt.id === selectedReceiptId) ?? receipts[0]!;
  const filteredReceipts =
    runFilter === 'all' ? receipts : receipts.filter((receipt) => receipt.status === runFilter);
  const visibleAutomations =
    automationFilter === 'all'
      ? automations
      : automations.filter((automation) => automation.status === automationFilter);

  const plainEnglishRule = useMemo(() => {
    if (triggerKind === 'drive-file') {
      return `When a new PDF or CSV appears in ${driveFolder}, prepare an import into ${portfolio}, skip exact duplicates, and ${reviewPolicy === 'exceptions-only' ? 'ask only when reconciliation finds a conflict' : 'request approval before writing'}.`;
    }
    if (triggerKind === 'allocation-drift') {
      return `Every Monday, compare ${portfolio} with Core 70/20/10. If any sleeve drifts by more than ${driftThreshold.toFixed(1)}%, prepare a rebalance proposal and wait for owner approval.`;
    }
    if (triggerKind === 'missing-basis') {
      return `After an import, find positions in ${portfolio} without cost basis, search connected source documents, and propose evidence-backed fixes without changing tax lots automatically.`;
    }
    if (triggerKind === 'report-schedule') {
      return `On day ${triggerDay} of each month at ${triggerTime}, create a private performance, cash-flow, risk, and decisions report for ${portfolio}.`;
    }
    return `On day ${triggerDay} of each month at ${triggerTime}, propose investing ${euro.format(amount)} into ${asset}. Continue only if cash remains above ${euro.format(cashFloor)}, and require approval before recording the purchase.`;
  }, [
    amount,
    asset,
    cashFloor,
    driveFolder,
    driftThreshold,
    portfolio,
    reviewPolicy,
    triggerDay,
    triggerKind,
    triggerTime,
  ]);

  const dryRun = useMemo<OriginAutomationDryRun>(() => {
    if (preset === 'drive') {
      return {
        periodFrom: '2026-01-01',
        periodTo: '2026-07-27',
        evaluated: 14,
        wouldRun: 12,
        wouldSkip: 2,
        wouldRequestReview: 1,
        estimatedCashImpact: 0,
        notes: [
          'Two duplicate files would be skipped',
          'One €25 cash conflict would require review',
        ],
      };
    }
    if (preset === 'drift') {
      return {
        periodFrom: '2026-01-01',
        periodTo: '2026-07-27',
        evaluated: 30,
        wouldRun: 2,
        wouldSkip: 28,
        wouldRequestReview: 2,
        estimatedCashImpact: 0,
        notes: [
          'Threshold crossed in March and June',
          'No proposed trade would execute automatically',
        ],
      };
    }
    if (preset === 'basis') {
      return {
        periodFrom: '2026-01-01',
        periodTo: '2026-07-27',
        evaluated: 8,
        wouldRun: 3,
        wouldSkip: 5,
        wouldRequestReview: 3,
        estimatedCashImpact: 0,
        notes: ['Two lots have connected source evidence', 'One estimate remains lower confidence'],
      };
    }
    if (preset === 'report') {
      return {
        periodFrom: '2026-01-01',
        periodTo: '2026-07-27',
        evaluated: 7,
        wouldRun: 7,
        wouldSkip: 0,
        wouldRequestReview: 0,
        estimatedCashImpact: 0,
        notes: [
          'All seven reports render with complete period data',
          'Delivery stays inside portfolio',
        ],
      };
    }
    const wouldRun =
      cashFloor + amount <= cashBalance ? 7 : Math.max(0, Math.floor(cashBalance / amount) - 1);
    return {
      periodFrom: '2026-01-01',
      periodTo: '2026-07-27',
      evaluated: 7,
      wouldRun,
      wouldSkip: 7 - wouldRun,
      wouldRequestReview: wouldRun,
      estimatedCashImpact: wouldRun * amount,
      notes: [
        `${wouldRun} purchase proposals would pass the cash floor`,
        'Every simulated purchase still requires owner approval',
      ],
    };
  }, [amount, cashBalance, cashFloor, preset]);

  const nextEvaluation = useMemo(() => {
    if (triggerKind === 'drive-file') return 'Immediately after the next matching file';
    if (triggerKind === 'allocation-drift') return 'Monday, 03 Aug 2026 · 08:00';
    if (triggerKind === 'missing-basis') return 'After the next import receipt';
    if (triggerKind === 'report-schedule') return `31 Jul 2026 · ${triggerTime}`;
    return `02 Aug 2026 · ${triggerTime}`;
  }, [triggerKind, triggerTime]);

  const notify = (message: string) => onToast?.(message);

  const cycleAutomationFilter = () => {
    const filters: Array<'all' | AutomationStatus> = ['all', 'active', 'attention', 'paused'];
    const currentIndex = filters.indexOf(automationFilter);
    const next = filters[(currentIndex + 1) % filters.length] ?? 'all';
    setAutomationFilter(next);
    const firstMatch = automations.find(
      (automation) => next === 'all' || automation.status === next,
    );
    if (firstMatch) setSelectedAutomationId(firstMatch.id);
  };

  const copyPlainEnglishRule = async () => {
    try {
      await navigator.clipboard.writeText(plainEnglishRule);
    } catch {
      // Clipboard permission is browser-controlled; the visible completion state still
      // keeps this frontend-only preview deterministic.
    }
    setRuleCopied(true);
    window.setTimeout(() => setRuleCopied(false), 1800);
    notify('Plain-English rule copied.');
  };

  const downloadRunReceipt = () => {
    const payload = JSON.stringify(
      {
        product: 'BetterTrack Origin demo',
        receipt: selectedReceipt,
        exportedAt: new Date().toISOString(),
        note: 'Fictional browser-local automation receipt.',
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${selectedReceipt.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify('Automation receipt downloaded.');
  };

  const applyPreset = (next: BuilderPreset) => {
    setPreset(next);
    setSubmittedProposalId(null);
    if (next === 'dca') {
      setRuleName('Monthly World ETF contribution');
      setTriggerKind('schedule');
      setTriggerDay(2);
      setTriggerTime('09:00');
      setActionKind('propose-purchase');
      setAmount(200);
      setAsset('iShares Core MSCI World · IE00B4L5Y983');
      setCashGuardEnabled(true);
      setCashFloor(1000);
      setDedupeEnabled(true);
      setOnlyOnChange(true);
      setReviewPolicy('approve-every-run');
    } else if (next === 'drive') {
      setRuleName('Statement inbox');
      setTriggerKind('drive-file');
      setActionKind('import-activities');
      setCashGuardEnabled(false);
      setDedupeEnabled(true);
      setOnlyOnChange(true);
      setReviewPolicy('exceptions-only');
    } else if (next === 'drift') {
      setRuleName('Allocation drift review');
      setTriggerKind('allocation-drift');
      setActionKind('propose-rebalance');
      setDriftThreshold(4);
      setCashGuardEnabled(false);
      setDedupeEnabled(true);
      setOnlyOnChange(true);
      setReviewPolicy('approve-every-run');
    } else if (next === 'basis') {
      setRuleName('Missing cost-basis investigator');
      setTriggerKind('missing-basis');
      setActionKind('research-cost-basis');
      setCashGuardEnabled(false);
      setDedupeEnabled(true);
      setOnlyOnChange(true);
      setReviewPolicy('approve-every-run');
    } else {
      setRuleName('Monthly owner report');
      setTriggerKind('report-schedule');
      setTriggerDay(31);
      setTriggerTime('18:00');
      setActionKind('create-report');
      setCashGuardEnabled(false);
      setDedupeEnabled(true);
      setOnlyOnChange(true);
      setReviewPolicy('auto-within-guardrails');
    }
  };

  const buildTrigger = (): OriginAutomationTrigger => {
    if (triggerKind === 'drive-file') {
      return {
        type: 'drive-file',
        connection: 'Google Drive · Finance vault',
        folder: driveFolder,
        fileTypes: ['pdf', 'csv'],
      };
    }
    if (triggerKind === 'allocation-drift') {
      return {
        type: 'allocation-drift',
        thresholdPercent: driftThreshold,
        evaluationCadence: 'weekly',
      };
    }
    if (triggerKind === 'missing-basis') {
      return {
        type: 'missing-basis',
        evaluationCadence: 'after-import',
        minimumPositionValue: 100,
      };
    }
    if (triggerKind === 'report-schedule') {
      return {
        type: 'report-schedule',
        cadence: 'monthly',
        day: triggerDay,
        time: triggerTime,
        timezone: 'Europe/Vienna',
      };
    }
    return {
      type: 'schedule',
      cadence: 'monthly',
      day: triggerDay,
      time: triggerTime,
      timezone: 'Europe/Vienna',
    };
  };

  const buildAction = (): OriginAutomationAction => {
    if (actionKind === 'import-activities') {
      return {
        type: 'import-activities',
        destination: portfolio,
        duplicatePolicy: 'skip-exact',
      };
    }
    if (actionKind === 'propose-rebalance') {
      return {
        type: 'propose-rebalance',
        model: 'Core 70/20/10',
        tolerancePercent: driftThreshold,
      };
    }
    if (actionKind === 'research-cost-basis') {
      return { type: 'research-cost-basis', method: 'source-documents' };
    }
    if (actionKind === 'create-report') {
      return {
        type: 'create-report',
        report: 'Owner monthly review',
        delivery: 'portfolio-inbox',
      };
    }
    return {
      type: 'propose-purchase',
      asset,
      amount,
      fundingSource: 'Portfolio EUR cash',
    };
  };

  const submitProposal = () => {
    const now = new Date();
    const proposal: OriginAutomationProposal = {
      id: `proposal_${now.getTime().toString(36)}`,
      portfolio,
      name: ruleName.trim() || 'Untitled automation',
      status: 'pending-review',
      createdAt: now.toISOString(),
      plainEnglishRule,
      trigger: buildTrigger(),
      conditions: [
        ...(cashGuardEnabled
          ? [
              {
                id: 'cash-floor',
                field: 'available_cash_after_action',
                operator: 'greater-than' as const,
                value: cashFloor,
                description: `Available cash must remain above ${euro.format(cashFloor)}.`,
              },
            ]
          : []),
        ...(dedupeEnabled
          ? [
              {
                id: 'idempotency',
                field: 'idempotency_key',
                operator: 'not-seen' as const,
                value: true,
                description: 'The same source event must not have a completed receipt.',
              },
            ]
          : []),
        ...(onlyOnChange
          ? [
              {
                id: 'material-change',
                field: 'portfolio_state',
                operator: 'changed-by' as const,
                value: triggerKind === 'allocation-drift' ? driftThreshold : 0,
                description: 'Do nothing when the evaluated state has not materially changed.',
              },
            ]
          : []),
      ],
      proposedAction: buildAction(),
      reviewPolicy,
      permissions: [
        'Read selected portfolio data',
        'Evaluate this rule in the automation sandbox',
        reviewPolicy === 'auto-within-guardrails'
          ? 'Write only inside approved guardrails'
          : 'Create a review proposal; no direct write',
        'Never access broker trading or withdrawal controls',
      ],
      nextEvaluation,
      dryRun,
    };
    setPendingProposals((current) => [proposal, ...current]);
    setSubmittedProposalId(proposal.id);
    onSubmitProposal(proposal);
    onRecordActivity?.(
      activityNow(
        portfolio,
        'proposal.created',
        `${proposal.name} was submitted for review and remains inactive.`,
        { proposalId: proposal.id },
      ),
    );
    notify('Automation proposal created — review is required before activation.');
  };

  const toggleAutomation = (automationId: string) => {
    const target = automations.find((automation) => automation.id === automationId);
    if (!target) return;
    const nextStatus: AutomationStatus = target.status === 'active' ? 'paused' : 'active';
    setAutomations((current) =>
      current.map((automation) =>
        automation.id === automationId
          ? {
              ...automation,
              status: nextStatus,
              nextRun:
                nextStatus === 'paused'
                  ? 'Paused'
                  : automation.id === 'auto_drive_import'
                    ? 'Watching continuously'
                    : 'Next evaluation scheduled',
            }
          : automation,
      ),
    );
    onRecordActivity?.(
      activityNow(
        portfolio,
        nextStatus === 'paused' ? 'automation.paused' : 'automation.resumed',
        `${target.name} was ${nextStatus === 'paused' ? 'paused' : 'resumed'}.`,
      ),
    );
    notify(`${target.name} ${nextStatus === 'paused' ? 'paused' : 'resumed'}.`);
  };

  const simulateRun = (automation: ExistingAutomation) => {
    const idempotencyKey = `${automation.id}:manual-demo:2026-07-27`;
    const existing = receipts.find((receipt) => receipt.idempotencyKey === idempotencyKey);
    if (existing) {
      setSelectedReceiptId(existing.id);
      setView('runs');
      notify('No duplicate run created — the existing idempotent receipt was reopened.');
      return;
    }
    setRunningId(automation.id);
    window.setTimeout(() => {
      const started = new Date();
      const cashGuardPass = automation.debitAmount <= cashBalance - 1000;
      const blocked = automation.debitAmount > 0 && !cashGuardPass;
      const amountUsed = blocked ? 0 : automation.debitAmount;
      const receipt: OriginAutomationRunReceipt = {
        id: `run_${started.getTime().toString(36)}`,
        automationId: automation.id,
        automationName: automation.name,
        portfolio,
        status: blocked ? 'blocked' : 'completed',
        startedAt: started.toISOString(),
        completedAt: new Date(started.getTime() + 1840).toISOString(),
        idempotencyKey,
        trigger: 'Owner-approved manual simulation',
        decision: blocked
          ? `Cash guard blocked the ${euro.format(automation.debitAmount)} action.`
          : automation.debitAmount > 0
            ? `Approved ${euro.format(automation.debitAmount)} simulated purchase recorded.`
            : 'Evaluation completed and an idempotent audit receipt was created.',
        cashBefore: cashBalance,
        cashAfter: cashBalance - amountUsed,
        amount: amountUsed,
        operations: blocked ? 0 : automation.debitAmount > 0 ? 2 : 1,
        checks: [
          {
            label: 'Owner approval',
            status: 'passed',
            detail: 'This demo run was explicitly approved from the workspace.',
          },
          {
            label: 'Idempotency key',
            status: 'passed',
            detail: 'No completed receipt exists for this trigger key.',
          },
          {
            label: 'Cash guard',
            status:
              automation.debitAmount === 0
                ? 'not-applicable'
                : cashGuardPass
                  ? 'passed'
                  : 'blocked',
            detail:
              automation.debitAmount === 0
                ? 'This automation does not spend portfolio cash.'
                : cashGuardPass
                  ? `${euro.format(cashBalance - automation.debitAmount)} remains after the action.`
                  : `The action would leave ${euro.format(cashBalance - automation.debitAmount)}, below the €1,000 floor.`,
          },
          {
            label: 'Broker access',
            status: 'not-applicable',
            detail:
              'BetterTrack records a proposal or simulated ledger activity; it cannot place a broker order.',
          },
        ],
      };
      setReceipts((current) => [receipt, ...current]);
      setSelectedReceiptId(receipt.id);
      if (!blocked) setCashBalance((current) => current - amountUsed);
      setAutomations((current) =>
        current.map((item) =>
          item.id === automation.id
            ? {
                ...item,
                lastRun: blocked ? 'Now · blocked safely' : 'Now · completed',
                runCount: item.runCount + 1,
              }
            : item,
        ),
      );
      setRunningId(null);
      setView('runs');
      onRecordActivity?.(
        activityNow(
          portfolio,
          'automation.run',
          `${automation.name} ${blocked ? 'was blocked by its cash guard' : 'completed an approved simulation'}.`,
          { receiptId: receipt.id },
        ),
      );
      notify(blocked ? 'Run blocked safely by the cash floor.' : 'Approved simulation completed.');
    }, 850);
  };

  const dryRunRows = useMemo<ReadonlyArray<readonly [string, string, string, string]>>(() => {
    if (preset === 'drive') {
      return [
        ['26 Jul', 'TR_activity_July.csv', 'Run', '39 create · 4 skip'],
        ['18 Jun', 'TR_activity_June.csv', 'Run', '42 create · 0 conflict'],
        ['18 Jun', 'TR_activity_June.csv', 'Skip', 'Duplicate file hash'],
        ['21 May', 'IBKR_May.csv', 'Review', '€25 cash conflict'],
        ['18 Apr', 'TR_activity_April.csv', 'Run', '31 create · 2 skip'],
      ];
    }
    if (preset === 'drift') {
      return [
        ['21 Jul', 'Largest drift 2.7%', 'Skip', 'Below 4.0% threshold'],
        ['30 Jun', 'Equity +4.6%', 'Review', 'Rebalance proposal'],
        ['02 Jun', 'Largest drift 3.2%', 'Skip', 'Below threshold'],
        ['31 Mar', 'Bonds −4.1%', 'Review', 'Rebalance proposal'],
        ['03 Mar', 'Largest drift 1.9%', 'Skip', 'Below threshold'],
      ];
    }
    if (preset === 'basis') {
      return [
        ['26 Jul', 'Microsoft · 12.4 sh', 'Review', 'Source evidence found'],
        ['18 Jun', 'Acme bond · 4 units', 'Review', 'Historical estimate'],
        ['21 May', 'Apple · 1.2 sh', 'Run', 'Confirmation matched'],
        ['18 Apr', 'All positions', 'Skip', 'No missing basis'],
        ['18 Mar', 'All positions', 'Skip', 'No missing basis'],
      ];
    }
    if (preset === 'report') {
      return [
        ['30 Jun', 'June owner report', 'Run', '12 pages · complete'],
        ['31 May', 'May owner report', 'Run', '11 pages · complete'],
        ['30 Apr', 'April owner report', 'Run', '12 pages · complete'],
        ['31 Mar', 'March owner report', 'Run', '13 pages · complete'],
        ['28 Feb', 'February owner report', 'Run', '11 pages · complete'],
      ];
    }
    return [
      ['02 Jul', euro.format(amount), 'Review', 'Cash after: €6,284.19'],
      ['02 Jun', euro.format(amount), 'Review', 'Cash after: €5,924.14'],
      ['02 May', euro.format(amount), 'Review', 'Cash after: €4,980.22'],
      ['02 Apr', euro.format(amount), 'Review', 'Cash after: €4,310.08'],
      ['02 Mar', euro.format(amount), 'Review', 'Cash after: €3,884.71'],
    ];
  }, [amount, preset]);

  return (
    <section className="origin-auto" aria-label="Automation workspace">
      <header className="origin-auto-header">
        <h1>Automations</h1>
        <div className="origin-auto-header__actions">
          <div className="origin-auto-cash">
            <span>Available automation cash</span>
            <strong>{euro.format(cashBalance)}</strong>
          </div>
          <button
            className="origin-auto-button origin-auto-button--primary"
            onClick={() => {
              setView('builder');
              setSubmittedProposalId(null);
            }}
            type="button"
          >
            <Icon name="plus" size={14} /> Build automation
          </button>
        </div>
      </header>

      <nav className="origin-auto-tabs" aria-label="Automation views">
        {(
          [
            ['active', 'Active & proposals', 'repeat'],
            ['builder', 'Builder', 'sliders'],
            ['runs', 'Run log', 'list'],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            aria-current={view === id ? 'page' : undefined}
            className={view === id ? 'is-active' : ''}
            key={id}
            onClick={() => setView(id)}
            type="button"
          >
            <Icon name={icon} size={15} />
            <span>{label}</span>
            {id === 'active' && pendingProposals.length > 0 ? (
              <em>{pendingProposals.length}</em>
            ) : null}
          </button>
        ))}
      </nav>

      {view === 'active' ? (
        <div className="origin-auto-active">
          {pendingProposals.length > 0 ? (
            <section className="origin-auto-pending">
              <div className="origin-auto-module-head">
                <div>
                  <span className="origin-auto-kicker">Pending review</span>
                  <h2>New proposals are inactive</h2>
                </div>
                <span className="origin-auto-state origin-auto-state--amber">
                  {pendingProposals.length} waiting
                </span>
              </div>
              {pendingProposals.map((proposal) => (
                <div className="origin-auto-pending__row" key={proposal.id}>
                  <span className="origin-auto-object-icon">
                    <Icon name="shield" size={15} />
                  </span>
                  <div>
                    <strong>{proposal.name}</strong>
                    <span>{proposal.plainEnglishRule}</span>
                  </div>
                  <span>
                    <small>Next evaluation</small>
                    <strong>{proposal.nextEvaluation}</strong>
                  </span>
                  <button
                    className="origin-auto-button origin-auto-button--secondary"
                    onClick={() => {
                      setView('builder');
                      setSubmittedProposalId(proposal.id);
                    }}
                    type="button"
                  >
                    Inspect proposal
                  </button>
                </div>
              ))}
            </section>
          ) : null}

          <div className="origin-auto-active-layout">
            <section className="origin-auto-list">
              <div className="origin-auto-module-head">
                <div>
                  <span className="origin-auto-kicker">Current workspace</span>
                  <h2>{automations.length} automation rules</h2>
                </div>
                <button
                  className="origin-auto-quiet-button"
                  onClick={cycleAutomationFilter}
                  type="button"
                >
                  <Icon name="filter" size={13} />
                  {automationFilter === 'all'
                    ? 'All rules'
                    : `${automationFilter[0]!.toUpperCase()}${automationFilter.slice(1)}`}
                </button>
              </div>
              <div className="origin-auto-table-head">
                <span>Automation</span>
                <span>Next evaluation</span>
                <span>Status</span>
              </div>
              {visibleAutomations.map((automation) => (
                <button
                  className={`origin-auto-row ${automation.id === selectedAutomation.id ? 'is-selected' : ''}`}
                  key={automation.id}
                  onClick={() => setSelectedAutomationId(automation.id)}
                  type="button"
                >
                  <span className="origin-auto-row__name">
                    <span className="origin-auto-object-icon">
                      <Icon name={automation.icon} size={15} />
                    </span>
                    <span>
                      <small>{automation.category}</small>
                      <strong>{automation.name}</strong>
                    </span>
                  </span>
                  <span className="origin-auto-row__next">
                    <strong>{automation.nextRun}</strong>
                  </span>
                  <span className={`origin-auto-state origin-auto-state--${automation.status}`}>
                    <i />
                    {automation.status}
                  </span>
                </button>
              ))}
            </section>

            <aside className="origin-auto-inspector">
              <div className="origin-auto-inspector__head">
                <span className="origin-auto-object-icon origin-auto-object-icon--large">
                  <Icon name={selectedAutomation.icon} size={18} />
                </span>
                <div>
                  <span className="origin-auto-kicker">{selectedAutomation.category}</span>
                  <h2>{selectedAutomation.name}</h2>
                </div>
                <button
                  aria-label={
                    selectedAutomation.status === 'active'
                      ? 'Pause automation'
                      : 'Resume automation'
                  }
                  aria-pressed={selectedAutomation.status === 'active'}
                  className={`origin-auto-switch ${selectedAutomation.status === 'active' ? 'is-on' : ''}`}
                  onClick={() => toggleAutomation(selectedAutomation.id)}
                  type="button"
                >
                  <span />
                </button>
              </div>

              <p className="origin-auto-inspector__description">{selectedAutomation.description}</p>

              <div className="origin-auto-rule-copy">
                <span>Rule in plain English</span>
                <div className="origin-auto-rule-grid">
                  <div>
                    <small>When</small>
                    <p>{selectedAutomation.rule.when}</p>
                  </div>
                  <div>
                    <small>If</small>
                    <p>{selectedAutomation.rule.condition}</p>
                  </div>
                  <div>
                    <small>Then</small>
                    <p>{selectedAutomation.rule.then}</p>
                  </div>
                  <div>
                    <small>Approval</small>
                    <p>{selectedAutomation.review}</p>
                  </div>
                </div>
              </div>

              <dl className="origin-auto-inspector__facts">
                <div>
                  <dt>Next evaluation</dt>
                  <dd>{selectedAutomation.nextRun}</dd>
                </div>
                <div>
                  <dt>Last result</dt>
                  <dd>{selectedAutomation.lastRun}</dd>
                </div>
                <div>
                  <dt>Reliability</dt>
                  <dd>
                    {selectedAutomation.successRate}% · {selectedAutomation.runCount} runs
                  </dd>
                </div>
                <div>
                  <dt>Cash impact</dt>
                  <dd>
                    {selectedAutomation.debitAmount
                      ? `${euro.format(selectedAutomation.debitAmount)} maximum`
                      : 'No direct cash change'}
                  </dd>
                </div>
              </dl>

              <div className="origin-auto-inspector__section">
                <span className="origin-auto-section-title">Affected data</span>
                <div className="origin-auto-tags">
                  {selectedAutomation.affectedData.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>

              <div className="origin-auto-inspector__section">
                <span className="origin-auto-section-title">Granted permissions</span>
                <ul className="origin-auto-checks">
                  {selectedAutomation.permissions.map((permission) => (
                    <li key={permission}>
                      <Icon name="check" size={12} /> {permission}
                    </li>
                  ))}
                  <li className="is-denied">
                    <Icon name="lock" size={12} /> No broker order or withdrawal access
                  </li>
                </ul>
              </div>

              <div className="origin-auto-inspector__actions">
                <button
                  className="origin-auto-button origin-auto-button--secondary"
                  onClick={() => {
                    const latest = receipts.find(
                      (receipt) => receipt.automationId === selectedAutomation.id,
                    );
                    if (latest) setSelectedReceiptId(latest.id);
                    setView('runs');
                  }}
                  type="button"
                >
                  View runs
                </button>
                <button
                  className="origin-auto-button origin-auto-button--primary"
                  disabled={
                    runningId === selectedAutomation.id || selectedAutomation.status === 'paused'
                  }
                  onClick={() => simulateRun(selectedAutomation)}
                  type="button"
                >
                  {runningId === selectedAutomation.id ? (
                    <>
                      <span className="origin-auto-spinner" /> Evaluating…
                    </>
                  ) : (
                    <>
                      <Icon name="shield" size={13} /> Simulate approved run
                    </>
                  )}
                </button>
              </div>
              {selectedAutomation.debitAmount > 0 ? (
                <div className="origin-auto-cash-guard">
                  <Icon name="wallet" size={14} />
                  <span>
                    Cash guard blocks the run unless at least €1,000 remains. Current post-run cash:{' '}
                    <strong>{euro.format(cashBalance - selectedAutomation.debitAmount)}</strong>
                  </span>
                </div>
              ) : null}
            </aside>
          </div>
        </div>
      ) : null}

      {view === 'builder' ? (
        <div className="origin-auto-builder">
          <section className="origin-auto-presets">
            <div className="origin-auto-module-head">
              <div>
                <span className="origin-auto-kicker">Starting point</span>
                <h2>Choose a workflow, then make it yours</h2>
              </div>
              <span>Templates set safe defaults, not hidden behavior.</span>
            </div>
            <div className="origin-auto-preset-grid">
              {presetMeta.map((item) => (
                <button
                  aria-pressed={preset === item.id}
                  className={preset === item.id ? 'is-selected' : ''}
                  key={item.id}
                  onClick={() => applyPreset(item.id)}
                  type="button"
                >
                  <span className="origin-auto-object-icon">
                    <Icon name={item.icon} size={15} />
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </span>
                  <span className="origin-auto-preset-check">
                    {preset === item.id ? <Icon name="check" size={11} /> : null}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {submittedProposalId ? (
            <div className="origin-auto-proposal-notice">
              <span>
                <Icon name="check" size={15} />
              </span>
              <div>
                <strong>Proposal {submittedProposalId} is waiting for review</strong>
                <p>
                  It has no trigger subscription and cannot run yet. Activation requires a separate
                  approval.
                </p>
              </div>
              <button
                className="origin-auto-button origin-auto-button--secondary"
                onClick={() => setView('active')}
                type="button"
              >
                Open review queue
              </button>
            </div>
          ) : null}

          <div className="origin-auto-builder-layout">
            <div className="origin-auto-builder-main">
              <section className="origin-auto-builder-module">
                <div className="origin-auto-builder-module__number">01</div>
                <div className="origin-auto-builder-module__content">
                  <div className="origin-auto-module-head">
                    <div>
                      <span className="origin-auto-kicker">Trigger</span>
                      <h2>When should BetterTrack evaluate?</h2>
                    </div>
                    <span className="origin-auto-module-state">Evaluation only</span>
                  </div>
                  <div className="origin-auto-field-grid">
                    <label className="origin-auto-field">
                      <span>Trigger type</span>
                      <select
                        onChange={(event) => setTriggerKind(event.target.value as TriggerKind)}
                        value={triggerKind}
                      >
                        {Object.entries(triggerLabels).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {triggerKind === 'drive-file' ? (
                      <label className="origin-auto-field origin-auto-field--wide">
                        <span>Connected folder</span>
                        <div className="origin-auto-input-icon">
                          <Icon name="folder" size={14} />
                          <input
                            onChange={(event) => setDriveFolder(event.target.value)}
                            value={driveFolder}
                          />
                        </div>
                      </label>
                    ) : triggerKind === 'allocation-drift' ? (
                      <label className="origin-auto-field">
                        <span>Drift threshold</span>
                        <div className="origin-auto-suffix-input">
                          <input
                            min="0.5"
                            onChange={(event) => setDriftThreshold(Number(event.target.value))}
                            step="0.5"
                            type="number"
                            value={driftThreshold}
                          />
                          <span>%</span>
                        </div>
                      </label>
                    ) : triggerKind === 'missing-basis' ? (
                      <label className="origin-auto-field">
                        <span>Evaluate</span>
                        <select defaultValue="after-import">
                          <option value="after-import">After every import</option>
                          <option value="daily">Daily at 06:00</option>
                        </select>
                      </label>
                    ) : (
                      <>
                        <label className="origin-auto-field">
                          <span>Day of month</span>
                          <input
                            max="31"
                            min="1"
                            onChange={(event) => setTriggerDay(Number(event.target.value))}
                            type="number"
                            value={triggerDay}
                          />
                        </label>
                        <label className="origin-auto-field">
                          <span>Local time</span>
                          <input
                            onChange={(event) => setTriggerTime(event.target.value)}
                            type="time"
                            value={triggerTime}
                          />
                        </label>
                      </>
                    )}
                  </div>
                  <div className="origin-auto-trigger-foot">
                    <span>
                      <Icon name="clock" size={13} /> Europe/Vienna
                    </span>
                    <span>
                      <Icon name="calendar" size={13} /> Next: {nextEvaluation}
                    </span>
                    <span>
                      <Icon name="repeat" size={13} /> Missed evaluations resume safely
                    </span>
                  </div>
                </div>
              </section>

              <section className="origin-auto-builder-module">
                <div className="origin-auto-builder-module__number">02</div>
                <div className="origin-auto-builder-module__content">
                  <div className="origin-auto-module-head">
                    <div>
                      <span className="origin-auto-kicker">Conditions</span>
                      <h2>What must be true?</h2>
                    </div>
                    <span className="origin-auto-module-state">
                      {[cashGuardEnabled, dedupeEnabled, onlyOnChange].filter(Boolean).length}{' '}
                      guards
                    </span>
                  </div>
                  <div className="origin-auto-condition-list">
                    <label className={cashGuardEnabled ? 'is-enabled' : ''}>
                      <input
                        checked={cashGuardEnabled}
                        onChange={(event) => setCashGuardEnabled(event.target.checked)}
                        type="checkbox"
                      />
                      <span className="origin-auto-condition-icon">
                        <Icon name="wallet" size={14} />
                      </span>
                      <span>
                        <strong>Protect the cash floor</strong>
                        <small>
                          Skip any spending action that would leave too little liquid cash.
                        </small>
                      </span>
                      <span className="origin-auto-inline-value">
                        <em>Cash after</em>
                        <b>≥</b>
                        <input
                          disabled={!cashGuardEnabled}
                          min="0"
                          onChange={(event) => setCashFloor(Number(event.target.value))}
                          step="100"
                          type="number"
                          value={cashFloor}
                        />
                        <i>EUR</i>
                      </span>
                    </label>
                    <label className={dedupeEnabled ? 'is-enabled' : ''}>
                      <input
                        checked={dedupeEnabled}
                        onChange={(event) => setDedupeEnabled(event.target.checked)}
                        type="checkbox"
                      />
                      <span className="origin-auto-condition-icon">
                        <Icon name="copy" size={14} />
                      </span>
                      <span>
                        <strong>Require a new idempotency key</strong>
                        <small>
                          A completed source event can never create the same work twice.
                        </small>
                      </span>
                      <span className="origin-auto-condition-result">
                        {dedupeEnabled ? 'Required' : 'Off'}
                      </span>
                    </label>
                    <label className={onlyOnChange ? 'is-enabled' : ''}>
                      <input
                        checked={onlyOnChange}
                        onChange={(event) => setOnlyOnChange(event.target.checked)}
                        type="checkbox"
                      />
                      <span className="origin-auto-condition-icon">
                        <Icon name="activity" size={14} />
                      </span>
                      <span>
                        <strong>Do nothing without a material change</strong>
                        <small>
                          Record a skipped evaluation instead of manufacturing busywork.
                        </small>
                      </span>
                      <span className="origin-auto-condition-result">
                        {onlyOnChange ? 'Required' : 'Off'}
                      </span>
                    </label>
                  </div>
                </div>
              </section>

              <section className="origin-auto-builder-module">
                <div className="origin-auto-builder-module__number">03</div>
                <div className="origin-auto-builder-module__content">
                  <div className="origin-auto-module-head">
                    <div>
                      <span className="origin-auto-kicker">Proposed action</span>
                      <h2>What work should be prepared?</h2>
                    </div>
                    <span className="origin-auto-module-state origin-auto-module-state--safe">
                      No broker execution
                    </span>
                  </div>
                  <div className="origin-auto-field-grid">
                    <label className="origin-auto-field">
                      <span>Action</span>
                      <select
                        onChange={(event) => setActionKind(event.target.value as ActionKind)}
                        value={actionKind}
                      >
                        {Object.entries(actionLabels).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {actionKind === 'propose-purchase' ? (
                      <>
                        <label className="origin-auto-field">
                          <span>Amount</span>
                          <div className="origin-auto-prefix-input">
                            <span>€</span>
                            <input
                              min="1"
                              onChange={(event) => setAmount(Number(event.target.value))}
                              step="25"
                              type="number"
                              value={amount}
                            />
                          </div>
                        </label>
                        <label className="origin-auto-field origin-auto-field--wide">
                          <span>Asset</span>
                          <div className="origin-auto-input-icon">
                            <Icon name="search" size={14} />
                            <input
                              onChange={(event) => setAsset(event.target.value)}
                              value={asset}
                            />
                          </div>
                        </label>
                      </>
                    ) : null}
                    {actionKind === 'import-activities' ? (
                      <>
                        <label className="origin-auto-field">
                          <span>Destination</span>
                          <input readOnly value={portfolio} />
                        </label>
                        <label className="origin-auto-field">
                          <span>Duplicate policy</span>
                          <select defaultValue="skip">
                            <option value="skip">Skip exact; review similar</option>
                            <option value="review">Review every potential match</option>
                          </select>
                        </label>
                      </>
                    ) : null}
                    {actionKind === 'propose-rebalance' ? (
                      <>
                        <label className="origin-auto-field">
                          <span>Target model</span>
                          <select defaultValue="core">
                            <option value="core">Core 70/20/10</option>
                            <option value="growth">Growth 85/10/5</option>
                          </select>
                        </label>
                        <label className="origin-auto-field">
                          <span>Output</span>
                          <input readOnly value="Workbench proposal" />
                        </label>
                      </>
                    ) : null}
                    {actionKind === 'research-cost-basis' ? (
                      <>
                        <label className="origin-auto-field">
                          <span>Evidence order</span>
                          <select defaultValue="documents">
                            <option value="documents">Source documents first</option>
                            <option value="market">Historical prices first</option>
                          </select>
                        </label>
                        <label className="origin-auto-field">
                          <span>Fallback</span>
                          <input readOnly value="Mark unknown and request review" />
                        </label>
                      </>
                    ) : null}
                    {actionKind === 'create-report' ? (
                      <>
                        <label className="origin-auto-field">
                          <span>Report blueprint</span>
                          <select defaultValue="owner">
                            <option value="owner">Owner monthly review</option>
                            <option value="risk">Risk committee snapshot</option>
                          </select>
                        </label>
                        <label className="origin-auto-field">
                          <span>Delivery</span>
                          <select defaultValue="inbox">
                            <option value="inbox">Private portfolio inbox</option>
                            <option value="email">Verified owner email</option>
                          </select>
                        </label>
                      </>
                    ) : null}
                  </div>
                  <div className="origin-auto-action-boundary">
                    <Icon name="shield" size={15} />
                    <span>
                      <strong>Propose, then account.</strong> This action can prepare portfolio work
                      and write only after the selected review policy permits it. It cannot submit a
                      real market order.
                    </span>
                  </div>
                </div>
              </section>

              <section className="origin-auto-builder-module">
                <div className="origin-auto-builder-module__number">04</div>
                <div className="origin-auto-builder-module__content">
                  <div className="origin-auto-module-head">
                    <div>
                      <span className="origin-auto-kicker">Review policy</span>
                      <h2>Where does human approval sit?</h2>
                    </div>
                    <span className="origin-auto-module-state origin-auto-module-state--required">
                      Required decision
                    </span>
                  </div>
                  <div className="origin-auto-policy-grid">
                    {(
                      [
                        [
                          'approve-every-run',
                          'Approve every run',
                          'The automation prepares work, then waits before any portfolio write.',
                          'Highest control',
                        ],
                        [
                          'auto-within-guardrails',
                          'Auto inside guardrails',
                          'Previously approved low-risk actions can write when every condition passes.',
                          'Balanced',
                        ],
                        [
                          'exceptions-only',
                          'Review exceptions',
                          'Normal reconciled work proceeds; conflicts and permission changes pause.',
                          'Lowest friction',
                        ],
                      ] as const
                    ).map(([id, title, description, badge]) => (
                      <label className={reviewPolicy === id ? 'is-selected' : ''} key={id}>
                        <input
                          checked={reviewPolicy === id}
                          name="review-policy"
                          onChange={() => setReviewPolicy(id)}
                          type="radio"
                        />
                        <span className="origin-auto-policy-radio">
                          {reviewPolicy === id ? <span /> : null}
                        </span>
                        <strong>{title}</strong>
                        <p>{description}</p>
                        <small>{badge}</small>
                      </label>
                    ))}
                  </div>
                  <div className="origin-auto-permission-matrix">
                    <div>
                      <span>Capability</span>
                      <span>Evaluate</span>
                      <span>Propose</span>
                      <span>Write</span>
                      <span>External action</span>
                    </div>
                    {[
                      ['Portfolio data', 'Read', '—', '—', 'Never'],
                      ['Workbench object', 'Read', 'Create', 'On approval', 'Never'],
                      ['Activity ledger', 'Read', 'Create preview', 'By policy', 'Never'],
                      ['Broker account', 'No access', '—', 'Never', 'Never'],
                    ].map((row) => (
                      <div key={row[0]}>
                        {row.map((cell, index) => (
                          <span
                            className={cell === 'Never' || cell === 'No access' ? 'is-denied' : ''}
                            key={cell}
                          >
                            {index > 0 && cell !== '—' ? (
                              <Icon
                                name={cell === 'Never' || cell === 'No access' ? 'lock' : 'check'}
                                size={10}
                              />
                            ) : null}
                            {cell}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              <section className="origin-auto-dry-run">
                <div className="origin-auto-module-head">
                  <div>
                    <span className="origin-auto-kicker">Historical dry run</span>
                    <h2>How this rule would have behaved</h2>
                  </div>
                  <span className="origin-auto-state origin-auto-state--active">
                    <i /> Evaluation passed
                  </span>
                </div>
                <div className="origin-auto-dry-metrics">
                  <div>
                    <span>Evaluations</span>
                    <strong>{dryRun.evaluated}</strong>
                    <small>01 Jan → 27 Jul 2026</small>
                  </div>
                  <div>
                    <span>Would act</span>
                    <strong>{dryRun.wouldRun}</strong>
                    <small>{dryRun.wouldRequestReview} require review</small>
                  </div>
                  <div>
                    <span>Would skip</span>
                    <strong>{dryRun.wouldSkip}</strong>
                    <small>Guarded, duplicate, or no change</small>
                  </div>
                  <div>
                    <span>Cash impact</span>
                    <strong>{euro.format(dryRun.estimatedCashImpact)}</strong>
                    <small>Simulated · no real trades</small>
                  </div>
                </div>
                <div className="origin-auto-dry-table-wrap">
                  <table className="origin-auto-dry-table">
                    <thead>
                      <tr>
                        <th>Evaluation</th>
                        <th>Input</th>
                        <th>Decision</th>
                        <th>Reason / outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dryRunRows.map((row) => (
                        <tr key={`${row[0]}-${row[1]}`}>
                          <td>{row[0]}</td>
                          <td>{row[1]}</td>
                          <td>
                            <span
                              className={`origin-auto-decision origin-auto-decision--${row[2].toLowerCase()}`}
                            >
                              {row[2]}
                            </span>
                          </td>
                          <td>{row[3]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <aside className="origin-auto-builder-aside">
              <div className="origin-auto-builder-aside__sticky">
                <section className="origin-auto-live-rule">
                  <div className="origin-auto-section-title">
                    <span>Live rule</span>
                    <span className="origin-auto-state origin-auto-state--draft">Draft</span>
                  </div>
                  <label className="origin-auto-field">
                    <span>Automation name</span>
                    <input onChange={(event) => setRuleName(event.target.value)} value={ruleName} />
                  </label>
                  <blockquote>{plainEnglishRule}</blockquote>
                  <button
                    className="origin-auto-quiet-button"
                    onClick={copyPlainEnglishRule}
                    type="button"
                  >
                    <Icon name={ruleCopied ? 'check' : 'copy'} size={12} />
                    {ruleCopied ? 'Copied' : 'Copy as plain text'}
                  </button>
                </section>

                <section className="origin-auto-readiness">
                  <div className="origin-auto-section-title">
                    <span>Readiness</span>
                    <strong>4 / 4</strong>
                  </div>
                  <ul>
                    <li>
                      <Icon name="check" size={12} />
                      <span>
                        <strong>Trigger</strong>
                        <small>{triggerLabels[triggerKind]}</small>
                      </span>
                    </li>
                    <li>
                      <Icon name="check" size={12} />
                      <span>
                        <strong>Conditions</strong>
                        <small>Idempotency and material-change guards</small>
                      </span>
                    </li>
                    <li>
                      <Icon name="check" size={12} />
                      <span>
                        <strong>Action</strong>
                        <small>{actionLabels[actionKind]}</small>
                      </span>
                    </li>
                    <li>
                      <Icon name="check" size={12} />
                      <span>
                        <strong>Approval boundary</strong>
                        <small>{reviewPolicyLabel(reviewPolicy)}</small>
                      </span>
                    </li>
                  </ul>
                </section>

                <section className="origin-auto-impact">
                  <div className="origin-auto-section-title">
                    <span>Operational impact</span>
                  </div>
                  <dl>
                    <div>
                      <dt>Next evaluation</dt>
                      <dd>{nextEvaluation}</dd>
                    </div>
                    <div>
                      <dt>Affected portfolio</dt>
                      <dd>{portfolio}</dd>
                    </div>
                    <div>
                      <dt>Available cash</dt>
                      <dd>{euro.format(cashBalance)}</dd>
                    </div>
                    <div>
                      <dt>Maximum single write</dt>
                      <dd>
                        {actionKind === 'propose-purchase' ? euro.format(amount) : 'No cash write'}
                      </dd>
                    </div>
                  </dl>
                  <div className="origin-auto-impact__boundary">
                    <Icon name="lock" size={13} />
                    <span>
                      External trading, withdrawals, access changes, and sharing are outside this
                      rule’s permission boundary.
                    </span>
                  </div>
                </section>

                <div className="origin-auto-submit">
                  <button
                    className="origin-auto-button origin-auto-button--primary"
                    onClick={submitProposal}
                    type="button"
                  >
                    <Icon name="shield" size={14} />
                    Submit for review
                  </button>
                  <span>
                    Creates an inactive proposal. It cannot run until separately approved.
                  </span>
                </div>
              </div>
            </aside>
          </div>
        </div>
      ) : null}

      {view === 'runs' ? (
        <div className="origin-auto-runs">
          <div className="origin-auto-run-layout">
            <section className="origin-auto-run-list">
              <div className="origin-auto-module-head">
                <div>
                  <span className="origin-auto-kicker">Immutable audit log</span>
                  <h2>Automation runs</h2>
                </div>
                <span>{receipts.length} retained receipts</span>
              </div>
              <div className="origin-auto-run-filters">
                {(['all', 'completed', 'blocked', 'skipped'] as RunFilter[]).map((filter) => (
                  <button
                    className={runFilter === filter ? 'is-active' : ''}
                    key={filter}
                    onClick={() => setRunFilter(filter)}
                    type="button"
                  >
                    {filter}
                    <span>
                      {filter === 'all'
                        ? receipts.length
                        : receipts.filter((receipt) => receipt.status === filter).length}
                    </span>
                  </button>
                ))}
              </div>
              <div className="origin-auto-run-table-head">
                <span>Run</span>
                <span>Automation</span>
                <span>Decision</span>
                <span>Started</span>
              </div>
              {filteredReceipts.map((receipt) => (
                <button
                  className={`origin-auto-run-row ${receipt.id === selectedReceipt.id ? 'is-selected' : ''}`}
                  key={receipt.id}
                  onClick={() => setSelectedReceiptId(receipt.id)}
                  type="button"
                >
                  <span
                    className={`origin-auto-run-signal origin-auto-run-signal--${receipt.status}`}
                  >
                    <Icon
                      name={
                        receipt.status === 'completed'
                          ? 'check'
                          : receipt.status === 'blocked'
                            ? 'shield'
                            : 'minus'
                      }
                      size={12}
                    />
                  </span>
                  <span>
                    <small>{receipt.id}</small>
                    <strong>{receipt.automationName}</strong>
                  </span>
                  <span className={`origin-auto-state origin-auto-state--${receipt.status}`}>
                    {runStatusLabel(receipt.status)}
                  </span>
                  <span>
                    {new Date(receipt.startedAt).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </button>
              ))}
            </section>

            <aside className="origin-auto-receipt">
              <div className="origin-auto-receipt__hero">
                <span
                  className={`origin-auto-run-signal origin-auto-run-signal--${selectedReceipt.status}`}
                >
                  <Icon
                    name={
                      selectedReceipt.status === 'completed'
                        ? 'check'
                        : selectedReceipt.status === 'blocked'
                          ? 'shield'
                          : 'minus'
                    }
                    size={15}
                  />
                </span>
                <div>
                  <span className="origin-auto-kicker">Idempotent run receipt</span>
                  <h2>{runStatusLabel(selectedReceipt.status)}</h2>
                  <p>{selectedReceipt.decision}</p>
                </div>
              </div>
              <div className="origin-auto-receipt__identity">
                <span>
                  <small>Receipt</small>
                  <code>{selectedReceipt.id}</code>
                </span>
                <span>
                  <small>Idempotency key</small>
                  <code>{selectedReceipt.idempotencyKey}</code>
                </span>
              </div>
              <dl className="origin-auto-receipt__facts">
                <div>
                  <dt>Automation</dt>
                  <dd>{selectedReceipt.automationName}</dd>
                </div>
                <div>
                  <dt>Portfolio</dt>
                  <dd>{selectedReceipt.portfolio}</dd>
                </div>
                <div>
                  <dt>Trigger</dt>
                  <dd>{selectedReceipt.trigger}</dd>
                </div>
                <div>
                  <dt>Operations</dt>
                  <dd>{selectedReceipt.operations}</dd>
                </div>
                <div>
                  <dt>Cash before</dt>
                  <dd>{euro.format(selectedReceipt.cashBefore)}</dd>
                </div>
                <div>
                  <dt>Cash after</dt>
                  <dd>{euro.format(selectedReceipt.cashAfter)}</dd>
                </div>
              </dl>
              <div className="origin-auto-receipt__checks">
                <span className="origin-auto-section-title">Decision trace</span>
                {selectedReceipt.checks.map((check) => (
                  <div key={check.label}>
                    <span
                      className={`origin-auto-check-state origin-auto-check-state--${check.status}`}
                    >
                      <Icon
                        name={
                          check.status === 'passed'
                            ? 'check'
                            : check.status === 'blocked'
                              ? 'lock'
                              : 'minus'
                        }
                        size={11}
                      />
                    </span>
                    <span>
                      <strong>{check.label}</strong>
                      <small>{check.detail}</small>
                    </span>
                  </div>
                ))}
              </div>
              <div className="origin-auto-receipt__actions">
                <button
                  className="origin-auto-button origin-auto-button--secondary"
                  onClick={downloadRunReceipt}
                  type="button"
                >
                  <Icon name="download" size={13} /> Export JSON
                </button>
                <button
                  className="origin-auto-button origin-auto-button--secondary"
                  onClick={() =>
                    notify(
                      'Receipt verified — replay would return this same result without another write.',
                    )
                  }
                  type="button"
                >
                  <Icon name="repeat" size={13} /> Verify replay
                </button>
              </div>
              <div className="origin-auto-idempotency-note">
                <Icon name="shield" size={13} />
                <span>
                  Replaying this trigger with the same key returns receipt{' '}
                  <code>{selectedReceipt.id}</code>. It cannot repeat the operation.
                </span>
              </div>
            </aside>
          </div>
        </div>
      ) : null}
    </section>
  );
}
