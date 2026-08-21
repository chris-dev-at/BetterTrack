import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParanoidVaultMediaState, VaultConfig } from '@bettertrack/contracts';

import type { VaultSyncState } from '../sync';

const runtime = vi.hoisted(() => ({
  syncState: null as VaultSyncState | null,
  driveAuthorization: 'connected' as
    | 'connected'
    | 'consent-required'
    | 'token-expired'
    | 'permission-denied',
  connection: {
    resume: vi.fn(async () => undefined),
  },
  reconnect: vi.fn(async () => ({})),
}));

vi.mock('../VaultRuntimeContext', () => ({
  useVaultRuntime: () => runtime,
}));

import { VaultSyncChip } from './VaultSyncChip';

const BOTH_MEDIA: ParanoidVaultMediaState = {
  mediaSet: ['server', 'drive'],
  driveAttestedVersion: 4,
  server: {
    disposition: 'active',
    candidate: null,
    retired: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  runtime.driveAuthorization = 'connected';
  runtime.syncState = {
    status: 'synced',
    active: {
      header: { writtenAt: '2026-07-30T10:00:00.000Z' },
    },
    pending: null,
  } as unknown as VaultSyncState;
});

describe('VaultSyncChip', () => {
  it('keeps status compact and reveals last write plus each selected medium in its popover', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VaultSyncChip media={BOTH_MEDIA} />
      </MemoryRouter>,
    );

    const trigger = screen.getByRole('button', { name: 'Synced' });
    expect(trigger).toHaveClass('bt-btn', 'bt-btn--quiet', 'bt-btn--sm');
    await user.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Encrypted vault sync' })).toBeInTheDocument();
    expect(screen.getByText('BetterTrack')).toBeInTheDocument();
    expect(screen.getByText('Google Drive')).toBeInTheDocument();
    expect(screen.getByText('Last encrypted write')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Storage and restore options' })).toHaveAttribute(
      'href',
      '/control/privacy?restore=1',
    );
  });

  it('surfaces token expiry as attention and resumes only from the user gesture', async () => {
    runtime.driveAuthorization = 'token-expired';
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VaultSyncChip media={BOTH_MEDIA} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(screen.getByText('Sign in to Google to sync')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in to Google and resume' }));
    expect(runtime.connection.resume).toHaveBeenCalledOnce();
    expect(runtime.reconnect).toHaveBeenCalledOnce();
  });

  it('uses one aggregate chip with one actionable row per vault', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VaultSyncChip
          vaults={[
            {
              vault: vault('018f0000-0000-7000-8000-000000000011', 'Long-term'),
              endpointState: {
                status: 'not-on-this-endpoint',
                requiredAction: {
                  kind: 'provide-phrase',
                  methods: ['enter-words', 'scan-qr'],
                },
              },
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000012', 'Daily'),
              endpointState: {
                status: 'stored+plain',
                requiredAction: { kind: 'open-silently' },
              },
              syncState: 'syncing',
            },
          ]}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Syncing' }));
    expect(screen.getAllByRole('dialog', { name: 'Encrypted vault sync' })).toHaveLength(1);
    expect(screen.getByText('Long-term')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Enter words' })).toHaveAttribute(
      'href',
      '/control/privacy?vault=018f0000-0000-7000-8000-000000000011&action=provide-phrase',
    );
    expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument();
  });

  it('keeps an inline action on a popover row for every E3 endpoint state', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VaultSyncChip
          vaults={[
            {
              vault: vault('018f0000-0000-7000-8000-000000000021', 'Wrapped locked'),
              endpointState: {
                status: 'stored+wrapped',
                session: 'locked',
                requiredAction: { kind: 'unlock', credential: 'device-password' },
              },
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000022', 'Wrapped waiting'),
              endpointState: {
                status: 'stored+wrapped',
                session: 'locked',
                requiredAction: {
                  kind: 'wait-or-reset',
                  retryAt: 1,
                  alternative: 'reset-endpoint-keystore',
                },
              },
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000023', 'Wrapped open'),
              endpointState: {
                status: 'stored+wrapped',
                session: 'unlocked',
                requiredAction: { kind: 'open-silently' },
              },
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000024', 'Plain open'),
              endpointState: {
                status: 'stored+plain',
                requiredAction: { kind: 'open-silently' },
              },
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000025', 'Phrase needed'),
              endpointState: {
                status: 'not-on-this-endpoint',
                requiredAction: {
                  kind: 'provide-phrase',
                  methods: ['enter-words', 'scan-qr'],
                },
              },
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000026', 'Invalid device'),
              endpointState: {
                status: 'endpoint-keystore-invalid',
                requiredAction: { kind: 'reset-endpoint-keystore' },
              },
            },
          ]}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Locked (4)' }));
    expect(screen.getAllByRole('link', { name: 'Unlock' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Reset this device' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Enter words' })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Scan QR' })).toHaveLength(1);
  });

  it('puts the worst storage-state recovery action and per-medium detail on its row', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <VaultSyncChip
          vaults={[
            {
              vault: vault('018f0000-0000-7000-8000-000000000031', 'Drive vault', [
                'server',
                'drive',
              ]),
              endpointState: {
                status: 'stored+plain',
                requiredAction: { kind: 'open-silently' },
              },
              driveAuthorization: 'consent-required',
            },
            {
              vault: vault('018f0000-0000-7000-8000-000000000032', 'Conflict vault'),
              endpointState: {
                status: 'stored+plain',
                requiredAction: { kind: 'open-silently' },
              },
              syncState: 'attention',
            },
          ]}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Attention: Drive vault' }));
    expect(screen.getByRole('link', { name: 'Sign in to Google' })).toHaveAttribute(
      'href',
      '/control/connections?vault=018f0000-0000-7000-8000-000000000031',
    );
    expect(screen.getByRole('link', { name: 'Choose a restore copy' })).toHaveAttribute(
      'href',
      '/control/privacy?vault=018f0000-0000-7000-8000-000000000032&action=restore',
    );
    expect(screen.getAllByText('BetterTrack')).toHaveLength(2);
    expect(screen.getByText('Google Drive')).toBeInTheDocument();
  });
});

function vault(id: string, name: string, media: VaultConfig['media'] = ['server']): VaultConfig {
  return {
    id,
    name,
    headerDocId: `${id.slice(0, -1)}a`,
    commonDocId: `${id.slice(0, -1)}b`,
    media,
    driveConnectionId: media.includes('drive') ? '018f0000-0000-7000-8000-000000000099' : null,
    keyFingerprint: 'abcdefghijklmnop',
    retirementProofPublicKey: 'cHVibGljLWtleQ',
    retirementGeneration: 0,
    mediaAttestedAt: '2026-08-20T10:00:00.000Z',
    mediaAttestedDriveConnectionId: media.includes('drive')
      ? '018f0000-0000-7000-8000-000000000099'
      : null,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
  };
}
