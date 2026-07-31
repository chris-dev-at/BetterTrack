import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParanoidVaultMediaState } from '@bettertrack/contracts';

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

vi.mock('../VaultRuntimeProvider', () => ({
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

    await user.click(screen.getByRole('button', { name: 'Synced' }));

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
});
