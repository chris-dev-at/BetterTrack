import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AdminStats, AdminUser, MeResponse } from '@bettertrack/contracts';

vi.mock('../lib/adminApi');
import * as api from '../lib/adminApi';
import { ApiError } from '../lib/apiClient';
import { AdminApp } from './AdminApp';

const admin: MeResponse = {
  id: 'admin-1',
  email: 'admin@bettertrack.test',
  username: 'rootadmin',
  role: 'admin',
  status: 'active',
  mustChangePassword: false,
  baseCurrency: 'EUR',
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const jane: AdminUser = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-02-02T00:00:00.000Z',
};

const stats: AdminStats = {
  userCount: 1,
  activeUserCount: 1,
  disabledUserCount: 0,
  pendingInviteCount: 0,
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/*" element={<AdminApp />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.getStats).mockResolvedValue(stats);
  vi.mocked(api.listUsers).mockResolvedValue({ users: [jane] });
});

test('anonymous visitors are sent to the admin login, not the users page', async () => {
  // A non-admin/anonymous session: /auth/me responds 401 (the API returns 404
  // for non-admins on admin routes — neither leaks route detail to the UI).
  vi.mocked(api.getMe).mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Not signed in.'));

  renderAt('/admin/users');

  expect(await screen.findByText('Admin console')).toBeInTheDocument();
  expect(screen.queryByText('jane@bettertrack.test')).not.toBeInTheDocument();
});

test('authenticated admins reach the guarded users page', async () => {
  vi.mocked(api.getMe).mockResolvedValue(admin);

  renderAt('/admin/users');

  expect(await screen.findByText('jane@bettertrack.test')).toBeInTheDocument();
});
