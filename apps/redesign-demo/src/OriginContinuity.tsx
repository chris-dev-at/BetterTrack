import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-continuity.css';

export type OriginContinuityPortfolio = {
  id: string;
  name: string;
  value: number;
  currency?: string;
};

export type OriginContinuityProps = {
  portfolio: OriginContinuityPortfolio;
  privateMode: boolean;
  onOpenWorkbench: (context: string) => void;
  onOpenFiles: () => void;
  onOpenReview: () => void;
  onOpenSecurity: () => void;
  onSubmitProposal: (proposal: OriginReviewEntry) => void;
  onToast?: (message: string) => void;
};

type ContinuityView = 'overview' | 'beneficiaries' | 'coverage' | 'handoff' | 'audit';
type EntityKind = 'account' | 'holding' | 'policy' | 'nested-portfolio';
type ChecklistState = 'ready' | 'attention' | 'missing';
type ProposalType = 'beneficiary' | 'coverage' | 'contact' | 'handoff';
type AuditTone = 'neutral' | 'positive' | 'warning';

type ProtectedEntity = {
  id: string;
  kind: EntityKind;
  name: string;
  detail: string;
  value: number;
};

type Allocation = {
  entityId: string;
  percentage: number;
};

type Beneficiary = {
  id: string;
  name: string;
  relationship: string;
  email: string;
  verified: boolean;
  allocations: Allocation[];
  updatedAt: string;
};

type InsurancePolicy = {
  id: string;
  name: string;
  provider: string;
  cover: number;
  annualPremium: number;
  status: 'active' | 'review-due';
  renews: string;
};

type CoverageNeeds = {
  liabilities: number;
  dependants: number;
  goals: number;
  immediateCosts: number;
};

type ReadinessItem = {
  id: string;
  title: string;
  detail: string;
  state: ChecklistState;
  fileName: string | null;
  updatedAt: string;
};

type EmergencyContact = {
  name: string;
  relationship: string;
  email: string;
  phone: string;
  verified: boolean;
};

type CheckInSchedule = {
  intervalDays: 30 | 60 | 90 | 180;
  graceDays: 3 | 7 | 14 | 30;
  lastCheckIn: string;
  nextCheckIn: string;
};

type HandoffScope = {
  portfolioSummary: boolean;
  accountDirectory: boolean;
  documents: boolean;
  adviserContacts: boolean;
  personalInstructions: boolean;
};

type HandoffPackage = {
  status: 'draft' | 'pending-review' | 'approved';
  encryption: string;
  scope: HandoffScope;
  instructions: string;
  lastPreparedAt: string | null;
  reviewReference: string | null;
};

type ContinuityProposal = {
  id: string;
  reference: string;
  type: ProposalType;
  title: string;
  summary: string;
  createdAt: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending';
  diff: Array<{
    label: string;
    before?: string;
    after: string;
    tone?: 'neutral' | 'positive' | 'negative' | 'warning';
    detail?: string;
  }>;
};

type ContinuityReceipt = {
  id: string;
  reference: string;
  kind: 'proposal-submitted' | 'check-in' | 'manifest-exported';
  summary: string;
  at: string;
  actor: string;
  consentConfirmed: boolean;
};

type AuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  reference: string;
  tone: AuditTone;
};

type ContinuityState = {
  version: 1;
  entities: ProtectedEntity[];
  beneficiaries: Beneficiary[];
  policies: InsurancePolicy[];
  needs: CoverageNeeds;
  checklist: ReadinessItem[];
  contact: EmergencyContact;
  schedule: CheckInSchedule;
  handoff: HandoffPackage;
  proposals: ContinuityProposal[];
  receipts: ContinuityReceipt[];
  audit: AuditEntry[];
};

type BeneficiaryDraft = {
  beneficiaryId: string | null;
  name: string;
  relationship: string;
  email: string;
  allocations: Record<string, number>;
  consent: boolean;
};

type CoverageDraft = {
  lifeCover: number;
  propertyCover: number;
  liabilities: number;
  dependants: number;
  goals: number;
  immediateCosts: number;
  note: string;
  consent: boolean;
};

type HandoffDraft = {
  contact: EmergencyContact;
  intervalDays: CheckInSchedule['intervalDays'];
  graceDays: CheckInSchedule['graceDays'];
  scope: HandoffScope;
  instructions: string;
  consent: boolean;
};

type Dialog =
  | { kind: 'beneficiary'; draft: BeneficiaryDraft }
  | { kind: 'coverage'; draft: CoverageDraft }
  | { kind: 'contact'; draft: HandoffDraft }
  | { kind: 'package'; draft: HandoffDraft }
  | null;

const viewMeta: ReadonlyArray<{
  id: ContinuityView;
  label: string;
  short: string;
  icon: IconName;
}> = [
  { id: 'overview', label: 'Overview', short: 'Overview', icon: 'home' },
  { id: 'beneficiaries', label: 'Beneficiaries', short: 'People', icon: 'people' },
  { id: 'coverage', label: 'Coverage', short: 'Cover', icon: 'shield' },
  { id: 'handoff', label: 'Handoff plan', short: 'Handoff', icon: 'key' },
  { id: 'audit', label: 'Audit & receipts', short: 'Audit', icon: 'list' },
];

const entityMeta: Record<
  EntityKind,
  { label: string; plural: string; icon: IconName; description: string }
> = {
  account: {
    label: 'Account',
    plural: 'Accounts',
    icon: 'bank',
    description: 'Cash and custody accounts',
  },
  holding: {
    label: 'Holding',
    plural: 'Holdings',
    icon: 'assets',
    description: 'Investments and private assets',
  },
  policy: {
    label: 'Policy',
    plural: 'Policies',
    icon: 'shield',
    description: 'Insurance policy proceeds',
  },
  'nested-portfolio': {
    label: 'Nested portfolio',
    plural: 'Nested portfolios',
    icon: 'layers',
    description: 'Portfolio groups and family structures',
  },
};

const today = '2026-07-27';

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function displayDate(value: string) {
  if (!value) return 'Not set';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(parsed);
}

function displayDateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatMoney(value: number, currency: string, privateMode = false) {
  if (privateMode) return '••••••';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function compactMoney(value: number, currency: string, privateMode = false) {
  if (privateMode) return '••••';
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function maskEmail(value: string, privateMode: boolean) {
  if (!privateMode) return value;
  const [local = '', domain = ''] = value.split('@');
  return `${local.slice(0, 1)}•••@${domain || '•••'}`;
}

function maskPhone(value: string, privateMode: boolean) {
  if (!privateMode) return value;
  return `••• ••• ${value.replace(/\D/g, '').slice(-3) || '•••'}`;
}

function storageKey(portfolioId: string) {
  const safe = portfolioId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-|-$/g, '');
  return `bt-demo-origin-continuity-v1:${safe || 'portfolio'}`;
}

function makeReference(prefix: string) {
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random()
    .toString(36)
    .slice(2, 7)
    .toUpperCase()}`;
}

function seedState(portfolio: OriginContinuityPortfolio): ContinuityState {
  const portfolioValue = Math.max(portfolio.value, 100_000);
  const entities: ProtectedEntity[] = [
    {
      id: 'entity-cash',
      kind: 'account',
      name: 'Operating cash',
      detail: 'Flatex cash account · ending •1842',
      value: Math.round(portfolioValue * 0.12),
    },
    {
      id: 'entity-core',
      kind: 'holding',
      name: 'Core investments',
      detail: 'Listed securities · 17 positions',
      value: Math.round(portfolioValue * 0.55),
    },
    {
      id: 'entity-property',
      kind: 'holding',
      name: 'Riverside property',
      detail: 'Private asset · valuation current',
      value: Math.round(portfolioValue * 0.23),
    },
    {
      id: 'entity-policy-life',
      kind: 'policy',
      name: 'Term life policy',
      detail: 'AlpenLife · policy AL-2844',
      value: 250_000,
    },
    {
      id: 'entity-policy-employer',
      kind: 'policy',
      name: 'Employer life cover',
      detail: 'Group policy · reviewed annually',
      value: 160_000,
    },
    {
      id: 'entity-family-reserve',
      kind: 'nested-portfolio',
      name: 'Family reserve',
      detail: `Nested under ${portfolio.name}`,
      value: Math.round(portfolioValue * 0.1),
    },
  ];

  return {
    version: 1,
    entities,
    beneficiaries: [
      {
        id: 'beneficiary-lea',
        name: 'Lea Morgan',
        relationship: 'Spouse',
        email: 'lea.morgan@example.com',
        verified: true,
        updatedAt: '2026-04-12',
        allocations: [
          { entityId: 'entity-cash', percentage: 100 },
          { entityId: 'entity-core', percentage: 50 },
          { entityId: 'entity-policy-life', percentage: 100 },
          { entityId: 'entity-family-reserve', percentage: 70 },
        ],
      },
      {
        id: 'beneficiary-anton',
        name: 'Anton Morgan',
        relationship: 'Child',
        email: 'anton.morgan@example.com',
        verified: true,
        updatedAt: '2026-04-12',
        allocations: [
          { entityId: 'entity-core', percentage: 25 },
          { entityId: 'entity-property', percentage: 50 },
          { entityId: 'entity-policy-employer', percentage: 50 },
          { entityId: 'entity-family-reserve', percentage: 15 },
        ],
      },
      {
        id: 'beneficiary-mira',
        name: 'Mira Morgan',
        relationship: 'Child',
        email: 'mira.morgan@example.com',
        verified: false,
        updatedAt: '2026-04-12',
        allocations: [
          { entityId: 'entity-core', percentage: 25 },
          { entityId: 'entity-property', percentage: 50 },
          { entityId: 'entity-policy-employer', percentage: 50 },
          { entityId: 'entity-family-reserve', percentage: 15 },
        ],
      },
    ],
    policies: [
      {
        id: 'policy-life',
        name: 'Term life',
        provider: 'AlpenLife',
        cover: 250_000,
        annualPremium: 612,
        status: 'active',
        renews: '2038-04-01',
      },
      {
        id: 'policy-employer',
        name: 'Employer group life',
        provider: 'North & Pine GmbH',
        cover: 160_000,
        annualPremium: 0,
        status: 'review-due',
        renews: '2026-11-30',
      },
    ],
    needs: {
      liabilities: 182_000,
      dependants: 220_000,
      goals: 90_000,
      immediateCosts: 36_000,
    },
    checklist: [
      {
        id: 'check-will',
        title: 'Current will',
        detail: 'Signed copy and executor details',
        state: 'ready',
        fileName: 'Will · signed · 2025.pdf',
        updatedAt: '2025-11-04',
      },
      {
        id: 'check-poa',
        title: 'Power of attorney',
        detail: 'Financial authority for an extended absence',
        state: 'missing',
        fileName: null,
        updatedAt: '',
      },
      {
        id: 'check-policy',
        title: 'Insurance schedule',
        detail: 'Policy numbers, providers, and claims contacts',
        state: 'ready',
        fileName: 'Insurance schedule · 2026.pdf',
        updatedAt: '2026-04-02',
      },
      {
        id: 'check-identity',
        title: 'Identity evidence',
        detail: 'Passport copy expires in under twelve months',
        state: 'attention',
        fileName: 'Passport · CM.pdf',
        updatedAt: '2022-09-18',
      },
      {
        id: 'check-accounts',
        title: 'Account directory',
        detail: 'Institution names and account references, without passwords',
        state: 'ready',
        fileName: 'Account directory · 2026.pdf',
        updatedAt: '2026-06-30',
      },
      {
        id: 'check-tax',
        title: 'Tax and residency records',
        detail: 'Most recent return and residency evidence',
        state: 'ready',
        fileName: 'Tax bundle · 2025.zip',
        updatedAt: '2026-03-22',
      },
    ],
    contact: {
      name: 'Elena Fischer',
      relationship: 'Family solicitor',
      email: 'elena.fischer@example.com',
      phone: '+43 660 555 018',
      verified: true,
    },
    schedule: {
      intervalDays: 90,
      graceDays: 14,
      lastCheckIn: '2026-07-20',
      nextCheckIn: '2026-10-18',
    },
    handoff: {
      status: 'draft',
      encryption: 'Account key + emergency contact key',
      scope: {
        portfolioSummary: true,
        accountDirectory: true,
        documents: true,
        adviserContacts: true,
        personalInstructions: false,
      },
      instructions:
        'Contact the family solicitor first. Preserve the core portfolio until the executor confirms authority.',
      lastPreparedAt: '2026-04-12T09:30:00.000Z',
      reviewReference: null,
    },
    proposals: [],
    receipts: [
      {
        id: 'receipt-seed',
        reference: 'CONT-20260412-A3P8K',
        kind: 'proposal-submitted',
        summary: 'Annual beneficiary review recorded',
        at: '2026-04-12T09:34:00.000Z',
        actor: 'You',
        consentConfirmed: true,
      },
    ],
    audit: [
      {
        id: 'audit-seed-1',
        at: '2026-07-20T08:12:00.000Z',
        actor: 'You',
        action: 'Availability confirmed',
        detail: 'The next scheduled check-in was set for 18 Oct 2026.',
        reference: 'CHECK-20260720-91KD2',
        tone: 'positive',
      },
      {
        id: 'audit-seed-2',
        at: '2026-04-12T09:34:00.000Z',
        actor: 'You',
        action: 'Annual beneficiary review recorded',
        detail: 'No distribution changes. Contact details were re-verified.',
        reference: 'CONT-20260412-A3P8K',
        tone: 'neutral',
      },
      {
        id: 'audit-seed-3',
        at: '2026-04-02T11:05:00.000Z',
        actor: 'Drive sync',
        action: 'Insurance schedule linked',
        detail: 'Insurance schedule · 2026.pdf was linked from Files.',
        reference: 'FILE-82C1E',
        tone: 'positive',
      },
    ],
  };
}

function loadState(portfolio: OriginContinuityPortfolio) {
  const seeded = seedState(portfolio);
  if (typeof window === 'undefined') return seeded;
  try {
    const raw = window.localStorage.getItem(storageKey(portfolio.id));
    if (!raw) return seeded;
    const parsed = JSON.parse(raw) as Partial<ContinuityState>;
    if (parsed.version !== 1) return seeded;
    return {
      ...seeded,
      ...parsed,
      entities: Array.isArray(parsed.entities) ? parsed.entities : seeded.entities,
      beneficiaries: Array.isArray(parsed.beneficiaries)
        ? parsed.beneficiaries
        : seeded.beneficiaries,
      policies: Array.isArray(parsed.policies) ? parsed.policies : seeded.policies,
      checklist: Array.isArray(parsed.checklist) ? parsed.checklist : seeded.checklist,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : seeded.proposals,
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : seeded.receipts,
      audit: Array.isArray(parsed.audit) ? parsed.audit : seeded.audit,
      needs: { ...seeded.needs, ...parsed.needs },
      contact: { ...seeded.contact, ...parsed.contact },
      schedule: { ...seeded.schedule, ...parsed.schedule },
      handoff: {
        ...seeded.handoff,
        ...parsed.handoff,
        scope: { ...seeded.handoff.scope, ...parsed.handoff?.scope },
      },
    } satisfies ContinuityState;
  } catch {
    return seeded;
  }
}

function allocationTotal(beneficiaries: Beneficiary[], entityId: string) {
  return beneficiaries.reduce(
    (sum, beneficiary) =>
      sum +
      (beneficiary.allocations.find((allocation) => allocation.entityId === entityId)?.percentage ??
        0),
    0,
  );
}

function scopeLabel(scope: keyof HandoffScope) {
  if (scope === 'portfolioSummary') return 'Portfolio summary and ownership map';
  if (scope === 'accountDirectory') return 'Account and provider directory';
  if (scope === 'documents') return 'Approved continuity documents';
  if (scope === 'adviserContacts') return 'Adviser and professional contacts';
  return 'Personal instructions';
}

function proposalLabel(type: ProposalType) {
  if (type === 'beneficiary') return 'Beneficiary change';
  if (type === 'coverage') return 'Coverage assumptions';
  if (type === 'contact') return 'Contact and check-in rules';
  return 'Encrypted handoff package';
}

function StatusMark({ state }: { state: ChecklistState }) {
  return (
    <span className={cx('oct-status-mark', `is-${state}`)} aria-label={state}>
      <Icon name={state === 'ready' ? 'check' : state === 'missing' ? 'x' : 'clock'} size={11} />
    </span>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="oct-section-heading">
      <div>
        {eyebrow ? <span>{eyebrow}</span> : null}
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action ? <div className="oct-section-heading__action">{action}</div> : null}
    </header>
  );
}

export function OriginContinuity({
  portfolio,
  privateMode,
  onOpenWorkbench,
  onOpenFiles,
  onOpenReview,
  onOpenSecurity,
  onSubmitProposal,
  onToast,
}: OriginContinuityProps) {
  const currency = portfolio.currency ?? 'EUR';
  const key = storageKey(portfolio.id);
  const [state, setState] = useState<ContinuityState>(() => loadState(portfolio));
  const [boundKey, setBoundKey] = useState(key);
  const [view, setView] = useState<ContinuityView>('overview');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [receipt, setReceipt] = useState<ContinuityReceipt | null>(null);
  const [auditFilter, setAuditFilter] = useState<'all' | 'proposals' | 'activity'>('all');
  const [beneficiarySearch, setBeneficiarySearch] = useState('');
  const changeDialogRef = useAccessibleDialog<HTMLFormElement>({
    open: Boolean(dialog),
    onClose: () => setDialog(null),
    initialFocusSelector: 'input, textarea, select, button',
  });
  const receiptDialogRef = useAccessibleDialog<HTMLElement>({
    open: Boolean(receipt),
    onClose: () => setReceipt(null),
    initialFocusSelector: '[aria-label="Close receipt"]',
  });

  useEffect(() => {
    if (boundKey === key) return;
    setState(loadState(portfolio));
    setBoundKey(key);
    setView('overview');
    setDialog(null);
    setReceipt(null);
  }, [boundKey, key, portfolio]);

  useEffect(() => {
    if (boundKey !== key || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // The demo remains fully usable in memory when browser storage is unavailable.
    }
  }, [boundKey, key, state]);

  const totals = useMemo(() => {
    const insurance = state.policies.reduce((sum, policy) => sum + policy.cover, 0);
    const liquidAssets = state.entities.find((entity) => entity.id === 'entity-cash')?.value ?? 0;
    const needs = Object.values(state.needs).reduce((sum, value) => sum + value, 0);
    const resources = insurance + liquidAssets;
    const gap = resources - needs;
    const coverageRatio = needs > 0 ? (resources / needs) * 100 : 100;
    return { insurance, liquidAssets, needs, resources, gap, coverageRatio };
  }, [state.entities, state.needs, state.policies]);

  const readiness = useMemo(() => {
    const documentPoints =
      (state.checklist.filter((item) => item.state === 'ready').length /
        Math.max(state.checklist.length, 1)) *
      30;
    const beneficiaryPoints =
      (state.entities.filter((entity) => allocationTotal(state.beneficiaries, entity.id) === 100)
        .length /
        Math.max(state.entities.length, 1)) *
      25;
    const coverPoints = Math.min(20, (totals.coverageRatio / 100) * 20);
    const contactPoints = state.contact.verified ? 10 : 4;
    const handoffPoints =
      state.handoff.status === 'approved' ? 15 : state.handoff.lastPreparedAt ? 8 : 0;
    return Math.round(
      Math.min(
        100,
        documentPoints + beneficiaryPoints + coverPoints + contactPoints + handoffPoints,
      ),
    );
  }, [
    state.beneficiaries,
    state.checklist,
    state.contact.verified,
    state.entities,
    state.handoff.lastPreparedAt,
    state.handoff.status,
    totals.coverageRatio,
  ]);

  const entityCoverage = useMemo(
    () =>
      state.entities.map((entity) => ({
        ...entity,
        allocated: allocationTotal(state.beneficiaries, entity.id),
      })),
    [state.beneficiaries, state.entities],
  );

  const pendingCount = state.proposals.filter((proposal) => proposal.status === 'pending').length;
  const checklistAttention = state.checklist.filter((item) => item.state !== 'ready').length;
  const selectedView = viewMeta.find((item) => item.id === view) ?? viewMeta[0]!;

  const appendReceipt = (
    kind: ContinuityReceipt['kind'],
    summary: string,
    reference: string,
    consentConfirmed: boolean,
  ) => {
    const next: ContinuityReceipt = {
      id: uid('receipt'),
      reference,
      kind,
      summary,
      at: new Date().toISOString(),
      actor: 'You',
      consentConfirmed,
    };
    setState((current) => ({
      ...current,
      receipts: [next, ...current.receipts].slice(0, 100),
    }));
    setReceipt(next);
    return next;
  };

  const submitChange = (
    type: ProposalType,
    title: string,
    summary: string,
    diff: ContinuityProposal['diff'],
    risk: ContinuityProposal['risk'],
  ) => {
    const reference = makeReference('CONT');
    const id = uid('continuity');
    const createdAt = new Date().toISOString();
    const localProposal: ContinuityProposal = {
      id,
      reference,
      type,
      title,
      summary,
      createdAt,
      risk,
      status: 'pending',
      diff,
    };

    const proposal: OriginReviewEntry = {
      id,
      kind: 'collaboration',
      title,
      summary,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Protection & continuity`,
      },
      source: {
        label: 'Protection & continuity',
        detail: 'Portfolio-scoped continuity plan',
        actor: 'You',
      },
      requestedAt: createdAt,
      requestedBy: 'You',
      status: 'pending',
      priority: risk === 'high' ? 'high' : 'normal',
      risk,
      affectedCount: diff.length,
      tags: ['continuity', 'portfolio-scoped', type],
      approveLabel: 'Approve change',
      rejectLabel: 'Keep current plan',
      diff,
      lineage: [
        {
          label: 'Portfolio source',
          detail: `${portfolio.name} · protection and continuity workspace`,
          at: createdAt,
          state: 'verified',
        },
        {
          label: 'Explicit consent',
          detail: 'The owner confirmed this proposal before it entered review.',
          at: createdAt,
          state: 'verified',
        },
        {
          label: 'No live change yet',
          detail: 'Current beneficiaries and release rules remain unchanged until approval.',
          state: 'derived',
        },
      ],
      permissions: [
        {
          label: 'Portfolio owner',
          detail: 'May propose protection and continuity changes',
          outcome: 'allowed',
        },
        {
          label: 'Continuity plan',
          detail: 'Sensitive changes require a recorded review decision',
          outcome: 'review',
        },
        {
          label: 'Emergency contact',
          detail: 'Cannot alter the portfolio or release rules',
          outcome: 'blocked',
        },
      ],
      policies: [
        {
          title: 'Approval before activation',
          description: 'The current plan remains authoritative until this proposal is approved.',
          status: 'pass',
        },
        {
          title: 'Consent recorded',
          description: `Owner consent is attached to ${reference}.`,
          status: 'pass',
        },
        {
          title: 'Sensitive details protected',
          description:
            'Review summaries do not include passwords, recovery keys, or file contents.',
          status: 'pass',
        },
      ],
    };

    setState((current) => ({
      ...current,
      proposals: [localProposal, ...current.proposals].slice(0, 100),
      handoff:
        type === 'handoff'
          ? {
              ...current.handoff,
              status: 'pending-review',
              lastPreparedAt: createdAt,
              reviewReference: reference,
            }
          : current.handoff,
      audit: [
        {
          id: uid('audit'),
          at: createdAt,
          actor: 'You',
          action: `${proposalLabel(type)} submitted`,
          detail: `${diff.length} change${diff.length === 1 ? '' : 's'} waiting in Review.`,
          reference,
          tone: 'warning',
        },
        ...current.audit,
      ],
    }));
    onSubmitProposal(proposal);
    appendReceipt('proposal-submitted', title, reference, true);
    setDialog(null);
    onToast?.(`${proposalLabel(type)} sent to Review. The current plan is unchanged.`);
  };

  const openBeneficiary = (beneficiary?: Beneficiary) => {
    setDialog({
      kind: 'beneficiary',
      draft: {
        beneficiaryId: beneficiary?.id ?? null,
        name: beneficiary?.name ?? '',
        relationship: beneficiary?.relationship ?? '',
        email: beneficiary?.email ?? '',
        allocations: Object.fromEntries(
          state.entities.map((entity) => [
            entity.id,
            beneficiary?.allocations.find((allocation) => allocation.entityId === entity.id)
              ?.percentage ?? 0,
          ]),
        ),
        consent: false,
      },
    });
  };

  const openCoverage = () => {
    setDialog({
      kind: 'coverage',
      draft: {
        lifeCover: state.policies[0]?.cover ?? 0,
        propertyCover: state.policies[1]?.cover ?? 0,
        ...state.needs,
        note: '',
        consent: false,
      },
    });
  };

  const handoffDraft = (): HandoffDraft => ({
    contact: { ...state.contact },
    intervalDays: state.schedule.intervalDays,
    graceDays: state.schedule.graceDays,
    scope: { ...state.handoff.scope },
    instructions: state.handoff.instructions,
    consent: false,
  });

  const submitBeneficiary = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== 'beneficiary') return;
    const draft = dialog.draft;
    const existing = state.beneficiaries.find(
      (beneficiary) => beneficiary.id === draft.beneficiaryId,
    );
    const otherBeneficiaries = state.beneficiaries.filter(
      (beneficiary) => beneficiary.id !== draft.beneficiaryId,
    );
    const overAllocated = state.entities.find(
      (entity) =>
        allocationTotal(otherBeneficiaries, entity.id) + (draft.allocations[entity.id] ?? 0) > 100,
    );
    if (!draft.name.trim() || !draft.relationship.trim() || !draft.email.includes('@')) {
      onToast?.('Add a name, relationship, and valid contact email.');
      return;
    }
    if (overAllocated) {
      onToast?.(`${overAllocated.name} would exceed a 100% allocation.`);
      return;
    }
    if (!draft.consent) {
      onToast?.('Confirm that you understand this creates a review proposal.');
      return;
    }
    const allocations = state.entities
      .map((entity) => ({
        entity,
        before:
          existing?.allocations.find((allocation) => allocation.entityId === entity.id)
            ?.percentage ?? 0,
        after: draft.allocations[entity.id] ?? 0,
      }))
      .filter((allocation) => allocation.before !== allocation.after);
    const diff: ContinuityProposal['diff'] = [
      ...(existing?.name !== draft.name.trim()
        ? [
            {
              label: 'Beneficiary',
              before: existing?.name ?? 'Not present',
              after: draft.name.trim(),
            },
          ]
        : []),
      ...(existing?.relationship !== draft.relationship.trim()
        ? [
            {
              label: 'Relationship',
              before: existing?.relationship ?? 'Not set',
              after: draft.relationship.trim(),
            },
          ]
        : []),
      ...(existing?.email !== draft.email.trim()
        ? [
            {
              label: 'Contact route',
              before: existing?.email ?? 'Not set',
              after: draft.email.trim(),
            },
          ]
        : []),
      ...allocations.map(({ entity, before, after }) => ({
        label: entity.name,
        before: `${before}%`,
        after: `${after}%`,
        tone: after > before ? ('warning' as const) : ('neutral' as const),
        detail: `${entityMeta[entity.kind].label} allocation`,
      })),
    ];
    if (!diff.length) {
      onToast?.('No changes to submit.');
      return;
    }
    submitChange(
      'beneficiary',
      existing ? `Update ${existing.name}’s allocation` : `Add ${draft.name.trim()} as beneficiary`,
      existing
        ? `Proposed distribution changes across ${allocations.length || 1} protected record${allocations.length === 1 ? '' : 's'}.`
        : `Proposed beneficiary for ${state.entities.filter((entity) => (draft.allocations[entity.id] ?? 0) > 0).length} protected records.`,
      diff,
      'high',
    );
  };

  const submitCoverage = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== 'coverage') return;
    const draft = dialog.draft;
    if (
      [
        draft.lifeCover,
        draft.propertyCover,
        draft.liabilities,
        draft.dependants,
        draft.goals,
        draft.immediateCosts,
      ].some((value) => value < 0)
    ) {
      onToast?.('Coverage and need amounts cannot be negative.');
      return;
    }
    if (!draft.consent) {
      onToast?.('Confirm that these assumptions are ready for review.');
      return;
    }
    const values: Array<[string, number, number]> = [
      ['Term life cover', state.policies[0]?.cover ?? 0, draft.lifeCover],
      ['Employer life cover', state.policies[1]?.cover ?? 0, draft.propertyCover],
      ['Liabilities', state.needs.liabilities, draft.liabilities],
      ['Dependants', state.needs.dependants, draft.dependants],
      ['Long-term goals', state.needs.goals, draft.goals],
      ['Immediate costs', state.needs.immediateCosts, draft.immediateCosts],
    ];
    const diff = values
      .filter(([, before, after]) => before !== after)
      .map(([label, before, after]) => ({
        label,
        before: formatMoney(before, currency),
        after: formatMoney(after, currency),
        tone: label.includes('cover')
          ? after >= before
            ? ('positive' as const)
            : ('warning' as const)
          : after > before
            ? ('warning' as const)
            : ('neutral' as const),
        detail: draft.note.trim() || undefined,
      }));
    if (!diff.length) {
      onToast?.('No coverage changes to submit.');
      return;
    }
    submitChange(
      'coverage',
      'Update protection assumptions',
      `${diff.length} coverage or household need assumptions will change after approval.`,
      diff,
      'medium',
    );
  };

  const submitContact = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== 'contact') return;
    const draft = dialog.draft;
    if (
      !draft.contact.name.trim() ||
      !draft.contact.relationship.trim() ||
      !draft.contact.email.includes('@')
    ) {
      onToast?.('Add a contact name, relationship, and valid email.');
      return;
    }
    if (!draft.consent) {
      onToast?.('Confirm that the contact and schedule are ready for review.');
      return;
    }
    const diff: ContinuityProposal['diff'] = [
      ...(state.contact.name !== draft.contact.name.trim()
        ? [
            {
              label: 'Emergency contact',
              before: state.contact.name,
              after: draft.contact.name.trim(),
            },
          ]
        : []),
      ...(state.contact.email !== draft.contact.email.trim()
        ? [
            {
              label: 'Contact email',
              before: state.contact.email,
              after: draft.contact.email.trim(),
            },
          ]
        : []),
      ...(state.contact.phone !== draft.contact.phone.trim()
        ? [
            {
              label: 'Contact phone',
              before: state.contact.phone,
              after: draft.contact.phone.trim(),
            },
          ]
        : []),
      ...(state.schedule.intervalDays !== draft.intervalDays
        ? [
            {
              label: 'Check-in interval',
              before: `Every ${state.schedule.intervalDays} days`,
              after: `Every ${draft.intervalDays} days`,
            },
          ]
        : []),
      ...(state.schedule.graceDays !== draft.graceDays
        ? [
            {
              label: 'Grace period',
              before: `${state.schedule.graceDays} days`,
              after: `${draft.graceDays} days`,
              tone: 'warning' as const,
            },
          ]
        : []),
    ];
    if (!diff.length) {
      onToast?.('No contact or schedule changes to submit.');
      return;
    }
    submitChange(
      'contact',
      'Update continuity contact and check-in schedule',
      'The proposed contact route and inactivity schedule will remain inactive until approval.',
      diff,
      'high',
    );
  };

  const submitPackage = (event: FormEvent) => {
    event.preventDefault();
    if (dialog?.kind !== 'package') return;
    const draft = dialog.draft;
    if (!Object.values(draft.scope).some(Boolean)) {
      onToast?.('Select at least one item for the handoff package.');
      return;
    }
    if (!draft.consent) {
      onToast?.('Confirm the handoff consent statement before submitting.');
      return;
    }
    const changedScopes = (Object.keys(draft.scope) as Array<keyof HandoffScope>).filter(
      (scope) => draft.scope[scope] !== state.handoff.scope[scope],
    );
    const diff: ContinuityProposal['diff'] = [
      ...changedScopes.map((scope) => ({
        label: scopeLabel(scope),
        before: state.handoff.scope[scope] ? 'Included' : 'Excluded',
        after: draft.scope[scope] ? 'Included' : 'Excluded',
        tone: draft.scope[scope] ? ('warning' as const) : ('neutral' as const),
      })),
      ...(draft.instructions.trim() !== state.handoff.instructions
        ? [
            {
              label: 'Personal instructions',
              before: state.handoff.instructions || 'None',
              after: draft.instructions.trim() || 'None',
              detail: 'Shown only after the release rules are satisfied.',
            },
          ]
        : []),
      {
        label: 'Release protection',
        before: state.handoff.status === 'approved' ? 'Approved package' : 'Draft package',
        after: 'Owner key + verified emergency contact + release review',
        tone: 'positive',
      },
    ];
    submitChange(
      'handoff',
      'Prepare encrypted continuity handoff',
      `${Object.values(draft.scope).filter(Boolean).length} approved information groups will be prepared for conditional release.`,
      diff,
      'high',
    );
  };

  const checkInNow = () => {
    const lastCheckIn = today;
    const nextCheckIn = addDays(today, state.schedule.intervalDays);
    const reference = makeReference('CHECK');
    const at = new Date().toISOString();
    setState((current) => ({
      ...current,
      schedule: { ...current.schedule, lastCheckIn, nextCheckIn },
      audit: [
        {
          id: uid('audit'),
          at,
          actor: 'You',
          action: 'Availability confirmed',
          detail: `The next check-in is due ${displayDate(nextCheckIn)}.`,
          reference,
          tone: 'positive',
        },
        ...current.audit,
      ],
    }));
    appendReceipt('check-in', 'Owner availability confirmed', reference, true);
    onToast?.(`Check-in recorded. Next due ${displayDate(nextCheckIn)}.`);
  };

  const exportManifest = () => {
    const reference = makeReference('MANIFEST');
    const manifest = {
      generatedAt: new Date().toISOString(),
      reference,
      portfolio: { id: portfolio.id, name: portfolio.name },
      note: 'Redacted continuity manifest. No passwords, account keys, or document contents.',
      readiness,
      protectedRecords: state.entities.map((entity) => ({
        type: entity.kind,
        name: entity.name,
        assignment: `${allocationTotal(state.beneficiaries, entity.id)}%`,
      })),
      documents: state.checklist.map((item) => ({
        requirement: item.title,
        state: item.state,
        linked: Boolean(item.fileName),
      })),
      handoff: {
        status: state.handoff.status,
        includedGroups: (Object.keys(state.handoff.scope) as Array<keyof HandoffScope>)
          .filter((scope) => state.handoff.scope[scope])
          .map(scopeLabel),
      },
    };
    try {
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${portfolio.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-continuity-manifest.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      const at = new Date().toISOString();
      setState((current) => ({
        ...current,
        audit: [
          {
            id: uid('audit'),
            at,
            actor: 'You',
            action: 'Redacted manifest exported',
            detail:
              'The export contains labels and readiness states, not secrets or file contents.',
            reference,
            tone: 'neutral',
          },
          ...current.audit,
        ],
      }));
      appendReceipt('manifest-exported', 'Redacted continuity manifest exported', reference, false);
      onToast?.('Redacted continuity manifest downloaded.');
    } catch {
      onToast?.('The browser could not create the demo manifest.');
    }
  };

  const simulateFlow = (stage?: string) => {
    onOpenWorkbench(
      [
        `Protection and continuity stress test for ${portfolio.name}.`,
        `Model owner unavailability after ${state.schedule.intervalDays} days plus a ${state.schedule.graceDays}-day grace period.`,
        `Current protection resources are ${formatMoney(totals.resources, currency)} against ${formatMoney(totals.needs, currency)} of recorded needs.`,
        stage
          ? `Focus on the “${stage}” step and show blocked, delayed, and successful outcomes.`
          : '',
        'Keep the live portfolio unchanged and return a comparison with actions that require review.',
      ]
        .filter(Boolean)
        .join(' '),
    );
  };

  const filteredBeneficiaries = state.beneficiaries.filter((beneficiary) =>
    `${beneficiary.name} ${beneficiary.relationship} ${beneficiary.email}`
      .toLowerCase()
      .includes(beneficiarySearch.trim().toLowerCase()),
  );

  const filteredAudit =
    auditFilter === 'all'
      ? state.audit
      : state.audit.filter((entry) =>
          auditFilter === 'proposals'
            ? entry.reference.startsWith('CONT-')
            : !entry.reference.startsWith('CONT-'),
        );

  return (
    <section className="origin-continuity" aria-labelledby="oct-title">
      <header className="oct-page-header">
        <h1 id="oct-title">Protection &amp; continuity</h1>
        <div className="oct-page-header__actions">
          <button
            className="oct-button oct-button--secondary"
            type="button"
            onClick={onOpenSecurity}
          >
            <Icon name="lock" size={13} />
            Security
          </button>
          <button
            className="oct-button oct-button--primary"
            type="button"
            onClick={() => setDialog({ kind: 'package', draft: handoffDraft() })}
          >
            <Icon name="key" size={13} />
            Prepare handoff
          </button>
        </div>
      </header>

      <div className="oct-summary" aria-label="Continuity summary">
        <div className="oct-summary__readiness">
          <span>Estate readiness</span>
          <strong>{readiness}%</strong>
          <small>
            {checklistAttention ? `${checklistAttention} evidence gaps` : 'Evidence current'}
          </small>
        </div>
        <div>
          <span>Recorded protection</span>
          <strong>{compactMoney(totals.resources, currency, privateMode)}</strong>
          <small>{Math.round(totals.coverageRatio)}% of recorded need</small>
        </div>
        <div className={cx(totals.gap < 0 && 'is-warning')}>
          <span>Protection gap</span>
          <strong>{compactMoney(Math.abs(totals.gap), currency, privateMode)}</strong>
          <small>{totals.gap >= 0 ? 'Surplus recorded' : 'Needs attention'}</small>
        </div>
        <div>
          <span>Next check-in</span>
          <strong>{displayDate(state.schedule.nextCheckIn)}</strong>
          <small>
            Every {state.schedule.intervalDays} days · {state.schedule.graceDays}-day grace
          </small>
        </div>
        <button type="button" onClick={onOpenReview} className="oct-summary__review">
          <span>Waiting in Review</span>
          <strong>{pendingCount}</strong>
          <small>
            {pendingCount ? 'Current plan unchanged' : 'No pending changes'}
            <Icon name="arrow-right" size={11} />
          </small>
        </button>
      </div>

      <div className="oct-workspace">
        <aside className="oct-nav" aria-label="Protection and continuity sections">
          <div className="oct-nav__heading">
            <span>Workspace</span>
            <strong>{selectedView.label}</strong>
          </div>
          <nav role="tablist" aria-label="Continuity views">
            {viewMeta.map((item) => (
              <button
                className={cx(view === item.id && 'is-active')}
                key={item.id}
                type="button"
                role="tab"
                aria-selected={view === item.id}
                onClick={() => setView(item.id)}
              >
                <span className="oct-nav__icon">
                  <Icon name={item.icon} size={13} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>
                    {item.id === 'beneficiaries'
                      ? `${state.beneficiaries.length} people`
                      : item.id === 'coverage'
                        ? `${Math.round(totals.coverageRatio)}% covered`
                        : item.id === 'handoff'
                          ? state.handoff.status.replace('-', ' ')
                          : item.id === 'audit'
                            ? `${state.audit.length} events`
                            : `${readiness}% ready`}
                  </small>
                </span>
                {item.id === 'audit' && pendingCount ? <em>{pendingCount}</em> : null}
                <Icon name="chevron-right" size={11} />
              </button>
            ))}
          </nav>
          <div className="oct-nav__boundary">
            <span>
              <Icon name="shield" size={12} />
              Protected boundary
            </span>
            <p>
              Contacts receive no portfolio access. Approved release rules govern only the encrypted
              handoff.
            </p>
            <button type="button" onClick={onOpenSecurity}>
              Review security settings
              <Icon name="arrow-right" size={10} />
            </button>
          </div>
        </aside>

        <main className="oct-main" role="tabpanel" aria-label={selectedView.label}>
          {view === 'overview' ? (
            <div className="oct-view oct-overview">
              <SectionHeading
                eyebrow="Readiness map"
                title="One plan around the portfolio"
                description="A clear view of what is ready, what is incomplete, and what would happen if the owner could not act."
                action={
                  <button
                    className="oct-button oct-button--secondary"
                    type="button"
                    onClick={() => simulateFlow()}
                  >
                    <Icon name="workbench" size={12} />
                    Stress-test
                  </button>
                }
              />

              <section className="oct-readiness-map" aria-label="Estate readiness score">
                <div
                  className="oct-readiness-ring"
                  style={{ '--oct-score': readiness } as CSSProperties}
                >
                  <strong>{readiness}</strong>
                  <span>of 100</span>
                </div>
                <div className="oct-readiness-copy">
                  <span className="oct-status-label is-attention">Action recommended</span>
                  <h3>Your instructions are usable, but not yet complete.</h3>
                  <p>
                    The missing power of attorney is the largest evidence gap. Recorded protection
                    is also {formatMoney(Math.abs(Math.min(0, totals.gap)), currency, privateMode)}{' '}
                    below the household need model.
                  </p>
                </div>
                <div className="oct-readiness-actions">
                  <button type="button" onClick={onOpenFiles}>
                    <span>
                      <Icon name="document" size={13} />
                    </span>
                    <span>
                      <strong>Complete evidence</strong>
                      <small>{checklistAttention} items need attention</small>
                    </span>
                    <Icon name="arrow-right" size={11} />
                  </button>
                  <button type="button" onClick={() => setView('coverage')}>
                    <span>
                      <Icon name="shield" size={13} />
                    </span>
                    <span>
                      <strong>Review protection gap</strong>
                      <small>
                        {compactMoney(Math.abs(totals.gap), currency, privateMode)} to inspect
                      </small>
                    </span>
                    <Icon name="arrow-right" size={11} />
                  </button>
                </div>
              </section>

              <section className="oct-section">
                <SectionHeading
                  title="If the owner is unavailable"
                  description="This is the approved path. Missing a check-in starts verification; it never releases data by itself."
                />
                <div className="oct-flow">
                  {[
                    {
                      icon: 'user-plus' as const,
                      number: '01',
                      title: 'Owner active',
                      detail: `Check in every ${state.schedule.intervalDays} days`,
                      state: 'current',
                    },
                    {
                      icon: 'clock' as const,
                      number: '02',
                      title: 'Grace period',
                      detail: `${state.schedule.graceDays} days and two reminders`,
                      state: 'guarded',
                    },
                    {
                      icon: 'people' as const,
                      number: '03',
                      title: 'Contact verifies',
                      detail: 'Identity and circumstance checked',
                      state: 'guarded',
                    },
                    {
                      icon: 'inbox' as const,
                      number: '04',
                      title: 'Release reviewed',
                      detail: 'Scope and authority confirmed',
                      state: 'review',
                    },
                    {
                      icon: 'key' as const,
                      number: '05',
                      title: 'Package opens',
                      detail: 'Approved information only',
                      state: 'locked',
                    },
                  ].map((step, index, list) => (
                    <div className="oct-flow__segment" key={step.number}>
                      <button
                        className={cx('oct-flow__step', `is-${step.state}`)}
                        type="button"
                        onClick={() => simulateFlow(step.title)}
                      >
                        <span className="oct-flow__number">{step.number}</span>
                        <span className="oct-flow__icon">
                          <Icon name={step.icon} size={15} />
                        </span>
                        <strong>{step.title}</strong>
                        <small>{step.detail}</small>
                      </button>
                      {index < list.length - 1 ? (
                        <span className="oct-flow__connector" aria-hidden="true">
                          <Icon name="arrow-right" size={12} />
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
                <footer className="oct-flow__foot">
                  <span>
                    <Icon name="lock" size={11} />
                    No passwords, trading rights, or automatic ownership transfer
                  </span>
                  <button type="button" onClick={() => simulateFlow()}>
                    Compare outcomes in Workbench
                    <Icon name="arrow-right" size={10} />
                  </button>
                </footer>
              </section>

              <div className="oct-overview-grid">
                <section className="oct-section oct-checklist-preview">
                  <SectionHeading
                    eyebrow="Linked evidence"
                    title="Estate readiness"
                    description="Documents remain in Files and are referenced here."
                    action={
                      <button className="oct-text-button" type="button" onClick={onOpenFiles}>
                        Open Files
                        <Icon name="arrow-right" size={10} />
                      </button>
                    }
                  />
                  <div className="oct-checklist">
                    {state.checklist.slice(0, 4).map((item) => (
                      <button type="button" key={item.id} onClick={onOpenFiles}>
                        <StatusMark state={item.state} />
                        <span>
                          <strong>{item.title}</strong>
                          <small>{item.fileName ?? item.detail}</small>
                        </span>
                        <span>
                          {item.state === 'ready' ? displayDate(item.updatedAt) : 'Resolve'}
                        </span>
                        <Icon name="chevron-right" size={11} />
                      </button>
                    ))}
                  </div>
                </section>

                <section className="oct-section oct-owner-card">
                  <SectionHeading
                    eyebrow="Current rules"
                    title="Contact & check-in"
                    description="Who is contacted, and only after which delay."
                    action={
                      <button
                        className="oct-text-button"
                        type="button"
                        onClick={() => setDialog({ kind: 'contact', draft: handoffDraft() })}
                      >
                        Propose change
                        <Icon name="arrow-right" size={10} />
                      </button>
                    }
                  />
                  <div className="oct-contact-identity">
                    <span>
                      {state.contact.name
                        .split(' ')
                        .map((part) => part[0])
                        .join('')
                        .slice(0, 2)}
                    </span>
                    <div>
                      <strong>{state.contact.name}</strong>
                      <small>{state.contact.relationship}</small>
                    </div>
                    <em className={cx(state.contact.verified && 'is-verified')}>
                      <Icon name={state.contact.verified ? 'check' : 'clock'} size={9} />
                      {state.contact.verified ? 'Verified' : 'Review due'}
                    </em>
                  </div>
                  <dl className="oct-definition-list">
                    <div>
                      <dt>Email</dt>
                      <dd>{maskEmail(state.contact.email, privateMode)}</dd>
                    </div>
                    <div>
                      <dt>Phone</dt>
                      <dd>{maskPhone(state.contact.phone, privateMode)}</dd>
                    </div>
                    <div>
                      <dt>Last check-in</dt>
                      <dd>{displayDate(state.schedule.lastCheckIn)}</dd>
                    </div>
                    <div>
                      <dt>Release review</dt>
                      <dd>Always required</dd>
                    </div>
                  </dl>
                  <button
                    className="oct-button oct-button--secondary oct-button--wide"
                    type="button"
                    onClick={checkInNow}
                  >
                    <Icon name="check" size={12} />
                    Check in now
                  </button>
                </section>
              </div>
            </div>
          ) : null}

          {view === 'beneficiaries' ? (
            <div className="oct-view">
              <SectionHeading
                eyebrow="Portfolio assignments"
                title="Beneficiaries"
                description="Assign people directly to accounts, holdings, insurance policies, and nested portfolios. A review decision is required before any change becomes active."
                action={
                  <button
                    className="oct-button oct-button--primary"
                    type="button"
                    onClick={() => openBeneficiary()}
                  >
                    <Icon name="user-plus" size={12} />
                    Add beneficiary
                  </button>
                }
              />

              <div className="oct-assignment-summary">
                <div>
                  <span>Protected records</span>
                  <strong>{state.entities.length}</strong>
                  <small>Across four record types</small>
                </div>
                <div>
                  <span>Fully assigned</span>
                  <strong>
                    {entityCoverage.filter((entity) => entity.allocated === 100).length}/
                    {state.entities.length}
                  </strong>
                  <small>Exactly 100% assigned</small>
                </div>
                <div>
                  <span>Verified people</span>
                  <strong>
                    {state.beneficiaries.filter((beneficiary) => beneficiary.verified).length}/
                    {state.beneficiaries.length}
                  </strong>
                  <small>Contact identity checked</small>
                </div>
              </div>

              <section className="oct-section oct-beneficiary-section">
                <div className="oct-toolbar">
                  <label className="oct-search">
                    <Icon name="search" size={12} />
                    <span className="oct-sr-only">Search beneficiaries</span>
                    <input
                      type="search"
                      value={beneficiarySearch}
                      onChange={(event) => setBeneficiarySearch(event.target.value)}
                      placeholder="Search people or relationship"
                    />
                  </label>
                  <span>{filteredBeneficiaries.length} people</span>
                </div>

                <div className="oct-beneficiary-list">
                  {filteredBeneficiaries.map((beneficiary) => {
                    const initials = beneficiary.name
                      .split(' ')
                      .map((part) => part[0])
                      .join('')
                      .slice(0, 2);
                    const totalRecords = beneficiary.allocations.filter(
                      (allocation) => allocation.percentage > 0,
                    ).length;
                    return (
                      <article className="oct-beneficiary-row" key={beneficiary.id}>
                        <div className="oct-person">
                          <span>{initials}</span>
                          <div>
                            <strong>{beneficiary.name}</strong>
                            <small>
                              {beneficiary.relationship} ·{' '}
                              {maskEmail(beneficiary.email, privateMode)}
                            </small>
                          </div>
                        </div>
                        <div className="oct-beneficiary-row__status">
                          <span
                            className={cx(
                              'oct-status-label',
                              beneficiary.verified ? 'is-ready' : 'is-attention',
                            )}
                          >
                            <Icon name={beneficiary.verified ? 'check' : 'clock'} size={9} />
                            {beneficiary.verified ? 'Verified' : 'Verify contact'}
                          </span>
                          <small>Reviewed {displayDate(beneficiary.updatedAt)}</small>
                        </div>
                        <div className="oct-allocation-tags">
                          {beneficiary.allocations
                            .filter((allocation) => allocation.percentage > 0)
                            .map((allocation) => {
                              const entity = state.entities.find(
                                (item) => item.id === allocation.entityId,
                              );
                              if (!entity) return null;
                              return (
                                <span key={allocation.entityId}>
                                  <Icon name={entityMeta[entity.kind].icon} size={10} />
                                  {entity.name}
                                  <strong>{allocation.percentage}%</strong>
                                </span>
                              );
                            })}
                        </div>
                        <div className="oct-beneficiary-row__actions">
                          <small>{totalRecords} linked records</small>
                          <button type="button" onClick={() => openBeneficiary(beneficiary)}>
                            Propose edit
                            <Icon name="chevron-right" size={11} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  {!filteredBeneficiaries.length ? (
                    <div className="oct-empty">
                      <Icon name="people" size={20} />
                      <strong>No matching beneficiaries</strong>
                      <p>Try a different name, relationship, or email.</p>
                    </div>
                  ) : null}
                </div>
              </section>

              <section className="oct-section">
                <SectionHeading
                  eyebrow="Distribution control"
                  title="Assignment by record"
                  description="Each row should total exactly 100%. Values are read from the live portfolio; assignments are part of the continuity plan."
                />
                <div className="oct-entity-ledger">
                  <div className="oct-entity-ledger__head">
                    <span>Protected record</span>
                    <span>Current value</span>
                    <span>Distribution</span>
                    <span>State</span>
                  </div>
                  {entityCoverage.map((entity) => (
                    <div className="oct-entity-row" key={entity.id}>
                      <span className="oct-entity-icon">
                        <Icon name={entityMeta[entity.kind].icon} size={13} />
                      </span>
                      <div>
                        <strong>{entity.name}</strong>
                        <small>
                          {entityMeta[entity.kind].label} · {entity.detail}
                        </small>
                      </div>
                      <span>{formatMoney(entity.value, currency, privateMode)}</span>
                      <div className="oct-entity-distribution">
                        <div>
                          {state.beneficiaries.map((beneficiary) => {
                            const percentage =
                              beneficiary.allocations.find(
                                (allocation) => allocation.entityId === entity.id,
                              )?.percentage ?? 0;
                            return percentage ? (
                              <span
                                key={beneficiary.id}
                                style={{ '--oct-share': percentage } as CSSProperties}
                                title={`${beneficiary.name}: ${percentage}%`}
                              />
                            ) : null;
                          })}
                          {entity.allocated < 100 ? (
                            <span
                              className="is-unassigned"
                              style={{ '--oct-share': 100 - entity.allocated } as CSSProperties}
                              title={`${100 - entity.allocated}% unassigned`}
                            />
                          ) : null}
                        </div>
                        <small>
                          {state.beneficiaries
                            .map((beneficiary) => {
                              const share =
                                beneficiary.allocations.find(
                                  (allocation) => allocation.entityId === entity.id,
                                )?.percentage ?? 0;
                              return share ? `${beneficiary.name.split(' ')[0]} ${share}%` : '';
                            })
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </div>
                      <span
                        className={cx(
                          'oct-allocation-state',
                          entity.allocated === 100 ? 'is-ready' : 'is-attention',
                        )}
                      >
                        {entity.allocated === 100 ? 'Complete' : `${100 - entity.allocated}% open`}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {view === 'coverage' ? (
            <div className="oct-view">
              <SectionHeading
                eyebrow="Household model"
                title="Insurance & protection gap"
                description="Compare recorded cover and accessible cash with liabilities, dependant support, goals, and immediate costs. This is planning context, not insurance advice."
                action={
                  <button
                    className="oct-button oct-button--primary"
                    type="button"
                    onClick={openCoverage}
                  >
                    <Icon name="sliders" size={12} />
                    Propose assumptions
                  </button>
                }
              />

              <section className="oct-coverage-hero">
                <div className="oct-coverage-hero__copy">
                  <span
                    className={cx(
                      'oct-status-label',
                      totals.gap >= 0 ? 'is-ready' : 'is-attention',
                    )}
                  >
                    <Icon name={totals.gap >= 0 ? 'check' : 'activity'} size={9} />
                    {totals.gap >= 0 ? 'Recorded resources cover the model' : 'Protection gap'}
                  </span>
                  <strong>{formatMoney(Math.abs(totals.gap), currency, privateMode)}</strong>
                  <p>
                    {totals.gap >= 0
                      ? 'Recorded insurance and accessible cash exceed the current household need model.'
                      : 'Additional protection, lower liabilities, or a different household plan would close the recorded gap.'}
                  </p>
                  <button
                    className="oct-text-button"
                    type="button"
                    onClick={() => simulateFlow('Protection gap')}
                  >
                    Model alternatives in Workbench
                    <Icon name="arrow-right" size={10} />
                  </button>
                </div>
                <div className="oct-coverage-scale" aria-label="Protection compared with needs">
                  <div>
                    <span>
                      <strong>Available protection</strong>
                      <em>{formatMoney(totals.resources, currency, privateMode)}</em>
                    </span>
                    <div className="oct-coverage-bar">
                      <span style={{ width: `${Math.min(100, totals.coverageRatio)}%` }}>
                        {Math.round(totals.coverageRatio)}%
                      </span>
                    </div>
                  </div>
                  <div>
                    <span>
                      <strong>Recorded household need</strong>
                      <em>{formatMoney(totals.needs, currency, privateMode)}</em>
                    </span>
                    <div className="oct-coverage-bar is-need">
                      <span style={{ width: '100%' }}>100%</span>
                    </div>
                  </div>
                  <small>
                    Cash availability is included for planning. It is not reserved or moved by this
                    plan.
                  </small>
                </div>
              </section>

              <div className="oct-coverage-grid">
                <section className="oct-section">
                  <SectionHeading
                    eyebrow="Resources"
                    title="Recorded policies"
                    description="Current cover imported or entered against this portfolio."
                  />
                  <div className="oct-policy-list">
                    {state.policies.map((policy) => (
                      <article key={policy.id}>
                        <span className="oct-policy-icon">
                          <Icon name="shield" size={14} />
                        </span>
                        <div>
                          <strong>{policy.name}</strong>
                          <small>
                            {policy.provider} · renews {displayDate(policy.renews)}
                          </small>
                        </div>
                        <div>
                          <strong>{formatMoney(policy.cover, currency, privateMode)}</strong>
                          <small>
                            {policy.annualPremium
                              ? `${formatMoney(policy.annualPremium, currency, privateMode)} / year`
                              : 'Employer funded'}
                          </small>
                        </div>
                        <span
                          className={cx(
                            'oct-status-label',
                            policy.status === 'active' ? 'is-ready' : 'is-attention',
                          )}
                        >
                          {policy.status === 'active' ? 'Active' : 'Review due'}
                        </span>
                      </article>
                    ))}
                    <article className="oct-policy-list__cash">
                      <span className="oct-policy-icon">
                        <Icon name="cash" size={14} />
                      </span>
                      <div>
                        <strong>Accessible cash</strong>
                        <small>Operating cash · not reserved</small>
                      </div>
                      <div>
                        <strong>{formatMoney(totals.liquidAssets, currency, privateMode)}</strong>
                        <small>Portfolio record</small>
                      </div>
                      <span className="oct-status-label">Planning input</span>
                    </article>
                  </div>
                </section>

                <section className="oct-section">
                  <SectionHeading
                    eyebrow="Needs"
                    title="What the plan protects"
                    description="Editable household assumptions with a visible source."
                  />
                  <div className="oct-needs-list">
                    {[
                      {
                        label: 'Liabilities',
                        value: state.needs.liabilities,
                        detail: 'Mortgage and other recorded debt',
                        icon: 'house' as const,
                      },
                      {
                        label: 'Dependants',
                        value: state.needs.dependants,
                        detail: 'Income support and care',
                        icon: 'people' as const,
                      },
                      {
                        label: 'Long-term goals',
                        value: state.needs.goals,
                        detail: 'Education and family milestones',
                        icon: 'target' as const,
                      },
                      {
                        label: 'Immediate costs',
                        value: state.needs.immediateCosts,
                        detail: 'Twelve-month transition reserve',
                        icon: 'calendar' as const,
                      },
                    ].map((need) => (
                      <div key={need.label}>
                        <span>
                          <Icon name={need.icon} size={12} />
                        </span>
                        <div>
                          <strong>{need.label}</strong>
                          <small>{need.detail}</small>
                        </div>
                        <strong>{formatMoney(need.value, currency, privateMode)}</strong>
                        <div className="oct-need-bar">
                          <span style={{ width: `${(need.value / totals.needs) * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <section className="oct-section oct-scenario-prompt">
                <span>
                  <Icon name="workbench" size={17} />
                </span>
                <div>
                  <strong>Test the plan without touching the portfolio</strong>
                  <p>
                    Compare cover changes, debt repayment, accessible cash, and dependant time
                    horizons as a Workbench branch.
                  </p>
                </div>
                <button
                  className="oct-button oct-button--secondary"
                  type="button"
                  onClick={() => simulateFlow('Protection alternatives')}
                >
                  Open Workbench
                  <Icon name="arrow-right" size={11} />
                </button>
              </section>
            </div>
          ) : null}

          {view === 'handoff' ? (
            <div className="oct-view">
              <SectionHeading
                eyebrow="Conditional access"
                title="Owner-unavailable handoff"
                description="Prepare a small encrypted package that can be released only after the check-in, identity, authority, and review conditions are satisfied."
                action={
                  <button
                    className="oct-button oct-button--primary"
                    type="button"
                    onClick={() => setDialog({ kind: 'package', draft: handoffDraft() })}
                  >
                    <Icon name="key" size={12} />
                    Prepare package
                  </button>
                }
              />

              <div className="oct-handoff-grid">
                <section className="oct-section oct-handoff-package">
                  <div className="oct-package-head">
                    <span className="oct-package-lock">
                      <Icon name="lock" size={18} />
                    </span>
                    <div>
                      <span>Encrypted handoff package</span>
                      <h3>{portfolio.name}</h3>
                      <p>{state.handoff.encryption}</p>
                    </div>
                    <em
                      className={cx(
                        'oct-status-label',
                        state.handoff.status === 'approved' ? 'is-ready' : 'is-attention',
                      )}
                    >
                      {state.handoff.status.replace('-', ' ')}
                    </em>
                  </div>
                  <div className="oct-package-preview">
                    <header>
                      <span>Included after approved release</span>
                      <small>Contents stay encrypted until then</small>
                    </header>
                    {(Object.keys(state.handoff.scope) as Array<keyof HandoffScope>).map(
                      (scope) => (
                        <div
                          className={cx(!state.handoff.scope[scope] && 'is-excluded')}
                          key={scope}
                        >
                          <span>
                            <Icon name={state.handoff.scope[scope] ? 'check' : 'minus'} size={10} />
                          </span>
                          <strong>{scopeLabel(scope)}</strong>
                          <small>{state.handoff.scope[scope] ? 'Included' : 'Not included'}</small>
                        </div>
                      ),
                    )}
                  </div>
                  <div className="oct-package-protections">
                    <div>
                      <Icon name="lock" size={12} />
                      <span>
                        <strong>No credentials</strong>
                        <small>Passwords and recovery keys are never included</small>
                      </span>
                    </div>
                    <div>
                      <Icon name="eye" size={12} />
                      <span>
                        <strong>Minimum disclosure</strong>
                        <small>Only the approved information groups open</small>
                      </span>
                    </div>
                    <div>
                      <Icon name="list" size={12} />
                      <span>
                        <strong>Receipt required</strong>
                        <small>Verification and release are written to the audit ledger</small>
                      </span>
                    </div>
                  </div>
                  <footer>
                    <span>
                      Last prepared{' '}
                      {state.handoff.lastPreparedAt
                        ? displayDateTime(state.handoff.lastPreparedAt)
                        : 'never'}
                    </span>
                    <button type="button" onClick={exportManifest}>
                      <Icon name="download" size={10} />
                      Download redacted manifest
                    </button>
                  </footer>
                </section>

                <div className="oct-handoff-side">
                  <section className="oct-section">
                    <SectionHeading
                      eyebrow="First contact"
                      title="Emergency contact"
                      description="This person can start verification, not open the portfolio."
                      action={
                        <button
                          className="oct-text-button"
                          type="button"
                          onClick={() => setDialog({ kind: 'contact', draft: handoffDraft() })}
                        >
                          Propose edit
                        </button>
                      }
                    />
                    <div className="oct-contact-large">
                      <span>
                        {state.contact.name
                          .split(' ')
                          .map((part) => part[0])
                          .join('')
                          .slice(0, 2)}
                      </span>
                      <div>
                        <strong>{state.contact.name}</strong>
                        <small>{state.contact.relationship}</small>
                        <em>
                          <Icon name={state.contact.verified ? 'check' : 'clock'} size={9} />
                          {state.contact.verified ? 'Identity verified' : 'Verification due'}
                        </em>
                      </div>
                    </div>
                    <dl className="oct-definition-list">
                      <div>
                        <dt>Email</dt>
                        <dd>{maskEmail(state.contact.email, privateMode)}</dd>
                      </div>
                      <div>
                        <dt>Phone</dt>
                        <dd>{maskPhone(state.contact.phone, privateMode)}</dd>
                      </div>
                      <div>
                        <dt>Portfolio access</dt>
                        <dd>None</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="oct-section">
                    <SectionHeading
                      eyebrow="Availability"
                      title="Check-in schedule"
                      description="A missed date starts reminders, then a grace period."
                    />
                    <div className="oct-schedule">
                      <div>
                        <span>Last confirmed</span>
                        <strong>{displayDate(state.schedule.lastCheckIn)}</strong>
                      </div>
                      <span className="oct-schedule__line" />
                      <div>
                        <span>Next due</span>
                        <strong>{displayDate(state.schedule.nextCheckIn)}</strong>
                      </div>
                      <span className="oct-schedule__line is-dashed" />
                      <div>
                        <span>Verification may start</span>
                        <strong>
                          {displayDate(
                            addDays(state.schedule.nextCheckIn, state.schedule.graceDays),
                          )}
                        </strong>
                      </div>
                    </div>
                    <button
                      className="oct-button oct-button--secondary oct-button--wide"
                      type="button"
                      onClick={checkInNow}
                    >
                      <Icon name="check" size={12} />
                      Check in now
                    </button>
                  </section>
                </div>
              </div>

              <section className="oct-section oct-release-rules">
                <SectionHeading
                  eyebrow="Release policy"
                  title="Every condition must pass"
                  description="No single person or missed reminder can release the handoff."
                />
                <div>
                  {[
                    {
                      title: 'Check-in and grace period elapsed',
                      detail: `${state.schedule.intervalDays} days + ${state.schedule.graceDays}-day grace`,
                      icon: 'clock' as const,
                    },
                    {
                      title: 'Emergency contact verified',
                      detail: 'Identity and registered contact route',
                      icon: 'people' as const,
                    },
                    {
                      title: 'Authority evidence reviewed',
                      detail: 'Executor, attorney, or equivalent evidence',
                      icon: 'document' as const,
                    },
                    {
                      title: 'Release decision recorded',
                      detail: 'Scope, actor, and time receive a receipt',
                      icon: 'list' as const,
                    },
                  ].map((rule, index) => (
                    <article key={rule.title}>
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <span>
                        <Icon name={rule.icon} size={13} />
                      </span>
                      <div>
                        <strong>{rule.title}</strong>
                        <small>{rule.detail}</small>
                      </div>
                      <Icon name="check" size={11} />
                    </article>
                  ))}
                </div>
              </section>

              <section className="oct-section oct-files-readiness">
                <SectionHeading
                  eyebrow="Evidence"
                  title="Estate-readiness checklist"
                  description="Open the linked document or resolve a missing requirement in Files."
                  action={
                    <button
                      className="oct-button oct-button--secondary"
                      type="button"
                      onClick={onOpenFiles}
                    >
                      <Icon name="folder" size={12} />
                      Open Files
                    </button>
                  }
                />
                <div className="oct-readiness-ledger">
                  <div className="oct-readiness-ledger__head">
                    <span>Requirement</span>
                    <span>Linked evidence</span>
                    <span>Last checked</span>
                    <span>State</span>
                  </div>
                  {state.checklist.map((item) => (
                    <button type="button" key={item.id} onClick={onOpenFiles}>
                      <StatusMark state={item.state} />
                      <div>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </div>
                      <span>
                        <Icon name={item.fileName ? 'document' : 'plus'} size={10} />
                        {item.fileName ?? 'Attach evidence'}
                      </span>
                      <span>{item.updatedAt ? displayDate(item.updatedAt) : '—'}</span>
                      <span className={cx('oct-status-label', `is-${item.state}`)}>
                        {item.state === 'ready'
                          ? 'Ready'
                          : item.state === 'attention'
                            ? 'Review'
                            : 'Missing'}
                      </span>
                      <Icon name="chevron-right" size={10} />
                    </button>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {view === 'audit' ? (
            <div className="oct-view">
              <SectionHeading
                eyebrow="Change control"
                title="Audit & receipts"
                description="A persistent record of proposals, owner check-ins, evidence links, and exports. Sensitive values are excluded from receipt summaries."
                action={
                  <button
                    className="oct-button oct-button--secondary"
                    type="button"
                    onClick={onOpenReview}
                  >
                    <Icon name="inbox" size={12} />
                    Open Review
                    {pendingCount ? <em>{pendingCount}</em> : null}
                  </button>
                }
              />

              <div className="oct-audit-summary">
                <div>
                  <span>Pending proposals</span>
                  <strong>{pendingCount}</strong>
                  <small>Awaiting explicit decision</small>
                </div>
                <div>
                  <span>Receipts retained</span>
                  <strong>{state.receipts.length}</strong>
                  <small>Portfolio-scoped history</small>
                </div>
                <div>
                  <span>Last owner action</span>
                  <strong>{displayDateTime(state.audit[0]?.at ?? '')}</strong>
                  <small>{state.audit[0]?.action ?? 'No activity'}</small>
                </div>
              </div>

              {state.proposals.length ? (
                <section className="oct-section oct-pending-proposals">
                  <SectionHeading
                    eyebrow="Waiting in Review"
                    title="The active plan is unchanged"
                    description="These proposals are staged, auditable, and reversible until an approval decision."
                  />
                  <div>
                    {state.proposals.slice(0, 5).map((proposal) => (
                      <article key={proposal.id}>
                        <span className="oct-proposal-icon">
                          <Icon
                            name={
                              proposal.type === 'beneficiary'
                                ? 'people'
                                : proposal.type === 'coverage'
                                  ? 'shield'
                                  : proposal.type === 'contact'
                                    ? 'bell'
                                    : 'key'
                            }
                            size={13}
                          />
                        </span>
                        <div>
                          <span>{proposalLabel(proposal.type)}</span>
                          <strong>{proposal.title}</strong>
                          <small>{proposal.summary}</small>
                        </div>
                        <div>
                          <span className="oct-status-label is-attention">Pending</span>
                          <small>{displayDateTime(proposal.createdAt)}</small>
                        </div>
                        <button type="button" onClick={onOpenReview}>
                          Review
                          <Icon name="arrow-right" size={10} />
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="oct-section oct-audit-section">
                <div className="oct-audit-toolbar">
                  <div>
                    {(['all', 'proposals', 'activity'] as const).map((filter) => (
                      <button
                        className={cx(auditFilter === filter && 'is-active')}
                        type="button"
                        key={filter}
                        onClick={() => setAuditFilter(filter)}
                      >
                        {filter === 'all'
                          ? 'All events'
                          : filter === 'proposals'
                            ? 'Proposals'
                            : 'Owner & system'}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={exportManifest}>
                    <Icon name="download" size={10} />
                    Export manifest
                  </button>
                </div>
                <div className="oct-audit-ledger">
                  <div className="oct-audit-ledger__head">
                    <span>Time</span>
                    <span>Event</span>
                    <span>Actor</span>
                    <span>Receipt</span>
                  </div>
                  {filteredAudit.map((entry) => (
                    <article key={entry.id}>
                      <span>{displayDateTime(entry.at)}</span>
                      <span className={cx('oct-audit-dot', `is-${entry.tone}`)} />
                      <div>
                        <strong>{entry.action}</strong>
                        <small>{entry.detail}</small>
                      </div>
                      <span>{entry.actor}</span>
                      <button
                        type="button"
                        onClick={() => {
                          const matching = state.receipts.find(
                            (item) => item.reference === entry.reference,
                          );
                          if (matching) setReceipt(matching);
                          else
                            onToast?.(
                              `Receipt reference ${entry.reference} copied from the audit record.`,
                            );
                        }}
                      >
                        {entry.reference}
                        <Icon name="chevron-right" size={9} />
                      </button>
                    </article>
                  ))}
                </div>
                <footer className="oct-audit-foot">
                  <span>
                    <Icon name="lock" size={10} />
                    Stored with {portfolio.name}; package secrets are never written to this ledger.
                  </span>
                  <button type="button" onClick={onOpenSecurity}>
                    Security boundary
                    <Icon name="arrow-right" size={9} />
                  </button>
                </footer>
              </section>
            </div>
          ) : null}
        </main>
      </div>

      {dialog?.kind === 'beneficiary' ? (
        <div className="oct-overlay" role="presentation" onMouseDown={() => setDialog(null)}>
          <form
            className="oct-dialog oct-dialog--wide"
            ref={changeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="oct-beneficiary-dialog-title"
            onSubmit={submitBeneficiary}
            onMouseDown={(event) => event.stopPropagation()}
            tabIndex={-1}
          >
            <header className="oct-dialog__header">
              <div>
                <span>Review-gated change</span>
                <h2 id="oct-beneficiary-dialog-title">
                  {dialog.draft.beneficiaryId ? 'Edit beneficiary' : 'Add beneficiary'}
                </h2>
                <p>
                  Prepare allocations across portfolio records. The active plan changes only after
                  approval.
                </p>
              </div>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close dialog">
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="oct-dialog__body">
              <div className="oct-form-grid">
                <label>
                  <span>Full name</span>
                  <input
                    value={dialog.draft.name}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: { ...dialog.draft, name: event.target.value },
                      })
                    }
                    placeholder="Beneficiary name"
                    autoFocus
                  />
                </label>
                <label>
                  <span>Relationship</span>
                  <input
                    value={dialog.draft.relationship}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: { ...dialog.draft, relationship: event.target.value },
                      })
                    }
                    placeholder="Spouse, child, trust…"
                  />
                </label>
                <label className="is-wide">
                  <span>Contact email</span>
                  <input
                    type="email"
                    value={dialog.draft.email}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: { ...dialog.draft, email: event.target.value },
                      })
                    }
                    placeholder="name@example.com"
                  />
                  <small>Used for verification only. This does not grant portfolio access.</small>
                </label>
              </div>

              <section className="oct-allocation-editor">
                <header>
                  <div>
                    <span>Proposed allocation</span>
                    <strong>Assign protected records</strong>
                  </div>
                  <small>Each record can total at most 100% across all people</small>
                </header>
                <div className="oct-allocation-editor__head">
                  <span>Record</span>
                  <span>Others</span>
                  <span>This person</span>
                  <span>Result</span>
                </div>
                {state.entities.map((entity) => {
                  const others = allocationTotal(
                    state.beneficiaries.filter(
                      (beneficiary) => beneficiary.id !== dialog.draft.beneficiaryId,
                    ),
                    entity.id,
                  );
                  const value = dialog.draft.allocations[entity.id] ?? 0;
                  const total = others + value;
                  return (
                    <div className="oct-allocation-editor__row" key={entity.id}>
                      <span className="oct-entity-icon">
                        <Icon name={entityMeta[entity.kind].icon} size={12} />
                      </span>
                      <div>
                        <strong>{entity.name}</strong>
                        <small>{entityMeta[entity.kind].label}</small>
                      </div>
                      <span>{others}%</span>
                      <label>
                        <span className="oct-sr-only">{entity.name} allocation</span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={value}
                          onChange={(event) =>
                            setDialog({
                              ...dialog,
                              draft: {
                                ...dialog.draft,
                                allocations: {
                                  ...dialog.draft.allocations,
                                  [entity.id]: Math.max(
                                    0,
                                    Math.min(100, Number(event.target.value)),
                                  ),
                                },
                              },
                            })
                          }
                        />
                        <em>%</em>
                      </label>
                      <span className={cx('oct-allocation-result', total > 100 && 'is-error')}>
                        {total}%
                      </span>
                    </div>
                  );
                })}
              </section>

              <label className="oct-consent">
                <input
                  type="checkbox"
                  checked={dialog.draft.consent}
                  onChange={(event) =>
                    setDialog({
                      ...dialog,
                      draft: { ...dialog.draft, consent: event.target.checked },
                    })
                  }
                />
                <span>
                  <strong>I confirm this proposal is intentional</strong>
                  <small>
                    The current distribution remains unchanged until a decision is recorded in
                    Review.
                  </small>
                </span>
              </label>
            </div>
            <footer className="oct-dialog__footer">
              <span>
                <Icon name="lock" size={10} />
                Approval required · receipt created
              </span>
              <div>
                <button
                  className="oct-button oct-button--quiet"
                  type="button"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button className="oct-button oct-button--primary" type="submit">
                  Submit to Review
                  <Icon name="arrow-right" size={11} />
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}

      {dialog?.kind === 'coverage' ? (
        <div className="oct-overlay" role="presentation" onMouseDown={() => setDialog(null)}>
          <form
            className="oct-dialog"
            ref={changeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="oct-coverage-dialog-title"
            onSubmit={submitCoverage}
            onMouseDown={(event) => event.stopPropagation()}
            tabIndex={-1}
          >
            <header className="oct-dialog__header">
              <div>
                <span>Planning assumptions</span>
                <h2 id="oct-coverage-dialog-title">Propose protection update</h2>
                <p>Update recorded cover and household needs without altering the live plan.</p>
              </div>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close dialog">
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="oct-dialog__body">
              <div className="oct-dialog-divider">
                <span>Available cover</span>
                <small>{currency}</small>
              </div>
              <div className="oct-form-grid">
                <label>
                  <span>Term life cover</span>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={dialog.draft.lifeCover}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: { ...dialog.draft, lifeCover: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  <span>Employer life cover</span>
                  <input
                    type="number"
                    min={0}
                    step={1000}
                    value={dialog.draft.propertyCover}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: { ...dialog.draft, propertyCover: Number(event.target.value) },
                      })
                    }
                  />
                </label>
              </div>
              <div className="oct-dialog-divider">
                <span>Household needs</span>
                <small>Current model</small>
              </div>
              <div className="oct-form-grid">
                {(
                  [
                    ['liabilities', 'Liabilities'],
                    ['dependants', 'Dependant support'],
                    ['goals', 'Long-term goals'],
                    ['immediateCosts', 'Immediate costs'],
                  ] as const
                ).map(([keyName, label]) => (
                  <label key={keyName}>
                    <span>{label}</span>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={dialog.draft[keyName]}
                      onChange={(event) =>
                        setDialog({
                          ...dialog,
                          draft: {
                            ...dialog.draft,
                            [keyName]: Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                ))}
                <label className="is-wide">
                  <span>Evidence or note</span>
                  <textarea
                    rows={3}
                    value={dialog.draft.note}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: { ...dialog.draft, note: event.target.value },
                      })
                    }
                    placeholder="What changed, and where can it be verified?"
                  />
                </label>
              </div>
              <label className="oct-consent">
                <input
                  type="checkbox"
                  checked={dialog.draft.consent}
                  onChange={(event) =>
                    setDialog({
                      ...dialog,
                      draft: { ...dialog.draft, consent: event.target.checked },
                    })
                  }
                />
                <span>
                  <strong>I have checked these planning assumptions</strong>
                  <small>They remain provisional until the review decision is recorded.</small>
                </span>
              </label>
            </div>
            <footer className="oct-dialog__footer">
              <span>
                <Icon name="shield" size={10} />
                Planning only · no policy purchase
              </span>
              <div>
                <button
                  className="oct-button oct-button--quiet"
                  type="button"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button className="oct-button oct-button--primary" type="submit">
                  Submit to Review
                  <Icon name="arrow-right" size={11} />
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}

      {dialog?.kind === 'contact' ? (
        <div className="oct-overlay" role="presentation" onMouseDown={() => setDialog(null)}>
          <form
            className="oct-dialog"
            ref={changeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="oct-contact-dialog-title"
            onSubmit={submitContact}
            onMouseDown={(event) => event.stopPropagation()}
            tabIndex={-1}
          >
            <header className="oct-dialog__header">
              <div>
                <span>Contact & schedule</span>
                <h2 id="oct-contact-dialog-title">Propose continuity rules</h2>
                <p>The contact starts verification. They never receive automatic access.</p>
              </div>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close dialog">
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="oct-dialog__body">
              <div className="oct-form-grid">
                <label>
                  <span>Contact name</span>
                  <input
                    value={dialog.draft.contact.name}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: {
                          ...dialog.draft,
                          contact: { ...dialog.draft.contact, name: event.target.value },
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>Relationship or role</span>
                  <input
                    value={dialog.draft.contact.relationship}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: {
                          ...dialog.draft,
                          contact: {
                            ...dialog.draft.contact,
                            relationship: event.target.value,
                          },
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input
                    type="email"
                    value={dialog.draft.contact.email}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: {
                          ...dialog.draft,
                          contact: { ...dialog.draft.contact, email: event.target.value },
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>Phone</span>
                  <input
                    value={dialog.draft.contact.phone}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: {
                          ...dialog.draft,
                          contact: { ...dialog.draft.contact, phone: event.target.value },
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <span>Check-in interval</span>
                  <select
                    value={dialog.draft.intervalDays}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: {
                          ...dialog.draft,
                          intervalDays: Number(
                            event.target.value,
                          ) as CheckInSchedule['intervalDays'],
                        },
                      })
                    }
                  >
                    <option value={30}>Every 30 days</option>
                    <option value={60}>Every 60 days</option>
                    <option value={90}>Every 90 days</option>
                    <option value={180}>Every 180 days</option>
                  </select>
                </label>
                <label>
                  <span>Grace period</span>
                  <select
                    value={dialog.draft.graceDays}
                    onChange={(event) =>
                      setDialog({
                        ...dialog,
                        draft: {
                          ...dialog.draft,
                          graceDays: Number(event.target.value) as CheckInSchedule['graceDays'],
                        },
                      })
                    }
                  >
                    <option value={3}>3 days</option>
                    <option value={7}>7 days</option>
                    <option value={14}>14 days</option>
                    <option value={30}>30 days</option>
                  </select>
                </label>
              </div>
              <div className="oct-boundary-note">
                <Icon name="lock" size={13} />
                <span>
                  <strong>The emergency contact is not a collaborator</strong>
                  <small>
                    They cannot see balances, trade, or change this plan. Their role is to begin a
                    documented verification process.
                  </small>
                </span>
              </div>
              <label className="oct-consent">
                <input
                  type="checkbox"
                  checked={dialog.draft.consent}
                  onChange={(event) =>
                    setDialog({
                      ...dialog,
                      draft: { ...dialog.draft, consent: event.target.checked },
                    })
                  }
                />
                <span>
                  <strong>I confirm these contact and timing changes</strong>
                  <small>The active rules remain unchanged until Review approves them.</small>
                </span>
              </label>
            </div>
            <footer className="oct-dialog__footer">
              <span>
                <Icon name="lock" size={10} />
                Contact verification required
              </span>
              <div>
                <button
                  className="oct-button oct-button--quiet"
                  type="button"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button className="oct-button oct-button--primary" type="submit">
                  Submit to Review
                  <Icon name="arrow-right" size={11} />
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}

      {dialog?.kind === 'package' ? (
        <div className="oct-overlay" role="presentation" onMouseDown={() => setDialog(null)}>
          <form
            className="oct-dialog"
            ref={changeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="oct-package-dialog-title"
            onSubmit={submitPackage}
            onMouseDown={(event) => event.stopPropagation()}
            tabIndex={-1}
          >
            <header className="oct-dialog__header">
              <div>
                <span>Encrypted handoff</span>
                <h2 id="oct-package-dialog-title">Prepare the minimum useful package</h2>
                <p>Select what may be released after every continuity condition passes.</p>
              </div>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close dialog">
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="oct-dialog__body">
              <div className="oct-package-selection">
                {(Object.keys(dialog.draft.scope) as Array<keyof HandoffScope>).map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={dialog.draft.scope[scope]}
                      onChange={(event) =>
                        setDialog({
                          ...dialog,
                          draft: {
                            ...dialog.draft,
                            scope: { ...dialog.draft.scope, [scope]: event.target.checked },
                          },
                        })
                      }
                    />
                    <span>
                      <Icon
                        name={
                          scope === 'documents'
                            ? 'document'
                            : scope === 'adviserContacts'
                              ? 'people'
                              : scope === 'accountDirectory'
                                ? 'bank'
                                : scope === 'personalInstructions'
                                  ? 'message'
                                  : 'portfolio'
                        }
                        size={13}
                      />
                    </span>
                    <span>
                      <strong>{scopeLabel(scope)}</strong>
                      <small>
                        {scope === 'documents'
                          ? `${state.checklist.filter((item) => item.fileName).length} linked evidence files`
                          : scope === 'portfolioSummary'
                            ? 'Values, ownership labels, and nested structure'
                            : scope === 'accountDirectory'
                              ? 'Provider references without credentials'
                              : scope === 'adviserContacts'
                                ? 'Named professionals and approved contact routes'
                                : 'A plain-language note for the verified recipient'}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <label className="oct-instructions">
                <span>Personal instructions</span>
                <textarea
                  rows={4}
                  value={dialog.draft.instructions}
                  onChange={(event) =>
                    setDialog({
                      ...dialog,
                      draft: { ...dialog.draft, instructions: event.target.value },
                    })
                  }
                  placeholder="Plain-language guidance for the verified recipient"
                />
                <small>
                  Instructions cannot transfer ownership or bypass legal authority. They provide
                  context only.
                </small>
              </label>
              <div className="oct-package-summary">
                <span>
                  <Icon name="key" size={13} />
                </span>
                <div>
                  <strong>Two protected parts</strong>
                  <small>Account key + verified emergency contact key</small>
                </div>
                <span>
                  {Object.values(dialog.draft.scope).filter(Boolean).length} information groups
                </span>
              </div>
              <label className="oct-consent oct-consent--strong">
                <input
                  type="checkbox"
                  checked={dialog.draft.consent}
                  onChange={(event) =>
                    setDialog({
                      ...dialog,
                      draft: { ...dialog.draft, consent: event.target.checked },
                    })
                  }
                />
                <span>
                  <strong>I consent to preparing this encrypted handoff</strong>
                  <small>
                    I understand that preparation does not release information. Release still
                    requires the full approved process and creates an audit receipt.
                  </small>
                </span>
              </label>
            </div>
            <footer className="oct-dialog__footer">
              <span>
                <Icon name="shield" size={10} />
                Encrypted · review-gated · auditable
              </span>
              <div>
                <button
                  className="oct-button oct-button--quiet"
                  type="button"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button className="oct-button oct-button--primary" type="submit">
                  Confirm &amp; submit
                  <Icon name="arrow-right" size={11} />
                </button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}

      {receipt ? (
        <div className="oct-overlay" role="presentation" onMouseDown={() => setReceipt(null)}>
          <section
            className="oct-receipt"
            ref={receiptDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="oct-receipt-title"
            onMouseDown={(event) => event.stopPropagation()}
            tabIndex={-1}
          >
            <header>
              <span className="oct-receipt__mark">
                <Icon name="check" size={17} />
              </span>
              <div>
                <span>Action recorded</span>
                <h2 id="oct-receipt-title">{receipt.summary}</h2>
                <p>{receipt.reference}</p>
              </div>
              <button type="button" onClick={() => setReceipt(null)} aria-label="Close receipt">
                <Icon name="x" size={13} />
              </button>
            </header>
            <dl>
              <div>
                <dt>Portfolio</dt>
                <dd>{portfolio.name}</dd>
              </div>
              <div>
                <dt>Recorded</dt>
                <dd>{displayDateTime(receipt.at)}</dd>
              </div>
              <div>
                <dt>Actor</dt>
                <dd>{receipt.actor}</dd>
              </div>
              <div>
                <dt>Consent</dt>
                <dd>{receipt.consentConfirmed ? 'Explicitly confirmed' : 'Not required'}</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>
                  {receipt.kind === 'proposal-submitted'
                    ? 'Waiting in Review · active plan unchanged'
                    : receipt.kind === 'check-in'
                      ? `Next check-in ${displayDate(state.schedule.nextCheckIn)}`
                      : 'Redacted file downloaded'}
                </dd>
              </div>
            </dl>
            <div className="oct-receipt__boundary">
              <Icon name="lock" size={12} />
              <span>
                This receipt records the action and consent state. It contains no package key,
                password, or document contents.
              </span>
            </div>
            <footer>
              <button
                className="oct-button oct-button--secondary"
                type="button"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(receipt.reference)
                    .then(() => onToast?.('Receipt reference copied.'))
                    .catch(() => onToast?.(receipt.reference));
                }}
              >
                <Icon name="copy" size={11} />
                Copy reference
              </button>
              {receipt.kind === 'proposal-submitted' ? (
                <button
                  className="oct-button oct-button--primary"
                  type="button"
                  onClick={() => {
                    setReceipt(null);
                    onOpenReview();
                  }}
                >
                  Open Review
                  <Icon name="arrow-right" size={11} />
                </button>
              ) : (
                <button
                  className="oct-button oct-button--primary"
                  type="button"
                  onClick={() => setReceipt(null)}
                >
                  Done
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default OriginContinuity;
