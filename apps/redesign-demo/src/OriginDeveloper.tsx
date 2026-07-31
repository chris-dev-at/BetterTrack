import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-developer.css';

type DeveloperTab = 'overview' | 'keys' | 'oauth' | 'webhooks' | 'mcp' | 'logs';

type DeveloperPageProps = {
  onToast: (message: string) => void;
  onOpenConnections: () => void;
};

type PermissionId =
  | 'portfolio:read'
  | 'portfolio:write'
  | 'workboard:read'
  | 'workboard:write'
  | 'market:read'
  | 'social:read'
  | 'notifications:read'
  | 'alerts:read'
  | 'alerts:write';

type PortfolioScope = 'all' | 'personal' | 'studio' | 'property';

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  portfolio: PortfolioScope;
  permissions: PermissionId[];
  created: string;
  lastUsed: string;
  revoked: boolean;
};

type OAuthApp = {
  id: string;
  name: string;
  clientId: string;
  kind: 'public' | 'confidential';
  redirects: string[];
  permissions: PermissionId[];
  created: string;
  status: 'Live' | 'Draft';
};

type WebhookEvent =
  | 'portfolio.updated'
  | 'transaction.created'
  | 'holding.changed'
  | 'automation.completed'
  | 'collaborator.added';

type Webhook = {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  successRate: number;
  lastDelivery: string;
};

type Delivery = {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  status: 200 | 202 | 401 | 500;
  duration: number;
  at: string;
  requestId: string;
  attempt: number;
};

type ApiRequest = {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  status: 200 | 201 | 204 | 400 | 401 | 429 | 500;
  duration: number;
  at: string;
  actor: string;
  source: 'API key' | 'OAuth' | 'MCP' | 'Webhook';
};

const tabs: ReadonlyArray<{
  id: DeveloperTab;
  label: string;
  icon: IconName;
  description: string;
}> = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'grid',
    description: 'Platform health, usage, and quick starts',
  },
  {
    id: 'keys',
    label: 'API keys',
    icon: 'lock',
    description: 'Scoped personal access tokens',
  },
  {
    id: 'oauth',
    label: 'OAuth apps',
    icon: 'link',
    description: 'Apps that connect on behalf of users',
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    icon: 'repeat',
    description: 'Push BetterTrack events to your systems',
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: 'command',
    description: 'Give selected AI tools portfolio context',
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: 'list',
    description: 'Requests, errors, and delivery detail',
  },
];

const portfolioLabels: Record<PortfolioScope, string> = {
  all: 'All wealth',
  personal: 'Personal wealth',
  studio: 'Northstar Studio',
  property: 'Riverside property',
};

const permissions: ReadonlyArray<{
  id: PermissionId;
  label: string;
  description: string;
  group: 'Portfolio data' | 'Research & planning' | 'Communication';
}> = [
  {
    id: 'portfolio:read',
    label: 'Read portfolios',
    description: 'Balances, holdings, transactions, cash flow, and files.',
    group: 'Portfolio data',
  },
  {
    id: 'portfolio:write',
    label: 'Change portfolios',
    description: 'Create transactions, update holdings, and run automations.',
    group: 'Portfolio data',
  },
  {
    id: 'workboard:read',
    label: 'Read Workbench',
    description: 'Scenarios, forecasts, Blueprints, and saved ideas.',
    group: 'Research & planning',
  },
  {
    id: 'workboard:write',
    label: 'Change Workbench',
    description: 'Create scenarios, forecasts, and reusable strategies.',
    group: 'Research & planning',
  },
  {
    id: 'market:read',
    label: 'Read market data',
    description: 'Asset metadata, quotes, history, and comparisons.',
    group: 'Research & planning',
  },
  {
    id: 'social:read',
    label: 'Read collaboration',
    description: 'People, shared items, and portfolio collaborators.',
    group: 'Communication',
  },
  {
    id: 'notifications:read',
    label: 'Read notifications',
    description: 'Portfolio reviews, approvals, and account notifications.',
    group: 'Communication',
  },
  {
    id: 'alerts:read',
    label: 'Read alerts',
    description: 'Rules, trigger history, and current alert state.',
    group: 'Communication',
  },
  {
    id: 'alerts:write',
    label: 'Change alerts',
    description: 'Create, pause, re-arm, and remove price alerts.',
    group: 'Communication',
  },
];

const impliedReadScope: Partial<Record<PermissionId, PermissionId>> = {
  'portfolio:write': 'portfolio:read',
  'workboard:write': 'workboard:read',
  'alerts:write': 'alerts:read',
};

const webhookEvents: ReadonlyArray<{
  id: WebhookEvent;
  label: string;
  description: string;
}> = [
  {
    id: 'portfolio.updated',
    label: 'Portfolio updated',
    description: 'A portfolio, cash source, or nested relationship changed.',
  },
  {
    id: 'transaction.created',
    label: 'Transaction created',
    description: 'A trade, income, expense, or transfer was recorded.',
  },
  {
    id: 'holding.changed',
    label: 'Holding changed',
    description: 'Quantity, value, or allocation changed materially.',
  },
  {
    id: 'automation.completed',
    label: 'Automation completed',
    description: 'A scheduled rule finished or needs review.',
  },
  {
    id: 'collaborator.added',
    label: 'Collaborator added',
    description: 'Portfolio access or permissions were granted.',
  },
];

const initialKeys: ApiKey[] = [
  {
    id: 'key_mobile_sync',
    name: 'Portfolio sync',
    prefix: 'btk_K9wA••••',
    portfolio: 'all',
    permissions: ['portfolio:read', 'market:read'],
    created: 'Jul 12, 2026',
    lastUsed: '4 min ago',
    revoked: false,
  },
  {
    id: 'key_tax_export',
    name: 'Tax export worker',
    prefix: 'btk_D2fQ••••',
    portfolio: 'personal',
    permissions: ['portfolio:read'],
    created: 'Jun 28, 2026',
    lastUsed: 'Yesterday',
    revoked: false,
  },
  {
    id: 'key_old_sheet',
    name: 'Spreadsheet experiment',
    prefix: 'btk_P1eV••••',
    portfolio: 'studio',
    permissions: ['portfolio:read', 'market:read'],
    created: 'Apr 03, 2026',
    lastUsed: 'Never',
    revoked: true,
  },
];

const initialApps: OAuthApp[] = [
  {
    id: 'oauth_parqet_bridge',
    name: 'Parqet Bridge',
    clientId: 'bt_client_8fD21pQ',
    kind: 'confidential',
    redirects: ['https://bridge.example.dev/oauth/callback'],
    permissions: ['portfolio:read', 'portfolio:write', 'market:read'],
    created: 'Jul 04, 2026',
    status: 'Live',
  },
  {
    id: 'oauth_mobile_lab',
    name: 'BetterTrack Mobile Lab',
    clientId: 'bt_client_2xM90aL',
    kind: 'public',
    redirects: ['bettertrack-lab://oauth/callback', 'http://127.0.0.1:4545/callback'],
    permissions: ['portfolio:read', 'workboard:read', 'notifications:read'],
    created: 'Jun 19, 2026',
    status: 'Draft',
  },
];

