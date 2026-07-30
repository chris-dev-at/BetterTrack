import { type FormEvent, type ReactNode, useState } from 'react';

import { Icon, type IconName } from './Icons';

export type ProductSurface =
  | 'app'
  | 'auth'
  | 'onboarding'
  | 'settings'
  | 'public'
  | 'advisor'
  | 'admin';

export type DesignDirection = 'northstar' | 'ledger' | 'signal' | 'atelier' | 'prism' | 'origin';

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function SuiteBrand({ edition }: { edition?: string }) {
  return (
    <span className="surface-brand">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="brand-name">
        Better<span>Track</span>
      </span>
      {edition ? <em>{edition}</em> : null}
    </span>
  );
}

function SurfaceButton({
  children,
  icon,
  variant = 'secondary',
  onClick,
  type = 'button',
  disabled,
}: {
  children: ReactNode;
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'quiet';
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
}) {
  return (
    <button
      className={`button button--${variant} button--md`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

function SurfaceTopbar({
  title,
  edition,
  onBack,
  right,
}: {
  title?: string;
  edition?: string;
  onBack: () => void;
  right?: ReactNode;
}) {
  return (
    <header className="surface-topbar">
      <SuiteBrand edition={edition} />
      {title ? <span className="surface-topbar__title">{title}</span> : null}
      <div className="surface-topbar__right">
        {right}
        <SurfaceButton variant="quiet" icon="arrow-right" onClick={onBack}>
          Back to suite
        </SurfaceButton>
      </div>
    </header>
  );
}

function SurfaceAvatar({
  initials,
  tone = 'sand',
}: {
  initials: string;
  tone?: 'sand' | 'sage' | 'blue' | 'rose';
}) {
  return <span className={`surface-avatar surface-avatar--${tone}`}>{initials}</span>;
}

type AuthStep = 'login' | 'chooser' | 'passkey' | 'twofactor' | 'register';

export function AuthSurface({
  onBack,
  onSuccess,
  onRegister = onSuccess,
}: {
  onBack: () => void;
  onSuccess: () => void;
  onRegister?: () => void;
}) {
  const [step, setStep] = useState<AuthStep>('login');
  const [email, setEmail] = useState('alex@example.com');

  function submit(event: FormEvent) {
    event.preventDefault();
    setStep('twofactor');
  }

  return (
    <div className="auth-surface">
      <button className="auth-back" onClick={onBack} type="button">
        <Icon name="arrow-right" size={15} />
        Preview suite
      </button>
      <section className="auth-story">
        <SuiteBrand />
        <div className="auth-story__copy">
          <span className="surface-kicker">ONE FINANCIAL WORKSPACE</span>
          <h1>Your wealth should feel connected.</h1>
          <p>
            Track the truth, explore possibilities, and work together—without stitching five
            products into one.
          </p>
        </div>
        <div className="auth-visual" aria-hidden="true">
          <span className="auth-visual__glow" />
          <div className="auth-visual__root">
            <span>
              <Icon name="layers" />
            </span>
            <span>
              <small>ALL WEALTH</small>
              <strong>€642,480</strong>
            </span>
            <em>+0.83%</em>
          </div>
          <div className="auth-visual__branch auth-visual__branch--one">
            <span>
              <Icon name="wallet" />
            </span>
            <span>
              <strong>Personal wealth</strong>
              <small>Investments · cash flow · plans</small>
            </span>
          </div>
          <div className="auth-visual__branch auth-visual__branch--two">
            <span>
              <Icon name="briefcase" />
            </span>
            <span>
              <strong>Northstar Studio</strong>
              <small>Company · 2 portfolios inside</small>
            </span>
          </div>
          <div className="auth-visual__branch auth-visual__branch--three">
            <span>
              <Icon name="house" />
            </span>
            <span>
              <strong>Riverside property</strong>
              <small>Shared with Mia · 50 / 50</small>
            </span>
          </div>
          <div className="auth-visual__brief">
            <Icon name="sparkles" />
            <span>
              <small>BETTERTRACK BRIEF</small>
              <strong>Your month, explained.</strong>
            </span>
          </div>
        </div>
        <footer>
          <span>
            <Icon name="shield" size={14} />
            Private by default
          </span>
          <span>© 2026 BetterTrack</span>
        </footer>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          {step === 'login' ? (
            <>
              <span className="auth-mobile-brand">
                <SuiteBrand />
              </span>
              <div className="auth-card__heading">
                <span className="surface-kicker">WELCOME BACK</span>
                <h2>Sign in to BetterTrack</h2>
                <p>Continue to your financial workspace.</p>
              </div>
              <form onSubmit={submit}>
                <label>
                  Email address
                  <input
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <SurfaceButton variant="primary" type="submit">
                  Continue
                  <Icon name="arrow-right" size={15} />
                </SurfaceButton>
              </form>
              <div className="auth-divider">
                <span>or continue with</span>
              </div>
              <div className="auth-provider-grid">
                <button type="button" onClick={() => setStep('chooser')}>
                  <span className="google-mark">G</span>
                  Google
                </button>
                <button type="button" onClick={() => setStep('passkey')}>
                  <Icon name="shield" />
                  Passkey
                </button>
              </div>
              <p className="auth-register-link">
                New to BetterTrack?{' '}
                <button type="button" onClick={() => setStep('register')}>
                  Create an account
                </button>
              </p>
              <div className="auth-security-note">
                <Icon name="lock" size={13} />
                Protected by encrypted sessions and device-aware security.
              </div>
            </>
          ) : null}

          {step === 'chooser' ? (
            <div className="auth-flow">
              <button className="flow-back" type="button" onClick={() => setStep('login')}>
                <Icon name="arrow-right" size={14} />
              </button>
              <span className="google-mark google-mark--large">G</span>
              <h2>Choose a Google account</h2>
              <p>Continue to BetterTrack. The demo never leaves this browser.</p>
              <div className="account-chooser">
                <button type="button" onClick={() => setStep('twofactor')}>
                  <SurfaceAvatar initials="AM" />
                  <span>
                    <strong>Alex Morgan</strong>
                    <small>alex@example.com</small>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
                <button type="button" onClick={() => setStep('twofactor')}>
                  <SurfaceAvatar initials="NW" tone="sage" />
                  <span>
                    <strong>Northstar Workspace</strong>
                    <small>alex@northstar.studio</small>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
                <button type="button">
                  <span className="chooser-add">
                    <Icon name="plus" size={15} />
                  </span>
                  <span>
                    <strong>Use another account</strong>
                    <small>Sign in with a different Google identity</small>
                  </span>
                </button>
              </div>
            </div>
          ) : null}

          {step === 'passkey' ? (
            <div className="auth-flow">
              <button className="flow-back" type="button" onClick={() => setStep('login')}>
                <Icon name="arrow-right" size={14} />
              </button>
              <span className="passkey-orbit">
                <Icon name="shield" />
              </span>
              <span className="surface-kicker">PASSKEY</span>
              <h2>Use this device to sign in</h2>
              <p>
                A passkey is faster and phishing-resistant. Your biometric data stays on-device.
              </p>
              <div className="passkey-user">
                <SurfaceAvatar initials="AM" />
                <span>
                  <strong>Alex Morgan</strong>
                  <small>{email}</small>
                </span>
              </div>
              <SurfaceButton variant="primary" icon="shield" onClick={onSuccess}>
                Continue with passkey
              </SurfaceButton>
              <button className="auth-text-button" type="button" onClick={() => setStep('login')}>
                Use password instead
              </button>
            </div>
          ) : null}

          {step === 'twofactor' ? (
            <div className="auth-flow">
              <button className="flow-back" type="button" onClick={() => setStep('login')}>
                <Icon name="arrow-right" size={14} />
              </button>
              <span className="twofactor-mark">
                <Icon name="lock" />
              </span>
              <span className="surface-kicker">ONE MORE STEP</span>
              <h2>Enter your security code</h2>
              <p>Use the six-digit code from your authenticator app.</p>
              <div className="code-inputs">
                {['4', '8', '2', '1', '9', '6'].map((digit, index) => (
                  <input
                    aria-label={`Digit ${index + 1}`}
                    defaultValue={digit}
                    key={`${digit}-${index}`}
                    maxLength={1}
                  />
                ))}
              </div>
              <label className="trusted-device">
                <input type="checkbox" defaultChecked />
                <span>
                  <strong>Trust this device for 30 days</strong>
                  <small>Not recommended on a shared computer.</small>
                </span>
              </label>
              <SurfaceButton variant="primary" icon="check" onClick={onSuccess}>
                Verify and continue
              </SurfaceButton>
              <button className="auth-text-button" type="button">
                Use a recovery code
              </button>
            </div>
          ) : null}

          {step === 'register' ? (
            <div className="auth-flow auth-flow--register">
              <button className="flow-back" type="button" onClick={() => setStep('login')}>
                <Icon name="arrow-right" size={14} />
              </button>
              <span className="surface-kicker">START YOUR WORKSPACE</span>
              <h2>Create your BetterTrack account</h2>
              <p>Begin simple. The same portfolio model grows with you.</p>
              <div className="register-fields">
                <label>
                  Name
                  <input defaultValue="Alex Morgan" />
                </label>
                <label>
                  Email
                  <input defaultValue={email} />
                </label>
                <label>
                  Password
                  <input defaultValue="strongpassword" type="password" />
                </label>
              </div>
              <label className="trusted-device">
                <input type="checkbox" defaultChecked />
                <span>
                  <strong>I accept the Terms and Privacy Policy</strong>
                  <small>Financial data remains private by default.</small>
                </span>
              </label>
              <SurfaceButton variant="primary" onClick={onRegister}>
                Create workspace
                <Icon name="arrow-right" size={15} />
              </SurfaceButton>
            </div>
          ) : null}
        </div>
        <footer className="auth-panel__footer">
          <button type="button">Privacy</button>
          <button type="button">Security</button>
          <button type="button">Help</button>
        </footer>
      </section>
    </div>
  );
}

const onboardingSteps = ['Purpose', 'Data', 'Structure', 'Preferences', 'Ready'];

export function OnboardingSurface({
  onBack,
  onFinish,
}: {
  onBack: () => void;
  onFinish: () => void;
}) {
  const [step, setStep] = useState(0);
  const [purpose, setPurpose] = useState('personal');
  const [connected, setConnected] = useState<string[]>(['trade']);
  const [privacy, setPrivacy] = useState(false);

  function toggleConnection(id: string) {
    setConnected((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  return (
    <div className="onboarding-surface">
      <header className="onboarding-header">
        <SuiteBrand />
        <button type="button" onClick={onBack}>
          Save and exit
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="onboarding-progress">
        {onboardingSteps.map((label, index) => (
          <span className={cx(index <= step && 'is-active')} key={label}>
            <i>{index < step ? <Icon name="check" size={11} /> : index + 1}</i>
            <em>{label}</em>
          </span>
        ))}
      </div>
      <main className="onboarding-main">
        {step === 0 ? (
          <section className="onboarding-step">
            <span className="surface-kicker">LET'S BUILD THE RIGHT FOUNDATION</span>
            <h1>What does your first portfolio represent?</h1>
            <p>
              This only chooses sensible defaults. Every portfolio uses the same powerful model and
              can change later.
            </p>
            <div className="purpose-grid">
              {[
                [
                  'personal',
                  'Personal wealth',
                  'Investments, cash, spending, goals, and tax',
                  'wallet',
                ],
                [
                  'household',
                  'Household',
                  'Shared accounts, ownership, goals, and approvals',
                  'people',
                ],
                [
                  'company',
                  'Company or entity',
                  'Assets, liabilities, cash planning, and documents',
                  'briefcase',
                ],
                [
                  'client',
                  'Client mandate',
                  'Advisor access, approvals, reporting, and audit',
                  'shield',
                ],
              ].map(([id, label, copy, icon]) => (
                <button
                  className={purpose === id ? 'is-active' : ''}
                  key={id}
                  onClick={() => setPurpose(id!)}
                  type="button"
                >
                  <span>
                    <Icon name={icon as IconName} />
                  </span>
                  <strong>{label}</strong>
                  <small>{copy}</small>
                  <i>{purpose === id ? <Icon name="check" size={13} /> : null}</i>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding-step">
            <span className="surface-kicker">BRING YOUR FINANCES TOGETHER</span>
            <h1>How should we start?</h1>
            <p>
              Connect now or skip everything. BetterTrack always stages imported data for review.
            </p>
            <div className="onboarding-connections">
              {[
                ['trade', 'Trade Republic', 'Broker holdings and activity', 'TR', 'black'],
                ['parqet', 'Parqet', 'Two-way portfolio sync', 'P', 'green'],
                ['bank', 'Bank account', 'Cash, income, and expenses', 'S', 'red'],
                ['drive', 'Google Drive', 'Statements and portfolio files', 'G', 'blue'],
                ['manual', 'Manual or CSV', 'Start from a file or empty portfolio', '+', 'neutral'],
              ].map(([id, name, copy, mark, tone]) => {
                const active = connected.includes(id!);
                return (
                  <button
                    className={active ? 'is-active' : ''}
                    key={id}
                    onClick={() => toggleConnection(id!)}
                    type="button"
                  >
                    <span className={`onboarding-source onboarding-source--${tone}`}>{mark}</span>
                    <span>
                      <strong>{name}</strong>
                      <small>{copy}</small>
                    </span>
                    <span className={cx('source-connect-state', active && 'is-connected')}>
                      {active ? (
                        <>
                          <Icon name="check" size={12} /> Connected
                        </>
                      ) : (
                        'Connect'
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="onboarding-trust">
              <Icon name="shield" />
              <span>
                <strong>You control the scope.</strong>
                <small>
                  See exactly what each source can read and write before authorizing it.
                </small>
              </span>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding-step onboarding-step--structure">
            <span className="surface-kicker">A STRUCTURE THAT CAN GROW</span>
            <h1>Start simple. Compose later.</h1>
            <p>
              A portfolio can contain accounts, real assets, liabilities, collaborators, and other
              portfolios.
            </p>
            <div className="onboarding-structure">
              <div className="structure-node structure-node--root">
                <span>
                  <Icon name="wallet" />
                </span>
                <span>
                  <small>YOUR FIRST PORTFOLIO</small>
                  <strong>Personal wealth</strong>
                  <em>EUR · Austria · Private</em>
                </span>
                <Icon name="settings" size={15} />
              </div>
              <span className="structure-trunk" />
              <div className="structure-child-grid">
                <div>
                  <Icon name="bank" />
                  <strong>Accounts</strong>
                  <small>Trade Republic</small>
                </div>
                <div>
                  <Icon name="cash" />
                  <strong>Cash flow</strong>
                  <small>Income and spending</small>
                </div>
                <button type="button">
                  <Icon name="plus" />
                  <strong>Add inside</strong>
                  <small>Portfolio, asset, debt…</small>
                </button>
              </div>
            </div>
            <label className="portfolio-name-field">
              Portfolio name
              <input defaultValue="Personal wealth" />
            </label>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="onboarding-step">
            <span className="surface-kicker">TAILORED, NOT DUMBED DOWN</span>
            <h1>Choose your starting experience.</h1>
            <p>You can change every preference later, per device or portfolio.</p>
            <div className="preference-groups">
              <div>
                <span>
                  <strong>Dashboard density</strong>
                  <small>Balanced shows context without becoming a terminal.</small>
                </span>
                <div className="preference-options">
                  <button type="button">Calm</button>
                  <button className="is-active" type="button">
                    Balanced
                  </button>
                  <button type="button">Dense</button>
                </div>
              </div>
              <div>
                <span>
                  <strong>Theme</strong>
                  <small>Follow this device the first time.</small>
                </span>
                <div className="preference-options">
                  <button className="is-active" type="button">
                    <Icon name="monitor" size={14} /> System
                  </button>
                  <button type="button">
                    <Icon name="moon" size={14} /> Dark
                  </button>
                  <button type="button">
                    <Icon name="sun" size={14} /> Light
                  </button>
                </div>
              </div>
              <button
                className={cx('privacy-choice', privacy && 'is-active')}
                onClick={() => setPrivacy(!privacy)}
                type="button"
              >
                <span>
                  <Icon name={privacy ? 'eye-off' : 'eye'} />
                </span>
                <span>
                  <strong>Start in discreet mode</strong>
                  <small>Hide values while keeping the app usable.</small>
                </span>
                <i className={cx('toggle', privacy && 'is-on')}>
                  <em />
                </i>
              </button>
              <div className="tax-choice">
                <span>
                  <strong>Tax profile</strong>
                  <small>Used only for estimates and reports.</small>
                </span>
                <button type="button">
                  🇦🇹 Austria <Icon name="chevron-down" size={14} />
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="onboarding-step onboarding-ready">
            <span className="ready-mark">
              <Icon name="check" />
            </span>
            <span className="surface-kicker">YOUR WORKSPACE IS READY</span>
            <h1>Welcome to BetterTrack.</h1>
            <p>
              Personal wealth is connected to {connected.length} source
              {connected.length === 1 ? '' : 's'}. Imported data will appear in Review before
              changing anything.
            </p>
            <div className="ready-preview">
              <div>
                <span>
                  <Icon name="wallet" />
                </span>
                <span>
                  <small>PERSONAL WEALTH</small>
                  <strong>Ready for your data</strong>
                </span>
              </div>
              <ul>
                <li>
                  <Icon name="check" size={13} /> Portfolio created
                </li>
                <li>
                  <Icon name="check" size={13} /> Preferences saved
                </li>
                <li>
                  <Icon name="check" size={13} /> Review inbox ready
                </li>
              </ul>
            </div>
          </section>
        ) : null}
      </main>
      <footer className="onboarding-footer">
        <button disabled={step === 0} onClick={() => setStep(Math.max(0, step - 1))} type="button">
          <Icon name="arrow-right" size={14} />
          Back
        </button>
        <span>
          Step {step + 1} of {onboardingSteps.length}
        </span>
        <SurfaceButton
          variant="primary"
          onClick={() => (step === onboardingSteps.length - 1 ? onFinish() : setStep(step + 1))}
        >
          {step === onboardingSteps.length - 1 ? 'Open BetterTrack' : 'Continue'}
          <Icon name="arrow-right" size={14} />
        </SurfaceButton>
      </footer>
    </div>
  );
}

type SettingsSection =
  | 'account'
  | 'security'
  | 'privacy'
  | 'appearance'
  | 'notifications'
  | 'connections'
  | 'developer'
  | 'billing';

const settingsNavigation: Array<{
  id: SettingsSection;
  label: string;
  icon: IconName;
  group: 'Personal' | 'Workspace';
}> = [
  { id: 'account', label: 'Account', icon: 'people', group: 'Personal' },
  { id: 'security', label: 'Security', icon: 'shield', group: 'Personal' },
  { id: 'privacy', label: 'Privacy & AI', icon: 'eye', group: 'Personal' },
  { id: 'appearance', label: 'Appearance', icon: 'sliders', group: 'Personal' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', group: 'Personal' },
  { id: 'connections', label: 'Connections', icon: 'link', group: 'Workspace' },
  { id: 'developer', label: 'Developer', icon: 'command', group: 'Workspace' },
  { id: 'billing', label: 'Plan & usage', icon: 'cash', group: 'Workspace' },
];

function SettingsRow({
  icon,
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="settings-row">
      {icon ? (
        <span className="settings-row__icon">
          <Icon name={icon} />
        </span>
      ) : null}
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="settings-row__action">{action}</span>
    </div>
  );
}

function SettingsContent({ section }: { section: SettingsSection }) {
  const [paranoid, setParanoid] = useState(false);
  if (section === 'account') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">PERSONAL</span>
          <h1>Account</h1>
          <p>Your profile, identity, locale, and account lifecycle.</p>
        </div>
        <section className="settings-card">
          <header>
            <h2>Profile</h2>
            <p>Shown to people you collaborate with.</p>
          </header>
          <div className="profile-editor">
            <SurfaceAvatar initials="AM" />
            <SurfaceButton variant="secondary">Change photo</SurfaceButton>
            <button type="button">Remove</button>
          </div>
          <div className="settings-form-grid">
            <label>
              Display name
              <input defaultValue="Alex Morgan" />
            </label>
            <label>
              Username
              <input defaultValue="alexmorgan" />
            </label>
            <label>
              Email
              <input defaultValue="alex@example.com" />
            </label>
            <label>
              Locale
              <button type="button">
                English · EUR <Icon name="chevron-down" size={13} />
              </button>
            </label>
          </div>
          <footer>
            <SurfaceButton variant="primary">Save profile</SurfaceButton>
          </footer>
        </section>
        <section className="settings-card">
          <header>
            <h2>Account data</h2>
            <p>Portable and removable.</p>
          </header>
          <SettingsRow
            icon="download"
            title="Export everything"
            description="Portfolio data, files, settings, and audit history."
            action={<SurfaceButton variant="secondary">Request export</SurfaceButton>}
          />
          <SettingsRow
            icon="trash"
            title="Delete account"
            description="Permanent after the recovery period."
            action={<SurfaceButton variant="ghost">Delete…</SurfaceButton>}
          />
        </section>
      </>
    );
  }

  if (section === 'security') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">PROTECTED</span>
          <h1>Security</h1>
          <p>Strong sign-in without making everyday use painful.</p>
        </div>
        <section className="settings-security-score">
          <span className="security-score-ring">92</span>
          <span>
            <strong>Your account is well protected.</strong>
            <small>Add a second passkey to make recovery safer.</small>
          </span>
          <span className="security-score-status">
            <Icon name="check" size={13} />
            No urgent issues
          </span>
        </section>
        <section className="settings-card">
          <header>
            <h2>Sign-in methods</h2>
            <p>Use several methods so one lost device cannot lock you out.</p>
          </header>
          <SettingsRow
            icon="shield"
            title="Passkeys"
            description="MacBook Pro · added 12 May 2026"
            action={<SurfaceButton variant="secondary">Add passkey</SurfaceButton>}
          />
          <SettingsRow
            icon="lock"
            title="Two-factor authentication"
            description="Authenticator app is active · 8 recovery codes left"
            action={<span className="setting-status setting-status--active">Active</span>}
          />
          <SettingsRow
            icon="command"
            title="Quick-unlock PIN"
            description="Require after 15 minutes on this device"
            action={
              <span className="toggle is-on">
                <em />
              </span>
            }
          />
        </section>
        <section className="settings-card">
          <header>
            <h2>Active sessions</h2>
            <p>Signed-in devices and recent access.</p>
          </header>
          {[
            ['monitor', 'MacBook Pro · Vienna', 'This device · active now', 'Current'],
            ['monitor', 'Chrome on Windows · Salzburg', 'Yesterday at 18:42', 'Revoke'],
            ['wallet', 'BetterTrack Android · Pixel 9', '24 Jul at 08:16', 'Revoke'],
          ].map(([icon, title, copy, action]) => (
            <SettingsRow
              key={title}
              icon={icon as IconName}
              title={title!}
              description={copy!}
              action={
                action === 'Current' ? (
                  <span className="setting-status setting-status--active">Current</span>
                ) : (
                  <button className="settings-text-action" type="button">
                    {action}
                  </button>
                )
              }
            />
          ))}
        </section>
      </>
    );
  }

  if (section === 'privacy') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">YOUR DATA, YOUR RULES</span>
          <h1>Privacy & AI</h1>
          <p>Control what appears, leaves the device, or can be proposed.</p>
        </div>
        <section className="settings-card">
          <header>
            <h2>Privacy modes</h2>
            <p>Fast concealment and maximum-isolation controls.</p>
          </header>
          <SettingsRow
            icon="eye-off"
            title="Discreet mode"
            description="Hide monetary values while keeping navigation and context."
            action={
              <span className="toggle">
                <em />
              </span>
            }
          />
          <SettingsRow
            icon="shield"
            title="Paranoid mode"
            description="Re-authenticate, disable remote AI context, and conceal sensitive surfaces."
            action={
              <button
                aria-pressed={paranoid}
                className={cx('toggle', paranoid && 'is-on')}
                onClick={() => setParanoid(!paranoid)}
                type="button"
              >
                <em />
              </button>
            }
          />
        </section>
        <section className="settings-card">
          <header>
            <h2>Ask BetterTrack permissions</h2>
            <p>Defaults for new AI conversations. Every conversation still shows its scope.</p>
          </header>
          <SettingsRow
            icon="eye"
            title="Read selected portfolio data"
            description="Only portfolios explicitly included in a conversation."
            action={<span className="setting-status setting-status--active">Allowed</span>}
          />
          <SettingsRow
            icon="document"
            title="Prepare action proposals"
            description="Draft scenarios and automations, but never apply them."
            action={
              <span className="toggle is-on">
                <em />
              </span>
            }
          />
          <SettingsRow
            icon="lock"
            title="Execute writes"
            description="Not available. Writes always require a human review step."
            action={<span className="setting-status">Never automatic</span>}
          />
        </section>
      </>
    );
  }

  if (section === 'appearance') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">MAKE IT YOURS</span>
          <h1>Appearance</h1>
          <p>Personalize density and charts without moving safety-critical controls.</p>
        </div>
        <section className="settings-card">
          <header>
            <h2>Interface</h2>
            <p>Applied across this device.</p>
          </header>
          <div className="appearance-previews">
            {['System', 'Dark', 'Light'].map((label, index) => (
              <button className={index === 0 ? 'is-active' : ''} key={label} type="button">
                <span className={`theme-preview theme-preview--${label.toLowerCase()}`}>
                  <i />
                  <em />
                </span>
                <strong>{label}</strong>
                {index === 0 ? <Icon name="check" size={13} /> : null}
              </button>
            ))}
          </div>
          <SettingsRow
            icon="list"
            title="Information density"
            description="Balanced"
            action={
              <button className="settings-select" type="button">
                Balanced <Icon name="chevron-down" size={13} />
              </button>
            }
          />
          <SettingsRow
            icon="assets"
            title="Portfolio chart color"
            description="Neutral brass; gain/loss colors reserved for individual assets."
            action={
              <span className="chart-color-choice">
                <i />
                <i />
                <i />
              </span>
            }
          />
        </section>
        <section className="settings-card">
          <header>
            <h2>Navigation</h2>
            <p>Pin desktop destinations and customize the mobile bar.</p>
          </header>
          <div className="settings-mobile-nav">
            {[
              ['home', 'Home'],
              ['portfolio', 'Portfolios'],
              ['plus', 'Create'],
              ['workbench', 'Workbench'],
              ['assets', 'Assets'],
            ].map(([icon, label]) => (
              <span key={label}>
                <Icon name={icon as IconName} />
                <small>{label}</small>
              </span>
            ))}
          </div>
          <footer>
            <SurfaceButton variant="secondary" icon="sliders">
              Configure mobile navigation
            </SurfaceButton>
          </footer>
        </section>
      </>
    );
  }

  if (section === 'notifications') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">SIGNAL, NOT NOISE</span>
          <h1>Notifications</h1>
          <p>Choose which portfolio changes deserve interruption.</p>
        </div>
        <section className="settings-card notification-matrix">
          <header>
            <h2>Delivery rules</h2>
            <p>Critical security alerts cannot be disabled.</p>
          </header>
          <div className="notification-matrix__head">
            <span>Event</span>
            <span>In app</span>
            <span>Email</span>
            <span>Push</span>
          </div>
          {[
            ['Needs review', true, false, true],
            ['Portfolio drift', true, true, false],
            ['Price and event alerts', true, false, true],
            ['Collaborator proposals', true, true, true],
            ['Weekly portfolio brief', true, true, false],
            ['Security and access', true, true, true],
          ].map(([label, app, email, push]) => (
            <div key={String(label)}>
              <strong>{label}</strong>
              {[app, email, push].map((active, index) => (
                <span className={cx('matrix-check', Boolean(active) && 'is-active')} key={index}>
                  {active ? <Icon name="check" size={11} /> : null}
                </span>
              ))}
            </div>
          ))}
        </section>
      </>
    );
  }

  if (section === 'connections') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">PORTFOLIO-SCOPED ACCESS</span>
          <h1>Connections</h1>
          <p>Every source shows its permissions, scope, health, and sync history.</p>
        </div>
        <section className="connection-overview">
          <span className="connection-score">
            <Icon name="check" />
          </span>
          <span>
            <strong>All 5 connected sources are healthy.</strong>
            <small>Last full sync 2 minutes ago · 1,284 records checked</small>
          </span>
          <SurfaceButton variant="secondary" icon="refresh">
            Sync all
          </SurfaceButton>
        </section>
        <section className="settings-card">
          <header>
            <h2>Data sources</h2>
            <p>Connected to Personal wealth unless noted.</p>
          </header>
          {[
            [
              'TR',
              'Trade Republic',
              'Read holdings and activity · write disabled',
              'Synced now',
              'black',
            ],
            ['P', 'Parqet', 'Two-way holdings and activity', 'Synced 4 min ago', 'green'],
            ['S', 'Sparkasse', 'Read balances and cash activity', 'Synced 8 min ago', 'red'],
            [
              'G',
              'Google Drive',
              'Read selected folder · write exports',
              'Synced 12 min ago',
              'blue',
            ],
          ].map(([mark, title, copy, status, tone]) => (
            <div className="settings-connection-row" key={title}>
              <span className={`onboarding-source onboarding-source--${tone}`}>{mark}</span>
              <span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </span>
              <span>
                <i />
                {status}
              </span>
              <button type="button">Manage</button>
            </div>
          ))}
          <footer>
            <SurfaceButton variant="primary" icon="plus">
              Add connection
            </SurfaceButton>
          </footer>
        </section>
      </>
    );
  }

  if (section === 'developer') {
    return (
      <>
        <div className="settings-title">
          <span className="surface-kicker">BUILD ON YOUR WEALTH DATA</span>
          <h1>Developer</h1>
          <p>APIs and AI context use the same portfolio permissions as the interface.</p>
        </div>
        <div className="developer-grid">
          {[
            [
              'API keys',
              'Create scoped keys for your own apps and automations.',
              'command',
              '2 active',
            ],
            [
              'OAuth applications',
              'Connect third-party apps without sharing a password.',
              'link',
              '1 app',
            ],
            ['Webhooks', 'Receive signed portfolio-change events.', 'activity', '3 endpoints'],
            [
              'MCP context',
              'Give an AI read access to explicitly selected portfolios.',
              'ai',
              'Read-only',
            ],
          ].map(([title, copy, icon, meta]) => (
            <button key={title} type="button">
              <span>
                <Icon name={icon as IconName} />
              </span>
              <strong>{title}</strong>
              <small>{copy}</small>
              <em>{meta}</em>
              <Icon name="arrow-right" size={14} />
            </button>
          ))}
        </div>
        <section className="settings-card">
          <header>
            <h2>Recent API activity</h2>
            <p>Every request is attributable and auditable.</p>
          </header>
          {[
            ['GET /v1/portfolios/personal/holdings', 'Portfolio dashboard', '200', '4 min ago'],
            ['POST /v1/portfolios/personal/activity', 'My finance tool', '201', 'Yesterday'],
            ['GET /v1/portfolios/personal/performance', 'Parqet sync', '200', 'Yesterday'],
          ].map(([request, app, status, time]) => (
            <div className="api-log-row" key={request}>
              <code>{request}</code>
              <span>{app}</span>
              <em>{status}</em>
              <small>{time}</small>
            </div>
          ))}
        </section>
      </>
    );
  }

  return (
    <>
      <div className="settings-title">
        <span className="surface-kicker">BETTERTRACK INVESTOR</span>
        <h1>Plan & usage</h1>
        <p>Your plan should scale with capability, not lock away your own data.</p>
      </div>
      <section className="billing-hero">
        <span>
          <small>CURRENT PLAN</small>
          <strong>Investor</strong>
          <em>Renews 12 August 2026</em>
        </span>
        <span>
          <strong>€8.90</strong>
          <small>/ month</small>
        </span>
        <SurfaceButton variant="secondary">Manage plan</SurfaceButton>
      </section>
      <section className="settings-card usage-card">
        <header>
          <h2>Usage this month</h2>
          <p>Transparent limits with no surprise lockouts.</p>
        </header>
        {[
          ['Portfolios', '4 of unlimited', 12],
          ['Connected sources', '5 of 10', 50],
          ['AI portfolio questions', '38 of 200', 19],
          ['File storage', '1.8 GB of 20 GB', 9],
        ].map(([label, value, usage]) => (
          <div key={String(label)}>
            <span>
              <strong>{label}</strong>
              <small>{value}</small>
            </span>
            <i>
              <em style={{ width: `${usage}%` }} />
            </i>
          </div>
        ))}
      </section>
    </>
  );
}

export function SettingsSurface({ onBack }: { onBack: () => void }) {
  const [section, setSection] = useState<SettingsSection>('security');
  return (
    <div className="settings-surface">
      <SurfaceTopbar title="Settings" onBack={onBack} />
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="settings-person">
            <SurfaceAvatar initials="AM" />
            <span>
              <strong>Alex Morgan</strong>
              <small>alex@example.com</small>
            </span>
          </div>
          {(['Personal', 'Workspace'] as const).map((group) => (
            <nav key={group}>
              <span>{group}</span>
              {settingsNavigation
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    className={section === item.id ? 'is-active' : ''}
                    key={item.id}
                    onClick={() => setSection(item.id)}
                    type="button"
                  >
                    <Icon name={item.icon} />
                    {item.label}
                    {item.id === 'security' ? <em>92</em> : null}
                  </button>
                ))}
            </nav>
          ))}
        </aside>
        <main className="settings-main">
          <SettingsContent section={section} />
        </main>
      </div>
    </div>
  );
}

export function PublicShareSurface({
  onBack,
  onSignIn,
}: {
  onBack: () => void;
  onSignIn: () => void;
}) {
  const [range, setRange] = useState('1Y');
  return (
    <div className="public-surface">
      <header className="public-header">
        <SuiteBrand />
        <div>
          <span>
            <Icon name="shield" size={13} />
            Read-only shared view
          </span>
          <SurfaceButton variant="secondary" onClick={onSignIn}>
            Sign in
          </SurfaceButton>
          <SurfaceButton variant="primary" onClick={onBack}>
            Open BetterTrack
          </SurfaceButton>
        </div>
      </header>
      <main className="public-main">
        <div className="public-profile">
          <SurfaceAvatar initials="AM" />
          <span>
            <strong>Alex Morgan</strong>
            <small>@alexmorgan · updated 8 minutes ago</small>
          </span>
          <button aria-label="Public portfolio options" type="button">
            <Icon name="more" />
          </button>
        </div>
        <section className="public-hero">
          <div>
            <span className="public-badge">
              <Icon name="portfolio" size={13} />
              PUBLIC PORTFOLIO
            </span>
            <h1>Global Core</h1>
            <p>
              A long-term, globally diversified allocation built around low fees and steady
              contributions.
            </p>
            <div className="public-meta">
              <span>
                <Icon name="calendar" size={13} />
                Started May 2021
              </span>
              <span>
                <Icon name="assets" size={13} />8 holdings
              </span>
              <span>
                <Icon name="eye" size={13} />
                Values hidden by owner
              </span>
            </div>
          </div>
          <button type="button">
            <Icon name="share" />
            Share
          </button>
        </section>
        <section className="public-performance">
          <div className="public-performance__header">
            <span>
              <small>Performance</small>
              <strong>+18.42%</strong>
              <em>+7.31% annualized</em>
            </span>
            <div className="range-switcher">
              {['1M', '3M', '1Y', 'ALL'].map((item) => (
                <button
                  className={range === item ? 'is-active' : ''}
                  key={item}
                  onClick={() => setRange(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          <svg
            viewBox="0 0 1000 280"
            preserveAspectRatio="none"
            aria-label="Public performance chart"
          >
            <defs>
              <linearGradient id="public-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#d9b778" stopOpacity=".22" />
                <stop offset="1" stopColor="#d9b778" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="chart-grid">
              <line x1="0" x2="1000" y1="50" y2="50" />
              <line x1="0" x2="1000" y1="125" y2="125" />
              <line x1="0" x2="1000" y1="200" y2="200" />
              <line x1="0" x2="1000" y1="265" y2="265" />
            </g>
            <path
              d="M5 246 C80 252 110 216 180 223 S270 182 340 191 S440 146 510 159 S610 107 680 122 S790 79 850 88 S930 49 995 31 L995 270 L5 270Z"
              fill="url(#public-area)"
            />
            <path
              d="M5 246 C80 252 110 216 180 223 S270 182 340 191 S440 146 510 159 S610 107 680 122 S790 79 850 88 S930 49 995 31"
              fill="none"
              stroke="#d9b778"
              strokeLinecap="round"
              strokeWidth="3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="public-chart-axis">
            <span>Jul 2025</span>
            <span>Oct</span>
            <span>Jan 2026</span>
            <span>Apr</span>
            <span>Today</span>
          </div>
          <footer>
            <span>
              <i />
              Global Core
            </span>
            <span>
              <i />
              FTSE All-World benchmark
            </span>
            <button aria-label="Admin notifications" type="button">
              <Icon name="help" size={13} />
              Methodology
            </button>
          </footer>
        </section>
        <div className="public-grid">
          <section className="public-card public-allocation">
            <header>
              <div>
                <h2>Allocation</h2>
                <p>Owner-selected public breakdown</p>
              </div>
              <button type="button">
                Asset class <Icon name="chevron-down" size={13} />
              </button>
            </header>
            <div>
              <span className="public-donut">
                <i>8</i>
                <small>holdings</small>
              </span>
              <div>
                {[
                  ['Global equity', '70%', '#d1b57f'],
                  ['Government bonds', '15%', '#829d92'],
                  ['Cash', '10%', '#d3cbb9'],
                  ['Alternatives', '5%', '#8493aa'],
                ].map(([label, value, color]) => (
                  <span key={label}>
                    <i style={{ background: color }} />
                    <em>{label}</em>
                    <strong>{value}</strong>
                  </span>
                ))}
              </div>
            </div>
          </section>
          <section className="public-card public-holdings">
            <header>
              <div>
                <h2>Top holdings</h2>
                <p>Percentages shown; values private</p>
              </div>
            </header>
            {[
              ['VWCE', 'Vanguard FTSE All-World', '52.4%', '+14.8%'],
              ['VAGF', 'Vanguard Global Aggregate Bond', '15.0%', '+3.2%'],
              ['AAPL', 'Apple', '8.6%', '+22.4%'],
              ['MSFT', 'Microsoft', '7.4%', '+18.1%'],
            ].map(([symbol, name, allocation, change]) => (
              <div key={symbol}>
                <span>{String(symbol).slice(0, 2)}</span>
                <span>
                  <strong>{symbol}</strong>
                  <small>{name}</small>
                </span>
                <strong>{allocation}</strong>
                <em>{change}</em>
              </div>
            ))}
          </section>
        </div>
        <section className="public-disclaimer">
          <Icon name="shield" />
          <span>
            <strong>Shared for information, not financial advice.</strong>
            <small>
              Performance can be delayed and excludes hidden activity. BetterTrack does not verify
              ownership claims on public pages.
            </small>
          </span>
        </section>
      </main>
      <footer className="public-footer">
        <SuiteBrand />
        <span>Built with BetterTrack · Your wealth, working together.</span>
        <div>
          <button type="button">Privacy</button>
          <button type="button">Report</button>
        </div>
      </footer>
    </div>
  );
}

type AdminSection = 'overview' | 'users' | 'operations' | 'integrations' | 'governance';

export function AdminSurface({ onBack }: { onBack: () => void }) {
  const [section, setSection] = useState<AdminSection>('overview');
  return (
    <div className="admin-surface">
      <aside className="admin-sidebar">
        <SuiteBrand edition="Admin" />
        <nav>
          <span>CONTROL</span>
          {[
            ['overview', 'Overview', 'grid'],
            ['users', 'Users & access', 'people'],
            ['operations', 'Operations', 'activity'],
            ['integrations', 'Integrations', 'link'],
            ['governance', 'Governance', 'shield'],
          ].map(([id, label, icon]) => (
            <button
              className={section === id ? 'is-active' : ''}
              key={id}
              onClick={() => setSection(id as AdminSection)}
              type="button"
            >
              <Icon name={icon as IconName} />
              {label}
              {id === 'operations' ? <em>2</em> : null}
            </button>
          ))}
          <span>SYSTEM</span>
          {[
            ['Plans & quotas', 'cash'],
            ['Feature flags', 'sliders'],
            ['AI policy', 'ai'],
            ['OAuth & API', 'command'],
            ['Announcements', 'bell'],
            ['Email', 'message'],
          ].map(([label, icon]) => (
            <button key={label} type="button">
              <Icon name={icon as IconName} />
              {label}
            </button>
          ))}
        </nav>
        <div className="admin-sidebar__bottom">
          <button type="button" onClick={onBack}>
            <Icon name="arrow-right" />
            Return to BetterTrack
          </button>
          <div>
            <SurfaceAvatar initials="AM" />
            <span>
              <strong>Alex Morgan</strong>
              <small>Developer · Owner</small>
            </span>
          </div>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-topbar">
          <span>
            <StatusPill tone="green">Production healthy</StatusPill>
            <small>EU-CENTRAL-1</small>
          </span>
          <div>
            <button aria-label="Admin help" type="button">
              <Icon name="search" />
              Search admin
              <kbd>⌘ K</kbd>
            </button>
            <button type="button">
              <Icon name="bell" />
              <i />
            </button>
            <button type="button">
              <Icon name="help" />
            </button>
          </div>
        </header>
        {section === 'overview' ? <AdminOverview /> : null}
        {section === 'users' ? <AdminUsers /> : null}
        {section === 'operations' ? <AdminOperations /> : null}
        {section === 'integrations' ? <AdminIntegrations /> : null}
        {section === 'governance' ? <AdminGovernance /> : null}
      </main>
    </div>
  );
}

function StatusPill({
  children,
  tone,
}: {
  children: ReactNode;
  tone: 'green' | 'amber' | 'red' | 'blue';
}) {
  return <span className={`admin-pill admin-pill--${tone}`}>{children}</span>;
}

function AdminHeading({
  eyebrow,
  title,
  copy,
  actions,
}: {
  eyebrow: string;
  title: string;
  copy: string;
  actions?: ReactNode;
}) {
  return (
    <div className="admin-heading">
      <div>
        <span>{eyebrow}</span>
        <h1>{title}</h1>
        <p>{copy}</p>
      </div>
      {actions ? <div>{actions}</div> : null}
    </div>
  );
}

function AdminOverview() {
  return (
    <div className="admin-content">
      <AdminHeading
        eyebrow="MONDAY, 27 JULY"
        title="System overview"
        copy="Product health, operations, and the work that needs attention."
        actions={
          <>
            <SurfaceButton variant="secondary" icon="download">
              Export
            </SurfaceButton>
            <SurfaceButton variant="primary" icon="plus">
              Invite user
            </SurfaceButton>
          </>
        }
      />
      <div className="admin-kpis">
        {[
          ['Active users', '12,842', '+8.4%', 'people'],
          ['Assets tracked', '€1.28B', '+3.1%', 'assets'],
          ['Sync success', '99.94%', '24h', 'refresh'],
          ['Monthly revenue', '€86.4K', '+12.6%', 'cash'],
        ].map(([label, value, delta, icon]) => (
          <section key={label}>
            <span>
              <Icon name={icon as IconName} />
            </span>
            <small>{label}</small>
            <strong>{value}</strong>
            <em>{delta}</em>
            <MiniAdminChart positive={label !== 'Sync success'} />
          </section>
        ))}
      </div>
      <div className="admin-overview-grid">
        <section className="admin-card admin-usage-chart">
          <header>
            <div>
              <h2>Product activity</h2>
              <p>Daily active workspaces and meaningful actions</p>
            </div>
            <button type="button">
              Last 30 days <Icon name="chevron-down" size={13} />
            </button>
          </header>
          <div className="admin-chart-legend">
            <span>
              <i /> Active workspaces
            </span>
            <span>
              <i /> Portfolio actions
            </span>
          </div>
          <svg viewBox="0 0 800 260" preserveAspectRatio="none">
            <defs>
              <linearGradient id="admin-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#d9b778" stopOpacity=".18" />
                <stop offset="1" stopColor="#d9b778" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="chart-grid">
              <line x1="0" x2="800" y1="35" y2="35" />
              <line x1="0" x2="800" y1="105" y2="105" />
              <line x1="0" x2="800" y1="175" y2="175" />
              <line x1="0" x2="800" y1="245" y2="245" />
            </g>
            <path
              d="M0 225 C80 210 120 215 180 185 S290 181 350 143 S450 153 520 99 S660 88 800 45 L800 255 L0 255Z"
              fill="url(#admin-area)"
            />
            <path
              d="M0 225 C80 210 120 215 180 185 S290 181 350 143 S450 153 520 99 S660 88 800 45"
              fill="none"
              stroke="#d9b778"
              strokeWidth="2.5"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d="M0 242 C90 232 150 239 220 210 S350 212 430 177 S560 181 630 142 S730 151 800 120"
              fill="none"
              stroke="#78978b"
              strokeDasharray="5 5"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <footer>
            <span>28 Jun</span>
            <span>06 Jul</span>
            <span>14 Jul</span>
            <span>22 Jul</span>
            <span>Today</span>
          </footer>
        </section>
        <section className="admin-card admin-attention">
          <header>
            <div>
              <h2>Needs attention</h2>
              <p>Prioritized operational queue</p>
            </div>
            <span>2 open</span>
          </header>
          {[
            ['red', 'Sparkasse sync degradation', '3.1% retry rate · 84 users affected', '12 min'],
            ['amber', 'Email queue delay', 'P95 delivery at 42 seconds', '28 min'],
            ['blue', 'Plan quota nearing limit', 'Drive storage · 14 workspaces', 'Today'],
            ['green', 'V6 migration complete', '12,842 workspaces verified', 'Yesterday'],
          ].map(([tone, title, copy, time]) => (
            <button key={title} type="button">
              <i className={`admin-state admin-state--${tone}`} />
              <span>
                <strong>{title}</strong>
                <small>{copy}</small>
              </span>
              <em>{time}</em>
              <Icon name="chevron-right" size={13} />
            </button>
          ))}
        </section>
      </div>
      <div className="admin-bottom-grid">
        <section className="admin-card">
          <header>
            <div>
              <h2>Connection health</h2>
              <p>Last 24 hours</p>
            </div>
            <button type="button">
              Details <Icon name="arrow-right" size={12} />
            </button>
          </header>
          <div className="provider-health">
            {[
              ['Trade Republic', '99.98%', 'green'],
              ['Parqet', '99.96%', 'green'],
              ['Google Drive', '99.91%', 'green'],
              ['Sparkasse', '96.88%', 'amber'],
            ].map(([name, uptime, tone]) => (
              <span key={name}>
                <i className={`admin-state admin-state--${tone}`} />
                <strong>{name}</strong>
                <em>{uptime}</em>
              </span>
            ))}
          </div>
        </section>
        <section className="admin-card">
          <header>
            <div>
              <h2>Sign-ups by plan</h2>
              <p>This month · 1,284 total</p>
            </div>
          </header>
          <div className="plan-breakdown">
            <span className="plan-donut">
              <i>+14%</i>
            </span>
            <div>
              <span>
                <i /> Free <strong>58%</strong>
              </span>
              <span>
                <i /> Investor <strong>31%</strong>
              </span>
              <span>
                <i /> Pro <strong>9%</strong>
              </span>
              <span>
                <i /> Advisor <strong>2%</strong>
              </span>
            </div>
          </div>
        </section>
        <section className="admin-card">
          <header>
            <div>
              <h2>Audit highlights</h2>
              <p>Privileged actions</p>
            </div>
          </header>
          <div className="audit-highlights">
            <span>
              <SurfaceAvatar initials="AM" />
              <span>
                <strong>Feature flag updated</strong>
                <small>advisor_spaces · 18 min</small>
              </span>
            </span>
            <span>
              <SurfaceAvatar initials="SK" tone="blue" />
              <span>
                <strong>User role changed</strong>
                <small>Support → Admin · 2 hr</small>
              </span>
            </span>
            <span>
              <SurfaceAvatar initials="SY" tone="sage" />
              <span>
                <strong>Automated backup verified</strong>
                <small>System · 4 hr</small>
              </span>
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

function MiniAdminChart({ positive }: { positive: boolean }) {
  const points = positive
    ? '0,27 12,24 24,25 36,17 48,19 60,11 72,13 84,5 96,7'
    : '0,12 12,11 24,12 36,10 48,11 60,10 72,11 84,9 96,10';
  return (
    <svg className="admin-mini-chart" viewBox="0 0 96 32" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke={positive ? 'var(--positive)' : 'var(--blue)'}
        strokeWidth="1.6"
      />
    </svg>
  );
}

function AdminUsers() {
  return (
    <div className="admin-content">
      <AdminHeading
        eyebrow="IDENTITY & ACCESS"
        title="Users"
        copy="People, roles, plans, invitations, and account health."
        actions={
          <SurfaceButton variant="primary" icon="user-plus">
            Invite user
          </SurfaceButton>
        }
      />
      <div className="admin-list-toolbar">
        <div>
          <Icon name="search" />
          <input placeholder="Search users, email, or workspace…" />
        </div>
        <SurfaceButton variant="secondary" icon="filter">
          Filters
        </SurfaceButton>
        <SurfaceButton variant="secondary" icon="download">
          Export
        </SurfaceButton>
      </div>
      <section className="admin-card admin-users-table">
        <div className="admin-table-head">
          <span>User</span>
          <span>Role</span>
          <span>Plan</span>
          <span>Workspaces</span>
          <span>Last active</span>
          <span>Status</span>
          <span />
        </div>
        {[
          [
            'AM',
            'Alex Morgan',
            'alex@example.com',
            'Developer',
            'Advisor',
            '3',
            'Now',
            'Active',
            'sand',
          ],
          [
            'MK',
            'Mia Keller',
            'mia@example.com',
            'User',
            'Investor',
            '2',
            '8 min',
            'Active',
            'sage',
          ],
          [
            'JL',
            'Jonas Leitner',
            'jonas@example.com',
            'Advisor',
            'Pro',
            '12',
            '1 hr',
            'Active',
            'blue',
          ],
          [
            'LW',
            'Lea Wagner',
            'lea@example.com',
            'User',
            'Free',
            '1',
            'Yesterday',
            'Invited',
            'rose',
          ],
          [
            'SK',
            'Sofia Kern',
            'sofia@bettertrack.app',
            'Admin',
            'Staff',
            '—',
            '2 hr',
            'Active',
            'blue',
          ],
        ].map(([initials, name, email, role, plan, spaces, active, status, tone]) => (
          <button key={email} type="button">
            <span className="admin-user">
              <SurfaceAvatar
                initials={initials!}
                tone={tone as 'sand' | 'sage' | 'blue' | 'rose'}
              />
              <span>
                <strong>{name}</strong>
                <small>{email}</small>
              </span>
            </span>
            <span>{role}</span>
            <span>{plan}</span>
            <span>{spaces}</span>
            <span>{active}</span>
            <StatusPill tone={status === 'Active' ? 'green' : 'amber'}>{status}</StatusPill>
            <Icon name="more" size={14} />
          </button>
        ))}
      </section>
    </div>
  );
}

function AdminOperations() {
  return (
    <div className="admin-content">
      <AdminHeading
        eyebrow="SYSTEM OPERATIONS"
        title="Operations"
        copy="Health, incidents, background jobs, and support problems."
      />
      <div className="admin-kpis">
        {[
          ['Open incidents', '0', 'All clear', 'shield'],
          ['Problem reports', '2', '−4 today', 'inbox'],
          ['Job throughput', '18.4K', 'per hour', 'activity'],
          ['P95 API latency', '184ms', '−22ms', 'clock'],
        ].map(([label, value, delta, icon]) => (
          <section key={label}>
            <span>
              <Icon name={icon as IconName} />
            </span>
            <small>{label}</small>
            <strong>{value}</strong>
            <em>{delta}</em>
          </section>
        ))}
      </div>
      <section className="admin-card operation-timeline">
        <header>
          <div>
            <h2>Live system timeline</h2>
            <p>Deploys, jobs, incidents, and automated checks</p>
          </div>
          <StatusPill tone="green">Live</StatusPill>
        </header>
        {[
          [
            'green',
            'Portfolio valuation cycle completed',
            '12,842 portfolios · 8.2s · no failures',
            '1 min ago',
          ],
          [
            'blue',
            'Release bettertrack-web@6.1.4 deployed',
            'Production · 100% rollout · by Sofia Kern',
            '24 min ago',
          ],
          [
            'amber',
            'Sparkasse provider retry threshold crossed',
            'Automatic backoff active · investigating',
            '41 min ago',
          ],
          ['green', 'Database backup verified', 'Encrypted snapshot · eu-central-1', '2 hr ago'],
        ].map(([tone, title, copy, time]) => (
          <div key={title}>
            <i className={`admin-state admin-state--${tone}`} />
            <span>
              <strong>{title}</strong>
              <small>{copy}</small>
            </span>
            <em>{time}</em>
          </div>
        ))}
      </section>
    </div>
  );
}

function AdminIntegrations() {
  return (
    <div className="admin-content">
      <AdminHeading
        eyebrow="DATA PLATFORM"
        title="Integrations"
        copy="Provider health, OAuth configuration, sync jobs, and scoped capabilities."
        actions={
          <SurfaceButton variant="primary" icon="plus">
            Add provider
          </SurfaceButton>
        }
      />
      <div className="integration-admin-grid">
        {[
          ['TR', 'Trade Republic', 'Broker', '42,181', '99.98%', 'Healthy', 'black'],
          ['P', 'Parqet', 'Portfolio sync', '18,904', '99.96%', 'Healthy', 'green'],
          ['S', 'Sparkasse', 'Banking', '8,294', '96.88%', 'Degraded', 'red'],
          ['G', 'Google Drive', 'Files', '11,428', '99.91%', 'Healthy', 'blue'],
        ].map(([mark, name, type, accounts, uptime, status, tone]) => (
          <section className="admin-card" key={name}>
            <header>
              <span className={`onboarding-source onboarding-source--${tone}`}>{mark}</span>
              <StatusPill tone={status === 'Healthy' ? 'green' : 'amber'}>{status}</StatusPill>
            </header>
            <h2>{name}</h2>
            <p>{type}</p>
            <dl>
              <div>
                <dt>Connected accounts</dt>
                <dd>{accounts}</dd>
              </div>
              <div>
                <dt>24h success</dt>
                <dd>{uptime}</dd>
              </div>
            </dl>
            <button type="button">
              Open provider <Icon name="arrow-right" size={13} />
            </button>
          </section>
        ))}
      </div>
    </div>
  );
}

function AdminGovernance() {
  return (
    <div className="admin-content">
      <AdminHeading
        eyebrow="CONTROL & PROOF"
        title="Governance"
        copy="Policies, privileged access, data retention, and immutable audit."
      />
      <div className="governance-grid">
        {[
          ['Admin access', '5 people', 'All protected by passkeys + 2FA', 'shield', 'green'],
          ['AI policy', 'Review required', 'No autonomous financial writes', 'ai', 'green'],
          [
            'Data retention',
            'Compliant',
            'EU region · 30-day deletion recovery',
            'document',
            'blue',
          ],
          ['Audit integrity', 'Verified', 'Last seal 4 minutes ago', 'lock', 'green'],
        ].map(([title, value, copy, icon, tone]) => (
          <section className="admin-card" key={title}>
            <span>
              <Icon name={icon as IconName} />
            </span>
            <small>{title}</small>
            <strong>{value}</strong>
            <p>{copy}</p>
            <StatusPill tone={tone as 'green' | 'blue'}>Healthy</StatusPill>
          </section>
        ))}
      </div>
      <section className="admin-card admin-audit-table">
        <header>
          <div>
            <h2>Privileged audit</h2>
            <p>Immutable log of administrative actions</p>
          </div>
          <SurfaceButton variant="secondary" icon="download">
            Export signed log
          </SurfaceButton>
        </header>
        {[
          [
            '27 Jul 09:42',
            'Sofia Kern',
            'feature_flag.update',
            'advisor_spaces → 100%',
            'Production',
          ],
          ['27 Jul 08:18', 'System', 'backup.verify', 'snapshot eu-2026-07-27', 'Automated'],
          ['26 Jul 18:51', 'Alex Morgan', 'role.update', 'user_8F2 → support', 'Production'],
          [
            '26 Jul 16:02',
            'Sofia Kern',
            'announcement.publish',
            'V6 migration complete',
            'Production',
          ],
        ].map(([time, actor, action, target, environment]) => (
          <div key={`${time}-${action}`}>
            <time>{time}</time>
            <strong>{actor}</strong>
            <code>{action}</code>
            <span>{target}</span>
            <em>{environment}</em>
          </div>
        ))}
      </section>
    </div>
  );
}

export function AdvisorSurface({ onBack }: { onBack: () => void }) {
  const [client, setClient] = useState('All clients');
  return (
    <div className="advisor-surface">
      <aside className="advisor-sidebar">
        <SuiteBrand edition="Advisor" />
        <button className="advisor-workspace-switch" type="button">
          <span>NM</span>
          <span>
            <strong>Northstar Advisory</strong>
            <small>Advisor workspace</small>
          </span>
          <Icon name="chevron-down" size={14} />
        </button>
        <nav>
          {[
            ['home', 'Overview'],
            ['people', 'Clients'],
            ['portfolio', 'Portfolios'],
            ['inbox', 'Review'],
            ['document', 'Reports'],
            ['activity', 'Activity'],
          ].map(([icon, label], index) => (
            <button className={index === 0 ? 'is-active' : ''} key={label} type="button">
              <Icon name={icon as IconName} />
              {label}
              {label === 'Review' ? <em>7</em> : null}
            </button>
          ))}
        </nav>
        <button className="advisor-back" type="button" onClick={onBack}>
          <Icon name="arrow-right" /> Personal BetterTrack
        </button>
      </aside>
      <main className="advisor-main">
        <header className="advisor-topbar">
          <button
            type="button"
            onClick={() => setClient(client === 'All clients' ? 'Morgan household' : 'All clients')}
          >
            <span className="surface-kicker">CLIENT SCOPE</span>
            <strong>{client}</strong>
            <Icon name="chevron-down" size={14} />
          </button>
          <div>
            <button type="button">
              <Icon name="search" />
              Search clients, assets, or activity…<kbd>⌘ K</kbd>
            </button>
            <SurfaceButton variant="primary" icon="plus">
              Create
            </SurfaceButton>
            <SurfaceAvatar initials="AM" />
          </div>
        </header>
        <div className="advisor-content">
          <div className="admin-heading">
            <div>
              <span>MONDAY, 27 JULY</span>
              <h1>Your book of business</h1>
              <p>What changed across clients, what needs review, and what is upcoming.</p>
            </div>
            <div>
              <SurfaceButton variant="secondary" icon="sliders">
                Customize
              </SurfaceButton>
            </div>
          </div>
          <div className="advisor-kpis">
            {[
              ['Assets overseen', '€18.42M', '+€142K this month'],
              ['Households', '42', '38 fully synced'],
              ['Needs review', '7', '2 high priority'],
              ['Upcoming meetings', '5', 'Next today at 14:00'],
            ].map(([label, value, meta], index) => (
              <section key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
                <span className={index === 2 ? 'negative' : index === 0 ? 'positive' : ''}>
                  {meta}
                </span>
              </section>
            ))}
          </div>
          <div className="advisor-grid">
            <section className="advisor-card advisor-clients">
              <header>
                <div>
                  <h2>Client households</h2>
                  <p>Sorted by attention</p>
                </div>
                <button type="button">
                  View all <Icon name="arrow-right" size={12} />
                </button>
              </header>
              {[
                ['MH', 'Morgan household', '€1.84M', '+1.2%', '2 reviews', 'sand'],
                ['KB', 'Keller family', '€982K', '+0.8%', 'All clear', 'sage'],
                ['JL', 'Leitner GmbH', '€2.46M', '−0.3%', '1 review', 'blue'],
                ['LW', 'Wagner family', '€724K', '+1.6%', 'Meeting today', 'rose'],
              ].map(([initials, name, value, change, state, tone]) => (
                <button key={name} type="button">
                  <SurfaceAvatar
                    initials={initials!}
                    tone={tone as 'sand' | 'sage' | 'blue' | 'rose'}
                  />
                  <span>
                    <strong>{name}</strong>
                    <small>Updated recently</small>
                  </span>
                  <span>
                    <strong>{value}</strong>
                    <small className={String(change).startsWith('−') ? 'negative' : 'positive'}>
                      {change}
                    </small>
                  </span>
                  <em>{state}</em>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </section>
            <section className="advisor-card advisor-review">
              <header>
                <div>
                  <h2>Review queue</h2>
                  <p>7 items across 5 clients</p>
                </div>
              </header>
              {[
                ['red', 'Missing cost basis', 'Leitner GmbH · 3 holdings'],
                ['amber', 'Allocation drift above 5%', 'Morgan household · Growth'],
                ['blue', 'Client proposal ready', 'Wagner family · pension plan'],
                ['green', 'Annual report approved', 'Keller family · 2025'],
              ].map(([tone, title, copy]) => (
                <button key={title} type="button">
                  <i className={`admin-state admin-state--${tone}`} />
                  <span>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </span>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </section>
          </div>
          <section className="advisor-card advisor-meetings">
            <header>
              <div>
                <h2>Upcoming</h2>
                <p>Meetings, reports, capital calls, and client events</p>
              </div>
              <button type="button">
                Calendar <Icon name="calendar" size={13} />
              </button>
            </header>
            <div>
              {[
                ['Today · 14:00', 'Wagner family review', 'Portfolio plan · 45 min', 'LW', 'rose'],
                [
                  'Tomorrow',
                  'Morgan quarterly report',
                  'Auto-generated · needs approval',
                  'MH',
                  'sand',
                ],
                ['31 Jul', 'Northwind capital call', '€42,000 expected', 'NW', 'blue'],
                ['05 Aug', 'Keller goal checkpoint', 'Education fund', 'KB', 'sage'],
              ].map(([date, title, copy, initials, tone]) => (
                <button key={title} type="button">
                  <small>{date}</small>
                  <SurfaceAvatar
                    initials={initials!}
                    tone={tone as 'sand' | 'sage' | 'blue' | 'rose'}
                  />
                  <span>
                    <strong>{title}</strong>
                    <em>{copy}</em>
                  </span>
                  <Icon name="chevron-right" size={13} />
                </button>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

export function DemoMenu({
  current,
  direction,
  onSelect,
  onDirection,
  onClose,
  onReset,
}: {
  current: ProductSurface;
  direction: DesignDirection;
  onSelect: (surface: ProductSurface) => void;
  onDirection: (direction: DesignDirection) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const directions: Array<{
    id: DesignDirection;
    label: string;
    description: string;
    traits: string;
  }> = [
    {
      id: 'northstar',
      label: 'Northstar',
      description: 'Warm executive workspace',
      traits: 'BALANCED · DARK',
    },
    {
      id: 'ledger',
      label: 'Ledger',
      description: 'Editorial daylight system',
      traits: 'CALM · HORIZONTAL',
    },
    {
      id: 'signal',
      label: 'Signal',
      description: 'Precise operating console',
      traits: 'DENSE · FAST',
    },
    {
      id: 'atelier',
      label: 'Atelier',
      description: 'Private wealth office',
      traits: 'WARM · SPACIOUS',
    },
    {
      id: 'prism',
      label: 'Prism',
      description: 'Modern modular canvas',
      traits: 'BOLD · STRUCTURED',
    },
    {
      id: 'origin',
      label: 'Origin',
      description: 'Northstar × original BetterTrack',
      traits: 'DETAILED · CONTINUOUS',
    },
  ];
  const surfaces: Array<{
    id: ProductSurface;
    label: string;
    description: string;
    icon: IconName;
    badge?: string;
  }> = [
    {
      id: 'app',
      label: 'Personal suite',
      description: 'Connected portfolio workspace',
      icon: 'home',
      badge: 'Current',
    },
    {
      id: 'onboarding',
      label: 'First-run setup',
      description: 'Portfolio-first guided onboarding',
      icon: 'sparkles',
    },
    {
      id: 'auth',
      label: 'Authentication',
      description: 'Google, passkey, 2FA, and registration',
      icon: 'lock',
    },
    {
      id: 'advisor',
      label: 'Advisor workspace',
      description: 'Clients, approvals, and book of business',
      icon: 'briefcase',
    },
    {
      id: 'settings',
      label: 'Settings & security',
      description: 'Account, privacy, developer, and billing',
      icon: 'settings',
    },
    {
      id: 'public',
      label: 'Public share',
      description: 'Read-only portfolio presentation',
      icon: 'share',
    },
    {
      id: 'admin',
      label: 'Admin console',
      description: 'Operations, users, providers, and governance',
      icon: 'shield',
    },
  ];
  return (
    <div className="demo-menu-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="demo-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Preview modes"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="surface-kicker">BETTERTRACK DESIGN LAB</span>
            <h2>Preview the whole product</h2>
            <p>
              Change the complete visual direction or move between product surfaces. Local demo
              state stays intact.
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <section className="demo-direction-lab">
          <div>
            <span>
              <strong>Design direction</strong>
              <small>Six complete systems · same connected product model</small>
            </span>
            <em>
              {directions.findIndex((item) => item.id === direction) + 1} / {directions.length}
            </em>
          </div>
          <div className="demo-direction-grid">
            {directions.map((item) => (
              <button
                aria-label={`${item.label}: ${item.description}`}
                className={direction === item.id ? 'is-active' : ''}
                key={item.id}
                onClick={() => onDirection(item.id)}
                type="button"
              >
                <span className={`direction-preview direction-preview--${item.id}`}>
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
                <em>{item.traits}</em>
              </button>
            ))}
          </div>
        </section>
        <div className="demo-surface-label">
          <strong>Product surfaces</strong>
          <small>Role, setup, sharing, and operational states</small>
        </div>
        <div className="demo-menu__grid">
          {surfaces.map((surface) => (
            <button
              className={current === surface.id ? 'is-active' : ''}
              key={surface.id}
              onClick={() => onSelect(surface.id)}
              type="button"
            >
              <span>
                <Icon name={surface.icon} />
              </span>
              <span>
                <strong>{surface.label}</strong>
                <small>{surface.description}</small>
              </span>
              {surface.badge && current === surface.id ? (
                <em>{surface.badge}</em>
              ) : (
                <Icon name="arrow-right" size={14} />
              )}
            </button>
          ))}
        </div>
        <footer>
          <button type="button" onClick={onReset}>
            <Icon name="refresh" size={14} /> Reset all demo data
          </button>
          <span>Everything is simulated locally.</span>
        </footer>
      </section>
    </div>
  );
}

export function PreviewDock({
  surface,
  onSelect,
}: {
  surface: ProductSurface;
  onSelect: (surface: ProductSurface) => void;
}) {
  return (
    <button className="preview-dock" type="button" onClick={() => onSelect('app')}>
      <span>
        <Icon name="grid" size={15} />
      </span>
      <span>
        <small>PREVIEWING</small>
        <strong>
          {surface === 'auth'
            ? 'Authentication'
            : surface === 'onboarding'
              ? 'Onboarding'
              : surface === 'public'
                ? 'Public share'
                : surface === 'settings'
                  ? 'Settings'
                  : surface === 'advisor'
                    ? 'Advisor'
                    : 'Admin'}
        </strong>
      </span>
      <span>
        Back to suite <Icon name="arrow-right" size={13} />
      </span>
    </button>
  );
}
