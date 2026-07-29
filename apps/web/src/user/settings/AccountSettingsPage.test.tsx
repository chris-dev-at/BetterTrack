import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  ExportRequestResponse,
  ExportStatusResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getMe: vi.fn(),
  changePassword: vi.fn(),
  requestDataExport: vi.fn(),
  getDataExportStatus: vi.fn(),
  getParanoidMediaState: vi.fn(),
  dataExportDownloadUrl: vi.fn(
    (token: string) => `/api/v1/account/export/download?token=${encodeURIComponent(token)}`,
  ),
}));
vi.mock('../../lib/settingsApi', () => ({
  getAccountSettings: vi.fn(),
  updateAccountSettings: vi.fn(),
}));
vi.mock('../vault/export/deliver', () => ({
  deliverClientDownload: vi.fn(),
  printClientDocument: vi.fn(),
}));

import { webcrypto } from 'node:crypto';

import { I18nProvider } from '../../i18n';
import { getMoneyCurrency, setMoneyCurrency } from '../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../lib/settingsApi';
import {
  changePassword,
  getDataExportStatus,
  getMe,
  getParanoidMediaState,
  requestDataExport,
} from '../../lib/userApi';
import {
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../vault/engine/clientMoney.testSupport';
import { VaultMoneyEngineProvider } from '../vault/engine/VaultMoneyEngineProvider';
import { deliverClientDownload } from '../vault/export/deliver';
import { AccountSettingsPage } from './AccountSettingsPage';

const ME: MeResponse = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'ada@example.com',
  username: 'ada',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-07-01T10:00:00.000Z',
  createdAt: '2026-01-15T09:00:00.000Z',
};

const NO_EXPORT: ExportStatusResponse = {
  status: null,
  jobId: null,
  requestedAt: null,
  expiresAt: null,
  sizeBytes: null,
};

const READY_EXPORT: ExportStatusResponse = {
  status: 'ready',
  jobId: '00000000-0000-0000-0000-0000000000aa',
  requestedAt: '2026-07-16T09:00:00.000Z',
  expiresAt: '2026-07-23T09:00:00.000Z',
  sizeBytes: 4096,
};

const REQUEST_RESPONSE: ExportRequestResponse = {
  jobId: '00000000-0000-0000-0000-0000000000aa',
  status: 'pending',
  downloadToken: 'raw-download-token-1',
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <AccountSettingsPage />
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getParanoidMediaState).mockResolvedValue({ privacyMode: 'normal', mediaState: null });
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(changePassword).mockResolvedValue(ME);
  vi.mocked(getDataExportStatus).mockResolvedValue(NO_EXPORT);
  vi.mocked(requestDataExport).mockResolvedValue(REQUEST_RESPONSE);
  vi.mocked(getAccountSettings).mockResolvedValue({
    defaultPortfolioVisibility: 'private',
    locale: 'en',
    baseCurrency: 'EUR',
    discreetMode: false,
  });
  vi.mocked(updateAccountSettings).mockResolvedValue({
    defaultPortfolioVisibility: 'private',
    locale: 'en',
    baseCurrency: 'EUR',
    discreetMode: false,
  });
});

// The default money currency is module-level state — restore EUR so tests
// stay order-independent.
afterEach(() => setMoneyCurrency('EUR'));

