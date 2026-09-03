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

vi.mock('../../../lib/userApi', () => ({
  getMe: vi.fn(),
  requestDataExport: vi.fn(),
  getDataExportStatus: vi.fn(),
  downloadDataExport: vi.fn(),
}));
vi.mock('../../../lib/settingsApi', () => ({
  getAccountSettings: vi.fn(),
  updateAccountSettings: vi.fn(),
}));
vi.mock('../../../lib/socialApi', () => ({
  getProfileSettings: vi.fn(),
  updateProfileSettings: vi.fn(),
}));
vi.mock('../../vault/export/deliver', () => ({
  deliverClientDownload: vi.fn(),
  printClientDocument: vi.fn(),
}));

import { webcrypto } from 'node:crypto';

import { I18nProvider } from '../../../i18n';
import { getMoneyCurrency, setMoneyCurrency } from '../../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../../lib/settingsApi';
import { getProfileSettings, updateProfileSettings } from '../../../lib/socialApi';
import {
  downloadDataExport,
  getDataExportStatus,
  getMe,
  requestDataExport,
} from '../../../lib/userApi';
import {
  createClientMoneyMarket,
  createMutableTestSync,
  decryptClientMoneyFixture,
} from '../../vault/engine/clientMoney.testSupport';
import { VaultMoneyEngineProvider } from '../../vault/engine/VaultMoneyEngineProvider';
import { deliverClientDownload } from '../../vault/export/deliver';
import { ResolvedPrivacyModeProvider } from '../../vault/usePrivacyMode';
import { AccountPanel } from './AccountPanel';

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
  error: null,
};

const READY_EXPORT: ExportStatusResponse = {
  status: 'ready',
  jobId: '00000000-0000-0000-0000-0000000000aa',
  requestedAt: '2026-07-16T09:00:00.000Z',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  sizeBytes: 4096,
  error: null,
};

/** A build refused for size: actionable, and distinct from a transient failure. */
const TOO_LARGE_EXPORT: ExportStatusResponse = {
  status: 'failed',
  jobId: '00000000-0000-0000-0000-0000000000ab',
  requestedAt: '2026-07-16T09:00:00.000Z',
  expiresAt: null,
  sizeBytes: null,
  error: 'EXPORT_TOO_LARGE',
};

const REQUEST_RESPONSE: ExportRequestResponse = {
  jobId: '00000000-0000-0000-0000-0000000000aa',
  status: 'pending',
  downloadToken: 'raw-download-token-1',
};

function renderPanel(mode: 'normal' | 'paranoid' = 'normal') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <ResolvedPrivacyModeProvider mode={mode}>
            <AccountPanel />
          </ResolvedPrivacyModeProvider>
        </QueryClientProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(getMe).mockResolvedValue(ME);
  vi.mocked(getDataExportStatus).mockResolvedValue(NO_EXPORT);
  vi.mocked(requestDataExport).mockResolvedValue(REQUEST_RESPONSE);
  vi.mocked(downloadDataExport).mockResolvedValue();
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
  vi.mocked(getProfileSettings).mockResolvedValue({
    username: 'ada',
    isPublic: false,
    bio: null,
    publicItemCount: 0,
    profileIcon: null,
  });
  vi.mocked(updateProfileSettings).mockResolvedValue({
    username: 'ada',
    isPublic: false,
    bio: null,
    publicItemCount: 0,
    profileIcon: 'astronaut',
  });
});

// The default money currency is module-level state — restore EUR so tests
// stay order-independent.
afterEach(() => setMoneyCurrency('EUR'));

