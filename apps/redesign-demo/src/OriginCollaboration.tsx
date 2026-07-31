import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Icon, type IconName } from './Icons';
import './origin-collaboration.css';

export type OriginCollaborationRole =
  | 'owner'
  | 'admin'
  | 'editor'
  | 'proposer'
  | 'viewer'
  | 'accountant';

export type OriginCollaborationView = 'people' | 'requests' | 'groups' | 'audit';

export type OriginCollaborationPortfolio =
  | string
  | {
      id?: string;
      name: string;
      owner?: string;
      value?: number;
      currency?: string;
    };

export type OriginCollaborationShareContext = {
  portfolio: {
    id?: string;
    name: string;
  };
  source: 'invite' | 'group';
  suggestedRole?: OriginCollaborationRole;
  group?: {
    id: string;
    name: string;
    memberEmails: string[];
    defaultRole: OriginCollaborationRole;
    maskedFields: string[];
  };
};

export type OriginCollaborationProposalType = 'valuation' | 'trade';

export type OriginCollaborationProposal = {
  id: string;
  kind: 'collaboration';
  title: string;
  summary: string;
  portfolio: {
    id?: string;
    name: string;
  };
  source: {
    label: string;
    actor: string;
    detail: string;
  };
  requestedAt: string;
  requestedBy: string;
  status: 'pending';
  priority: 'normal' | 'high';
  risk: 'low' | 'medium';
  affectedCount: number;
  tags: string[];
  diff: Array<{
    label: string;
    before?: string;
    after: string;
    tone?: 'neutral' | 'positive' | 'negative' | 'warning';
    detail?: string;
  }>;
  lineage: Array<{
    label: string;
    detail: string;
    at?: string;
    state?: 'verified' | 'derived' | 'external' | 'warning';
  }>;
  permissions: Array<{
    label: string;
    detail?: string;
    outcome: 'allowed' | 'review' | 'blocked';
  }>;
  collaboration: {
    requestId: string;
    proposalType: OriginCollaborationProposalType;
    attachmentName?: string;
    comment: string;
    submittedByRole: OriginCollaborationRole;
  };
};

export type OriginCollaborationProps = {
  portfolio: OriginCollaborationPortfolio;
  externalShares?: OriginCollaborationExternalShare[];
  onOpenShare: (context: OriginCollaborationShareContext) => void;
  onSubmitProposal: (proposal: OriginCollaborationProposal) => void;
  onToast?: (message: string) => void;
};

export type OriginCollaborationExternalShare = {
  id: string;
  kind: 'collaboration' | 'private-link';
  status: 'active' | 'revoked';
  recipient: {
    email?: string;
    name?: string;
  };
  access: {
    role: OriginCollaborationRole;
    maskedFields: string[];
  };
  security: {
    expiresAt: string | null;
  };
  receipt: {
    createdAt: string;
  };
};

type MemberStatus = 'active' | 'left' | 'removed';
type InviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';
type ConnectionModel = 'mirrorchain' | 'shared-copy';
type Expiry = '7-days' | '30-days' | '90-days' | 'never';
type ProposalStatus = 'submitted' | 'sent-to-review' | 'withdrawn';
type AuditTone = 'neutral' | 'positive' | 'warning' | 'critical';
type MaskField =
  | 'total-value'
  | 'cost-basis'
  | 'returns'
  | 'transactions'
  | 'documents'
  | 'personal-labels';

type Member = {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: OriginCollaborationRole;
  status: MemberStatus;
  masks: MaskField[];
  joinedAt: string;
  expiresAt: string | null;
  lastSeen: string;
};

type Invitation = {
  id: string;
  email: string;
  name: string;
  role: OriginCollaborationRole;
  masks: MaskField[];
  expiry: Expiry;
  expiresAt: string | null;
  status: InviteStatus;
  createdAt: string;
  respondedAt?: string;
};

type ProposalComment = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  at: string;
};

type RequestProposal = {
  id: string;
  type: OriginCollaborationProposalType;
  title: string;
  submittedById: string;
  submittedByName: string;
  submittedByRole: OriginCollaborationRole;
  createdAt: string;
  status: ProposalStatus;
  comment: string;
  attachmentName?: string;
  valuation?: {
    asset: string;
    previousValue: number;
    proposedValue: number;
    method: string;
    effectiveDate: string;
  };
  trade?: {
    side: 'buy' | 'sell';
    symbol: string;
    quantity: number;
    limitPrice: number;
    fundingSource: string;
  };
  comments: ProposalComment[];
  reactionUserIds: string[];
  reviewReference?: string;
};

type AudienceGroup = {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  defaultRole: OriginCollaborationRole;
  masks: MaskField[];
  createdAt: string;
  updatedAt: string;
};

type UnsyncedFork = {
  id: string;
  memberId: string;
  memberName: string;
  reason: 'left' | 'removed';
  model: ConnectionModel;
  createdAt: string;
  lastSyncedAt: string;
  recordCount: number;
  sourceVersion: string;
};

type AuditEntry = {
  id: string;
  actor: string;
  actorId: string;
  action: string;
  detail: string;
  entity: 'access' | 'invitation' | 'proposal' | 'group' | 'ownership' | 'data';
  at: string;
  tone: AuditTone;
};

type CollaborationState = {
  version: 1;
  activeView: OriginCollaborationView;
  persona: 'owner' | 'invitee';
  selectedActorId: string;
  model: ConnectionModel;
  members: Member[];
  invitations: Invitation[];
  proposals: RequestProposal[];
  groups: AudienceGroup[];
  forks: UnsyncedFork[];
  audit: AuditEntry[];
};

type ConfirmationAction =
  | { kind: 'remove'; memberId: string }
  | { kind: 'leave'; memberId: string }
  | { kind: 'revoke-invite'; inviteId: string }
  | null;

const roleOrder: OriginCollaborationRole[] = [
  'owner',
  'admin',
  'editor',
  'proposer',
  'viewer',
  'accountant',
];

const editableRoles: OriginCollaborationRole[] = [
  'admin',
  'editor',
  'proposer',
  'viewer',
  'accountant',
];

const roleMeta: Record<
  OriginCollaborationRole,
  {
    label: string;
    icon: IconName;
    summary: string;
    capabilities: string[];
    tone: string;
  }
> = {
  owner: {
    label: 'Owner',
    icon: 'key',
    summary: 'Custody, access, and final authority',
    capabilities: ['Everything in the portfolio', 'Manage people', 'Transfer ownership'],
    tone: 'gold',
  },
  admin: {
    label: 'Administrator',
    icon: 'shield',
    summary: 'Maintain data and manage access',
    capabilities: ['Edit portfolio data', 'Manage people', 'Review proposals'],
    tone: 'blue',
  },
  editor: {
    label: 'Editor',
    icon: 'sliders',
    summary: 'Keep portfolio records accurate',
    capabilities: ['Edit holdings and activity', 'Run imports', 'Create scenarios'],
    tone: 'green',
  },
  proposer: {
    label: 'Proposer',
    icon: 'workbench',
    summary: 'Suggest changes without applying them',
    capabilities: ['View permitted data', 'Create proposals', 'Comment on requests'],
    tone: 'violet',
  },
  viewer: {
    label: 'Viewer',
    icon: 'eye',
    summary: 'Explore approved information',
    capabilities: ['View permitted data', 'Open asset details', 'Comment if invited'],
    tone: 'slate',
  },
  accountant: {
    label: 'Accountant',
    icon: 'document',
    summary: 'Reconcile books and prepare reports',
    capabilities: ['View activity and cash flow', 'View tax lots', 'Export reports'],
    tone: 'cyan',
  },
};

const maskMeta: Record<MaskField, { label: string; description: string }> = {
  'total-value': {
    label: 'Total value',
    description: 'Hide portfolio totals and position market values.',
  },
  'cost-basis': {
    label: 'Cost basis',
    description: 'Hide acquisition cost and unrealized gain.',
  },
  returns: {
    label: 'Returns',
    description: 'Hide absolute and percentage performance.',
  },
  transactions: {
    label: 'Transactions',
    description: 'Hide the activity ledger and cash movements.',
  },
  documents: {
    label: 'Documents',
    description: 'Hide statements, invoices, and attachments.',
  },
  'personal-labels': {
    label: 'Private labels',
    description: 'Hide personal notes, tags, and custom account names.',
  },
};

const viewMeta: Array<{
  id: OriginCollaborationView;
  label: string;
  icon: IconName;
}> = [
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'requests', label: 'Requests', icon: 'inbox' },
  { id: 'groups', label: 'Groups', icon: 'layers' },
  { id: 'audit', label: 'Audit', icon: 'activity' },
];

const auditEntityLabels: Record<AuditEntry['entity'], string> = {
  access: 'Access',
  invitation: 'Invitation',
  proposal: 'Proposal',
  group: 'Group',
  ownership: 'Ownership',
  data: 'Data state',
};

function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function useModalDialog<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const dialogElement: T = dialog;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

    const frame = window.requestAnimationFrame(() => {
      const initial =
        dialogElement.querySelector<HTMLElement>('[autofocus]') ??
        dialogElement.querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])',
        ) ??
        dialogElement.querySelector<HTMLElement>('button:not([disabled])');
      (initial ?? dialogElement).focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogElement.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    dialogElement.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      dialogElement.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  return dialogRef;
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function isoNow() {
  return new Date().toISOString();
}

function portfolioInfo(portfolio: OriginCollaborationPortfolio) {
  if (typeof portfolio === 'string') {
    return {
      id: undefined,
      name: portfolio,
      owner: 'Alex Morgan',
      currency: 'EUR',
      value: 284920.18,
    };
  }
  return {
    id: portfolio.id,
    name: portfolio.name,
    owner: portfolio.owner ?? 'Alex Morgan',
    currency: portfolio.currency ?? 'EUR',
    value: portfolio.value ?? 284920.18,
  };
}

function initials(value: string) {
  return (
    value
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'BT'
  );
}

