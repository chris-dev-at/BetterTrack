import { type ReactNode, useMemo, useState } from 'react';

import { Icon, type IconName } from './Icons';

export type OriginSharePortfolio = {
  id?: string;
  name: string;
  owner?: string;
  value?: number;
  currency?: string;
};

export type OriginShareRole = 'owner' | 'admin' | 'editor' | 'proposer' | 'viewer' | 'accountant';

export type OriginShareResult = {
  id: string;
  portfolio: {
    id?: string;
    name: string;
  };
  kind: 'collaboration' | 'private-link';
  status: 'active' | 'revoked';
  recipient: {
    email?: string;
    name?: string;
    audience?: 'named-recipient' | 'workspace-members' | 'anyone-with-passcode';
    message?: string;
  };
  access: {
    role: OriginShareRole;
    permissions: string[];
    maskedFields: string[];
    approvalPolicy: 'role-default' | 'owner-approval' | 'two-person' | 'proposal-only';
  };
  security: {
    expiresAt: string | null;
    passcodeRequired: boolean;
    link?: string;
    accessCode?: string;
  };
  receipt: {
    createdAt: string;
    createdBy: string;
    dataHome: OriginShareDataHome;
    revocationId: string;
    auditReference: string;
  };
};

export type OriginShareDataHome = 'hosted' | 'drive' | 'drive-only' | 'local';

export type OriginShareFlowProps = {
  portfolio: OriginSharePortfolio | string;
  dataHome?: OriginShareDataHome;
  onClose: () => void;
  onComplete: (result: OriginShareResult) => void;
};

type Stage = 'kind' | 'recipient' | 'role' | 'masking' | 'policy' | 'preview' | 'receipt';
type ShareKind = OriginShareResult['kind'];
type Audience = NonNullable<OriginShareResult['recipient']['audience']>;
type Expiry = '24h' | '7d' | '30d' | '90d' | 'never' | 'custom';
type MaskField =
  | 'total-value'
  | 'cost-basis'
  | 'returns'
  | 'transactions'
  | 'cash-flows'
  | 'documents'
  | 'personal-labels';
type ApprovalPolicy = OriginShareResult['access']['approvalPolicy'];

type ShareDraft = {
  stage: Stage;
  kind: ShareKind | '';
  email: string;
  recipientName: string;
  audience: Audience;
  message: string;
  role: OriginShareRole;
  transferConfirmed: boolean;
  masks: MaskField[];
  expiry: Expiry;
  customExpiry: string;
  passcode: boolean;
  approval: ApprovalPolicy;
};

const stages: Array<{ id: Stage; label: string }> = [
  { id: 'kind', label: 'Share type' },
  { id: 'recipient', label: 'Recipient' },
  { id: 'role', label: 'Access' },
  { id: 'masking', label: 'Privacy' },
  { id: 'policy', label: 'Controls' },
  { id: 'preview', label: 'Preview' },
  { id: 'receipt', label: 'Complete' },
];

const roleMeta: Record<
  OriginShareRole,
  {
    label: string;
    icon: IconName;
    summary: string;
    detail: string;
    permissions: string[];
    risk: 'high' | 'medium' | 'low';
  }
> = {
  owner: {
    label: 'Owner',
    icon: 'key',
    summary: 'Full custody and control',
    detail:
      'Can transfer ownership, delete the portfolio, manage billing and control every person.',
    permissions: [
      'View all financial data',
      'Edit holdings and transactions',
      'Run imports and integrations',
      'Manage people and permissions',
      'Transfer or delete portfolio',
    ],
    risk: 'high',
  },
  admin: {
    label: 'Administrator',
    icon: 'shield',
    summary: 'Manage data and people',
    detail: 'Can edit everything and manage access, but cannot transfer ownership or delete.',
    permissions: [
      'View all financial data',
      'Edit holdings and transactions',
      'Run imports and integrations',
      'Manage people and permissions',
    ],
    risk: 'high',
  },
  editor: {
    label: 'Editor',
    icon: 'sliders',
    summary: 'Maintain the portfolio',
    detail: 'Can add and correct data, create plans and resolve review items.',
    permissions: [
      'View permitted financial data',
      'Edit holdings and transactions',
      'Run imports',
      'Create and apply scenarios',
    ],
    risk: 'medium',
  },
  proposer: {
    label: 'Proposer',
    icon: 'workbench',
    summary: 'Suggest, never apply directly',
    detail: 'Can research, build scenarios and submit structured changes for review.',
    permissions: [
      'View permitted financial data',
      'Create scenarios and forecasts',
      'Submit change proposals',
      'Comment on review items',
    ],
    risk: 'low',
  },
  viewer: {
    label: 'Viewer',
    icon: 'eye',
    summary: 'Read-only portfolio access',
    detail: 'Can explore the permitted views but cannot change, export or connect anything.',
    permissions: ['View permitted financial data', 'Open asset detail', 'View approved notes'],
    risk: 'low',
  },
  accountant: {
    label: 'Accountant',
    icon: 'document',
    summary: 'Books, transactions and tax',
    detail: 'Focused read and export access for reconciliation and reporting.',
    permissions: [
      'View transactions and cash flows',
      'View cost basis and tax lots',
      'Open approved documents',
      'Export tax and transaction reports',
    ],
    risk: 'low',
  },
};

const maskMeta: Record<
  MaskField,
  { label: string; detail: string; icon: IconName; example: string }
