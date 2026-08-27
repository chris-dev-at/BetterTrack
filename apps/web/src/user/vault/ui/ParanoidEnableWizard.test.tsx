import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PARANOID_TRANSITION_ERROR_CODES } from '@bettertrack/contracts';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  prepare: vi.fn(),
  enable: vi.fn(),
  deliver: vi.fn(),
  migrate: vi.fn(),
  commitApi: vi.fn(),
  prepareDriveStorage: vi.fn(),
  authorizeDriveStorage: vi.fn(),
  unlockWithPassphrase: vi.fn(),
}));

vi.mock('../../AuthContext', () => ({
  useAuth: () => ({ user: { id: '018f0000-0000-7000-8000-000000000001' } }),
}));
vi.mock('../VaultRuntimeProvider', () => ({
  useVaultRuntime: () => ({
    prepareDriveStorage: mocks.prepareDriveStorage,
    authorizeDriveStorage: mocks.authorizeDriveStorage,
    unlockWithPassphrase: mocks.unlockWithPassphrase,
  }),
}));
vi.mock('../export/deliver', () => ({
  deliverClientDownload: mocks.deliver,
}));
vi.mock('../serverBlobDataHome', () => ({
  createServerBlobDataHome: () => ({ medium: 'server' }),
}));
// Only the capture call is stubbed: `VaultCaptureUnstableError` stays REAL, so
// the wizard's `instanceof` mapping is exercised rather than mocked away.
vi.mock('./migration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./migration')>();
  return { ...actual, captureNormalVault: mocks.migrate };
});
vi.mock('./enable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./enable')>();
  return {
    ...actual,
    prepareVaultMaterial: mocks.prepare,
    enablePreparedVault: mocks.enable,
  };
});
// Only the commit endpoint is stubbed; every other user API stays real so the
// modules under test keep their genuine imports.
vi.mock('../../../lib/userApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/userApi')>();
  return { ...actual, enableParanoidMode: mocks.commitApi };
});

import { ParanoidEnableWizard } from './ParanoidEnableWizard';
import { ApiError, isRateLimitHandledLocally } from '../../../lib/apiClient';
import { VaultEnableError } from './enable';
import { VaultCaptureUnstableError } from './migration';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({
    keyId: '018f0000-0000-7000-8000-000000000002',
    vaultKey: new Uint8Array(32).fill(1),
    wrappedKey: {},
    recoveryKit: {
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'bettertrack-recovery-kit.txt',
      type: 'text/plain;charset=utf-8',
    },
    dispose: mocks.dispose,
  });
  mocks.prepareDriveStorage.mockResolvedValue(undefined);
  mocks.authorizeDriveStorage.mockResolvedValue({ medium: 'drive' });
  mocks.unlockWithPassphrase.mockResolvedValue({});
  mocks.enable.mockImplementation(async (input: { onStage?: (stage: string) => void }) => {
    input.onStage?.('migrate');
    input.onStage?.('commit');
    return {
      envelope: new Uint8Array([9]),
      version: 1,
      receipt: {
        mode: 'paranoid',
        mediaSet: ['server'],
        vaultVersion: 1,
        completedAt: '2026-07-30T10:00:00.000Z',
        idempotent: false,
      },
    };
  });
});