describe('AccountPanel', () => {
  test('renders an export-status read failure without hiding the account panel', async () => {
    vi.mocked(getDataExportStatus).mockRejectedValue(new Error('export status unavailable'));
    renderPanel();

    expect(await screen.findByText("This information isn't available.")).toBeInTheDocument();
    expect(screen.getAllByText('Export my data')).not.toHaveLength(0);
  });

  // #1714: a build refused for size is terminal for that account, so the note
  // has to say so — a generic "try again" would send the user in a loop.
  test('names a size-refused export and says the allowance was not used', async () => {
    vi.mocked(getDataExportStatus).mockResolvedValue(TOO_LARGE_EXPORT);
    renderPanel();

    expect(await screen.findByText(/more data than a single export archive/i)).toBeInTheDocument();
    expect(screen.getByText(/daily allowance was not used/i)).toBeInTheDocument();
  });

  test('renders identity rows; the base currency has its own picker (V3-P10d)', async () => {
    renderPanel();

    expect(await screen.findByText('ada')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Member since')).toBeInTheDocument();
    // The V2 "EUR (fixed)" identity marker is gone — the base is configurable now.
    expect(screen.queryByText(/\(fixed\)/)).not.toBeInTheDocument();
  });

  // Popup-native: ONE compact head naming the panel, and no page-sized title
  // stack or subtitle restating it.
  test('carries exactly one panel head and no page heading', async () => {
    renderPanel();

    await screen.findByText('ada');
    const heads = screen.getAllByRole('heading', { level: 2 });
    expect(heads).toHaveLength(1);
    expect(heads[0]).toHaveTextContent('Account');
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  // Credentials are the Sign-in panel's job now — this panel is identity +
  // display + data, and must not ship a password form of its own.
  test('has no password form (it moved to the Sign-in panel)', async () => {
    renderPanel();

    await screen.findByText('ada');
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
  });

  // Portfolio visibility moved to the Socials tab (#377): the Control Center has
  // no sharing toggle — neither the per-default-portfolio one nor the create-time
  // default — and never writes a portfolio visibility.
  test('has no visibility toggle and never writes a portfolio visibility (#377)', async () => {
    renderPanel();

    await screen.findByText('ada');
    expect(screen.queryByRole('radio', { name: 'Friends' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Yes' })).not.toBeInTheDocument();
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
    renderPanel();

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
    renderPanel();

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

  // Data export (#951): request → hold the raw token only in memory → once the
  // same job is ready, exchange it in a POST body and clear the held token.
  test('requests, polls, and exchanges an in-memory token without durable storage', async () => {
    const user = userEvent.setup();
    // Never-requested until the export is asked for; the same job then reports ready.
    vi.mocked(getDataExportStatus).mockResolvedValueOnce(NO_EXPORT).mockResolvedValue(READY_EXPORT);
    renderPanel();

    await user.type(await screen.findByLabelText('Confirm your password'), 'oldpassword1');
    await user.click(screen.getByRole('button', { name: 'Export my data' }));

    await waitFor(() =>
      expect(requestDataExport).toHaveBeenCalledWith({ password: 'oldpassword1' }),
    );

    expect(localStorage.getItem('bt.export.token')).toBeNull();

    const download = await screen.findByRole('button', { name: 'Download export' });
    await user.click(download);
    await waitFor(() =>
      expect(downloadDataExport).toHaveBeenCalledWith({
        token: REQUEST_RESPONSE.downloadToken,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Download export' })).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem('bt.export.token')).toBeNull();
  });

  test('clears the legacy token on load and never restores download access from it', async () => {
    localStorage.setItem(
      'bt.export.token',
      JSON.stringify({ jobId: READY_EXPORT.jobId, token: 'legacy-raw-token' }),
    );
    vi.mocked(getDataExportStatus).mockResolvedValue(READY_EXPORT);
    renderPanel();

    await waitFor(() => expect(localStorage.getItem('bt.export.token')).toBeNull());
    expect(
      await screen.findByText(/download access is not kept across page reloads/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download export' })).not.toBeInTheDocument();
    expect(downloadDataExport).not.toHaveBeenCalled();
  });
});

describe('AccountPanel — paranoid cleartext export (PD7)', () => {
  test('keeps the curated profile-icon picker without exposing public-profile settings', async () => {
    const user = userEvent.setup();
    renderPanel('paranoid');

    await user.click(await screen.findByRole('button', { name: /Profile icon/i }));
    const choices = screen.getAllByRole('radio');
    await user.click(choices[0]!);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(updateProfileSettings).toHaveBeenCalledWith({
        isPublic: false,
        profileIcon: expect.any(String),
      }),
    );
    expect(screen.queryByRole('switch', { name: /public profile/i })).not.toBeInTheDocument();
  });

  test('a normal account never shows the cleartext export block', async () => {
    renderPanel();
    await screen.findByText('ada');
    expect(screen.queryByText('Cleartext export (this device)')).not.toBeInTheDocument();
  });

  test('a locked vault shows the unlock requirement while the server export row stays', async () => {
    renderPanel('paranoid');

    expect(await screen.findByText('Cleartext export (this device)')).toBeInTheDocument();
    expect(screen.getByText(/Unlock your vault to build a cleartext export/i)).toBeInTheDocument();
    // The account (server) export remains — it still carries the server-classified
    // data. In the popup grammar it is a labelled row, not a page heading.
    expect(screen.getByRole('button', { name: 'Export my data' })).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm your password')).toBeInTheDocument();
  });

  test('an unlocked vault builds the zip in the browser and hands it to the download', async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    const fixture = await decryptClientMoneyFixture();
    const sync = createMutableTestSync(fixture.document, fixture.header, fixture.envelope);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    render(
      <MemoryRouter>
        <I18nProvider>
          <QueryClientProvider client={client}>
            <ResolvedPrivacyModeProvider mode="paranoid">
              <VaultMoneyEngineProvider
                dependencies={{ sync, market: createClientMoneyMarket().market }}
              >
                <AccountPanel />
              </VaultMoneyEngineProvider>
            </ResolvedPrivacyModeProvider>
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
            <ResolvedPrivacyModeProvider mode="paranoid">
              <VaultMoneyEngineProvider dependencies={{ sync: activeSync, market }}>
                <AccountPanel />
              </VaultMoneyEngineProvider>
            </ResolvedPrivacyModeProvider>
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