> = {
  'total-value': {
    label: 'Portfolio value',
    detail: 'Hide totals and absolute holding values.',
    icon: 'wallet',
    example: '€128,430',
  },
  'cost-basis': {
    label: 'Cost basis',
    detail: 'Hide purchase prices and unrealized profit.',
    icon: 'activity',
    example: '€96,242',
  },
  returns: {
    label: 'Performance & returns',
    detail: 'Hide gain amounts, percentages and history.',
    icon: 'assets',
    example: '+18.3%',
  },
  transactions: {
    label: 'Transaction history',
    detail: 'Hide trades, transfers, income and expenses.',
    icon: 'repeat',
    example: '847 records',
  },
  'cash-flows': {
    label: 'Cash flows',
    detail: 'Hide recurring income, expenses and forecasts.',
    icon: 'cash',
    example: '€2,900/mo',
  },
  documents: {
    label: 'Documents & notes',
    detail: 'Hide statements, tax files and private notes.',
    icon: 'document',
    example: '23 files',
  },
  'personal-labels': {
    label: 'Personal names & labels',
    detail: 'Replace owners, account labels and custom notes.',
    icon: 'people',
    example: 'Family reserve',
  },
};

const initialDraft: ShareDraft = {
  stage: 'kind',
  kind: '',
  email: '',
  recipientName: '',
  audience: 'named-recipient',
  message: '',
  role: 'viewer',
  transferConfirmed: false,
  masks: ['documents', 'personal-labels'],
  expiry: '30d',
  customExpiry: '',
  passcode: true,
  approval: 'role-default',
};

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
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
    <button className={cn('osf-button', `osf-button--${kind}`)} type="button" {...props}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

function StageHeading({
  kicker,
  title,
  copy,
  aside,
}: {
  kicker: string;
  title: string;
  copy: string;
  aside?: ReactNode;
}) {
  return (
    <div className="osf-stage-heading">
      <div>
        <span>{kicker}</span>
        <h2>{title}</h2>
        <p>{copy}</p>
      </div>
      {aside}
    </div>
  );
}

function formatPortfolio(portfolio: OriginShareFlowProps['portfolio']): OriginSharePortfolio {
  return typeof portfolio === 'string'
    ? { name: portfolio, owner: 'Alex Morgan', value: 128430.2, currency: 'EUR' }
    : {
        owner: 'Alex Morgan',
        value: 128430.2,
        currency: 'EUR',
        ...portfolio,
      };
}

