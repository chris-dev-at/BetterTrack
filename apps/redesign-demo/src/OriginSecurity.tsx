import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react';

import { Icon, type IconName } from './Icons';
import { useAccessibleDialog, useDialogStepFocus } from './useAccessibleDialog';
import './origin-security.css';

export const ORIGIN_SECURITY_STORAGE_KEY = 'bt-demo-security';

export type OriginSecuritySection =
  | 'account'
  | 'authentication'
  | 'sessions'
  | 'privacy'
  | 'data'
  | 'danger';

export type OriginAiAccessMode = 'off' | 'read' | 'read-write';
export type OriginSecurityDataHome = 'hosted' | 'drive' | 'local';

export type OriginSecurityEventType =
  | 'profile.updated'
  | 'identity.linked'
  | 'identity.unlinked'
  | 'password.changed'
  | 'passkey.added'
  | 'passkey.removed'
  | 'totp.enabled'
  | 'recovery.regenerated'
  | 'pin.enabled'
  | 'pin.disabled'
  | 'session.revoked'
  | 'privacy.updated'
  | 'byok.connected'
  | 'byok.removed'
  | 'export.requested'
  | 'export.ready'
  | 'account.deleted';

export interface OriginSecurityEvent {
  id: string;
  type: OriginSecurityEventType;
  summary: string;
  at: string;
  actor: string;
  location: string;
  severity: 'info' | 'success' | 'attention';
}

export interface OriginSecurityPasskey {
  id: string;
  name: string;
  device: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface OriginSecuritySession {
  id: string;
  device: string;
  browser: string;
  location: string;
  ip: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
  trusted: boolean;
  revokedAt: string | null;
}

export interface OriginSecurityExportJob {
  id: string;
  scope: 'all-data' | 'portfolio-data' | 'audit-history';
  format: 'json-csv' | 'json' | 'csv';
  status: 'processing' | 'ready' | 'downloaded';
  requestedAt: string;
  readyAt: string | null;
  expiresAt: string | null;
  size: string | null;
}

export interface OriginSecurityPersistedState {
  version: 1;
  profile: {
    displayName: string;
    legalName: string;
    email: string;
    timezone: string;
    baseCurrency: string;
    locale: string;
    updatedAt: string;
  };
  googleIdentity: {
    linked: boolean;
    email: string | null;
    linkedAt: string | null;
  };
  password: {
    changeRequired: boolean;
    changedAt: string | null;
  };
  passkeys: OriginSecurityPasskey[];
  totp: {
    enabled: boolean;
    enabledAt: string | null;
    recoveryCodesRemaining: number;
  };
  pin: {
    enabled: boolean;
    enabledAt: string | null;
  };
  sessions: OriginSecuritySession[];
  privacy: {
    aiAccess: OriginAiAccessMode;
    aiScopes: {
      portfolioBalances: boolean;
      holdingsAndActivity: boolean;
      documents: boolean;
      workbench: boolean;
      collaboration: boolean;
    };
    rememberAiConversations: boolean;
    productAnalytics: boolean;
    crashDiagnostics: boolean;
    byok: {
      configured: boolean;
      provider: 'OpenAI' | 'Anthropic' | 'Azure OpenAI' | null;
      keySuffix: string | null;
      connectedAt: string | null;
    };
  };
  exportJobs: OriginSecurityExportJob[];
  events: OriginSecurityEvent[];
}

export interface OriginSecurityDeletedReceipt {
  id: string;
  type: 'account-deleted';
  deletedAt: string;
  accountEmail: string;
  revokedSessions: number;
  deletedPasskeys: number;
  exportPreserved: boolean;
  localDemoStorageCleared: boolean;
}

export interface OriginSecurityProps {
  dataHome?: OriginSecurityDataHome;
  onBack: () => void;
  onSignedOut?: (receipt: OriginSecurityDeletedReceipt) => void;
  onToast?: (message: string) => void;
}

type SecurityModal = 'totp' | 'recovery' | 'delete' | 'unlink-google' | null;

const sections: ReadonlyArray<{
  id: OriginSecuritySection;
  label: string;
  description: string;
  icon: IconName;
}> = [
  { id: 'account', label: 'Account', description: 'Identity and preferences', icon: 'user-plus' },
  {
    id: 'authentication',
    label: 'Authentication',
    description: 'Password, passkeys, and 2FA',
    icon: 'shield',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    description: 'Devices and security events',
    icon: 'monitor',
  },
  {
    id: 'privacy',
    label: 'Privacy & AI',
    description: 'Data access and model controls',
    icon: 'ai',
  },
  {
    id: 'data',
    label: 'Data & Export',
    description: 'Residency, copies, and portability',
    icon: 'database',
  },
  { id: 'danger', label: 'Danger', description: 'Irreversible account actions', icon: 'trash' },
];

const dataHomeMeta: Record<
  OriginSecurityDataHome,
  {
    sidebarTitle: string;
    sidebarCopy: string;
    code: string;
    kicker: string;
    title: string;
    description: string;
    encryption: string;
    backup: string;
  }
> = {
  hosted: {
    sidebarTitle: 'EU data home',
    sidebarCopy: 'Frankfurt · encrypted at rest',
    code: 'FRA',
    kicker: 'Primary residency',
    title: 'European Union · Frankfurt',
    description:
      'Portfolio records, identity metadata, audit events, and encrypted documents stay in the selected EU data home. Connected providers retain their own source data.',
    encryption: 'AES-256 at rest · TLS 1.3 in transit',
    backup: 'EU · Amsterdam',
  },
  drive: {
    sidebarTitle: 'Drive data home',
    sidebarCopy: 'User-controlled · portable',
    code: 'GDR',
    kicker: 'Authoritative storage',
    title: 'Google Drive · BetterTrack folder',
    description:
      'The selected Drive folder is the portable source of truth for portfolio records and encrypted documents. BetterTrack retains only the minimum account and sync metadata needed to operate the suite.',
    encryption: 'Client-side envelope · Google transport encryption',
    backup: 'Drive version history · user controlled',
  },
  local: {
    sidebarTitle: 'Local data home',
    sidebarCopy: 'This device · no cloud copy',
    code: 'LOC',
    kicker: 'Authoritative storage',
    title: 'Local or self-hosted workspace',
    description:
      'Portfolio records and documents remain in this local demo boundary. Connected sources can be read explicitly, but BetterTrack does not create a hosted copy.',
    encryption: 'Device storage boundary · browser sandbox',
    backup: 'Manual encrypted export recommended',
  },
};

const defaultSessions: OriginSecuritySession[] = [
  {
    id: 'sess_current',
    device: 'MacBook Pro',
    browser: 'Safari 18 · macOS',
    location: 'Vienna, Austria',
    ip: '10.0.0.4',
    createdAt: '2026-07-27T06:42:00.000Z',
    lastActiveAt: '2026-07-27T08:58:00.000Z',
    current: true,
    trusted: true,
    revokedAt: null,
  },
  {
    id: 'sess_android',
    device: 'Pixel 9 Pro',
    browser: 'BetterTrack Android · Android 16',
    location: 'Vienna, Austria',
    ip: '84.115.•••.42',
    createdAt: '2026-07-20T17:20:00.000Z',
    lastActiveAt: '2026-07-27T07:14:00.000Z',
    current: false,
    trusted: true,
    revokedAt: null,
  },
  {
    id: 'sess_chrome',
    device: 'Windows workstation',
    browser: 'Chrome 138 · Windows 11',
    location: 'Graz, Austria',
    ip: '91.141.•••.18',
    createdAt: '2026-07-18T10:11:00.000Z',
    lastActiveAt: '2026-07-25T16:31:00.000Z',
    current: false,
    trusted: false,
    revokedAt: null,
  },
  {
    id: 'sess_tablet',
    device: 'iPad Air',
    browser: 'Safari · iPadOS',
    location: 'Vienna, Austria',
    ip: '84.115.•••.42',
    createdAt: '2026-06-04T11:05:00.000Z',
    lastActiveAt: '2026-07-11T19:02:00.000Z',
    current: false,
    trusted: true,
    revokedAt: null,
  },
];

const defaultEvents: OriginSecurityEvent[] = [
  {
    id: 'evt_current_login',
    type: 'profile.updated',
    summary: 'Successful sign-in with password and authenticator',
    at: '2026-07-27T06:42:00.000Z',
    actor: 'You',
    location: 'Vienna · Safari 18',
    severity: 'success',
  },
  {
    id: 'evt_android_refresh',
    type: 'privacy.updated',
    summary: 'Trusted Android session refreshed',
    at: '2026-07-26T18:14:00.000Z',
    actor: 'BetterTrack Android',
    location: 'Vienna · Pixel 9 Pro',
    severity: 'info',
  },
  {
    id: 'evt_password_due',
    type: 'password.changed',
    summary: 'Password rotation requested after the demo security review',
    at: '2026-07-25T09:30:00.000Z',
    actor: 'Security policy',
    location: 'System',
    severity: 'attention',
  },
];

const defaultState: OriginSecurityPersistedState = {
  version: 1,
  profile: {
    displayName: 'Christopher',
    legalName: 'Christopher Wiesinger',
    email: 'christopher@bettertrack.app',
    timezone: 'Europe/Vienna',
    baseCurrency: 'EUR',
    locale: 'English (International)',
    updatedAt: '2026-07-20T12:00:00.000Z',
  },
  googleIdentity: {
    linked: true,
    email: 'cwiesi@gmail.com',
    linkedAt: '2026-06-14T09:20:00.000Z',
  },
  password: {
    changeRequired: true,
    changedAt: '2025-11-02T10:00:00.000Z',
  },
  passkeys: [
    {
      id: 'passkey_mac',
      name: 'MacBook Touch ID',
      device: 'Apple platform authenticator',
      createdAt: '2026-06-14T09:31:00.000Z',
      lastUsedAt: '2026-07-25T07:12:00.000Z',
    },
  ],
  totp: {
    enabled: true,
    enabledAt: '2026-02-18T19:22:00.000Z',
    recoveryCodesRemaining: 6,
  },
  pin: {
    enabled: false,
    enabledAt: null,
  },
  sessions: defaultSessions,
  privacy: {
    aiAccess: 'read',
    aiScopes: {
      portfolioBalances: true,
      holdingsAndActivity: true,
      documents: false,
      workbench: true,
      collaboration: false,
    },
    rememberAiConversations: false,
    productAnalytics: true,
    crashDiagnostics: true,
    byok: {
      configured: false,
      provider: null,
      keySuffix: null,
      connectedAt: null,
    },
  },
  exportJobs: [],
  events: defaultEvents,
};

function loadPersistedState(): OriginSecurityPersistedState {
  try {
    const raw = window.localStorage.getItem(ORIGIN_SECURITY_STORAGE_KEY);
    if (!raw) return defaultState;
    const parsed = JSON.parse(raw) as Partial<OriginSecurityPersistedState>;
    return {
      ...defaultState,
      ...parsed,
      profile: { ...defaultState.profile, ...parsed.profile },
      googleIdentity: { ...defaultState.googleIdentity, ...parsed.googleIdentity },
      password: { ...defaultState.password, ...parsed.password },
      totp: { ...defaultState.totp, ...parsed.totp },
      pin: { ...defaultState.pin, ...parsed.pin },
      privacy: {
        ...defaultState.privacy,
        ...parsed.privacy,
        aiScopes: { ...defaultState.privacy.aiScopes, ...parsed.privacy?.aiScopes },
        byok: { ...defaultState.privacy.byok, ...parsed.privacy?.byok },
      },
      passkeys: Array.isArray(parsed.passkeys) ? parsed.passkeys : defaultState.passkeys,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : defaultState.sessions,
      exportJobs: Array.isArray(parsed.exportJobs) ? parsed.exportJobs : [],
      events: Array.isArray(parsed.events) ? parsed.events : defaultState.events,
    };
  } catch {
    return defaultState;
  }
}

function makeEvent(
  type: OriginSecurityEventType,
  summary: string,
  severity: OriginSecurityEvent['severity'] = 'success',
): OriginSecurityEvent {
  return {
    id: `sec_${Math.random().toString(36).slice(2, 10)}`,
    type,
    summary,
    at: new Date().toISOString(),
    actor: 'You',
    location: 'Vienna · current session',
    severity,
  };
}

function makeRecoveryCodes() {
  return Array.from({ length: 8 }, (_, index) => {
    const left = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
    const right = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'Y');
    return `BT${String(index + 1).padStart(2, '0')}-${left}-${right}`;
  });
}

