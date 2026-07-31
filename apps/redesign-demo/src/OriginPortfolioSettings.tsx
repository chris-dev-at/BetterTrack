import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import type { OriginReviewEntry } from './OriginReviewCenter';
import { useAccessibleDialog } from './useAccessibleDialog';
import './origin-portfolio-settings.css';

export type OriginPortfolioSettingsPortfolio = {
  id: string;
  name: string;
  reference?: string;
  baseCurrency?: string;
  reportingTimezone?: string;
};

export type OriginPortfolioSettingsProps = {
  portfolio: OriginPortfolioSettingsPortfolio;
  privateMode: boolean;
  onClose: () => void;
  onOpenTax: () => void;
  onOpenPeople: () => void;
  onOpenConnections: () => void;
  onOpenReview: () => void;
  onSubmitReview: (entry: OriginReviewEntry) => void;
  onToast?: (message: string) => void;
};

type SettingsView = 'overview' | 'calculation' | 'data' | 'access' | 'lifecycle' | 'audit';
type SettingsSection = 'identity' | 'calculation' | 'privacy' | 'review-policy' | 'data';
type LifecycleAction = 'duplicate' | 'split' | 'archive';
type Risk = 'low' | 'medium' | 'high';

type IdentitySettings = {
  name: string;
  reference: string;
  baseCurrency: 'EUR' | 'USD' | 'GBP' | 'CHF';
  reportingTimezone: string;
  dateFormat: 'DD MMM YYYY' | 'DD.MM.YYYY' | 'YYYY-MM-DD';
  compactNumbers: boolean;
};

type CalculationSettings = {
  valuationMethod: 'latest-close' | 'provider-close' | 'manual-review';
  performanceMethod: 'twr' | 'mwr';
  cashTreatment: 'include' | 'exclude' | 'separate';
  fxMethod: 'ecb-close' | 'source-rate' | 'transaction-rate';
  benchmark: string;
};

type PrivacySettings = {
  visibility: 'private' | 'invited' | 'link';
  maskByDefault: boolean;
  allowExports: boolean;
  publicAttribution: boolean;
};

type ReviewPolicy = {
  mode: 'owner' | 'risk-based' | 'dual';
  amountThreshold: number;
  allocationThreshold: number;
  requireSourceChanges: boolean;
  requireLifecycle: boolean;
  allowSafeCorporateActions: boolean;
};

type DataSource = {
  id: string;
  name: string;
  detail: string;
  kind: 'connection' | 'import' | 'manual' | 'derived';
  priority: number;
  enabled: boolean;
  lastSeen: string;
};

type DataSettings = {
  ownership: 'bettertrack' | 'drive' | 'device';
  conflictRule: 'priority' | 'newest' | 'manual-review';
  preserveSourceEvidence: boolean;
  sources: DataSource[];
};

type SettingsConfig = {
  identity: IdentitySettings;
  calculation: CalculationSettings;
  privacy: PrivacySettings;
  reviewPolicy: ReviewPolicy;
  data: DataSettings;
};

type SettingsReceipt = {
  id: string;
  reference: string;
  at: string;
  actor: string;
  type: 'direct-save' | 'review-submitted';
  section: SettingsSection | LifecycleAction;
  summary: string;
  reason?: string;
};

type AuditEvent = {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
  reference: string;
  tone: 'neutral' | 'success' | 'warning';
};

type PendingProposal = {
  id: string;
  reference: string;
  title: string;
  summary: string;
  submittedAt: string;
  risk: Risk;
  section: SettingsSection | LifecycleAction;
  nextConfig?: SettingsConfig;
};

type PersistedSettingsState = {
  version: 1;
  config: SettingsConfig;
  receipts: SettingsReceipt[];
  audit: AuditEvent[];
  proposals: PendingProposal[];
};

type ReviewDiff = NonNullable<OriginReviewEntry['diff']>;

type ConfirmationDialog =
  | {
      kind: 'settings';
      section: SettingsSection;
      title: string;
      summary: string;
      diff: ReviewDiff;
      risk: Risk;
      reason: string;
      consent: boolean;
    }
  | {
      kind: 'lifecycle';
      action: LifecycleAction;
      title: string;
      summary: string;
      risk: Risk;
      reason: string;
      consent: boolean;
      destinationName: string;
      splitRule: 'selected-assets' | 'allocation' | 'empty-shell';
      archivePhrase: string;
    }
  | null;

const views: Array<{
  id: SettingsView;
  label: string;
  description: string;
  icon: IconName;
}> = [
  {
    id: 'overview',
    label: 'Portfolio profile',
    description: 'Identity, tax, and policies',
    icon: 'portfolio',
  },
  {
    id: 'calculation',
    label: 'Calculation',
    description: 'Valuation and performance',
    icon: 'activity',
  },
  {
    id: 'data',
    label: 'Connected data',
    description: 'Ownership and precedence',
    icon: 'database',
  },
  {
    id: 'access',
    label: 'Access & privacy',
    description: 'People and visibility',
    icon: 'shield',
  },
  {
    id: 'lifecycle',
    label: 'Lifecycle',
    description: 'Duplicate, split, or archive',
    icon: 'layers',
  },
  {
    id: 'audit',
    label: 'Settings audit',
    description: 'Receipts and proposals',
    icon: 'clock',
  },
];

const currencyLabels: Record<IdentitySettings['baseCurrency'], string> = {
  EUR: 'EUR · Euro',
  USD: 'USD · US dollar',
  GBP: 'GBP · Pound sterling',
  CHF: 'CHF · Swiss franc',
};

const valuationLabels: Record<CalculationSettings['valuationMethod'], string> = {
  'latest-close': 'Latest available market close',
  'provider-close': 'Connected provider close',
  'manual-review': 'Manual values until reviewed',
};

const performanceLabels: Record<CalculationSettings['performanceMethod'], string> = {
  twr: 'Time-weighted return (TWR)',
  mwr: 'Money-weighted return (IRR)',
};

const sourceKindLabels: Record<DataSource['kind'], string> = {
  connection: 'Connection',
  import: 'Imported',
  manual: 'Manual',
  derived: 'Calculated',
};

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function reference(prefix: string) {
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;
}

function safeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function storageKey(portfolioId: string) {
  return `bt-origin-portfolio-settings-v1-${safeKey(portfolioId) || 'portfolio'}`;
}

