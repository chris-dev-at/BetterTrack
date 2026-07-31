import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';

export type OriginFirstRunResult = {
  account: {
    auth: 'google' | 'email' | 'demo';
    displayName: string;
    email: string;
    role: string;
    intents: string[];
  };
  data: {
    home: 'hosted' | 'drive' | 'local';
    source: 'broker' | 'parqet' | 'bank' | 'manual' | 'skip';
    provider?: string;
    syncMode?: 'read' | 'two-way';
    importedRecords: number;
  };
  security: {
    method: 'passkey' | 'authenticator' | 'later';
  };
  region: {
    currency: string;
    locale: string;
    taxResidency: string;
  };
  portfolio: {
    id: string;
    name: string;
    type: string;
    structure: 'single' | 'hub' | 'nested';
    openingCash: number;
    openingHolding?: {
      ticker: string;
      quantity: number;
      costBasis: number;
    };
  };
  collaboration: {
    mode: 'private' | 'invite' | 'household' | 'advisor';
    inviteEmail?: string;
    inviteRole?: string;
  };
  notifications: {
    reviewCadence: 'daily' | 'weekly' | 'monthly' | 'off';
    important: boolean;
    activity: boolean;
    email: boolean;
  };
  activatedAt: string;
};

export type OriginFirstRunProps = {
  onFinish: (result: OriginFirstRunResult) => void;
  onExit?: () => void;
};

type StepId =
  | 'welcome'
  | 'identity'
  | 'intent'
  | 'data-home'
  | 'security'
  | 'regional'
  | 'portfolio'
  | 'structure'
  | 'source'
  | 'connect'
  | 'opening'
  | 'collaboration'
  | 'notifications'
  | 'review'
  | 'activate';

type WizardState = {
  step: StepId;
  auth: '' | 'google' | 'email' | 'demo';
  displayName: string;
  email: string;
  role: string;
  intents: string[];
  dataHome: '' | 'hosted' | 'drive' | 'local';
  security: '' | 'passkey' | 'authenticator' | 'later';
  currency: string;
  locale: string;
  taxResidency: string;
  portfolioType: string;
  portfolioName: string;
  structure: '' | 'single' | 'hub' | 'nested';
  dataSource: '' | 'broker' | 'parqet' | 'bank' | 'manual' | 'skip';
  provider: string;
  syncMode: 'read' | 'two-way';
  connectionProgress: number;
  connectionComplete: boolean;
  importRecords: number;
  importApproved: boolean;
  openingCash: string;
  openingTicker: string;
  openingQuantity: string;
  openingCost: string;
  collaboration: '' | 'private' | 'invite' | 'household' | 'advisor';
  inviteEmail: string;
  inviteRole: string;
  reviewCadence: 'daily' | 'weekly' | 'monthly' | 'off';
  notifyImportant: boolean;
  notifyActivity: boolean;
  notifyEmail: boolean;
  termsAccepted: boolean;
  activationProgress: number;
};

const STORAGE_KEY = 'bettertrack-origin-first-run-v1';

const defaultState: WizardState = {
  step: 'welcome',
  auth: '',
  displayName: '',
  email: '',
  role: 'Individual investor',
  intents: [],
  dataHome: '',
  security: '',
  currency: 'EUR',
  locale: 'English (Ireland)',
  taxResidency: 'Austria',
  portfolioType: 'Personal',
  portfolioName: 'My portfolio',
  structure: '',
  dataSource: '',
  provider: '',
  syncMode: 'read',
  connectionProgress: 0,
  connectionComplete: false,
  importRecords: 0,
  importApproved: false,
  openingCash: '12500',
  openingTicker: 'VWCE',
  openingQuantity: '36',
  openingCost: '105.42',
  collaboration: '',
  inviteEmail: '',
  inviteRole: 'Can edit',
  reviewCadence: 'weekly',
  notifyImportant: true,
  notifyActivity: true,
  notifyEmail: true,
  termsAccepted: false,
  activationProgress: 0,
};

const baseSteps: Array<{ id: StepId; label: string; group: string }> = [
  { id: 'welcome', label: 'Welcome', group: 'Account' },
  { id: 'identity', label: 'Your account', group: 'Account' },
  { id: 'intent', label: 'What you need', group: 'Account' },
  { id: 'data-home', label: 'Data home', group: 'Foundation' },
  { id: 'security', label: 'Security', group: 'Foundation' },
  { id: 'regional', label: 'Region & tax', group: 'Foundation' },
  { id: 'portfolio', label: 'First portfolio', group: 'Portfolio' },
  { id: 'structure', label: 'Structure', group: 'Portfolio' },
  { id: 'source', label: 'Starting data', group: 'Portfolio' },
  { id: 'connect', label: 'Connect & import', group: 'Portfolio' },
  { id: 'opening', label: 'Opening position', group: 'Portfolio' },
  { id: 'collaboration', label: 'Collaboration', group: 'Workspace' },
  { id: 'notifications', label: 'Review rhythm', group: 'Workspace' },
  { id: 'review', label: 'Review', group: 'Finish' },
  { id: 'activate', label: 'Ready', group: 'Finish' },
];

const intentOptions = [
  { value: 'Track my complete wealth', icon: 'pie' as IconName },
  { value: 'Research investments', icon: 'search' as IconName },
  { value: 'Test strategies', icon: 'workbench' as IconName },
  { value: 'Plan recurring cash flows', icon: 'repeat' as IconName },
  { value: 'Manage people or clients', icon: 'people' as IconName },
  { value: 'Build with the API', icon: 'code' as IconName },
];

const sourceMeta: Record<
  Exclude<WizardState['dataSource'], ''>,
  { title: string; copy: string; icon: IconName; records: number }
> = {
  broker: {
    title: 'Broker statement',
    copy: 'Import transactions from a supported CSV or PDF export.',
    icon: 'upload',
    records: 847,
  },
  parqet: {
    title: 'Parqet',
    copy: 'Bring portfolios across and optionally keep them synchronized.',
    icon: 'repeat',
    records: 1264,
  },
  bank: {
    title: 'Bank cash',
    copy: 'Read balances and cash movements through a consented connection.',
    icon: 'bank',
    records: 392,
  },
  manual: {
    title: 'Enter a position',
    copy: 'Start with opening cash and one investment. Add the rest later.',
    icon: 'plus',
    records: 1,
  },
  skip: {
    title: 'Start empty',
    copy: 'Explore the suite first. Your portfolio will be ready for data later.',
    icon: 'arrow-right',
    records: 0,
  },
};

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function loadState() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultState;
    return { ...defaultState, ...(JSON.parse(stored) as Partial<WizardState>) };
  } catch {
    return defaultState;
  }
}

function OButton({
  children,
  icon,
  kind = 'secondary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button className={cn('ofr-button', `ofr-button--${kind}`)} type="button" {...props}>
      {icon ? <Icon name={icon} size={17} /> : null}
      {children}
    </button>
  );
}