describe('ParanoidEnableWizard', () => {
  it('orders review → default storage → distinct passphrase/recovery → verified migration', async () => {
    const user = userEvent.setup();
    const enabled = vi.fn();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={enabled} />);

    expect(screen.getByRole('heading', { name: 'What changes' })).toBeInTheDocument();
    expect(screen.getByText(/Sharing, shared items, comments/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('radio', { name: /BetterTrack encrypted storage/i })).toBeChecked();
    expect(screen.getByText('Encrypted on BetterTrack; only you can read it.')).toBeInTheDocument();
    expect(screen.getByText(/Nothing on BetterTrack servers/i)).not.toBeVisible();
    await user.click(screen.getByText('Advanced'));
    expect(screen.getByText('Nothing on BetterTrack servers — not even encrypted.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByText(/different from your BetterTrack login password/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );

    const enable = screen.getByRole('button', { name: 'Enable Paranoid mode' });
    expect(enable).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      'text/plain;charset=utf-8',
      'bettertrack-recovery-kit.txt',
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(
      screen.getByRole('checkbox', {
        name: 'If I lose my vault passphrase and my recovery kit, my data is gone forever. BetterTrack cannot recover it.',
      }),
    );
    expect(enable).toBeEnabled();

    await user.click(enable);

    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(enabled).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'paranoid', mediaSet: ['server'] }),
    );
    expect(mocks.unlockWithPassphrase).toHaveBeenCalledWith('correct horse battery staple 729', {
      authorizeDrive: false,
      driveOnly: false,
      keepUnlocked: false,
    });
    expect(mocks.authorizeDriveStorage).not.toHaveBeenCalled();
  });

  it('connects Google Drive from the storage step before showing the passphrase step', async () => {
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Also keep a verified copy in my Google Drive' }),
    );

    await waitFor(() => {
      expect(mocks.prepareDriveStorage).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeEnabled();
    });
    expect(screen.getByText(/Connect Google Drive before continuing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));

    expect(mocks.authorizeDriveStorage).toHaveBeenCalledOnce();
    expect(screen.getByText(/Google Drive is connected and ready/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.commitApi).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByLabelText('Vault passphrase')).toBeInTheDocument();
  });

  it('prepares GIS before it enables the first Google Drive authorization gesture', async () => {
    let finishPreparation!: () => void;
    mocks.prepareDriveStorage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Also keep a verified copy in my Google Drive' }),
    );

    await waitFor(() => expect(mocks.prepareDriveStorage).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Preparing Google sign-in…' })).toBeDisabled();
    expect(mocks.authorizeDriveStorage).not.toHaveBeenCalled();

    finishPreparation();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeEnabled(),
    );
  });

  it('keeps the account untouched when the early Google Drive popup is blocked', async () => {
    mocks.authorizeDriveStorage.mockRejectedValueOnce(new Error('popup blocked'));
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Also keep a verified copy in my Google Drive' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Allow the Google sign-in popup.*account has not changed/i,
    );
    expect(screen.getByRole('heading', { name: 'Choose encrypted storage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.queryByLabelText('Vault passphrase')).not.toBeInTheDocument();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.commitApi).not.toHaveBeenCalled();
  });

  it('rechecks Drive authorization from the final Enable gesture before writing', async () => {
    const earlyDrive = { medium: 'drive' };
    const refreshedDrive = { medium: 'drive', refreshed: true };
    mocks.authorizeDriveStorage
      .mockResolvedValueOnce(earlyDrive)
      .mockResolvedValueOnce(refreshedDrive);
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Also keep a verified copy in my Google Drive' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(mocks.authorizeDriveStorage).toHaveBeenCalledTimes(2);
    expect(mocks.enable).toHaveBeenCalledWith(
      expect.objectContaining({ mediaSet: ['server', 'drive'] }),
      expect.objectContaining({ drive: refreshedDrive }),
    );
  });

  it('locks navigation and discards a late final Drive authorization after dismissal', async () => {
    const finalAuthorization = deferred<{ medium: 'drive' }>();
    mocks.authorizeDriveStorage
      .mockResolvedValueOnce({ medium: 'drive' })
      .mockReturnValueOnce(finalAuthorization.promise);
    const user = userEvent.setup();
    const rendered = render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Also keep a verified copy in my Google Drive' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    await waitFor(() => expect(mocks.authorizeDriveStorage).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    // A route/panel close can still unmount the wizard while Google owns its
    // popup. Resolving it afterwards must not encrypt with the now-zeroed key
    // or commit the storage choice the user just left.
    rendered.unmount();
    await act(async () => {
      finalAuthorization.resolve({ medium: 'drive' });
      await finalAuthorization.promise;
    });

    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.commitApi).not.toHaveBeenCalled();
  });

  it('requires a new Drive connection after final reauthorization fails', async () => {
    mocks.authorizeDriveStorage
      .mockResolvedValueOnce({ medium: 'drive' })
      .mockRejectedValueOnce(new Error('token expired'));
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Also keep a verified copy in my Google Drive' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /needs to be reconnected before the transfer can start.*account has not changed/i,
    );
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
    expect(mocks.commitApi).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Enable Paranoid mode' })).toBeDisabled();

    // The failed final check invalidates the early Drive home. Going back
    // cannot re-enter the passphrase/recovery step until Drive reconnects.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Choose encrypted storage' })).toBeInTheDocument();
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await user.click(continueButton);
    expect(screen.queryByLabelText('Vault passphrase')).not.toBeInTheDocument();
  });

  it.each([
    [PARANOID_TRANSITION_ERROR_CODES.mirrorchainActive, /Leave your MIRRORCHAIN group portfolio/i],
    [PARANOID_TRANSITION_ERROR_CODES.importInFlight, /Finish or cancel the active import/i],
    [PARANOID_TRANSITION_ERROR_CODES.exportInFlight, /Wait for the account export to finish/i],
  ])('turns enable precondition %s into actionable copy', async (code, expected) => {
    mocks.enable.mockRejectedValue(
      new VaultEnableError('commit', 'transition refused', {
        cause: new ApiError(409, code, 'transition refused'),
      }),
    );
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  });

  it('names the real cause when the capture could not hold the account still', async () => {
    // A capture that gave up must not read as "your connection dropped, retry" —
    // that advice sends the user straight back into the same loop. The dedicated
    // error type earns dedicated copy: close the other writer, then start again.
    mocks.enable.mockRejectedValue(
      new VaultEnableError('migrate', 'Your existing data could not be prepared safely.', {
        cause: new VaultCaptureUnstableError(2),
      }),
    );
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /kept changing while BetterTrack was collecting it/i,
    );
  });

  it.each([
    [1, '1 data section collected safely.'],
    [23, '23 data sections collected safely.'],
  ])('shows capture progress for %i completed reads', async (completedRequests, expected) => {
    mocks.migrate.mockImplementation(
      async (options: { onProgress?: (progress: { completedRequests: number }) => void }) => {
        options.onProgress?.({ completedRequests });
        return {
          document: { schemaVersion: 1, entities: {}, mergeLog: [] },
          normalDataRevision: 'r1',
        };
      },
    );
    mocks.enable.mockImplementation(
      async (
        input: { onStage?: (stage: string) => void },
        dependencies: { migrate(): Promise<unknown> },
      ) => {
        input.onStage?.('migrate');
        await dependencies.migrate();
        return {
          envelope: new Uint8Array([9]),
          version: 1,
          receipt: {
            mode: 'paranoid',
            mediaSet: ['server'],
            vaultVersion: 1,
            completedAt: '2026-07-30T10:00:00.000Z',
            idempotent: false,
          },
        };
      },
    );
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  // Rate limiting is not a capture-only hazard: the commit is a request too, and
  // its 429 is equally invisible to the global banner (the wizard opts every one
  // of its calls out of it), so every stage has to reach the same named-wait copy.
  it.each(['migrate', 'commit'] as const)(
    'names the server wait when rate limiting hits the %s stage',
    async (stage) => {
      mocks.enable.mockRejectedValue(
        new VaultEnableError(stage, 'stage failed', {
          cause: new ApiError(429, 'RATE_LIMITED', 'Too many requests.', undefined, 37),
        }),
      );
      const user = userEvent.setup();
      render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      await user.type(
        screen.getByLabelText('Vault passphrase'),
        'correct horse battery staple 729',
      );
      await user.type(
        screen.getByLabelText('Confirm vault passphrase'),
        'correct horse battery staple 729',
      );
      await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
      await user.click(
        screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
      );
      await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
      await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/request limit.*37 seconds/i);
    },
  );

  it('opts the commit request out of the app-wide rate-limit banner', async () => {
    // The capture tags its own reads; the commit is the only other request the
    // transition puts through `apiRequest`, so it must carry the same tag — or a
    // commit 429 would fire the global "too fast" banner mid-transition.
    mocks.commitApi.mockResolvedValue({
      mode: 'paranoid',
      mediaSet: ['server'],
      vaultVersion: 1,
      completedAt: '2026-07-30T10:00:00.000Z',
      idempotent: false,
    });
    mocks.enable.mockImplementation(
      async (
        input: { onStage?: (stage: string) => void },
        dependencies: { commit(body: unknown): Promise<unknown> },
      ) => {
        input.onStage?.('commit');
        const receipt = await dependencies.commit({
          mediaSet: ['server'],
          vaultVersion: 1,
          driveAttestation: null,
          normalDataRevision: 'r1',
        });
        return { envelope: new Uint8Array([9]), version: 1, receipt };
      },
    );
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(mocks.commitApi).toHaveBeenCalledOnce();
    const [, signal] = mocks.commitApi.mock.calls[0] as [unknown, AbortSignal | undefined];
    expect(isRateLimitHandledLocally(signal)).toBe(true);
    // A tag, not a cancel handle: nothing in the wizard can abort it.
    expect(signal?.aborted).toBe(false);
  });

  it('leaves non-429 failures on their stage copy', async () => {
    mocks.enable.mockRejectedValue(
      new VaultEnableError('migrate', 'Your existing data could not be prepared safely.', {
        cause: new ApiError(503, 'UNAVAILABLE', 'Service unavailable.'),
      }),
    );
    const user = userEvent.setup();
    render(<ParanoidEnableWizard onCancel={() => {}} onEnabled={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText('Vault passphrase'), 'correct horse battery staple 729');
    await user.type(
      screen.getByLabelText('Confirm vault passphrase'),
      'correct horse battery staple 729',
    );
    await user.click(screen.getByRole('button', { name: 'Download recovery kit' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'I have stored my recovery kit safely.' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /my data is gone forever/i }));
    await user.click(screen.getByRole('button', { name: 'Enable Paranoid mode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Your current data could not be collected completely/i,
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