function scopeLabel(scope: OriginSecurityExportJob['scope']) {
  if (scope === 'all-data') return 'Complete account archive';
  if (scope === 'portfolio-data') return 'Portfolio data only';
  return 'Audit and security history';
}

function exportStatusLabel(status: OriginSecurityExportJob['status']) {
  if (status === 'processing') return 'Processing';
  if (status === 'ready') return 'Ready to download';
  return 'Downloaded';
}

export function OriginSecurity({
  dataHome = 'hosted',
  onBack,
  onSignedOut,
  onToast,
}: OriginSecurityProps) {
  const [state, setState] = useState<OriginSecurityPersistedState>(loadPersistedState);
  const [section, setSection] = useState<OriginSecuritySection>('account');
  const [deletedReceipt, setDeletedReceipt] = useState<OriginSecurityDeletedReceipt | null>(null);
  const [modal, setModal] = useState<SecurityModal>(null);
  const [working, setWorking] = useState<string | null>(null);

  const [profileDraft, setProfileDraft] = useState(state.profile);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passkeyName, setPasskeyName] = useState('This device');

  const [totpPhase, setTotpPhase] = useState<'scan' | 'verify' | 'codes'>('scan');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpError, setTotpError] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [codesCopied, setCodesCopied] = useState(false);

  const [pinSetup, setPinSetup] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [sessionPin, setSessionPin] = useState('2468');
  const [pinLocked, setPinLocked] = useState(false);
  const [pinUnlock, setPinUnlock] = useState('');
  const [pinError, setPinError] = useState('');

  const [byokDraft, setByokDraft] = useState('');
  const [byokProvider, setByokProvider] = useState<'OpenAI' | 'Anthropic' | 'Azure OpenAI'>(
    'OpenAI',
  );
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteKeepExport, setDeleteKeepExport] = useState(true);
  const securityStepHeadingRef = useRef<HTMLHeadingElement>(null);
  const securityDialogRef = useAccessibleDialog<HTMLElement>({
    open: modal !== null,
    onClose: closeSecurityModal,
  });

  useDialogStepFocus(modal === 'totp', `${modal ?? 'closed'}-${totpPhase}`, securityStepHeadingRef);

  function closeSecurityModal() {
    if (modal === 'totp' || modal === 'recovery') {
      setRecoveryCodes(null);
      setTotpSecret('');
      setTotpCode('');
      setTotpError('');
      setCodesCopied(false);
      setTotpPhase('scan');
    }
    setModal(null);
  }

  useEffect(() => {
    if (deletedReceipt) return;
    window.localStorage.setItem(ORIGIN_SECURITY_STORAGE_KEY, JSON.stringify(state));
  }, [deletedReceipt, state]);

  const activeSessions = state.sessions.filter((sessionItem) => !sessionItem.revokedAt);
  const selectedSection = sections.find((item) => item.id === section) ?? sections[0]!;
  const selectedDataHome = dataHomeMeta[dataHome];
  const securityScore = useMemo(() => {
    let score = 42;
    if (!state.password.changeRequired) score += 15;
    if (state.passkeys.length > 0) score += 15;
    if (state.totp.enabled) score += 18;
    if (activeSessions.every((sessionItem) => sessionItem.current || sessionItem.trusted))
      score += 5;
    if (state.googleIdentity.linked) score += 5;
    return Math.min(score, 100);
  }, [
    activeSessions,
    state.googleIdentity.linked,
    state.passkeys.length,
    state.password.changeRequired,
    state.totp.enabled,
  ]);

  const notify = (message: string) => onToast?.(message);

  const saveProfile = (event: FormEvent) => {
    event.preventDefault();
    const updatedAt = new Date().toISOString();
    setState((current) => ({
      ...current,
      profile: { ...profileDraft, email: current.profile.email, updatedAt },
      events: [
        makeEvent('profile.updated', 'Account profile and regional preferences updated'),
        ...current.events,
      ],
    }));
    notify('Account profile saved.');
  };

  const connectGoogle = () => {
    setWorking('google');
    window.setTimeout(() => {
      const linkedAt = new Date().toISOString();
      setState((current) => ({
        ...current,
        googleIdentity: { linked: true, email: 'cwiesi@gmail.com', linkedAt },
        events: [
          makeEvent('identity.linked', 'Google sign-in linked to cwiesi@gmail.com'),
          ...current.events,
        ],
      }));
      setWorking(null);
      notify('Google identity linked.');
    }, 750);
  };

  const unlinkGoogle = () => {
    setState((current) => ({
      ...current,
      googleIdentity: { linked: false, email: null, linkedAt: null },
      events: [
        makeEvent('identity.unlinked', 'Google sign-in was removed', 'attention'),
        ...current.events,
      ],
    }));
    setModal(null);
    notify('Google identity unlinked. Password sign-in remains available.');
  };

  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    setPasswordError('');
    if (!currentPassword) {
      setPasswordError('Enter your current password.');
      return;
    }
    if (newPassword.length < 12) {
      setPasswordError('Use at least 12 characters for this demo.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    const changedAt = new Date().toISOString();
    setState((current) => ({
      ...current,
      password: { changeRequired: false, changedAt },
      events: [
        makeEvent('password.changed', 'Password changed and older password sessions invalidated'),
        ...current.events,
      ],
      sessions: current.sessions.map((sessionItem) =>
        sessionItem.current || sessionItem.revokedAt
          ? sessionItem
          : { ...sessionItem, revokedAt: changedAt },
      ),
    }));
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    notify('Password changed. Other browser sessions were revoked.');
  };

  const addPasskey = () => {
    if (!passkeyName.trim()) return;
    setWorking('passkey');
    window.setTimeout(() => {
      const passkey: OriginSecurityPasskey = {
        id: `passkey_${Math.random().toString(36).slice(2, 9)}`,
        name: passkeyName.trim(),
        device: 'Platform authenticator · secure enclave',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      setState((current) => ({
        ...current,
        passkeys: [...current.passkeys, passkey],
        events: [makeEvent('passkey.added', `Passkey “${passkey.name}” added`), ...current.events],
      }));
      setPasskeyName('This device');
      setWorking(null);
      notify('Passkey added. No credential secret was stored by this demo.');
    }, 850);
  };

  const removePasskey = (passkey: OriginSecurityPasskey) => {
    setState((current) => ({
      ...current,
      passkeys: current.passkeys.filter((item) => item.id !== passkey.id),
      events: [
        makeEvent('passkey.removed', `Passkey “${passkey.name}” removed`, 'attention'),
        ...current.events,
      ],
    }));
    notify(`${passkey.name} removed.`);
  };

  const beginTotp = () => {
    setTotpSecret('JBSW-Y3DP-EHPK-3PXP-BT26');
    setTotpCode('');
    setTotpError('');
    setTotpPhase('scan');
    setModal('totp');
  };

  const verifyTotp = () => {
    if (!/^\d{6}$/.test(totpCode)) {
      setTotpError('Enter any six-digit authenticator code in this demo.');
      return;
    }
    const codes = makeRecoveryCodes();
    setRecoveryCodes(codes);
    setCodesCopied(false);
    setTotpPhase('codes');
    setState((current) => ({
      ...current,
      totp: {
        enabled: true,
        enabledAt: new Date().toISOString(),
        recoveryCodesRemaining: codes.length,
      },
      events: [makeEvent('totp.enabled', 'Authenticator app enabled'), ...current.events],
    }));
    notify('Authenticator enabled. Save the one-time recovery codes.');
  };

  const closeRecoveryCodes = () => {
    setRecoveryCodes(null);
    setTotpSecret('');
    setTotpCode('');
    setCodesCopied(false);
    setModal(null);
  };

  const regenerateRecoveryCodes = () => {
    const codes = makeRecoveryCodes();
    setRecoveryCodes(codes);
    setCodesCopied(false);
    setModal('recovery');
    setState((current) => ({
      ...current,
      totp: { ...current.totp, recoveryCodesRemaining: codes.length },
      events: [
        makeEvent(
          'recovery.regenerated',
          'Recovery codes regenerated; all previous codes invalidated',
          'attention',
        ),
        ...current.events,
      ],
    }));
  };

  const copyRecoveryCodes = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCodesCopied(true);
      notify('Recovery codes copied. They will not be shown again after closing.');
    } catch {
      notify('Clipboard access is unavailable. Copy the codes manually.');
    }
  };

  const enablePin = (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{4,8}$/.test(pinSetup) || pinSetup !== pinConfirm) {
      notify('Use matching 4–8 digit PINs.');
      return;
    }
    setSessionPin(pinSetup);
    setPinSetup('');
    setPinConfirm('');
    setState((current) => ({
      ...current,
      pin: { enabled: true, enabledAt: new Date().toISOString() },
      events: [makeEvent('pin.enabled', 'Local app PIN enabled'), ...current.events],
    }));
    notify('App PIN enabled. The raw PIN stays only in this browser session.');
  };

  const disablePin = () => {
    setState((current) => ({
      ...current,
      pin: { enabled: false, enabledAt: null },
      events: [makeEvent('pin.disabled', 'Local app PIN disabled', 'attention'), ...current.events],
    }));
    setPinLocked(false);
    setSessionPin('2468');
    notify('App PIN disabled.');
  };

  const unlockPin = (event: FormEvent) => {
    event.preventDefault();
    if (pinUnlock !== sessionPin) {
      setPinError('Incorrect demo PIN. Use the PIN created in this session.');
      return;
    }
    setPinLocked(false);
    setPinUnlock('');
    setPinError('');
    notify('BetterTrack unlocked.');
  };

  const revokeSession = (sessionItem: OriginSecuritySession) => {
    if (sessionItem.current || sessionItem.revokedAt) return;
    const revokedAt = new Date().toISOString();
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === sessionItem.id ? { ...item, revokedAt } : item,
      ),
      events: [
        makeEvent(
          'session.revoked',
          `${sessionItem.device} session revoked`,
          sessionItem.trusted ? 'info' : 'attention',
        ),
        ...current.events,
      ],
    }));
    notify(`${sessionItem.device} signed out.`);
  };

  const revokeOtherSessions = () => {
    const revokedAt = new Date().toISOString();
    const count = activeSessions.filter((sessionItem) => !sessionItem.current).length;
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((sessionItem) =>
        sessionItem.current || sessionItem.revokedAt ? sessionItem : { ...sessionItem, revokedAt },
      ),
      events: [
        makeEvent(
          'session.revoked',
          `${count} other sessions revoked`,
          count > 0 ? 'attention' : 'info',
        ),
        ...current.events,
      ],
    }));
    notify(count > 0 ? `${count} other sessions revoked.` : 'No other active sessions.');
  };

  const updateAiMode = (mode: OriginAiAccessMode) => {
    setState((current) => ({
      ...current,
      privacy: { ...current.privacy, aiAccess: mode },
      events: [
        makeEvent(
          'privacy.updated',
          `AI portfolio access changed to ${mode}`,
          mode === 'read-write' ? 'attention' : 'info',
        ),
        ...current.events,
      ],
    }));
    notify(`AI access set to ${mode}.`);
  };

  const updateAiScope = (scope: keyof OriginSecurityPersistedState['privacy']['aiScopes']) => {
    setState((current) => ({
      ...current,
      privacy: {
        ...current.privacy,
        aiScopes: {
          ...current.privacy.aiScopes,
          [scope]: !current.privacy.aiScopes[scope],
        },
      },
      events: [
        makeEvent('privacy.updated', `AI data scope “${scope}” changed`, 'info'),
        ...current.events,
      ],
    }));
  };

  const saveByok = () => {
    if (byokDraft.trim().length < 8) {
      notify('Enter a demo API key with at least 8 characters.');
      return;
    }
    const suffix = byokDraft.trim().slice(-4);
    setState((current) => ({
      ...current,
      privacy: {
        ...current.privacy,
        byok: {
          configured: true,
          provider: byokProvider,
          keySuffix: suffix,
          connectedAt: new Date().toISOString(),
        },
      },
      events: [
        makeEvent('byok.connected', `${byokProvider} bring-your-own key connected`),
        ...current.events,
      ],
    }));
    setByokDraft('');
    notify(`BYOK connected. Only the ••••${suffix} display suffix was retained.`);
  };

  const removeByok = () => {
    setState((current) => ({
      ...current,
      privacy: {
        ...current.privacy,
        byok: { configured: false, provider: null, keySuffix: null, connectedAt: null },
      },
      events: [
        makeEvent('byok.removed', 'Bring-your-own model key removed', 'attention'),
        ...current.events,
      ],
    }));
    notify('BYOK connection removed.');
  };

  const requestExport = (scope: OriginSecurityExportJob['scope']) => {
    const requestedAt = new Date();
    const id = `export_${requestedAt.getTime().toString(36)}`;
    const job: OriginSecurityExportJob = {
      id,
      scope,
      format: scope === 'portfolio-data' ? 'csv' : 'json-csv',
      status: 'processing',
      requestedAt: requestedAt.toISOString(),
      readyAt: null,
      expiresAt: null,
      size: null,
    };
    setState((current) => ({
      ...current,
      exportJobs: [job, ...current.exportJobs],
      events: [
        makeEvent('export.requested', `${scopeLabel(scope)} requested`, 'info'),
        ...current.events,
      ],
    }));
    notify('Export requested. The demo is assembling your archive.');
    window.setTimeout(() => {
      const readyAt = new Date();
      const expiresAt = new Date(readyAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      setState((current) => ({
        ...current,
        exportJobs: current.exportJobs.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'ready',
                readyAt: readyAt.toISOString(),
                expiresAt: expiresAt.toISOString(),
                size:
                  scope === 'all-data'
                    ? '18.4 MB'
                    : scope === 'portfolio-data'
                      ? '6.8 MB'
                      : '1.2 MB',
              }
            : item,
        ),
        events: [
          makeEvent('export.ready', `${scopeLabel(scope)} is ready to download`),
          ...current.events,
        ],
      }));
      notify('Your export is ready to download.');
    }, 1350);
  };

  const downloadExport = (job: OriginSecurityExportJob) => {
    const payload = JSON.stringify(
      {
        demo: true,
        exportId: job.id,
        scope: job.scope,
        generatedAt: job.readyAt,
        profile: {
          displayName: state.profile.displayName,
          email: state.profile.email,
          timezone: state.profile.timezone,
        },
        notice: 'This is a fictional BetterTrack redesign-demo archive.',
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `bettertrack-${job.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setState((current) => ({
      ...current,
      exportJobs: current.exportJobs.map((item) =>
        item.id === job.id ? { ...item, status: 'downloaded' } : item,
      ),
    }));
    notify('Demo export downloaded.');
  };

  const downloadAuditLog = () => {
    const payload = JSON.stringify(
      {
        product: 'BetterTrack Origin demo',
        generatedAt: new Date().toISOString(),
        account: state.profile.email,
        events: state.events,
        note: 'Fictional browser-local security audit data.',
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'bettertrack-security-audit-demo.json';
    link.click();
    URL.revokeObjectURL(url);
    notify('Security audit log downloaded.');
  };

  const deleteAccount = () => {
    if (deleteConfirmation !== 'DELETE MY ACCOUNT') return;
    setWorking('delete');
    window.setTimeout(() => {
      const deletedAt = new Date().toISOString();
      const receipt: OriginSecurityDeletedReceipt = {
        id: `deleted_${Date.now().toString(36)}`,
        type: 'account-deleted',
        deletedAt,
        accountEmail: state.profile.email,
        revokedSessions: activeSessions.length,
        deletedPasskeys: state.passkeys.length,
        exportPreserved: deleteKeepExport,
        localDemoStorageCleared: true,
      };
      window.localStorage.removeItem(ORIGIN_SECURITY_STORAGE_KEY);
      setDeletedReceipt(receipt);
      setWorking(null);
      setModal(null);
    }, 1100);
  };

  if (deletedReceipt) {
    return (
      <section className="origin-security origin-security--deleted">
        <div className="origin-security-deleted">
          <span className="origin-security-deleted__mark">
            <Icon name="check" size={27} />
          </span>
          <span className="origin-security-kicker">Deletion receipt</span>
          <h1>Account deleted and signed out</h1>
          <p>
            The fictional BetterTrack account, active sessions, credentials, AI access, and local
            demo security state were removed.
          </p>
          <div className="origin-security-deleted__receipt">
            <div>
              <span>Receipt</span>
              <code>{deletedReceipt.id}</code>
            </div>
            <div>
              <span>Deleted at</span>
              <strong>{new Date(deletedReceipt.deletedAt).toLocaleString()}</strong>
            </div>
            <div>
              <span>Sessions revoked</span>
              <strong>{deletedReceipt.revokedSessions}</strong>
            </div>
            <div>
              <span>Passkeys removed</span>
              <strong>{deletedReceipt.deletedPasskeys}</strong>
            </div>
            <div>
              <span>Requested export</span>
              <strong>{deletedReceipt.exportPreserved ? 'Preserved for 7 days' : 'Removed'}</strong>
            </div>
            <div>
              <span>Local demo key</span>
              <strong>{ORIGIN_SECURITY_STORAGE_KEY} cleared</strong>
            </div>
          </div>
          <button
            className="origin-security-button origin-security-button--primary"
            onClick={() => (onSignedOut ? onSignedOut(deletedReceipt) : onBack())}
            type="button"
          >
            Return to sign in
          </button>
        </div>
      </section>
    );
  }

  if (pinLocked) {
    return (
      <section className="origin-security origin-security--locked">
        <form className="origin-security-lock" onSubmit={unlockPin}>
          <span className="origin-security-lock__icon">
            <Icon name="lock" size={22} />
          </span>
          <span className="origin-security-kicker">Local privacy lock</span>
          <h1>BetterTrack is locked</h1>
          <p>
            Enter the PIN created in this browser session. Portfolio data remains hidden behind the
            lock.
          </p>
          <label>
            <span>App PIN</span>
            <input
              aria-describedby={pinError ? 'origin-security-pin-error' : undefined}
              aria-invalid={pinError ? true : undefined}
              autoFocus
              inputMode="numeric"
              maxLength={8}
              onChange={(event) => {
                setPinUnlock(event.target.value.replace(/\D/g, ''));
                setPinError('');
              }}
              placeholder="••••"
              type="password"
              value={pinUnlock}
            />
          </label>
          {pinError ? (
            <span
              className="origin-security-form-error"
              id="origin-security-pin-error"
              role="alert"
            >
              {pinError}
            </span>
          ) : null}
          <button className="origin-security-button origin-security-button--primary" type="submit">
            Unlock
          </button>
          <button className="origin-security-text-button" onClick={onBack} type="button">
            Sign out instead
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="origin-security">
      <header className="origin-security-header">
        <button aria-label="Back" className="origin-security-back" onClick={onBack} type="button">
          <Icon name="arrow-right" size={15} />
        </button>
        <div>
          <h1>Account & security</h1>
        </div>
        <div className="origin-security-header__status">
          <div className="origin-security-score">
            <span
              className="origin-security-score__ring"
              style={{ '--security-score': securityScore } as React.CSSProperties}
            >
              <strong>{securityScore}</strong>
            </span>
            <span>
              <small>Security score</small>
              <strong>{securityScore >= 90 ? 'Strong' : 'Needs attention'}</strong>
            </span>
          </div>
        </div>
      </header>

      <div className="origin-security-layout">
        <aside className="origin-security-nav">
          <nav aria-label="Account settings">
            {sections.map((item) => (
              <button
                aria-current={section === item.id ? 'page' : undefined}
                className={section === item.id ? 'is-active' : ''}
                key={item.id}
                onClick={() => setSection(item.id)}
                type="button"
              >
                <span className="origin-security-nav__icon">
                  <Icon name={item.icon} size={15} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {item.id === 'authentication' && state.password.changeRequired ? (
                  <span className="origin-security-nav__attention" />
                ) : null}
                <Icon className="origin-security-nav__chevron" name="chevron-right" size={12} />
              </button>
            ))}
          </nav>
          <div className="origin-security-nav__storage">
            <Icon name="database" size={14} />
            <span>
              <strong>{selectedDataHome.sidebarTitle}</strong>
              <small>{selectedDataHome.sidebarCopy}</small>
            </span>
          </div>
        </aside>

        <main className="origin-security-main">
          <div className="origin-security-main__head">
            <h2>{selectedSection.label}</h2>
            {section === 'authentication' && state.password.changeRequired ? (
              <span className="origin-security-state origin-security-state--attention">
                <span /> Action required
              </span>
            ) : null}
          </div>

          {section === 'account' ? (
            <div className="origin-security-section">
              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Profile</h3>
                    <p>How your name and regional conventions appear across BetterTrack.</p>
                  </div>
                  <span>Updated {new Date(state.profile.updatedAt).toLocaleDateString()}</span>
                </div>
                <form className="origin-security-profile" onSubmit={saveProfile}>
                  <div className="origin-security-avatar">
                    <span>{profileDraft.displayName.slice(0, 2).toUpperCase()}</span>
                    <button
                      onClick={() =>
                        notify('Photo picker previewed; this demo intentionally keeps initials.')
                      }
                      type="button"
                    >
                      Change photo
                    </button>
                    <small>JPG or PNG · this demo keeps initials only</small>
                  </div>
                  <div className="origin-security-fields">
                    <label className="origin-security-field">
                      <span>Display name</span>
                      <input
                        onChange={(event) =>
                          setProfileDraft((current) => ({
                            ...current,
                            displayName: event.target.value,
                          }))
                        }
                        value={profileDraft.displayName}
                      />
                    </label>
                    <label className="origin-security-field">
                      <span>Legal name</span>
                      <input
                        onChange={(event) =>
                          setProfileDraft((current) => ({
                            ...current,
                            legalName: event.target.value,
                          }))
                        }
                        value={profileDraft.legalName}
                      />
                    </label>
                    <label className="origin-security-field origin-security-field--wide">
                      <span>Primary email</span>
                      <div className="origin-security-verified-input">
                        <input readOnly value={state.profile.email} />
                        <span>
                          <Icon name="check" size={11} /> Verified
                        </span>
                      </div>
                      <small>Email changes require verification from both addresses.</small>
                    </label>
                    <label className="origin-security-field">
                      <span>Timezone</span>
                      <select
                        onChange={(event) =>
                          setProfileDraft((current) => ({
                            ...current,
                            timezone: event.target.value,
                          }))
                        }
                        value={profileDraft.timezone}
                      >
                        <option>Europe/Vienna</option>
                        <option>Europe/Berlin</option>
                        <option>Europe/London</option>
                        <option>America/New_York</option>
                      </select>
                    </label>
                    <label className="origin-security-field">
                      <span>Base currency</span>
                      <select
                        onChange={(event) =>
                          setProfileDraft((current) => ({
                            ...current,
                            baseCurrency: event.target.value,
                          }))
                        }
                        value={profileDraft.baseCurrency}
                      >
                        <option>EUR</option>
                        <option>USD</option>
                        <option>GBP</option>
                        <option>CHF</option>
                      </select>
                    </label>
                    <label className="origin-security-field">
                      <span>Language & number format</span>
                      <select
                        onChange={(event) =>
                          setProfileDraft((current) => ({
                            ...current,
                            locale: event.target.value,
                          }))
                        }
                        value={profileDraft.locale}
                      >
                        <option>English (International)</option>
                        <option>Deutsch (Österreich)</option>
                        <option>English (United States)</option>
                      </select>
                    </label>
                  </div>
                  <div className="origin-security-form-actions">
                    <button
                      className="origin-security-button origin-security-button--secondary"
                      onClick={() => setProfileDraft(state.profile)}
                      type="button"
                    >
                      Reset
                    </button>
                    <button
                      className="origin-security-button origin-security-button--primary"
                      type="submit"
                    >
                      Save profile
                    </button>
                  </div>
                </form>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Connected sign-in identities</h3>
                    <p>
                      Alternative identity providers can sign in, but never inherit portfolio
                      permissions.
                    </p>
                  </div>
                </div>
                <div className="origin-security-identity-row">
                  <span className="origin-security-google">G</span>
                  <div>
                    <strong>Google</strong>
                    <span>
                      {state.googleIdentity.linked
                        ? state.googleIdentity.email
                        : 'No Google identity connected'}
                    </span>
                  </div>
                  {state.googleIdentity.linked ? (
                    <>
                      <span className="origin-security-state origin-security-state--healthy">
                        <Icon name="check" size={10} /> Linked
                      </span>
                      <button
                        className="origin-security-button origin-security-button--secondary"
                        onClick={() => setModal('unlink-google')}
                        type="button"
                      >
                        Unlink
                      </button>
                    </>
                  ) : (
                    <button
                      className="origin-security-button origin-security-button--secondary"
                      disabled={working === 'google'}
                      onClick={connectGoogle}
                      type="button"
                    >
                      {working === 'google' ? (
                        <>
                          <span className="origin-security-spinner" /> Connecting…
                        </>
                      ) : (
                        <>
                          <Icon name="link" size={13} /> Link Google
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div className="origin-security-inline-note">
                  <Icon name="shield" size={14} />
                  <span>
                    Password sign-in remains available. Removing Google cannot lock you out while a
                    password and authenticator are configured.
                  </span>
                </div>
              </section>
            </div>
          ) : null}

          {section === 'authentication' ? (
            <div className="origin-security-section">
              {state.password.changeRequired ? (
                <div className="origin-security-required-banner">
                  <span className="origin-security-required-banner__icon">
                    <Icon name="shield" size={17} />
                  </span>
                  <div>
                    <span className="origin-security-kicker">Forced security action</span>
                    <strong>Change your password before sensitive account actions</strong>
                    <p>
                      A demo security review flagged the current password as older than the accepted
                      policy. Portfolio viewing remains available; exports and new credentials
                      should wait.
                    </p>
                  </div>
                  <span className="origin-security-state origin-security-state--attention">
                    Required
                  </span>
                </div>
              ) : null}

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Password</h3>
                    <p>Changing it revokes every browser session except this one.</p>
                  </div>
                  <span>
                    {state.password.changedAt
                      ? `Last changed ${new Date(state.password.changedAt).toLocaleDateString()}`
                      : 'No recorded change'}
                  </span>
                </div>
                <form className="origin-security-password" onSubmit={changePassword}>
                  <label className="origin-security-field">
                    <span>Current password</span>
                    <input
                      aria-describedby={
                        passwordError ? 'origin-security-password-error' : undefined
                      }
                      aria-invalid={passwordError ? true : undefined}
                      autoComplete="current-password"
                      onChange={(event) => {
                        setCurrentPassword(event.target.value);
                        setPasswordError('');
                      }}
                      type="password"
                      value={currentPassword}
                    />
                  </label>
                  <label className="origin-security-field">
                    <span>New password</span>
                    <input
                      aria-describedby={
                        passwordError ? 'origin-security-password-error' : undefined
                      }
                      aria-invalid={passwordError ? true : undefined}
                      autoComplete="new-password"
                      onChange={(event) => {
                        setNewPassword(event.target.value);
                        setPasswordError('');
                      }}
                      type="password"
                      value={newPassword}
                    />
                    <small>12+ characters · passphrase recommended</small>
                  </label>
                  <label className="origin-security-field">
                    <span>Confirm new password</span>
                    <input
                      aria-describedby={
                        passwordError ? 'origin-security-password-error' : undefined
                      }
                      aria-invalid={passwordError ? true : undefined}
                      autoComplete="new-password"
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        setPasswordError('');
                      }}
                      type="password"
                      value={confirmPassword}
                    />
                  </label>
                  <div className="origin-security-password__strength">
                    <span>
                      <i className={newPassword.length >= 4 ? 'is-filled' : ''} />
                      <i className={newPassword.length >= 8 ? 'is-filled' : ''} />
                      <i className={newPassword.length >= 12 ? 'is-filled' : ''} />
                      <i className={newPassword.length >= 16 ? 'is-filled' : ''} />
                    </span>
                    <small>
                      {newPassword.length >= 16
                        ? 'Strong'
                        : newPassword.length >= 12
                          ? 'Good'
                          : 'Enter a longer passphrase'}
                    </small>
                  </div>
                  {passwordError ? (
                    <span
                      className="origin-security-form-error"
                      id="origin-security-password-error"
                      role="alert"
                    >
                      {passwordError}
                    </span>
                  ) : null}
                  <div className="origin-security-form-actions">
                    <button
                      className="origin-security-button origin-security-button--primary"
                      type="submit"
                    >
                      Change password
                    </button>
                  </div>
                </form>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Passkeys</h3>
                    <p>
                      Sign in with Touch ID, Face ID, Windows Hello, or a hardware security key.
                    </p>
                  </div>
                  <span>{state.passkeys.length} registered</span>
                </div>
                <div className="origin-security-credential-list">
                  {state.passkeys.map((passkey) => (
                    <div className="origin-security-credential-row" key={passkey.id}>
                      <span className="origin-security-credential-icon">
                        <Icon name="key" size={15} />
                      </span>
                      <div>
                        <strong>{passkey.name}</strong>
                        <span>{passkey.device}</span>
                        <small>
                          Added {new Date(passkey.createdAt).toLocaleDateString()}
                          {passkey.lastUsedAt
                            ? ` · last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}`
                            : ' · never used'}
                        </small>
                      </div>
                      <button
                        className="origin-security-text-button origin-security-text-button--danger"
                        onClick={() => removePasskey(passkey)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <div className="origin-security-add-credential">
                  <label className="origin-security-field">
                    <span>Passkey label</span>
                    <input
                      onChange={(event) => setPasskeyName(event.target.value)}
                      placeholder="e.g. Home security key"
                      value={passkeyName}
                    />
                  </label>
                  <button
                    className="origin-security-button origin-security-button--secondary"
                    disabled={working === 'passkey'}
                    onClick={addPasskey}
                    type="button"
                  >
                    {working === 'passkey' ? (
                      <>
                        <span className="origin-security-spinner" /> Waiting for device…
                      </>
                    ) : (
                      <>
                        <Icon name="plus" size={13} /> Add passkey
                      </>
                    )}
                  </button>
                </div>
                <div className="origin-security-inline-note">
                  <Icon name="lock" size={14} />
                  <span>
                    Passkey private material stays in your device authenticator. BetterTrack stores
                    only public credential metadata; this demo stores no raw passkey secret.
                  </span>
                </div>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Authenticator & recovery</h3>
                    <p>Use time-based codes when a passkey is unavailable.</p>
                  </div>
                  <span
                    className={`origin-security-state ${
                      state.totp.enabled
                        ? 'origin-security-state--healthy'
                        : 'origin-security-state--attention'
                    }`}
                  >
                    {state.totp.enabled ? <Icon name="check" size={10} /> : null}
                    {state.totp.enabled ? 'Enabled' : 'Not configured'}
                  </span>
                </div>
                <div className="origin-security-setting-row">
                  <span className="origin-security-setting-icon">
                    <Icon name="clock" size={15} />
                  </span>
                  <div>
                    <strong>Authenticator app</strong>
                    <span>
                      {state.totp.enabled
                        ? `Enabled ${new Date(state.totp.enabledAt ?? '').toLocaleDateString()}`
                        : 'Not configured'}
                    </span>
                  </div>
                  <button
                    className="origin-security-button origin-security-button--secondary"
                    onClick={beginTotp}
                    type="button"
                  >
                    {state.totp.enabled ? 'Replace authenticator' : 'Set up'}
                  </button>
                </div>
                <div className="origin-security-setting-row">
                  <span className="origin-security-setting-icon">
                    <Icon name="document" size={15} />
                  </span>
                  <div>
                    <strong>Recovery codes</strong>
                    <span>{state.totp.recoveryCodesRemaining} unused codes remain</span>
                  </div>
                  <button
                    className="origin-security-button origin-security-button--secondary"
                    disabled={!state.totp.enabled}
                    onClick={regenerateRecoveryCodes}
                    type="button"
                  >
                    Regenerate
                  </button>
                </div>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Local app PIN</h3>
                    <p>Hide financial data when stepping away without ending the session.</p>
                  </div>
                  <span
                    className={`origin-security-state ${
                      state.pin.enabled
                        ? 'origin-security-state--healthy'
                        : 'origin-security-state--neutral'
                    }`}
                  >
                    {state.pin.enabled ? 'Enabled' : 'Off'}
                  </span>
                </div>
                {state.pin.enabled ? (
                  <div className="origin-security-pin-enabled">
                    <span className="origin-security-setting-icon">
                      <Icon name="lock" size={15} />
                    </span>
                    <div>
                      <strong>PIN lock is ready</strong>
                      <span>Raw PIN exists only in memory for this demo session.</span>
                    </div>
                    <button
                      className="origin-security-button origin-security-button--secondary"
                      onClick={() => setPinLocked(true)}
                      type="button"
                    >
                      Lock now
                    </button>
                    <button
                      className="origin-security-button origin-security-button--danger"
                      onClick={disablePin}
                      type="button"
                    >
                      Disable PIN
                    </button>
                  </div>
                ) : (
                  <form className="origin-security-pin-form" onSubmit={enablePin}>
                    <label className="origin-security-field">
                      <span>Create 4–8 digit PIN</span>
                      <input
                        inputMode="numeric"
                        maxLength={8}
                        onChange={(event) => setPinSetup(event.target.value.replace(/\D/g, ''))}
                        placeholder="••••"
                        type="password"
                        value={pinSetup}
                      />
                    </label>
                    <label className="origin-security-field">
                      <span>Confirm PIN</span>
                      <input
                        inputMode="numeric"
                        maxLength={8}
                        onChange={(event) => setPinConfirm(event.target.value.replace(/\D/g, ''))}
                        placeholder="••••"
                        type="password"
                        value={pinConfirm}
                      />
                    </label>
                    <button
                      className="origin-security-button origin-security-button--secondary"
                      type="submit"
                    >
                      Enable PIN
                    </button>
                  </form>
                )}
              </section>
            </div>
          ) : null}

          {section === 'sessions' ? (
            <div className="origin-security-section">
              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Active sessions</h3>
                    <p>Devices with a currently valid BetterTrack session.</p>
                  </div>
                  <button
                    className="origin-security-button origin-security-button--secondary"
                    onClick={revokeOtherSessions}
                    type="button"
                  >
                    Sign out all others
                  </button>
                </div>
                <div className="origin-security-session-list">
                  {state.sessions.map((sessionItem) => (
                    <div
                      className={`origin-security-session ${sessionItem.revokedAt ? 'is-revoked' : ''}`}
                      key={sessionItem.id}
                    >
                      <span className="origin-security-session__device">
                        <Icon
                          name={sessionItem.device.includes('Pixel') ? 'moon' : 'monitor'}
                          size={16}
                        />
                      </span>
                      <div className="origin-security-session__identity">
                        <span>
                          <strong>{sessionItem.device}</strong>
                          {sessionItem.current ? (
                            <em className="origin-security-state origin-security-state--healthy">
                              Current
                            </em>
                          ) : sessionItem.revokedAt ? (
                            <em className="origin-security-state origin-security-state--neutral">
                              Revoked
                            </em>
                          ) : null}
                        </span>
                        <small>{sessionItem.browser}</small>
                      </div>
                      <div className="origin-security-session__meta">
                        <span>{sessionItem.location}</span>
                        <small>{sessionItem.ip}</small>
                      </div>
                      <div className="origin-security-session__meta">
                        <span>
                          {sessionItem.revokedAt
                            ? `Revoked ${new Date(sessionItem.revokedAt).toLocaleDateString()}`
                            : `Active ${new Date(sessionItem.lastActiveAt).toLocaleString([], {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })}`}
                        </span>
                        <small>{sessionItem.trusted ? 'Trusted device' : 'Not trusted'}</small>
                      </div>
                      {!sessionItem.current && !sessionItem.revokedAt ? (
                        <button
                          className="origin-security-text-button origin-security-text-button--danger"
                          onClick={() => revokeSession(sessionItem)}
                          type="button"
                        >
                          Revoke
                        </button>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Recent security events</h3>
                    <p>Account changes and access decisions retained for review.</p>
                  </div>
                  <button
                    className="origin-security-text-button"
                    onClick={downloadAuditLog}
                    type="button"
                  >
                    Export audit log
                  </button>
                </div>
                <div className="origin-security-event-list">
                  {state.events.slice(0, 10).map((securityEvent) => (
                    <div className="origin-security-event" key={securityEvent.id}>
                      <span
                        className={`origin-security-event__signal origin-security-event__signal--${securityEvent.severity}`}
                      >
                        <Icon
                          name={
                            securityEvent.severity === 'success'
                              ? 'check'
                              : securityEvent.severity === 'attention'
                                ? 'shield'
                                : 'activity'
                          }
                          size={12}
                        />
                      </span>
                      <div>
                        <strong>{securityEvent.summary}</strong>
                        <span>
                          {securityEvent.actor} · {securityEvent.location}
                        </span>
                      </div>
                      <span>
                        {new Date(securityEvent.at).toLocaleString([], {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          ) : null}

          {section === 'privacy' ? (
            <div className="origin-security-section">
              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>AI portfolio access</h3>
                    <p>Choose the maximum permission boundary for intentional AI work.</p>
                  </div>
                  <span>Never shared with model training</span>
                </div>
                <div className="origin-security-ai-modes">
                  {(
                    [
                      [
                        'off',
                        'Off',
                        'AI cannot read portfolio data. Generic product help remains available.',
                        'No data access',
                      ],
                      [
                        'read',
                        'Read & explain',
                        'Answer questions and build previews from the data scopes below.',
                        'Current',
                      ],
                      [
                        'read-write',
                        'Propose changes',
                        'Prepare portfolio actions, always behind review and approval boundaries.',
                        'Most capable',
                      ],
                    ] as const
                  ).map(([mode, label, description, badge]) => (
                    <button
                      aria-pressed={state.privacy.aiAccess === mode}
                      className={state.privacy.aiAccess === mode ? 'is-selected' : ''}
                      key={mode}
                      onClick={() => updateAiMode(mode)}
                      type="button"
                    >
                      <span className="origin-security-ai-mode__radio">
                        {state.privacy.aiAccess === mode ? <span /> : null}
                      </span>
                      <strong>{label}</strong>
                      <p>{description}</p>
                      <small>{state.privacy.aiAccess === mode ? 'Selected' : badge}</small>
                    </button>
                  ))}
                </div>
                <div className="origin-security-permission-boundary">
                  <span>
                    <Icon name="shield" size={15} />
                  </span>
                  <div>
                    <strong>
                      {state.privacy.aiAccess === 'off'
                        ? 'AI portfolio boundary is closed'
                        : state.privacy.aiAccess === 'read'
                          ? 'AI can reason, but cannot change data'
                          : 'AI can prepare proposals, never silently execute them'}
                    </strong>
                    <p>
                      Broker trading, withdrawals, sharing, collaborator changes, key management,
                      and account settings remain outside every AI access mode.
                    </p>
                  </div>
                </div>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Allowed AI data scopes</h3>
                    <p>Scopes apply only when you deliberately open the AI workspace.</p>
                  </div>
                  <span>
                    {Object.values(state.privacy.aiScopes).filter(Boolean).length} of 5 enabled
                  </span>
                </div>
                <div className="origin-security-scope-list">
                  {(
                    [
                      [
                        'portfolioBalances',
                        'Portfolio balances',
                        'Current totals, cash, currency, and high-level performance.',
                        'wallet',
                      ],
                      [
                        'holdingsAndActivity',
                        'Holdings & activity',
                        'Positions, transactions, tax lots, income, and expenses.',
                        'portfolio',
                      ],
                      [
                        'documents',
                        'Documents',
                        'Files explicitly attached to selected portfolios.',
                        'document',
                      ],
                      [
                        'workbench',
                        'Workbench',
                        'Scenarios, forecasts, models, and saved research.',
                        'workbench',
                      ],
                      [
                        'collaboration',
                        'Collaboration',
                        'Names, comments, assignments, and shared review items.',
                        'people',
                      ],
                    ] as const
                  ).map(([id, label, description, icon]) => (
                    <label key={id}>
                      <span className="origin-security-setting-icon">
                        <Icon name={icon} size={15} />
                      </span>
                      <span>
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                      <input
                        checked={state.privacy.aiScopes[id]}
                        disabled={state.privacy.aiAccess === 'off'}
                        onChange={() => updateAiScope(id)}
                        type="checkbox"
                      />
                    </label>
                  ))}
                </div>
                <label className="origin-security-toggle-row">
                  <span>
                    <strong>Remember AI conversations</strong>
                    <small>
                      Off keeps transcript context only for the current browser session. Generated
                      portfolio objects still have their own audit trail.
                    </small>
                  </span>
                  <input
                    checked={state.privacy.rememberAiConversations}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        privacy: {
                          ...current.privacy,
                          rememberAiConversations: event.target.checked,
                        },
                      }))
                    }
                    type="checkbox"
                  />
                </label>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Bring your own model key</h3>
                    <p>Route eligible AI requests through your provider account.</p>
                  </div>
                  <span
                    className={`origin-security-state ${
                      state.privacy.byok.configured
                        ? 'origin-security-state--healthy'
                        : 'origin-security-state--neutral'
                    }`}
                  >
                    {state.privacy.byok.configured ? 'Connected' : 'Not configured'}
                  </span>
                </div>
                {state.privacy.byok.configured ? (
                  <div className="origin-security-byok-connected">
                    <span className="origin-security-setting-icon">
                      <Icon name="key" size={15} />
                    </span>
                    <div>
                      <strong>{state.privacy.byok.provider}</strong>
                      <span>Key ending ••••{state.privacy.byok.keySuffix}</span>
                      <small>
                        Connected{' '}
                        {new Date(state.privacy.byok.connectedAt ?? '').toLocaleDateString()} · raw
                        key not stored in demo state
                      </small>
                    </div>
                    <button
                      className="origin-security-button origin-security-button--danger"
                      onClick={removeByok}
                      type="button"
                    >
                      Remove key
                    </button>
                  </div>
                ) : (
                  <div className="origin-security-byok-form">
                    <label className="origin-security-field">
                      <span>Provider</span>
                      <select
                        onChange={(event) =>
                          setByokProvider(
                            event.target.value as 'OpenAI' | 'Anthropic' | 'Azure OpenAI',
                          )
                        }
                        value={byokProvider}
                      >
                        <option>OpenAI</option>
                        <option>Anthropic</option>
                        <option>Azure OpenAI</option>
                      </select>
                    </label>
                    <label className="origin-security-field origin-security-field--wide">
                      <span>Provider API key</span>
                      <div className="origin-security-secret-input">
                        <Icon name="key" size={14} />
                        <input
                          autoComplete="off"
                          onChange={(event) => setByokDraft(event.target.value)}
                          placeholder="sk-demo-••••••••"
                          type="password"
                          value={byokDraft}
                        />
                      </div>
                      <small>
                        Demo behavior: the raw value stays only in component memory; persistence
                        retains only its provider and final four characters.
                      </small>
                    </label>
                    <button
                      className="origin-security-button origin-security-button--secondary"
                      onClick={saveByok}
                      type="button"
                    >
                      Verify & connect
                    </button>
                  </div>
                )}
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Product telemetry</h3>
                    <p>Optional signals used to improve reliability and usability.</p>
                  </div>
                </div>
                <label className="origin-security-toggle-row">
                  <span>
                    <strong>Anonymous product analytics</strong>
                    <small>
                      Feature usage and performance without portfolio values or instrument names.
                    </small>
                  </span>
                  <input
                    checked={state.privacy.productAnalytics}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        privacy: { ...current.privacy, productAnalytics: event.target.checked },
                      }))
                    }
                    type="checkbox"
                  />
                </label>
                <label className="origin-security-toggle-row">
                  <span>
                    <strong>Crash diagnostics</strong>
                    <small>Technical stack traces with financial data fields removed.</small>
                  </span>
                  <input
                    checked={state.privacy.crashDiagnostics}
                    onChange={(event) =>
                      setState((current) => ({
                        ...current,
                        privacy: { ...current.privacy, crashDiagnostics: event.target.checked },
                      }))
                    }
                    type="checkbox"
                  />
                </label>
              </section>
            </div>
          ) : null}

          {section === 'data' ? (
            <div className="origin-security-section">
              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Your data home</h3>
                    <p>Where BetterTrack stores the account’s authoritative encrypted data.</p>
                  </div>
                  <span className="origin-security-state origin-security-state--healthy">
                    <span /> Healthy
                  </span>
                </div>
                <div className="origin-security-data-home">
                  <div className="origin-security-data-home__map">
                    <span className="origin-security-data-home__region">
                      <span />
                      {selectedDataHome.code}
                    </span>
                    <div className="origin-security-data-home__orbit origin-security-data-home__orbit--one" />
                    <div className="origin-security-data-home__orbit origin-security-data-home__orbit--two" />
                    <div className="origin-security-data-home__grid" />
                  </div>
                  <div className="origin-security-data-home__copy">
                    <span className="origin-security-kicker">{selectedDataHome.kicker}</span>
                    <h3>{selectedDataHome.title}</h3>
                    <p>{selectedDataHome.description}</p>
                    <dl>
                      <div>
                        <dt>Encryption</dt>
                        <dd>{selectedDataHome.encryption}</dd>
                      </div>
                      <div>
                        <dt>Backup region</dt>
                        <dd>{selectedDataHome.backup}</dd>
                      </div>
                      <div>
                        <dt>Account objects</dt>
                        <dd>8 portfolios · 14,208 activities · 46 documents</dd>
                      </div>
                      <div>
                        <dt>Last integrity check</dt>
                        <dd>Today, 06:00 CEST · passed</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                <div className="origin-security-data-boundary">
                  <div>
                    <span className="origin-security-setting-icon">
                      <Icon name="database" size={15} />
                    </span>
                    <span>
                      <strong>BetterTrack data home</strong>
                      <small>Portfolios, activity, Workbench, collaboration, audit trail</small>
                    </span>
                  </div>
                  <Icon name="arrow-right" size={15} />
                  <div>
                    <span className="origin-security-setting-icon">
                      <Icon name="link" size={15} />
                    </span>
                    <span>
                      <strong>Connected source systems</strong>
                      <small>Brokers, Drive, market data, and optional model provider</small>
                    </span>
                  </div>
                </div>
              </section>

              <section className="origin-security-group">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Export your data</h3>
                    <p>Create a portable archive without pausing the account.</p>
                  </div>
                  <span>Downloads expire after 7 days</span>
                </div>
                <div className="origin-security-export-options">
                  {(
                    [
                      [
                        'all-data',
                        'Complete account archive',
                        'All portfolios, activities, Workbench objects, documents, collaboration, and audit events.',
                        'JSON + CSV',
                      ],
                      [
                        'portfolio-data',
                        'Portfolio data only',
                        'Holdings, transactions, cash flows, assets, prices, and portfolio relationships.',
                        'CSV',
                      ],
                      [
                        'audit-history',
                        'Audit & security history',
                        'Sign-ins, sessions, account changes, imports, automations, and approval receipts.',
                        'JSON',
                      ],
                    ] as const
                  ).map(([scope, label, description, format]) => (
                    <div key={scope}>
                      <span className="origin-security-export-icon">
                        <Icon
                          name={
                            scope === 'all-data'
                              ? 'database'
                              : scope === 'portfolio-data'
                                ? 'portfolio'
                                : 'shield'
                          }
                          size={16}
                        />
                      </span>
                      <div>
                        <strong>{label}</strong>
                        <p>{description}</p>
                        <small>{format} · encrypted download link</small>
                      </div>
                      <button
                        className="origin-security-button origin-security-button--secondary"
                        disabled={state.exportJobs.some(
                          (job) => job.scope === scope && job.status === 'processing',
                        )}
                        onClick={() => requestExport(scope)}
                        type="button"
                      >
                        Request
                      </button>
                    </div>
                  ))}
                </div>
              </section>

              {state.exportJobs.length > 0 ? (
                <section className="origin-security-group">
                  <div className="origin-security-group__head">
                    <div>
                      <h3>Export requests</h3>
                      <p>Prepared archives and their download lifecycle.</p>
                    </div>
                  </div>
                  <div className="origin-security-job-list">
                    {state.exportJobs.map((job) => (
                      <div className="origin-security-job" key={job.id}>
                        <span
                          className={`origin-security-job__state origin-security-job__state--${job.status}`}
                        >
                          {job.status === 'processing' ? (
                            <span className="origin-security-spinner" />
                          ) : (
                            <Icon name={job.status === 'ready' ? 'check' : 'download'} size={13} />
                          )}
                        </span>
                        <div>
                          <strong>{scopeLabel(job.scope)}</strong>
                          <span>
                            {job.id} · requested{' '}
                            {new Date(job.requestedAt).toLocaleString([], {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })}
                          </span>
                        </div>
                        <span>
                          <strong>{exportStatusLabel(job.status)}</strong>
                          <small>{job.size ?? 'Preparing manifest…'}</small>
                        </span>
                        {job.status === 'ready' || job.status === 'downloaded' ? (
                          <button
                            className="origin-security-button origin-security-button--primary"
                            onClick={() => downloadExport(job)}
                            type="button"
                          >
                            <Icon name="download" size={13} />
                            {job.status === 'downloaded' ? 'Download again' : 'Download'}
                          </button>
                        ) : (
                          <span className="origin-security-state origin-security-state--neutral">
                            Processing
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          ) : null}

          {section === 'danger' ? (
            <div className="origin-security-section">
              <div className="origin-security-danger-intro">
                <span>
                  <Icon name="shield" size={18} />
                </span>
                <div>
                  <span className="origin-security-kicker">Irreversible actions</span>
                  <h3>Slow down at the boundary</h3>
                  <p>
                    Account deletion removes access, portfolio state, credentials, and collaboration
                    links. Request an export first if any copy should survive.
                  </p>
                </div>
              </div>
              <section className="origin-security-group origin-security-group--danger">
                <div className="origin-security-group__head">
                  <div>
                    <h3>Delete BetterTrack account</h3>
                    <p>This action signs out every device and cannot be undone.</p>
                  </div>
                  <span>Permanent</span>
                </div>
                <div className="origin-security-delete-summary">
                  <div>
                    <span>8</span>
                    <small>portfolios deleted</small>
                  </div>
                  <div>
                    <span>14,208</span>
                    <small>activities deleted</small>
                  </div>
                  <div>
                    <span>{activeSessions.length}</span>
                    <small>sessions revoked</small>
                  </div>
                  <div>
                    <span>{state.passkeys.length}</span>
                    <small>passkeys removed</small>
                  </div>
                </div>
                <div className="origin-security-danger-action">
                  <div>
                    <strong>Deletion includes nested and collaborative data</strong>
                    <span>
                      Shared portfolios transfer only where another owner exists. Public links and
                      OAuth grants stop immediately.
                    </span>
                  </div>
                  <button
                    className="origin-security-button origin-security-button--danger-solid"
                    onClick={() => {
                      setDeleteConfirmation('');
                      setModal('delete');
                    }}
                    type="button"
                  >
                    <Icon name="trash" size={13} /> Delete account
                  </button>
                </div>
              </section>
              <div className="origin-security-inline-note origin-security-inline-note--danger">
                <Icon name="lock" size={14} />
                <span>
                  This is a frontend simulation. Confirming deletion clears only the local{' '}
                  <code>{ORIGIN_SECURITY_STORAGE_KEY}</code> demo key and returns a fictional
                  deletion receipt.
                </span>
              </div>
            </div>
          ) : null}
        </main>
      </div>

      {modal === 'unlink-google' ? (
        <div
          className="origin-security-modal-backdrop"
          data-accessible-dialog-layer
          role="presentation"
        >
          <section
            aria-labelledby="unlink-google-title"
            aria-modal="true"
            className="origin-security-modal origin-security-modal--small"
            ref={securityDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <span className="origin-security-modal__icon">
              <Icon name="link" size={18} />
            </span>
            <h2 id="unlink-google-title">Unlink Google sign-in?</h2>
            <p>
              You will continue signing in with {state.profile.email} and your BetterTrack password.
              Portfolio connections to Google Drive are separate and stay untouched.
            </p>
            <div className="origin-security-modal__actions">
              <button
                className="origin-security-button origin-security-button--secondary"
                onClick={() => setModal(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="origin-security-button origin-security-button--danger"
                onClick={unlinkGoogle}
                type="button"
              >
                Unlink Google
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {modal === 'totp' ? (
        <div
          className="origin-security-modal-backdrop"
          data-accessible-dialog-layer
          role="presentation"
        >
          <section
            aria-labelledby={totpPhase === 'codes' ? 'totp-recovery-title' : 'totp-title'}
            aria-modal="true"
            className="origin-security-modal"
            ref={securityDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            {totpPhase !== 'codes' ? (
              <>
                <div className="origin-security-modal__head">
                  <div>
                    <span className="origin-security-kicker">Authenticator setup</span>
                    <h2 id="totp-title" ref={securityStepHeadingRef} tabIndex={-1}>
                      {totpPhase === 'scan'
                        ? 'Scan the private setup code'
                        : 'Verify your authenticator'}
                    </h2>
                  </div>
                  <button
                    aria-label="Close"
                    className="origin-security-modal__close"
                    onClick={() => {
                      setTotpSecret('');
                      setModal(null);
                    }}
                    type="button"
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
                <div className="origin-security-totp-layout">
                  <div className="origin-security-qr" aria-label="Fictional QR setup code">
                    {Array.from({ length: 81 }, (_, index) => (
                      <span
                        className={(index * 7 + Math.floor(index / 9) * 3) % 5 < 2 ? 'is-dark' : ''}
                        key={index}
                      />
                    ))}
                  </div>
                  <div>
                    <ol>
                      <li>Open a trusted authenticator app.</li>
                      <li>Scan this fictional BetterTrack QR pattern.</li>
                      <li>Enter the current six-digit code.</li>
                    </ol>
                    <div className="origin-security-totp-secret">
                      <span>Manual setup key · never persisted</span>
                      <code>{totpSecret}</code>
                    </div>
                  </div>
                </div>
                {totpPhase === 'verify' ? (
                  <label className="origin-security-field origin-security-totp-code">
                    <span>Six-digit code</span>
                    <input
                      aria-describedby={totpError ? 'origin-security-totp-error' : undefined}
                      aria-invalid={totpError ? true : undefined}
                      autoFocus
                      inputMode="numeric"
                      maxLength={6}
                      onChange={(event) => {
                        setTotpCode(event.target.value.replace(/\D/g, ''));
                        setTotpError('');
                      }}
                      placeholder="000000"
                      value={totpCode}
                    />
                  </label>
                ) : null}
                {totpError ? (
                  <span
                    className="origin-security-form-error"
                    id="origin-security-totp-error"
                    role="alert"
                  >
                    {totpError}
                  </span>
                ) : null}
                <div className="origin-security-modal__actions">
                  <button
                    className="origin-security-button origin-security-button--secondary"
                    onClick={() => {
                      setTotpSecret('');
                      setModal(null);
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="origin-security-button origin-security-button--primary"
                    onClick={() => (totpPhase === 'scan' ? setTotpPhase('verify') : verifyTotp())}
                    type="button"
                  >
                    {totpPhase === 'scan' ? 'I scanned it' : 'Verify & enable'}
                    <Icon name="arrow-right" size={13} />
                  </button>
                </div>
              </>
            ) : (
              <RecoveryCodesPanel
                codes={recoveryCodes ?? []}
                copied={codesCopied}
                headingRef={securityStepHeadingRef}
                onClose={closeRecoveryCodes}
                onCopy={copyRecoveryCodes}
                title="Save your recovery codes"
                titleId="totp-recovery-title"
              />
            )}
          </section>
        </div>
      ) : null}

      {modal === 'recovery' ? (
        <div
          className="origin-security-modal-backdrop"
          data-accessible-dialog-layer
          role="presentation"
        >
          <section
            aria-labelledby="recovery-title"
            aria-modal="true"
            className="origin-security-modal"
            ref={securityDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <RecoveryCodesPanel
              codes={recoveryCodes ?? []}
              copied={codesCopied}
              onClose={closeRecoveryCodes}
              onCopy={copyRecoveryCodes}
              title="New recovery codes"
              titleId="recovery-title"
            />
          </section>
        </div>
      ) : null}

      {modal === 'delete' ? (
        <div
          className="origin-security-modal-backdrop"
          data-accessible-dialog-layer
          role="presentation"
        >
          <section
            aria-labelledby="delete-title"
            aria-modal="true"
            className="origin-security-modal origin-security-modal--danger"
            ref={securityDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="origin-security-modal__head">
              <div>
                <span className="origin-security-kicker">Permanent deletion</span>
                <h2 id="delete-title">Delete the entire account?</h2>
              </div>
              <button
                aria-label="Close"
                className="origin-security-modal__close"
                onClick={() => setModal(null)}
                type="button"
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="origin-security-delete-warning">
              <Icon name="trash" size={18} />
              <span>
                This signs out every session, removes credentials and AI grants, deletes portfolios
                and nested data, and disables every public or collaborative link.
              </span>
            </div>
            <label className="origin-security-toggle-row origin-security-toggle-row--boxed">
              <span>
                <strong>Preserve my latest requested export for 7 days</strong>
                <small>The encrypted archive remains available through the deletion receipt.</small>
              </span>
              <input
                checked={deleteKeepExport}
                onChange={(event) => setDeleteKeepExport(event.target.checked)}
                type="checkbox"
              />
            </label>
            <label className="origin-security-field">
              <span>
                Type <strong>DELETE MY ACCOUNT</strong> to confirm
              </span>
              <input
                autoComplete="off"
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                placeholder="DELETE MY ACCOUNT"
                value={deleteConfirmation}
              />
            </label>
            <div className="origin-security-modal__actions">
              <button
                className="origin-security-button origin-security-button--secondary"
                onClick={() => setModal(null)}
                type="button"
              >
                Keep account
              </button>
              <button
                className="origin-security-button origin-security-button--danger-solid"
                disabled={deleteConfirmation !== 'DELETE MY ACCOUNT' || working === 'delete'}
                onClick={deleteAccount}
                type="button"
              >
                {working === 'delete' ? (
                  <>
                    <span className="origin-security-spinner" /> Deleting and signing out…
                  </>
                ) : (
                  <>
                    <Icon name="trash" size={13} /> Permanently delete
                  </>
                )}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function RecoveryCodesPanel({
  codes,
  copied,
  headingRef,
  onClose,
  onCopy,
  title,
  titleId,
}: {
  codes: string[];
  copied: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  onCopy: () => void;
  title: string;
  titleId: string;
}) {
  return (
    <>
      <div className="origin-security-recovery-head">
        <span className="origin-security-recovery-head__icon">
          <Icon name="key" size={18} />
        </span>
        <span className="origin-security-kicker">Shown once</span>
        <h2 id={titleId} ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
          {title}
        </h2>
        <p>
          Each code signs in once if your authenticator is unavailable. Closing this window
          permanently removes these raw codes from the demo’s memory.
        </p>
      </div>
      <div className="origin-security-recovery-grid">
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </div>
      <div className="origin-security-inline-note">
        <Icon name="lock" size={14} />
        <span>
          Recovery codes are never written to <code>{ORIGIN_SECURITY_STORAGE_KEY}</code>. Only the
          remaining code count is persisted.
        </span>
      </div>
      <div className="origin-security-modal__actions">
        <button
          className="origin-security-button origin-security-button--secondary"
          onClick={onCopy}
          type="button"
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy codes'}
        </button>
        <button
          className="origin-security-button origin-security-button--primary"
          onClick={onClose}
          type="button"
        >
          I stored them safely
        </button>
      </div>
    </>
  );
}