describe('AccountSettingsPage', () => {
  test('renders identity fields; the base currency moved to its own picker (V3-P10d)', async () => {
    renderPage();

    expect(await screen.findByText('ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Member since')).toBeInTheDocument();
    // The V2 "EUR (fixed)" identity marker is gone — the base is configurable now.
    expect(screen.queryByText(/\(fixed\)/)).not.toBeInTheDocument();
  });

  test('change-password submit calls the client with current + new', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Current password'), 'oldpassword1');
    await user.type(screen.getByLabelText('New password'), 'newpassword123');
    await user.type(screen.getByLabelText('Confirm new password'), 'newpassword123');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpassword1',
        newPassword: 'newpassword123',
      }),
    );
    expect(await screen.findByText(/password has been changed/i)).toBeInTheDocument();
  });

  test('mismatched new passwords do not call the client', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Current password'), 'oldpassword1');
    await user.type(screen.getByLabelText('New password'), 'newpassword123');
    await user.type(screen.getByLabelText('Confirm new password'), 'different12345');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  // Portfolio visibility moved to the Socials tab (#377): Settings no longer has
  // any sharing toggle — neither the per-default-portfolio one nor the create-time
  // default — only a signpost linking to where sharing now lives.
  test('has no visibility toggle and links to sharing in the Social tab (#377)', async () => {
    renderPage();

    expect(await screen.findByText('Portfolio sharing')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /manage sharing in social/i });
    expect(link).toHaveAttribute('href', '/people/shared');

    // The retired controls are gone: no Private/Friends or Yes/No radios.
    expect(screen.queryByRole('radio', { name: 'Friends' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Yes' })).not.toBeInTheDocument();
    // …and Settings never writes a portfolio visibility any more.
    expect(updateAccountSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ defaultPortfolioVisibility: expect.anything() }),
    );
  });

  test('the language picker persists the choice and switches the app to German', async () => {
    const user = userEvent.setup();
    vi.mocked(updateAccountSettings).mockResolvedValue({
      defaultPortfolioVisibility: 'private',
      locale: 'de',
      baseCurrency: 'EUR',
      discreetMode: false,
    });
    renderPage();

    // Renders in English by default (source of truth).
    expect(await screen.findByText('Account')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Display language'), 'de');

    // Persists the choice server-side …
    await waitFor(() => expect(updateAccountSettings).toHaveBeenCalledWith({ locale: 'de' }));
    // … and switches the app at runtime without a reload (German heading appears).
    expect(await screen.findByText('Konto')).toBeInTheDocument();
  });

  test('the base-currency picker persists the choice and flips the money formatter (V3-P10d)', async () => {
    const user = userEvent.setup();
    vi.mocked(updateAccountSettings).mockResolvedValue({
      defaultPortfolioVisibility: 'private',
      locale: 'en',
      baseCurrency: 'USD',
      discreetMode: false,
    });
    renderPage();

    // Defaults to EUR (the migration/backfill default) with all four options.
    const picker = await screen.findByLabelText('Base currency');
    await waitFor(() => expect(picker).toHaveValue('EUR'));
    for (const code of ['EUR', 'USD', 'CHF', 'GBP']) {
      expect(screen.getByRole('option', { name: new RegExp(`^${code} — `) })).toBeInTheDocument();
    }

    await user.selectOptions(picker, 'USD');

    // Persists the choice server-side …
    await waitFor(() =>
      expect(updateAccountSettings).toHaveBeenCalledWith({ baseCurrency: 'USD' }),
    );
    // … and immediately drives the display layer's default money currency, so
    // every omitted-currency MoneyText re-renders in the new base.
    await waitFor(() => expect(getMoneyCurrency()).toBe('USD'));
  });

  // Data export (§13.4 V4-P6a, #494): request → the raw token is stored (keyed by
  // job id) → once the poll reports the SAME job ready, the download link renders
  // with that token in the URL.
  test('requesting an export stores the token and renders a download link for the ready job', async () => {
    const user = userEvent.setup();
    // Never-requested until the export is asked for; the same job then reports ready.
    vi.mocked(getDataExportStatus).mockResolvedValueOnce(NO_EXPORT).mockResolvedValue(READY_EXPORT);
    renderPage();

    await user.type(await screen.findByLabelText('Confirm your password'), 'oldpassword1');
    await user.click(screen.getByRole('button', { name: 'Export my data' }));

    await waitFor(() =>
      expect(requestDataExport).toHaveBeenCalledWith({ password: 'oldpassword1' }),
    );

    // The raw token was persisted (only its hash lives server-side), keyed by job id.
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('bt.export.token') ?? '{}')).toEqual({
        jobId: REQUEST_RESPONSE.jobId,
        token: REQUEST_RESPONSE.downloadToken,
      }),
    );

    // Once the same job is ready, the held token unlocks the download URL.
    const link = await screen.findByRole('link', { name: 'Download export' });
    expect(link).toHaveAttribute(
      'href',
      `/api/v1/account/export/download?token=${encodeURIComponent(REQUEST_RESPONSE.downloadToken)}`,
    );
  });

  // The stored token only unlocks the CURRENT ready job: a leftover token for a
  // different job id must NOT produce a download link — the readyNoToken branch
  // tells the user to request a fresh export on this device.
  test('a ready job with a mismatched stored token shows readyNoToken, not a download link', async () => {
    localStorage.setItem(
      'bt.export.token',
      JSON.stringify({ jobId: 'a-different-job', token: 'stale-token' }),
    );
    vi.mocked(getDataExportStatus).mockResolvedValue(READY_EXPORT);
    renderPage();

    expect(
      await screen.findByText(/its download link isn't available on this device/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download export' })).not.toBeInTheDocument();
  });
});

