import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, MonitoringStatusResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { MonitoringPage } from './MonitoringPage';

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
  lastLoginAt: '2026-06-01T08:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const notExposed: MonitoringStatusResponse = {
  grafana: { configured: true, reachable: false, detail: 'timeout' },
  prometheus: { configured: true, reachable: true, detail: null },
  externalAccess: {
    deployEnabled: false,
    passwordSet: false,
    killSwitchOn: true,
    effective: false,
    updatedAt: null,
    updatedBy: null,
  },
  externalUrl: null,
  checkedAt: '2026-07-19T00:00:00.000Z',
};

const exposed: MonitoringStatusResponse = {
  grafana: { configured: true, reachable: true, detail: null },
  prometheus: { configured: true, reachable: true, detail: null },
  externalAccess: {
    deployEnabled: true,
    passwordSet: true,
    killSwitchOn: true,
    effective: true,
    updatedAt: '2026-07-18T00:00:00.000Z',
    updatedBy: 'admin-1',
  },
  externalUrl: null,
  checkedAt: '2026-07-19T00:00:00.000Z',
};

function renderPage() {
  return render(
    <AuthProvider>
      <MonitoringPage />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
});

test('degrades gracefully when not exposed: no iframe, deploy-config hint shown', async () => {
  vi.mocked(api.getMonitoringStatus).mockResolvedValue(notExposed);
  renderPage();

  await waitFor(() => expect(screen.getByText('Localhost / LAN only')).toBeInTheDocument());
  // The unreachable Grafana probe is surfaced.
  expect(screen.getByText('Not reachable')).toBeInTheDocument();
  // With neither deploy opt-in nor a password, the toggle is replaced by guidance
  // and Grafana is NOT embedded.
  expect(screen.queryByTitle('Grafana dashboards')).not.toBeInTheDocument();
  expect(screen.getByText(/External access needs the deploy to opt in/i)).toBeInTheDocument();
});

test('embeds Grafana + toggles the runtime kill-switch when exposed', async () => {
  vi.mocked(api.getMonitoringStatus).mockResolvedValue(exposed);
  vi.mocked(api.setMonitoringExternalAccess).mockResolvedValue({
    ...exposed,
    externalAccess: { ...exposed.externalAccess, killSwitchOn: false, effective: false },
  });
  renderPage();

  await waitFor(() =>
    expect(screen.getByText('Reachable from outside the LAN (authenticated)')).toBeInTheDocument(),
  );
  // Grafana is embedded via the admin-proxy path under the API origin.
  const frame = screen.getByTitle('Grafana dashboards');
  expect(frame).toHaveAttribute('src', '/api/v1/admin/monitoring/grafana/');

  // Flipping the runtime kill-switch off calls the API and re-renders as localhost-only.
  await userEvent.click(screen.getByRole('button', { name: 'Disable external access' }));
  expect(api.setMonitoringExternalAccess).toHaveBeenCalledWith(false);
  await waitFor(() => expect(screen.getByText('Localhost / LAN only')).toBeInTheDocument());
  expect(screen.queryByTitle('Grafana dashboards')).not.toBeInTheDocument();
});