function getExpiry(expiry: Expiry, custom: string) {
  if (expiry === 'never') return null;
  if (expiry === 'custom') {
    const date = new Date(`${custom}T23:59:59`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const duration = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
  }[expiry];
  return new Date(Date.now() + duration * 86400000).toISOString();
}

function futureDate(days: number) {
  const date = new Date(Date.now() + days * 86400000);
  return date.toISOString().slice(0, 10);
}

function buildReference(prefix: string) {
  const stamp = Date.now().toString(36).toUpperCase();
  return `${prefix}-${stamp.slice(-7)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export function OriginShareFlow({
  portfolio: portfolioInput,
  dataHome = 'hosted',
  onClose,
  onComplete,
}: OriginShareFlowProps) {
  const portfolio = useMemo(() => formatPortfolio(portfolioInput), [portfolioInput]);
  const [draft, setDraft] = useState<ShareDraft>(initialDraft);
  const [error, setError] = useState('');
  const [result, setResult] = useState<OriginShareResult | null>(null);
  const [copied, setCopied] = useState<'link' | 'invite' | 'code' | ''>('');
  const [revokeConfirm, setRevokeConfirm] = useState(false);

  const currentIndex = stages.findIndex((stage) => stage.id === draft.stage);
  const linksAllowed = dataHome === 'hosted';
  const directSyncCopy =
    dataHome === 'hosted'
      ? 'The recipient gets permission-scoped access to this live portfolio.'
      : dataHome === 'drive' || dataHome === 'drive-only'
        ? 'The invitation is hosted securely; portfolio updates synchronize from your Drive data home.'
        : 'The invitation is hosted securely; updates synchronize while your local BetterTrack app is online.';

  function update(patch: Partial<ShareDraft>) {
    setDraft((previous) => ({ ...previous, ...patch }));
    setError('');
  }

  function selectKind(kind: ShareKind) {
    if (kind === 'private-link' && !linksAllowed) return;
    update({
      kind,
      role: kind === 'private-link' ? 'viewer' : draft.role,
      audience: kind === 'private-link' ? 'named-recipient' : draft.audience,
      expiry: kind === 'private-link' ? '30d' : 'never',
      passcode: kind === 'private-link',
      approval: kind === 'private-link' ? 'proposal-only' : draft.approval,
      masks:
        kind === 'private-link' && !draft.masks.length
          ? ['documents', 'personal-labels']
          : draft.masks,
    });
  }

  function selectRole(role: OriginShareRole) {
    const highAccess = role === 'owner' || role === 'admin';
    update({
      role,
      transferConfirmed: role === 'owner' ? false : draft.transferConfirmed,
      masks: highAccess
        ? []
        : role === 'accountant'
          ? draft.masks.filter((mask) => mask !== 'transactions' && mask !== 'cost-basis')
          : draft.masks,
      approval:
        role === 'proposer' || role === 'viewer' || role === 'accountant'
          ? 'proposal-only'
          : draft.approval === 'proposal-only'
            ? 'role-default'
            : draft.approval,
    });
  }

  function validate() {
    switch (draft.stage) {
      case 'kind':
        return draft.kind ? '' : 'Choose collaboration or a private view link.';
      case 'recipient':
        if (
          (draft.kind === 'collaboration' || draft.audience === 'named-recipient') &&
          !/^\S+@\S+\.\S+$/.test(draft.email)
        )
          return 'Enter a valid recipient email.';
        return '';
      case 'role':
        if (draft.role === 'owner' && !draft.transferConfirmed)
          return 'Confirm the ownership transfer before continuing.';
        return '';
      case 'policy':
        if (draft.expiry === 'custom' && !draft.customExpiry)
          return 'Choose a custom expiration date.';
        if (
          draft.expiry === 'custom' &&
          new Date(`${draft.customExpiry}T23:59:59`).getTime() <= Date.now()
        )
          return 'Expiration must be in the future.';
        return '';
      default:
        return '';
    }
  }

  function next() {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    const nextStage = stages[currentIndex + 1];
    if (nextStage) update({ stage: nextStage.id });
  }

  function back() {
    const previous = stages[currentIndex - 1];
    if (previous) update({ stage: previous.id });
  }

  function toggleMask(field: MaskField) {
    if (draft.role === 'owner' || draft.role === 'admin') return;
    if (draft.role === 'accountant' && (field === 'transactions' || field === 'cost-basis')) return;
    update({
      masks: draft.masks.includes(field)
        ? draft.masks.filter((mask) => mask !== field)
        : [...draft.masks, field],
    });
  }

  function createAccess() {
    const id = buildReference(draft.kind === 'private-link' ? 'LINK' : 'INV');
    const accessCode = draft.kind === 'private-link' && draft.passcode ? '842 619' : undefined;
    const shareResult: OriginShareResult = {
      id,
      portfolio: { id: portfolio.id, name: portfolio.name },
      kind: draft.kind || 'collaboration',
      status: 'active',
      recipient: {
        email: draft.email || undefined,
        name: draft.recipientName || undefined,
        audience: draft.kind === 'private-link' ? draft.audience : 'named-recipient',
        message: draft.message.trim() || undefined,
      },
      access: {
        role: draft.role,
        permissions: roleMeta[draft.role].permissions,
        maskedFields: draft.masks,
        approvalPolicy: draft.approval,
      },
      security: {
        expiresAt: getExpiry(draft.expiry, draft.customExpiry),
        passcodeRequired: draft.kind === 'private-link' && draft.passcode,
        link:
          draft.kind === 'private-link'
            ? `https://share.bettertrack.app/p/${id.toLowerCase()}`
            : `https://app.bettertrack.io/invite/${id.toLowerCase()}`,
        accessCode,
      },
      receipt: {
        createdAt: new Date().toISOString(),
        createdBy: portfolio.owner || 'Portfolio owner',
        dataHome,
        revocationId: buildReference('RVK'),
        auditReference: buildReference('AUD'),
      },
    };
    setResult(shareResult);
    update({ stage: 'receipt' });
  }

  async function copy(value: string, target: 'link' | 'invite' | 'code') {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement('textarea');
      input.value = value;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    setCopied(target);
    window.setTimeout(() => setCopied(''), 1500);
  }

  function revoke() {
    if (!result) return;
    if (!revokeConfirm) {
      setRevokeConfirm(true);
      return;
    }
    setResult({ ...result, status: 'revoked' });
    setRevokeConfirm(false);
  }

  function finish() {
    if (result) onComplete(result);
  }

  return (
    <div className="origin-share-flow" role="dialog" aria-modal="true" aria-label="Share portfolio">
      <div className="osf-backdrop" onClick={onClose} />
      <section className="osf-shell">
        <header className="osf-header">
          <div className="osf-brand">
            <span className="osf-brand__mark" />
            <span>
              <small>Share from</small>
              <strong>{portfolio.name}</strong>
            </span>
          </div>
          <div className="osf-header__security">
            <Icon name="shield" size={14} />
            Permission scoped
          </div>
          <button aria-label="Close sharing" className="osf-close" onClick={onClose} type="button">
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="osf-body">
          <aside className="osf-steps">
            <div>
              <span>Portfolio access</span>
              <h1>Share with intent.</h1>
              <p>Decide who sees what, what they can do and when their access should end.</p>
            </div>
            <nav aria-label="Sharing progress">
              {stages.map((stage, index) => (
                <button
                  className={cn(
                    index === currentIndex && 'is-current',
                    index < currentIndex && 'is-complete',
                  )}
                  disabled={index > currentIndex || draft.stage === 'receipt'}
                  key={stage.id}
                  onClick={() => index < currentIndex && update({ stage: stage.id })}
                  type="button"
                >
                  <i>{index < currentIndex ? <Icon name="check" size={11} /> : index + 1}</i>
                  <span>{stage.label}</span>
                </button>
              ))}
            </nav>
            <div className="osf-context-card">
              <span className="osf-context-card__avatar">
                {portfolio.name.slice(0, 2).toUpperCase()}
              </span>
              <span>
                <small>{portfolio.currency || 'EUR'} portfolio</small>
                <strong>{portfolio.name}</strong>
                <em>{portfolio.owner || 'Portfolio owner'}</em>
              </span>
              <Icon name="lock" size={15} />
            </div>
          </aside>

          <main className="osf-stage">
            {draft.stage === 'kind' ? (
              <>
                <StageHeading
                  copy="Collaboration gives a known person an account and an audit trail. A view link is a deliberately limited snapshot."
                  kicker="Choose the access model"
                  title="How do you want to share?"
                />
                <div className="osf-kind-grid">
                  <button
                    className={cn('osf-kind-card', draft.kind === 'collaboration' && 'is-active')}
                    onClick={() => selectKind('collaboration')}
                    type="button"
                  >
                    <span className="osf-kind-card__icon">
                      <Icon name="user-plus" size={23} />
                    </span>
                    <em>Recommended for ongoing work</em>
                    <h3>Invite a collaborator</h3>
                    <p>{directSyncCopy}</p>
                    <ul>
                      <li>
                        <Icon name="check" size={13} /> Verified BetterTrack account
                      </li>
                      <li>
                        <Icon name="check" size={13} /> Six purpose-built roles
                      </li>
                      <li>
                        <Icon name="check" size={13} /> Comments, proposals and change history
                      </li>
                    </ul>
                    <i className="osf-card-check">
                      {draft.kind === 'collaboration' ? <Icon name="check" size={14} /> : null}
                    </i>
                  </button>
                  <button
                    className={cn(
                      'osf-kind-card',
                      draft.kind === 'private-link' && 'is-active',
                      !linksAllowed && 'is-disabled',
                    )}
                    disabled={!linksAllowed}
                    onClick={() => selectKind('private-link')}
                    type="button"
                  >
                    <span className="osf-kind-card__icon">
                      <Icon name="link" size={23} />
                    </span>
                    <em>For a clean read-only view</em>
                    <h3>Create a private view link</h3>
                    <p>
                      Share a controlled presentation without giving someone a complete workspace.
                    </p>
                    <ul>
                      <li>
                        <Icon name="check" size={13} /> Optional identity check and passcode
                      </li>
                      <li>
                        <Icon name="check" size={13} /> Expiring and immediately revocable
                      </li>
                      <li>
                        <Icon name="check" size={13} /> Search engines are always blocked
                      </li>
                    </ul>
                    <i className="osf-card-check">
                      {draft.kind === 'private-link' ? <Icon name="check" size={14} /> : null}
                    </i>
                  </button>
                </div>
                {!linksAllowed ? (
                  <div className="osf-data-home-warning">
                    <Icon name={dataHome === 'local' ? 'monitor' : 'folder'} size={18} />
                    <span>
                      <strong>Private view links need a hosted access boundary</strong>
                      {dataHome === 'local'
                        ? 'Your portfolio currently lives only on this device, so BetterTrack cannot serve a reliable link while it is offline.'
                        : 'Your Drive is the only data home. BetterTrack will not silently copy it into a public-facing hosted view.'}{' '}
                      Direct collaboration remains available because every recipient is identified,
                      scoped and logged.
                    </span>
                  </div>
                ) : null}
              </>
            ) : null}

            {draft.stage === 'recipient' ? <RecipientStage draft={draft} update={update} /> : null}

            {draft.stage === 'role' ? (
              <RoleStage draft={draft} selectRole={selectRole} update={update} />
            ) : null}

            {draft.stage === 'masking' ? (
              <MaskingStage draft={draft} toggleMask={toggleMask} />
            ) : null}

            {draft.stage === 'policy' ? <PolicyStage draft={draft} update={update} /> : null}

            {draft.stage === 'preview' ? (
              <PreviewStage draft={draft} portfolio={portfolio} />
            ) : null}

            {draft.stage === 'receipt' && result ? (
              <ReceiptStage
                copied={copied}
                onCopy={copy}
                onRevoke={revoke}
                result={result}
                revokeConfirm={revokeConfirm}
              />
            ) : null}

            {draft.stage !== 'receipt' ? (
              <footer className="osf-actions">
                <Button
                  icon="arrow-right"
                  kind="ghost"
                  onClick={currentIndex === 0 ? onClose : back}
                >
                  {currentIndex === 0 ? 'Cancel' : 'Back'}
                </Button>
                <div>
                  {error ? (
                    <span className="osf-error" role="alert">
                      <Icon name="activity" size={14} />
                      {error}
                    </span>
                  ) : (
                    <small>
                      {draft.stage === 'preview'
                        ? 'Nothing is shared until you create access'
                        : 'You can change these controls later'}
                    </small>
                  )}
                  <Button
                    icon={draft.stage === 'preview' ? 'share' : 'arrow-right'}
                    kind="primary"
                    onClick={draft.stage === 'preview' ? createAccess : next}
                  >
                    {draft.stage === 'preview'
                      ? draft.kind === 'private-link'
                        ? 'Create private link'
                        : 'Send invitation'
                      : 'Continue'}
                  </Button>
                </div>
              </footer>
            ) : (
              <footer className="osf-actions osf-actions--receipt">
                <span>
                  <Icon name="check" size={14} />
                  Access controls are active
                </span>
                <Button icon="arrow-right" kind="primary" onClick={finish}>
                  Done
                </Button>
              </footer>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}

function RecipientStage({
  draft,
  update,
}: {
  draft: ShareDraft;
  update: (patch: Partial<ShareDraft>) => void;
}) {
  const isLink = draft.kind === 'private-link';
  return (
    <>
      <StageHeading
        copy={
          isLink
            ? 'Choose whether the viewer must verify their identity or can open the link with its separate passcode.'
            : 'The invitation is bound to one verified account. Email is only used to deliver and identify it.'
        }
        kicker={isLink ? 'Link audience' : 'Direct collaboration'}
        title={isLink ? 'Who may open this view?' : 'Who are you inviting?'}
      />
      {isLink ? (
        <div className="osf-audience-grid">
          {[
            [
              'named-recipient',
              'user-plus',
              'One named recipient',
              'Email verification plus the link and passcode.',
              'Most private',
            ],
            [
              'workspace-members',
              'people',
              'Current workspace members',
              'Anyone already verified in this BetterTrack workspace.',
              'Team access',
            ],
            [
              'anyone-with-passcode',
              'globe',
              'Anyone with link + passcode',
              'No account required. Access is logged as an anonymous session.',
              'Easiest',
            ],
          ].map(([audience, icon, title, copy, tag]) => (
            <button
              className={cn('osf-audience-card', draft.audience === audience && 'is-active')}
              key={audience}
              onClick={() => update({ audience: audience as Audience })}
              type="button"
            >
              <Icon name={icon as IconName} size={19} />
              <strong>{title}</strong>
              <p>{copy}</p>
              <em>{tag}</em>
            </button>
          ))}
        </div>
      ) : null}
      <div className="osf-recipient-form">
        {(!isLink || draft.audience === 'named-recipient') && (
          <>
            <label>
              <span>
                Email address <small>Required</small>
              </span>
              <div>
                <Icon name="message" size={16} />
                <input
                  autoFocus
                  onChange={(event) => update({ email: event.target.value })}
                  placeholder="person@example.com"
                  type="email"
                  value={draft.email}
                />
                {/^\S+@\S+\.\S+$/.test(draft.email) ? <Icon name="check" size={15} /> : null}
              </div>
            </label>
            <label>
              <span>
                Name <small>Optional</small>
              </span>
              <div>
                <Icon name="people" size={16} />
                <input
                  onChange={(event) => update({ recipientName: event.target.value })}
                  placeholder="Jamie Lee"
                  value={draft.recipientName}
                />
              </div>
            </label>
          </>
        )}
        <label className="osf-message-field">
          <span>
            Personal message <small>Optional</small>
          </span>
          <textarea
            maxLength={240}
            onChange={(event) => update({ message: event.target.value })}
            placeholder={
              isLink
                ? 'Here is the portfolio view we discussed…'
                : 'I am inviting you to work with me on this portfolio…'
            }
            value={draft.message}
          />
          <em>{draft.message.length}/240</em>
        </label>
      </div>
      <div className="osf-delivery-note">
        <span>
          <Icon name="shield" size={17} />
        </span>
        <p>
          <strong>
            {isLink ? 'The passcode is delivered separately' : 'The recipient must accept'}
          </strong>
          {isLink
            ? 'BetterTrack never includes the private link and passcode in the same email.'
            : 'Access starts only after the invited email signs in and accepts the exact role and privacy scope.'}
        </p>
      </div>
    </>
  );
}

function RoleStage({
  draft,
  selectRole,
  update,
}: {
  draft: ShareDraft;
  selectRole: (role: OriginShareRole) => void;
  update: (patch: Partial<ShareDraft>) => void;
}) {
  const isLink = draft.kind === 'private-link';
  const availableRoles: OriginShareRole[] = isLink
    ? ['viewer', 'accountant']
    : ['owner', 'admin', 'editor', 'proposer', 'viewer', 'accountant'];
  const selected = roleMeta[draft.role];
  return (
    <>
      <StageHeading
        copy={
          isLink
            ? 'A private link can expose a general read-only view or a books-and-tax-focused view. It can never edit.'
            : 'Roles are explicit starting points. Privacy masking and approval rules add another layer next.'
        }
        kicker="Role and capability"
        title="What should they be able to do?"
      />
      <div className="osf-role-layout">
        <div className="osf-role-list">
          {availableRoles.map((role) => {
            const meta = roleMeta[role];
            return (
              <button
                className={cn(
                  'osf-role-item',
                  draft.role === role && 'is-active',
                  meta.risk === 'high' && 'is-sensitive',
                )}
                key={role}
                onClick={() => selectRole(role)}
                type="button"
              >
                <span>
                  <Icon name={meta.icon} size={18} />
                </span>
                <i>
                  <strong>{meta.label}</strong>
                  <small>{meta.summary}</small>
                </i>
                {meta.risk === 'high' ? <em>Powerful</em> : null}
                <b>{draft.role === role ? <Icon name="check" size={13} /> : null}</b>
              </button>
            );
          })}
        </div>
        <aside className="osf-role-detail">
          <div className="osf-role-detail__head">
            <span>
              <Icon name={selected.icon} size={21} />
            </span>
            <div>
              <small>Selected role</small>
              <h3>{selected.label}</h3>
            </div>
          </div>
          <p>{selected.detail}</p>
          <ul>
            {selected.permissions.map((permission) => (
              <li key={permission}>
                <Icon name="check" size={13} />
                {permission}
              </li>
            ))}
          </ul>
          {draft.role === 'owner' ? (
            <button
              className={cn('osf-transfer-confirm', draft.transferConfirmed && 'is-active')}
              onClick={() => update({ transferConfirmed: !draft.transferConfirmed })}
              type="button"
            >
              <i>{draft.transferConfirmed ? <Icon name="check" size={12} /> : null}</i>
              <span>
                <strong>I understand this transfers ownership</strong>
                You become an administrator after the recipient accepts. They can later remove your
                access.
              </span>
            </button>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function MaskingStage({
  draft,
  toggleMask,
}: {
  draft: ShareDraft;
  toggleMask: (field: MaskField) => void;
}) {
  const masksDisabled = draft.role === 'owner' || draft.role === 'admin';
  return (
    <>
      <StageHeading
        aside={
          <div className="osf-mask-counter">
            <strong>{draft.masks.length}</strong>
            <small>fields hidden</small>
          </div>
        }
        copy="Their role determines what actions are possible. Masking independently decides which financial fields exist in their view."
        kicker="Field-level privacy"
        title="Hide what they do not need."
      />
      {masksDisabled ? (
        <div className="osf-mask-warning">
          <Icon name="shield" size={18} />
          <span>
            <strong>{roleMeta[draft.role].label} access cannot be meaningfully masked</strong>
            This role can manage portfolio data and would be able to reveal or reconstruct masked
            fields. Choose Editor or a read-oriented role if you need privacy boundaries.
          </span>
        </div>
      ) : null}
      <div className={cn('osf-mask-grid', masksDisabled && 'is-disabled')}>
        {(Object.keys(maskMeta) as MaskField[]).map((field) => {
          const meta = maskMeta[field];
          const active = draft.masks.includes(field);
          const requiredForRole =
            draft.role === 'accountant' && (field === 'transactions' || field === 'cost-basis');
          return (
            <button
              className={cn(active && 'is-masked', requiredForRole && 'is-required')}
              disabled={masksDisabled || requiredForRole}
              key={field}
              onClick={() => toggleMask(field)}
              type="button"
            >
              <span>
                <Icon name={meta.icon} size={17} />
              </span>
              <i>
                <strong>{meta.label}</strong>
                <small>{meta.detail}</small>
              </i>
              <em className={active ? 'is-blurred' : ''}>{meta.example}</em>
              <b>{requiredForRole ? 'Role requires' : active ? 'Hidden' : 'Visible'}</b>
            </button>
          );
        })}
      </div>
      <div className="osf-mask-principle">
        <Icon name="eye-off" size={17} />
        <span>
          <strong>Masking applies everywhere</strong>
          Home, charts, tables, exports, notifications and API responses all receive the same
          permission-filtered representation.
        </span>
      </div>
    </>
  );
}

function PolicyStage({
  draft,
  update,
}: {
  draft: ShareDraft;
  update: (patch: Partial<ShareDraft>) => void;
}) {
  const canChange = draft.role === 'owner' || draft.role === 'admin' || draft.role === 'editor';
  const expiryOptions: Array<[Expiry, string, string]> = [
    ['24h', '24 hours', 'One-time review'],
    ['7d', '7 days', 'Short project'],
    ['30d', '30 days', 'Monthly review'],
    ['90d', '90 days', 'Quarterly access'],
    ['never', 'No expiry', 'Until revoked'],
    ['custom', 'Custom', 'Choose a date'],
  ];
  return (
    <>
      <StageHeading
        copy="Time limits, identity checks and approval rules remain enforceable even if the recipient bookmarks a page or saves a notification."
        kicker="Safety controls"
        title="Define the boundaries."
      />
      <div className="osf-policy-layout">
        <section>
          <span className="osf-section-label">Access expiration</span>
          <div className="osf-expiry-grid">
            {expiryOptions.map(([expiry, label, copy]) => (
              <button
                className={cn(draft.expiry === expiry && 'is-active')}
                key={expiry}
                onClick={() => update({ expiry })}
                type="button"
              >
                <strong>{label}</strong>
                <small>{copy}</small>
              </button>
            ))}
          </div>
          {draft.expiry === 'custom' ? (
            <label className="osf-custom-date">
              Access ends after
              <input
                min={futureDate(1)}
                onChange={(event) => update({ customExpiry: event.target.value })}
                type="date"
                value={draft.customExpiry}
              />
            </label>
          ) : null}
          {draft.kind === 'private-link' ? (
            <button
              className="osf-passcode-toggle"
              onClick={() => update({ passcode: !draft.passcode })}
              type="button"
            >
              <span>
                <Icon name="key" size={17} />
                <i>
                  <strong>Require a separate passcode</strong>
                  <small>Generated after the link is created.</small>
                </i>
              </span>
              <b className={cn(draft.passcode && 'is-on')}>
                <i />
              </b>
            </button>
          ) : null}
        </section>
        <section>
          <span className="osf-section-label">Change approval</span>
          <div className="osf-approval-list">
            {[
              [
                'role-default',
                'Role can apply allowed changes',
                canChange
                  ? 'Actions covered by the role are immediately recorded.'
                  : 'This role is read-oriented and cannot directly change data.',
                'activity',
              ],
              [
                'owner-approval',
                'Owner approves material changes',
                'Routine notes are direct; transactions, imports and automation wait for approval.',
                'check',
              ],
              [
                'two-person',
                'Two-person approval',
                'Two eligible reviewers must approve every material portfolio change.',
                'people',
              ],
              [
                'proposal-only',
                'Everything becomes a proposal',
                'The recipient can prepare work, but only an owner or admin can apply it.',
                'inbox',
              ],
            ].map(([policy, title, copy, icon]) => {
              const disabled =
                !canChange && policy !== 'proposal-only' && policy !== 'role-default';
              return (
                <button
                  className={cn(
                    draft.approval === policy && 'is-active',
                    disabled && 'is-disabled',
                  )}
                  disabled={disabled}
                  key={policy}
                  onClick={() => update({ approval: policy as ApprovalPolicy })}
                  type="button"
                >
                  <span>
                    <Icon name={icon as IconName} size={17} />
                  </span>
                  <i>
                    <strong>{title}</strong>
                    <small>{copy}</small>
                  </i>
                  <b>{draft.approval === policy ? <Icon name="check" size={12} /> : null}</b>
                </button>
              );
            })}
          </div>
        </section>
      </div>
      <div className="osf-policy-note">
        <Icon name="bell" size={16} />
        Owners and administrators are notified before expiration and immediately after a permission
        change, failed identity check or revocation.
      </div>
    </>
  );
}

function PreviewStage({
  draft,
  portfolio,
}: {
  draft: ShareDraft;
  portfolio: OriginSharePortfolio;
}) {
  const masked = (field: MaskField) => draft.masks.includes(field);
  const selectedRole = roleMeta[draft.role];
  const expiry = getExpiry(draft.expiry, draft.customExpiry);
  return (
    <>
      <StageHeading
        aside={
          <div className="osf-preview-person">
            <span>{(draft.recipientName || draft.email || 'Guest').slice(0, 2).toUpperCase()}</span>
            <i>
              <small>Previewing as</small>
              <strong>{draft.recipientName || draft.email || 'Private guest'}</strong>
            </i>
          </div>
        }
        copy="This is the permission-filtered portfolio—not a decorative mock. Masked fields, navigation and actions disappear at the data boundary."
        kicker="Recipient preview"
        title="See exactly what they will see."
      />
      <div className="osf-preview-frame">
        <div className="osf-preview-frame__bar">
          <span className="osf-mini-brand">
            <i />
            Better<strong>Track</strong>
          </span>
          <span>
            <Icon name="lock" size={12} />
            {draft.kind === 'private-link' ? 'Private view' : `${selectedRole.label} access`}
          </span>
          <i>
            <b />
            <b />
            <b />
          </i>
        </div>
        <div className="osf-preview-frame__body">
          <aside>
            {['Overview', 'Holdings', 'Transactions', 'Tax', 'People'].map((item, index) => {
              const hidden =
                (item === 'Transactions' && masked('transactions')) ||
                (item === 'Tax' &&
                  (masked('transactions') ||
                    (draft.role !== 'accountant' && draft.kind === 'private-link'))) ||
                (item === 'People' && draft.role !== 'owner' && draft.role !== 'admin');
              if (hidden) return null;
              return (
                <span className={index === 0 ? 'is-active' : ''} key={item}>
                  {item}
                </span>
              );
            })}
          </aside>
          <main>
            <div className="osf-preview-title">
              <span>
                <small>{portfolio.currency || 'EUR'} portfolio</small>
                <strong>{portfolio.name}</strong>
              </span>
              {draft.kind === 'private-link' ? (
                <em>Viewing only</em>
              ) : draft.role === 'proposer' ? (
                <button type="button">Create proposal</button>
              ) : draft.role === 'editor' || draft.role === 'admin' || draft.role === 'owner' ? (
                <button type="button">Add transaction</button>
              ) : null}
            </div>
            <div className="osf-preview-value">
              <small>Total value</small>
              <h3 className={masked('total-value') ? 'is-masked' : ''}>
                {portfolio.currency || 'EUR'}{' '}
                {(portfolio.value || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}
              </h3>
              <span className={masked('returns') ? 'is-masked' : ''}>+18.27% all time</span>
            </div>
            <div className={cn('osf-preview-chart', masked('returns') && 'is-masked')}>
              <svg preserveAspectRatio="none" viewBox="0 0 700 180">
                <defs>
                  <linearGradient id="osf-preview-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="#38bdf8" stopOpacity=".2" />
                    <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M0 154 L24 149 L48 152 L72 140 L96 145 L120 131 L144 136 L168 116 L192 121 L216 109 L240 114 L264 92 L288 97 L312 83 L336 87 L360 73 L384 80 L408 62 L432 69 L456 52 L480 57 L504 39 L528 44 L552 31 L576 38 L600 22 L624 28 L648 17 L676 23 L700 9 L700 180 L0 180Z"
                  fill="url(#osf-preview-fill)"
                />
                <path
                  d="M0 154 L24 149 L48 152 L72 140 L96 145 L120 131 L144 136 L168 116 L192 121 L216 109 L240 114 L264 92 L288 97 L312 83 L336 87 L360 73 L384 80 L408 62 L432 69 L456 52 L480 57 L504 39 L528 44 L552 31 L576 38 L600 22 L624 28 L648 17 L676 23 L700 9"
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <span>Jul ’25</span>
              <span>Oct ’25</span>
              <span>Jan ’26</span>
              <span>Apr ’26</span>
              <span>Jul ’26</span>
            </div>
            <div className="osf-preview-metrics">
              <span>
                <small>Cost basis</small>
                <strong className={masked('cost-basis') ? 'is-masked' : ''}>€96,242.18</strong>
              </span>
              <span>
                <small>Monthly cash flow</small>
                <strong className={masked('cash-flows') ? 'is-masked' : ''}>+€1,240</strong>
              </span>
              <span>
                <small>Transactions</small>
                <strong className={masked('transactions') ? 'is-masked' : ''}>847</strong>
              </span>
            </div>
          </main>
        </div>
        {draft.masks.length ? (
          <div className="osf-preview-frame__mask-note">
            <Icon name="eye-off" size={13} />
            {draft.masks.length} field group{draft.masks.length === 1 ? '' : 's'} hidden by your
            privacy policy
          </div>
        ) : null}
      </div>
      <div className="osf-preview-summary">
        <span>
          <small>Access</small>
          <strong>{selectedRole.label}</strong>
        </span>
        <span>
          <small>Audience</small>
          <strong>
            {draft.kind === 'collaboration' ? draft.email : draft.audience.replaceAll('-', ' ')}
          </strong>
        </span>
        <span>
          <small>Expires</small>
          <strong>{expiry ? new Date(expiry).toLocaleDateString() : 'Only when revoked'}</strong>
        </span>
        <span>
          <small>Changes</small>
          <strong>{draft.approval.replaceAll('-', ' ')}</strong>
        </span>
      </div>
    </>
  );
}

function ReceiptStage({
  result,
  copied,
  revokeConfirm,
  onCopy,
  onRevoke,
}: {
  result: OriginShareResult;
  copied: 'link' | 'invite' | 'code' | '';
  revokeConfirm: boolean;
  onCopy: (value: string, target: 'link' | 'invite' | 'code') => void;
  onRevoke: () => void;
}) {
  const revoked = result.status === 'revoked';
  const isLink = result.kind === 'private-link';
  return (
    <div className={cn('osf-receipt', revoked && 'is-revoked')}>
      <div className="osf-receipt__hero">
        <span>{revoked ? <Icon name="x" size={27} /> : <Icon name="check" size={27} />}</span>
        <small>
          {revoked ? 'Access revoked' : isLink ? 'Private link created' : 'Invitation sent'}
        </small>
        <h2>
          {revoked
            ? 'This access can no longer be used.'
            : isLink
              ? 'Your controlled view is ready.'
              : `Waiting for ${result.recipient.email} to accept.`}
        </h2>
        <p>
          {revoked
            ? 'Existing sessions were closed and the event was added to the portfolio access log.'
            : 'Every view and action is filtered through the role, masking, expiry and approval policy you selected.'}
        </p>
      </div>
      {!revoked ? (
        <div className="osf-receipt__access">
          <label>
            <span>{isLink ? 'Private link' : 'Invitation link'}</span>
            <div>
              <Icon name="link" size={15} />
              <code>{result.security.link}</code>
              <button
                onClick={() => onCopy(result.security.link || '', isLink ? 'link' : 'invite')}
                type="button"
              >
                <Icon name={copied === (isLink ? 'link' : 'invite') ? 'check' : 'copy'} size={15} />
                {copied === (isLink ? 'link' : 'invite') ? 'Copied' : 'Copy'}
              </button>
            </div>
          </label>
          {result.security.accessCode ? (
            <label>
              <span>Separate access code</span>
              <div className="osf-code-field">
                <Icon name="key" size={15} />
                <code>{result.security.accessCode}</code>
                <button
                  onClick={() => onCopy(result.security.accessCode || '', 'code')}
                  type="button"
                >
                  <Icon name={copied === 'code' ? 'check' : 'copy'} size={15} />
                  {copied === 'code' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </label>
          ) : null}
          {isLink ? (
            <p className="osf-code-warning">
              <Icon name="message" size={14} />
              Send the access code through a different channel than the link.
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="osf-receipt__details">
        <span>
          <small>Status</small>
          <strong className={revoked ? 'is-red' : 'is-green'}>
            <i /> {revoked ? 'Revoked' : isLink ? 'Active' : 'Pending acceptance'}
          </strong>
        </span>
        <span>
          <small>Role</small>
          <strong>{roleMeta[result.access.role].label}</strong>
        </span>
        <span>
          <small>Expiry</small>
          <strong>
            {result.security.expiresAt
              ? new Date(result.security.expiresAt).toLocaleString()
              : 'No automatic expiry'}
          </strong>
        </span>
        <span>
          <small>Hidden fields</small>
          <strong>{result.access.maskedFields.length}</strong>
        </span>
      </div>
      <div className="osf-audit-receipt">
        <div>
          <Icon name="document" size={18} />
          <span>
            <small>Access receipt</small>
            <strong>{result.id}</strong>
          </span>
        </div>
        <dl>
          <div>
            <dt>Created</dt>
            <dd>{new Date(result.receipt.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Created by</dt>
            <dd>{result.receipt.createdBy}</dd>
          </div>
          <div>
            <dt>Audit reference</dt>
            <dd>{result.receipt.auditReference}</dd>
          </div>
          <div>
            <dt>Revocation ID</dt>
            <dd>{result.receipt.revocationId}</dd>
          </div>
        </dl>
        {!revoked ? (
          <button
            className={cn('osf-revoke-button', revokeConfirm && 'is-confirming')}
            onClick={onRevoke}
            type="button"
          >
            <Icon name={revokeConfirm ? 'activity' : 'trash'} size={15} />
            {revokeConfirm ? 'Confirm: revoke immediately' : 'Revoke access'}
          </button>
        ) : (
          <p className="osf-revoked-note">
            <Icon name="check" size={14} />
            Revocation recorded. Creating access again will generate a different ID and link.
          </p>
        )}
      </div>
    </div>
  );
}