function nameFromEmail(email: string) {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IE', {
    day: '2-digit',
    month: 'short',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function expiryDate(expiry: Expiry) {
  if (expiry === 'never') return null;
  const days = expiry === '7-days' ? 7 : expiry === '30-days' ? 30 : 90;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function makeAudit(
  actorId: string,
  actor: string,
  action: string,
  detail: string,
  entity: AuditEntry['entity'],
  tone: AuditTone = 'neutral',
): AuditEntry {
  return {
    id: uid('audit'),
    actor,
    actorId,
    action,
    detail,
    entity,
    at: isoNow(),
    tone,
  };
}

function seedState(portfolioName: string, ownerName: string): CollaborationState {
  const seededAt = new Date().toISOString();
  const owner: Member = {
    id: 'member_owner',
    name: ownerName,
    email: 'alex@northstar.studio',
    initials: initials(ownerName),
    role: 'owner',
    status: 'active',
    masks: [],
    joinedAt: '2024-04-12T09:10:00.000Z',
    expiresAt: null,
    lastSeen: 'Now',
  };
  const maya: Member = {
    id: 'member_maya',
    name: 'Maya Chen',
    email: 'maya@northstar.studio',
    initials: 'MC',
    role: 'admin',
    status: 'active',
    masks: [],
    joinedAt: '2025-11-08T14:20:00.000Z',
    expiresAt: null,
    lastSeen: '12 min ago',
  };
  const jonas: Member = {
    id: 'member_jonas',
    name: 'Jonas Feld',
    email: 'jonas@example.com',
    initials: 'JF',
    role: 'viewer',
    status: 'active',
    masks: ['cost-basis', 'transactions', 'documents', 'personal-labels'],
    joinedAt: '2026-05-14T08:42:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    lastSeen: 'Yesterday',
  };
  const priya: Member = {
    id: 'member_priya',
    name: 'Priya Rao',
    email: 'priya@harbor-advisory.example',
    initials: 'PR',
    role: 'proposer',
    status: 'active',
    masks: ['documents', 'personal-labels'],
    joinedAt: '2026-06-21T10:15:00.000Z',
    expiresAt: null,
    lastSeen: '34 min ago',
  };

  return {
    version: 1,
    activeView: 'people',
    persona: 'owner',
    selectedActorId: owner.id,
    model: 'mirrorchain',
    members: [owner, maya, jonas, priya],
    invitations: [
      {
        id: 'invite_leonie',
        email: 'leonie@taxdesk.example',
        name: 'Leonie Weber',
        role: 'accountant',
        masks: ['personal-labels'],
        expiry: '30-days',
        expiresAt: '2026-08-26T10:00:00.000Z',
        status: 'pending',
        createdAt: '2026-07-26T10:00:00.000Z',
      },
    ],
    proposals: [
      {
        id: 'proposal_riverside',
        type: 'valuation',
        title: 'Update Riverside property valuation',
        submittedById: priya.id,
        submittedByName: priya.name,
        submittedByRole: 'proposer',
        createdAt: '2026-07-26T16:42:00.000Z',
        status: 'submitted',
        comment:
          'The new value follows the signed July appraisal. I kept renovation costs separate so performance history remains traceable.',
        attachmentName: 'Riverside_Appraisal_July_2026.pdf',
        valuation: {
          asset: 'Riverside property',
          previousValue: 138400,
          proposedValue: 145000,
          method: 'Independent appraisal',
          effectiveDate: '2026-07-25',
        },
        comments: [
          {
            id: 'comment_seed_1',
            authorId: maya.id,
            authorName: maya.name,
            body: 'The document and effective date match the property folder.',
            at: '2026-07-26T17:05:00.000Z',
          },
        ],
        reactionUserIds: [maya.id],
      },
    ],
    groups: [
      {
        id: 'group_finance',
        name: 'Finance operations',
        description: 'People who maintain records and reconcile monthly reporting.',
        memberIds: [maya.id, priya.id],
        defaultRole: 'editor',
        masks: ['personal-labels'],
        createdAt: '2026-06-21T10:20:00.000Z',
        updatedAt: '2026-07-18T08:40:00.000Z',
      },
      {
        id: 'group_observers',
        name: 'Quarterly observers',
        description: 'Read-only access for the quarterly portfolio review.',
        memberIds: [jonas.id],
        defaultRole: 'viewer',
        masks: ['cost-basis', 'transactions', 'documents', 'personal-labels'],
        createdAt: '2026-05-14T08:42:00.000Z',
        updatedAt: '2026-05-14T08:42:00.000Z',
      },
    ],
    forks: [],
    audit: [
      {
        id: 'audit_seed_1',
        actor: priya.name,
        actorId: priya.id,
        action: 'Submitted valuation proposal',
        detail: `Riverside property · ${portfolioName}`,
        entity: 'proposal',
        at: '2026-07-26T16:42:00.000Z',
        tone: 'warning',
      },
      {
        id: 'audit_seed_2',
        actor: owner.name,
        actorId: owner.id,
        action: 'Invited Leonie Weber',
        detail: 'Accountant access · expires after 30 days',
        entity: 'invitation',
        at: '2026-07-26T10:00:00.000Z',
        tone: 'neutral',
      },
      {
        id: 'audit_seed_3',
        actor: maya.name,
        actorId: maya.id,
        action: 'Changed portfolio data model',
        detail: 'Shared copy → Live source',
        entity: 'data',
        at: '2026-07-18T08:44:00.000Z',
        tone: 'positive',
      },
      {
        id: 'audit_seed_4',
        actor: owner.name,
        actorId: owner.id,
        action: 'Created collaboration workspace',
        detail: `${portfolioName} now has one governed source of truth`,
        entity: 'access',
        at: seededAt,
        tone: 'positive',
      },
    ],
  };
}

function loadState(storageKey: string, initial: CollaborationState) {
  if (typeof window === 'undefined') return initial;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return initial;
    const parsed = JSON.parse(raw) as Partial<CollaborationState>;
    if (parsed.version !== 1) return initial;
    return {
      ...initial,
      ...parsed,
      members: Array.isArray(parsed.members) ? parsed.members : initial.members,
      invitations: Array.isArray(parsed.invitations) ? parsed.invitations : initial.invitations,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : initial.proposals,
      groups: Array.isArray(parsed.groups) ? parsed.groups : initial.groups,
      forks: Array.isArray(parsed.forks) ? parsed.forks : initial.forks,
      audit: Array.isArray(parsed.audit) ? parsed.audit : initial.audit,
    };
  } catch {
    return initial;
  }
}

function Button({
  children,
  icon,
  tone = 'secondary',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  icon?: IconName;
  tone?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button className={cx('oc-button', `oc-button--${tone}`, className)} type="button" {...props}>
      {icon ? <Icon name={icon} size={15} /> : null}
      <span>{children}</span>
    </button>
  );
}

function RoleBadge({
  role,
  compact = false,
}: {
  role: OriginCollaborationRole;
  compact?: boolean;
}) {
  const meta = roleMeta[role];
  return (
    <span className={cx('oc-role', `oc-role--${meta.tone}`, compact && 'oc-role--compact')}>
      <Icon name={meta.icon} size={compact ? 11 : 13} />
      {meta.label}
    </span>
  );
}

function PersonAvatar({
  name,
  size = 'normal',
}: {
  name: string;
  size?: 'small' | 'normal' | 'large';
}) {
  return (
    <span className={cx('oc-avatar', `oc-avatar--${size}`)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="oc-empty">
      <span className="oc-empty__icon">
        <Icon name={icon} size={20} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function OriginCollaboration({
  portfolio,
  externalShares = [],
  onOpenShare,
  onSubmitProposal,
  onToast,
}: OriginCollaborationProps) {
  const tabsId = useId();
  const info = useMemo(() => portfolioInfo(portfolio), [portfolio]);
  const storageKey = useMemo(() => {
    const identity = (info.id ?? info.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `bt-demo-collaboration-${identity}`;
  }, [info.id, info.name]);
  const initial = useMemo(() => seedState(info.name, info.owner), [info.name, info.owner]);
  const [state, setState] = useState<CollaborationState>(() => loadState(storageKey, initial));
  const [notice, setNotice] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationAction>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }, [state, storageKey]);

  useEffect(() => {
    if (!externalShares.length) return;
    setState((current) => {
      let changed = false;
      let invitations = [...current.invitations];
      let audit = [...current.audit];
      externalShares
        .filter((share) => share.kind === 'collaboration' && share.recipient.email)
        .forEach((share) => {
          const invitationId = `external_${share.id}`;
          const existing = invitations.find((invitation) => invitation.id === invitationId);
          if (existing) {
            const nextStatus = share.status === 'revoked' ? 'revoked' : existing.status;
            if (nextStatus !== existing.status) {
              changed = true;
              invitations = invitations.map((invitation) =>
                invitation.id === invitationId ? { ...invitation, status: nextStatus } : invitation,
              );
            }
            return;
          }
          changed = true;
          invitations = [
            {
              id: invitationId,
              email: share.recipient.email!,
              name: share.recipient.name || share.recipient.email!.split('@')[0]!,
              role: share.access.role,
              masks: share.access.maskedFields.filter(
                (field): field is MaskField => field in maskMeta,
              ),
              expiry: share.security.expiresAt ? '30-days' : 'never',
              expiresAt: share.security.expiresAt,
              status: share.status === 'revoked' ? 'revoked' : 'pending',
              createdAt: share.receipt.createdAt,
            },
            ...invitations,
          ];
          audit = [
            makeAudit(
              'member_owner',
              'Alex Morgan',
              'Guided share added',
              `${share.recipient.email} · ${roleMeta[share.access.role].label}`,
              'invitation',
              'positive',
            ),
            ...audit,
          ];
        });
      return changed ? { ...current, invitations, audit } : current;
    });
  }, [externalShares]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function toast(message: string) {
    setNotice(message);
    onToast?.(message);
  }

  const owner = state.members.find(
    (member) => member.role === 'owner' && member.status === 'active',
  );
  const selectedMember = state.members.find((member) => member.id === state.selectedActorId);
  const selectedInvite = state.selectedActorId.startsWith('invite:')
    ? state.invitations.find(
        (invitation) => invitation.id === state.selectedActorId.replace('invite:', ''),
      )
    : undefined;
  const actor =
    state.persona === 'owner'
      ? owner
      : selectedMember?.status === 'active'
        ? selectedMember
        : undefined;
  const pendingCount = state.proposals.filter((proposal) => proposal.status === 'submitted').length;
  const activePeople = state.members.filter((member) => member.status === 'active');
  const pendingInvites = state.invitations.filter((invitation) => invitation.status === 'pending');

  function setView(view: OriginCollaborationView) {
    setState((current) => ({ ...current, activeView: view }));
  }

  function switchPersona(persona: 'owner' | 'invitee') {
    if (persona === 'owner') {
      setState((current) => ({
        ...current,
        persona,
        selectedActorId:
          current.members.find((member) => member.role === 'owner' && member.status === 'active')
            ?.id ?? current.selectedActorId,
      }));
      return;
    }
    setState((current) => {
      const currentGuest =
        current.selectedActorId !==
        current.members.find((member) => member.role === 'owner' && member.status === 'active')?.id;
      const fallback = current.invitations.find((invitation) => invitation.status === 'pending')
        ? `invite:${current.invitations.find((invitation) => invitation.status === 'pending')!.id}`
        : (current.members.find((member) => member.role !== 'owner' && member.status === 'active')
            ?.id ?? current.selectedActorId);
      return {
        ...current,
        persona,
        selectedActorId: currentGuest ? current.selectedActorId : fallback,
      };
    });
  }

  function chooseInvitee(value: string) {
    setState((current) => ({ ...current, persona: 'invitee', selectedActorId: value }));
  }

  function setConnectionModel(model: ConnectionModel) {
    if (!actor || actor.role !== 'owner') {
      toast('Only the portfolio owner can change the collaboration data model.');
      return;
    }
    setState((current) => ({
      ...current,
      model,
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          'Changed portfolio data model',
          `${current.model === 'mirrorchain' ? 'Live source' : 'Shared copy'} → ${
            model === 'mirrorchain' ? 'Live source' : 'Shared copy'
          }`,
          'data',
          'positive',
        ),
        ...current.audit,
      ],
    }));
    toast(
      model === 'mirrorchain'
        ? 'Portfolio now uses one live source.'
        : 'Portfolio now uses shared copies.',
    );
  }

  function addInvitation(draft: {
    email: string;
    role: OriginCollaborationRole;
    masks: MaskField[];
    expiry: Expiry;
  }) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) {
      toast('Your role cannot invite people.');
      return;
    }
    const normalizedEmail = draft.email.trim().toLowerCase();
    const alreadyExists =
      state.members.some(
        (member) => member.email.toLowerCase() === normalizedEmail && member.status === 'active',
      ) ||
      state.invitations.some(
        (invitation) =>
          invitation.email.toLowerCase() === normalizedEmail && invitation.status === 'pending',
      );
    if (alreadyExists) {
      toast('That person already has access or a pending invitation.');
      return;
    }
    const invitation: Invitation = {
      id: uid('invite'),
      email: normalizedEmail,
      name: nameFromEmail(normalizedEmail),
      role: draft.role,
      masks: draft.masks,
      expiry: draft.expiry,
      expiresAt: expiryDate(draft.expiry),
      status: 'pending',
      createdAt: isoNow(),
    };
    setState((current) => ({
      ...current,
      invitations: [invitation, ...current.invitations],
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          `Invited ${invitation.name}`,
          `${roleMeta[invitation.role].label} access · ${
            invitation.expiresAt ? `expires ${formatDate(invitation.expiresAt)}` : 'no expiry'
          } · ${invitation.masks.length} masked fields`,
          'invitation',
        ),
        ...current.audit,
      ],
    }));
    setInviteOpen(false);
    toast(`Invitation prepared for ${invitation.email}. Switch persona to preview the email.`);
  }

  function respondToInvite(invitation: Invitation, response: 'accepted' | 'declined') {
    const now = isoNow();
    if (response === 'declined') {
      setState((current) => ({
        ...current,
        invitations: current.invitations.map((item) =>
          item.id === invitation.id ? { ...item, status: 'declined', respondedAt: now } : item,
        ),
        audit: [
          makeAudit(
            `invite:${invitation.id}`,
            invitation.name,
            'Declined portfolio invitation',
            `${info.name} · ${roleMeta[invitation.role].label}`,
            'invitation',
            'warning',
          ),
          ...current.audit,
        ],
      }));
      toast('Invitation declined. No portfolio data was shared.');
      return;
    }

    const member: Member = {
      id: uid('member'),
      name: invitation.name,
      email: invitation.email,
      initials: initials(invitation.name),
      role: invitation.role,
      status: 'active',
      masks: invitation.masks,
      joinedAt: now,
      expiresAt: invitation.expiresAt,
      lastSeen: 'Now',
    };
    setState((current) => ({
      ...current,
      selectedActorId: member.id,
      invitations: current.invitations.map((item) =>
        item.id === invitation.id ? { ...item, status: 'accepted', respondedAt: now } : item,
      ),
      members: [...current.members, member],
      audit: [
        makeAudit(
          member.id,
          member.name,
          'Accepted portfolio invitation',
          `${roleMeta[member.role].label} access · ${current.model === 'mirrorchain' ? 'live source' : 'shared copy'} connected`,
          'invitation',
          'positive',
        ),
        ...current.audit,
      ],
    }));
    toast(`${info.name} is now available in ${member.name}'s portfolio list.`);
  }

  function updateRole(memberId: string, role: OriginCollaborationRole) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) {
      toast('Your role cannot change access.');
      return;
    }
    const target = state.members.find((member) => member.id === memberId);
    if (!target || target.role === 'owner' || target.status !== 'active') return;
    const before = target.role;
    setState((current) => ({
      ...current,
      members: current.members.map((member) =>
        member.id === memberId ? { ...member, role } : member,
      ),
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          `Changed ${target.name}'s role`,
          `${roleMeta[before].label} → ${roleMeta[role].label}`,
          'access',
          role === 'admin' ? 'warning' : 'neutral',
        ),
        ...current.audit,
      ],
    }));
    toast(`${target.name} is now ${roleMeta[role].label.toLowerCase()}.`);
  }

  function updateMasks(memberId: string, masks: MaskField[]) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) {
      toast('Your role cannot change privacy controls.');
      return;
    }
    const target = state.members.find((member) => member.id === memberId);
    if (!target || target.role === 'owner') return;
    setState((current) => ({
      ...current,
      members: current.members.map((member) =>
        member.id === memberId ? { ...member, masks } : member,
      ),
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          `Updated ${target.name}'s data visibility`,
          masks.length
            ? `${masks.length} portfolio fields are masked`
            : 'All permitted fields visible',
          'access',
        ),
        ...current.audit,
      ],
    }));
    toast('Visibility rules updated.');
  }

  function createFork(member: Member, reason: 'left' | 'removed', model: ConnectionModel) {
    return {
      id: uid('fork'),
      memberId: member.id,
      memberName: member.name,
      reason,
      model,
      createdAt: isoNow(),
      lastSyncedAt: isoNow(),
      recordCount: 1842,
      sourceVersion: `snapshot-${new Date().toISOString().slice(0, 10)}`,
    } satisfies UnsyncedFork;
  }

  function confirmLifecycleAction() {
    if (!confirmation) return;
    if (confirmation.kind === 'revoke-invite') {
      const invitation = state.invitations.find((item) => item.id === confirmation.inviteId);
      if (!invitation || !actor) return;
      setState((current) => ({
        ...current,
        invitations: current.invitations.map((item) =>
          item.id === invitation.id ? { ...item, status: 'revoked', respondedAt: isoNow() } : item,
        ),
        audit: [
          makeAudit(
            actor.id,
            actor.name,
            `Revoked ${invitation.name}'s invitation`,
            `${invitation.email} can no longer accept`,
            'invitation',
            'warning',
          ),
          ...current.audit,
        ],
      }));
      setConfirmation(null);
      toast('Invitation revoked.');
      return;
    }

    const member = state.members.find((item) => item.id === confirmation.memberId);
    if (!member) return;
    const reason = confirmation.kind === 'leave' ? 'left' : 'removed';
    const fork = createFork(member, reason, state.model);
    const actingPerson =
      confirmation.kind === 'leave'
        ? member
        : (actor ?? state.members.find((item) => item.role === 'owner') ?? member);

    setState((current) => ({
      ...current,
      members: current.members.map((item) =>
        item.id === member.id ? { ...item, status: reason } : item,
      ),
      forks: [fork, ...current.forks],
      audit: [
        makeAudit(
          actingPerson.id,
          actingPerson.name,
          reason === 'left' ? 'Left shared portfolio' : `Removed ${member.name}`,
          `${member.name}'s last synced snapshot became a persistent unsynced fork`,
          'data',
          'critical',
        ),
        ...current.audit,
      ],
    }));
    setConfirmation(null);
    toast(
      reason === 'left'
        ? 'You left the source. Your saved copy is now an unsynced fork.'
        : `${member.name} was removed. Their saved copy is now an unsynced fork.`,
    );
  }

  function saveProposal(draft: {
    type: OriginCollaborationProposalType;
    comment: string;
    attachmentName?: string;
    valuation?: RequestProposal['valuation'];
    trade?: RequestProposal['trade'];
  }) {
    if (!actor || actor.role !== 'proposer') {
      toast('Only a proposer can submit this change without direct edit access.');
      return;
    }
    const title =
      draft.type === 'valuation'
        ? `Update ${draft.valuation?.asset ?? 'asset'} valuation`
        : `${draft.trade?.side === 'sell' ? 'Sell' : 'Buy'} ${draft.trade?.symbol ?? 'asset'}`;
    const proposal: RequestProposal = {
      id: uid('proposal'),
      type: draft.type,
      title,
      submittedById: actor.id,
      submittedByName: actor.name,
      submittedByRole: actor.role,
      createdAt: isoNow(),
      status: 'submitted',
      comment: draft.comment,
      attachmentName: draft.attachmentName,
      valuation: draft.valuation,
      trade: draft.trade,
      comments: [],
      reactionUserIds: [],
    };
    setState((current) => ({
      ...current,
      activeView: 'requests',
      proposals: [proposal, ...current.proposals],
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          `Submitted ${draft.type} proposal`,
          `${title} · owner review required`,
          'proposal',
          'warning',
        ),
        ...current.audit,
      ],
    }));
    toast('Proposal submitted to the portfolio owner.');
  }

  function withdrawProposal(proposal: RequestProposal) {
    if (!actor || actor.id !== proposal.submittedById || proposal.status !== 'submitted') return;
    setState((current) => ({
      ...current,
      proposals: current.proposals.map((item) =>
        item.id === proposal.id ? { ...item, status: 'withdrawn' } : item,
      ),
      audit: [
        makeAudit(actor.id, actor.name, 'Withdrew proposal', proposal.title, 'proposal', 'warning'),
        ...current.audit,
      ],
    }));
    toast('Proposal withdrawn before review.');
  }

  function sendProposalToReview(proposal: RequestProposal) {
    if (!actor || !['owner', 'admin'].includes(actor.role) || proposal.status !== 'submitted') {
      toast('Only an owner or administrator can send this request to Review.');
      return;
    }
    const reviewReference = `COL-${new Date().getFullYear()}-${Math.floor(
      1000 + Math.random() * 9000,
    )}`;
    const payload = makeReviewProposal(proposal, info, reviewReference);
    onSubmitProposal(payload);
    setState((current) => ({
      ...current,
      proposals: current.proposals.map((item) =>
        item.id === proposal.id ? { ...item, status: 'sent-to-review', reviewReference } : item,
      ),
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          'Sent proposal to shared Review',
          `${proposal.title} · ${reviewReference}`,
          'proposal',
          'positive',
        ),
        ...current.audit,
      ],
    }));
    toast(`Sent to Review as ${reviewReference}.`);
  }

  function addComment(proposalId: string, body: string) {
    if (!actor || !body.trim()) return;
    const comment: ProposalComment = {
      id: uid('comment'),
      authorId: actor.id,
      authorName: actor.name,
      body: body.trim(),
      at: isoNow(),
    };
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal) return;
    setState((current) => ({
      ...current,
      proposals: current.proposals.map((item) =>
        item.id === proposalId ? { ...item, comments: [...item.comments, comment] } : item,
      ),
      audit: [
        makeAudit(actor.id, actor.name, 'Commented on proposal', proposal.title, 'proposal'),
        ...current.audit,
      ],
    }));
  }

  function toggleReaction(proposalId: string) {
    if (!actor) {
      toast('Accept the invitation to react.');
      return;
    }
    setState((current) => ({
      ...current,
      proposals: current.proposals.map((item) => {
        if (item.id !== proposalId) return item;
        const reacted = item.reactionUserIds.includes(actor.id);
        return {
          ...item,
          reactionUserIds: reacted
            ? item.reactionUserIds.filter((id) => id !== actor.id)
            : [...item.reactionUserIds, actor.id],
        };
      }),
    }));
  }

  function saveGroup(draft: {
    id?: string;
    name: string;
    description: string;
    memberIds: string[];
    defaultRole: OriginCollaborationRole;
    masks: MaskField[];
  }) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) {
      toast('Your role cannot manage audience groups.');
      return;
    }
    const now = isoNow();
    const group: AudienceGroup = {
      id: draft.id ?? uid('group'),
      name: draft.name.trim(),
      description: draft.description.trim(),
      memberIds: draft.memberIds,
      defaultRole: draft.defaultRole,
      masks: draft.masks,
      createdAt: state.groups.find((item) => item.id === draft.id)?.createdAt ?? now,
      updatedAt: now,
    };
    const existing = Boolean(draft.id);
    setState((current) => ({
      ...current,
      groups: existing
        ? current.groups.map((item) => (item.id === group.id ? group : item))
        : [group, ...current.groups],
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          existing ? `Updated group ${group.name}` : `Created group ${group.name}`,
          `${group.memberIds.length} people · default ${roleMeta[group.defaultRole].label}`,
          'group',
          'positive',
        ),
        ...current.audit,
      ],
    }));
    toast(existing ? 'Audience group updated.' : 'Reusable audience group created.');
  }

  function deleteGroup(group: AudienceGroup) {
    if (!actor || !['owner', 'admin'].includes(actor.role)) return;
    setState((current) => ({
      ...current,
      groups: current.groups.filter((item) => item.id !== group.id),
      audit: [
        makeAudit(
          actor.id,
          actor.name,
          `Deleted group ${group.name}`,
          'Existing portfolio access was not changed',
          'group',
          'warning',
        ),
        ...current.audit,
      ],
    }));
    toast('Group deleted. Existing access remains unchanged.');
  }

  function useGroup(group: AudienceGroup) {
    const memberEmails = group.memberIds
      .map((memberId) => state.members.find((member) => member.id === memberId)?.email)
      .filter((email): email is string => Boolean(email));
    onOpenShare({
      portfolio: { id: info.id, name: info.name },
      source: 'group',
      suggestedRole: group.defaultRole,
      group: {
        id: group.id,
        name: group.name,
        memberEmails,
        defaultRole: group.defaultRole,
        maskedFields: group.masks,
      },
    });
  }

  function transferOwnership(targetId: string) {
    if (!owner || !actor || actor.id !== owner.id) {
      toast('Only the current owner can transfer ownership.');
      return;
    }
    const target = state.members.find(
      (member) => member.id === targetId && member.status === 'active',
    );
    if (!target || target.role === 'owner') return;
    setState((current) => ({
      ...current,
      selectedActorId: target.id,
      members: current.members.map((member) => {
        if (member.id === owner.id) return { ...member, role: 'admin' };
        if (member.id === target.id)
          return { ...member, role: 'owner', masks: [], expiresAt: null };
        return member;
      }),
      audit: [
        makeAudit(
          owner.id,
          owner.name,
          'Transferred portfolio ownership',
          `${owner.name} → ${target.name} · ${info.name}`,
          'ownership',
          'critical',
        ),
        ...current.audit,
      ],
    }));
    setTransferOpen(false);
    toast(`${target.name} is now the portfolio owner.`);
  }

  function resetDemo() {
    setState(initial);
    setConfirmation(null);
    setTransferOpen(false);
    setInviteOpen(false);
    toast('Collaboration demo reset.');
  }

  const disconnectedMember =
    state.persona === 'invitee'
      ? state.members.find(
          (member) => member.id === state.selectedActorId && member.status !== 'active',
        )
      : undefined;
  const selectedFork = disconnectedMember
    ? state.forks.find((fork) => fork.memberId === disconnectedMember.id)
    : undefined;

  return (
    <section className="origin-collaboration">
      <header className="oc-page-head">
        <div className="oc-page-head__identity">
          <span className="oc-page-head__mark">
            <Icon name="people" size={18} />
          </span>
          <div>
            <h1>People & access</h1>
          </div>
        </div>
        <div className="oc-page-head__actions">
          <div className="oc-persona-switch" aria-label="Preview collaboration as">
            <button
              aria-pressed={state.persona === 'owner'}
              className={cx(state.persona === 'owner' && 'is-active')}
              onClick={() => switchPersona('owner')}
              type="button"
            >
              Owner
            </button>
            <button
              aria-pressed={state.persona === 'invitee'}
              className={cx(state.persona === 'invitee' && 'is-active')}
              onClick={() => switchPersona('invitee')}
              type="button"
            >
              Invitee
            </button>
          </div>
          <Button
            icon="user-plus"
            onClick={() => {
              if (actor && ['owner', 'admin'].includes(actor.role)) setInviteOpen(true);
              else toast('Only an owner or administrator can invite people.');
            }}
            tone="primary"
          >
            Invite person
          </Button>
        </div>
      </header>

      <PersonaBar
        activePeople={activePeople}
        invitations={state.invitations}
        model={state.model}
        onChoose={chooseInvitee}
        owner={owner}
        persona={state.persona}
        selectedActorId={state.selectedActorId}
        selectedInvite={selectedInvite}
        selectedMember={selectedMember}
      />

      {selectedInvite ? (
        <InvitationResponse
          invitation={selectedInvite}
          model={state.model}
          onRespond={respondToInvite}
          portfolioName={info.name}
        />
      ) : disconnectedMember && selectedFork ? (
        <ForkWorkspace
          currency={info.currency}
          fork={selectedFork}
          member={disconnectedMember}
          portfolioName={info.name}
          portfolioValue={info.value}
        />
      ) : (
        <>
          <nav aria-label="Collaboration sections" className="oc-view-tabs" role="tablist">
            {viewMeta.map((item) => {
              const count =
                item.id === 'people'
                  ? activePeople.length + pendingInvites.length
                  : item.id === 'requests'
                    ? pendingCount
                    : item.id === 'groups'
                      ? state.groups.length
                      : state.audit.length;
              return (
                <button
                  aria-controls={`${tabsId}-${item.id}-panel`}
                  aria-selected={state.activeView === item.id}
                  className={cx(state.activeView === item.id && 'is-active')}
                  id={`${tabsId}-${item.id}-tab`}
                  key={item.id}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const current = viewMeta.findIndex((view) => view.id === item.id);
                    const next =
                      event.key === 'Home'
                        ? viewMeta[0]!
                        : event.key === 'End'
                          ? viewMeta[viewMeta.length - 1]!
                          : viewMeta[
                              (current + (event.key === 'ArrowRight' ? 1 : -1) + viewMeta.length) %
                                viewMeta.length
                            ]!;
                    setView(next.id);
                    window.requestAnimationFrame(() =>
                      document.getElementById(`${tabsId}-${next.id}-tab`)?.focus(),
                    );
                  }}
                  onClick={() => setView(item.id)}
                  role="tab"
                  tabIndex={state.activeView === item.id ? 0 : -1}
                  type="button"
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                  <small>{count}</small>
                </button>
              );
            })}
          </nav>

          <div className="oc-view-stack">
            <div
              aria-labelledby={`${tabsId}-people-tab`}
              hidden={state.activeView !== 'people'}
              id={`${tabsId}-people-panel`}
              role="tabpanel"
            >
              <PeopleView
                actor={actor}
                activePeople={activePeople}
                currency={info.currency}
                forks={state.forks}
                invitations={state.invitations}
                model={state.model}
                onChangeModel={setConnectionModel}
                onChangeRole={updateRole}
                onEditMasks={updateMasks}
                onLeave={(memberId) => setConfirmation({ kind: 'leave', memberId })}
                onOpenGuidedShare={() =>
                  onOpenShare({
                    portfolio: { id: info.id, name: info.name },
                    source: 'invite',
                    suggestedRole: 'viewer',
                  })
                }
                onOpenTransfer={() => setTransferOpen(true)}
                onRemove={(memberId) => setConfirmation({ kind: 'remove', memberId })}
                onRevokeInvite={(inviteId) => setConfirmation({ kind: 'revoke-invite', inviteId })}
                onTryRestricted={() => {
                  toast('Permission denied: Viewer cannot edit valuation or portfolio activity.');
                  if (actor) {
                    setState((current) => ({
                      ...current,
                      audit: [
                        makeAudit(
                          actor.id,
                          actor.name,
                          'Blocked edit attempt',
                          'Viewer tried to edit a portfolio valuation',
                          'access',
                          'warning',
                        ),
                        ...current.audit,
                      ],
                    }));
                  }
                }}
                owner={owner}
                portfolioName={info.name}
                portfolioValue={info.value}
              />
            </div>

            <div
              aria-labelledby={`${tabsId}-requests-tab`}
              hidden={state.activeView !== 'requests'}
              id={`${tabsId}-requests-panel`}
              role="tabpanel"
            >
              <RequestsView
                actor={actor}
                currency={info.currency}
                onAddComment={addComment}
                onCreateProposal={saveProposal}
                onOpenPeople={() => setView('people')}
                onSendToReview={sendProposalToReview}
                onToggleReaction={toggleReaction}
                onWithdraw={withdrawProposal}
                proposals={state.proposals}
              />
            </div>

            <div
              aria-labelledby={`${tabsId}-groups-tab`}
              hidden={state.activeView !== 'groups'}
              id={`${tabsId}-groups-panel`}
              role="tabpanel"
            >
              <GroupsView
                actor={actor}
                groups={state.groups}
                members={activePeople}
                onDelete={deleteGroup}
                onSave={saveGroup}
                onUse={useGroup}
              />
            </div>

            <div
              aria-labelledby={`${tabsId}-audit-tab`}
              hidden={state.activeView !== 'audit'}
              id={`${tabsId}-audit-panel`}
              role="tabpanel"
            >
              <AuditView entries={state.audit} onReset={resetDemo} />
            </div>
          </div>
        </>
      )}

      {inviteOpen ? (
        <InviteComposer onClose={() => setInviteOpen(false)} onSubmit={addInvitation} />
      ) : null}

      {transferOpen && owner ? (
        <OwnershipTransfer
          members={activePeople.filter((member) => member.id !== owner.id)}
          onClose={() => setTransferOpen(false)}
          onTransfer={transferOwnership}
          owner={owner}
          portfolioName={info.name}
        />
      ) : null}

      {confirmation ? (
        <LifecycleConfirmation
          action={confirmation}
          invitation={
            confirmation.kind === 'revoke-invite'
              ? state.invitations.find((item) => item.id === confirmation.inviteId)
              : undefined
          }
          member={
            confirmation.kind !== 'revoke-invite'
              ? state.members.find((item) => item.id === confirmation.memberId)
              : undefined
          }
          model={state.model}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmLifecycleAction}
        />
      ) : null}

      {notice ? (
        <div className="oc-toast" role="status">
          <Icon name="check" size={15} />
          <span>{notice}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice('')} type="button">
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function makeReviewProposal(
  proposal: RequestProposal,
  portfolio: ReturnType<typeof portfolioInfo>,
  reviewReference: string,
): OriginCollaborationProposal {
  const isValuation = proposal.type === 'valuation';
  const valuation = proposal.valuation;
  const trade = proposal.trade;
  const summary = isValuation
    ? `${proposal.submittedByName} proposes valuing ${valuation?.asset ?? 'an asset'} at ${formatMoney(
        valuation?.proposedValue ?? 0,
        portfolio.currency,
      )}.`
    : `${proposal.submittedByName} proposes a ${trade?.side ?? 'buy'} of ${
        trade?.quantity ?? 0
      } ${trade?.symbol ?? 'units'}.`;

  return {
    id: reviewReference,
    kind: 'collaboration',
    title: proposal.title,
    summary,
    portfolio: { id: portfolio.id, name: portfolio.name },
    source: {
      label: 'Portfolio collaboration',
      actor: proposal.submittedByName,
      detail: `${roleMeta[proposal.submittedByRole].label} · request ${proposal.id}`,
    },
    requestedAt: proposal.createdAt,
    requestedBy: proposal.submittedByName,
    status: 'pending',
    priority: proposal.type === 'trade' ? 'high' : 'normal',
    risk: proposal.type === 'trade' ? 'medium' : 'low',
    affectedCount: 1,
    tags: ['collaboration', proposal.type, 'owner-reviewed'],
    diff: isValuation
      ? [
          {
            label: valuation?.asset ?? 'Asset valuation',
            before: formatMoney(valuation?.previousValue ?? 0, portfolio.currency),
            after: formatMoney(valuation?.proposedValue ?? 0, portfolio.currency),
            tone:
              (valuation?.proposedValue ?? 0) >= (valuation?.previousValue ?? 0)
                ? 'positive'
                : 'negative',
            detail: `${valuation?.method ?? 'Manual valuation'} · effective ${
              valuation?.effectiveDate ?? 'today'
            }`,
          },
        ]
      : [
          {
            label: `${trade?.side === 'sell' ? 'Sell' : 'Buy'} ${trade?.symbol ?? 'asset'}`,
            before: 'No staged trade',
            after: `${trade?.quantity ?? 0} units · ${formatMoney(
              trade?.limitPrice ?? 0,
              portfolio.currency,
            )} limit`,
            tone: 'warning',
            detail: `Funding: ${trade?.fundingSource ?? 'Portfolio cash'}`,
          },
        ],
    lineage: [
      {
        label: 'Submitted by',
        detail: `${proposal.submittedByName} · ${roleMeta[proposal.submittedByRole].label}`,
        at: proposal.createdAt,
        state: 'verified',
      },
      {
        label: 'Attachment',
        detail: proposal.attachmentName ?? 'No supporting file',
        state: proposal.attachmentName ? 'external' : 'warning',
      },
      {
        label: 'Owner routing',
        detail: `Sent to shared Review as ${reviewReference}`,
        at: isoNow(),
        state: 'derived',
      },
    ],
    permissions: [
      {
        label: 'Read permitted portfolio data',
        detail: `${proposal.submittedByName}'s role allows scoped portfolio access`,
        outcome: 'allowed',
      },
      {
        label: 'Create a proposal',
        detail: 'Proposer can stage structured changes',
        outcome: 'allowed',
      },
      {
        label: 'Apply portfolio changes',
        detail: 'Explicit Review approval is required',
        outcome: 'review',
      },
    ],
    collaboration: {
      requestId: proposal.id,
      proposalType: proposal.type,
      attachmentName: proposal.attachmentName,
      comment: proposal.comment,
      submittedByRole: proposal.submittedByRole,
    },
  };
}

function PersonaBar({
  persona,
  owner,
  selectedMember,
  selectedInvite,
  selectedActorId,
  activePeople,
  invitations,
  model,
  onChoose,
}: {
  persona: 'owner' | 'invitee';
  owner?: Member;
  selectedMember?: Member;
  selectedInvite?: Invitation;
  selectedActorId: string;
  activePeople: Member[];
  invitations: Invitation[];
  model: ConnectionModel;
  onChoose: (value: string) => void;
}) {
  const person = persona === 'owner' ? owner : selectedMember;
  return (
    <div className={cx('oc-persona-bar', persona === 'invitee' && 'is-preview')}>
      <div className="oc-persona-bar__status">
        <span className="oc-live-dot" />
        <div>
          <small>{persona === 'owner' ? 'OWNER VIEW' : 'INVITEE PREVIEW'}</small>
          <strong>{selectedInvite?.name ?? person?.name ?? 'Choose an invitee'}</strong>
        </div>
        {selectedInvite ? (
          <span className="oc-status oc-status--pending">Invitation pending</span>
        ) : person ? (
          <RoleBadge compact role={person.role} />
        ) : null}
      </div>
      <div className="oc-persona-bar__context">
        <span>
          <Icon name={model === 'mirrorchain' ? 'link' : 'copy'} size={13} />
          {model === 'mirrorchain' ? 'One governed live source' : 'Synchronized shared copies'}
        </span>
        {persona === 'invitee' ? (
          <label>
            <span>Preview as</span>
            <select onChange={(event) => onChoose(event.target.value)} value={selectedActorId}>
              {invitations
                .filter((invitation) => invitation.status !== 'revoked')
                .map((invitation) => (
                  <option key={invitation.id} value={`invite:${invitation.id}`}>
                    {invitation.name} · {invitation.status} invite
                  </option>
                ))}
              {activePeople
                .filter((member) => member.role !== 'owner')
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} · {roleMeta[member.role].label}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <span className="oc-persona-bar__hint">
            Switch to Invitee to test permissions and acceptance.
          </span>
        )}
      </div>
    </div>
  );
}

function InvitationResponse({
  invitation,
  model,
  portfolioName,
  onRespond,
}: {
  invitation: Invitation;
  model: ConnectionModel;
  portfolioName: string;
  onRespond: (invitation: Invitation, response: 'accepted' | 'declined') => void;
}) {
  if (invitation.status !== 'pending') {
    return (
      <div className="oc-invite-result">
        <span className={cx('oc-invite-result__icon', `is-${invitation.status}`)}>
          <Icon name={invitation.status === 'accepted' ? 'check' : 'x'} size={22} />
        </span>
        <small>INVITATION {invitation.status.toUpperCase()}</small>
        <h2>
          {invitation.status === 'accepted'
            ? `${portfolioName} was added`
            : `No access to ${portfolioName}`}
        </h2>
        <p>
          {invitation.status === 'accepted'
            ? 'Choose the active member record in the preview selector to open the shared workspace.'
            : 'The owner can prepare a new invitation if access is still needed.'}
        </p>
      </div>
    );
  }

  return (
    <div className="oc-invitation-screen">
      <section className="oc-invitation-letter">
        <div className="oc-invitation-letter__brand">
          <span>
            <Icon name="portfolio" size={18} />
          </span>
          BetterTrack
        </div>
        <small>PORTFOLIO INVITATION</small>
        <h2>You are invited to work on {portfolioName}</h2>
        <p>
          The owner is offering you <strong>{roleMeta[invitation.role].label}</strong> access. You
          will work with the same portfolio structure while your role limits what you can see and
          change.
        </p>
        <div className="oc-invitation-letter__facts">
          <div>
            <span>Role</span>
            <RoleBadge role={invitation.role} />
          </div>
          <div>
            <span>Data connection</span>
            <strong>
              <Icon name={model === 'mirrorchain' ? 'link' : 'copy'} size={14} />
              {model === 'mirrorchain' ? 'Live source' : 'Shared copy'}
            </strong>
          </div>
          <div>
            <span>Expires</span>
            <strong>{invitation.expiresAt ? formatDate(invitation.expiresAt) : 'Never'}</strong>
          </div>
          <div>
            <span>Hidden from you</span>
            <strong>{invitation.masks.length || 'Nothing'}</strong>
          </div>
        </div>
        <div className="oc-invitation-letter__permissions">
          <h3>What this role can do</h3>
          {roleMeta[invitation.role].capabilities.map((capability) => (
            <span key={capability}>
              <Icon name="check" size={13} />
              {capability}
            </span>
          ))}
        </div>
        {invitation.masks.length ? (
          <div className="oc-invitation-letter__masks">
            <Icon name="eye-off" size={16} />
            <div>
              <strong>Some portfolio details remain private</strong>
              <p>{invitation.masks.map((mask) => maskMeta[mask].label).join(', ')}</p>
            </div>
          </div>
        ) : null}
        <div className="oc-invitation-letter__actions">
          <Button onClick={() => onRespond(invitation, 'accepted')} tone="primary">
            Accept and open portfolio
          </Button>
          <Button onClick={() => onRespond(invitation, 'declined')} tone="ghost">
            Decline
          </Button>
        </div>
      </section>
      <aside className="oc-invitation-aside">
        <Icon name="shield" size={21} />
        <h3>Access stays understandable</h3>
        <p>
          Every role change, proposal, acceptance, and removal is recorded in the portfolio audit
          trail.
        </p>
        <span>Named account</span>
        <span>Revocable access</span>
        <span>Visible permission boundary</span>
      </aside>
    </div>
  );
}

function ForkWorkspace({
  fork,
  member,
  portfolioName,
  portfolioValue,
  currency,
}: {
  fork: UnsyncedFork;
  member: Member;
  portfolioName: string;
  portfolioValue: number;
  currency: string;
}) {
  return (
    <div className="oc-fork-workspace">
      <section className="oc-fork-hero">
        <span className="oc-fork-hero__icon">
          <Icon name="link" size={24} />
        </span>
        <small>UNSYNCED FORK</small>
        <h2>Your saved copy remains. The shared source does not.</h2>
        <p>
          {member.status === 'left'
            ? `You left ${portfolioName}.`
            : `The owner removed your access to ${portfolioName}.`}{' '}
          BetterTrack kept the data that was already synchronized as a private, frozen fork. New
          source activity and corrections will no longer arrive.
        </p>
        <div className="oc-fork-hero__state">
          <span>
            <Icon name="check" size={14} />
            {fork.recordCount.toLocaleString('en-IE')} records retained
          </span>
          <span>
            <Icon name="x" size={14} />
            Live sync stopped
          </span>
          <span>
            <Icon name="lock" size={14} />
            Private to {member.name}
          </span>
        </div>
      </section>
      <section className="oc-fork-ledger">
        <header>
          <div>
            <small>PORTFOLIO SNAPSHOT</small>
            <h3>{portfolioName} · personal fork</h3>
          </div>
          <span className="oc-status oc-status--unsynced">Unsynced</span>
        </header>
        <div className="oc-fork-ledger__metrics">
          <div>
            <span>Last known value</span>
            <strong>{formatMoney(portfolioValue, currency)}</strong>
          </div>
          <div>
            <span>Last synchronized</span>
            <strong>{formatDateTime(fork.lastSyncedAt)}</strong>
          </div>
          <div>
            <span>Source version</span>
            <strong>{fork.sourceVersion}</strong>
          </div>
        </div>
        <div className="oc-fork-ledger__rule">
          <Icon name="help" size={16} />
          <p>
            Editing this fork creates new private history. Rejoining the original portfolio does not
            merge those edits automatically; both histories must be reviewed explicitly.
          </p>
        </div>
      </section>
    </div>
  );
}

function PeopleView({
  actor,
  owner,
  activePeople,
  invitations,
  forks,
  model,
  portfolioName,
  portfolioValue,
  currency,
  onChangeModel,
  onChangeRole,
  onEditMasks,
  onRemove,
  onRevokeInvite,
  onTryRestricted,
  onOpenGuidedShare,
  onOpenTransfer,
  onLeave,
}: {
  actor?: Member;
  owner?: Member;
  activePeople: Member[];
  invitations: Invitation[];
  forks: UnsyncedFork[];
  model: ConnectionModel;
  portfolioName: string;
  portfolioValue: number;
  currency: string;
  onChangeModel: (model: ConnectionModel) => void;
  onChangeRole: (memberId: string, role: OriginCollaborationRole) => void;
  onEditMasks: (memberId: string, masks: MaskField[]) => void;
  onRemove: (memberId: string) => void;
  onRevokeInvite: (inviteId: string) => void;
  onTryRestricted: () => void;
  onOpenGuidedShare: () => void;
  onOpenTransfer: () => void;
  onLeave: (memberId: string) => void;
}) {
  const [focusedId, setFocusedId] = useState(actor?.id ?? owner?.id ?? activePeople[0]?.id ?? '');
  const [maskEditorId, setMaskEditorId] = useState<string | null>(null);
  const focused =
    activePeople.find((member) => member.id === focusedId) ?? actor ?? owner ?? activePeople[0];
  const maskTarget = activePeople.find((member) => member.id === maskEditorId);
  const canManage = Boolean(actor && ['owner', 'admin'].includes(actor.role));
  const pendingInvites = invitations.filter((invitation) => invitation.status === 'pending');

  useEffect(() => {
    if (actor) setFocusedId(actor.id);
  }, [actor]);

  return (
    <div className="oc-people-view">
      <section className="oc-summary-strip">
        <div>
          <small>ACTIVE PEOPLE</small>
          <strong>{activePeople.length}</strong>
          <span>
            {activePeople.filter((member) => member.role !== 'owner').length} collaborators
          </span>
        </div>
        <div>
          <small>PENDING</small>
          <strong>{pendingInvites.length}</strong>
          <span>{pendingInvites.length ? 'Awaiting a response' : 'No open invitations'}</span>
        </div>
        <div>
          <small>DATA MODEL</small>
          <strong>
            {model === 'mirrorchain' ? 'One source' : `${activePeople.length} copies`}
          </strong>
          <span>{model === 'mirrorchain' ? 'One governed ledger' : 'Synchronized per person'}</span>
        </div>
        <div>
          <small>VISIBLE VALUE</small>
          <strong>
            {actor?.masks.includes('total-value')
              ? 'Hidden'
              : formatMoney(portfolioValue, currency)}
          </strong>
          <span>For the current persona</span>
        </div>
      </section>

      <section className="oc-flat-module oc-model-module">
        <header className="oc-module-head">
          <div>
            <small>CONNECTION MODEL</small>
            <h2>How shared data stays connected</h2>
            <p>Access and data ownership remain separate, visible decisions.</p>
          </div>
          <span className="oc-module-head__signal">
            <span className="oc-live-dot" />
            Healthy
          </span>
        </header>
        <div className="oc-model-grid">
          <button
            aria-pressed={model === 'mirrorchain'}
            className={cx('oc-model-option', model === 'mirrorchain' && 'is-selected')}
            disabled={!canManage}
            onClick={() => onChangeModel('mirrorchain')}
            type="button"
          >
            <span className="oc-model-option__icon">
              <Icon name="link" size={18} />
            </span>
            <div>
              <strong>Live source</strong>
              <p>
                Everyone works against one governed portfolio. Roles control operations, while the
                canonical ledger stays singular.
              </p>
              <span>Best for ongoing teamwork</span>
            </div>
            <i>{model === 'mirrorchain' ? <Icon name="check" size={13} /> : null}</i>
          </button>
          <button
            aria-pressed={model === 'shared-copy'}
            className={cx('oc-model-option', model === 'shared-copy' && 'is-selected')}
            disabled={!canManage}
            onClick={() => onChangeModel('shared-copy')}
            type="button"
          >
            <span className="oc-model-option__icon">
              <Icon name="copy" size={18} />
            </span>
            <div>
              <strong>Shared copies</strong>
              <p>
                Each person gets a synchronized copy with an explicit link to the source and the
                same permission boundary.
              </p>
              <span>Best for independent workspaces</span>
            </div>
            <i>{model === 'shared-copy' ? <Icon name="check" size={13} /> : null}</i>
          </button>
        </div>
        <footer className="oc-model-foot">
          <Icon name="shield" size={14} />
          <span>
            If someone leaves or is removed, their last synchronized data becomes a labeled,
            unsynced fork. Source changes stop; their saved history does not vanish.
          </span>
        </footer>
      </section>

      <div className="oc-people-layout">
        <section className="oc-flat-module oc-people-list">
          <header className="oc-module-head oc-module-head--compact">
            <div>
              <small>PORTFOLIO ACCESS</small>
              <h2>People</h2>
            </div>
            {canManage ? (
              <Button icon="share" onClick={onOpenGuidedShare} tone="ghost">
                Guided sharing
              </Button>
            ) : null}
          </header>
          <div className="oc-table oc-table--people">
            <div className="oc-table__head">
              <span>Person</span>
              <span>Role</span>
              <span>Visibility</span>
              <span>Last active</span>
              <span aria-label="Actions" />
            </div>
            {activePeople
              .slice()
              .sort(
                (a, b) =>
                  roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role) ||
                  a.name.localeCompare(b.name),
              )
              .map((member) => (
                <div
                  className={cx('oc-person-row', focused?.id === member.id && 'is-focused')}
                  key={member.id}
                  onClick={() => setFocusedId(member.id)}
                >
                  <button
                    aria-pressed={focused?.id === member.id}
                    className="oc-person-row__identity"
                    onClick={(event) => {
                      event.stopPropagation();
                      setFocusedId(member.id);
                    }}
                    type="button"
                  >
                    <PersonAvatar name={member.name} size="small" />
                    <span>
                      <strong>{member.name}</strong>
                      <small>{member.email}</small>
                    </span>
                  </button>
                  <span onClick={(event) => event.stopPropagation()}>
                    {canManage && member.role !== 'owner' ? (
                      <select
                        aria-label={`Role for ${member.name}`}
                        onChange={(event) =>
                          onChangeRole(member.id, event.target.value as OriginCollaborationRole)
                        }
                        value={member.role}
                      >
                        {editableRoles.map((role) => (
                          <option key={role} value={role}>
                            {roleMeta[role].label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <RoleBadge compact role={member.role} />
                    )}
                  </span>
                  <span className="oc-person-row__visibility">
                    <Icon name={member.masks.length ? 'eye-off' : 'eye'} size={13} />
                    {member.masks.length ? `${member.masks.length} hidden` : 'All permitted'}
                  </span>
                  <span className="oc-person-row__seen">{member.lastSeen}</span>
                  <span className="oc-person-row__arrow">
                    <Icon name="chevron-right" size={14} />
                  </span>
                </div>
              ))}
          </div>
        </section>

        {focused ? (
          <aside className="oc-person-detail">
            <header>
              <PersonAvatar name={focused.name} size="large" />
              <div>
                <h3>{focused.name}</h3>
                <p>{focused.email}</p>
              </div>
              <RoleBadge compact role={focused.role} />
            </header>
            <div className="oc-person-detail__role">
              <small>ROLE BOUNDARY</small>
              <strong>{roleMeta[focused.role].summary}</strong>
              {roleMeta[focused.role].capabilities.map((capability) => (
                <span key={capability}>
                  <Icon name="check" size={12} />
                  {capability}
                </span>
              ))}
            </div>
            <div className="oc-person-detail__facts">
              <div>
                <span>Joined</span>
                <strong>{formatDate(focused.joinedAt)}</strong>
              </div>
              <div>
                <span>Expiry</span>
                <strong>{focused.expiresAt ? formatDate(focused.expiresAt) : 'No expiry'}</strong>
              </div>
              <div>
                <span>Data hidden</span>
                <strong>
                  {focused.masks.length ? `${focused.masks.length} fields` : 'Nothing'}
                </strong>
              </div>
            </div>
            {focused.masks.length ? (
              <div className="oc-mask-list">
                {focused.masks.map((mask) => (
                  <span key={mask}>{maskMeta[mask].label}</span>
                ))}
              </div>
            ) : null}
            {actor?.id === focused.id && actor.role === 'viewer' ? (
              <button className="oc-denied-demo" onClick={onTryRestricted} type="button">
                <span>
                  <Icon name="lock" size={15} />
                </span>
                <span>
                  <strong>Try editing a valuation</strong>
                  <small>Preview the viewer permission boundary</small>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            ) : null}
            <footer>
              {canManage && focused.role !== 'owner' ? (
                <>
                  <Button icon="eye" onClick={() => setMaskEditorId(focused.id)} tone="ghost">
                    Visibility
                  </Button>
                  <Button icon="trash" onClick={() => onRemove(focused.id)} tone="danger">
                    Remove
                  </Button>
                </>
              ) : null}
              {actor?.id === focused.id && focused.role !== 'owner' ? (
                <Button icon="x" onClick={() => onLeave(focused.id)} tone="danger">
                  Leave portfolio
                </Button>
              ) : null}
            </footer>
          </aside>
        ) : null}
      </div>

      <section className="oc-flat-module oc-invite-list">
        <header className="oc-module-head oc-module-head--compact">
          <div>
            <small>INVITATION LIFECYCLE</small>
            <h2>Open and recent invitations</h2>
          </div>
          <span>{invitations.length} total</span>
        </header>
        {invitations.length ? (
          <div className="oc-table oc-table--invites">
            <div className="oc-table__head">
              <span>Recipient</span>
              <span>Access</span>
              <span>Expiry</span>
              <span>Status</span>
              <span />
            </div>
            {invitations.map((invitation) => (
              <div className="oc-invite-row" key={invitation.id}>
                <span className="oc-invite-row__person">
                  <PersonAvatar name={invitation.name} size="small" />
                  <span>
                    <strong>{invitation.name}</strong>
                    <small>{invitation.email}</small>
                  </span>
                </span>
                <RoleBadge compact role={invitation.role} />
                <span>
                  {invitation.expiresAt ? formatDate(invitation.expiresAt) : 'Never'}
                  <small>{invitation.masks.length} hidden fields</small>
                </span>
                <span
                  className={cx(
                    'oc-status',
                    invitation.status === 'pending'
                      ? 'oc-status--pending'
                      : invitation.status === 'accepted'
                        ? 'oc-status--active'
                        : 'oc-status--muted',
                  )}
                >
                  {invitation.status}
                </span>
                <span>
                  {canManage && invitation.status === 'pending' ? (
                    <Button
                      aria-label={`Revoke invitation for ${invitation.name}`}
                      icon="x"
                      onClick={() => onRevokeInvite(invitation.id)}
                      tone="ghost"
                    >
                      Revoke
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon="inbox" title="No invitations yet">
            New invitations and their response history will appear here.
          </EmptyState>
        )}
      </section>

      {forks.length ? (
        <section className="oc-flat-module oc-fork-history">
          <header className="oc-module-head oc-module-head--compact">
            <div>
              <small>DISCONNECTED COPIES</small>
              <h2>Unsynced forks</h2>
            </div>
            <span>{forks.length}</span>
          </header>
          {forks.map((fork) => (
            <div className="oc-fork-row" key={fork.id}>
              <span>
                <Icon name="copy" size={15} />
              </span>
              <div>
                <strong>{fork.memberName}'s private fork</strong>
                <p>
                  {fork.reason === 'left' ? 'Left voluntarily' : 'Removed by owner'} ·{' '}
                  {fork.recordCount.toLocaleString('en-IE')} retained records
                </p>
              </div>
              <span>{formatDateTime(fork.lastSyncedAt)}</span>
              <span className="oc-status oc-status--unsynced">No longer syncing</span>
            </div>
          ))}
        </section>
      ) : null}

      {actor?.role === 'owner' ? (
        <section className="oc-ownership-rule">
          <div>
            <Icon name="key" size={17} />
            <div>
              <strong>Ownership is the custody boundary</strong>
              <p>It controls transfer, deletion, and final access authority for {portfolioName}.</p>
            </div>
          </div>
          <Button onClick={onOpenTransfer} tone="ghost">
            Transfer ownership
          </Button>
        </section>
      ) : null}

      {maskTarget ? (
        <MaskEditor
          member={maskTarget}
          onClose={() => setMaskEditorId(null)}
          onSave={(masks) => {
            onEditMasks(maskTarget.id, masks);
            setMaskEditorId(null);
          }}
        />
      ) : null}
    </div>
  );
}

function RequestsView({
  actor,
  proposals,
  currency,
  onCreateProposal,
  onSendToReview,
  onAddComment,
  onToggleReaction,
  onWithdraw,
  onOpenPeople,
}: {
  actor?: Member;
  proposals: RequestProposal[];
  currency: string;
  onCreateProposal: (draft: {
    type: OriginCollaborationProposalType;
    comment: string;
    attachmentName?: string;
    valuation?: RequestProposal['valuation'];
    trade?: RequestProposal['trade'];
  }) => void;
  onSendToReview: (proposal: RequestProposal) => void;
  onAddComment: (proposalId: string, body: string) => void;
  onToggleReaction: (proposalId: string) => void;
  onWithdraw: (proposal: RequestProposal) => void;
  onOpenPeople: () => void;
}) {
  const [selectedId, setSelectedId] = useState(proposals[0]?.id ?? '');
  const [composerOpen, setComposerOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | ProposalStatus>('all');
  const filtered = proposals.filter(
    (proposal) => statusFilter === 'all' || proposal.status === statusFilter,
  );
  const selected =
    proposals.find((proposal) => proposal.id === selectedId) ?? filtered[0] ?? proposals[0];
  const canRoute = Boolean(actor && ['owner', 'admin'].includes(actor.role));
  const canPropose = actor?.role === 'proposer';

  useEffect(() => {
    if (!selected && proposals[0]) setSelectedId(proposals[0].id);
  }, [proposals, selected]);

  return (
    <div className="oc-requests-view">
      <section className="oc-request-intro">
        <div>
          <small>GOVERNED CHANGES</small>
          <h2>Suggestions become traceable Review items</h2>
          <p>
            Proposers can structure a change and explain their reasoning. Owners decide when it is
            ready for the shared Review queue; nothing writes directly to the portfolio here.
          </p>
        </div>
        {canPropose ? (
          <Button icon="plus" onClick={() => setComposerOpen(true)} tone="primary">
            New proposal
          </Button>
        ) : actor?.role === 'viewer' ? (
          <Button icon="lock" onClick={onOpenPeople} tone="secondary">
            Viewer is read-only
          </Button>
        ) : null}
      </section>

      <div className="oc-request-workspace">
        <section className="oc-request-list">
          <header>
            <div>
              <small>REQUESTS</small>
              <strong>{filtered.length}</strong>
            </div>
            <select
              aria-label="Filter requests"
              onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
              value={statusFilter}
            >
              <option value="all">All states</option>
              <option value="submitted">Awaiting owner</option>
              <option value="sent-to-review">In Review</option>
              <option value="withdrawn">Withdrawn</option>
            </select>
          </header>
          {filtered.length ? (
            filtered.map((proposal) => (
              <button
                aria-pressed={selected?.id === proposal.id}
                className={cx('oc-request-item', selected?.id === proposal.id && 'is-selected')}
                key={proposal.id}
                onClick={() => setSelectedId(proposal.id)}
                type="button"
              >
                <span className="oc-request-item__icon">
                  <Icon name={proposal.type === 'trade' ? 'repeat' : 'house'} size={16} />
                </span>
                <span>
                  <small>{proposal.type.toUpperCase()}</small>
                  <strong>{proposal.title}</strong>
                  <em>
                    {proposal.submittedByName} · {formatDateTime(proposal.createdAt)}
                  </em>
                </span>
                <RequestStatus status={proposal.status} />
              </button>
            ))
          ) : (
            <EmptyState icon="inbox" title="Nothing in this state">
              Change the filter or submit a new proposal.
            </EmptyState>
          )}
        </section>

        {selected ? (
          <RequestDetail
            actor={actor}
            canRoute={canRoute}
            currency={currency}
            onAddComment={onAddComment}
            onSendToReview={onSendToReview}
            onToggleReaction={onToggleReaction}
            onWithdraw={onWithdraw}
            proposal={selected}
          />
        ) : (
          <section className="oc-request-detail">
            <EmptyState icon="workbench" title="No proposals yet">
              Switch to a proposer persona to draft the first structured change.
            </EmptyState>
          </section>
        )}
      </div>

      {composerOpen && actor ? (
        <ProposalComposer
          currency={currency}
          onClose={() => setComposerOpen(false)}
          onSubmit={(draft) => {
            onCreateProposal(draft);
            setComposerOpen(false);
          }}
          proposer={actor}
        />
      ) : null}
    </div>
  );
}

function RequestStatus({ status }: { status: ProposalStatus }) {
  const config: Record<ProposalStatus, { label: string; className: string; icon: IconName }> = {
    submitted: { label: 'Awaiting owner', className: 'oc-status--pending', icon: 'clock' },
    'sent-to-review': { label: 'In Review', className: 'oc-status--active', icon: 'shield' },
    withdrawn: { label: 'Withdrawn', className: 'oc-status--muted', icon: 'x' },
  };
  const item = config[status];
  return (
    <span className={cx('oc-status', item.className)}>
      <Icon name={item.icon} size={11} />
      {item.label}
    </span>
  );
}

function RequestDetail({
  proposal,
  actor,
  canRoute,
  currency,
  onSendToReview,
  onAddComment,
  onToggleReaction,
  onWithdraw,
}: {
  proposal: RequestProposal;
  actor?: Member;
  canRoute: boolean;
  currency: string;
  onSendToReview: (proposal: RequestProposal) => void;
  onAddComment: (proposalId: string, body: string) => void;
  onToggleReaction: (proposalId: string) => void;
  onWithdraw: (proposal: RequestProposal) => void;
}) {
  const [comment, setComment] = useState('');
  const reacted = actor ? proposal.reactionUserIds.includes(actor.id) : false;
  const delta =
    proposal.valuation && proposal.valuation.previousValue !== 0
      ? ((proposal.valuation.proposedValue - proposal.valuation.previousValue) /
          proposal.valuation.previousValue) *
        100
      : 0;

  return (
    <section className="oc-request-detail">
      <header className="oc-request-detail__head">
        <div>
          <div className="oc-request-detail__type">
            <span>{proposal.type.toUpperCase()}</span>
            <RequestStatus status={proposal.status} />
          </div>
          <h2>{proposal.title}</h2>
          <p>
            Submitted by {proposal.submittedByName} · {formatDateTime(proposal.createdAt)}
          </p>
        </div>
        <button
          aria-label={reacted ? 'Remove acknowledgement' : 'Acknowledge proposal'}
          aria-pressed={reacted}
          className={cx('oc-reaction', reacted && 'is-active')}
          onClick={() => onToggleReaction(proposal.id)}
          type="button"
        >
          <Icon name="check" size={13} />
          {proposal.reactionUserIds.length}
        </button>
      </header>

      {proposal.valuation ? (
        <div className="oc-change-sheet">
          <div>
            <small>ASSET</small>
            <strong>{proposal.valuation.asset}</strong>
            <span>{proposal.valuation.method}</span>
          </div>
          <div>
            <small>CURRENT VALUE</small>
            <strong>{formatMoney(proposal.valuation.previousValue, currency)}</strong>
            <span>Portfolio source</span>
          </div>
          <span className="oc-change-sheet__arrow">
            <Icon name="arrow-right" size={17} />
          </span>
          <div className="is-proposed">
            <small>PROPOSED VALUE</small>
            <strong>{formatMoney(proposal.valuation.proposedValue, currency)}</strong>
            <span className={delta >= 0 ? 'is-positive' : 'is-negative'}>
              {delta >= 0 ? '+' : ''}
              {delta.toFixed(2)}%
            </span>
          </div>
          <div>
            <small>EFFECTIVE</small>
            <strong>{formatDate(proposal.valuation.effectiveDate)}</strong>
            <span>Historical update</span>
          </div>
        </div>
      ) : proposal.trade ? (
        <div className="oc-change-sheet oc-change-sheet--trade">
          <div>
            <small>ACTION</small>
            <strong>{proposal.trade.side === 'buy' ? 'Buy' : 'Sell'}</strong>
            <span>Proposed trade</span>
          </div>
          <div>
            <small>ASSET</small>
            <strong>{proposal.trade.symbol}</strong>
            <span>{proposal.trade.quantity.toLocaleString('en-IE')} units</span>
          </div>
          <div>
            <small>LIMIT</small>
            <strong>{formatMoney(proposal.trade.limitPrice, currency)}</strong>
            <span>
              ≈ {formatMoney(proposal.trade.limitPrice * proposal.trade.quantity, currency)}
            </span>
          </div>
          <div>
            <small>FUNDING</small>
            <strong>{proposal.trade.fundingSource}</strong>
            <span>Cash checked in Review</span>
          </div>
        </div>
      ) : null}

      <div className="oc-request-context">
        <div>
          <small>PROPOSER NOTE</small>
          <p>{proposal.comment}</p>
        </div>
        <div>
          <small>SUPPORTING FILE</small>
          {proposal.attachmentName ? (
            <button type="button">
              <Icon name="document" size={14} />
              <span>{proposal.attachmentName}</span>
              <Icon name="download" size={13} />
            </button>
          ) : (
            <p>No attachment supplied.</p>
          )}
        </div>
      </div>

      <div className="oc-permission-route">
        <div className="is-done">
          <span>
            <Icon name="check" size={13} />
          </span>
          <div>
            <strong>Structured by proposer</strong>
            <small>No write permission used</small>
          </div>
        </div>
        <i />
        <div className={cx(proposal.status !== 'withdrawn' && 'is-current')}>
          <span>
            <Icon name="eye" size={13} />
          </span>
          <div>
            <strong>Owner triage</strong>
            <small>Context and completeness</small>
          </div>
        </div>
        <i />
        <div className={cx(proposal.status === 'sent-to-review' && 'is-done')}>
          <span>
            <Icon name="shield" size={13} />
          </span>
          <div>
            <strong>Shared Review</strong>
            <small>{proposal.reviewReference ?? 'Not sent yet'}</small>
          </div>
        </div>
      </div>

      <div className="oc-thread">
        <header>
          <div>
            <Icon name="message" size={14} />
            <strong>Discussion</strong>
          </div>
          <span>{proposal.comments.length} comments</span>
        </header>
        <div className="oc-thread__messages">
          {proposal.comments.length ? (
            proposal.comments.map((item) => (
              <div className="oc-comment" key={item.id}>
                <PersonAvatar name={item.authorName} size="small" />
                <div>
                  <span>
                    <strong>{item.authorName}</strong>
                    <small>{formatDateTime(item.at)}</small>
                  </span>
                  <p>{item.body}</p>
                </div>
              </div>
            ))
          ) : (
            <p className="oc-thread__empty">No discussion yet. Add context for the reviewer.</p>
          )}
        </div>
        {actor && proposal.status !== 'withdrawn' ? (
          <form
            className="oc-comment-box"
            onSubmit={(event) => {
              event.preventDefault();
              onAddComment(proposal.id, comment);
              setComment('');
            }}
          >
            <PersonAvatar name={actor.name} size="small" />
            <input
              aria-label="Add a comment"
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add context or ask a question…"
              value={comment}
            />
            <Button disabled={!comment.trim()} icon="arrow-right" tone="ghost" type="submit">
              Comment
            </Button>
          </form>
        ) : null}
      </div>

      <footer className="oc-request-actions">
        <div>
          <Icon name="lock" size={13} />
          <span>
            Routing this request does not apply it. Review remains the final write boundary.
          </span>
        </div>
        {actor?.id === proposal.submittedById && proposal.status === 'submitted' ? (
          <Button onClick={() => onWithdraw(proposal)} tone="ghost">
            Withdraw
          </Button>
        ) : null}
        {canRoute ? (
          <Button
            disabled={proposal.status !== 'submitted'}
            icon={proposal.status === 'sent-to-review' ? 'check' : 'shield'}
            onClick={() => onSendToReview(proposal)}
            tone="primary"
          >
            {proposal.status === 'sent-to-review' ? 'Sent to Review' : 'Send to shared Review'}
          </Button>
        ) : null}
      </footer>
    </section>
  );
}

function ProposalComposer({
  proposer,
  currency,
  onClose,
  onSubmit,
}: {
  proposer: Member;
  currency: string;
  onClose: () => void;
  onSubmit: (draft: {
    type: OriginCollaborationProposalType;
    comment: string;
    attachmentName?: string;
    valuation?: RequestProposal['valuation'];
    trade?: RequestProposal['trade'];
  }) => void;
}) {
  const [type, setType] = useState<OriginCollaborationProposalType>('valuation');
  const [asset, setAsset] = useState('Riverside property');
  const [previousValue, setPreviousValue] = useState('138400');
  const [proposedValue, setProposedValue] = useState('145000');
  const [method, setMethod] = useState('Independent appraisal');
  const [effectiveDate, setEffectiveDate] = useState('2026-07-25');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [symbol, setSymbol] = useState('VWCE');
  const [quantity, setQuantity] = useState('12');
  const [limitPrice, setLimitPrice] = useState('132.40');
  const [fundingSource, setFundingSource] = useState('EUR cash');
  const [comment, setComment] = useState('');
  const [attachmentName, setAttachmentName] = useState('');
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLFormElement>(onClose);

  const valid =
    comment.trim().length >= 8 &&
    (type === 'valuation'
      ? Boolean(asset.trim() && Number(proposedValue) > 0 && effectiveDate)
      : Boolean(symbol.trim() && Number(quantity) > 0 && Number(limitPrice) > 0));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    onSubmit({
      type,
      comment: comment.trim(),
      attachmentName: attachmentName || undefined,
      valuation:
        type === 'valuation'
          ? {
              asset: asset.trim(),
              previousValue: Number(previousValue),
              proposedValue: Number(proposedValue),
              method,
              effectiveDate,
            }
          : undefined,
      trade:
        type === 'trade'
          ? {
              side,
              symbol: symbol.trim().toUpperCase(),
              quantity: Number(quantity),
              limitPrice: Number(limitPrice),
              fundingSource,
            }
          : undefined,
    });
  }

  return (
    <div className="oc-overlay" role="presentation">
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className="oc-dialog oc-proposal-composer"
        onSubmit={submit}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="oc-dialog__head">
          <div>
            <small>PROPOSAL BY {proposer.name.toUpperCase()}</small>
            <h2 id={titleId}>Suggest a portfolio change</h2>
            <p>Your role can structure and explain this change, but cannot apply it.</p>
          </div>
          <button aria-label="Close proposal composer" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="oc-proposal-kind">
          <button
            aria-pressed={type === 'valuation'}
            className={cx(type === 'valuation' && 'is-active')}
            onClick={() => setType('valuation')}
            type="button"
          >
            <Icon name="house" size={17} />
            <span>
              <strong>Valuation</strong>
              <small>Update a manually valued asset</small>
            </span>
          </button>
          <button
            aria-pressed={type === 'trade'}
            className={cx(type === 'trade' && 'is-active')}
            onClick={() => setType('trade')}
            type="button"
          >
            <Icon name="repeat" size={17} />
            <span>
              <strong>Trade</strong>
              <small>Stage a purchase or sale</small>
            </span>
          </button>
        </div>

        <div className="oc-dialog__body">
          {type === 'valuation' ? (
            <div className="oc-form-grid">
              <label className="oc-field oc-field--wide">
                <span>Asset</span>
                <input onChange={(event) => setAsset(event.target.value)} value={asset} />
              </label>
              <label className="oc-field">
                <span>Current value</span>
                <div className="oc-money-input">
                  <i>{currency}</i>
                  <input
                    min="0"
                    onChange={(event) => setPreviousValue(event.target.value)}
                    step="100"
                    type="number"
                    value={previousValue}
                  />
                </div>
              </label>
              <label className="oc-field">
                <span>Proposed value</span>
                <div className="oc-money-input">
                  <i>{currency}</i>
                  <input
                    min="0"
                    onChange={(event) => setProposedValue(event.target.value)}
                    step="100"
                    type="number"
                    value={proposedValue}
                  />
                </div>
              </label>
              <label className="oc-field">
                <span>Valuation method</span>
                <select onChange={(event) => setMethod(event.target.value)} value={method}>
                  <option>Independent appraisal</option>
                  <option>Comparable sales</option>
                  <option>Broker statement</option>
                  <option>Manual owner estimate</option>
                </select>
              </label>
              <label className="oc-field">
                <span>Effective date</span>
                <input
                  onChange={(event) => setEffectiveDate(event.target.value)}
                  type="date"
                  value={effectiveDate}
                />
              </label>
            </div>
          ) : (
            <div className="oc-form-grid">
              <label className="oc-field">
                <span>Side</span>
                <select
                  onChange={(event) => setSide(event.target.value as 'buy' | 'sell')}
                  value={side}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                </select>
              </label>
              <label className="oc-field">
                <span>Symbol / ISIN</span>
                <input onChange={(event) => setSymbol(event.target.value)} value={symbol} />
              </label>
              <label className="oc-field">
                <span>Quantity</span>
                <input
                  min="0.0001"
                  onChange={(event) => setQuantity(event.target.value)}
                  step="0.0001"
                  type="number"
                  value={quantity}
                />
              </label>
              <label className="oc-field">
                <span>Limit price ({currency})</span>
                <input
                  min="0"
                  onChange={(event) => setLimitPrice(event.target.value)}
                  step="0.01"
                  type="number"
                  value={limitPrice}
                />
              </label>
              <label className="oc-field oc-field--wide">
                <span>Funding source</span>
                <select
                  onChange={(event) => setFundingSource(event.target.value)}
                  value={fundingSource}
                >
                  <option>EUR cash</option>
                  <option>USD cash</option>
                  <option>Reinvest sale proceeds</option>
                </select>
              </label>
            </div>
          )}

          <label className="oc-field">
            <span>Reason and context</span>
            <textarea
              onChange={(event) => setComment(event.target.value)}
              placeholder="Explain why this change belongs in the portfolio and what the owner should verify…"
              rows={4}
              value={comment}
            />
            <small>{comment.trim().length}/8 minimum characters</small>
          </label>

          <label className="oc-attachment">
            <input
              onChange={(event) => setAttachmentName(event.target.files?.[0]?.name ?? '')}
              type="file"
            />
            <span>
              <Icon name={attachmentName ? 'check' : 'upload'} size={17} />
            </span>
            <div>
              <strong>{attachmentName || 'Attach supporting evidence'}</strong>
              <small>
                {attachmentName
                  ? 'File name will travel with the demo request'
                  : 'Appraisal, statement, trade note, or research PDF'}
              </small>
            </div>
            {attachmentName ? (
              <button
                onClick={(event) => {
                  event.preventDefault();
                  setAttachmentName('');
                }}
                type="button"
              >
                Remove
              </button>
            ) : (
              <em>Choose file</em>
            )}
          </label>
        </div>

        <footer className="oc-dialog__foot">
          <div>
            <Icon name="shield" size={14} />
            Owner triage, then shared Review
          </div>
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <button className="oc-button oc-button--primary" disabled={!valid} type="submit">
            <Icon name="arrow-right" size={15} />
            <span>Submit proposal</span>
          </button>
        </footer>
      </form>
    </div>
  );
}

function GroupsView({
  actor,
  groups,
  members,
  onSave,
  onUse,
  onDelete,
}: {
  actor?: Member;
  groups: AudienceGroup[];
  members: Member[];
  onSave: (draft: {
    id?: string;
    name: string;
    description: string;
    memberIds: string[];
    defaultRole: OriginCollaborationRole;
    masks: MaskField[];
  }) => void;
  onUse: (group: AudienceGroup) => void;
  onDelete: (group: AudienceGroup) => void;
}) {
  const [editor, setEditor] = useState<AudienceGroup | 'new' | null>(null);
  const canManage = Boolean(actor && ['owner', 'admin'].includes(actor.role));

  return (
    <div className="oc-groups-view">
      <section className="oc-group-intro">
        <div>
          <small>REUSABLE AUDIENCES</small>
          <h2>Define the people once, reuse the intent</h2>
          <p>
            Groups remember an audience, default role, and privacy baseline. Applying one to another
            portfolio still opens a reviewable sharing flow—it never silently grants access.
          </p>
        </div>
        {canManage ? (
          <Button icon="plus" onClick={() => setEditor('new')} tone="primary">
            New group
          </Button>
        ) : null}
      </section>

      <section className="oc-group-grid">
        {groups.map((group) => {
          const groupMembers = group.memberIds
            .map((memberId) => members.find((member) => member.id === memberId))
            .filter((member): member is Member => Boolean(member));
          return (
            <article className="oc-group-card" key={group.id}>
              <header>
                <span className="oc-group-card__icon">
                  <Icon name="people" size={17} />
                </span>
                <div>
                  <h3>{group.name}</h3>
                  <p>{group.description}</p>
                </div>
                <button aria-label={`More actions for ${group.name}`} type="button">
                  <Icon name="more" size={16} />
                </button>
              </header>
              <div className="oc-group-card__defaults">
                <div>
                  <small>DEFAULT ACCESS</small>
                  <RoleBadge compact role={group.defaultRole} />
                </div>
                <div>
                  <small>PRIVACY BASELINE</small>
                  <strong>
                    <Icon name={group.masks.length ? 'eye-off' : 'eye'} size={13} />
                    {group.masks.length ? `${group.masks.length} hidden fields` : 'No masks'}
                  </strong>
                </div>
              </div>
              <div className="oc-group-card__people">
                <span className="oc-avatar-stack">
                  {groupMembers.slice(0, 4).map((member) => (
                    <PersonAvatar key={member.id} name={member.name} size="small" />
                  ))}
                </span>
                <div>
                  <strong>
                    {groupMembers.length} {groupMembers.length === 1 ? 'person' : 'people'}
                  </strong>
                  <span>
                    {groupMembers.map((member) => member.name).join(', ') || 'Empty group'}
                  </span>
                </div>
              </div>
              <footer>
                <Button icon="share" onClick={() => onUse(group)} tone="secondary">
                  Use group
                </Button>
                {canManage ? (
                  <>
                    <Button icon="sliders" onClick={() => setEditor(group)} tone="ghost">
                      Edit
                    </Button>
                    <Button icon="trash" onClick={() => onDelete(group)} tone="ghost">
                      Delete
                    </Button>
                  </>
                ) : null}
              </footer>
            </article>
          );
        })}
        {groups.length === 0 ? (
          <div className="oc-group-empty">
            <EmptyState
              action={
                canManage ? (
                  <Button icon="plus" onClick={() => setEditor('new')} tone="primary">
                    Create first group
                  </Button>
                ) : undefined
              }
              icon="people"
              title="No reusable audiences"
            >
              Groups make repeated portfolio access easier to reason about.
            </EmptyState>
          </div>
        ) : null}
      </section>

      <section className="oc-group-explainer">
        <div>
          <span>1</span>
          <div>
            <strong>Choose an audience</strong>
            <p>People remain named accounts, never an anonymous link.</p>
          </div>
        </div>
        <i />
        <div>
          <span>2</span>
          <div>
            <strong>Review role and masks</strong>
            <p>Group defaults are a starting point you can change per portfolio.</p>
          </div>
        </div>
        <i />
        <div>
          <span>3</span>
          <div>
            <strong>Send named invitations</strong>
            <p>Each person accepts independently and appears in the audit trail.</p>
          </div>
        </div>
      </section>

      {editor ? (
        <GroupEditor
          group={editor === 'new' ? undefined : editor}
          members={members.filter((member) => member.role !== 'owner')}
          onClose={() => setEditor(null)}
          onSave={(draft) => {
            onSave(draft);
            setEditor(null);
          }}
        />
      ) : null}
    </div>
  );
}

function GroupEditor({
  group,
  members,
  onClose,
  onSave,
}: {
  group?: AudienceGroup;
  members: Member[];
  onClose: () => void;
  onSave: (draft: {
    id?: string;
    name: string;
    description: string;
    memberIds: string[];
    defaultRole: OriginCollaborationRole;
    masks: MaskField[];
  }) => void;
}) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [memberIds, setMemberIds] = useState<string[]>(group?.memberIds ?? []);
  const [defaultRole, setDefaultRole] = useState<OriginCollaborationRole>(
    group?.defaultRole ?? 'viewer',
  );
  const [masks, setMasks] = useState<MaskField[]>(
    group?.masks ?? ['cost-basis', 'personal-labels'],
  );
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLFormElement>(onClose);

  function toggleMember(id: string) {
    setMemberIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleMask(mask: MaskField) {
    setMasks((current) =>
      current.includes(mask) ? current.filter((item) => item !== mask) : [...current, mask],
    );
  }

  return (
    <div className="oc-overlay" role="presentation">
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className="oc-dialog oc-group-editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || memberIds.length === 0) return;
          onSave({
            id: group?.id,
            name,
            description,
            memberIds,
            defaultRole,
            masks,
          });
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="oc-dialog__head">
          <div>
            <small>{group ? 'EDIT AUDIENCE' : 'NEW AUDIENCE'}</small>
            <h2 id={titleId}>{group ? group.name : 'Create a reusable group'}</h2>
            <p>Defaults are reviewed again whenever this group is used.</p>
          </div>
          <button aria-label="Close group editor" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="oc-dialog__body">
          <div className="oc-form-grid">
            <label className="oc-field">
              <span>Group name</span>
              <input
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. External tax team"
                value={name}
              />
            </label>
            <label className="oc-field">
              <span>Default role</span>
              <select
                onChange={(event) => setDefaultRole(event.target.value as OriginCollaborationRole)}
                value={defaultRole}
              >
                {editableRoles.map((role) => (
                  <option key={role} value={role}>
                    {roleMeta[role].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="oc-field oc-field--wide">
              <span>Description</span>
              <textarea
                onChange={(event) => setDescription(event.target.value)}
                placeholder="When should this audience be used?"
                rows={3}
                value={description}
              />
            </label>
          </div>

          <fieldset className="oc-choice-fieldset">
            <legend>People</legend>
            <div className="oc-member-choices">
              {members.map((member) => (
                <label key={member.id}>
                  <input
                    checked={memberIds.includes(member.id)}
                    onChange={() => toggleMember(member.id)}
                    type="checkbox"
                  />
                  <PersonAvatar name={member.name} size="small" />
                  <span>
                    <strong>{member.name}</strong>
                    <small>{member.email}</small>
                  </span>
                  <RoleBadge compact role={member.role} />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="oc-choice-fieldset">
            <legend>Fields hidden by default</legend>
            <div className="oc-mask-choices oc-mask-choices--compact">
              {(Object.keys(maskMeta) as MaskField[]).map((mask) => (
                <label key={mask}>
                  <input
                    checked={masks.includes(mask)}
                    onChange={() => toggleMask(mask)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{maskMeta[mask].label}</strong>
                    <small>{maskMeta[mask].description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <footer className="oc-dialog__foot">
          <span>{memberIds.length} people selected</span>
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <button
            className="oc-button oc-button--primary"
            disabled={!name.trim() || memberIds.length === 0}
            type="submit"
          >
            <Icon name="check" size={14} />
            <span>{group ? 'Save group' : 'Create group'}</span>
          </button>
        </footer>
      </form>
    </div>
  );
}

function AuditView({ entries, onReset }: { entries: AuditEntry[]; onReset: () => void }) {
  const [query, setQuery] = useState('');
  const [entity, setEntity] = useState<AuditEntry['entity'] | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(entries[0]?.id ?? null);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return entries.filter(
      (entry) =>
        (entity === 'all' || entry.entity === entity) &&
        (!search ||
          entry.actor.toLowerCase().includes(search) ||
          entry.action.toLowerCase().includes(search) ||
          entry.detail.toLowerCase().includes(search)),
    );
  }, [entries, entity, query]);

  function exportAudit() {
    const csv = [
      ['Timestamp', 'Actor', 'Category', 'Action', 'Detail'],
      ...filtered.map((entry) => [
        entry.at,
        entry.actor,
        auditEntityLabels[entry.entity],
        entry.action,
        entry.detail,
      ]),
    ]
      .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'bettertrack-collaboration-audit.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="oc-audit-view">
      <section className="oc-audit-head">
        <div>
          <small>ACCOUNTABILITY</small>
          <h2>Portfolio collaboration audit</h2>
          <p>
            An append-style demo record of access, proposals, audience changes, and data
            disconnections.
          </p>
        </div>
        <div>
          <Button icon="download" onClick={exportAudit} tone="secondary">
            Export CSV
          </Button>
        </div>
      </section>

      <section className="oc-audit-controls">
        <label className="oc-search">
          <Icon name="search" size={14} />
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actor, action, or detail"
            value={query}
          />
        </label>
        <label>
          <span>Event type</span>
          <select
            onChange={(event) => setEntity(event.target.value as typeof entity)}
            value={entity}
          >
            <option value="all">All events</option>
            {(Object.keys(auditEntityLabels) as AuditEntry['entity'][]).map((item) => (
              <option key={item} value={item}>
                {auditEntityLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <span>
          {filtered.length} of {entries.length} events
        </span>
      </section>

      <section className="oc-audit-ledger">
        <div className="oc-audit-ledger__head">
          <span>Time</span>
          <span>Actor</span>
          <span>Event</span>
          <span>Category</span>
          <span />
        </div>
        {filtered.length ? (
          filtered.map((entry) => (
            <button
              className={cx('oc-audit-entry', expandedId === entry.id && 'is-expanded')}
              key={entry.id}
              onClick={() => setExpandedId((current) => (current === entry.id ? null : entry.id))}
              type="button"
            >
              <span className="oc-audit-entry__time">
                <strong>{formatDateTime(entry.at)}</strong>
                <small>{entry.id}</small>
              </span>
              <span className="oc-audit-entry__actor">
                <PersonAvatar name={entry.actor} size="small" />
                <strong>{entry.actor}</strong>
              </span>
              <span className="oc-audit-entry__event">
                <i className={`is-${entry.tone}`} />
                <span>
                  <strong>{entry.action}</strong>
                  <small>{entry.detail}</small>
                </span>
              </span>
              <span className="oc-audit-entry__category">{auditEntityLabels[entry.entity]}</span>
              <span>
                <Icon name={expandedId === entry.id ? 'chevron-down' : 'chevron-right'} size={14} />
              </span>
              {expandedId === entry.id ? (
                <span className="oc-audit-entry__receipt">
                  <span>
                    <small>EVENT ID</small>
                    <strong>{entry.id}</strong>
                  </span>
                  <span>
                    <small>ACTOR ID</small>
                    <strong>{entry.actorId}</strong>
                  </span>
                  <span>
                    <small>RECORDED</small>
                    <strong>{entry.at}</strong>
                  </span>
                  <span>
                    <small>INTEGRITY</small>
                    <strong>
                      <Icon name="shield" size={12} /> Demo receipt retained
                    </strong>
                  </span>
                </span>
              ) : null}
            </button>
          ))
        ) : (
          <EmptyState icon="search" title="No matching audit events">
            Try a different category or search phrase.
          </EmptyState>
        )}
      </section>

      <footer className="oc-audit-foot">
        <div>
          <Icon name="database" size={14} />
          <span>
            Demo state is stored locally under the <code>bt-demo-collaboration-*</code> key.
          </span>
        </div>
        <Button onClick={onReset} tone="ghost">
          Reset collaboration demo
        </Button>
      </footer>
    </div>
  );
}

function InviteComposer({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (draft: {
    email: string;
    role: OriginCollaborationRole;
    masks: MaskField[];
    expiry: Expiry;
  }) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OriginCollaborationRole>('viewer');
  const [masks, setMasks] = useState<MaskField[]>(['cost-basis', 'personal-labels']);
  const [expiry, setExpiry] = useState<Expiry>('30-days');
  const [step, setStep] = useState<'access' | 'privacy'>('access');
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLFormElement>(onClose);

  function toggleMask(mask: MaskField) {
    setMasks((current) =>
      current.includes(mask) ? current.filter((item) => item !== mask) : [...current, mask],
    );
  }

  return (
    <div className="oc-overlay" role="presentation">
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className="oc-dialog oc-invite-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === 'access') {
            if (emailValid) setStep('privacy');
            return;
          }
          onSubmit({ email, role, masks, expiry });
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="oc-dialog__head">
          <div>
            <small>INVITE PERSON · {step === 'access' ? '1 OF 2' : '2 OF 2'}</small>
            <h2 id={titleId}>
              {step === 'access' ? 'Who should join?' : 'Set the privacy boundary'}
            </h2>
            <p>
              {step === 'access'
                ? 'Use a named account and give it one clear job.'
                : 'Mask details independently from the role and set an expiry.'}
            </p>
          </div>
          <button aria-label="Close invitation" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="oc-step-track">
          <span className="is-active">
            <i>1</i> Person & role
          </span>
          <em />
          <span className={cx(step === 'privacy' && 'is-active')}>
            <i>2</i> Privacy & expiry
          </span>
        </div>

        <div className="oc-dialog__body">
          {step === 'access' ? (
            <>
              <label className="oc-field">
                <span>Email address</span>
                <input
                  autoFocus
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="person@example.com"
                  type="email"
                  value={email}
                />
                <small>The invitation is tied to this BetterTrack account.</small>
              </label>
              <fieldset className="oc-role-picker">
                <legend>Role</legend>
                {editableRoles.map((item) => (
                  <label className={cx(role === item && 'is-selected')} key={item}>
                    <input
                      checked={role === item}
                      name="invite-role"
                      onChange={() => setRole(item)}
                      type="radio"
                    />
                    <span className={`is-${roleMeta[item].tone}`}>
                      <Icon name={roleMeta[item].icon} size={15} />
                    </span>
                    <div>
                      <strong>{roleMeta[item].label}</strong>
                      <p>{roleMeta[item].summary}</p>
                    </div>
                    <Icon name={role === item ? 'check' : 'chevron-right'} size={13} />
                  </label>
                ))}
              </fieldset>
            </>
          ) : (
            <>
              <div className="oc-invite-summary">
                <PersonAvatar name={nameFromEmail(email)} />
                <div>
                  <strong>{email}</strong>
                  <RoleBadge compact role={role} />
                </div>
                <button onClick={() => setStep('access')} type="button">
                  Edit
                </button>
              </div>
              <fieldset className="oc-choice-fieldset">
                <legend>Hide these fields</legend>
                <div className="oc-mask-choices">
                  {(Object.keys(maskMeta) as MaskField[]).map((mask) => (
                    <label key={mask}>
                      <input
                        checked={masks.includes(mask)}
                        onChange={() => toggleMask(mask)}
                        type="checkbox"
                      />
                      <span>
                        <strong>{maskMeta[mask].label}</strong>
                        <small>{maskMeta[mask].description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="oc-field">
                <span>Access expires</span>
                <select
                  onChange={(event) => setExpiry(event.target.value as Expiry)}
                  value={expiry}
                >
                  <option value="7-days">After 7 days</option>
                  <option value="30-days">After 30 days</option>
                  <option value="90-days">After 90 days</option>
                  <option value="never">Never</option>
                </select>
                <small>Owners can revoke access at any time, regardless of expiry.</small>
              </label>
            </>
          )}
        </div>

        <footer className="oc-dialog__foot">
          <div>
            <Icon name="shield" size={14} />
            Named, revocable, audited access
          </div>
          {step === 'privacy' ? (
            <Button onClick={() => setStep('access')} tone="ghost">
              Back
            </Button>
          ) : (
            <Button onClick={onClose} tone="ghost">
              Cancel
            </Button>
          )}
          <button className="oc-button oc-button--primary" disabled={!emailValid} type="submit">
            <span>{step === 'access' ? 'Continue' : 'Prepare invitation'}</span>
            <Icon name="arrow-right" size={14} />
          </button>
        </footer>
      </form>
    </div>
  );
}

function MaskEditor({
  member,
  onClose,
  onSave,
}: {
  member: Member;
  onClose: () => void;
  onSave: (masks: MaskField[]) => void;
}) {
  const [masks, setMasks] = useState<MaskField[]>(member.masks);
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLDivElement>(onClose);

  function toggle(mask: MaskField) {
    setMasks((current) =>
      current.includes(mask) ? current.filter((item) => item !== mask) : [...current, mask],
    );
  }

  return (
    <div className="oc-overlay" role="presentation">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="oc-dialog oc-mask-editor"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="oc-dialog__head">
          <div>
            <small>DATA VISIBILITY</small>
            <h2 id={titleId}>What can {member.name} see?</h2>
            <p>Role permissions still apply. These masks further reduce visible portfolio data.</p>
          </div>
          <button aria-label="Close visibility editor" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="oc-dialog__body">
          <div className="oc-visibility-person">
            <PersonAvatar name={member.name} />
            <div>
              <strong>{member.name}</strong>
              <span>{member.email}</span>
            </div>
            <RoleBadge compact role={member.role} />
          </div>
          <div className="oc-mask-choices">
            {(Object.keys(maskMeta) as MaskField[]).map((mask) => (
              <label key={mask}>
                <input
                  checked={masks.includes(mask)}
                  onChange={() => toggle(mask)}
                  type="checkbox"
                />
                <span>
                  <strong>Hide {maskMeta[mask].label.toLowerCase()}</strong>
                  <small>{maskMeta[mask].description}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="oc-visibility-preview">
            <span>
              <Icon name={masks.length ? 'eye-off' : 'eye'} size={16} />
            </span>
            <div>
              <strong>
                {masks.length ? `${masks.length} fields will be hidden` : 'No additional masks'}
              </strong>
              <p>
                {masks.length
                  ? masks.map((mask) => maskMeta[mask].label).join(', ')
                  : 'The member sees everything their role permits.'}
              </p>
            </div>
          </div>
        </div>
        <footer className="oc-dialog__foot">
          <span>Changes are recorded in Audit.</span>
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <Button icon="check" onClick={() => onSave(masks)} tone="primary">
            Save visibility
          </Button>
        </footer>
      </div>
    </div>
  );
}

function OwnershipTransfer({
  owner,
  members,
  portfolioName,
  onClose,
  onTransfer,
}: {
  owner: Member;
  members: Member[];
  portfolioName: string;
  onClose: () => void;
  onTransfer: (targetId: string) => void;
}) {
  const eligible = members.filter((member) => member.status === 'active');
  const [targetId, setTargetId] = useState(eligible[0]?.id ?? '');
  const [confirmation, setConfirmation] = useState('');
  const target = eligible.find((member) => member.id === targetId);
  const valid = Boolean(target && confirmation === portfolioName);
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLFormElement>(onClose);

  return (
    <div className="oc-overlay" role="presentation">
      <form
        aria-labelledby={titleId}
        aria-modal="true"
        className="oc-dialog oc-transfer"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onTransfer(targetId);
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="oc-dialog__head">
          <div>
            <small>OWNERSHIP TRANSFER</small>
            <h2 id={titleId}>Move the custody boundary</h2>
            <p>This changes who can transfer, delete, and exercise final access authority.</p>
          </div>
          <button aria-label="Close ownership transfer" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="oc-dialog__body">
          <div className="oc-transfer-route">
            <div>
              <PersonAvatar name={owner.name} />
              <span>
                <small>CURRENT OWNER</small>
                <strong>{owner.name}</strong>
                <em>Becomes administrator</em>
              </span>
            </div>
            <Icon name="arrow-right" size={18} />
            <div>
              {target ? <PersonAvatar name={target.name} /> : <span className="oc-avatar">?</span>}
              <span>
                <small>NEW OWNER</small>
                <strong>{target?.name ?? 'Choose a person'}</strong>
                <em>Receives full custody</em>
              </span>
            </div>
          </div>
          <label className="oc-field">
            <span>New owner</span>
            <select onChange={(event) => setTargetId(event.target.value)} value={targetId}>
              {eligible.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} · currently {roleMeta[member.role].label}
                </option>
              ))}
            </select>
          </label>
          <div className="oc-transfer-warning">
            <Icon name="shield" size={17} />
            <div>
              <strong>This takes effect immediately in the demo</strong>
              <p>
                The new owner receives unmasked, non-expiring access. You remain an administrator.
                Every step is recorded in Audit.
              </p>
            </div>
          </div>
          <label className="oc-field oc-confirm-field">
            <span>
              Type <strong>{portfolioName}</strong> to confirm
            </span>
            <input
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={portfolioName}
              value={confirmation}
            />
            <small className={cx(confirmation && !valid && 'is-error')}>
              {confirmation && !valid
                ? 'Portfolio name does not match.'
                : 'Case-sensitive confirmation'}
            </small>
          </label>
        </div>
        <footer className="oc-dialog__foot">
          <span>This action is simulated and persists locally.</span>
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <button className="oc-button oc-button--danger" disabled={!valid} type="submit">
            <Icon name="key" size={14} />
            <span>Transfer ownership</span>
          </button>
        </footer>
      </form>
    </div>
  );
}

function LifecycleConfirmation({
  action,
  member,
  invitation,
  model,
  onCancel,
  onConfirm,
}: {
  action: Exclude<ConfirmationAction, null>;
  member?: Member;
  invitation?: Invitation;
  model: ConnectionModel;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const revoke = action.kind === 'revoke-invite';
  const leaving = action.kind === 'leave';
  const name = revoke ? invitation?.name : member?.name;
  const titleId = useId();
  const dialogRef = useModalDialog<HTMLDivElement>(onCancel);

  return (
    <div className="oc-overlay" role="presentation">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="oc-dialog oc-lifecycle-dialog"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <header className="oc-dialog__head">
          <div>
            <small>
              {revoke ? 'REVOKE INVITATION' : leaving ? 'LEAVE PORTFOLIO' : 'REMOVE ACCESS'}
            </small>
            <h2 id={titleId}>
              {revoke
                ? `Close ${name ?? 'this'}'s invitation?`
                : leaving
                  ? 'Disconnect from the shared source?'
                  : `Remove ${name ?? 'this person'}?`}
            </h2>
            <p>
              {revoke
                ? 'The invitation can no longer be accepted. No portfolio data has been shared.'
                : 'Live source access stops immediately. Already synchronized data is handled explicitly.'}
            </p>
          </div>
          <button aria-label="Close confirmation" onClick={onCancel} type="button">
            <Icon name="x" size={16} />
          </button>
        </header>
        {!revoke ? (
          <div className="oc-lifecycle-outcome">
            <div className="is-stopped">
              <Icon name="x" size={15} />
              <div>
                <strong>What stops</strong>
                <p>New holdings, activity, corrections, comments, and role updates.</p>
              </div>
            </div>
            <div className="is-retained">
              <Icon name="copy" size={15} />
              <div>
                <strong>What remains</strong>
                <p>
                  The last synchronized snapshot becomes a private, unsynced fork with a visible
                  source boundary.
                </p>
              </div>
            </div>
            <div className="oc-lifecycle-model">
              <span>
                <Icon name={model === 'mirrorchain' ? 'link' : 'copy'} size={14} />
                Current model: {model === 'mirrorchain' ? 'Live source' : 'Shared copy'}
              </span>
              <p>
                {model === 'mirrorchain'
                  ? 'BetterTrack materializes the last permitted snapshot before access is severed.'
                  : 'The existing synchronized copy simply stops receiving source changes.'}
              </p>
            </div>
          </div>
        ) : null}
        <footer className="oc-dialog__foot">
          <span>
            {revoke ? 'This invitation event remains in Audit.' : 'No history is silently deleted.'}
          </span>
          <Button onClick={onCancel} tone="ghost">
            Cancel
          </Button>
          <Button icon={revoke ? 'x' : 'link'} onClick={onConfirm} tone="danger">
            {revoke
              ? 'Revoke invitation'
              : leaving
                ? 'Leave and keep fork'
                : 'Remove and retain fork'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