const initialWebhooks: Webhook[] = [
  {
    id: 'wh_accounting',
    name: 'Accounting mirror',
    url: 'https://hooks.northstar.studio/bettertrack',
    events: ['transaction.created', 'portfolio.updated'],
    active: true,
    successRate: 99.96,
    lastDelivery: '38 sec ago',
  },
  {
    id: 'wh_automation',
    name: 'Automation monitor',
    url: 'https://ops.example.dev/wealth-events',
    events: ['automation.completed', 'holding.changed'],
    active: true,
    successRate: 98.72,
    lastDelivery: '14 min ago',
  },
];

const initialDeliveries: Delivery[] = [
  {
    id: 'del_1842',
    webhookId: 'wh_accounting',
    event: 'transaction.created',
    status: 200,
    duration: 184,
    at: '02:47:18',
    requestId: 'req_91c7d',
    attempt: 1,
  },
  {
    id: 'del_1841',
    webhookId: 'wh_accounting',
    event: 'portfolio.updated',
    status: 200,
    duration: 161,
    at: '02:42:03',
    requestId: 'req_74a2e',
    attempt: 1,
  },
  {
    id: 'del_1840',
    webhookId: 'wh_automation',
    event: 'automation.completed',
    status: 202,
    duration: 238,
    at: '02:33:51',
    requestId: 'req_63fb1',
    attempt: 1,
  },
  {
    id: 'del_1839',
    webhookId: 'wh_automation',
    event: 'holding.changed',
    status: 500,
    duration: 1_209,
    at: '02:31:09',
    requestId: 'req_598b4',
    attempt: 3,
  },
];

const initialRequests: ApiRequest[] = [
  {
    id: 'req_8f22a',
    method: 'GET',
    path: '/v1/portfolios/pf_personal/holdings',
    status: 200,
    duration: 84,
    at: '02:48:12.491',
    actor: 'Portfolio sync',
    source: 'API key',
  },
  {
    id: 'req_7dc14',
    method: 'POST',
    path: '/v1/portfolios/pf_personal/scenarios',
    status: 201,
    duration: 231,
    at: '02:47:55.206',
    actor: 'Claude Desktop',
    source: 'MCP',
  },
  {
    id: 'req_6ba81',
    method: 'GET',
    path: '/v1/market/assets/VWCE/history?range=1Y',
    status: 200,
    duration: 119,
    at: '02:47:41.884',
    actor: 'Parqet Bridge',
    source: 'OAuth',
  },
  {
    id: 'req_5e190',
    method: 'PATCH',
    path: '/v1/alerts/al_48d1',
    status: 200,
    duration: 91,
    at: '02:46:02.107',
    actor: 'BetterTrack Mobile Lab',
    source: 'OAuth',
  },
  {
    id: 'req_4c118',
    method: 'POST',
    path: '/v1/portfolios/pf_studio/transactions',
    status: 401,
    duration: 42,
    at: '02:44:39.712',
    actor: 'Tax export worker',
    source: 'API key',
  },
  {
    id: 'req_3af72',
    method: 'GET',
    path: '/v1/portfolios',
    status: 429,
    duration: 22,
    at: '02:43:16.350',
    actor: 'Portfolio sync',
    source: 'API key',
  },
  {
    id: 'req_292fe',
    method: 'POST',
    path: '/v1/webhooks/wh_accounting/test',
    status: 204,
    duration: 188,
    at: '02:42:51.029',
    actor: 'Alex Morgan',
    source: 'Webhook',
  },
  {
    id: 'req_160b8',
    method: 'GET',
    path: '/v1/workbench/forecasts/fc_83b',
    status: 200,
    duration: 76,
    at: '02:41:03.816',
    actor: 'Claude Desktop',
    source: 'MCP',
  },
];

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function useDeveloperState<T>(key: string, initial: T) {
  const storageKey = `bt-demo-developer-${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  }, [storageKey, value]);

  return [value, setValue] as const;
}

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function issueToken(prefix: 'btk_demo' | 'btsec_demo' | 'btwhsec_demo') {
  const body = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2)}`;
  return `${prefix}_${body}`;
}

async function copyText(value: string, label: string, onToast: (message: string) => void) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
    } else {
      const fallback = document.createElement('textarea');
      fallback.value = value;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }
    onToast(`${label} copied`);
  } catch {
    onToast(`Could not copy ${label.toLowerCase()}`);
  }
}

