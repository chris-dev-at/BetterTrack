import { useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-connections.css';

export type OriginConnectionCategory = 'broker' | 'portfolio-service' | 'storage' | 'bank';
export type OriginConnectionStatus =
  | 'healthy'
  | 'attention'
  | 'paused'
  | 'syncing'
  | 'disconnected';
export type OriginConnectionSyncMode =
  | 'continuous-import'
  | 'manual-import'
  | 'export'
  | 'two-way'
  | 'data-home'
  | 'backup'
  | 'watched-import'
  | 'files'
  | 'read-only-cash';

export type OriginConnectionLog = {
  id: string;
  timestamp: string;
  event: string;
  detail: string;
  status: 'success' | 'warning' | 'error' | 'info';
  records?: number;
  durationMs?: number;
};

export type OriginConnectionConflict = {
  id: string;
  field: string;
  asset: string;
  sourceValue: string;
  betterTrackValue: string;
  reason: string;
  status: 'open' | 'use-source' | 'keep-bettertrack' | 'ignored';
};

export type OriginConnectionRecord = {
  id: string;
  provider: {
    id: OriginProviderId;
    name: string;
    category: OriginConnectionCategory;
  };
  portfolio: {
    id?: string;
    name: string;
  };
  status: OriginConnectionStatus;
  syncMode: OriginConnectionSyncMode;
  sourceAccount: string;
  sourceWorkspace?: string;
  driveRole?: 'data-home' | 'backup' | 'files' | 'watched-import';
  permissions: string[];
  createdAt: string;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  health: {
    score: number;
    records: number;
    coverage: number;
    costBasisCoverage: number;
    reconciledValue: number;
    sourceValue: number;
    unsupportedFields: string[];
    missingCostBasis: number;
    openConflicts: number;
  };
  logs: OriginConnectionLog[];
  conflicts: OriginConnectionConflict[];
};

export type OriginConnectionChange = {
  type:
    | 'created'
    | 'updated'
    | 'sync-started'
    | 'sync-completed'
    | 'paused'
    | 'resumed'
    | 'reconnected'
    | 'disconnected'
    | 'conflict-resolved';
  connection: OriginConnectionRecord;
};

export type OriginConnectionPortfolio = {
  id?: string;
  name: string;
  currency?: string;
};

export type OriginConnectionsProps = {
  portfolio: OriginConnectionPortfolio | string;
  connections?: OriginConnectionRecord[];
  onChange: (change: OriginConnectionChange) => void;
  onClose: () => void;
  onOpenDeveloper?: () => void;
};

export type OriginProviderId =
  | 'trade-republic'
  | 'flatex'
  | 'ibkr'
  | 'parqet'
  | 'google-drive'
  | 'erste'
  | 'n26'
  | 'revolut'
  | 'wise';

type ProviderDefinition = {
  id: OriginProviderId;
  name: string;
  initials: string;
  category: OriginConnectionCategory;
  description: string;
  support: string;
  accent: string;
  capabilities: string[];
  permissions: string[];
  accounts: string[];
  beta?: boolean;
};

type View = 'list' | 'detail' | 'add';
type DetailTab = 'overview' | 'mapping' | 'activity' | 'conflicts';
type AddStep =
  | 'provider'
  | 'permissions'
  | 'authenticate'
  | 'account'
  | 'mapping'
  | 'direction'
  | 'stage'
  | 'review';
type Filter = 'all' | 'healthy' | 'attention' | 'paused';

const providerDefinitions: ProviderDefinition[] = [
  {
    id: 'trade-republic',
    name: 'Trade Republic',
    initials: 'TR',
    category: 'broker',
    description: 'Holdings, trades, savings plans, cash and income.',
    support: 'Continuous read-only OAuth',
    accent: '#f2f2ee',
    capabilities: ['Transactions', 'Positions', 'Cash', 'Income'],
    permissions: [
      'Read securities accounts and current positions',
      'Read completed orders, savings plans and fees',
      'Read cash balance, deposits, withdrawals and income',
      'Refresh this data until you revoke consent',
    ],
    accounts: ['Main securities account · ••1842', 'Crypto account · ••1842'],
    beta: true,
  },
  {
    id: 'flatex',
    name: 'Flatex',
    initials: 'FL',
    category: 'broker',
    description: 'Securities, cash accounts, orders and dividends.',
    support: 'Continuous read-only OAuth',
    accent: '#f39b38',
    capabilities: ['Transactions', 'Positions', 'Cash', 'Tax lots'],
    permissions: [
      'Read linked securities and cash accounts',
      'Read executed orders, fees and tax bookings',
      'Read current holdings and acquisition values',
      'Refresh this data until you revoke consent',
    ],
    accounts: ['Depot AT · ••9204', 'Cash account EUR · ••3811'],
  },
  {
    id: 'ibkr',
    name: 'Interactive Brokers',
    initials: 'IB',
    category: 'broker',
    description: 'Multi-currency portfolios, activity and corporate actions.',
    support: 'Flex OAuth · read-only',
    accent: '#e54d4d',
    capabilities: ['Transactions', 'Positions', 'FX', 'Corporate actions'],
    permissions: [
      'Read portfolio positions and account values',
      'Read activity statements and corporate actions',
      'Read multi-currency cash balances and conversions',
      'Create read-only Flex queries for future syncs',
    ],
    accounts: ['Individual · U•••731', 'Joint · U•••804'],
  },
  {
    id: 'parqet',
    name: 'Parqet',
    initials: 'PQ',
    category: 'portfolio-service',
    description: 'Connect an existing portfolio or keep two systems aligned.',
    support: 'Import, export or two-way',
    accent: '#8866f2',
    capabilities: ['Portfolios', 'Transactions', 'Cash', 'Two-way'],
    permissions: [
      'List portfolios available in your Parqet workspace',
      'Read holdings, transactions and cash bookings',
      'Write only if export or two-way sync is selected',
      'Read sync metadata to detect duplicates and conflicts',
    ],
    accounts: ['Personal wealth', 'Long-term ETF', 'Family portfolio'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    initials: 'GD',
    category: 'storage',
    description: 'Use Drive as a data home, backup, file library or watched inbox.',
    support: 'Four explicit storage roles',
    accent: '#4ca45d',
    capabilities: ['Data home', 'Backup', 'Files', 'Watched import'],
    permissions: [
      'Create and manage the BetterTrack folder you select',
      'Read only files BetterTrack created or you explicitly choose',
      'Watch an import folder only when that role is selected',
      'Never scan unrelated Drive content',
    ],
    accounts: ['alex@example.com', 'finance@northstar.at'],
  },
  {
    id: 'erste',
    name: 'Erste / Sparkasse',
    initials: 'ES',
    category: 'bank',
    description: 'Read-only cash balances and booked transactions.',
    support: 'PSD2 consent · 90 days',
    accent: '#e34f4f',
    capabilities: ['Cash', 'Transactions', 'Recurring detection'],
    permissions: [
      'Read selected account names, currencies and balances',
      'Read booked and pending cash transactions',
      'Refresh consented data for up to 90 days',
      'Never initiate transfers or payments',
    ],
    accounts: ['Girokonto · ••4821', 'Sparkonto · ••1990'],
  },
  {
    id: 'n26',
    name: 'N26',
    initials: 'N2',
    category: 'bank',
    description: 'Cash accounts, spaces and transaction history.',
    support: 'PSD2 consent · 90 days',
    accent: '#5fd5c2',
    capabilities: ['Cash', 'Spaces', 'Transactions'],
    permissions: [
      'Read selected account and Space balances',
      'Read booked and pending cash transactions',
      'Refresh consented data for up to 90 days',
      'Never initiate transfers or payments',
    ],
    accounts: ['Main account · ••0062', 'Taxes space · ••3174'],
  },
  {
    id: 'revolut',
    name: 'Revolut',
    initials: 'RV',
    category: 'bank',
    description: 'Multi-currency cash and exchange transactions.',
    support: 'Open Banking · read-only',
    accent: '#4d8df5',
    capabilities: ['Cash', 'FX', 'Transactions'],
    permissions: [
      'Read selected multi-currency balances',
      'Read booked transactions and currency exchanges',
      'Refresh consented data until consent expires',
      'Never initiate transfers or payments',
    ],
    accounts: ['Personal · EUR', 'Personal · USD', 'Savings · EUR'],
  },
  {
    id: 'wise',
    name: 'Wise',
    initials: 'WS',
    category: 'bank',
    description: 'Multi-currency balances, transfers and exchange fees.',
    support: 'Read-only account token',
    accent: '#9fe870',
    capabilities: ['Cash', 'FX', 'Transfers'],
    permissions: [
      'Read selected currency balances',
      'Read completed transfers and exchange fees',
      'Refresh this data until you revoke consent',
      'Never create or fund transfers',
    ],
    accounts: ['Personal balances · ••1007', 'Business balances · ••9240'],
  },
];

const addSteps: Array<{ id: AddStep; label: string }> = [
  { id: 'provider', label: 'Provider' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'authenticate', label: 'Connect' },
  { id: 'account', label: 'Account' },
  { id: 'mapping', label: 'Map' },
  { id: 'direction', label: 'Sync' },
  { id: 'stage', label: 'Stage' },
  { id: 'review', label: 'Review' },
];

const categoryLabels: Record<OriginConnectionCategory, string> = {
  broker: 'Broker',
  'portfolio-service': 'Portfolio service',
  storage: 'Storage',
  bank: 'Bank cash',
};

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function normalPortfolio(
  portfolio: OriginConnectionsProps['portfolio'],
): OriginConnectionPortfolio {
  return typeof portfolio === 'string'
    ? { name: portfolio, currency: 'EUR' }
    : { currency: 'EUR', ...portfolio };
}

function nowMinus(minutes: number) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function nowPlus(minutes: number) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

function id(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function createOriginSeedConnections(
  portfolio: OriginConnectionPortfolio,
): OriginConnectionRecord[] {
  return [
    {
      id: 'conn_tr_demo',
      provider: { id: 'trade-republic', name: 'Trade Republic', category: 'broker' },
      portfolio: { id: portfolio.id, name: portfolio.name },
      status: 'healthy',
      syncMode: 'continuous-import',
      sourceAccount: 'Main securities account · ••1842',
      permissions: providerDefinitions[0]!.permissions,
      createdAt: nowMinus(43200),
      lastSyncAt: nowMinus(18),
      nextSyncAt: nowPlus(42),
      health: {
        score: 96,
        records: 847,
        coverage: 99,
        costBasisCoverage: 97,
        reconciledValue: 82340.16,
        sourceValue: 82340.16,
        unsupportedFields: ['Broker savings-plan labels'],
        missingCostBasis: 3,
        openConflicts: 0,
      },
      logs: [
        {
          id: 'log_tr_1',
          timestamp: nowMinus(18),
          event: 'Scheduled sync completed',
          detail: '4 new records · 839 unchanged · 4 enriched',
          status: 'success',
          records: 847,
          durationMs: 2380,
        },
        {
          id: 'log_tr_2',
          timestamp: nowMinus(1440),
          event: 'Cost basis enriched',
          detail: 'Matched 2 fractional savings-plan executions.',
          status: 'success',
          records: 2,
          durationMs: 940,
        },
        {
          id: 'log_tr_3',
          timestamp: nowMinus(2880),
          event: 'Unsupported field ignored',
          detail: 'Broker-native savings-plan labels have no portable equivalent.',
          status: 'warning',
        },
      ],
      conflicts: [],
    },
    {
      id: 'conn_drive_demo',
      provider: { id: 'google-drive', name: 'Google Drive', category: 'storage' },
      portfolio: { id: portfolio.id, name: portfolio.name },
      status: 'healthy',
      syncMode: 'backup',
      driveRole: 'backup',
      sourceAccount: 'alex@example.com',
      sourceWorkspace: '/BetterTrack/Backups',
      permissions: providerDefinitions[4]!.permissions,
      createdAt: nowMinus(20160),
      lastSyncAt: nowMinus(420),
      nextSyncAt: nowPlus(1020),
      health: {
        score: 100,
        records: 14,
        coverage: 100,
        costBasisCoverage: 100,
        reconciledValue: 128430.2,
        sourceValue: 128430.2,
        unsupportedFields: [],
        missingCostBasis: 0,
        openConflicts: 0,
      },
      logs: [
        {
          id: 'log_drive_1',
          timestamp: nowMinus(420),
          event: 'Encrypted backup created',
          detail: 'Snapshot bt-2026-07-27-0200.enc · 4.2 MB',
          status: 'success',
          records: 14,
          durationMs: 1180,
        },
      ],
      conflicts: [],
    },
    {
      id: 'conn_parqet_demo',
      provider: { id: 'parqet', name: 'Parqet', category: 'portfolio-service' },
      portfolio: { id: portfolio.id, name: portfolio.name },
      status: 'attention',
      syncMode: 'two-way',
      sourceAccount: 'Personal wealth',
      permissions: providerDefinitions[3]!.permissions,
      createdAt: nowMinus(10080),
      lastSyncAt: nowMinus(95),
      nextSyncAt: null,
      health: {
        score: 78,
        records: 1264,
        coverage: 94,
        costBasisCoverage: 91,
        reconciledValue: 128430.2,
        sourceValue: 128512.7,
        unsupportedFields: ['Custom asset icon', 'Parqet dashboard grouping'],
        missingCostBasis: 8,
        openConflicts: 2,
      },
      logs: [
        {
          id: 'log_pq_1',
          timestamp: nowMinus(95),
          event: 'Sync paused for review',
          detail: '2 records were changed in both systems.',
          status: 'warning',
          records: 1264,
          durationMs: 3620,
        },
        {
          id: 'log_pq_2',
          timestamp: nowMinus(1540),
          event: 'Two-way sync completed',
          detail: '11 imported · 3 exported · 1,248 unchanged',
          status: 'success',
          records: 1262,
          durationMs: 3410,
        },
      ],
      conflicts: [
        {
          id: 'conflict_pq_1',
          field: 'Quantity',
          asset: 'Vanguard FTSE All-World',
          sourceValue: '312.487 units',
          betterTrackValue: '312.480 units',
          reason: 'A fractional fill was edited after the previous sync.',
          status: 'open',
        },
        {
          id: 'conflict_pq_2',
          field: 'Transaction note',
          asset: 'Apple Inc.',
          sourceValue: 'Savings plan',
          betterTrackValue: 'Long-term allocation',
          reason: 'The note changed in both systems.',
          status: 'open',
        },
      ],
    },
    {
      id: 'conn_bank_demo',
      provider: { id: 'erste', name: 'Erste / Sparkasse', category: 'bank' },
      portfolio: { id: portfolio.id, name: portfolio.name },
      status: 'paused',
      syncMode: 'read-only-cash',
      sourceAccount: 'Girokonto · ••4821',
      permissions: providerDefinitions[5]!.permissions,
      createdAt: nowMinus(129600),
      lastSyncAt: nowMinus(10080),
      nextSyncAt: null,
      health: {
        score: 63,
        records: 392,
        coverage: 100,
        costBasisCoverage: 100,
        reconciledValue: 14609.76,
        sourceValue: 14609.76,
        unsupportedFields: ['Pending card merchant logo'],
        missingCostBasis: 0,
        openConflicts: 0,
      },
      logs: [
        {
          id: 'log_bank_1',
          timestamp: nowMinus(10080),
          event: 'Connection paused',
          detail: 'Paused manually by Alex Morgan.',
          status: 'info',
        },
        {
          id: 'log_bank_2',
          timestamp: nowMinus(11520),
          event: 'Cash sync completed',
          detail: '18 new movements · recurring patterns updated',
          status: 'success',
          records: 392,
          durationMs: 1820,
        },
      ],
      conflicts: [],
    },
  ];
}

function ProviderMark({
  provider,
  small = false,
}: {
  provider: ProviderDefinition;
  small?: boolean;
}) {
  return (
    <span
      className={cn('ocn-provider-mark', small && 'ocn-provider-mark--small')}
      style={{ '--provider-color': provider.accent } as React.CSSProperties}
    >
      {provider.initials}
    </span>
  );
}

function Button({
  children,
  icon,
  kind = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button className={cn('ocn-button', `ocn-button--${kind}`)} type="button" {...props}>
      {icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

function Status({ status, label }: { status: OriginConnectionStatus; label?: string }) {
  return (
    <span className={cn('ocn-status', `ocn-status--${status}`)}>
      <i />
      {label || status}
    </span>
  );
}

export function OriginConnections({
  portfolio: portfolioInput,
  connections: providedConnections,
  onChange,
  onClose,
  onOpenDeveloper,
}: OriginConnectionsProps) {
  const portfolio = useMemo(() => normalPortfolio(portfolioInput), [portfolioInput]);
  const [connections, setConnections] = useState<OriginConnectionRecord[]>(() =>
    providedConnections?.length ? providedConnections : createOriginSeedConnections(portfolio),
  );
  const [view, setView] = useState<View>('list');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [actionMenu, setActionMenu] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [toast, setToast] = useState('');
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const [addStep, setAddStep] = useState<AddStep>('provider');
  const [providerId, setProviderId] = useState<OriginProviderId | null>(null);
  const [providerSearch, setProviderSearch] = useState('');
  const [category, setCategory] = useState<'all' | OriginConnectionCategory>('all');
  const [permissionAccepted, setPermissionAccepted] = useState(false);
  const [authProgress, setAuthProgress] = useState(0);
  const [sourceAccount, setSourceAccount] = useState('');
  const [sourceWorkspace, setSourceWorkspace] = useState('');
  const [targetPortfolio, setTargetPortfolio] = useState(portfolio.name);
  const [mappingStrategy, setMappingStrategy] = useState<'merge' | 'replace' | 'new'>('merge');
  const [syncMode, setSyncMode] = useState<OriginConnectionSyncMode>('continuous-import');
  const [driveRole, setDriveRole] = useState<OriginConnectionRecord['driveRole']>('backup');
  const [stageProgress, setStageProgress] = useState(0);
  const [stageComplete, setStageComplete] = useState(false);
  const [stageApproved, setStageApproved] = useState(false);
  const [error, setError] = useState('');

  const selected = connections.find((connection) => connection.id === selectedId) ?? null;
  const provider = providerDefinitions.find((item) => item.id === providerId) ?? null;
  const addIndex = addSteps.findIndex((step) => step.id === addStep);

  const visibleConnections = connections.filter((connection) => {
    const matchesSearch =
      !search ||
      `${connection.provider.name} ${connection.sourceAccount} ${connection.portfolio.name}`
        .toLowerCase()
        .includes(search.toLowerCase());
    const matchesFilter =
      filter === 'all' ||
      connection.status === filter ||
      (filter === 'attention' && connection.status === 'disconnected');
    return matchesSearch && matchesFilter;
  });

  const filteredProviders = providerDefinitions.filter((item) => {
    const matchesCategory = category === 'all' || item.category === category;
    const matchesSearch =
      !providerSearch ||
      `${item.name} ${item.description} ${item.capabilities.join(' ')}`
        .toLowerCase()
        .includes(providerSearch.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  function updateConnection(
    connectionId: string,
    updater: (record: OriginConnectionRecord) => OriginConnectionRecord,
    type: OriginConnectionChange['type'],
  ) {
    const current = connections.find((record) => record.id === connectionId);
    if (!current) return;
    const next = updater(current);
    setConnections((records) =>
      records.map((record) => (record.id === connectionId ? next : record)),
    );
    onChange({ type, connection: next });
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(''), 2300);
  }

  function openDetail(connectionId: string, tab: DetailTab = 'overview') {
    setSelectedId(connectionId);
    setDetailTab(tab);
    setView('detail');
    setActionMenu(false);
    setDisconnectConfirm(false);
  }

  function startAdd(preselect?: OriginProviderId) {
    setProviderId(preselect ?? null);
    setAddStep(preselect ? 'permissions' : 'provider');
    setPermissionAccepted(false);
    setAuthProgress(0);
    setSourceAccount('');
    setSourceWorkspace('');
    setTargetPortfolio(portfolio.name);
    setMappingStrategy('merge');
    setStageProgress(0);
    setStageComplete(false);
    setStageApproved(false);
    setError('');
    setView('add');
  }

  function selectProvider(next: OriginProviderId) {
    const definition = providerDefinitions.find((item) => item.id === next)!;
    setProviderId(next);
    setPermissionAccepted(false);
    setSourceAccount('');
    setDriveRole(definition.category === 'storage' ? 'backup' : undefined);
    setSyncMode(defaultSyncMode(definition, 'backup'));
    setError('');
  }

  useEffect(() => {
    if (addStep !== 'authenticate' || authProgress <= 0 || authProgress >= 100) return;
    const timer = window.setInterval(() => {
      setAuthProgress((progress) => Math.min(100, progress + 8));
    }, 130);
    return () => window.clearInterval(timer);
  }, [addStep, authProgress]);

  useEffect(() => {
    if (addStep !== 'stage' || stageProgress <= 0 || stageProgress >= 100) return;
    const timer = window.setInterval(() => {
      setStageProgress((progress) => {
        const next = Math.min(100, progress + 5);
        if (next === 100) setStageComplete(true);
        return next;
      });
    }, 145);
    return () => window.clearInterval(timer);
  }, [addStep, stageProgress]);

  useEffect(() => {
    if (!syncingId) return;
    const timer = window.setTimeout(() => {
      updateConnection(
        syncingId,
        (record) => ({
          ...record,
          status: record.health.openConflicts ? 'attention' : 'healthy',
          lastSyncAt: new Date().toISOString(),
          nextSyncAt: nowPlus(60),
          logs: [
            {
              id: id('log'),
              timestamp: new Date().toISOString(),
              event: 'Manual sync completed',
              detail: 'Source checked · 3 new · 2 enriched · no duplicates',
              status: 'success',
              records: record.health.records + 3,
              durationMs: 2170,
            },
            ...record.logs,
          ],
          health: { ...record.health, records: record.health.records + 3 },
        }),
        'sync-completed',
      );
      setSyncingId(null);
      notify('Sync completed successfully');
    }, 1900);
    return () => window.clearTimeout(timer);
  }, [syncingId]);

  function validateAdd() {
    switch (addStep) {
      case 'provider':
        return provider ? '' : 'Choose a provider to continue.';
      case 'permissions':
        return permissionAccepted ? '' : 'Confirm the requested read permissions.';
      case 'authenticate':
        return authProgress >= 100 ? '' : 'Finish the simulated provider authorization.';
      case 'account':
        return sourceAccount ? '' : 'Choose at least one source account.';
      case 'mapping':
        if (!targetPortfolio.trim()) return 'Choose a target portfolio.';
        if (provider?.id === 'google-drive' && !sourceWorkspace.trim())
          return 'Choose a Drive folder.';
        return '';
      case 'stage':
        if (!stageComplete) return 'Run the staged sync first.';
        if (!stageApproved) return 'Approve the staged result.';
        return '';
      default:
        return '';
    }
  }

  function addNext() {
    const message = validateAdd();
    if (message) {
      setError(message);
      return;
    }
    const next = addSteps[addIndex + 1];
    if (next) {
      setAddStep(next.id);
      setError('');
    }
  }

  function addBack() {
    const previous = addSteps[addIndex - 1];
    if (previous) {
      setAddStep(previous.id);
      setError('');
    } else {
      setView('list');
    }
  }

  function createConnection() {
    if (!provider) return;
    const records =
      provider.category === 'broker'
        ? 847
        : provider.id === 'parqet'
          ? 1264
          : provider.category === 'bank'
            ? 392
            : 14;
    const sourceValue = provider.category === 'bank' ? 14609.76 : 128430.2;
    const connection: OriginConnectionRecord = {
      id: id('conn'),
      provider: {
        id: provider.id,
        name: provider.name,
        category: provider.category,
      },
      portfolio: {
        id: targetPortfolio === portfolio.name ? portfolio.id : undefined,
        name: targetPortfolio,
      },
      status: 'healthy',
      syncMode,
      sourceAccount,
      sourceWorkspace: sourceWorkspace || undefined,
      driveRole,
      permissions: provider.permissions,
      createdAt: new Date().toISOString(),
      lastSyncAt: new Date().toISOString(),
      nextSyncAt: syncMode === 'manual-import' || syncMode === 'export' ? null : nowPlus(60),
      health: {
        score: provider.id === 'parqet' ? 94 : 98,
        records,
        coverage: provider.id === 'parqet' ? 97 : 99,
        costBasisCoverage: provider.category === 'broker' ? 97 : 100,
        reconciledValue: sourceValue,
        sourceValue,
        unsupportedFields:
          provider.id === 'parqet'
            ? ['Custom dashboard groups']
            : provider.category === 'broker'
              ? ['Provider-native labels']
              : [],
        missingCostBasis: provider.category === 'broker' ? 3 : 0,
        openConflicts: 0,
      },
      logs: [
        {
          id: id('log'),
          timestamp: new Date().toISOString(),
          event: 'Initial staged sync applied',
          detail: `${records.toLocaleString()} source records mapped to ${targetPortfolio}.`,
          status: 'success',
          records,
          durationMs: 4230,
        },
        {
          id: id('log'),
          timestamp: nowMinus(3),
          event: 'Connection authorized',
          detail: `${sourceAccount} granted ${provider.permissions.length} read scopes.`,
          status: 'info',
        },
      ],
      conflicts: [],
    };
    setConnections((current) => [connection, ...current]);
    onChange({ type: 'created', connection });
    setSelectedId(connection.id);
    setDetailTab('overview');
    setView('detail');
    notify(`${provider.name} connected`);
  }

  function syncNow(connection: OriginConnectionRecord) {
    if (connection.status === 'paused' || connection.status === 'disconnected') return;
    setSyncingId(connection.id);
    updateConnection(connection.id, (record) => ({ ...record, status: 'syncing' }), 'sync-started');
  }

  function togglePause(connection: OriginConnectionRecord) {
    const resume = connection.status === 'paused';
    updateConnection(
      connection.id,
      (record) => ({
        ...record,
        status: resume ? (record.health.openConflicts ? 'attention' : 'healthy') : 'paused',
        nextSyncAt: resume ? nowPlus(60) : null,
        logs: [
          {
            id: id('log'),
            timestamp: new Date().toISOString(),
            event: resume ? 'Connection resumed' : 'Connection paused',
            detail: resume
              ? 'Scheduled synchronization is active.'
              : 'No source data will be read until resumed.',
            status: 'info',
          },
          ...record.logs,
        ],
      }),
      resume ? 'resumed' : 'paused',
    );
    setActionMenu(false);
    notify(resume ? 'Connection resumed' : 'Connection paused');
  }

  function reconnect(connection: OriginConnectionRecord) {
    updateConnection(
      connection.id,
      (record) => ({
        ...record,
        status: record.health.openConflicts ? 'attention' : 'healthy',
        nextSyncAt: nowPlus(60),
        logs: [
          {
            id: id('log'),
            timestamp: new Date().toISOString(),
            event: 'Consent reauthorized',
            detail: 'Provider identity and requested scopes were verified again.',
            status: 'success',
            durationMs: 1240,
          },
          ...record.logs,
        ],
      }),
      'reconnected',
    );
    setActionMenu(false);
    notify('Provider reauthorized');
  }

  function disconnect(connection: OriginConnectionRecord) {
    if (!disconnectConfirm) {
      setDisconnectConfirm(true);
      return;
    }
    updateConnection(
      connection.id,
      (record) => ({
        ...record,
        status: 'disconnected',
        nextSyncAt: null,
        logs: [
          {
            id: id('log'),
            timestamp: new Date().toISOString(),
            event: 'Connection disconnected',
            detail: 'Provider tokens were revoked. Imported portfolio records were retained.',
            status: 'warning',
          },
          ...record.logs,
        ],
      }),
      'disconnected',
    );
    setDisconnectConfirm(false);
    setActionMenu(false);
    notify('Connection disconnected; imported data retained');
  }

  function resolveConflict(
    connection: OriginConnectionRecord,
    conflictId: string,
    resolution: 'use-source' | 'keep-bettertrack' | 'ignored',
  ) {
    updateConnection(
      connection.id,
      (record) => {
        const conflicts = record.conflicts.map((conflict) =>
          conflict.id === conflictId ? { ...conflict, status: resolution } : conflict,
        );
        const openConflicts = conflicts.filter((conflict) => conflict.status === 'open').length;
        return {
          ...record,
          status: openConflicts ? 'attention' : 'healthy',
          health: {
            ...record.health,
            openConflicts,
            score: openConflicts ? record.health.score : Math.max(record.health.score, 94),
          },
          conflicts,
          logs: [
            {
              id: id('log'),
              timestamp: new Date().toISOString(),
              event: 'Sync conflict resolved',
              detail: `${conflictId} · ${resolution.replaceAll('-', ' ')}`,
              status: 'success',
            },
            ...record.logs,
          ],
        };
      },
      'conflict-resolved',
    );
    notify('Resolution saved to the sync history');
  }

  return (
    <div aria-label="Connections" aria-modal="true" className="origin-connections" role="dialog">
      <header className="ocn-header">
        <div className="ocn-brand">
          <span className="ocn-brand__mark" />
          <span>
            <strong>
              Better<span>Track</span>
            </strong>
            <small>Connections</small>
          </span>
        </div>
        <div className="ocn-breadcrumb">
          <span>Control center</span>
          <Icon name="chevron-right" size={13} />
          <strong>
            {view === 'add' ? 'Add connection' : selected?.provider.name || 'Connections'}
          </strong>
        </div>
        <div className="ocn-header__actions">
          {onOpenDeveloper ? (
            <button onClick={onOpenDeveloper} type="button">
              <Icon name="code" size={15} />
              Developer Platform
            </button>
          ) : null}
          <button aria-label="Close connections" onClick={onClose} type="button">
            <Icon name="x" size={18} />
          </button>
        </div>
      </header>

      {view === 'list' ? (
        <ConnectionList
          connections={visibleConnections}
          filter={filter}
          onAdd={() => startAdd()}
          onFilter={setFilter}
          onOpen={openDetail}
          portfolio={portfolio}
          search={search}
          setSearch={setSearch}
          total={connections}
        />
      ) : null}

      {view === 'detail' && selected ? (
        <ConnectionDetail
          actionMenu={actionMenu}
          connection={selected}
          detailTab={detailTab}
          disconnectConfirm={disconnectConfirm}
          onActionMenu={() => {
            setActionMenu(!actionMenu);
            setDisconnectConfirm(false);
          }}
          onBack={() => setView('list')}
          onDisconnect={() => disconnect(selected)}
          onPause={() => togglePause(selected)}
          onReconnect={() => reconnect(selected)}
          onResolve={(conflictId, resolution) => resolveConflict(selected, conflictId, resolution)}
          onSync={() => syncNow(selected)}
          onTab={setDetailTab}
          provider={providerDefinitions.find((item) => item.id === selected.provider.id)!}
          syncing={syncingId === selected.id}
        />
      ) : null}

      {view === 'add' ? (
        <AddConnection
          account={sourceAccount}
          addIndex={addIndex}
          category={category}
          driveRole={driveRole}
          error={error}
          mappingStrategy={mappingStrategy}
          onAccount={setSourceAccount}
          onApproveStage={setStageApproved}
          onAuth={() => setAuthProgress(1)}
          onBack={addBack}
          onCategory={setCategory}
          onChooseFolder={() => {
            setSourceWorkspace('BetterTrack / Personal wealth');
            setToast('Drive folder selected · access remains limited to this folder');
          }}
          onCreate={createConnection}
          onDriveRole={(role) => {
            setDriveRole(role);
            if (provider) setSyncMode(defaultSyncMode(provider, role));
          }}
          onMappingStrategy={setMappingStrategy}
          onNext={addNext}
          onPermission={setPermissionAccepted}
          onProvider={selectProvider}
          onProviderSearch={setProviderSearch}
          onStage={() => setStageProgress(1)}
          onSyncMode={setSyncMode}
          onTargetPortfolio={setTargetPortfolio}
          onWorkspace={setSourceWorkspace}
          permissionAccepted={permissionAccepted}
          portfolio={portfolio}
          provider={provider}
          providerSearch={providerSearch}
          providers={filteredProviders}
          sourceWorkspace={sourceWorkspace}
          stageApproved={stageApproved}
          stageComplete={stageComplete}
          stageProgress={stageProgress}
          step={addStep}
          syncMode={syncMode}
          targetPortfolio={targetPortfolio}
          authProgress={authProgress}
        />
      ) : null}

      {toast ? (
        <div className="ocn-toast" role="status">
          <Icon name="check" size={15} />
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionList({
  connections,
  total,
  portfolio,
  search,
  setSearch,
  filter,
  onFilter,
  onOpen,
  onAdd,
}: {
  connections: OriginConnectionRecord[];
  total: OriginConnectionRecord[];
  portfolio: OriginConnectionPortfolio;
  search: string;
  setSearch: (value: string) => void;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  onOpen: (id: string, tab?: DetailTab) => void;
  onAdd: () => void;
}) {
  const attention = total.filter(
    (connection) => connection.status === 'attention' || connection.status === 'disconnected',
  ).length;
  const records = total.reduce((sum, connection) => sum + connection.health.records, 0);
  return (
    <main className="ocn-page">
      <div className="ocn-page-heading">
        <div>
          <span>Data & access</span>
          <h1>Connections</h1>
          <p>
            See where {portfolio.name} gets data, where it sends data and whether every source still
            agrees.
          </p>
        </div>
        <Button icon="plus" kind="primary" onClick={onAdd}>
          Add connection
        </Button>
      </div>

      <div className="ocn-overview-strip">
        <span>
          <small>Active connections</small>
          <strong>{total.filter((item) => item.status !== 'disconnected').length}</strong>
          <em>Across {new Set(total.map((item) => item.provider.category)).size} source types</em>
        </span>
        <span>
          <small>Records under management</small>
          <strong>{records.toLocaleString()}</strong>
          <em>Deduplicated across sources</em>
        </span>
      </div>

      {attention ? (
        <section className="ocn-attention-banner">
          <span>
            <Icon name="activity" size={19} />
          </span>
          <div>
            <small>Connection review</small>
            <strong>
              {attention} connection{attention === 1 ? '' : 's'} need your decision
            </strong>
            <p>
              BetterTrack paused uncertain writes. Existing portfolio data remains available and
              unchanged.
            </p>
          </div>
          <Button
            onClick={() => {
              const first = total.find(
                (connection) =>
                  connection.status === 'attention' || connection.status === 'disconnected',
              );
              if (first) onOpen(first.id, first.health.openConflicts ? 'conflicts' : 'overview');
            }}
          >
            Review now
          </Button>
        </section>
      ) : null}

      <section className="ocn-connections-section">
        <div className="ocn-list-toolbar">
          <div className="ocn-search">
            <Icon name="search" size={15} />
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search provider, account or portfolio"
              value={search}
            />
            {search ? (
              <button onClick={() => setSearch('')} type="button">
                <Icon name="x" size={13} />
              </button>
            ) : null}
          </div>
          <div className="ocn-filters">
            {(['all', 'healthy', 'attention', 'paused'] as const).map((item) => (
              <button
                aria-pressed={filter === item}
                className={filter === item ? 'is-active' : ''}
                key={item}
                onClick={() => onFilter(item)}
                type="button"
              >
                {item}
                {item !== 'all' ? (
                  <span>
                    {
                      total.filter(
                        (connection) =>
                          connection.status === item ||
                          (item === 'attention' && connection.status === 'disconnected'),
                      ).length
                    }
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        <div className="ocn-table">
          <div className="ocn-table__head">
            <span>Connection</span>
            <span>Direction</span>
            <span>Coverage</span>
            <span>Last sync</span>
            <span>Status</span>
            <span />
          </div>
          {connections.map((connection) => {
            const provider = providerDefinitions.find(
              (item) => item.id === connection.provider.id,
            )!;
            return (
              <button
                className="ocn-connection-row"
                key={connection.id}
                onClick={() => onOpen(connection.id)}
                type="button"
              >
                <span className="ocn-connection-row__identity">
                  <ProviderMark provider={provider} />
                  <i>
                    <strong>{provider.name}</strong>
                    <small>{connection.sourceAccount}</small>
                  </i>
                </span>
                <span className="ocn-direction">
                  <Icon
                    name={
                      connection.syncMode === 'two-way'
                        ? 'repeat'
                        : connection.syncMode === 'export'
                          ? 'upload'
                          : 'download'
                    }
                    size={14}
                  />
                  {syncModeLabel(connection)}
                </span>
                <span className="ocn-coverage">
                  <i>
                    <b style={{ width: `${connection.health.coverage}%` }} />
                  </i>
                  {connection.health.coverage}%
                </span>
                <span className="ocn-last-sync">
                  {connection.lastSyncAt ? relativeTime(connection.lastSyncAt) : 'Never'}
                  <small>{connection.health.records.toLocaleString()} records</small>
                </span>
                <Status status={connection.status} />
                <span className="ocn-open-row">
                  <Icon name="chevron-right" size={16} />
                </span>
              </button>
            );
          })}
          {!connections.length ? (
            <div className="ocn-empty-list">
              <Icon name="link" size={25} />
              <strong>No connections match this view</strong>
              <p>Clear the search or add a source for {portfolio.name}.</p>
              <Button icon="plus" onClick={onAdd}>
                Add connection
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      <div className="ocn-footnote">
        <Icon name="shield" size={15} />
        <span>
          <strong>Connections never place trades or move money.</strong>
          Provider tokens are encrypted, scoped and independently revocable. Every sync produces an
          audit entry.
        </span>
      </div>
    </main>
  );
}

function ConnectionDetail({
  connection,
  provider,
  detailTab,
  syncing,
  actionMenu,
  disconnectConfirm,
  onBack,
  onTab,
  onSync,
  onPause,
  onReconnect,
  onDisconnect,
  onResolve,
  onActionMenu,
}: {
  connection: OriginConnectionRecord;
  provider: ProviderDefinition;
  detailTab: DetailTab;
  syncing: boolean;
  actionMenu: boolean;
  disconnectConfirm: boolean;
  onBack: () => void;
  onTab: (tab: DetailTab) => void;
  onSync: () => void;
  onPause: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  onResolve: (id: string, resolution: 'use-source' | 'keep-bettertrack' | 'ignored') => void;
  onActionMenu: () => void;
}) {
  const valueDifference = connection.health.sourceValue - connection.health.reconciledValue;
  return (
    <main className="ocn-page ocn-detail-page">
      <button className="ocn-back-link" onClick={onBack} type="button">
        <Icon name="arrow-right" size={14} />
        All connections
      </button>
      <div className="ocn-detail-heading">
        <ProviderMark provider={provider} />
        <div>
          <span>{categoryLabels[provider.category]}</span>
          <h1>{provider.name}</h1>
          <p>
            {connection.sourceAccount} → {connection.portfolio.name}
          </p>
        </div>
        <Status status={connection.status} />
        <div className="ocn-detail-actions">
          <Button
            disabled={
              syncing || connection.status === 'paused' || connection.status === 'disconnected'
            }
            icon="refresh"
            onClick={onSync}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
          <div className="ocn-action-menu">
            <Button
              aria-controls="ocn-connection-actions"
              aria-expanded={actionMenu}
              aria-label={`Actions for ${provider.name}`}
              icon="more"
              onClick={onActionMenu}
            />
            {actionMenu ? (
              <div
                id="ocn-connection-actions"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    onActionMenu();
                  }
                }}
                aria-label="Connection actions"
                role="group"
              >
                <button onClick={onReconnect} type="button">
                  <Icon name="refresh" size={14} />
                  Reauthorize connection
                </button>
                <button onClick={onPause} type="button">
                  <Icon name={connection.status === 'paused' ? 'activity' : 'clock'} size={14} />
                  {connection.status === 'paused' ? 'Resume sync' : 'Pause sync'}
                </button>
                <button className="is-danger" onClick={onDisconnect} type="button">
                  <Icon name={disconnectConfirm ? 'activity' : 'trash'} size={14} />
                  {disconnectConfirm ? 'Confirm disconnect' : 'Disconnect'}
                </button>
                {disconnectConfirm ? (
                  <p>Imported data stays. Tokens and scheduled syncs are removed.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <nav aria-label={`${provider.name} connection sections`} className="ocn-detail-tabs">
        {(['overview', 'mapping', 'activity', 'conflicts'] as const).map((tab) => (
          <button
            aria-controls={`ocn-${connection.id}-${tab}-panel`}
            aria-pressed={detailTab === tab}
            className={detailTab === tab ? 'is-active' : ''}
            id={`ocn-${connection.id}-${tab}-tab`}
            key={tab}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const tabs = ['overview', 'mapping', 'activity', 'conflicts'] as const;
              const current = tabs.indexOf(tab);
              const next =
                event.key === 'Home'
                  ? tabs[0]!
                  : event.key === 'End'
                    ? tabs[tabs.length - 1]!
                    : tabs[
                        (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
                          tabs.length
                      ]!;
              onTab(next);
              window.requestAnimationFrame(() =>
                document.getElementById(`ocn-${connection.id}-${next}-tab`)?.focus(),
              );
            }}
            onClick={() => onTab(tab)}
            type="button"
          >
            {tab}
            {tab === 'conflicts' && connection.health.openConflicts ? (
              <span>{connection.health.openConflicts}</span>
            ) : null}
          </button>
        ))}
      </nav>

      {detailTab === 'overview' ? (
        <div
          aria-labelledby={`ocn-${connection.id}-overview-tab`}
          className="ocn-detail-content"
          id={`ocn-${connection.id}-overview-panel`}
          role="region"
        >
          <section className="ocn-health-hero">
            <div className="ocn-health-score">
              <span
                style={
                  {
                    '--health-score': `${connection.health.score * 3.6}deg`,
                  } as React.CSSProperties
                }
              >
                <i>
                  <strong>{connection.health.score}</strong>
                  <small>/ 100</small>
                </i>
              </span>
              <div>
                <small>Connection health</small>
                <h2>
                  {connection.health.score >= 90
                    ? 'Source is in good shape'
                    : connection.health.score >= 70
                      ? 'A few decisions are waiting'
                      : 'This connection needs attention'}
                </h2>
                <p>
                  Health combines freshness, field coverage, reconciliation, permissions and open
                  conflicts.
                </p>
              </div>
            </div>
            <div className="ocn-health-metrics">
              <span>
                <small>Field coverage</small>
                <strong>{connection.health.coverage}%</strong>
                <i>
                  <b style={{ width: `${connection.health.coverage}%` }} />
                </i>
              </span>
              <span>
                <small>Cost basis coverage</small>
                <strong>{connection.health.costBasisCoverage}%</strong>
                <i>
                  <b style={{ width: `${connection.health.costBasisCoverage}%` }} />
                </i>
              </span>
              <span>
                <small>Open conflicts</small>
                <strong className={connection.health.openConflicts ? 'is-warning' : ''}>
                  {connection.health.openConflicts}
                </strong>
                <em>
                  {connection.health.openConflicts ? 'Sync writes paused' : 'No uncertain writes'}
                </em>
              </span>
            </div>
          </section>

          <div className="ocn-detail-grid">
            <section className="ocn-flat-module">
              <div className="ocn-module-heading">
                <span>
                  <small>Value reconciliation</small>
                  <h3>Source and BetterTrack agree</h3>
                </span>
                <em className={Math.abs(valueDifference) < 0.01 ? 'is-good' : 'is-warning'}>
                  {Math.abs(valueDifference) < 0.01
                    ? 'Balanced'
                    : `${formatCurrency(Math.abs(valueDifference))} difference`}
                </em>
              </div>
              <div className="ocn-reconciliation">
                <span>
                  <small>{provider.name}</small>
                  <strong>{formatCurrency(connection.health.sourceValue)}</strong>
                  <i style={{ width: '100%' }} />
                </span>
                <span>
                  <small>BetterTrack mapped value</small>
                  <strong>{formatCurrency(connection.health.reconciledValue)}</strong>
                  <i
                    style={{
                      width: `${Math.min(
                        100,
                        (connection.health.reconciledValue /
                          Math.max(connection.health.sourceValue, 1)) *
                          100,
                      )}%`,
                    }}
                  />
                </span>
              </div>
              <div className="ocn-reconciliation-meta">
                <span>
                  <small>Records</small>
                  <strong>{connection.health.records.toLocaleString()}</strong>
                </span>
                <span>
                  <small>Missing cost basis</small>
                  <strong>{connection.health.missingCostBasis}</strong>
                </span>
                <span>
                  <small>Last completed</small>
                  <strong>
                    {connection.lastSyncAt ? relativeTime(connection.lastSyncAt) : 'Never'}
                  </strong>
                </span>
              </div>
            </section>
            <section className="ocn-flat-module">
              <div className="ocn-module-heading">
                <span>
                  <small>Sync schedule</small>
                  <h3>{syncModeLabel(connection)}</h3>
                </span>
                <Icon name="repeat" size={17} />
              </div>
              <dl className="ocn-definition-list">
                <div>
                  <dt>Source</dt>
                  <dd>{connection.sourceAccount}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>{connection.portfolio.name}</dd>
                </div>
                <div>
                  <dt>Next scheduled check</dt>
                  <dd>
                    {connection.nextSyncAt
                      ? new Date(connection.nextSyncAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : 'Not scheduled'}
                  </dd>
                </div>
                <div>
                  <dt>Connection created</dt>
                  <dd>{new Date(connection.createdAt).toLocaleDateString()}</dd>
                </div>
              </dl>
            </section>
          </div>

          <section className="ocn-coverage-module">
            <div className="ocn-module-heading">
              <span>
                <small>Coverage and exceptions</small>
                <h3>What travels through this connection</h3>
              </span>
              <button onClick={() => onTab('mapping')} type="button">
                Open field mapping <Icon name="arrow-right" size={13} />
              </button>
            </div>
            <div className="ocn-coverage-columns">
              <div>
                <strong>Supported</strong>
                {provider.capabilities.map((capability) => (
                  <span key={capability}>
                    <Icon name="check" size={13} />
                    {capability}
                  </span>
                ))}
              </div>
              <div>
                <strong>Not portable</strong>
                {connection.health.unsupportedFields.length ? (
                  connection.health.unsupportedFields.map((field) => (
                    <span key={field}>
                      <Icon name="minus" size={13} />
                      {field}
                    </span>
                  ))
                ) : (
                  <span>
                    <Icon name="check" size={13} />
                    No known unsupported fields
                  </span>
                )}
              </div>
              <div>
                <strong>Permission boundary</strong>
                <span>
                  <Icon name="lock" size={13} />
                  Read-only provider access
                </span>
                <span>
                  <Icon name="shield" size={13} />
                  No trading or money movement
                </span>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {detailTab === 'mapping' ? <MappingTab connection={connection} provider={provider} /> : null}
      {detailTab === 'activity' ? (
        <ActivityTab connectionId={connection.id} logs={connection.logs} />
      ) : null}
      {detailTab === 'conflicts' ? (
        <ConflictsTab
          connectionId={connection.id}
          conflicts={connection.conflicts}
          onResolve={onResolve}
          openCount={connection.health.openConflicts}
        />
      ) : null}
    </main>
  );
}

function MappingTab({
  connection,
  provider,
}: {
  connection: OriginConnectionRecord;
  provider: ProviderDefinition;
}) {
  const fields = [
    ['instrument.isin', 'Asset identifier', 'IE00BK5BQT80', 'Exact'],
    ['execution.timestamp', 'Transaction date', '2026-07-24 16:42', 'Normalized'],
    ['transaction.type', 'Transaction type', 'SAVINGS_PLAN_BUY', 'Rule'],
    ['quantity', 'Units', '3.482901', 'Exact'],
    ['gross_amount', 'Gross value', '€412.40', 'Exact'],
    ['fees + taxes', 'Costs & tax', '€1.50 + €0.00', 'Combined'],
    ['cash_account', 'Cash source', 'Cash account EUR', 'Matched'],
  ];
  return (
    <div
      aria-labelledby={`ocn-${connection.id}-mapping-tab`}
      className="ocn-subpage"
      id={`ocn-${connection.id}-mapping-panel`}
      role="region"
    >
      <section className="ocn-mapping-summary">
        <div>
          <span>
            <Icon name="download" size={17} />
          </span>
          <i>
            <small>Source</small>
            <strong>{provider.name}</strong>
            <em>{connection.sourceAccount}</em>
          </i>
        </div>
        <b>
          <Icon name={connection.syncMode === 'two-way' ? 'repeat' : 'arrow-right'} size={17} />
          {connection.health.records.toLocaleString()} records
        </b>
        <div>
          <span>
            <Icon name="portfolio" size={17} />
          </span>
          <i>
            <small>Destination</small>
            <strong>BetterTrack</strong>
            <em>{connection.portfolio.name}</em>
          </i>
        </div>
      </section>
      <section className="ocn-mapping-table">
        <div className="ocn-module-heading">
          <span>
            <small>Field map</small>
            <h3>Normalized source schema</h3>
          </span>
          <em>{connection.health.coverage}% coverage</em>
        </div>
        <div className="ocn-mapping-table__head">
          <span>Source field</span>
          <span>BetterTrack field</span>
          <span>Latest sample</span>
          <span>Method</span>
        </div>
        {fields.map((field) => (
          <div key={field[0]}>
            <code>{field[0]}</code>
            <strong>{field[1]}</strong>
            <span>{field[2]}</span>
            <em>{field[3]}</em>
          </div>
        ))}
      </section>
      <section className="ocn-mapping-notes">
        <div>
          <Icon name="database" size={17} />
          <span>
            <strong>Canonical asset matching</strong>
            ISIN, FIGI and exchange ticker are resolved to one asset before duplicate detection.
          </span>
        </div>
        <div>
          <Icon name="repeat" size={17} />
          <span>
            <strong>Idempotent records</strong>
            Stable source IDs prevent the same trade from being imported twice.
          </span>
        </div>
        <div>
          <Icon name="clock" size={17} />
          <span>
            <strong>Original values retained</strong>
            Every normalized value keeps its source payload and mapping version in the audit log.
          </span>
        </div>
      </section>
    </div>
  );
}

function ActivityTab({
  connectionId,
  logs,
}: {
  connectionId: string;
  logs: OriginConnectionLog[];
}) {
  const [filter, setFilter] = useState<'all' | OriginConnectionLog['status']>('all');
  const visible = logs.filter((log) => filter === 'all' || log.status === filter);
  return (
    <div
      aria-labelledby={`ocn-${connectionId}-activity-tab`}
      className="ocn-subpage"
      id={`ocn-${connectionId}-activity-panel`}
      role="region"
    >
      <div className="ocn-activity-toolbar">
        <div>
          <span>Sync log</span>
          <h2>Every provider interaction</h2>
          <p>Authorization, reads, writes, skips and warnings are recorded here.</p>
        </div>
        <div>
          {(['all', 'success', 'warning', 'error', 'info'] as const).map((item) => (
            <button
              aria-pressed={filter === item}
              className={filter === item ? 'is-active' : ''}
              key={item}
              onClick={() => setFilter(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <section className="ocn-log-list">
        {visible.map((log) => (
          <div key={log.id}>
            <span className={cn('ocn-log-icon', `is-${log.status}`)}>
              <Icon
                name={
                  log.status === 'success'
                    ? 'check'
                    : log.status === 'warning' || log.status === 'error'
                      ? 'activity'
                      : 'clock'
                }
                size={14}
              />
            </span>
            <i>
              <strong>{log.event}</strong>
              <p>{log.detail}</p>
              <small>{new Date(log.timestamp).toLocaleString()}</small>
            </i>
            <span className="ocn-log-meta">
              {log.records !== undefined ? <em>{log.records.toLocaleString()} records</em> : null}
              {log.durationMs !== undefined ? <em>{(log.durationMs / 1000).toFixed(2)}s</em> : null}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}

function ConflictsTab({
  connectionId,
  conflicts,
  openCount,
  onResolve,
}: {
  connectionId: string;
  conflicts: OriginConnectionConflict[];
  openCount: number;
  onResolve: (id: string, resolution: 'use-source' | 'keep-bettertrack' | 'ignored') => void;
}) {
  return (
    <div
      aria-labelledby={`ocn-${connectionId}-conflicts-tab`}
      className="ocn-subpage"
      id={`ocn-${connectionId}-conflicts-panel`}
      role="region"
    >
      <section className={cn('ocn-conflict-heading', !openCount && 'is-clear')}>
        <span>
          <Icon name={openCount ? 'activity' : 'check'} size={22} />
        </span>
        <div>
          <small>Safe two-way synchronization</small>
          <h2>
            {openCount
              ? `${openCount} decision${openCount === 1 ? '' : 's'} waiting`
              : 'No open conflicts'}
          </h2>
          <p>
            {openCount
              ? 'Both systems changed the same record. BetterTrack paused only those writes and left everything else untouched.'
              : 'Every detected difference has a recorded resolution.'}
          </p>
        </div>
      </section>
      <div className="ocn-conflict-list">
        {conflicts.map((conflict) => (
          <section
            className={cn('ocn-conflict-card', conflict.status !== 'open' && 'is-resolved')}
            key={conflict.id}
          >
            <div className="ocn-conflict-card__head">
              <span>
                <small>{conflict.field}</small>
                <strong>{conflict.asset}</strong>
              </span>
              <em>
                {conflict.status === 'open'
                  ? 'Decision needed'
                  : conflict.status.replaceAll('-', ' ')}
              </em>
            </div>
            <p>{conflict.reason}</p>
            <div className="ocn-conflict-values">
              <button
                aria-pressed={conflict.status === 'use-source'}
                className={conflict.status === 'use-source' ? 'is-selected' : ''}
                disabled={conflict.status !== 'open'}
                onClick={() => onResolve(conflict.id, 'use-source')}
                type="button"
              >
                <small>Connected source</small>
                <strong>{conflict.sourceValue}</strong>
                <em>Use source</em>
              </button>
              <span>or</span>
              <button
                aria-pressed={conflict.status === 'keep-bettertrack'}
                className={conflict.status === 'keep-bettertrack' ? 'is-selected' : ''}
                disabled={conflict.status !== 'open'}
                onClick={() => onResolve(conflict.id, 'keep-bettertrack')}
                type="button"
              >
                <small>BetterTrack</small>
                <strong>{conflict.betterTrackValue}</strong>
                <em>Keep BetterTrack</em>
              </button>
            </div>
            {conflict.status === 'open' ? (
              <button
                className="ocn-ignore-conflict"
                onClick={() => onResolve(conflict.id, 'ignored')}
                type="button"
              >
                Ignore this field on future syncs
              </button>
            ) : null}
          </section>
        ))}
        {!conflicts.length ? (
          <div className="ocn-no-conflicts">
            <Icon name="shield" size={25} />
            <strong>Nothing needs reconciliation</strong>
            <p>Potential duplicate and two-way changes will appear here before they are applied.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AddConnection({
  step,
  addIndex,
  providers,
  provider,
  providerSearch,
  category,
  portfolio,
  permissionAccepted,
  authProgress,
  account,
  sourceWorkspace,
  targetPortfolio,
  mappingStrategy,
  syncMode,
  driveRole,
  stageProgress,
  stageComplete,
  stageApproved,
  error,
  onProviderSearch,
  onCategory,
  onChooseFolder,
  onProvider,
  onPermission,
  onAuth,
  onAccount,
  onWorkspace,
  onTargetPortfolio,
  onMappingStrategy,
  onSyncMode,
  onDriveRole,
  onStage,
  onApproveStage,
  onBack,
  onNext,
  onCreate,
}: {
  step: AddStep;
  addIndex: number;
  providers: ProviderDefinition[];
  provider: ProviderDefinition | null;
  providerSearch: string;
  category: 'all' | OriginConnectionCategory;
  portfolio: OriginConnectionPortfolio;
  permissionAccepted: boolean;
  authProgress: number;
  account: string;
  sourceWorkspace: string;
  targetPortfolio: string;
  mappingStrategy: 'merge' | 'replace' | 'new';
  syncMode: OriginConnectionSyncMode;
  driveRole: OriginConnectionRecord['driveRole'];
  stageProgress: number;
  stageComplete: boolean;
  stageApproved: boolean;
  error: string;
  onProviderSearch: (value: string) => void;
  onCategory: (category: 'all' | OriginConnectionCategory) => void;
  onChooseFolder: () => void;
  onProvider: (id: OriginProviderId) => void;
  onPermission: (accepted: boolean) => void;
  onAuth: () => void;
  onAccount: (account: string) => void;
  onWorkspace: (workspace: string) => void;
  onTargetPortfolio: (portfolio: string) => void;
  onMappingStrategy: (strategy: 'merge' | 'replace' | 'new') => void;
  onSyncMode: (mode: OriginConnectionSyncMode) => void;
  onDriveRole: (role: OriginConnectionRecord['driveRole']) => void;
  onStage: () => void;
  onApproveStage: (approved: boolean) => void;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
}) {
  return (
    <main className="ocn-add-page">
      <aside className="ocn-add-steps">
        <button onClick={onBack} type="button">
          <Icon name="arrow-right" size={14} />
          Cancel setup
        </button>
        <span>New connection</span>
        <h1>{provider?.name || 'Choose a source'}</h1>
        <nav>
          {addSteps.map((item, index) => (
            <div
              className={cn(index === addIndex && 'is-current', index < addIndex && 'is-complete')}
              key={item.id}
            >
              <i>{index < addIndex ? <Icon name="check" size={11} /> : index + 1}</i>
              <span>{item.label}</span>
            </div>
          ))}
        </nav>
        {provider ? (
          <div className="ocn-add-provider">
            <ProviderMark provider={provider} />
            <span>
              <strong>{provider.name}</strong>
              <small>{provider.support}</small>
            </span>
          </div>
        ) : null}
      </aside>
      <section className="ocn-add-stage">
        {step === 'provider' ? (
          <ProviderChooser
            category={category}
            onCategory={onCategory}
            onProvider={onProvider}
            onSearch={onProviderSearch}
            provider={provider}
            providers={providers}
            search={providerSearch}
          />
        ) : null}
        {step === 'permissions' && provider ? (
          <PermissionStep
            accepted={permissionAccepted}
            onAccepted={onPermission}
            provider={provider}
          />
        ) : null}
        {step === 'authenticate' && provider ? (
          <AuthenticateStep onStart={onAuth} progress={authProgress} provider={provider} />
        ) : null}
        {step === 'account' && provider ? (
          <AccountStep account={account} onAccount={onAccount} provider={provider} />
        ) : null}
        {step === 'mapping' && provider ? (
          <PortfolioMappingStep
            account={account}
            mappingStrategy={mappingStrategy}
            onMappingStrategy={onMappingStrategy}
            onChooseFolder={onChooseFolder}
            onTarget={onTargetPortfolio}
            onWorkspace={onWorkspace}
            portfolio={portfolio}
            provider={provider}
            sourceWorkspace={sourceWorkspace}
            target={targetPortfolio}
          />
        ) : null}
        {step === 'direction' && provider ? (
          <DirectionStep
            driveRole={driveRole}
            onDriveRole={onDriveRole}
            onSyncMode={onSyncMode}
            provider={provider}
            syncMode={syncMode}
          />
        ) : null}
        {step === 'stage' && provider ? (
          <StagedSyncStep
            account={account}
            approved={stageApproved}
            complete={stageComplete}
            onApprove={onApproveStage}
            onStart={onStage}
            portfolio={targetPortfolio}
            progress={stageProgress}
            provider={provider}
            syncMode={syncMode}
          />
        ) : null}
        {step === 'review' && provider ? (
          <ConnectionReview
            account={account}
            driveRole={driveRole}
            portfolio={targetPortfolio}
            provider={provider}
            syncMode={syncMode}
          />
        ) : null}

        <footer className="ocn-add-actions">
          <Button icon="arrow-right" kind="ghost" onClick={onBack}>
            Back
          </Button>
          <div>
            {error ? (
              <span className="ocn-error">
                <Icon name="activity" size={14} />
                {error}
              </span>
            ) : (
              <small>
                {step === 'review'
                  ? 'The first sync remains in the audit log'
                  : 'No source data is written without approval'}
              </small>
            )}
            <Button
              icon={step === 'review' ? 'check' : 'arrow-right'}
              kind="primary"
              onClick={step === 'review' ? onCreate : onNext}
            >
              {step === 'review' ? 'Finish connection' : 'Continue'}
            </Button>
          </div>
        </footer>
      </section>
    </main>
  );
}

function ProviderChooser({
  providers,
  provider,
  search,
  category,
  onSearch,
  onCategory,
  onProvider,
}: {
  providers: ProviderDefinition[];
  provider: ProviderDefinition | null;
  search: string;
  category: 'all' | OriginConnectionCategory;
  onSearch: (value: string) => void;
  onCategory: (category: 'all' | OriginConnectionCategory) => void;
  onProvider: (provider: OriginProviderId) => void;
}) {
  return (
    <>
      <div className="ocn-add-heading">
        <span>Connect a source</span>
        <h2>Where should this portfolio connect?</h2>
        <p>
          Each source has one explicit purpose. BetterTrack stages and explains the mapping before
          changing your portfolio.
        </p>
      </div>
      <div className="ocn-provider-toolbar">
        <div>
          <Icon name="search" size={15} />
          <input
            autoFocus
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search brokers, banks and storage"
            value={search}
          />
        </div>
        <nav>
          {(
            [
              ['all', 'All'],
              ['broker', 'Brokers'],
              ['portfolio-service', 'Portfolio services'],
              ['storage', 'Storage'],
              ['bank', 'Bank cash'],
            ] as const
          ).map(([id, label]) => (
            <button
              aria-pressed={category === id}
              className={category === id ? 'is-active' : ''}
              key={id}
              onClick={() => onCategory(id)}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="ocn-provider-list">
        {providers.map((item) => (
          <button
            aria-pressed={provider?.id === item.id}
            className={provider?.id === item.id ? 'is-active' : ''}
            key={item.id}
            onClick={() => onProvider(item.id)}
            type="button"
          >
            <ProviderMark provider={item} />
            <span>
              <i>
                <strong>{item.name}</strong>
                {item.beta ? <em>Beta</em> : null}
              </i>
              <small>{item.description}</small>
              <b>{item.support}</b>
            </span>
            <span className="ocn-provider-capabilities">
              {item.capabilities.slice(0, 3).map((capability) => (
                <em key={capability}>{capability}</em>
              ))}
            </span>
            <i className="ocn-provider-check">
              {provider?.id === item.id ? <Icon name="check" size={13} /> : null}
            </i>
          </button>
        ))}
      </div>
    </>
  );
}

function PermissionStep({
  provider,
  accepted,
  onAccepted,
}: {
  provider: ProviderDefinition;
  accepted: boolean;
  onAccepted: (accepted: boolean) => void;
}) {
  return (
    <>
      <div className="ocn-add-heading">
        <span>Permission boundary</span>
        <h2>Understand exactly what {provider.name} shares.</h2>
        <p>
          BetterTrack asks for the minimum scope required for the connection you chose. You can
          revoke it here or at the provider.
        </p>
      </div>
      <div className="ocn-permission-layout">
        <section>
          <div className="ocn-permission-identity">
            <ProviderMark provider={provider} />
            <span>
              <strong>{provider.name}</strong>
              <small>will share with</small>
            </span>
            <Icon name="arrow-right" size={17} />
            <span className="ocn-bt-mark" />
            <span>
              <strong>BetterTrack</strong>
              <small>for this portfolio only</small>
            </span>
          </div>
          <div className="ocn-permission-list">
            {provider.permissions.map((permission, index) => (
              <div key={permission}>
                <span>
                  <Icon
                    name={
                      index === provider.permissions.length - 1
                        ? 'refresh'
                        : index === 0
                          ? 'eye'
                          : 'database'
                    }
                    size={17}
                  />
                </span>
                <p>
                  <strong>{permission}</strong>
                  <small>
                    {index === provider.permissions.length - 1
                      ? 'Ongoing consent can be paused or revoked at any time.'
                      : 'Used only for portfolio calculation and reconciliation.'}
                  </small>
                </p>
              </div>
            ))}
          </div>
        </section>
        <aside>
          <Icon name="shield" size={24} />
          <h3>What BetterTrack cannot do</h3>
          <p>These boundaries apply even if you later create automations inside BetterTrack.</p>
          <ul>
            <li>
              <Icon name="x" size={12} /> Place, cancel or modify trades
            </li>
            <li>
              <Icon name="x" size={12} /> Transfer or withdraw money
            </li>
            <li>
              <Icon name="x" size={12} /> Read unrelated accounts or files
            </li>
            <li>
              <Icon name="x" size={12} /> Share provider credentials with collaborators
            </li>
          </ul>
        </aside>
      </div>
      <button
        aria-pressed={accepted}
        className={cn('ocn-permission-confirm', accepted && 'is-active')}
        onClick={() => onAccepted(!accepted)}
        type="button"
      >
        <i>{accepted ? <Icon name="check" size={13} /> : null}</i>
        <span>
          <strong>These permissions make sense for this connection</strong>I understand that this is
          a simulated authorization and no real provider account will be accessed.
        </span>
      </button>
    </>
  );
}

function AuthenticateStep({
  provider,
  progress,
  onStart,
}: {
  provider: ProviderDefinition;
  progress: number;
  onStart: () => void;
}) {
  const complete = progress >= 100;
  return (
    <div className="ocn-auth-step">
      <div className="ocn-auth-window">
        <header>
          <ProviderMark provider={provider} small />
          <strong>{provider.name}</strong>
          <span>
            <Icon name="lock" size={12} /> Secure provider window
          </span>
        </header>
        <div>
          <span className="ocn-auth-user">
            <Icon name="people" size={22} />
          </span>
          <small>Authorize BetterTrack</small>
          <h2>
            {complete
              ? 'Authorization complete'
              : progress
                ? 'Verifying your consent'
                : `Sign in to ${provider.name}`}
          </h2>
          <p>
            {complete
              ? 'The provider returned a scoped token. Your sign-in details never passed through BetterTrack.'
              : 'This simulation represents the provider-owned OAuth and consent screen.'}
          </p>
          {progress ? (
            <div className="ocn-auth-progress">
              <i
                aria-label={`${provider.name} authorization progress`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progress}
                role="progressbar"
              >
                <b style={{ width: `${progress}%` }} />
              </i>
              <span>
                {complete
                  ? 'Identity and consent verified'
                  : progress < 45
                    ? 'Opening encrypted session'
                    : progress < 78
                      ? 'Confirming read scopes'
                      : 'Returning to BetterTrack'}
              </span>
            </div>
          ) : (
            <Button icon="lock" kind="primary" onClick={onStart}>
              Continue in provider window
            </Button>
          )}
          {complete ? (
            <div className="ocn-auth-success">
              <Icon name="check" size={16} />
              <span>
                <strong>Connected as alex@example.com</strong>
                Token scope matches the permissions you approved.
              </span>
            </div>
          ) : null}
        </div>
        <footer>
          <Icon name="shield" size={13} />
          BetterTrack cannot see or store your provider password
        </footer>
      </div>
    </div>
  );
}

function AccountStep({
  provider,
  account,
  onAccount,
}: {
  provider: ProviderDefinition;
  account: string;
  onAccount: (account: string) => void;
}) {
  return (
    <>
      <div className="ocn-add-heading">
        <span>Source scope</span>
        <h2>Choose the account to connect.</h2>
        <p>
          Only selected accounts enter this connection. Add another connection later if they need
          different portfolios or sync rules.
        </p>
      </div>
      <div className="ocn-account-list">
        {provider.accounts.map((item, index) => (
          <button
            aria-pressed={account === item}
            className={account === item ? 'is-active' : ''}
            key={item}
            onClick={() => onAccount(item)}
            type="button"
          >
            <span>
              <Icon
                name={
                  provider.category === 'bank'
                    ? 'bank'
                    : provider.category === 'storage'
                      ? 'folder'
                      : 'portfolio'
                }
                size={19}
              />
            </span>
            <i>
              <strong>{item}</strong>
              <small>
                {provider.category === 'bank'
                  ? index
                    ? 'Savings · EUR'
                    : 'Current account · EUR'
                  : provider.category === 'storage'
                    ? 'Google account · available'
                    : `${index ? 'Secondary' : 'Primary'} portfolio · ${index ? '84' : '847'} records`}
              </small>
            </i>
            <em>{index ? 'Optional' : 'Recommended'}</em>
            <b>{account === item ? <Icon name="check" size={13} /> : null}</b>
          </button>
        ))}
      </div>
      <div className="ocn-account-boundary">
        <Icon name="lock" size={16} />
        Accounts not selected here remain invisible to this BetterTrack connection.
      </div>
    </>
  );
}

function PortfolioMappingStep({
  provider,
  portfolio,
  account,
  target,
  sourceWorkspace,
  mappingStrategy,
  onTarget,
  onWorkspace,
  onChooseFolder,
  onMappingStrategy,
}: {
  provider: ProviderDefinition;
  portfolio: OriginConnectionPortfolio;
  account: string;
  target: string;
  sourceWorkspace: string;
  mappingStrategy: 'merge' | 'replace' | 'new';
  onTarget: (target: string) => void;
  onWorkspace: (workspace: string) => void;
  onChooseFolder: () => void;
  onMappingStrategy: (strategy: 'merge' | 'replace' | 'new') => void;
}) {
  return (
    <>
      <div className="ocn-add-heading">
        <span>Portfolio mapping</span>
        <h2>Decide where this source belongs.</h2>
        <p>
          Mapping keeps source ownership explicit. It never makes a second copy inside a different
          portfolio unless you ask.
        </p>
      </div>
      <div className="ocn-map-flow">
        <div>
          <ProviderMark provider={provider} />
          <span>
            <small>Source account</small>
            <strong>{account}</strong>
            <em>{provider.name}</em>
          </span>
        </div>
        <span>
          <Icon name="arrow-right" size={18} />
        </span>
        <div>
          <span className="ocn-bt-mark" />
          <label>
            <small>BetterTrack portfolio</small>
            <select onChange={(event) => onTarget(event.target.value)} value={target}>
              <option>{portfolio.name}</option>
              <option>Long-term investments</option>
              <option>Business reserve</option>
              <option value="New portfolio from source">Create a new portfolio…</option>
            </select>
            <em>Destination</em>
          </label>
        </div>
      </div>
      {provider.id === 'google-drive' ? (
        <label className="ocn-drive-folder">
          <span>
            <Icon name="folder" size={18} />
            Drive folder
          </span>
          <div>
            <strong>My Drive /</strong>
            <input
              onChange={(event) => onWorkspace(event.target.value)}
              placeholder="BetterTrack"
              value={sourceWorkspace}
            />
            <Button onClick={onChooseFolder}>Choose folder</Button>
          </div>
          <small>BetterTrack requests access only to this folder.</small>
        </label>
      ) : (
        <div className="ocn-mapping-strategies">
          {[
            [
              'merge',
              'Merge with matching records',
              'Use stable IDs, dates and asset identifiers to avoid duplicates.',
              'Recommended',
            ],
            [
              'replace',
              'Source becomes authoritative',
              'Replace overlapping imported records while keeping manual data.',
              'Advanced',
            ],
            [
              'new',
              'Keep as a separate child',
              'Create a nested portfolio and include it in the parent total.',
              'Cleanest boundary',
            ],
          ].map(([strategy, title, copy, tag]) => (
            <button
              aria-pressed={mappingStrategy === strategy}
              className={mappingStrategy === strategy ? 'is-active' : ''}
              key={strategy}
              onClick={() => onMappingStrategy(strategy as typeof mappingStrategy)}
              type="button"
            >
              <i>{mappingStrategy === strategy ? <Icon name="check" size={13} /> : null}</i>
              <span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </span>
              <em>{tag}</em>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function DirectionStep({
  provider,
  syncMode,
  driveRole,
  onSyncMode,
  onDriveRole,
}: {
  provider: ProviderDefinition;
  syncMode: OriginConnectionSyncMode;
  driveRole: OriginConnectionRecord['driveRole'];
  onSyncMode: (mode: OriginConnectionSyncMode) => void;
  onDriveRole: (role: OriginConnectionRecord['driveRole']) => void;
}) {
  if (provider.id === 'google-drive') {
    const roles: Array<
      [NonNullable<OriginConnectionRecord['driveRole']>, IconName, string, string, string]
    > = [
      [
        'data-home',
        'database',
        'External data home',
        'Portable snapshots and app data use this folder as their primary external home.',
        'Primary',
      ],
      [
        'backup',
        'shield',
        'Encrypted backup',
        'Create scheduled encrypted recovery snapshots without changing the live data home.',
        'Daily',
      ],
      [
        'files',
        'document',
        'Portfolio file library',
        'Attach selected statements and documents without scanning unrelated files.',
        'Manual',
      ],
      [
        'watched-import',
        'inbox',
        'Watched import folder',
        'Stage new supported broker exports when they appear in this exact folder.',
        'Automatic',
      ],
    ];
    return (
      <>
        <div className="ocn-add-heading">
          <span>Storage role</span>
          <h2>Give this Drive connection one clear job.</h2>
          <p>
            Separate roles prevent a convenient file connection from quietly becoming your data home
            or an automatic importer.
          </p>
        </div>
        <div className="ocn-drive-roles">
          {roles.map(([role, icon, title, copy, tag]) => (
            <button
              aria-pressed={driveRole === role}
              className={driveRole === role ? 'is-active' : ''}
              key={role}
              onClick={() => onDriveRole(role)}
              type="button"
            >
              <span>
                <Icon name={icon} size={19} />
              </span>
              <i>
                <strong>{title}</strong>
                <small>{copy}</small>
              </i>
              <em>{tag}</em>
              <b>{driveRole === role ? <Icon name="check" size={13} /> : null}</b>
            </button>
          ))}
        </div>
      </>
    );
  }

  const options = syncOptions(provider);
  return (
    <>
      <div className="ocn-add-heading">
        <span>Direction & schedule</span>
        <h2>Choose how data should move.</h2>
        <p>
          Direction is part of the connection contract. BetterTrack will not export or write because
          an import permission happens to exist.
        </p>
      </div>
      <div className="ocn-direction-options">
        {options.map((option) => (
          <button
            aria-pressed={syncMode === option.mode}
            className={syncMode === option.mode ? 'is-active' : ''}
            key={option.mode}
            onClick={() => onSyncMode(option.mode)}
            type="button"
          >
            <div className="ocn-direction-diagram">
              <span>{provider.initials}</span>
              <i>
                <Icon name={option.icon} size={18} />
              </i>
              <span className="is-bt">BT</span>
            </div>
            <span>
              <em>{option.tag}</em>
              <strong>{option.title}</strong>
              <small>{option.copy}</small>
            </span>
            <b>{syncMode === option.mode ? <Icon name="check" size={13} /> : null}</b>
          </button>
        ))}
      </div>
      {syncMode === 'two-way' ? (
        <div className="ocn-two-way-warning">
          <Icon name="repeat" size={17} />
          <span>
            <strong>Two-way does not mean last-write-wins</strong>
            If the same portable field changes on both sides, BetterTrack pauses that record and
            asks you to choose. Unsupported fields remain where they originated.
          </span>
        </div>
      ) : null}
    </>
  );
}

function StagedSyncStep({
  provider,
  account,
  portfolio,
  syncMode,
  progress,
  complete,
  approved,
  onStart,
  onApprove,
}: {
  provider: ProviderDefinition;
  account: string;
  portfolio: string;
  syncMode: OriginConnectionSyncMode;
  progress: number;
  complete: boolean;
  approved: boolean;
  onStart: () => void;
  onApprove: (approved: boolean) => void;
}) {
  const [inspection, setInspection] = useState<'lots' | 'field' | null>(null);
  const records =
    provider.category === 'broker'
      ? 847
      : provider.id === 'parqet'
        ? 1264
        : provider.category === 'bank'
          ? 392
          : 14;
  return (
    <>
      <div className="ocn-add-heading">
        <span>Staged first sync</span>
        <h2>Inspect the result before it becomes live.</h2>
        <p>
          The initial read happens in an isolated stage. Coverage, missing data, duplicates and
          value reconciliation are visible before approval.
        </p>
      </div>
      {!progress ? (
        <button className="ocn-stage-start" onClick={onStart} type="button">
          <span>
            <ProviderMark provider={provider} />
            <i>
              <small>Source</small>
              <strong>{account}</strong>
            </i>
          </span>
          <i>
            <Icon
              name={
                syncMode === 'two-way' ? 'repeat' : syncMode === 'export' ? 'upload' : 'download'
              }
              size={21}
            />
          </i>
          <span>
            <span className="ocn-bt-mark" />
            <i>
              <small>Staged destination</small>
              <strong>{portfolio}</strong>
            </i>
          </span>
          <em>
            <Icon name="sparkles" size={15} />
            Run staged sync
          </em>
        </button>
      ) : (
        <div className="ocn-staging">
          <div className="ocn-stage-progress">
            <span
              aria-label="Initial staged synchronization progress"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={progress}
              role="progressbar"
              style={{ '--stage-progress': `${progress * 3.6}deg` } as React.CSSProperties}
            >
              <i>{complete ? <Icon name="check" size={22} /> : `${progress}%`}</i>
            </span>
            <div>
              <small>{complete ? 'Stage complete' : 'Analyzing source'}</small>
              <h3>
                {complete
                  ? `${records.toLocaleString()} records are ready`
                  : progress < 25
                    ? 'Reading source schema'
                    : progress < 55
                      ? 'Matching assets and accounts'
                      : progress < 80
                        ? 'Detecting duplicates'
                        : 'Reconciling portfolio value'}
              </h3>
              <p>
                {complete
                  ? 'No live portfolio data has changed yet.'
                  : 'You can safely leave this setup; the stage can be discarded.'}
              </p>
            </div>
          </div>
          <div className="ocn-stage-checks">
            {[
              ['Source authorized', 10],
              ['Schema recognized', 28],
              ['Assets matched', 52],
              ['Duplicates classified', 73],
              ['Value reconciled', 92],
            ].map(([label, threshold]) => (
              <span className={progress >= Number(threshold) ? 'is-done' : ''} key={label}>
                <i>{progress >= Number(threshold) ? <Icon name="check" size={11} /> : null}</i>
                {label}
              </span>
            ))}
          </div>
        </div>
      )}
      {complete ? (
        <>
          <div className="ocn-stage-result">
            <span>
              <small>Records found</small>
              <strong>{records.toLocaleString()}</strong>
              <em>100% structurally valid</em>
            </span>
            <span>
              <small>Field coverage</small>
              <strong>{provider.id === 'parqet' ? '97%' : '99%'}</strong>
              <em>
                {provider.id === 'parqet' ? '1 grouping unsupported' : 'Portable core covered'}
              </em>
            </span>
            <span>
              <small>Duplicates</small>
              <strong>24</strong>
              <em>Will be linked, not copied</em>
            </span>
            <span>
              <small>Reconciliation</small>
              <strong className="is-positive">Balanced</strong>
              <em>€0.00 unexplained</em>
            </span>
          </div>
          <div className="ocn-stage-exceptions">
            <div>
              <Icon name="activity" size={16} />
              <span>
                <strong>3 positions have incomplete acquisition data</strong>
                Current value is exact. Tax lots and performance before the first recorded purchase
                will show a coverage marker.
              </span>
              <button
                aria-expanded={inspection === 'lots'}
                onClick={() => setInspection((current) => (current === 'lots' ? null : 'lots'))}
                type="button"
              >
                Inspect 3
              </button>
            </div>
            <div>
              <Icon name="minus" size={16} />
              <span>
                <strong>1 provider-native field stays at the source</strong>
                This has no effect on value, performance, tax or future duplicate detection.
              </span>
              <button
                aria-expanded={inspection === 'field'}
                onClick={() => setInspection((current) => (current === 'field' ? null : 'field'))}
                type="button"
              >
                View field
              </button>
            </div>
          </div>
          {inspection ? (
            <section className="ocn-stage-inspection" aria-live="polite">
              <header>
                <span>
                  <Icon name={inspection === 'lots' ? 'activity' : 'document'} size={15} />
                  <strong>
                    {inspection === 'lots'
                      ? 'Acquisition details to resolve later'
                      : 'Provider-native field retained at source'}
                  </strong>
                </span>
                <button
                  aria-label="Close inspection"
                  onClick={() => setInspection(null)}
                  type="button"
                >
                  <Icon name="x" size={13} />
                </button>
              </header>
              {inspection === 'lots' ? (
                <div className="ocn-stage-inspection__rows">
                  {[
                    ['VWCE', '14.273 units', 'Purchase date known · basis missing'],
                    ['AAPL', '8 units', 'Basis estimated from first source snapshot'],
                    ['BTC', '0.084 BTC', 'Two acquisition records need matching'],
                  ].map(([asset, quantity, issue]) => (
                    <div key={asset}>
                      <strong>{asset}</strong>
                      <span>{quantity}</span>
                      <small>{issue}</small>
                      <em>Sent to Tax & basis review</em>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ocn-stage-inspection__field">
                  <span>Parqet dashboard color</span>
                  <strong>portfolio_theme = “sunset”</strong>
                  <p>
                    This presentation preference is not part of the portable portfolio schema. It
                    stays in Parqet and is ignored without affecting any financial calculation.
                  </p>
                </div>
              )}
            </section>
          ) : null}
          <button
            aria-pressed={approved}
            className={cn('ocn-stage-approve', approved && 'is-active')}
            onClick={() => onApprove(!approved)}
            type="button"
          >
            <i>{approved ? <Icon name="check" size={13} /> : null}</i>
            <span>
              <strong>Apply this staged result</strong>
              Create the connection, link matching records and import the explained differences.
            </span>
          </button>
        </>
      ) : null}
    </>
  );
}

function ConnectionReview({
  provider,
  account,
  portfolio,
  syncMode,
  driveRole,
}: {
  provider: ProviderDefinition;
  account: string;
  portfolio: string;
  syncMode: OriginConnectionSyncMode;
  driveRole: OriginConnectionRecord['driveRole'];
}) {
  return (
    <>
      <div className="ocn-add-heading">
        <span>Connection review</span>
        <h2>Ready to keep this source connected.</h2>
        <p>
          BetterTrack will apply the approved stage, save the permission boundary and begin the
          selected schedule.
        </p>
      </div>
      <div className="ocn-review-hero">
        <ProviderMark provider={provider} />
        <div>
          <small>{categoryLabels[provider.category]}</small>
          <h3>{provider.name}</h3>
          <p>{account}</p>
        </div>
        <Status status="healthy" label="Ready" />
      </div>
      <div className="ocn-review-grid">
        <div>
          <span>
            <Icon name="portfolio" size={17} />
          </span>
          <i>
            <small>Destination</small>
            <strong>{portfolio}</strong>
            <em>Existing portfolio</em>
          </i>
        </div>
        <div>
          <span>
            <Icon name="repeat" size={17} />
          </span>
          <i>
            <small>{provider.id === 'google-drive' ? 'Storage role' : 'Sync direction'}</small>
            <strong>
              {provider.id === 'google-drive'
                ? driveRole?.replaceAll('-', ' ')
                : syncMode.replaceAll('-', ' ')}
            </strong>
            <em>{provider.support}</em>
          </i>
        </div>
        <div>
          <span>
            <Icon name="database" size={17} />
          </span>
          <i>
            <small>Initial stage</small>
            <strong>Balanced and approved</strong>
            <em>Exceptions remain visible</em>
          </i>
        </div>
        <div>
          <span>
            <Icon name="shield" size={17} />
          </span>
          <i>
            <small>Control</small>
            <strong>Pause or revoke anytime</strong>
            <em>Imported records are retained</em>
          </i>
        </div>
      </div>
      <div className="ocn-review-timeline">
        <span>
          <i>
            <Icon name="check" size={11} />
          </i>
          <strong>Now</strong>
          <small>Apply staged records</small>
        </span>
        <b />
        <span>
          <i>2</i>
          <strong>In one hour</strong>
          <small>First scheduled source check</small>
        </span>
        <b />
        <span>
          <i>3</i>
          <strong>Only if needed</strong>
          <small>Surface conflicts for review</small>
        </span>
      </div>
    </>
  );
}

function defaultSyncMode(
  provider: ProviderDefinition,
  role: OriginConnectionRecord['driveRole'],
): OriginConnectionSyncMode {
  if (provider.category === 'bank') return 'read-only-cash';
  if (provider.category === 'broker') return 'continuous-import';
  if (provider.id === 'parqet') return 'manual-import';
  return role || 'backup';
}

function syncOptions(provider: ProviderDefinition) {
  if (provider.category === 'bank') {
    return [
      {
        mode: 'read-only-cash' as const,
        icon: 'download' as IconName,
        title: 'Read-only cash sync',
        copy: 'Import balances and cash movements. Never initiate payments.',
        tag: 'Only available mode',
      },
    ];
  }
  if (provider.category === 'broker') {
    return [
      {
        mode: 'continuous-import' as const,
        icon: 'download' as IconName,
        title: 'Continuous read-only import',
        copy: 'Check for new positions and activity on a schedule.',
        tag: 'Recommended',
      },
      {
        mode: 'manual-import' as const,
        icon: 'download' as IconName,
        title: 'Import only when requested',
        copy: 'Keep authorization but run each source read manually.',
        tag: 'Manual control',
      },
    ];
  }
  return [
    {
      mode: 'manual-import' as const,
      icon: 'download' as IconName,
      title: 'Import to BetterTrack',
      copy: 'Parqet remains the source. BetterTrack only reads on request.',
      tag: 'Safest start',
    },
    {
      mode: 'export' as const,
      icon: 'upload' as IconName,
      title: 'Export from BetterTrack',
      copy: 'BetterTrack remains the source and sends portable changes.',
      tag: 'BetterTrack source',
    },
    {
      mode: 'two-way' as const,
      icon: 'repeat' as IconName,
      title: 'Two-way synchronization',
      copy: 'Changes travel both ways; overlapping edits require a decision.',
      tag: 'Advanced',
    },
  ];
}

function syncModeLabel(connection: OriginConnectionRecord) {
  const labels: Record<OriginConnectionSyncMode, string> = {
    'continuous-import': 'Continuous import',
    'manual-import': 'Manual import',
    export: 'Export',
    'two-way': 'Two-way',
    'data-home': 'Data home',
    backup: 'Encrypted backup',
    'watched-import': 'Watched import',
    files: 'File library',
    'read-only-cash': 'Read-only cash',
  };
  return labels[connection.syncMode];
}

function relativeTime(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
  }).format(value);
}