function SelectCard({
  active,
  icon,
  title,
  copy,
  meta,
  onClick,
  children,
}: {
  active: boolean;
  icon: IconName;
  title: string;
  copy: string;
  meta?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn('ofr-select-card', active && 'ofr-select-card--active')}
      onClick={onClick}
      type="button"
    >
      <span className="ofr-select-card__icon">
        <Icon name={icon} size={20} />
      </span>
      <span className="ofr-select-card__body">
        <span className="ofr-select-card__top">
          <strong>{title}</strong>
          {meta ? <small>{meta}</small> : null}
        </span>
        <span>{copy}</span>
        {children}
      </span>
      <span className="ofr-select-card__check">
        {active ? <Icon name="check" size={14} /> : null}
      </span>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ofr-field">
      <span className="ofr-field__label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      {children}
    </label>
  );
}

function Toggle({
  checked,
  onChange,
  title,
  copy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  copy: string;
}) {
  return (
    <button className="ofr-toggle-row" onClick={() => onChange(!checked)} type="button">
      <span>
        <strong>{title}</strong>
        <small>{copy}</small>
      </span>
      <span aria-checked={checked} className={cn('ofr-switch', checked && 'is-on')} role="switch">
        <i />
      </span>
    </button>
  );
}

function SummaryRow({
  icon,
  title,
  value,
  detail,
}: {
  icon: IconName;
  title: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="ofr-summary-row">
      <span className="ofr-summary-row__icon">
        <Icon name={icon} size={18} />
      </span>
      <span>
        <small>{title}</small>
        <strong>{value}</strong>
      </span>
      <p>{detail}</p>
    </div>
  );
}

function MiniStructure({ mode }: { mode: 'single' | 'hub' | 'nested' }) {
  if (mode === 'single') {
    return (
      <span className="ofr-structure-map">
        <i className="is-root">You</i>
        <b />
        <i>Portfolio</i>
      </span>
    );
  }
  if (mode === 'hub') {
    return (
      <span className="ofr-structure-map">
        <i className="is-root">Wealth hub</i>
        <b />
        <span>
          <i>Personal</i>
          <i>Business</i>
          <i>Cash</i>
        </span>
      </span>
    );
  }
  return (
    <span className="ofr-structure-map">
      <i className="is-root">Group</i>
      <b />
      <span>
        <i>Person A</i>
        <i>Person B</i>
        <i>Shared</i>
      </span>
    </span>
  );
}