describe('AccountSettingsPage — paranoid cleartext export (PD7)', () => {
  const PARANOID = {
    privacyMode: 'paranoid' as const,
    mediaState: {
      mediaSet: ['server' as const],
      driveAttestedVersion: null,
      server: { disposition: 'active' as const, candidate: null, retired: null },
    },
  };

  test('a normal account never shows the cleartext export block', async () => {
    renderPage();
    await screen.findByText('ada');
    expect(screen.queryByText('Cleartext export (this device)')).not.toBeInTheDocument();
  });

  test('a locked vault shows the unlock requirement while the server export block stays', async () => {
    vi.mocked(getParanoidMediaState).mockResolvedValue(PARANOID);
    renderPage();

    expect(await screen.findByText('Cleartext export (this device)')).toBeInTheDocument();
    expect(screen.getByText(/Unlock your vault to build a cleartext export/i)).toBeInTheDocument();
    // The account (server) export remains — it still carries the server-classified data.
    expect(screen.getByRole('heading', { name: 'Export my data' })).toBeInTheDocument();
  });

  test('an unlocked vault builds the zip in the browser and hands it to the download', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    vi.mocked(getParanoidMediaState).mockResolvedValue(PARANOID);
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    render(
      <MemoryRouter>
        <I18nProvider>
          <QueryClientProvider client={client}>
            <VaultMoneyEngineProvider
              dependencies={{ sync, market: createClientMoneyMarket().market }}
            >
              <AccountSettingsPage />
            </VaultMoneyEngineProvider>
          </QueryClientProvider>
        </I18nProvider>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Build cleartext export' }));

    await waitFor(() => expect(deliverClientDownload).toHaveBeenCalledTimes(1), {
      timeout: 10_000,
    });
    const [bytes, mediaType, filename] = vi.mocked(deliverClientDownload).mock.calls[0]!;
    expect(mediaType).toBe('application/zip');
    expect(String(filename)).toMatch(/^bettertrack-cleartext-export-\d{4}-\d{2}-\d{2}\.zip$/);
    expect((bytes as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  // Locking during generation (PD7 acceptance): the paranoid section stays
  // mounted while `session` drops to null, so the in-flight export must be
  // aborted — and the revoked session seam must fail locked — before any
  // cleartext bytes are handed over.
  test('locking mid-generation aborts the export — no cleartext leaves after lock', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    vi.mocked(getParanoidMediaState).mockResolvedValue(PARANOID);
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);
    const market = createClientMoneyMarket().market;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const ui = (activeSync: typeof sync | null) => (
      <MemoryRouter>
        <I18nProvider>
          <QueryClientProvider client={client}>
            <VaultMoneyEngineProvider dependencies={{ sync: activeSync, market }}>
              <AccountSettingsPage />
            </VaultMoneyEngineProvider>
          </QueryClientProvider>
        </I18nProvider>
      </MemoryRouter>
    );
    const view = render(ui(sync));

    // fireEvent, not userEvent: the lock must land while the generation is
    // still parked on its first browser-task boundary.
    fireEvent.click(await screen.findByRole('button', { name: 'Build cleartext export' }));
    view.rerender(ui(null));

    // The section stays mounted and reports the unlock requirement…
    expect(
      await screen.findByText(/Unlock your vault to build a cleartext export/i),
    ).toBeInTheDocument();
    // …and the aborted generation gets every chance to (incorrectly) finish
    // before asserting that no bytes were ever delivered.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(deliverClientDownload).not.toHaveBeenCalled();
  });
});