function DevButton({
  children,
  icon,
  tone = 'secondary',
  compact = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  icon?: IconName;
  tone?: 'primary' | 'secondary' | 'quiet' | 'danger';
  compact?: boolean;
}) {
  return (
    <button
      className={cx('dev-button', `dev-button--${tone}`, compact && 'dev-button--compact')}
      type="button"
      {...props}
    >
      {icon ? <Icon name={icon} size={compact ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

function StatePill({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue';
}) {
  return <span className={`dev-state dev-state--${tone}`}>{children}</span>;
}

function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="dev-section-heading">
      <div>
        {eyebrow ? <span className="dev-kicker">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="dev-section-heading__actions">{actions}</div> : null}
    </header>
  );
}

function Modal({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="dev-modal-layer">
      <button
        aria-label="Close dialog"
        className="dev-modal-backdrop"
        onClick={onClose}
        type="button"
      />
      <section
        aria-describedby="developer-dialog-description"
        aria-labelledby="developer-dialog-title"
        aria-modal="true"
        className="dev-modal"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="developer-dialog-title">{title}</h2>
            <p id="developer-dialog-description">{description}</p>
          </div>
          <button aria-label="Close dialog" onClick={onClose} type="button">
            <Icon name="x" size={17} />
          </button>
        </header>
        <div className="dev-modal__body">{children}</div>
      </section>
    </div>
  );
}

function PortfolioSelect({
  value,
  onChange,
  id,
}: {
  value: PortfolioScope;
  onChange: (scope: PortfolioScope) => void;
  id: string;
}) {
  return (
    <label className="dev-field" htmlFor={id}>
      <span>Portfolio access</span>
      <small>Limit this credential to only the wealth it needs.</small>
      <select
        id={id}
        onChange={(event) => onChange(event.target.value as PortfolioScope)}
        value={value}
      >
        {Object.entries(portfolioLabels).map(([scope, label]) => (
          <option key={scope} value={scope}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PermissionPicker({
  selected,
  onChange,
  compact = false,
}: {
  selected: Set<PermissionId>;
  onChange: (next: Set<PermissionId>) => void;
  compact?: boolean;
}) {
  function toggle(id: PermissionId) {
    const next = new Set(selected);
    if (next.has(id)) {
      const write = Object.entries(impliedReadScope).find(([, read]) => read === id)?.[0] as
        | PermissionId
        | undefined;
      if (write && next.has(write)) return;
      next.delete(id);
    } else {
      next.add(id);
      const implied = impliedReadScope[id];
      if (implied) next.add(implied);
    }
    onChange(next);
  }

  const groups = ['Portfolio data', 'Research & planning', 'Communication'] as const;
  return (
    <fieldset className={cx('dev-permissions', compact && 'dev-permissions--compact')}>
      <legend>Permissions</legend>
      <p>Write access always includes the matching read permission.</p>
      {groups.map((group) => (
        <div className="dev-permission-group" key={group}>
          <span>{group}</span>
          <div>
            {permissions
              .filter((permission) => permission.group === group)
              .map((permission) => {
                const write = Object.entries(impliedReadScope).find(
                  ([, read]) => read === permission.id,
                )?.[0] as PermissionId | undefined;
                const locked = Boolean(write && selected.has(write));
                return (
                  <label key={permission.id}>
                    <input
                      checked={selected.has(permission.id)}
                      disabled={locked}
                      onChange={() => toggle(permission.id)}
                      type="checkbox"
                    />
                    <span>
                      <strong>{permission.label}</strong>
                      <small>{permission.description}</small>
                      <code>{permission.id}</code>
                    </span>
                    {locked ? <em>Included</em> : null}
                  </label>
                );
              })}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

function CredentialModal({
  title,
  description,
  fields,
  onClose,
  onToast,
}: {
  title: string;
  description: string;
  fields: Array<{ label: string; value: string; secret?: boolean }>;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  return (
    <Modal description={description} onClose={onClose} title={title}>
      <div className="dev-once-warning">
        <Icon name="shield" size={18} />
        <span>
          <strong>Shown once</strong>
          <small>Store these credentials now. BetterTrack cannot reveal secrets again.</small>
        </span>
      </div>
      <div className="dev-credential-list">
        {fields.map((field) => (
          <div key={field.label}>
            <span>{field.label}</span>
            <code className={field.secret ? 'is-secret' : undefined}>{field.value}</code>
            <DevButton
              compact
              icon="document"
              onClick={() => void copyText(field.value, field.label, onToast)}
            >
              Copy
            </DevButton>
          </div>
        ))}
      </div>
      <footer className="dev-form-footer">
        <DevButton onClick={onClose} tone="primary">
          I stored these safely
        </DevButton>
      </footer>
    </Modal>
  );
}

function UsageBars({ values }: { values: number[] }) {
  return (
    <div aria-label="Requests over time" className="dev-usage-bars" role="img">
      {values.map((value, index) => (
        <span key={`${index}-${value}`}>
          <i style={{ height: `${value}%` }} />
        </span>
      ))}
    </div>
  );
}

function OverviewPanel({
  onNavigate,
  onToast,
  onOpenConnections,
}: {
  onNavigate: (tab: DeveloperTab) => void;
  onToast: (message: string) => void;
  onOpenConnections: () => void;
}) {
  const usage = [
    30, 35, 32, 41, 38, 47, 51, 45, 48, 56, 52, 58, 64, 61, 68, 57, 66, 73, 78, 69, 72, 82, 76, 88,
    84, 79, 91, 86, 72, 77, 81, 74, 85, 93, 88, 96, 91, 83, 89, 78, 86, 94, 88, 80, 90, 84, 97, 92,
  ];
  const curl = `curl https://api.bettertrack.app/v1/portfolios \\
  -H "Authorization: Bearer btk_••••••••"`;

  return (
    <div
      aria-labelledby="developer-tab-overview"
      className="dev-tab-panel"
      id="developer-panel-overview"
      role="tabpanel"
    >
      <section className="dev-overview-hero">
        <div className="dev-overview-hero__copy">
          <div>
            <DevButton icon="lock" onClick={() => onNavigate('keys')} tone="primary">
              Create API key
            </DevButton>
            <DevButton icon="link" onClick={() => onNavigate('oauth')}>
              Register OAuth app
            </DevButton>
          </div>
        </div>
        <div className="dev-quickstart">
          <header>
            <span>
              <i />
              <i />
              <i />
            </span>
            <strong>First request</strong>
            <button
              aria-label="Copy first request"
              onClick={() => void copyText(curl, 'Request', onToast)}
              type="button"
            >
              <Icon name="document" size={14} />
              Copy
            </button>
          </header>
          <pre>
            <code>{curl}</code>
          </pre>
          <footer>
            <span>
              <Icon name="check" size={13} /> 200 OK
            </span>
            <span>84 ms</span>
          </footer>
        </div>
      </section>

      <section aria-label="Developer usage summary" className="dev-metric-strip">
        <div>
          <span>Success rate</span>
          <strong>99.94%</strong>
          <small>Across API, MCP, and hooks</small>
        </div>
        <div>
          <span>Median latency</span>
          <strong>92 ms</strong>
          <small className="positive">−18 ms</small>
        </div>
        <div>
          <span>Active integrations</span>
          <strong>7</strong>
          <small>2 need attention</small>
        </div>
      </section>

      <section className="dev-overview-grid">
        <article className="dev-usage-section">
          <header>
            <div>
              <h3>Usage</h3>
            </div>
            <StatePill tone="green">31.8% used</StatePill>
          </header>
          <div className="dev-usage-total">
            <strong>318.4k</strong>
            <span>of 1 million monthly requests</span>
          </div>
          <UsageBars values={usage} />
          <footer>
            <span>Jun 28</span>
            <span>Jul 27</span>
          </footer>
        </article>
      </section>

      <section className="dev-recent-section">
        <SectionHeader
          actions={
            <DevButton compact icon="arrow-right" onClick={() => onNavigate('logs')} tone="quiet">
              Open logs
            </DevButton>
          }
          description=""
          eyebrow=""
          title="Recent activity"
        />
        <div className="dev-activity-list">
          {initialRequests.slice(0, 5).map((request) => (
            <div key={request.id}>
              <span className={`dev-method dev-method--${request.method.toLowerCase()}`}>
                {request.method}
              </span>
              <code>{request.path}</code>
              <span>{request.actor}</span>
              <StatePill tone={request.status < 300 ? 'green' : 'red'}>{request.status}</StatePill>
              <small>{request.duration} ms</small>
            </div>
          ))}
        </div>
        <footer className="dev-platform-footer">
          <span>
            <Icon name="shield" size={15} />
            Connections inherit the same portfolio permissions.
          </span>
          <button onClick={onOpenConnections} type="button">
            Manage connected services <Icon name="arrow-right" size={13} />
          </button>
        </footer>
      </section>
    </div>
  );
}

function ApiKeysPanel({ onToast }: { onToast: (message: string) => void }) {
  const [keys, setKeys] = useDeveloperState<ApiKey[]>('api-keys', initialKeys);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('Portfolio data pipeline');
  const [portfolio, setPortfolio] = useState<PortfolioScope>('personal');
  const [selected, setSelected] = useState<Set<PermissionId>>(
    new Set(['portfolio:read', 'market:read']),
  );
  const [issued, setIssued] = useState<{ token: string; name: string } | null>(null);

  function createKey(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || selected.size === 0) return;
    const token = issueToken('btk_demo');
    const key: ApiKey = {
      id: uid('key'),
      name: name.trim(),
      prefix: `${token.slice(0, 12)}••••`,
      portfolio,
      permissions: permissions
        .map((permission) => permission.id)
        .filter((permission) => selected.has(permission)),
      created: 'Just now',
      lastUsed: 'Never',
      revoked: false,
    };
    setKeys((current) => [key, ...current]);
    setCreateOpen(false);
    setIssued({ token, name: key.name });
    setName('Portfolio data pipeline');
    setPortfolio('personal');
    setSelected(new Set(['portfolio:read', 'market:read']));
    onToast(`${key.name} created`);
  }

  function revoke(id: string) {
    setKeys((current) => current.map((key) => (key.id === id ? { ...key, revoked: true } : key)));
    onToast('API key revoked immediately');
  }

  const activeKeys = keys.filter((key) => !key.revoked).length;

  return (
    <div
      aria-labelledby="developer-tab-keys"
      className="dev-tab-panel"
      id="developer-panel-keys"
      role="tabpanel"
    >
      <SectionHeader
        actions={
          <DevButton icon="plus" onClick={() => setCreateOpen(true)} tone="primary">
            Create key
          </DevButton>
        }
        description="For your own scripts, services, and scheduled jobs. Keys can never reach admin APIs."
        eyebrow="PERSONAL ACCESS"
        title="API keys"
      />

      <section className="dev-inline-note">
        <Icon name="shield" size={18} />
        <div>
          <strong>Least privilege by default</strong>
          <p>
            Keys are constrained twice: first to a portfolio boundary, then to explicit read or
            write permissions. Write permissions automatically include their matching read access.
          </p>
        </div>
        <span>{activeKeys} active</span>
      </section>

      <section aria-label="API keys" className="dev-object-list">
        <header className="dev-object-list__columns dev-key-columns">
          <span>Name</span>
          <span>Portfolio</span>
          <span>Permissions</span>
          <span>Activity</span>
          <span />
        </header>
        {keys.map((key) => (
          <article
            className={cx('dev-object-row', 'dev-key-columns', key.revoked && 'is-disabled')}
            key={key.id}
          >
            <div className="dev-object-identity">
              <span className="dev-object-icon">
                <Icon name="lock" size={17} />
              </span>
              <span>
                <strong>{key.name}</strong>
                <code>{key.prefix}</code>
              </span>
            </div>
            <div>
              <strong>{portfolioLabels[key.portfolio]}</strong>
              <small>{key.portfolio === 'all' ? 'All current portfolios' : 'One portfolio'}</small>
            </div>
            <div className="dev-scope-chips">
              {key.permissions.slice(0, 3).map((permission) => (
                <code key={permission}>{permission}</code>
              ))}
              {key.permissions.length > 3 ? <span>+{key.permissions.length - 3}</span> : null}
            </div>
            <div>
              <strong>{key.revoked ? 'Revoked' : key.lastUsed}</strong>
              <small>Created {key.created}</small>
            </div>
            <div className="dev-row-actions">
              {key.revoked ? (
                <StatePill>Inactive</StatePill>
              ) : (
                <DevButton
                  aria-label={`Revoke ${key.name}`}
                  compact
                  onClick={() => revoke(key.id)}
                  tone="quiet"
                >
                  Revoke
                </DevButton>
              )}
            </div>
          </article>
        ))}
      </section>

      <section className="dev-doc-callout">
        <div>
          <span className="dev-kicker">AUTHENTICATION</span>
          <h3>Use a bearer token in every request</h3>
          <p>Tokens start with a recognizable btk_ prefix and are only returned at creation.</p>
        </div>
        <code>Authorization: Bearer btk_••••••••••••</code>
        <DevButton
          compact
          icon="document"
          onClick={() => void copyText('Authorization: Bearer btk_YOUR_KEY', 'Header', onToast)}
        >
          Copy header
        </DevButton>
      </section>

      {createOpen ? (
        <Modal
          description="Choose the smallest portfolio boundary and permission set this service needs."
          onClose={() => setCreateOpen(false)}
          title="Create API key"
        >
          <form className="dev-form" onSubmit={createKey}>
            <label className="dev-field" htmlFor="developer-key-name">
              <span>Key name</span>
              <small>Name the script or service so activity is attributable.</small>
              <input
                id="developer-key-name"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <PortfolioSelect
              id="developer-key-portfolio"
              onChange={setPortfolio}
              value={portfolio}
            />
            <PermissionPicker onChange={setSelected} selected={selected} />
            <footer className="dev-form-footer">
              <DevButton onClick={() => setCreateOpen(false)}>Cancel</DevButton>
              <button
                className="dev-button dev-button--primary"
                disabled={!name.trim() || selected.size === 0}
                type="submit"
              >
                Create secure key
              </button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {issued ? (
        <CredentialModal
          description={`${issued.name} is ready. The full token disappears when this dialog closes.`}
          fields={[{ label: 'API token', value: issued.token, secret: true }]}
          onClose={() => setIssued(null)}
          onToast={onToast}
          title="Your new API key"
        />
      ) : null}
    </div>
  );
}

function OAuthPanel({ onToast }: { onToast: (message: string) => void }) {
  const [apps, setApps] = useDeveloperState<OAuthApp[]>('oauth-apps', initialApps);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('Wealth companion');
  const [kind, setKind] = useState<'public' | 'confidential'>('public');
  const [redirects, setRedirects] = useState('wealth-companion://oauth/callback');
  const [selected, setSelected] = useState<Set<PermissionId>>(
    new Set(['portfolio:read', 'market:read']),
  );
  const [issued, setIssued] = useState<{
    name: string;
    clientId: string;
    secret: string | null;
  } | null>(null);

  function createApp(event: FormEvent) {
    event.preventDefault();
    const parsedRedirects = redirects
      .split('\n')
      .map((redirect) => redirect.trim())
      .filter(Boolean);
    if (!name.trim() || parsedRedirects.length === 0 || selected.size === 0) return;
    const clientId = `bt_client_${Math.random().toString(36).slice(2, 11)}`;
    const secret = kind === 'confidential' ? issueToken('btsec_demo') : null;
    const app: OAuthApp = {
      id: uid('oauth'),
      name: name.trim(),
      clientId,
      kind,
      redirects: parsedRedirects,
      permissions: permissions
        .map((permission) => permission.id)
        .filter((permission) => selected.has(permission)),
      created: 'Just now',
      status: 'Draft',
    };
    setApps((current) => [app, ...current]);
    setCreateOpen(false);
    setIssued({ name: app.name, clientId, secret });
    onToast(`${app.name} registered`);
  }

  function removeApp(id: string) {
    setApps((current) => current.filter((app) => app.id !== id));
    onToast('OAuth app deleted and grants revoked');
  }

  return (
    <div
      aria-labelledby="developer-tab-oauth"
      className="dev-tab-panel"
      id="developer-panel-oauth"
      role="tabpanel"
    >
      <SectionHeader
        actions={
          <DevButton icon="plus" onClick={() => setCreateOpen(true)} tone="primary">
            Register app
          </DevButton>
        }
        description="Let people connect their BetterTrack data to your product through a clear consent flow."
        eyebrow="USER AUTHORIZATION"
        title="OAuth apps"
      />

      <section className="dev-oauth-flow" aria-label="OAuth authorization flow">
        <div>
          <span>
            <Icon name="user-plus" size={18} />
          </span>
          <strong>User chooses account</strong>
          <small>BetterTrack confirms the active identity.</small>
        </div>
        <Icon name="arrow-right" size={16} />
        <div>
          <span>
            <Icon name="shield" size={18} />
          </span>
          <strong>Reviews access</strong>
          <small>Scopes are translated into plain language.</small>
        </div>
        <Icon name="arrow-right" size={16} />
        <div>
          <span>
            <Icon name="link" size={18} />
          </span>
          <strong>Returns with code</strong>
          <small>Authorization code + PKCE, never a raw password.</small>
        </div>
      </section>

      <section aria-label="Registered OAuth apps" className="dev-app-grid">
        {apps.map((app) => (
          <article className="dev-app-object" key={app.id}>
            <header>
              <span className="dev-app-logo">{app.name.slice(0, 2).toUpperCase()}</span>
              <div>
                <strong>{app.name}</strong>
                <small>Registered {app.created}</small>
              </div>
              <StatePill tone={app.status === 'Live' ? 'green' : 'amber'}>{app.status}</StatePill>
            </header>
            <dl>
              <div>
                <dt>Client ID</dt>
                <dd>
                  <code>{app.clientId}</code>
                  <button
                    aria-label={`Copy client ID for ${app.name}`}
                    onClick={() => void copyText(app.clientId, 'Client ID', onToast)}
                    type="button"
                  >
                    <Icon name="document" size={13} />
                  </button>
                </dd>
              </div>
              <div>
                <dt>Client type</dt>
                <dd>{app.kind === 'public' ? 'Public · PKCE' : 'Confidential · Secret'}</dd>
              </div>
              <div>
                <dt>Redirect</dt>
                <dd className="dev-break">{app.redirects[0]}</dd>
              </div>
            </dl>
            <div className="dev-scope-chips">
              {app.permissions.slice(0, 4).map((permission) => (
                <code key={permission}>{permission}</code>
              ))}
              {app.permissions.length > 4 ? <span>+{app.permissions.length - 4}</span> : null}
            </div>
            <footer>
              <DevButton
                compact
                onClick={() => onToast(`Opened settings for ${app.name}`)}
                tone="quiet"
              >
                Configure
              </DevButton>
              <DevButton
                aria-label={`Delete ${app.name}`}
                compact
                onClick={() => removeApp(app.id)}
                tone="quiet"
              >
                Delete
              </DevButton>
            </footer>
          </article>
        ))}
      </section>

      <section className="dev-authorized-apps">
        <SectionHeader
          description="Apps you personally allowed to access BetterTrack."
          eyebrow="YOUR ACCOUNT"
          title="Authorized apps"
        />
        <article>
          <span className="dev-app-logo dev-app-logo--soft">PP</span>
          <div>
            <strong>Portfolio Performance Desktop</strong>
            <small>Read Personal wealth · portfolio:read · market:read</small>
          </div>
          <span>Last used 2 hours ago</span>
          <DevButton
            compact
            onClick={() => onToast('Portfolio Performance access revoked')}
            tone="quiet"
          >
            Revoke access
          </DevButton>
        </article>
      </section>

      {createOpen ? (
        <Modal
          description="Register a public PKCE client or a confidential backend application."
          onClose={() => setCreateOpen(false)}
          title="Register OAuth app"
        >
          <form className="dev-form" onSubmit={createApp}>
            <label className="dev-field" htmlFor="developer-oauth-name">
              <span>App name</span>
              <small>Shown to users on the BetterTrack consent screen.</small>
              <input
                id="developer-oauth-name"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <fieldset className="dev-choice-field">
              <legend>Application type</legend>
              <label>
                <input
                  checked={kind === 'public'}
                  name="oauth-kind"
                  onChange={() => setKind('public')}
                  type="radio"
                />
                <span>
                  <strong>Public · PKCE</strong>
                  <small>Mobile, desktop, and browser apps that cannot hold a secret.</small>
                </span>
              </label>
              <label>
                <input
                  checked={kind === 'confidential'}
                  name="oauth-kind"
                  onChange={() => setKind('confidential')}
                  type="radio"
                />
                <span>
                  <strong>Confidential</strong>
                  <small>Backends that can safely store a client secret.</small>
                </span>
              </label>
            </fieldset>
            <label className="dev-field" htmlFor="developer-oauth-redirects">
              <span>Redirect URIs</span>
              <small>One HTTPS, loopback, or custom-scheme URI per line.</small>
              <textarea
                id="developer-oauth-redirects"
                onChange={(event) => setRedirects(event.target.value)}
                required
                rows={3}
                value={redirects}
              />
            </label>
            <PermissionPicker compact onChange={setSelected} selected={selected} />
            <footer className="dev-form-footer">
              <DevButton onClick={() => setCreateOpen(false)}>Cancel</DevButton>
              <button
                className="dev-button dev-button--primary"
                disabled={!name.trim() || !redirects.trim() || selected.size === 0}
                type="submit"
              >
                Register application
              </button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {issued ? (
        <CredentialModal
          description={`${issued.name} is registered. ${
            issued.secret
              ? 'The client secret disappears when this dialog closes.'
              : 'This public client uses PKCE and has no client secret.'
          }`}
          fields={[
            { label: 'Client ID', value: issued.clientId },
            ...(issued.secret
              ? [{ label: 'Client secret', value: issued.secret, secret: true }]
              : []),
          ]}
          onClose={() => setIssued(null)}
          onToast={onToast}
          title="OAuth credentials"
        />
      ) : null}
    </div>
  );
}

function WebhooksPanel({ onToast }: { onToast: (message: string) => void }) {
  const [hooks, setHooks] = useDeveloperState<Webhook[]>('webhooks', initialWebhooks);
  const [deliveries, setDeliveries] = useDeveloperState<Delivery[]>(
    'webhook-deliveries',
    initialDeliveries,
  );
  const [selectedDelivery, setSelectedDelivery] = useState<Delivery | null>(initialDeliveries[0]!);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('Portfolio event mirror');
  const [url, setUrl] = useState('https://api.example.dev/hooks/bettertrack');
  const [events, setEvents] = useState<Set<WebhookEvent>>(
    new Set(['portfolio.updated', 'transaction.created']),
  );
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);

  function toggleEvent(event: WebhookEvent) {
    const next = new Set(events);
    if (next.has(event)) next.delete(event);
    else next.add(event);
    setEvents(next);
  }

  function createWebhook(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !url.trim() || events.size === 0) return;
    const webhook: Webhook = {
      id: uid('wh'),
      name: name.trim(),
      url: url.trim(),
      events: webhookEvents.map((item) => item.id).filter((item) => events.has(item)),
      active: true,
      successRate: 100,
      lastDelivery: 'Waiting for first event',
    };
    setHooks((current) => [webhook, ...current]);
    setCreateOpen(false);
    setIssuedSecret(issueToken('btwhsec_demo'));
    onToast(`${webhook.name} is listening`);
  }

  function testWebhook(webhook: Webhook) {
    const delivery: Delivery = {
      id: uid('del'),
      webhookId: webhook.id,
      event: webhook.events[0] ?? 'portfolio.updated',
      status: 200,
      duration: 143,
      at: 'Just now',
      requestId: uid('req'),
      attempt: 1,
    };
    setDeliveries((current) => [delivery, ...current]);
    setSelectedDelivery(delivery);
    setHooks((current) =>
      current.map((item) =>
        item.id === webhook.id ? { ...item, lastDelivery: 'Just now' } : item,
      ),
    );
    onToast(`Test delivered to ${webhook.name}`);
  }

  function toggleWebhook(id: string) {
    setHooks((current) =>
      current.map((hook) => (hook.id === id ? { ...hook, active: !hook.active } : hook)),
    );
  }

  const selectedHook = selectedDelivery
    ? hooks.find((hook) => hook.id === selectedDelivery.webhookId)
    : null;

  return (
    <div
      aria-labelledby="developer-tab-webhooks"
      className="dev-tab-panel"
      id="developer-panel-webhooks"
      role="tabpanel"
    >
      <SectionHeader
        actions={
          <DevButton icon="plus" onClick={() => setCreateOpen(true)} tone="primary">
            Add endpoint
          </DevButton>
        }
        description="Receive signed events instead of polling. Deliveries retry with backoff and remain inspectable."
        eyebrow="EVENT DELIVERY"
        title="Webhooks"
      />

      <section className="dev-metric-strip dev-metric-strip--compact">
        <div>
          <span>Deliveries · 24h</span>
          <strong>18,294</strong>
          <small className="positive">+8.2%</small>
        </div>
        <div>
          <span>Success rate</span>
          <strong>99.94%</strong>
          <small>11 retried successfully</small>
        </div>
        <div>
          <span>Median delivery</span>
          <strong>184 ms</strong>
          <small>p95 · 412 ms</small>
        </div>
      </section>

      <section aria-label="Webhook endpoints" className="dev-hook-list">
        {hooks.map((hook) => (
          <article className={cx(!hook.active && 'is-disabled')} key={hook.id}>
            <header>
              <span className="dev-object-icon">
                <Icon name="repeat" size={17} />
              </span>
              <div>
                <strong>{hook.name}</strong>
                <code>{hook.url}</code>
              </div>
              <StatePill tone={hook.active ? 'green' : 'neutral'}>
                {hook.active ? 'Listening' : 'Paused'}
              </StatePill>
            </header>
            <div className="dev-hook-events">
              {hook.events.map((event) => (
                <code key={event}>{event}</code>
              ))}
            </div>
            <dl>
              <div>
                <dt>Success</dt>
                <dd>{hook.successRate}%</dd>
              </div>
              <div>
                <dt>Last delivery</dt>
                <dd>{hook.lastDelivery}</dd>
              </div>
            </dl>
            <footer>
              <DevButton compact onClick={() => testWebhook(hook)}>
                Send test
              </DevButton>
              <DevButton compact onClick={() => toggleWebhook(hook.id)} tone="quiet">
                {hook.active ? 'Pause' : 'Resume'}
              </DevButton>
            </footer>
          </article>
        ))}
      </section>

      <section className="dev-delivery-layout">
        <div className="dev-delivery-list">
          <SectionHeader
            description="Select a delivery to inspect its signed request and response."
            eyebrow="LATEST"
            title="Deliveries"
          />
          <div>
            {deliveries.map((delivery) => {
              const hook = hooks.find((item) => item.id === delivery.webhookId);
              return (
                <button
                  aria-pressed={selectedDelivery?.id === delivery.id}
                  className={cx(selectedDelivery?.id === delivery.id && 'is-active')}
                  key={delivery.id}
                  onClick={() => setSelectedDelivery(delivery)}
                  type="button"
                >
                  <span
                    className={cx(
                      'dev-delivery-status',
                      delivery.status < 300 ? 'is-success' : 'is-error',
                    )}
                  />
                  <span>
                    <strong>{delivery.event}</strong>
                    <small>
                      {hook?.name ?? 'Removed endpoint'} · {delivery.at}
                    </small>
                  </span>
                  <StatePill tone={delivery.status < 300 ? 'green' : 'red'}>
                    {delivery.status}
                  </StatePill>
                  <small>{delivery.duration} ms</small>
                </button>
              );
            })}
          </div>
        </div>
        {selectedDelivery ? (
          <aside className="dev-delivery-detail">
            <header>
              <div>
                <span className="dev-kicker">DELIVERY DETAIL</span>
                <strong>{selectedDelivery.id}</strong>
              </div>
              <StatePill tone={selectedDelivery.status < 300 ? 'green' : 'red'}>
                HTTP {selectedDelivery.status}
              </StatePill>
            </header>
            <dl>
              <div>
                <dt>Endpoint</dt>
                <dd>{selectedHook?.url ?? 'Endpoint removed'}</dd>
              </div>
              <div>
                <dt>Event</dt>
                <dd>{selectedDelivery.event}</dd>
              </div>
              <div>
                <dt>Request ID</dt>
                <dd>
                  <code>{selectedDelivery.requestId}</code>
                </dd>
              </div>
              <div>
                <dt>Attempt</dt>
                <dd>{selectedDelivery.attempt} of 6</dd>
              </div>
            </dl>
            <span>Payload preview</span>
            <pre>
              <code>{`{
  "id": "${selectedDelivery.id}",
  "type": "${selectedDelivery.event}",
  "portfolio_id": "pf_personal",
  "created_at": "2026-07-27T02:47:18Z"
}`}</code>
            </pre>
            <DevButton
              compact
              icon="refresh"
              onClick={() =>
                selectedHook
                  ? testWebhook(selectedHook)
                  : onToast('The original endpoint no longer exists')
              }
            >
              Redeliver
            </DevButton>
          </aside>
        ) : null}
      </section>

      {createOpen ? (
        <Modal
          description="BetterTrack signs every payload. Choose only the events this endpoint handles."
          onClose={() => setCreateOpen(false)}
          title="Add webhook endpoint"
        >
          <form className="dev-form" onSubmit={createWebhook}>
            <label className="dev-field" htmlFor="developer-hook-name">
              <span>Endpoint name</span>
              <small>A recognizable destination for delivery logs.</small>
              <input
                id="developer-hook-name"
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </label>
            <label className="dev-field" htmlFor="developer-hook-url">
              <span>HTTPS endpoint</span>
              <small>Publicly reachable URL that returns a 2xx response.</small>
              <input
                id="developer-hook-url"
                inputMode="url"
                onChange={(event) => setUrl(event.target.value)}
                required
                type="url"
                value={url}
              />
            </label>
            <fieldset className="dev-event-picker">
              <legend>Events</legend>
              {webhookEvents.map((event) => (
                <label key={event.id}>
                  <input
                    checked={events.has(event.id)}
                    onChange={() => toggleEvent(event.id)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{event.label}</strong>
                    <small>{event.description}</small>
                    <code>{event.id}</code>
                  </span>
                </label>
              ))}
            </fieldset>
            <footer className="dev-form-footer">
              <DevButton onClick={() => setCreateOpen(false)}>Cancel</DevButton>
              <button
                className="dev-button dev-button--primary"
                disabled={!name.trim() || !url.trim() || events.size === 0}
                type="submit"
              >
                Create endpoint
              </button>
            </footer>
          </form>
        </Modal>
      ) : null}

      {issuedSecret ? (
        <CredentialModal
          description="Use this secret to verify the signature on every BetterTrack delivery."
          fields={[{ label: 'Signing secret', value: issuedSecret, secret: true }]}
          onClose={() => setIssuedSecret(null)}
          onToast={onToast}
          title="Webhook signing secret"
        />
      ) : null}
    </div>
  );
}

function McpPanel({ onToast }: { onToast: (message: string) => void }) {
  const [enabled, setEnabled] = useDeveloperState('mcp-enabled', true);
  const [portfolio, setPortfolio] = useDeveloperState<PortfolioScope>('mcp-portfolio', 'personal');
  const [selected, setSelected] = useState<Set<PermissionId>>(
    new Set(['portfolio:read', 'workboard:read', 'market:read']),
  );
  const [approvalRequired, setApprovalRequired] = useDeveloperState('mcp-approval-required', true);
  const [tokenVersion, setTokenVersion] = useDeveloperState('mcp-token-version', 4);

  const config = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            bettertrack: {
              type: 'streamable-http',
              url: 'https://mcp.bettertrack.app/v1',
              headers: {
                Authorization: `Bearer btmcp_demo_v${tokenVersion}_••••••••`,
              },
            },
          },
        },
        null,
        2,
      ),
    [tokenVersion],
  );

  const hasWrite = [...selected].some((permission) => permission.endsWith(':write'));

  return (
    <div
      aria-labelledby="developer-tab-mcp"
      className="dev-tab-panel"
      id="developer-panel-mcp"
      role="tabpanel"
    >
      <SectionHeader
        actions={
          <DevButton
            icon={enabled ? 'check' : 'plus'}
            onClick={() => {
              setEnabled((current) => !current);
              onToast(enabled ? 'MCP gateway disabled' : 'MCP gateway enabled');
            }}
            tone={enabled ? 'secondary' : 'primary'}
          >
            {enabled ? 'Gateway enabled' : 'Enable gateway'}
          </DevButton>
        }
        description="Let approved AI tools understand selected BetterTrack data without exposing your whole account."
        eyebrow="MODEL CONTEXT PROTOCOL"
        title="MCP"
      />

      <section className="dev-mcp-hero">
        <div className="dev-mcp-orbit" aria-hidden="true">
          <span>
            <Icon name="command" size={27} />
          </span>
          <i />
          <i />
          <i />
        </div>
        <div>
          <StatePill tone={enabled ? 'green' : 'neutral'}>
            {enabled ? 'Accepting approved clients' : 'Gateway disabled'}
          </StatePill>
          <h3>Ask better questions with your actual financial context.</h3>
          <p>
            BetterTrack exposes structured portfolio, market, and Workbench tools. Every write is
            separately scoped and can require an explicit review inside the suite.
          </p>
        </div>
        <dl>
          <div>
            <dt>Connected clients</dt>
            <dd>2</dd>
          </div>
          <div>
            <dt>Calls · 24h</dt>
            <dd>184</dd>
          </div>
          <div>
            <dt>Writes reviewed</dt>
            <dd>7 / 7</dd>
          </div>
        </dl>
      </section>

      <section className="dev-mcp-layout">
        <div className="dev-mcp-config">
          <SectionHeader
            description="Paste this into any Streamable HTTP compatible MCP client."
            eyebrow="CLIENT CONFIGURATION"
            title="Connect a client"
          />
          <div className="dev-code-block">
            <header>
              <span>bettertrack.mcp.json</span>
              <button
                onClick={() => void copyText(config, 'MCP configuration', onToast)}
                type="button"
              >
                <Icon name="document" size={14} />
                Copy
              </button>
            </header>
            <pre>
              <code>{config}</code>
            </pre>
          </div>
          <div className="dev-mcp-actions">
            <DevButton
              compact
              icon="refresh"
              onClick={() => {
                setTokenVersion((version) => version + 1);
                onToast('MCP access token rotated');
              }}
            >
              Rotate token
            </DevButton>
            <span>Rotating disconnects clients using the previous token.</span>
          </div>
        </div>

        <aside className="dev-mcp-clients">
          <SectionHeader eyebrow="CONNECTED" title="AI clients" />
          {[
            ['Claude Desktop', 'Active now', 'CD'],
            ['Raycast', 'Last used 18 min ago', 'RC'],
          ].map(([name, activity, initials]) => (
            <article key={name}>
              <span>{initials}</span>
              <div>
                <strong>{name}</strong>
                <small>{activity}</small>
              </div>
              <span className="dev-live-dot" />
              <button
                aria-label={`Disconnect ${name}`}
                onClick={() => onToast(`${name} disconnected`)}
                type="button"
              >
                <Icon name="x" size={13} />
              </button>
            </article>
          ))}
          <DevButton
            compact
            icon="plus"
            onClick={() => onToast('A new one-time MCP connection token was generated')}
            tone="quiet"
          >
            Connect another client
          </DevButton>
        </aside>
      </section>

      <section className="dev-mcp-permission-layout">
        <div>
          <SectionHeader
            description="These controls apply to every currently connected MCP client."
            eyebrow="BOUNDARIES"
            title="Data and action permissions"
          />
          <PortfolioSelect id="developer-mcp-portfolio" onChange={setPortfolio} value={portfolio} />
          <PermissionPicker compact onChange={setSelected} selected={selected} />
        </div>
        <aside className="dev-review-policy">
          <span className="dev-kicker">WRITE POLICY</span>
          <h3>Review before BetterTrack changes anything</h3>
          <p>
            An AI may prepare a transaction, automation, or alert. It remains a proposal until you
            approve it in BetterTrack.
          </p>
          <label>
            <span>
              <strong>Require explicit approval</strong>
              <small>Recommended for every finance write.</small>
            </span>
            <input
              checked={approvalRequired}
              disabled={!hasWrite}
              onChange={(event) => setApprovalRequired(event.target.checked)}
              type="checkbox"
            />
          </label>
          <div className={cx('dev-policy-result', hasWrite ? 'is-review' : 'is-readonly')}>
            <Icon name={hasWrite ? 'shield' : 'eye'} size={17} />
            <span>
              <strong>
                {hasWrite
                  ? approvalRequired
                    ? 'Writes become proposals'
                    : 'Direct writes allowed'
                  : 'Read-only connection'}
              </strong>
              <small>
                {hasWrite
                  ? approvalRequired
                    ? 'You keep the final decision.'
                    : 'The client can apply permitted changes.'
                  : 'No MCP tool can change your data.'}
              </small>
            </span>
          </div>
        </aside>
      </section>
    </div>
  );
}

function LogsPanel({ onToast }: { onToast: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'success' | 'error'>('all');
  const [source, setSource] = useState<'all' | ApiRequest['source']>('all');
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('24h');
  const [selected, setSelected] = useState<ApiRequest | null>(initialRequests[0]!);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return initialRequests.filter((request) => {
      const matchesText =
        !normalized ||
        request.path.toLowerCase().includes(normalized) ||
        request.actor.toLowerCase().includes(normalized) ||
        request.id.toLowerCase().includes(normalized);
      const matchesStatus =
        status === 'all' || (status === 'success' ? request.status < 400 : request.status >= 400);
      const matchesSource = source === 'all' || request.source === source;
      return matchesText && matchesStatus && matchesSource;
    });
  }, [query, source, status]);

  const usageByPeriod: Record<typeof period, number[]> = {
    '24h': [
      28, 37, 33, 48, 42, 51, 64, 59, 71, 62, 75, 82, 68, 77, 89, 84, 73, 87, 95, 88, 76, 91, 84,
      97,
    ],
    '7d': [42, 54, 48, 66, 59, 73, 64, 78, 71, 85, 76, 93, 82, 89],
    '30d': [31, 42, 38, 49, 54, 47, 61, 58, 66, 72, 63, 79, 74, 87, 81, 93],
  };

  return (
    <div
      aria-labelledby="developer-tab-logs"
      className="dev-tab-panel"
      id="developer-panel-logs"
      role="tabpanel"
    >
      <SectionHeader
        actions={
          <DevButton icon="download" onClick={() => onToast('Request log CSV downloaded')}>
            Export CSV
          </DevButton>
        }
        description="Trace every API, OAuth, webhook, and MCP interaction back to a credential and portfolio."
        eyebrow="OBSERVABILITY"
        title="Usage & logs"
      />

      <section className="dev-log-usage">
        <header>
          <div>
            <span className="dev-kicker">REQUESTS</span>
            <strong>{period === '24h' ? '12,842' : period === '7d' ? '84,190' : '318,420'}</strong>
            <small className="positive">+12.8% from previous period</small>
          </div>
          <div className="dev-segmented" aria-label="Usage period">
            {(['24h', '7d', '30d'] as const).map((value) => (
              <button
                aria-pressed={period === value}
                className={period === value ? 'is-active' : undefined}
                key={value}
                onClick={() => setPeriod(value)}
                type="button"
              >
                {value}
              </button>
            ))}
          </div>
        </header>
        <UsageBars values={usageByPeriod[period]} />
        <footer>
          <span>0</span>
          <span>Success 99.94%</span>
          <span>Rate limited 0.03%</span>
          <span>Errors 0.03%</span>
        </footer>
      </section>

      <section className="dev-request-layout">
        <div className="dev-request-list">
          <div className="dev-log-toolbar">
            <label>
              <span className="dev-visually-hidden">Search request logs</span>
              <Icon name="search" size={15} />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search path, request ID, or actor"
                value={query}
              />
            </label>
            <label>
              <span className="dev-visually-hidden">Filter by result</span>
              <select
                onChange={(event) => setStatus(event.target.value as 'all' | 'success' | 'error')}
                value={status}
              >
                <option value="all">All results</option>
                <option value="success">Successful</option>
                <option value="error">Errors</option>
              </select>
            </label>
            <label>
              <span className="dev-visually-hidden">Filter by source</span>
              <select
                onChange={(event) => setSource(event.target.value as 'all' | ApiRequest['source'])}
                value={source}
              >
                <option value="all">All sources</option>
                <option value="API key">API keys</option>
                <option value="OAuth">OAuth</option>
                <option value="MCP">MCP</option>
                <option value="Webhook">Webhooks</option>
              </select>
            </label>
          </div>
          <div className="dev-request-table" role="table" aria-label="Request logs">
            <header role="row">
              <span role="columnheader">Request</span>
              <span role="columnheader">Actor</span>
              <span role="columnheader">Result</span>
              <span role="columnheader">Time</span>
            </header>
            {filtered.length ? (
              filtered.map((request) => (
                <button
                  aria-pressed={selected?.id === request.id}
                  className={selected?.id === request.id ? 'is-active' : undefined}
                  key={request.id}
                  onClick={() => setSelected(request)}
                  role="row"
                  type="button"
                >
                  <span role="cell">
                    <i className={`dev-method dev-method--${request.method.toLowerCase()}`}>
                      {request.method}
                    </i>
                    <code>{request.path}</code>
                    <small>{request.id}</small>
                  </span>
                  <span role="cell">
                    <strong>{request.actor}</strong>
                    <small>{request.source}</small>
                  </span>
                  <span role="cell">
                    <StatePill tone={request.status < 400 ? 'green' : 'red'}>
                      {request.status}
                    </StatePill>
                    <small>{request.duration} ms</small>
                  </span>
                  <span role="cell">{request.at}</span>
                </button>
              ))
            ) : (
              <div className="dev-log-empty">
                <Icon name="search" size={20} />
                <strong>No matching requests</strong>
                <small>Try another path, actor, or result filter.</small>
              </div>
            )}
          </div>
        </div>

        {selected ? (
          <aside className="dev-request-detail">
            <header>
              <div>
                <span className={`dev-method dev-method--${selected.method.toLowerCase()}`}>
                  {selected.method}
                </span>
                <strong>{selected.id}</strong>
              </div>
              <StatePill tone={selected.status < 400 ? 'green' : 'red'}>
                {selected.status}
              </StatePill>
            </header>
            <code className="dev-request-path">{selected.path}</code>
            <dl>
              <div>
                <dt>Actor</dt>
                <dd>{selected.actor}</dd>
              </div>
              <div>
                <dt>Authentication</dt>
                <dd>{selected.source}</dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{selected.duration} ms</dd>
              </div>
              <div>
                <dt>Portfolio scope</dt>
                <dd>Personal wealth</dd>
              </div>
              <div>
                <dt>Region</dt>
                <dd>eu-central</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>Jul 27 · {selected.at}</dd>
              </div>
            </dl>
            <span>Response preview</span>
            <pre>
              <code>
                {selected.status < 400
                  ? `{
  "object": "portfolio",
  "request_id": "${selected.id}",
  "has_more": false
}`
                  : `{
  "error": {
    "code": "${selected.status === 429 ? 'rate_limit_exceeded' : 'insufficient_scope'}",
    "request_id": "${selected.id}"
  }
}`}
              </code>
            </pre>
            <DevButton
              compact
              icon="document"
              onClick={() => void copyText(selected.id, 'Request ID', onToast)}
            >
              Copy request ID
            </DevButton>
          </aside>
        ) : null}
      </section>
    </div>
  );
}

export function DeveloperPage({ onToast, onOpenConnections }: DeveloperPageProps) {
  const [activeTab, setActiveTab] = useDeveloperState<DeveloperTab>('active-tab', 'overview');
  const activeMeta = tabs.find((tab) => tab.id === activeTab) ?? tabs[0]!;

  return (
    <div className="page developer-page">
      <header className="developer-header">
        <h1>Developer</h1>
        <div className="developer-header__actions">
          <DevButton
            icon="document"
            onClick={() => onToast('API documentation opened in the demo')}
          >
            API docs
          </DevButton>
          <DevButton icon="link" onClick={onOpenConnections}>
            Connections
          </DevButton>
        </div>
      </header>

      <nav aria-label="Developer sections" className="developer-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            aria-controls={`developer-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'is-active' : undefined}
            id={`developer-tab-${tab.id}`}
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            type="button"
          >
            <Icon name={tab.icon} size={15} />
            <strong>{tab.label}</strong>
          </button>
        ))}
      </nav>

      <div className="developer-context">
        <span>
          <Icon name={activeMeta.icon} size={14} />
          {activeMeta.label}
        </span>
        <small>{activeMeta.description}</small>
      </div>

      <div aria-labelledby="developer-tab-overview" hidden={activeTab !== 'overview'}>
        <OverviewPanel
          onNavigate={setActiveTab}
          onOpenConnections={onOpenConnections}
          onToast={onToast}
        />
      </div>
      <div aria-labelledby="developer-tab-keys" hidden={activeTab !== 'keys'}>
        <ApiKeysPanel onToast={onToast} />
      </div>
      <div aria-labelledby="developer-tab-oauth" hidden={activeTab !== 'oauth'}>
        <OAuthPanel onToast={onToast} />
      </div>
      <div aria-labelledby="developer-tab-webhooks" hidden={activeTab !== 'webhooks'}>
        <WebhooksPanel onToast={onToast} />
      </div>
      <div aria-labelledby="developer-tab-mcp" hidden={activeTab !== 'mcp'}>
        <McpPanel onToast={onToast} />
      </div>
      <div aria-labelledby="developer-tab-logs" hidden={activeTab !== 'logs'}>
        <LogsPanel onToast={onToast} />
      </div>
    </div>
  );
}