export function OriginFirstRun({ onFinish, onExit }: OriginFirstRunProps) {
  const [state, setState] = useState<WizardState>(loadState);
  const [showResume, setShowResume] = useState(
    () => Boolean(window.localStorage.getItem(STORAGE_KEY)) && loadState().step !== 'welcome',
  );
  const [error, setError] = useState('');

  const steps = useMemo(
    () =>
      baseSteps.filter(
        (step) =>
          step.id !== 'connect' ||
          state.dataSource === 'broker' ||
          state.dataSource === 'parqet' ||
          state.dataSource === 'bank',
      ),
    [state.dataSource],
  );
  const stepIndex = Math.max(
    0,
    steps.findIndex((step) => step.id === state.step),
  );
  const current = steps[stepIndex] ?? steps[0]!;
  const percent = Math.round((stepIndex / Math.max(steps.length - 1, 1)) * 100);

  function update(patch: Partial<WizardState>) {
    setState((previous) => ({ ...previous, ...patch }));
    setError('');
  }

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (
      state.step !== 'connect' ||
      state.connectionProgress <= 0 ||
      state.connectionProgress >= 100
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setState((previous) => {
        const next = Math.min(100, previous.connectionProgress + 7);
        return {
          ...previous,
          connectionProgress: next,
          connectionComplete: next === 100,
          importRecords:
            next === 100 && previous.dataSource
              ? sourceMeta[previous.dataSource].records
              : previous.importRecords,
          importApproved: next === 100,
        };
      });
    }, 180);
    return () => window.clearInterval(timer);
  }, [state.connectionProgress, state.step]);

  useEffect(() => {
    if (
      state.step !== 'activate' ||
      state.activationProgress <= 0 ||
      state.activationProgress >= 100
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setState((previous) => ({
        ...previous,
        activationProgress: Math.min(100, previous.activationProgress + 5),
      }));
    }, 110);
    return () => window.clearInterval(timer);
  }, [state.activationProgress, state.step]);

  function validateStep() {
    switch (state.step) {
      case 'welcome':
        if (!state.auth) return 'Choose how you want to continue.';
        break;
      case 'identity':
        if (state.displayName.trim().length < 2) return 'Add the name we should use for you.';
        if (!/^\S+@\S+\.\S+$/.test(state.email)) return 'Enter a valid email address.';
        break;
      case 'intent':
        if (!state.intents.length) return 'Select at least one thing you want to do.';
        break;
      case 'data-home':
        if (!state.dataHome) return 'Choose where BetterTrack should keep your data.';
        break;
      case 'security':
        if (!state.security) return 'Choose a security setup.';
        break;
      case 'portfolio':
        if (!state.portfolioName.trim()) return 'Give your first portfolio a name.';
        break;
      case 'structure':
        if (!state.structure) return 'Choose how you want to organize your portfolios.';
        break;
      case 'source':
        if (!state.dataSource) return 'Choose how you want to start.';
        break;
      case 'connect':
        if (!state.provider) return 'Select a provider first.';
        if (!state.connectionComplete) return 'Complete the simulated connection or import.';
        if (!state.importApproved) return 'Approve the imported records to continue.';
        break;
      case 'opening':
        if (state.dataSource === 'manual' && Number(state.openingCash) < 0)
          return 'Opening cash cannot be negative.';
        break;
      case 'collaboration':
        if (!state.collaboration) return 'Choose who should have access.';
        if (
          state.collaboration !== 'private' &&
          state.inviteEmail &&
          !/^\S+@\S+\.\S+$/.test(state.inviteEmail)
        )
          return 'Enter a valid collaborator email.';
        break;
      case 'review':
        if (!state.termsAccepted) return 'Confirm the setup summary before activating.';
        break;
    }
    return '';
  }

  function next() {
    const message = validateStep();
    if (message) {
      setError(message);
      return;
    }
    const nextStep = steps[stepIndex + 1];
    if (!nextStep) return;
    update({ step: nextStep.id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function back() {
    const previous = steps[stepIndex - 1];
    if (!previous) return;
    update({ step: previous.id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    setState(defaultState);
    setShowResume(false);
    setError('');
  }

  function toggleIntent(value: string) {
    update({
      intents: state.intents.includes(value)
        ? state.intents.filter((intent) => intent !== value)
        : [...state.intents, value],
    });
  }

  function selectSource(source: WizardState['dataSource']) {
    update({
      dataSource: source,
      provider: '',
      connectionProgress: 0,
      connectionComplete: false,
      importRecords: 0,
      importApproved: false,
    });
  }

  function payload(): OriginFirstRunResult {
    const importedRecords =
      state.dataSource === 'manual'
        ? Number(state.openingQuantity) > 0
          ? 1
          : 0
        : state.importRecords;
    return {
      account: {
        auth: state.auth || 'demo',
        displayName: state.displayName,
        email: state.email,
        role: state.role,
        intents: state.intents,
      },
      data: {
        home: state.dataHome || 'hosted',
        source: state.dataSource || 'skip',
        provider: state.provider || undefined,
        syncMode:
          state.dataSource === 'parqet' || state.dataSource === 'bank' ? state.syncMode : undefined,
        importedRecords,
      },
      security: { method: state.security || 'later' },
      region: {
        currency: state.currency,
        locale: state.locale,
        taxResidency: state.taxResidency,
      },
      portfolio: {
        id: `portfolio_${Date.now().toString(36)}`,
        name: state.portfolioName,
        type: state.portfolioType,
        structure: state.structure || 'single',
        openingCash: Number(state.openingCash) || 0,
        openingHolding:
          state.dataSource === 'manual' && state.openingTicker
            ? {
                ticker: state.openingTicker.toUpperCase(),
                quantity: Number(state.openingQuantity) || 0,
                costBasis: Number(state.openingCost) || 0,
              }
            : undefined,
      },
      collaboration: {
        mode: state.collaboration || 'private',
        inviteEmail: state.inviteEmail || undefined,
        inviteRole: state.inviteEmail ? state.inviteRole : undefined,
      },
      notifications: {
        reviewCadence: state.reviewCadence,
        important: state.notifyImportant,
        activity: state.notifyActivity,
        email: state.notifyEmail,
      },
      activatedAt: new Date().toISOString(),
    };
  }

  const providerOptions =
    state.dataSource === 'broker'
      ? ['Trade Republic', 'Flatex', 'Interactive Brokers', 'George']
      : state.dataSource === 'parqet'
        ? ['Parqet workspace']
        : ['Erste / Sparkasse', 'N26', 'Revolut', 'Wise'];

  return (
    <div className="origin-first-run">
      <aside className="ofr-rail">
        <div className="ofr-brand">
          <span className="ofr-brand__mark" />
          <span>
            Better<strong>Track</strong>
          </span>
        </div>
        <div className="ofr-rail__intro">
          <span className="ofr-kicker">Your financial operating system</span>
          <h1>One connected foundation, shaped around you.</h1>
          <p>
            Set up where your data lives, how your portfolios fit together and who can work with
            you. You can change every choice later.
          </p>
        </div>
        <nav className="ofr-progress" aria-label="Setup progress">
          {steps.map((item, index) => (
            <button
              className={cn(
                'ofr-progress__item',
                index === stepIndex && 'is-current',
                index < stepIndex && 'is-complete',
              )}
              disabled={index > stepIndex}
              key={item.id}
              onClick={() => index <= stepIndex && update({ step: item.id })}
              type="button"
            >
              <span>{index < stepIndex ? <Icon name="check" size={12} /> : index + 1}</span>
              <i>
                <small>{item.group}</small>
                {item.label}
              </i>
            </button>
          ))}
        </nav>
        <div className="ofr-rail__trust">
          <Icon name="shield" size={17} />
          <span>
            <strong>You stay in control</strong>
            <small>Private by default · Export anytime</small>
          </span>
        </div>
      </aside>

      <main className="ofr-main">
        <header className="ofr-topbar">
          <div className="ofr-mobile-brand">
            <span className="ofr-brand__mark" />
            <span>
              Better<strong>Track</strong>
            </span>
          </div>
          <div className="ofr-topbar__progress">
            <span style={{ width: `${percent}%` }} />
          </div>
          <span className="ofr-topbar__count">
            {stepIndex + 1} / {steps.length}
          </span>
          <button className="ofr-text-button" onClick={reset} type="button">
            Start over
          </button>
          {onExit ? (
            <button
              aria-label="Exit setup"
              className="ofr-icon-button"
              onClick={onExit}
              type="button"
            >
              <Icon name="x" size={18} />
            </button>
          ) : null}
        </header>

        <div className="ofr-stage">
          <div className="ofr-stage__head">
            <span className="ofr-step-label">
              {current.group} · Step {stepIndex + 1}
            </span>
            <StepHeading step={state.step} name={state.displayName} />
          </div>

          {showResume ? (
            <div className="ofr-resume">
              <Icon name="clock" size={17} />
              <span>
                <strong>Your setup was restored</strong>
                Everything on this device has been saved automatically.
              </span>
              <button onClick={() => setShowResume(false)} type="button">
                Got it
              </button>
            </div>
          ) : null}

          <div className="ofr-content">
            {state.step === 'welcome' ? (
              <WelcomeStep
                auth={state.auth}
                onSelect={(auth) =>
                  update({
                    auth,
                    displayName: auth === 'demo' ? 'Alex Morgan' : state.displayName,
                    email: auth === 'demo' ? 'alex@bettertrack.demo' : state.email,
                  })
                }
              />
            ) : null}

            {state.step === 'identity' ? (
              <div className="ofr-form-grid">
                <div className="ofr-profile-preview">
                  <span>
                    {(state.displayName || 'You')
                      .split(' ')
                      .map((part) => part[0])
                      .join('')
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                  <strong>{state.displayName || 'Your name'}</strong>
                  <small>{state.email || 'your@email.com'}</small>
                  <i>
                    {state.auth === 'google'
                      ? 'Google account'
                      : state.auth === 'demo'
                        ? 'Demo profile'
                        : 'Email account'}
                  </i>
                </div>
                <div className="ofr-fields">
                  <Field label="Name">
                    <input
                      autoFocus
                      onChange={(event) => update({ displayName: event.target.value })}
                      placeholder="Alex Morgan"
                      value={state.displayName}
                    />
                  </Field>
                  <Field label="Email" hint="Used for security and important account notices">
                    <input
                      onChange={(event) => update({ email: event.target.value })}
                      placeholder="alex@example.com"
                      type="email"
                      value={state.email}
                    />
                  </Field>
                  <Field label="I am primarily a…">
                    <select
                      onChange={(event) => update({ role: event.target.value })}
                      value={state.role}
                    >
                      <option>Individual investor</option>
                      <option>Household organizer</option>
                      <option>Founder or business owner</option>
                      <option>Financial advisor</option>
                      <option>Developer or integrator</option>
                    </select>
                  </Field>
                </div>
              </div>
            ) : null}

            {state.step === 'intent' ? (
              <>
                <div className="ofr-choice-grid ofr-choice-grid--three">
                  {intentOptions.map((intent) => (
                    <SelectCard
                      active={state.intents.includes(intent.value)}
                      copy={
                        intent.value === 'Track my complete wealth'
                          ? 'Portfolios, cash and assets in one view.'
                          : getIntentCopy(intent.value)
                      }
                      icon={intent.icon}
                      key={intent.value}
                      onClick={() => toggleIntent(intent.value)}
                      title={intent.value}
                    />
                  ))}
                </div>
                <p className="ofr-inline-note">
                  <Icon name="sparkles" size={15} />
                  We use this to arrange your workspace—not to limit what you can do.
                </p>
              </>
            ) : null}

            {state.step === 'data-home' ? (
              <>
                <div className="ofr-choice-grid">
                  <SelectCard
                    active={state.dataHome === 'hosted'}
                    copy="The simplest setup. Encrypted storage, automatic sync and access from every device."
                    icon="globe"
                    meta="Recommended"
                    onClick={() => update({ dataHome: 'hosted' })}
                    title="BetterTrack Cloud"
                  >
                    <ul>
                      <li>Automatic backups and version history</li>
                      <li>Collaboration and API access included</li>
                      <li>Nothing to maintain</li>
                    </ul>
                  </SelectCard>
                  <SelectCard
                    active={state.dataHome === 'drive'}
                    copy="Your connected Google Drive becomes the external home for exports and portable snapshots."
                    icon="folder"
                    meta="Portable"
                    onClick={() => update({ dataHome: 'drive' })}
                    title="Google Drive data home"
                  >
                    <ul>
                      <li>You control the Drive folder</li>
                      <li>Private app data stays encrypted</li>
                      <li>Some live collaboration needs the web app</li>
                    </ul>
                  </SelectCard>
                  <SelectCard
                    active={state.dataHome === 'local'}
                    copy="Keep manual files on this device and explicitly choose when to import or export."
                    icon="monitor"
                    meta="Advanced"
                    onClick={() => update({ dataHome: 'local' })}
                    title="Local-first & manual"
                  >
                    <ul>
                      <li>Maximum custody and explicit control</li>
                      <li>No automatic cross-device sync</li>
                      <li>You are responsible for backups</li>
                    </ul>
                  </SelectCard>
                </div>
                <div className="ofr-data-diagram">
                  <span>
                    <Icon name="user-plus" size={18} /> You
                  </span>
                  <i />
                  <span className="is-accent">
                    <span className="ofr-mini-logo" /> BetterTrack
                  </span>
                  <i />
                  <span>
                    <Icon
                      name={
                        state.dataHome === 'drive'
                          ? 'folder'
                          : state.dataHome === 'local'
                            ? 'monitor'
                            : 'database'
                      }
                      size={18}
                    />
                    {state.dataHome === 'drive'
                      ? 'Your Drive'
                      : state.dataHome === 'local'
                        ? 'This device'
                        : 'Encrypted cloud'}
                  </span>
                </div>
              </>
            ) : null}

            {state.step === 'security' ? (
              <div className="ofr-security-layout">
                <div className="ofr-choice-stack">
                  <SelectCard
                    active={state.security === 'passkey'}
                    copy="Sign in with Face ID, Touch ID, Windows Hello or your device PIN. Resistant to phishing."
                    icon="key"
                    meta="Recommended"
                    onClick={() => update({ security: 'passkey' })}
                    title="Create a passkey"
                  />
                  <SelectCard
                    active={state.security === 'authenticator'}
                    copy="Use a password plus a rotating code from your authenticator app."
                    icon="shield"
                    onClick={() => update({ security: 'authenticator' })}
                    title="Authenticator app"
                  />
                  <SelectCard
                    active={state.security === 'later'}
                    copy="Continue with your account provider. We will remind you after setup."
                    icon="clock"
                    onClick={() => update({ security: 'later' })}
                    title="Set this up later"
                  />
                </div>
                <div className="ofr-security-card">
                  <span className="ofr-security-card__shield">
                    <Icon name="shield" size={29} />
                    <i />
                  </span>
                  <h3>Protection that follows the data</h3>
                  <p>
                    Security applies across portfolios, exports, integrations and collaborator
                    access—not only at sign-in.
                  </p>
                  <div>
                    <span>
                      <Icon name="check" size={14} /> Encryption in transit and at rest
                    </span>
                    <span>
                      <Icon name="check" size={14} /> Granular sessions and access logs
                    </span>
                    <span>
                      <Icon name="check" size={14} /> No brokerage trading credentials stored
                    </span>
                  </div>
                </div>
              </div>
            ) : null}

            {state.step === 'regional' ? (
              <div className="ofr-regional-layout">
                <div className="ofr-fields">
                  <Field
                    label="Base currency"
                    hint="Portfolio values can still be viewed in other currencies"
                  >
                    <select
                      onChange={(event) => update({ currency: event.target.value })}
                      value={state.currency}
                    >
                      <option value="EUR">EUR — Euro</option>
                      <option value="USD">USD — US Dollar</option>
                      <option value="GBP">GBP — British Pound</option>
                      <option value="CHF">CHF — Swiss Franc</option>
                    </select>
                  </Field>
                  <Field label="Language & number format">
                    <select
                      onChange={(event) => update({ locale: event.target.value })}
                      value={state.locale}
                    >
                      <option>English (Ireland)</option>
                      <option>English (United States)</option>
                      <option>English (United Kingdom)</option>
                      <option>Deutsch (Österreich)</option>
                      <option>Deutsch (Deutschland)</option>
                    </select>
                  </Field>
                  <Field label="Tax residency" hint="Used for tax views, never as tax advice">
                    <select
                      onChange={(event) => update({ taxResidency: event.target.value })}
                      value={state.taxResidency}
                    >
                      <option>Austria</option>
                      <option>Germany</option>
                      <option>Switzerland</option>
                      <option>Ireland</option>
                      <option>United Kingdom</option>
                      <option>United States</option>
                      <option>Other / not configured</option>
                    </select>
                  </Field>
                </div>
                <div className="ofr-preview-document">
                  <span>Portfolio statement</span>
                  <small>Example preview</small>
                  <strong>{state.currency} 128,430.20</strong>
                  <div>
                    <i style={{ width: '78%' }} />
                    <i style={{ width: '56%' }} />
                    <i style={{ width: '68%' }} />
                  </div>
                  <p>
                    Gains shown with{' '}
                    {state.locale.includes('United States') ? '1,234.56' : '1.234,56'} formatting
                  </p>
                  <em>
                    <Icon name="document" size={15} />
                    {state.taxResidency} tax model
                  </em>
                </div>
              </div>
            ) : null}

            {state.step === 'portfolio' ? (
              <>
                <div className="ofr-portfolio-name">
                  <Field label="Portfolio name">
                    <input
                      autoFocus
                      onChange={(event) => update({ portfolioName: event.target.value })}
                      value={state.portfolioName}
                    />
                  </Field>
                  <span className="ofr-portfolio-avatar">
                    {(state.portfolioName || 'P').slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="ofr-segmented-cards">
                  {[
                    ['Personal', 'wallet', 'Your investments, cash flows and financial plans.'],
                    ['Household', 'house', 'Joint and individual wealth with shared oversight.'],
                    ['Business', 'briefcase', 'Company holdings, reserves and recurring expenses.'],
                    ['Client', 'people', 'A permission-aware portfolio managed for someone else.'],
                    ['Sandbox', 'workbench', 'A clean space for hypothetical strategies.'],
                  ].map(([type, icon, copy]) => (
                    <button
                      className={cn('ofr-type-card', state.portfolioType === type && 'is-active')}
                      key={type}
                      onClick={() => update({ portfolioType: type! })}
                      type="button"
                    >
                      <Icon name={icon as IconName} size={19} />
                      <strong>{type}</strong>
                      <span>{copy}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {state.step === 'structure' ? (
              <div className="ofr-structure-options">
                <button
                  className={cn(
                    'ofr-structure-option',
                    state.structure === 'single' && 'is-active',
                  )}
                  onClick={() => update({ structure: 'single' })}
                  type="button"
                >
                  <MiniStructure mode="single" />
                  <span>
                    <strong>Start simple</strong>
                    <small>One independent portfolio. You can split or nest it later.</small>
                  </span>
                  <em>Best for a focused start</em>
                </button>
                <button
                  className={cn('ofr-structure-option', state.structure === 'hub' && 'is-active')}
                  onClick={() => update({ structure: 'hub' })}
                  type="button"
                >
                  <MiniStructure mode="hub" />
                  <span>
                    <strong>Build a wealth hub</strong>
                    <small>
                      Create a parent view that rolls up personal, business and cash portfolios.
                    </small>
                  </span>
                  <em>Best for complete wealth</em>
                </button>
                <button
                  className={cn(
                    'ofr-structure-option',
                    state.structure === 'nested' && 'is-active',
                  )}
                  onClick={() => update({ structure: 'nested' })}
                  type="button"
                >
                  <MiniStructure mode="nested" />
                  <span>
                    <strong>People & client structure</strong>
                    <small>
                      Keep ownership distinct while seeing the total wealth you oversee.
                    </small>
                  </span>
                  <em>Best for teams and advisors</em>
                </button>
                <p className="ofr-structure-note">
                  <Icon name="layers" size={17} />A parent portfolio reads from its children.
                  Transactions remain in their source portfolio, so nothing gets duplicated.
                </p>
              </div>
            ) : null}

            {state.step === 'source' ? (
              <div className="ofr-source-list">
                {(Object.keys(sourceMeta) as Array<Exclude<WizardState['dataSource'], ''>>).map(
                  (source) => {
                    const item = sourceMeta[source];
                    return (
                      <SelectCard
                        active={state.dataSource === source}
                        copy={item.copy}
                        icon={item.icon}
                        key={source}
                        meta={
                          source === 'broker'
                            ? 'Most complete'
                            : source === 'bank'
                              ? 'Read-only'
                              : undefined
                        }
                        onClick={() => selectSource(source)}
                        title={item.title}
                      />
                    );
                  },
                )}
              </div>
            ) : null}

            {state.step === 'connect' ? (
              <ConnectionStep
                approved={state.importApproved}
                complete={state.connectionComplete}
                dataSource={state.dataSource}
                onApprove={(approved) => update({ importApproved: approved })}
                onConnect={() => update({ connectionProgress: 1, connectionComplete: false })}
                onProvider={(provider) =>
                  update({
                    provider,
                    connectionProgress: 0,
                    connectionComplete: false,
                    importApproved: false,
                  })
                }
                onSyncMode={(syncMode) => update({ syncMode })}
                progress={state.connectionProgress}
                provider={state.provider}
                providerOptions={providerOptions}
                records={state.importRecords}
                syncMode={state.syncMode}
              />
            ) : null}

            {state.step === 'opening' ? <OpeningStep state={state} update={update} /> : null}

            {state.step === 'collaboration' ? (
              <>
                <div className="ofr-choice-grid">
                  {[
                    ['private', 'lock', 'Only me', 'Keep this portfolio private for now.'],
                    [
                      'invite',
                      'user-plus',
                      'Invite someone',
                      'Add a partner, accountant or trusted person.',
                    ],
                    [
                      'household',
                      'house',
                      'Household workspace',
                      'Shared oversight with individual ownership.',
                    ],
                    [
                      'advisor',
                      'briefcase',
                      'Advisor relationship',
                      'Give a professional proposal or management access.',
                    ],
                  ].map(([mode, icon, title, copy]) => (
                    <SelectCard
                      active={state.collaboration === mode}
                      copy={copy!}
                      icon={icon as IconName}
                      key={mode}
                      onClick={() =>
                        update({
                          collaboration: mode as WizardState['collaboration'],
                          inviteEmail: mode === 'private' ? '' : state.inviteEmail,
                        })
                      }
                      title={title!}
                    />
                  ))}
                </div>
                {state.collaboration && state.collaboration !== 'private' ? (
                  <div className="ofr-invite-box">
                    <span className="ofr-invite-avatar">
                      <Icon name="user-plus" size={19} />
                    </span>
                    <Field label="Invite now" hint="Optional — you can also do this later">
                      <input
                        onChange={(event) => update({ inviteEmail: event.target.value })}
                        placeholder="person@example.com"
                        type="email"
                        value={state.inviteEmail}
                      />
                    </Field>
                    <Field label="Permission">
                      <select
                        onChange={(event) => update({ inviteRole: event.target.value })}
                        value={state.inviteRole}
                      >
                        <option>Can view</option>
                        <option>Can comment</option>
                        <option>Can propose</option>
                        <option>Can edit</option>
                      </select>
                    </Field>
                  </div>
                ) : null}
              </>
            ) : null}

            {state.step === 'notifications' ? (
              <div className="ofr-notification-layout">
                <div>
                  <span className="ofr-subheading">Your review rhythm</span>
                  <div className="ofr-cadence">
                    {(['daily', 'weekly', 'monthly', 'off'] as const).map((cadence) => (
                      <button
                        className={cn(state.reviewCadence === cadence && 'is-active')}
                        key={cadence}
                        onClick={() => update({ reviewCadence: cadence })}
                        type="button"
                      >
                        <strong>{cadence === 'off' ? 'No digest' : cadence}</strong>
                        <small>
                          {cadence === 'daily'
                            ? 'Every morning'
                            : cadence === 'weekly'
                              ? 'Monday morning'
                              : cadence === 'monthly'
                                ? 'First of month'
                                : 'Open BetterTrack when you choose'}
                        </small>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ofr-toggle-list">
                  <Toggle
                    checked={state.notifyImportant}
                    copy="Security, failed imports and portfolio rules that require attention."
                    onChange={(notifyImportant) => update({ notifyImportant })}
                    title="Important alerts"
                  />
                  <Toggle
                    checked={state.notifyActivity}
                    copy="Comments, proposals and changes from people you work with."
                    onChange={(notifyActivity) => update({ notifyActivity })}
                    title="Collaboration activity"
                  />
                  <Toggle
                    checked={state.notifyEmail}
                    copy="Send your chosen digest and important alerts to your account email."
                    onChange={(notifyEmail) => update({ notifyEmail })}
                    title="Email delivery"
                  />
                </div>
                <p className="ofr-inline-note">
                  <Icon name="bell" size={15} />
                  Price alerts and automation rules are configured separately. We never enable noisy
                  market notifications by default.
                </p>
              </div>
            ) : null}

            {state.step === 'review' ? (
              <div className="ofr-review">
                <div className="ofr-review__summary">
                  <SummaryRow
                    detail={`${state.role} · ${state.intents.length} workspace priorities`}
                    icon="user-plus"
                    title="Account"
                    value={`${state.displayName} · ${state.email}`}
                  />
                  <SummaryRow
                    detail={`${state.security === 'later' ? 'Provider sign-in for now' : state.security} · ${state.taxResidency} tax model`}
                    icon="shield"
                    title="Data & security"
                    value={
                      state.dataHome === 'hosted'
                        ? 'BetterTrack Cloud'
                        : state.dataHome === 'drive'
                          ? 'Google Drive data home'
                          : 'Local-first & manual'
                    }
                  />
                  <SummaryRow
                    detail={`${state.portfolioType} · ${state.structure} structure · ${state.currency}`}
                    icon="portfolio"
                    title="Portfolio"
                    value={state.portfolioName}
                  />
                  <SummaryRow
                    detail={
                      state.provider
                        ? `${state.provider} · ${state.importRecords.toLocaleString()} records ready`
                        : state.dataSource === 'manual'
                          ? `${state.openingTicker || 'Cash only'} · manual opening position`
                          : 'No starting records'
                    }
                    icon={state.dataSource ? sourceMeta[state.dataSource].icon : 'database'}
                    title="Starting data"
                    value={state.dataSource ? sourceMeta[state.dataSource].title : 'None'}
                  />
                  <SummaryRow
                    detail={`${state.reviewCadence} review · ${state.notifyImportant ? 'important alerts on' : 'important alerts off'}`}
                    icon="people"
                    title="Access & rhythm"
                    value={
                      state.collaboration === 'private'
                        ? 'Private workspace'
                        : state.inviteEmail || `${state.collaboration} workspace`
                    }
                  />
                </div>
                <button
                  className={cn('ofr-confirm', state.termsAccepted && 'is-active')}
                  onClick={() => update({ termsAccepted: !state.termsAccepted })}
                  type="button"
                >
                  <span>{state.termsAccepted ? <Icon name="check" size={14} /> : null}</span>
                  <p>
                    <strong>This setup looks right</strong>I understand that portfolio calculations
                    are informational and not financial or tax advice. Connections in this demo are
                    simulated.
                  </p>
                </button>
              </div>
            ) : null}

            {state.step === 'activate' ? (
              <ActivationStep
                onFinish={() => {
                  window.localStorage.removeItem(STORAGE_KEY);
                  onFinish(payload());
                }}
                onStart={() => update({ activationProgress: 1 })}
                progress={state.activationProgress}
                state={state}
              />
            ) : null}
          </div>

          {state.step !== 'activate' ? (
            <footer className="ofr-actions">
              <div>
                {stepIndex > 0 ? (
                  <OButton icon="arrow-right" kind="ghost" onClick={back}>
                    Back
                  </OButton>
                ) : onExit ? (
                  <OButton kind="ghost" onClick={onExit}>
                    Do this later
                  </OButton>
                ) : null}
              </div>
              <div className="ofr-actions__next">
                {error ? (
                  <span className="ofr-error" role="alert">
                    <Icon name="activity" size={15} />
                    {error}
                  </span>
                ) : (
                  <small>Saved on this device</small>
                )}
                <OButton icon="arrow-right" kind="primary" onClick={next}>
                  {state.step === 'review' ? 'Build my workspace' : 'Continue'}
                </OButton>
              </div>
            </footer>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function StepHeading({ step, name }: { step: StepId; name: string }) {
  const copy: Record<StepId, [string, string]> = {
    welcome: [
      'Welcome to BetterTrack',
      'Begin with an account—or step into a fully prepared demo.',
    ],
    identity: [
      'Make this workspace yours',
      'A little context helps us make the suite feel familiar from the first screen.',
    ],
    intent: [
      'What should BetterTrack help with?',
      'Pick as many as you like. The suite stays fully available.',
    ],
    'data-home': [
      'Choose where your data lives',
      'This is the foundation of your workspace, portability and collaboration.',
    ],
    security: ['Protect the whole workspace', 'Choose the sign-in protection that fits you.'],
    regional: [
      'Set your financial context',
      'Currency, formatting and tax views should make sense from day one.',
    ],
    portfolio: [
      'Create your first portfolio',
      'A portfolio is the connected home for holdings, cash flows, plans and people.',
    ],
    structure: [
      'How should everything fit together?',
      'Start simple or create a roll-up that reflects your real financial world.',
    ],
    source: [
      'Bring in your starting point',
      'Choose one source now. More brokers, banks and portfolios can be added later.',
    ],
    connect: [
      'Connect, inspect, then approve',
      'Nothing enters your portfolio until the mapping looks right to you.',
    ],
    opening: [
      'Confirm the opening position',
      'Review what the portfolio will contain when you arrive.',
    ],
    collaboration: [
      'Who belongs in this portfolio?',
      'Keep it private or define collaboration from the start.',
    ],
    notifications: [
      'Stay informed without the noise',
      'Choose a deliberate review rhythm and only the alerts that matter.',
    ],
    review: [
      `Ready when you are${name ? `, ${name.split(' ')[0]}` : ''}`,
      'One final look before BetterTrack assembles your workspace.',
    ],
    activate: [
      'Your workspace is ready',
      'BetterTrack has connected the pieces without locking you into them.',
    ],
  };
  return (
    <>
      <h2>{copy[step][0]}</h2>
      <p>{copy[step][1]}</p>
    </>
  );
}

function WelcomeStep({
  auth,
  onSelect,
}: {
  auth: WizardState['auth'];
  onSelect: (auth: Exclude<WizardState['auth'], ''>) => void;
}) {
  return (
    <div className="ofr-welcome">
      <div className="ofr-auth-options">
        <button
          className={cn('ofr-auth-button', auth === 'google' && 'is-active')}
          onClick={() => onSelect('google')}
          type="button"
        >
          <span className="ofr-google-mark">G</span>
          <span>
            <strong>Continue with Google</strong>
            <small>Fast sign-in · Drive can be connected separately</small>
          </span>
          {auth === 'google' ? (
            <Icon name="check" size={16} />
          ) : (
            <Icon name="arrow-right" size={16} />
          )}
        </button>
        <button
          className={cn('ofr-auth-button', auth === 'email' && 'is-active')}
          onClick={() => onSelect('email')}
          type="button"
        >
          <span>
            <Icon name="message" size={18} />
          </span>
          <span>
            <strong>Continue with email</strong>
            <small>Passwordless code or a passkey</small>
          </span>
          {auth === 'email' ? (
            <Icon name="check" size={16} />
          ) : (
            <Icon name="arrow-right" size={16} />
          )}
        </button>
        <div className="ofr-divider">
          <span>or explore first</span>
        </div>
        <button
          className={cn('ofr-demo-button', auth === 'demo' && 'is-active')}
          onClick={() => onSelect('demo')}
          type="button"
        >
          <span className="ofr-demo-button__visual">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>Use the interactive demo workspace</strong>
            <small>Pre-filled fictional data · No account needed · Every feature unlocked</small>
          </span>
          <em>Demo</em>
        </button>
      </div>
      <aside className="ofr-welcome__aside">
        <span className="ofr-kicker">A suite, not a pile of tools</span>
        <div>
          <i>
            <Icon name="portfolio" size={18} />
          </i>
          <span>
            <strong>Portfolio is the source of truth</strong>
            <small>Holdings, cash, expenses, documents and collaborators stay connected.</small>
          </span>
        </div>
        <div>
          <i>
            <Icon name="workbench" size={18} />
          </i>
          <span>
            <strong>Workbench explores what could change</strong>
            <small>Forecast, compare and test without corrupting your real data.</small>
          </span>
        </div>
        <div>
          <i>
            <Icon name="people" size={18} />
          </i>
          <span>
            <strong>Access follows the portfolio</strong>
            <small>Work together with clear roles, proposals and a complete history.</small>
          </span>
        </div>
      </aside>
    </div>
  );
}

function getIntentCopy(value: string) {
  const copies: Record<string, string> = {
    'Research investments': 'Detailed assets, watchlists, news and screeners.',
    'Test strategies': 'Forecasts, backtests, comparisons and custom scenarios.',
    'Plan recurring cash flows': 'Income, expenses, transfers and contribution plans.',
    'Manage people or clients': 'Nested portfolios, roles, proposals and reviews.',
    'Build with the API': 'API keys, OAuth apps, webhooks and MCP access.',
  };
  return copies[value] ?? '';
}

function ConnectionStep({
  dataSource,
  provider,
  providerOptions,
  progress,
  complete,
  records,
  approved,
  syncMode,
  onProvider,
  onConnect,
  onApprove,
  onSyncMode,
}: {
  dataSource: WizardState['dataSource'];
  provider: string;
  providerOptions: string[];
  progress: number;
  complete: boolean;
  records: number;
  approved: boolean;
  syncMode: WizardState['syncMode'];
  onProvider: (provider: string) => void;
  onConnect: () => void;
  onApprove: (approved: boolean) => void;
  onSyncMode: (mode: WizardState['syncMode']) => void;
}) {
  const title =
    dataSource === 'broker'
      ? 'Choose the statement format'
      : dataSource === 'parqet'
        ? 'Authorize your Parqet workspace'
        : 'Choose a bank';
  return (
    <div className="ofr-connect-layout">
      <div className="ofr-connection-panel">
        <span className="ofr-subheading">{title}</span>
        <div className="ofr-provider-grid">
          {providerOptions.map((item) => (
            <button
              className={cn(provider === item && 'is-active')}
              key={item}
              onClick={() => onProvider(item)}
              type="button"
            >
              <span>{item.slice(0, 2).toUpperCase()}</span>
              <strong>{item}</strong>
              {provider === item ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
        {dataSource === 'broker' ? (
          <button
            className={cn('ofr-dropzone', provider && 'is-ready')}
            disabled={!provider || (progress > 0 && progress < 100)}
            onClick={onConnect}
            type="button"
          >
            <span>
              <Icon name={complete ? 'check' : 'upload'} size={23} />
            </span>
            <strong>{complete ? 'transactions-2021-2026.csv' : 'Drop your export here'}</strong>
            <small>
              {complete
                ? '4.8 MB · scanned locally'
                : `or choose a ${provider || 'broker'} CSV file`}
            </small>
          </button>
        ) : (
          <div className="ofr-connect-consent">
            <span>
              <Icon name="lock" size={18} />
            </span>
            <div>
              <strong>{provider || 'Select a provider'} will ask you to approve</strong>
              <small>
                Read portfolio names, holdings, transactions and balances. BetterTrack cannot place
                trades or move money.
              </small>
            </div>
            <OButton
              disabled={!provider || (progress > 0 && progress < 100)}
              kind="primary"
              onClick={onConnect}
            >
              {complete ? 'Reconnect' : 'Authorize'}
            </OButton>
          </div>
        )}
        {dataSource === 'parqet' ? (
          <div className="ofr-sync-choice">
            <span>
              <strong>Ongoing sync</strong>
              <small>Control which system can update the other.</small>
            </span>
            <div>
              <button
                className={cn(syncMode === 'read' && 'is-active')}
                onClick={() => onSyncMode('read')}
                type="button"
              >
                Import only
              </button>
              <button
                className={cn(syncMode === 'two-way' && 'is-active')}
                onClick={() => onSyncMode('two-way')}
                type="button"
              >
                Two-way
              </button>
            </div>
          </div>
        ) : null}
        {progress > 0 ? (
          <div className="ofr-import-progress">
            <span>
              <strong>
                {complete
                  ? 'Analysis complete'
                  : progress < 35
                    ? 'Reading records'
                    : progress < 72
                      ? 'Matching assets'
                      : 'Checking duplicates'}
              </strong>
              <em>{progress}%</em>
            </span>
            <i>
              <b style={{ width: `${progress}%` }} />
            </i>
            <small>
              {complete
                ? `${records.toLocaleString()} records are ready for review`
                : 'This simulation keeps moving if you leave and come back.'}
            </small>
          </div>
        ) : null}
      </div>

      <div className="ofr-mapping-panel">
        <div className="ofr-mapping-panel__head">
          <span>
            <small>Import preview</small>
            <strong>
              {complete ? `${records.toLocaleString()} records found` : 'Waiting for data'}
            </strong>
          </span>
          {complete ? <em>98.7% matched</em> : null}
        </div>
        {complete ? (
          <>
            <div className="ofr-import-metrics">
              <span>
                <small>Transactions</small>
                <strong>{Math.round(records * 0.71)}</strong>
              </span>
              <span>
                <small>Cash movements</small>
                <strong>{Math.round(records * 0.19)}</strong>
              </span>
              <span>
                <small>Income</small>
                <strong>{Math.round(records * 0.1)}</strong>
              </span>
            </div>
            <div className="ofr-mapping-table">
              <span>
                <small>Source field</small>
                <small>BetterTrack field</small>
                <small>Sample</small>
              </span>
              <span>
                <b>ISIN</b>
                <b>Asset identifier</b>
                <em>IE00BK5BQT80</em>
              </span>
              <span>
                <b>Executed at</b>
                <b>Transaction date</b>
                <em>2025-11-08</em>
              </span>
              <span>
                <b>Value + fee</b>
                <b>Total cost</b>
                <em>€1,242.90</em>
              </span>
            </div>
            <div className="ofr-import-warning">
              <Icon name="activity" size={16} />
              <span>
                <strong>11 records need a fallback</strong>
                Fractional savings-plan fills will be grouped by execution day. You can inspect
                every change after import.
              </span>
              <button type="button">Inspect</button>
            </div>
            <button
              className={cn('ofr-approve-import', approved && 'is-approved')}
              onClick={() => onApprove(!approved)}
              type="button"
            >
              <span>{approved ? <Icon name="check" size={14} /> : null}</span>
              <strong>{approved ? 'Import approved' : 'Approve this mapping'}</strong>
              <small>No records are written before approval.</small>
            </button>
          </>
        ) : (
          <div className="ofr-empty-preview">
            <Icon name="database" size={28} />
            <strong>Your data stays staged</strong>
            <p>Choose a provider, connect it and inspect the exact mapping here.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function OpeningStep({
  state,
  update,
}: {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
}) {
  if (state.dataSource === 'manual') {
    return (
      <div className="ofr-opening-layout">
        <div className="ofr-fields">
          <Field label="Opening cash" hint={`In ${state.currency}`}>
            <div className="ofr-money-input">
              <span>{state.currency}</span>
              <input
                min="0"
                onChange={(event) => update({ openingCash: event.target.value })}
                type="number"
                value={state.openingCash}
              />
            </div>
          </Field>
          <div className="ofr-field-row">
            <Field label="First asset">
              <input
                onChange={(event) => update({ openingTicker: event.target.value })}
                placeholder="VWCE"
                value={state.openingTicker}
              />
            </Field>
            <Field label="Quantity">
              <input
                min="0"
                onChange={(event) => update({ openingQuantity: event.target.value })}
                type="number"
                value={state.openingQuantity}
              />
            </Field>
            <Field label="Average cost">
              <input
                min="0"
                onChange={(event) => update({ openingCost: event.target.value })}
                type="number"
                value={state.openingCost}
              />
            </Field>
          </div>
          <p className="ofr-inline-note">
            <Icon name="document" size={15} />
            Add transaction history later to unlock complete performance and tax calculations.
          </p>
        </div>
        <OpeningPreview state={state} />
      </div>
    );
  }
  if (state.dataSource === 'skip') {
    return (
      <div className="ofr-empty-opening">
        <span>
          <Icon name="portfolio" size={30} />
        </span>
        <h3>{state.portfolioName} will start clean</h3>
        <p>
          We will add a guided checklist inside the portfolio: connect a source, add cash, record a
          trade or explore with fictional preview data.
        </p>
        <div>
          <span>
            <Icon name="upload" size={17} /> Import data
          </span>
          <span>
            <Icon name="cash" size={17} /> Add cash
          </span>
          <span>
            <Icon name="assets" size={17} /> Add an investment
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="ofr-import-review">
      <div className="ofr-import-review__hero">
        <span>
          <Icon name="check" size={22} />
        </span>
        <div>
          <small>Opening snapshot · 26 July 2026</small>
          <h3>€128,430.20</h3>
          <p>
            {state.importRecords.toLocaleString()} records from {state.provider} reconcile to this
            value.
          </p>
        </div>
        <em>Balanced</em>
      </div>
      <div className="ofr-import-review__grid">
        <span>
          <small>Invested</small>
          <strong>€113,820.44</strong>
          <i style={{ width: '88%' }} />
        </span>
        <span>
          <small>Cash</small>
          <strong>€14,609.76</strong>
          <i style={{ width: '24%' }} />
        </span>
        <span>
          <small>Cost basis</small>
          <strong>€96,242.18</strong>
          <i style={{ width: '72%' }} />
        </span>
        <span>
          <small>Unrealized gain</small>
          <strong className="positive">+€17,578.26</strong>
          <i className="is-positive" style={{ width: '43%' }} />
        </span>
      </div>
      <div className="ofr-review-table">
        <span className="ofr-review-table__head">
          <small>Holding</small>
          <small>Units</small>
          <small>Value</small>
          <small>Weight</small>
          <small>Match</small>
        </span>
        {[
          ['Vanguard FTSE All-World', '312.48', '€38,820', '30.2%', 'Exact'],
          ['Apple Inc.', '84.00', '€17,420', '13.6%', 'Exact'],
          ['iShares Core MSCI World', '126.34', '€14,260', '11.1%', 'Exact'],
          ['Bitcoin', '0.214', '€11,680', '9.1%', 'Exact'],
          ['12 more holdings', '—', '€31,640', '24.6%', 'Reviewed'],
        ].map((row) => (
          <span key={row[0]}>
            {row.map((cell, index) =>
              index === 4 ? <em key={cell}>{cell}</em> : <b key={cell}>{cell}</b>,
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function OpeningPreview({ state }: { state: WizardState }) {
  const cash = Number(state.openingCash) || 0;
  const holding = (Number(state.openingQuantity) || 0) * (Number(state.openingCost) || 0);
  const total = cash + holding;
  return (
    <div className="ofr-opening-preview">
      <small>Opening portfolio</small>
      <h3>
        {state.currency} {total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </h3>
      <div
        className="ofr-donut"
        style={{ '--cash-share': `${total ? (cash / total) * 100 : 100}%` } as React.CSSProperties}
      >
        <span />
      </div>
      <p>
        <span>
          <i className="is-invested" /> {state.openingTicker || 'Invested'}
          <strong>{total ? Math.round((holding / total) * 100) : 0}%</strong>
        </span>
        <span>
          <i className="is-cash" /> Cash
          <strong>{total ? Math.round((cash / total) * 100) : 100}%</strong>
        </span>
      </p>
    </div>
  );
}

function ActivationStep({
  progress,
  onStart,
  onFinish,
  state,
}: {
  progress: number;
  onStart: () => void;
  onFinish: () => void;
  state: WizardState;
}) {
  const done = progress >= 100;
  return (
    <div className={cn('ofr-activation', done && 'is-done')}>
      <div className="ofr-activation__visual">
        <span className="ofr-activation__logo" />
        <i style={{ '--progress': `${progress * 3.6}deg` } as React.CSSProperties} />
        {done ? <Icon name="check" size={24} /> : null}
      </div>
      <div className="ofr-activation__copy">
        <span className="ofr-kicker">{done ? 'Setup complete' : 'One connected workspace'}</span>
        <h3>
          {done ? `Welcome to ${state.portfolioName}` : 'Assemble your BetterTrack workspace'}
        </h3>
        <p>
          {done
            ? 'Your portfolio, workbench, assets and collaboration layer are ready. The first review is waiting inside.'
            : 'We will create the portfolio structure, stage your starting data and apply your privacy and review choices.'}
        </p>
      </div>
      <div className="ofr-activation__tasks">
        {[
          ['Create secure workspace', 18],
          ['Build portfolio structure', 42],
          ['Index holdings and cash flows', 67],
          ['Prepare insights and review items', 86],
          ['Finish your home view', 100],
        ].map(([label, threshold]) => (
          <span className={progress >= Number(threshold) ? 'is-complete' : ''} key={label}>
            <i>{progress >= Number(threshold) ? <Icon name="check" size={12} /> : null}</i>
            {label}
          </span>
        ))}
      </div>
      {progress === 0 ? (
        <OButton icon="sparkles" kind="primary" onClick={onStart}>
          Activate workspace
        </OButton>
      ) : done ? (
        <OButton icon="arrow-right" kind="primary" onClick={onFinish}>
          Open BetterTrack
        </OButton>
      ) : (
        <div className="ofr-activation__bar">
          <i>
            <b style={{ width: `${progress}%` }} />
          </i>
          <span>{progress}%</span>
        </div>
      )}
      {done ? (
        <div className="ofr-ready-preview">
          <span>
            <Icon name="portfolio" size={17} />
            <small>Portfolio</small>
            <strong>{state.portfolioName}</strong>
          </span>
          <span>
            <Icon name="inbox" size={17} />
            <small>First review</small>
            <strong>{state.dataSource === 'skip' ? '3 setup items' : '4 insights ready'}</strong>
          </span>
          <span>
            <Icon name="shield" size={17} />
            <small>Access</small>
            <strong>{state.collaboration === 'private' ? 'Only you' : state.collaboration}</strong>
          </span>
        </div>
      ) : null}
    </div>
  );
}
