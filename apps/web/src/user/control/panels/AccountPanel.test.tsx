import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
  dataExportDownloadUrl: vi.fn(
    (token: string) => `/api/v1/account/export/download?token=${encodeURIComponent(token)}`,
  ),
}));
vi.mock('../../../lib/settingsApi', () => ({
  getAccountSettings: vi.fn(),
  updateAccountSettings: vi.fn(),
}));

import { I18nProvider } from '../../../i18n';
import { getMoneyCurrency, setMoneyCurrency } from '../../../lib/format';
import { getAccountSettings, updateAccountSettings } from '../../../lib/settingsApi';
import { getDataExportStatus, getMe, requestDataExport } from '../../../lib/userApi';
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

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter>
      <I18nProvider>
        <QueryClientProvider client={client}>
          <AccountPanel />
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

describe('AccountPanel', () => {
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

  // Data export (§13.4 V4-P6a, #494): request → the raw token is stored (keyed by
  // job id) → once the poll reports the SAME job ready, the download link renders
  // with that token in the URL.
  test('requesting an export stores the token and renders a download link for the ready job', async () => {
    const user = userEvent.setup();
    // Never-requested until the export is asked for; the same job then reports ready.
    vi.mocked(getDataExportStatus).mockResolvedValueOnce(NO_EXPORT).mockResolvedValue(READY_EXPORT);
    renderPanel();

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
    renderPanel();

    expect(
      await screen.findByText(/its download link isn't available on this device/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download export' })).not.toBeInTheDocument();
  });
});
