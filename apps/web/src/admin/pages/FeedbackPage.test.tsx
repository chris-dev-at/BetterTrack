import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminFeedbackListResponse,
  AdminFeedbackSubmission,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import { I18nProvider } from '../../i18n';
import * as api from '../../lib/adminApi';
import { setViewportWidth } from '../../test/viewport';
import { AuthProvider } from '../AuthContext';
import { FeedbackPage } from './FeedbackPage';

const admin: MeResponse = {
  id: 'admin-1',
  email: 'admin@bettertrack.test',
  username: 'rootadmin',
  role: 'admin',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-08-18T07:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const submission: AdminFeedbackSubmission = {
  id: '00000000-0000-7000-8000-000000000001',
  category: 'feature',
  subject: 'Compact forecast scenarios',
  message: 'Please add a compact scenario switcher without widening the page.',
  context: {
    platform: 'android',
    appVersion: '5.4.0',
    osVersion: '16',
    device: 'Pixel 9 Pro Fold with a deliberately long device label',
    locale: null,
    screen: '/forecast',
    futureDiagnostic: { raw: 'must not render' },
  },
  status: 'new',
  lastStatusChangeAt: '2026-08-18T08:00:00.000Z',
  declinedReason: null,
  shippedVersion: null,
  submitter: {
    id: '00000000-0000-7000-8000-000000000002',
    username: 'mobile_owner',
    email: 'mobile-owner-with-a-long-address@example.test',
  },
  createdAt: '2026-08-18T08:00:00.000Z',
  updatedAt: '2026-08-18T08:00:00.000Z',
};

const list = (overrides: Partial<AdminFeedbackListResponse> = {}): AdminFeedbackListResponse => ({
  submissions: [submission],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  ...overrides,
});

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <FeedbackPage />
      </AuthProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setViewportWidth(1440);
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.listAdminFeedback).mockResolvedValue(list());
});

test('renders the submitter and labelled diagnostics without raw or absent context fields', async () => {
  renderPage();

  const subject = await screen.findByText('Compact forecast scenarios');
  const row = subject.closest('li')!;
  expect(within(row).getByText('mobile_owner')).toBeInTheDocument();
  expect(
    within(row).getByText('mobile-owner-with-a-long-address@example.test'),
  ).toBeInTheDocument();
  expect(within(row).getByText('Platform')).toBeInTheDocument();
  expect(within(row).getByText('android')).toBeInTheDocument();
  expect(within(row).getByText('App version')).toBeInTheDocument();
  expect(within(row).getByText('OS version')).toBeInTheDocument();
  expect(within(row).getByText('Device')).toBeInTheDocument();
  expect(within(row).getByText('Screen')).toBeInTheDocument();
  expect(within(row).queryByText('Locale')).not.toBeInTheDocument();
  expect(row).not.toHaveTextContent('futureDiagnostic');
  expect(row).not.toHaveTextContent('undefined');
  expect(row).not.toHaveTextContent('null');
});

test('filters and sorts the inbox, restoring category priority when the filter clears', async () => {
  const user = userEvent.setup();
  renderPage();

  await screen.findByText('Compact forecast scenarios');
  expect(api.listAdminFeedback).toHaveBeenCalledWith(
    { category: undefined, sort: 'category', page: 1 },
    expect.any(AbortSignal),
  );

  await user.selectOptions(screen.getByRole('combobox', { name: 'Sort' }), 'newest');
  await waitFor(() =>
    expect(api.listAdminFeedback).toHaveBeenLastCalledWith(
      { category: undefined, sort: 'newest', page: 1 },
      expect.any(AbortSignal),
    ),
  );

  await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'bug');
  await waitFor(() =>
    expect(api.listAdminFeedback).toHaveBeenLastCalledWith(
      { category: 'bug', sort: 'newest', page: 1 },
      expect.any(AbortSignal),
    ),
  );

  await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'all');
  await waitFor(() =>
    expect(api.listAdminFeedback).toHaveBeenLastCalledWith(
      { category: undefined, sort: 'category', page: 1 },
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('category');
});

test('changes status and reloads the persisted row', async () => {
  const user = userEvent.setup();
  const triaged = {
    ...submission,
    status: 'triaged' as const,
    lastStatusChangeAt: '2026-08-18T09:00:00.000Z',
  };
  vi.mocked(api.updateFeedbackStatus).mockResolvedValue({
    id: submission.id,
    status: 'triaged',
    lastStatusChangeAt: '2026-08-18T09:00:00.000Z',
    declinedReason: null,
    shippedVersion: null,
    updatedAt: '2026-08-18T09:00:00.000Z',
  });
  vi.mocked(api.listAdminFeedback)
    .mockResolvedValueOnce(list())
    .mockResolvedValue(list({ submissions: [triaged] }));
  renderPage();

  const status = await screen.findByRole('combobox', {
    name: 'Status for feedback from mobile_owner',
  });
  await user.selectOptions(status, 'triaged');

  await waitFor(() =>
    expect(api.updateFeedbackStatus).toHaveBeenCalledWith(submission.id, {
      status: 'triaged',
    }),
  );
  await waitFor(() => expect(status).toHaveValue('triaged'));
  expect(vi.mocked(api.listAdminFeedback).mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('paginates and renders the empty state', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listAdminFeedback)
    .mockResolvedValueOnce(list({ pagination: { page: 1, limit: 20, total: 21, totalPages: 2 } }))
    .mockResolvedValueOnce(list({ pagination: { page: 2, limit: 20, total: 21, totalPages: 2 } }));
  const first = renderPage();

  await user.click(await screen.findByRole('button', { name: 'Next' }));
  await waitFor(() =>
    expect(api.listAdminFeedback).toHaveBeenLastCalledWith(
      { category: undefined, sort: 'category', page: 2 },
      expect.any(AbortSignal),
    ),
  );

  first.unmount();
  vi.mocked(api.listAdminFeedback).mockResolvedValue(
    list({
      submissions: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    }),
  );
  renderPage();
  expect(await screen.findByText('No feedback yet.')).toBeInTheDocument();
});

test('ships German copy and uses contained cards at phone and desktop widths', async () => {
  setViewportWidth(390);
  const phone = renderPage('de');

  await screen.findByText('Compact forecast scenarios');
  expect(screen.getByRole('combobox', { name: 'Kategorie' })).toBeInTheDocument();
  expect(screen.getByText('Diagnosedaten')).toBeInTheDocument();
  const phoneList = screen.getByTestId('feedback-list');
  expect(phoneList).toHaveClass('min-w-0');
  expect(phoneList.querySelector('li')).toHaveClass('min-w-0', 'overflow-hidden');

  phone.unmount();
  setViewportWidth(1440);
  renderPage('en');
  await screen.findByText('Compact forecast scenarios');
  expect(screen.getByTestId('feedback-list').querySelector('li')).toHaveClass(
    'min-w-0',
    'overflow-hidden',
  );
});