export function applyOriginPortfolioSettingsReviewDecision(
  portfolioId: string,
  reviewId: string,
  decision: 'approved' | 'rejected',
  reference: string,
) {
  if (typeof window === 'undefined') return false;
  try {
    const key = storageKey(portfolioId);
    const state = JSON.parse(
      window.localStorage.getItem(key) ?? 'null',
    ) as PersistedSettingsState | null;
    const proposal = state?.proposals.find((item) => item.id === reviewId);
    if (!state || !proposal) return false;
    const at = new Date().toISOString();
    const next: PersistedSettingsState = {
      ...state,
      config: decision === 'approved' && proposal.nextConfig ? proposal.nextConfig : state.config,
      proposals: state.proposals.filter((item) => item.id !== reviewId),
      audit: [
        {
          id: uid('audit'),
          at,
          actor: 'You',
          action: `${proposal.title} ${decision}`,
          detail:
            decision === 'approved'
              ? 'The reviewed settings diff is now the active portfolio policy.'
              : 'The proposal was closed and active portfolio settings stayed unchanged.',
          reference,
          tone: decision === 'approved' ? ('success' as const) : ('neutral' as const),
        },
        ...state.audit,
      ].slice(0, 100),
    };
    window.localStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
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

function seedConfig(portfolio: OriginPortfolioSettingsPortfolio): SettingsConfig {
  return {
    identity: {
      name: portfolio.name,
      reference: portfolio.reference ?? 'BT-PERSONAL-001',
      baseCurrency: (portfolio.baseCurrency as IdentitySettings['baseCurrency']) ?? 'EUR',
      reportingTimezone: portfolio.reportingTimezone ?? 'Europe/Vienna',
      dateFormat: 'DD MMM YYYY',
      compactNumbers: false,
    },
    calculation: {
      valuationMethod: 'latest-close',
      performanceMethod: 'twr',
      cashTreatment: 'include',
      fxMethod: 'ecb-close',
      benchmark: 'FTSE All-World · EUR',
    },
    privacy: {
      visibility: 'private',
      maskByDefault: false,
      allowExports: true,
      publicAttribution: false,
    },
    reviewPolicy: {
      mode: 'risk-based',
      amountThreshold: 10000,
      allocationThreshold: 3,
      requireSourceChanges: true,
      requireLifecycle: true,
      allowSafeCorporateActions: true,
    },
    data: {
      ownership: 'bettertrack',
      conflictRule: 'priority',
      preserveSourceEvidence: true,
      sources: [
        {
          id: 'source-flatex',
          name: 'Flatex depot',
          detail: 'Holdings, trades, and cash movements',
          kind: 'connection',
          priority: 1,
          enabled: true,
          lastSeen: 'Today · 05:17',
        },
        {
          id: 'source-drive',
          name: 'Google Drive import',
          detail: 'Contract notes and private valuations',
          kind: 'import',
          priority: 2,
          enabled: true,
          lastSeen: 'Yesterday · 22:04',
        },
        {
          id: 'source-manual',
          name: 'Owner corrections',
          detail: 'Reviewed values entered inside this portfolio',
          kind: 'manual',
          priority: 3,
          enabled: true,
          lastSeen: '24 Jul · 18:42',
        },
        {
          id: 'source-derived',
          name: 'BetterTrack calculations',
          detail: 'FX conversion, accrued income, and projections',
          kind: 'derived',
          priority: 4,
          enabled: true,
          lastSeen: 'Today · 05:18',
        },
      ],
    },
  };
}

function initialState(portfolio: OriginPortfolioSettingsPortfolio): PersistedSettingsState {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    config: seedConfig(portfolio),
    receipts: [],
    proposals: [],
    audit: [
      {
        id: 'audit-settings-seed',
        at: timestamp,
        actor: 'BetterTrack',
        action: 'Portfolio settings verified',
        detail: 'Calculation, access, and source policies are internally consistent.',
        reference: 'SYSTEM-CHECK',
        tone: 'success',
      },
    ],
  };
}

function loadState(portfolio: OriginPortfolioSettingsPortfolio): PersistedSettingsState {
  const fallback = initialState(portfolio);
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey(portfolio.id));
    if (!stored) return fallback;
    const parsed = JSON.parse(stored) as Partial<PersistedSettingsState>;
    return {
      ...fallback,
      ...parsed,
      version: 1,
      config: {
        ...fallback.config,
        ...parsed.config,
        identity: { ...fallback.config.identity, ...parsed.config?.identity },
        calculation: { ...fallback.config.calculation, ...parsed.config?.calculation },
        privacy: { ...fallback.config.privacy, ...parsed.config?.privacy },
        reviewPolicy: { ...fallback.config.reviewPolicy, ...parsed.config?.reviewPolicy },
        data: {
          ...fallback.config.data,
          ...parsed.config?.data,
          sources: Array.isArray(parsed.config?.data?.sources)
            ? parsed.config.data.sources
            : fallback.config.data.sources,
        },
      },
      receipts: Array.isArray(parsed.receipts) ? parsed.receipts : fallback.receipts,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : fallback.proposals,
      audit: Array.isArray(parsed.audit) ? parsed.audit : fallback.audit,
    };
  } catch {
    return fallback;
  }
}

function settingsLabel(section: SettingsSection) {
  const labels: Record<SettingsSection, string> = {
    identity: 'Portfolio identity',
    calculation: 'Calculation policy',
    privacy: 'Visibility and privacy',
    'review-policy': 'Review policy',
    data: 'Connected-data policy',
  };
  return labels[section];
}

function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
}) {
  return <span className={`opset-pill opset-pill--${tone}`}>{children}</span>;
}

function Toggle({
  checked,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={checked}
      className={`opset-toggle ${checked ? 'is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      type="button"
    >
      <i />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="opset-setting-row">
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <div className="opset-setting-row__control">{children}</div>
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="opset-section-header">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function diffValue(before: string | number | boolean, after: string | number | boolean) {
  return { before: String(before), after: String(after) };
}

export function OriginPortfolioSettings({
  portfolio,
  privateMode,
  onClose,
  onOpenTax,
  onOpenPeople,
  onOpenConnections,
  onOpenReview,
  onSubmitReview,
  onToast,
}: OriginPortfolioSettingsProps) {
  const [boundPortfolioId, setBoundPortfolioId] = useState(portfolio.id);
  const [state, setState] = useState<PersistedSettingsState>(() => loadState(portfolio));
  const [draft, setDraft] = useState<SettingsConfig>(() => loadState(portfolio).config);
  const [view, setView] = useState<SettingsView>('overview');
  const [dialog, setDialog] = useState<ConfirmationDialog>(null);
  const [lastReceipt, setLastReceipt] = useState<SettingsReceipt | null>(null);
  const workspaceRef = useAccessibleDialog<HTMLDivElement>({ open: true, onClose });
  const confirmationRef = useAccessibleDialog<HTMLElement>({
    open: dialog !== null,
    onClose: () => setDialog(null),
    initialFocusSelector: '[data-autofocus]',
  });

  useEffect(() => {
    if (boundPortfolioId === portfolio.id) return;
    const next = loadState(portfolio);
    setState(next);
    setDraft(next.config);
    setBoundPortfolioId(portfolio.id);
    setView('overview');
    setDialog(null);
    setLastReceipt(null);
  }, [boundPortfolioId, portfolio]);

  useEffect(() => {
    if (boundPortfolioId !== portfolio.id || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(storageKey(portfolio.id), JSON.stringify(state));
    } catch {
      // Keep the simulated workspace fully usable when browser storage is unavailable.
    }
  }, [boundPortfolioId, portfolio.id, state]);

  const pendingCount = state.proposals.length;
  const enabledSources = draft.data.sources.filter((source) => source.enabled).length;
  const currentView = views.find((item) => item.id === view) ?? views[0]!;

  const dirty = useMemo(
    () => ({
      identity: JSON.stringify(draft.identity) !== JSON.stringify(state.config.identity),
      calculation: JSON.stringify(draft.calculation) !== JSON.stringify(state.config.calculation),
      privacy: JSON.stringify(draft.privacy) !== JSON.stringify(state.config.privacy),
      reviewPolicy:
        JSON.stringify(draft.reviewPolicy) !== JSON.stringify(state.config.reviewPolicy),
      data: JSON.stringify(draft.data) !== JSON.stringify(state.config.data),
    }),
    [draft, state.config],
  );

  const appendReceipt = (
    type: SettingsReceipt['type'],
    section: SettingsReceipt['section'],
    summary: string,
    receiptReference: string,
    reason?: string,
  ) => {
    const receipt: SettingsReceipt = {
      id: uid('receipt'),
      reference: receiptReference,
      at: new Date().toISOString(),
      actor: 'You',
      type,
      section,
      summary,
      reason,
    };
    setState((current) => ({
      ...current,
      receipts: [receipt, ...current.receipts].slice(0, 80),
    }));
    setLastReceipt(receipt);
    return receipt;
  };

  const directSave = (section: SettingsSection, nextConfig: SettingsConfig, summary: string) => {
    const receiptReference = reference('SET');
    const timestamp = new Date().toISOString();
    setState((current) => ({
      ...current,
      config: nextConfig,
      audit: [
        {
          id: uid('audit'),
          at: timestamp,
          actor: 'You',
          action: `${settingsLabel(section)} saved`,
          detail: summary,
          reference: receiptReference,
          tone: 'success' as const,
        },
        ...current.audit,
      ].slice(0, 100),
    }));
    appendReceipt('direct-save', section, summary, receiptReference);
    onToast?.(`${settingsLabel(section)} saved to ${portfolio.name}.`);
  };

  const proposeSettings = (
    section: SettingsSection,
    title: string,
    summary: string,
    diff: ReviewDiff,
    risk: Risk,
  ) => {
    setDialog({
      kind: 'settings',
      section,
      title,
      summary,
      diff,
      risk,
      reason: '',
      consent: false,
    });
  };

  const identityDiff = (): ReviewDiff => {
    const before = state.config.identity;
    const after = draft.identity;
    return [
      { label: 'Portfolio name', ...diffValue(before.name, after.name) },
      { label: 'Internal reference', ...diffValue(before.reference, after.reference) },
      { label: 'Base currency', ...diffValue(before.baseCurrency, after.baseCurrency) },
    ].filter((item) => item.before !== item.after);
  };

  const identityDisplayDiff = (): ReviewDiff => {
    const before = state.config.identity;
    const after = draft.identity;
    return [
      {
        label: 'Reporting timezone',
        ...diffValue(before.reportingTimezone, after.reportingTimezone),
      },
      { label: 'Date format', ...diffValue(before.dateFormat, after.dateFormat) },
      {
        label: 'Compact numbers',
        ...diffValue(before.compactNumbers ? 'On' : 'Off', after.compactNumbers ? 'On' : 'Off'),
      },
    ].filter((item) => item.before !== item.after);
  };

  const saveIdentity = () => {
    if (!dirty.identity) return;
    const consequential = identityDiff();
    if (consequential.length === 0) {
      directSave(
        'identity',
        { ...state.config, identity: draft.identity },
        'Reporting timezone and display conventions updated.',
      );
      return;
    }
    proposeSettings(
      'identity',
      'Change portfolio identity',
      'Update identifying fields used by reports, exports, integrations, and collaborators.',
      [...consequential, ...identityDisplayDiff()],
      draft.identity.baseCurrency !== state.config.identity.baseCurrency ? 'high' : 'medium',
    );
  };

  const calculationDiff = (): ReviewDiff => {
    const before = state.config.calculation;
    const after = draft.calculation;
    return [
      {
        label: 'Valuation method',
        ...diffValue(
          valuationLabels[before.valuationMethod],
          valuationLabels[after.valuationMethod],
        ),
      },
      {
        label: 'Performance method',
        ...diffValue(
          performanceLabels[before.performanceMethod],
          performanceLabels[after.performanceMethod],
        ),
      },
      { label: 'Cash treatment', ...diffValue(before.cashTreatment, after.cashTreatment) },
      { label: 'FX policy', ...diffValue(before.fxMethod, after.fxMethod) },
      { label: 'Benchmark', ...diffValue(before.benchmark, after.benchmark) },
    ].filter((item) => item.before !== item.after);
  };

  const saveCalculation = () => {
    const diff = calculationDiff();
    if (!diff.length) return;
    proposeSettings(
      'calculation',
      'Change portfolio calculation policy',
      'Recalculate how this portfolio values assets and reports historical performance.',
      diff,
      draft.calculation.performanceMethod !== state.config.calculation.performanceMethod
        ? 'high'
        : 'medium',
    );
  };

  const privacyDiff = (): ReviewDiff => {
    const before = state.config.privacy;
    const after = draft.privacy;
    return [
      { label: 'Visibility', ...diffValue(before.visibility, after.visibility) },
      {
        label: 'Mask values by default',
        ...diffValue(before.maskByDefault ? 'On' : 'Off', after.maskByDefault ? 'On' : 'Off'),
      },
      {
        label: 'Member exports',
        ...diffValue(
          before.allowExports ? 'Allowed' : 'Blocked',
          after.allowExports ? 'Allowed' : 'Blocked',
        ),
      },
      {
        label: 'Public attribution',
        ...diffValue(
          before.publicAttribution ? 'Shown' : 'Hidden',
          after.publicAttribution ? 'Shown' : 'Hidden',
        ),
      },
    ].filter((item) => item.before !== item.after);
  };

  const savePrivacy = () => {
    const diff = privacyDiff();
    if (!diff.length) return;
    proposeSettings(
      'privacy',
      'Change portfolio visibility',
      'Update who can discover, view, or export information from this portfolio.',
      diff,
      draft.privacy.visibility === 'link' ? 'high' : 'medium',
    );
  };

  const policyDiff = (): ReviewDiff => {
    const before = state.config.reviewPolicy;
    const after = draft.reviewPolicy;
    return [
      { label: 'Approval mode', ...diffValue(before.mode, after.mode) },
      {
        label: 'Amount threshold',
        ...diffValue(`€${before.amountThreshold}`, `€${after.amountThreshold}`),
      },
      {
        label: 'Allocation threshold',
        ...diffValue(`${before.allocationThreshold}%`, `${after.allocationThreshold}%`),
      },
      {
        label: 'Source changes',
        ...diffValue(
          before.requireSourceChanges ? 'Review' : 'Direct',
          after.requireSourceChanges ? 'Review' : 'Direct',
        ),
      },
      {
        label: 'Lifecycle actions',
        ...diffValue(
          before.requireLifecycle ? 'Review' : 'Direct',
          after.requireLifecycle ? 'Review' : 'Direct',
        ),
      },
      {
        label: 'Safe corporate actions',
        ...diffValue(
          before.allowSafeCorporateActions ? 'Direct' : 'Review',
          after.allowSafeCorporateActions ? 'Direct' : 'Review',
        ),
      },
    ].filter((item) => item.before !== item.after);
  };

  const savePolicy = () => {
    const diff = policyDiff();
    if (!diff.length) return;
    proposeSettings(
      'review-policy',
      'Change Review policy',
      'Change which future portfolio mutations can apply directly and which require approval.',
      diff,
      'high',
    );
  };

  const dataDiff = (): ReviewDiff => {
    const before = state.config.data;
    const after = draft.data;
    const beforeOrder = [...before.sources]
      .sort((a, b) => a.priority - b.priority)
      .map((source) => source.name)
      .join(' → ');
    const afterOrder = [...after.sources]
      .sort((a, b) => a.priority - b.priority)
      .map((source) => source.name)
      .join(' → ');
    return [
      { label: 'Data home', ...diffValue(before.ownership, after.ownership) },
      { label: 'Conflict rule', ...diffValue(before.conflictRule, after.conflictRule) },
      { label: 'Source precedence', ...diffValue(beforeOrder, afterOrder) },
      {
        label: 'Source evidence',
        ...diffValue(
          before.preserveSourceEvidence ? 'Preserved' : 'Discarded',
          after.preserveSourceEvidence ? 'Preserved' : 'Discarded',
        ),
      },
      ...after.sources
        .filter(
          (source) =>
            source.enabled !==
            before.sources.find((candidate) => candidate.id === source.id)?.enabled,
        )
        .map((source) => ({
          label: source.name,
          before: source.enabled ? 'Disabled' : 'Enabled',
          after: source.enabled ? 'Enabled' : 'Disabled',
        })),
    ].filter((item) => item.before !== item.after);
  };

  const saveData = () => {
    const diff = dataDiff();
    if (!diff.length) return;
    proposeSettings(
      'data',
      'Change connected-data authority',
      'Update which source wins when multiple records describe the same portfolio fact.',
      diff,
      'high',
    );
  };

  const submitReview = (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    const isArchive = dialog.kind === 'lifecycle' && dialog.action === 'archive';
    if (
      dialog.reason.trim().length < 8 ||
      !dialog.consent ||
      (isArchive && dialog.archivePhrase.trim().toUpperCase() !== 'ARCHIVE')
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const receiptReference = reference(dialog.kind === 'lifecycle' ? 'LIFE' : 'SET');
    const reviewId = uid(dialog.kind === 'lifecycle' ? 'lifecycle' : 'settings');
    const section =
      dialog.kind === 'settings' ? dialog.section : (dialog.action as SettingsReceipt['section']);
    const title = dialog.title;
    const summary =
      dialog.kind === 'lifecycle'
        ? `${dialog.summary} Requested destination: ${dialog.destinationName || 'Not applicable'}.`
        : dialog.summary;
    const diff: ReviewDiff =
      dialog.kind === 'settings'
        ? dialog.diff
        : [
            {
              label: 'Lifecycle state',
              before: 'Active portfolio',
              after:
                dialog.action === 'archive'
                  ? 'Archived, read-only portfolio'
                  : dialog.action === 'duplicate'
                    ? `New independent copy: ${dialog.destinationName}`
                    : `New separated portfolio: ${dialog.destinationName}`,
              tone: dialog.action === 'archive' ? 'warning' : 'neutral',
            },
            ...(dialog.action === 'split'
              ? [
                  {
                    label: 'Split rule',
                    before: 'All records in current portfolio',
                    after: dialog.splitRule.replaceAll('-', ' '),
                  },
                ]
              : []),
          ];

    const review: OriginReviewEntry = {
      id: reviewId,
      kind: 'collaboration',
      title,
      summary,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        path: `${portfolio.name} / Settings & lifecycle`,
      },
      source: {
        label: 'Portfolio settings',
        detail: `${settingsLabel(section as SettingsSection) ?? section} · ${receiptReference}`,
        actor: 'You',
      },
      requestedAt: createdAt,
      requestedBy: 'You',
      status: 'pending',
      priority: dialog.risk === 'high' ? 'high' : 'normal',
      risk: dialog.risk,
      affectedCount: diff.length,
      tags: [
        'portfolio-settings',
        'portfolio-scoped',
        dialog.kind === 'lifecycle' ? dialog.action : dialog.section,
      ],
      approveLabel: dialog.kind === 'lifecycle' ? `Approve ${dialog.action}` : 'Approve changes',
      rejectLabel: 'Keep current settings',
      diff,
      lineage: [
        {
          label: 'Current portfolio state',
          detail: `${portfolio.name} remains authoritative while this request is pending.`,
          at: createdAt,
          state: 'verified',
        },
        {
          label: 'Owner reason',
          detail: dialog.reason.trim(),
          at: createdAt,
          state: 'verified',
        },
        {
          label: 'Settings receipt',
          detail: `${receiptReference} records the proposal, consent, and exact diff.`,
          at: createdAt,
          state: 'derived',
        },
      ],
      permissions: [
        {
          label: 'Portfolio owner',
          detail: 'May propose portfolio policy and lifecycle changes',
          outcome: 'allowed',
        },
        {
          label: 'Review policy',
          detail: `${state.config.reviewPolicy.mode} approval is required before application`,
          outcome: 'review',
        },
      ],
      policies: [
        {
          title: 'No silent mutation',
          description: 'The active portfolio stays unchanged until Review records approval.',
          status: 'pass',
        },
        {
          title: 'Reversible preparation',
          description:
            dialog.kind === 'lifecycle' && dialog.action === 'archive'
              ? 'Archive preserves records, evidence, and an auditable restore path.'
              : 'No source records are removed while the change is staged.',
          status: 'pass',
        },
        {
          title: 'Reason and consent attached',
          description: `Owner confirmation is recorded on ${receiptReference}.`,
          status: 'pass',
        },
        {
          title: 'Non-owner writes rejected',
          description:
            'Editors and connected apps cannot apply portfolio policy or lifecycle changes.',
          status: 'pass',
        },
      ],
    };

    const proposal: PendingProposal = {
      id: reviewId,
      reference: receiptReference,
      title,
      summary,
      submittedAt: createdAt,
      risk: dialog.risk,
      section,
      ...(dialog.kind === 'settings' ? { nextConfig: draft } : {}),
    };
    setState((current) => ({
      ...current,
      proposals: [proposal, ...current.proposals].slice(0, 60),
      audit: [
        {
          id: uid('audit'),
          at: createdAt,
          actor: 'You',
          action: `${title} submitted`,
          detail: `Current settings remain unchanged while ${receiptReference} waits in Review.`,
          reference: receiptReference,
          tone: 'warning' as const,
        },
        ...current.audit,
      ].slice(0, 100),
    }));
    appendReceipt(
      'review-submitted',
      section,
      `${title} is waiting in Review.`,
      receiptReference,
      dialog.reason.trim(),
    );
    onSubmitReview(review);
    setDraft(state.config);
    setDialog(null);
    onToast?.(`${title} sent to Review. Nothing changed yet.`);
  };

  const moveSource = (sourceId: string, direction: -1 | 1) => {
    setDraft((current) => {
      const ordered = [...current.data.sources].sort((a, b) => a.priority - b.priority);
      const index = ordered.findIndex((source) => source.id === sourceId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return current;
      [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
      const sources = ordered.map((source, nextIndex) => ({
        ...source,
        priority: nextIndex + 1,
      }));
      return { ...current, data: { ...current.data, sources } };
    });
  };

  const openLifecycle = (action: LifecycleAction) => {
    const meta: Record<
      LifecycleAction,
      Pick<Extract<ConfirmationDialog, { kind: 'lifecycle' }>, 'title' | 'summary' | 'risk'>
    > = {
      duplicate: {
        title: 'Duplicate this portfolio',
        summary:
          'Create an independent portfolio with copied structure and selected historical records.',
        risk: 'medium',
      },
      split: {
        title: 'Split this portfolio',
        summary:
          'Stage selected assets and their source history for a new, separately managed portfolio.',
        risk: 'high',
      },
      archive: {
        title: 'Archive this portfolio',
        summary:
          'Make the portfolio read-only, stop automations, and remove it from active navigation.',
        risk: 'high',
      },
    };
    setDialog({
      kind: 'lifecycle',
      action,
      ...meta[action],
      reason: '',
      consent: false,
      destinationName:
        action === 'duplicate'
          ? `${portfolio.name} copy`
          : action === 'split'
            ? `${portfolio.name} · New sleeve`
            : '',
      splitRule: 'selected-assets',
      archivePhrase: '',
    });
  };

  const resetSection = (section: SettingsSection) => {
    setDraft((current) => ({
      ...current,
      [section === 'review-policy' ? 'reviewPolicy' : section]:
        state.config[section === 'review-policy' ? 'reviewPolicy' : section],
    }));
  };

  return (
    <div
      aria-label={`${portfolio.name} portfolio settings`}
      aria-modal="true"
      className={`opset-shell ${privateMode ? 'is-private' : ''}`}
      data-accessible-dialog-layer
      data-testid="portfolio-settings-workspace"
      ref={workspaceRef}
      role="dialog"
      tabIndex={-1}
    >
      <header className="opset-topbar">
        <div className="opset-brand">
          <span>
            <Icon name="settings" size={16} />
          </span>
          <div>
            <strong>Portfolio settings</strong>
            <small>{portfolio.name}</small>
          </div>
        </div>
        <div className="opset-topbar__actions">
          <Pill tone={pendingCount ? 'warning' : 'positive'}>
            {pendingCount ? `${pendingCount} in Review` : 'Policy verified'}
          </Pill>
          {privateMode ? <Pill>Private mode</Pill> : null}
          <button aria-label="Close portfolio settings" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </div>
      </header>

      <div className="opset-layout">
        <aside className="opset-navigation">
          <div className="opset-navigation__scope">
            <span>Portfolio scope</span>
            <strong>{portfolio.name}</strong>
            <small>{state.config.identity.reference}</small>
          </div>
          <nav aria-label="Portfolio settings sections">
            {views.map((item) => (
              <button
                aria-current={view === item.id ? 'page' : undefined}
                className={view === item.id ? 'is-active' : ''}
                data-testid={`settings-tab-${item.id}`}
                key={item.id}
                onClick={() => setView(item.id)}
                type="button"
              >
                <Icon name={item.icon} size={16} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {item.id === 'audit' && pendingCount ? <i>{pendingCount}</i> : null}
              </button>
            ))}
          </nav>
          <section className="opset-navigation__boundary">
            <span>Scope boundary</span>
            <p>These rules apply only to this portfolio and its records.</p>
            <button onClick={onOpenReview} type="button">
              <Icon name="inbox" size={14} />
              Open Review
            </button>
          </section>
        </aside>

        <main className="opset-main">
          <div className="opset-page-heading">
            <div>
              <span>{currentView.description}</span>
              <h1>{currentView.label}</h1>
            </div>
            <div>
              <Pill>{enabledSources} active sources</Pill>
              <Pill tone="positive">Stored locally</Pill>
            </div>
          </div>

          {view === 'overview' ? (
            <div className="opset-content" data-testid="settings-view-overview">
              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Portfolio identity"
                  title="Portfolio identity"
                  description="Used across reports, imports, integrations, collaboration, and audit receipts."
                />
                <div className="opset-fields opset-fields--two">
                  <label>
                    <span>Portfolio name</span>
                    <input
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          identity: { ...current.identity, name: event.target.value },
                        }))
                      }
                      value={draft.identity.name}
                    />
                    <small>Visible to members and connected applications.</small>
                  </label>
                  <label>
                    <span>Internal reference</span>
                    <input
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          identity: { ...current.identity, reference: event.target.value },
                        }))
                      }
                      value={draft.identity.reference}
                    />
                    <small>Stable identifier used in exports and advisor reports.</small>
                  </label>
                  <label>
                    <span>Base currency</span>
                    <select
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          identity: {
                            ...current.identity,
                            baseCurrency: event.target.value as IdentitySettings['baseCurrency'],
                          },
                        }))
                      }
                      value={draft.identity.baseCurrency}
                    >
                      {Object.entries(currencyLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <small>Changing this recalculates every portfolio total.</small>
                  </label>
                  <label>
                    <span>Reporting timezone</span>
                    <select
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          identity: {
                            ...current.identity,
                            reportingTimezone: event.target.value,
                          },
                        }))
                      }
                      value={draft.identity.reportingTimezone}
                    >
                      <option value="Europe/Vienna">Europe/Vienna · CET/CEST</option>
                      <option value="Europe/London">Europe/London · GMT/BST</option>
                      <option value="America/New_York">America/New York · ET</option>
                      <option value="UTC">UTC</option>
                    </select>
                    <small>Controls day boundaries, schedules, and report timestamps.</small>
                  </label>
                </div>
                <div className="opset-inline-settings">
                  <SettingRow
                    description="Choose the convention used on portfolio pages and exports."
                    title="Date format"
                  >
                    <select
                      aria-label="Date format"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          identity: {
                            ...current.identity,
                            dateFormat: event.target.value as IdentitySettings['dateFormat'],
                          },
                        }))
                      }
                      value={draft.identity.dateFormat}
                    >
                      <option>DD MMM YYYY</option>
                      <option>DD.MM.YYYY</option>
                      <option>YYYY-MM-DD</option>
                    </select>
                  </SettingRow>
                  <SettingRow
                    description="Show €284.9k instead of €284,920 where space is limited."
                    title="Compact large numbers"
                  >
                    <Toggle
                      checked={draft.identity.compactNumbers}
                      label="Compact large numbers"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          identity: { ...current.identity, compactNumbers: checked },
                        }))
                      }
                    />
                  </SettingRow>
                </div>
                <footer className="opset-card__actions">
                  <button
                    className="opset-button opset-button--ghost"
                    disabled={!dirty.identity}
                    onClick={() => resetSection('identity')}
                    type="button"
                  >
                    Discard
                  </button>
                  <button
                    className="opset-button opset-button--primary"
                    data-testid="settings-save-identity"
                    disabled={!dirty.identity || !draft.identity.name.trim()}
                    onClick={saveIdentity}
                    type="button"
                  >
                    {identityDiff().length ? 'Propose identity change' : 'Save display settings'}
                  </button>
                </footer>
              </section>

              <div className="opset-grid opset-grid--two">
                <section className="opset-card">
                  <SectionHeader
                    eyebrow="Tax profile"
                    title="Austria · Individual"
                    description="Calendar-year reporting with EUR tax basis and Austrian lot rules."
                  />
                  <dl className="opset-definition-list">
                    <div>
                      <dt>Profile</dt>
                      <dd>AT individual investor</dd>
                    </div>
                    <div>
                      <dt>Fiscal year</dt>
                      <dd>01 Jan – 31 Dec</dd>
                    </div>
                    <div>
                      <dt>Basis coverage</dt>
                      <dd>96% verified</dd>
                    </div>
                  </dl>
                  <button className="opset-text-action" onClick={onOpenTax} type="button">
                    Open tax & lots
                    <Icon name="arrow-right" size={14} />
                  </button>
                </section>

                <section className="opset-card">
                  <SectionHeader
                    eyebrow="Review posture"
                    title="Risk-based approval"
                    description="Routine display changes save directly. Material changes enter Review."
                  />
                  <div className="opset-policy-summary">
                    <div>
                      <Icon name="check" size={15} />
                      <span>
                        <strong>Direct</strong>
                        <small>Display format, timezone, personal masking</small>
                      </span>
                    </div>
                    <div>
                      <Icon name="inbox" size={15} />
                      <span>
                        <strong>Review</strong>
                        <small>Calculation, authority, visibility, lifecycle</small>
                      </span>
                    </div>
                  </div>
                  <button
                    className="opset-text-action"
                    onClick={() => setView('access')}
                    type="button"
                  >
                    Configure Review policy
                    <Icon name="arrow-right" size={14} />
                  </button>
                </section>
              </div>
            </div>
          ) : null}

          {view === 'calculation' ? (
            <div className="opset-content" data-testid="settings-view-calculation">
              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Valuation & return engine"
                  title="Performance calculation"
                  description="These methods drive charts, analytics, reports, projections, and connected API output."
                  action={<Pill tone="warning">Review required</Pill>}
                />
                <div className="opset-choice-grid">
                  {(
                    Object.entries(valuationLabels) as Array<
                      [CalculationSettings['valuationMethod'], string]
                    >
                  ).map(([value, label]) => (
                    <button
                      aria-pressed={draft.calculation.valuationMethod === value}
                      className={
                        draft.calculation.valuationMethod === value ? 'is-selected' : undefined
                      }
                      key={value}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          calculation: { ...current.calculation, valuationMethod: value },
                        }))
                      }
                      type="button"
                    >
                      <span>
                        <Icon
                          name={
                            value === 'latest-close'
                              ? 'activity'
                              : value === 'provider-close'
                                ? 'link'
                                : 'sliders'
                          }
                          size={17}
                        />
                      </span>
                      <strong>{label}</strong>
                      <small>
                        {value === 'latest-close'
                          ? 'Best market close available for each asset.'
                          : value === 'provider-close'
                            ? 'Respect the close supplied by the authoritative source.'
                            : 'Hold changed values until a person approves them.'}
                      </small>
                    </button>
                  ))}
                </div>
                <div className="opset-inline-settings opset-inline-settings--divided">
                  <SettingRow
                    description="TWR isolates manager performance; IRR reflects your cash-flow timing."
                    title="Performance method"
                  >
                    <select
                      aria-label="Performance method"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          calculation: {
                            ...current.calculation,
                            performanceMethod: event.target
                              .value as CalculationSettings['performanceMethod'],
                          },
                        }))
                      }
                      value={draft.calculation.performanceMethod}
                    >
                      {Object.entries(performanceLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </SettingRow>
                  <SettingRow
                    description="Controls whether idle cash contributes to allocation and return."
                    title="Cash treatment"
                  >
                    <select
                      aria-label="Cash treatment"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          calculation: {
                            ...current.calculation,
                            cashTreatment: event.target
                              .value as CalculationSettings['cashTreatment'],
                          },
                        }))
                      }
                      value={draft.calculation.cashTreatment}
                    >
                      <option value="include">Include in total portfolio</option>
                      <option value="separate">Report as separate sleeve</option>
                      <option value="exclude">Exclude from performance</option>
                    </select>
                  </SettingRow>
                  <SettingRow
                    description="The conversion source for valuations without a transaction-specific rate."
                    title="Foreign-exchange policy"
                  >
                    <select
                      aria-label="Foreign-exchange policy"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          calculation: {
                            ...current.calculation,
                            fxMethod: event.target.value as CalculationSettings['fxMethod'],
                          },
                        }))
                      }
                      value={draft.calculation.fxMethod}
                    >
                      <option value="ecb-close">ECB daily close</option>
                      <option value="source-rate">Connected source rate</option>
                      <option value="transaction-rate">Transaction rate, then ECB</option>
                    </select>
                  </SettingRow>
                  <SettingRow
                    description="Shown beside return charts and used for relative-performance metrics."
                    title="Default benchmark"
                  >
                    <select
                      aria-label="Default benchmark"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          calculation: { ...current.calculation, benchmark: event.target.value },
                        }))
                      }
                      value={draft.calculation.benchmark}
                    >
                      <option>FTSE All-World · EUR</option>
                      <option>MSCI World · EUR</option>
                      <option>60/40 Global · EUR</option>
                      <option>No benchmark</option>
                    </select>
                  </SettingRow>
                </div>
                <div className="opset-impact-note">
                  <Icon name="activity" size={17} />
                  <div>
                    <strong>Estimated recalculation scope</strong>
                    <p>
                      2,847 ledger records · 38 holdings · 4 connected reports · no source data will
                      be overwritten.
                    </p>
                  </div>
                </div>
                <footer className="opset-card__actions">
                  <button
                    className="opset-button opset-button--ghost"
                    disabled={!dirty.calculation}
                    onClick={() => resetSection('calculation')}
                    type="button"
                  >
                    Discard
                  </button>
                  <button
                    className="opset-button opset-button--primary"
                    data-testid="settings-save-calculation"
                    disabled={!dirty.calculation}
                    onClick={saveCalculation}
                    type="button"
                  >
                    Send calculation change to Review
                  </button>
                </footer>
              </section>
            </div>
          ) : null}

          {view === 'data' ? (
            <div className="opset-content" data-testid="settings-view-data">
              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Record ownership"
                  title="Connected data"
                  description="Connected services can contribute records. This portfolio remains the boundary that resolves them."
                  action={<Pill tone="positive">Evidence preserved</Pill>}
                />
                <div className="opset-ownership-grid">
                  {[
                    {
                      value: 'bettertrack',
                      title: 'BetterTrack vault',
                      description: 'Encrypted portfolio storage with portable exports.',
                      icon: 'shield' as IconName,
                    },
                    {
                      value: 'drive',
                      title: 'Google Drive',
                      description: 'A Drive-backed ledger that you own and can inspect.',
                      icon: 'folder' as IconName,
                    },
                    {
                      value: 'device',
                      title: 'This device',
                      description: 'Local-first portfolio state with manual backups.',
                      icon: 'monitor' as IconName,
                    },
                  ].map((option) => (
                    <button
                      aria-pressed={draft.data.ownership === option.value}
                      className={draft.data.ownership === option.value ? 'is-selected' : undefined}
                      key={option.value}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          data: {
                            ...current.data,
                            ownership: option.value as DataSettings['ownership'],
                          },
                        }))
                      }
                      type="button"
                    >
                      <Icon name={option.icon} size={18} />
                      <strong>{option.title}</strong>
                      <small>{option.description}</small>
                    </button>
                  ))}
                </div>
                <div className="opset-inline-settings">
                  <SettingRow
                    description="Choose what happens when enabled sources disagree on the same field."
                    title="Conflict rule"
                  >
                    <select
                      aria-label="Conflict rule"
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          data: {
                            ...current.data,
                            conflictRule: event.target.value as DataSettings['conflictRule'],
                          },
                        }))
                      }
                      value={draft.data.conflictRule}
                    >
                      <option value="priority">Use source precedence</option>
                      <option value="newest">Use newest verified record</option>
                      <option value="manual-review">Always create a Review item</option>
                    </select>
                  </SettingRow>
                  <SettingRow
                    description="Keep the original row, document, timestamp, and source identity."
                    title="Preserve source evidence"
                  >
                    <Toggle
                      checked={draft.data.preserveSourceEvidence}
                      label="Preserve source evidence"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          data: { ...current.data, preserveSourceEvidence: checked },
                        }))
                      }
                    />
                  </SettingRow>
                </div>
              </section>

              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Source precedence"
                  title="Source precedence"
                  description="Higher sources win field-level conflicts. Every losing value remains visible in lineage."
                  action={
                    <button
                      className="opset-button opset-button--ghost"
                      onClick={onOpenConnections}
                      type="button"
                    >
                      <Icon name="link" size={14} />
                      Manage connections
                    </button>
                  }
                />
                <div className="opset-source-list">
                  {[...draft.data.sources]
                    .sort((a, b) => a.priority - b.priority)
                    .map((source, index, ordered) => (
                      <div className={!source.enabled ? 'is-disabled' : undefined} key={source.id}>
                        <span className="opset-source-list__rank">{index + 1}</span>
                        <span className="opset-source-list__icon">
                          <Icon
                            name={
                              source.kind === 'connection'
                                ? 'link'
                                : source.kind === 'import'
                                  ? 'upload'
                                  : source.kind === 'manual'
                                    ? 'sliders'
                                    : 'activity'
                            }
                            size={16}
                          />
                        </span>
                        <div className="opset-source-list__copy">
                          <strong>{source.name}</strong>
                          <p>{source.detail}</p>
                          <small>
                            {sourceKindLabels[source.kind]} · Last evidence {source.lastSeen}
                          </small>
                        </div>
                        <div className="opset-source-list__controls">
                          <button
                            aria-label={`Move ${source.name} up`}
                            disabled={index === 0}
                            onClick={() => moveSource(source.id, -1)}
                            type="button"
                          >
                            <Icon name="arrow-up" size={14} />
                          </button>
                          <button
                            aria-label={`Move ${source.name} down`}
                            disabled={index === ordered.length - 1}
                            onClick={() => moveSource(source.id, 1)}
                            type="button"
                          >
                            <Icon name="arrow-down" size={14} />
                          </button>
                          <Toggle
                            checked={source.enabled}
                            label={`${source.enabled ? 'Disable' : 'Enable'} ${source.name}`}
                            onChange={(checked) =>
                              setDraft((current) => ({
                                ...current,
                                data: {
                                  ...current.data,
                                  sources: current.data.sources.map((candidate) =>
                                    candidate.id === source.id
                                      ? { ...candidate, enabled: checked }
                                      : candidate,
                                  ),
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                    ))}
                </div>
                <footer className="opset-card__actions">
                  <button
                    className="opset-button opset-button--ghost"
                    disabled={!dirty.data}
                    onClick={() => resetSection('data')}
                    type="button"
                  >
                    Discard
                  </button>
                  <button
                    className="opset-button opset-button--primary"
                    data-testid="settings-save-data"
                    disabled={!dirty.data || enabledSources === 0}
                    onClick={saveData}
                    type="button"
                  >
                    Propose authority changes
                  </button>
                </footer>
              </section>
            </div>
          ) : null}

          {view === 'access' ? (
            <div className="opset-content" data-testid="settings-view-access">
              <div className="opset-grid opset-grid--access">
                <section className="opset-card">
                  <SectionHeader
                    eyebrow="Access summary"
                    title="4 people can access this portfolio"
                    description="Roles are portfolio-scoped. No one inherits access from another portfolio."
                  />
                  <div className="opset-member-list">
                    {[
                      ['CW', 'Chris Wiesinger', 'Owner', 'Full control'],
                      ['AL', 'Anna Leitner', 'Editor', 'Holdings and activity'],
                      ['MR', 'Martin Roth', 'Advisor', 'Propose and report'],
                      ['—', 'External auditor', 'Viewer', 'Expires 31 Aug'],
                    ].map(([initials, name, role, detail], index) => (
                      <div key={name}>
                        <span>{privateMode && index > 0 ? '••' : initials}</span>
                        <div>
                          <strong>{privateMode && index > 0 ? `Member ${index}` : name}</strong>
                          <small>{detail}</small>
                        </div>
                        <Pill tone={role === 'Owner' ? 'positive' : 'neutral'}>{role}</Pill>
                      </div>
                    ))}
                  </div>
                  <button className="opset-text-action" onClick={onOpenPeople} type="button">
                    Manage portfolio access
                    <Icon name="arrow-right" size={14} />
                  </button>
                </section>

                <section className="opset-card">
                  <SectionHeader
                    eyebrow="Effective boundary"
                    title="Private portfolio"
                    description="Only invited members can see records, files, calculations, and discussion."
                  />
                  <div className="opset-boundary-map">
                    <div>
                      <span>
                        <Icon name="portfolio" size={17} />
                      </span>
                      <strong>{portfolio.name}</strong>
                      <small>Policy boundary</small>
                    </div>
                    <i />
                    <div>
                      <span>
                        <Icon name="people" size={17} />
                      </span>
                      <strong>4 members</strong>
                      <small>Explicit access</small>
                    </div>
                    <i />
                    <div>
                      <span>
                        <Icon name="link" size={17} />
                      </span>
                      <strong>2 apps</strong>
                      <small>Scoped tokens</small>
                    </div>
                  </div>
                </section>
              </div>

              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Visibility & privacy"
                  title="Sharing and exports"
                  description="Visibility changes affect shared views and connected consumers, so they always enter Review."
                  action={<Pill tone="warning">Review required</Pill>}
                />
                <div className="opset-segmented" aria-label="Portfolio visibility">
                  {[
                    ['private', 'Private', 'Only explicit members'],
                    ['invited', 'Invite only', 'Members may invite'],
                    ['link', 'Restricted link', 'Anyone with approved link'],
                  ].map(([value, label, detail]) => (
                    <button
                      aria-pressed={draft.privacy.visibility === value}
                      className={draft.privacy.visibility === value ? 'is-selected' : undefined}
                      key={value}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          privacy: {
                            ...current.privacy,
                            visibility: value as PrivacySettings['visibility'],
                          },
                        }))
                      }
                      type="button"
                    >
                      <strong>{label}</strong>
                      <small>{detail}</small>
                    </button>
                  ))}
                </div>
                <div className="opset-inline-settings">
                  <SettingRow
                    description="Hide monetary values when members first open this portfolio."
                    title="Mask values by default"
                  >
                    <Toggle
                      checked={draft.privacy.maskByDefault}
                      label="Mask values by default"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          privacy: { ...current.privacy, maskByDefault: checked },
                        }))
                      }
                    />
                  </SettingRow>
                  <SettingRow
                    description="Allow editors and advisors to create portable portfolio exports."
                    title="Member exports"
                  >
                    <Toggle
                      checked={draft.privacy.allowExports}
                      label="Allow member exports"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          privacy: { ...current.privacy, allowExports: checked },
                        }))
                      }
                    />
                  </SettingRow>
                  <SettingRow
                    description="Include the owner name in externally shared, restricted reports."
                    title="Public attribution"
                  >
                    <Toggle
                      checked={draft.privacy.publicAttribution}
                      label="Show public attribution"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          privacy: { ...current.privacy, publicAttribution: checked },
                        }))
                      }
                    />
                  </SettingRow>
                </div>
                <footer className="opset-card__actions">
                  <button
                    className="opset-button opset-button--ghost"
                    disabled={!dirty.privacy}
                    onClick={() => resetSection('privacy')}
                    type="button"
                  >
                    Discard
                  </button>
                  <button
                    className="opset-button opset-button--primary"
                    data-testid="settings-save-privacy"
                    disabled={!dirty.privacy}
                    onClick={savePrivacy}
                    type="button"
                  >
                    Propose privacy changes
                  </button>
                </footer>
              </section>

              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Review policy"
                  title="Review policy"
                  description="The policy is evaluated before automations, imports, people, AI, or apps can mutate records."
                />
                <div className="opset-policy-builder">
                  <label>
                    <span>Approval mode</span>
                    <select
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          reviewPolicy: {
                            ...current.reviewPolicy,
                            mode: event.target.value as ReviewPolicy['mode'],
                          },
                        }))
                      }
                      value={draft.reviewPolicy.mode}
                    >
                      <option value="owner">Owner approval</option>
                      <option value="risk-based">Risk-based approval</option>
                      <option value="dual">Two-person approval</option>
                    </select>
                  </label>
                  <label>
                    <span>Amount threshold</span>
                    <div className="opset-input-prefix">
                      <i>€</i>
                      <input
                        min="0"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            reviewPolicy: {
                              ...current.reviewPolicy,
                              amountThreshold: Number(event.target.value),
                            },
                          }))
                        }
                        type="number"
                        value={draft.reviewPolicy.amountThreshold}
                      />
                    </div>
                  </label>
                  <label>
                    <span>Allocation threshold</span>
                    <div className="opset-input-prefix opset-input-prefix--suffix">
                      <input
                        max="100"
                        min="0"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            reviewPolicy: {
                              ...current.reviewPolicy,
                              allocationThreshold: Number(event.target.value),
                            },
                          }))
                        }
                        type="number"
                        value={draft.reviewPolicy.allocationThreshold}
                      />
                      <i>%</i>
                    </div>
                  </label>
                </div>
                <div className="opset-inline-settings">
                  <SettingRow
                    description="Require approval before source priority, ownership, or mapping changes."
                    title="Connected-data authority"
                  >
                    <Toggle
                      checked={draft.reviewPolicy.requireSourceChanges}
                      label="Review connected-data authority changes"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          reviewPolicy: { ...current.reviewPolicy, requireSourceChanges: checked },
                        }))
                      }
                    />
                  </SettingRow>
                  <SettingRow
                    description="Require an explicit decision for duplicate, split, and archive actions."
                    title="Portfolio lifecycle"
                  >
                    <Toggle
                      checked={draft.reviewPolicy.requireLifecycle}
                      label="Review lifecycle actions"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          reviewPolicy: { ...current.reviewPolicy, requireLifecycle: checked },
                        }))
                      }
                    />
                  </SettingRow>
                  <SettingRow
                    description="Permit fully matched stock splits and symbol changes to confirm directly."
                    title="Safe corporate actions"
                  >
                    <Toggle
                      checked={draft.reviewPolicy.allowSafeCorporateActions}
                      label="Allow safe corporate actions"
                      onChange={(checked) =>
                        setDraft((current) => ({
                          ...current,
                          reviewPolicy: {
                            ...current.reviewPolicy,
                            allowSafeCorporateActions: checked,
                          },
                        }))
                      }
                    />
                  </SettingRow>
                </div>
                <footer className="opset-card__actions">
                  <button
                    className="opset-button opset-button--ghost"
                    disabled={!dirty.reviewPolicy}
                    onClick={() => resetSection('review-policy')}
                    type="button"
                  >
                    Discard
                  </button>
                  <button
                    className="opset-button opset-button--primary"
                    data-testid="settings-save-policy"
                    disabled={!dirty.reviewPolicy}
                    onClick={savePolicy}
                    type="button"
                  >
                    Propose policy changes
                  </button>
                </footer>
              </section>
            </div>
          ) : null}

          {view === 'lifecycle' ? (
            <div className="opset-content" data-testid="settings-view-lifecycle">
              <section className="opset-lifecycle-intro">
                <div>
                  <span>Portfolio lifecycle</span>
                  <h2>Reshape without losing provenance</h2>
                  <p>
                    Copies, splits, and archives preserve source lineage, ownership, and an
                    auditable reason. Nothing happens silently.
                  </p>
                </div>
                <div className="opset-lifecycle-intro__status">
                  <Icon name="shield" size={20} />
                  <span>
                    <strong>Protected by Review</strong>
                    <small>Current portfolio remains active until approval</small>
                  </span>
                </div>
              </section>
              <div className="opset-lifecycle-grid">
                <article>
                  <span className="opset-lifecycle-grid__icon">
                    <Icon name="copy" size={19} />
                  </span>
                  <Pill>Reversible</Pill>
                  <h3>Duplicate</h3>
                  <p>
                    Create an independent working copy for a client, strategy, or clean new start.
                  </p>
                  <ul>
                    <li>Choose which history and files carry over</li>
                    <li>Connections and automations stay disconnected</li>
                    <li>Original portfolio is never changed</li>
                  </ul>
                  <button
                    className="opset-button opset-button--secondary"
                    data-testid="settings-lifecycle-duplicate"
                    onClick={() => openLifecycle('duplicate')}
                    type="button"
                  >
                    Configure duplicate
                  </button>
                </article>
                <article>
                  <span className="opset-lifecycle-grid__icon">
                    <Icon name="layers" size={19} />
                  </span>
                  <Pill tone="warning">Material change</Pill>
                  <h3>Split</h3>
                  <p>
                    Move a coherent sleeve into a separately managed portfolio with its history.
                  </p>
                  <ul>
                    <li>Preview assets, lots, and cash attribution</li>
                    <li>Preserve cross-portfolio transfer lineage</li>
                    <li>Recalculate both portfolios after approval</li>
                  </ul>
                  <button
                    className="opset-button opset-button--secondary"
                    data-testid="settings-lifecycle-split"
                    onClick={() => openLifecycle('split')}
                    type="button"
                  >
                    Configure split
                  </button>
                </article>
                <article className="opset-lifecycle-grid__danger">
                  <span className="opset-lifecycle-grid__icon">
                    <Icon name="trash" size={19} />
                  </span>
                  <Pill tone="danger">Restricted</Pill>
                  <h3>Archive</h3>
                  <p>
                    Retire this portfolio from active work while preserving every record and file.
                  </p>
                  <ul>
                    <li>Stops schedules, syncs, and write access</li>
                    <li>Keeps reports, evidence, and receipts</li>
                    <li>Restore remains an owner-only Review action</li>
                  </ul>
                  <button
                    className="opset-button opset-button--danger"
                    data-testid="settings-lifecycle-archive"
                    onClick={() => openLifecycle('archive')}
                    type="button"
                  >
                    Prepare archive
                  </button>
                </article>
              </div>
            </div>
          ) : null}

          {view === 'audit' ? (
            <div className="opset-content" data-testid="settings-view-audit">
              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Pending proposals"
                  title={`${pendingCount} portfolio change${pendingCount === 1 ? '' : 's'} waiting`}
                  description="Review is the shared decision point. This page records what was proposed and why."
                  action={
                    <button
                      className="opset-button opset-button--primary"
                      onClick={onOpenReview}
                      type="button"
                    >
                      <Icon name="inbox" size={14} />
                      Open Review
                    </button>
                  }
                />
                {state.proposals.length ? (
                  <div className="opset-proposal-list">
                    {state.proposals.map((proposal) => (
                      <button key={proposal.id} onClick={onOpenReview} type="button">
                        <span className={`opset-risk opset-risk--${proposal.risk}`} />
                        <div>
                          <strong>{proposal.title}</strong>
                          <p>{proposal.summary}</p>
                          <small>
                            {new Intl.DateTimeFormat('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(new Date(proposal.submittedAt))}
                            {' · '}
                            {proposal.reference}
                          </small>
                        </div>
                        <Pill tone="warning">Waiting</Pill>
                        <Icon name="chevron-right" size={15} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="opset-empty">
                    <span>
                      <Icon name="check" size={19} />
                    </span>
                    <strong>No portfolio settings are waiting</strong>
                    <p>Material changes will appear here and in the shared Review inbox.</p>
                  </div>
                )}
              </section>
              <section className="opset-card opset-card--wide">
                <SectionHeader
                  eyebrow="Audit trail"
                  title="Settings audit"
                  description="Local demo receipts preserve actor, time, reason, scope, and a stable reference."
                />
                <div className="opset-audit-list">
                  {state.audit.map((event) => (
                    <div key={event.id}>
                      <span
                        className={`opset-audit-list__mark opset-audit-list__mark--${event.tone}`}
                      >
                        <Icon
                          name={
                            event.tone === 'success'
                              ? 'check'
                              : event.tone === 'warning'
                                ? 'clock'
                                : 'activity'
                          }
                          size={13}
                        />
                      </span>
                      <div>
                        <strong>{event.action}</strong>
                        <p>{event.detail}</p>
                        <small>
                          {new Intl.DateTimeFormat('en-GB', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          }).format(new Date(event.at))}
                          {' · '}
                          {event.actor} · {event.reference}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}
        </main>
      </div>

      {dialog ? (
        <div className="opset-modal-layer" data-accessible-dialog-layer>
          <section
            aria-labelledby="opset-confirmation-title"
            aria-modal="true"
            className="opset-modal"
            data-testid="settings-confirm-dialog"
            ref={confirmationRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div>
                <span>
                  {dialog.kind === 'lifecycle' ? 'Lifecycle confirmation' : 'Settings confirmation'}
                </span>
                <h2 id="opset-confirmation-title">{dialog.title}</h2>
              </div>
              <button aria-label="Close confirmation" onClick={() => setDialog(null)} type="button">
                <Icon name="x" size={16} />
              </button>
            </header>
            <form onSubmit={submitReview}>
              <div className="opset-modal__intro">
                <span
                  className={`opset-modal__icon ${
                    dialog.risk === 'high' ? 'opset-modal__icon--warning' : ''
                  }`}
                >
                  <Icon
                    name={
                      dialog.kind === 'lifecycle'
                        ? dialog.action === 'archive'
                          ? 'trash'
                          : 'layers'
                        : 'settings'
                    }
                    size={20}
                  />
                </span>
                <div>
                  <strong>Current portfolio stays unchanged</strong>
                  <p>{dialog.summary}</p>
                </div>
              </div>

              {dialog.kind === 'settings' ? (
                <div className="opset-diff-list">
                  {dialog.diff.map((item) => (
                    <div key={item.label}>
                      <span>{item.label}</span>
                      <del>{item.before}</del>
                      <Icon name="arrow-right" size={13} />
                      <ins>{item.after}</ins>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="opset-modal__fields">
                  {dialog.action !== 'archive' ? (
                    <label>
                      <span>New portfolio name</span>
                      <input
                        data-autofocus
                        onChange={(event) =>
                          setDialog((current) =>
                            current?.kind === 'lifecycle'
                              ? { ...current, destinationName: event.target.value }
                              : current,
                          )
                        }
                        required
                        value={dialog.destinationName}
                      />
                    </label>
                  ) : null}
                  {dialog.action === 'split' ? (
                    <label>
                      <span>Split method</span>
                      <select
                        onChange={(event) =>
                          setDialog((current) =>
                            current?.kind === 'lifecycle'
                              ? {
                                  ...current,
                                  splitRule: event.target.value as Extract<
                                    ConfirmationDialog,
                                    { kind: 'lifecycle' }
                                  >['splitRule'],
                                }
                              : current,
                          )
                        }
                        value={dialog.splitRule}
                      >
                        <option value="selected-assets">Selected assets and linked history</option>
                        <option value="allocation">Percentage allocation across all assets</option>
                        <option value="empty-shell">Empty structure only</option>
                      </select>
                    </label>
                  ) : null}
                  <div className="opset-consequence-list">
                    <strong>What happens after approval</strong>
                    <ul>
                      {dialog.action === 'duplicate' ? (
                        <>
                          <li>A new independent portfolio and copy receipt are created.</li>
                          <li>
                            Connections, people, and automations are not copied automatically.
                          </li>
                          <li>This portfolio remains unchanged.</li>
                        </>
                      ) : dialog.action === 'split' ? (
                        <>
                          <li>A preview must balance source and destination before application.</li>
                          <li>Lots, documents, and activity lineage move with selected assets.</li>
                          <li>Both portfolios receive linked, zero-net transfer receipts.</li>
                        </>
                      ) : (
                        <>
                          <li>All writes, schedules, and connection syncs stop.</li>
                          <li>The portfolio becomes read-only and leaves active navigation.</li>
                          <li>Records, files, permissions, and audit evidence remain intact.</li>
                        </>
                      )}
                    </ul>
                  </div>
                  {dialog.action === 'archive' ? (
                    <label>
                      <span>Type ARCHIVE to confirm intent</span>
                      <input
                        data-autofocus
                        onChange={(event) =>
                          setDialog((current) =>
                            current?.kind === 'lifecycle'
                              ? { ...current, archivePhrase: event.target.value }
                              : current,
                          )
                        }
                        placeholder="ARCHIVE"
                        value={dialog.archivePhrase}
                      />
                    </label>
                  ) : null}
                </div>
              )}

              <label className="opset-reason">
                <span>Reason for this change</span>
                <textarea
                  data-autofocus={dialog.kind === 'settings' ? true : undefined}
                  data-testid="settings-reason"
                  onChange={(event) =>
                    setDialog((current) =>
                      current ? { ...current, reason: event.target.value } : current,
                    )
                  }
                  placeholder="Explain the intended outcome for reviewers and future audit."
                  rows={3}
                  value={dialog.reason}
                />
                <small>Required · at least 8 characters · included on the receipt</small>
              </label>
              <label className="opset-consent">
                <input
                  checked={dialog.consent}
                  data-testid="settings-consent"
                  onChange={(event) =>
                    setDialog((current) =>
                      current ? { ...current, consent: event.target.checked } : current,
                    )
                  }
                  type="checkbox"
                />
                <span>
                  <strong>I reviewed the scope and consequences</strong>
                  <small>No live portfolio state changes until Review approval.</small>
                </span>
              </label>
              <footer>
                <button
                  className="opset-button opset-button--ghost"
                  onClick={() => setDialog(null)}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className={
                    dialog.kind === 'lifecycle' && dialog.action === 'archive'
                      ? 'opset-button opset-button--danger'
                      : 'opset-button opset-button--primary'
                  }
                  data-testid="settings-submit-review"
                  disabled={
                    dialog.reason.trim().length < 8 ||
                    !dialog.consent ||
                    (dialog.kind === 'lifecycle' &&
                      dialog.action !== 'archive' &&
                      !dialog.destinationName.trim()) ||
                    (dialog.kind === 'lifecycle' &&
                      dialog.action === 'archive' &&
                      dialog.archivePhrase.trim().toUpperCase() !== 'ARCHIVE')
                  }
                  type="submit"
                >
                  <Icon name="inbox" size={14} />
                  Send to Review
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}

      {lastReceipt ? (
        <aside
          aria-live="polite"
          className="opset-receipt"
          data-testid="settings-receipt"
          role="status"
        >
          <span>
            <Icon name={lastReceipt.type === 'direct-save' ? 'check' : 'inbox'} size={16} />
          </span>
          <div>
            <strong>
              {lastReceipt.type === 'direct-save' ? 'Settings saved' : 'Proposal recorded'}
            </strong>
            <p>{lastReceipt.summary}</p>
            <small>
              {lastReceipt.reference} · {nowLabel()}
            </small>
          </div>
          {lastReceipt.type === 'review-submitted' ? (
            <button
              onClick={() => {
                setLastReceipt(null);
                onOpenReview();
              }}
              type="button"
            >
              Open Review
            </button>
          ) : null}
          <button aria-label="Dismiss receipt" onClick={() => setLastReceipt(null)} type="button">
            <Icon name="x" size={14} />
          </button>
        </aside>
      ) : null}
    </div>
  );
}
