import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { AiSettingsResponse, MeResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { AiSettingsPage } from './AiSettingsPage';

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

const unconfigured: AiSettingsResponse = {
  endpoint: null,
  model: null,
  dailyCap: 20,
  configured: false,
  updatedAt: null,
  updatedBy: null,
};

function renderPage() {
  return render(
    <AuthProvider>
      <AiSettingsPage />
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

test('shows "Not configured" and the local-only provider form when unset', async () => {
  vi.mocked(api.getAiSettings).mockResolvedValue(unconfigured);
  renderPage();

  await waitFor(() => expect(screen.getByText('Not configured')).toBeInTheDocument());
  expect(screen.getByLabelText('Ollama endpoint')).toBeInTheDocument();
  expect(screen.getByLabelText('Model')).toBeInTheDocument();
  // Local-only framing is visible — no cloud provider / token anywhere.
  expect(screen.getByText(/Local only/i)).toBeInTheDocument();
});

test('saves the endpoint / model / cap and reflects "Configured"', async () => {
  vi.mocked(api.getAiSettings).mockResolvedValue(unconfigured);
  vi.mocked(api.updateAiSettings).mockResolvedValue({
    endpoint: 'http://ollama.local:11434',
    model: 'llama3.1:8b',
    dailyCap: 7,
    configured: true,
    updatedAt: '2026-07-22T00:00:00.000Z',
    updatedBy: 'admin-1',
  });
  renderPage();

  await waitFor(() => expect(screen.getByLabelText('Ollama endpoint')).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText('Ollama endpoint'), 'http://ollama.local:11434');
  await userEvent.type(screen.getByLabelText('Model'), 'llama3.1:8b');
  const cap = screen.getByLabelText('Daily limit per user');
  await userEvent.clear(cap);
  await userEvent.type(cap, '7');

  await userEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(api.updateAiSettings).toHaveBeenCalledWith({
    endpoint: 'http://ollama.local:11434',
    model: 'llama3.1:8b',
    dailyCap: 7,
  });
  await waitFor(() => expect(screen.getByText('Configured')).toBeInTheDocument());
});

test('test-connection lists the models the endpoint serves', async () => {
  vi.mocked(api.getAiSettings).mockResolvedValue({
    ...unconfigured,
    endpoint: 'http://ollama.local:11434',
  });
  vi.mocked(api.testAiConnection).mockResolvedValue({
    ok: true,
    models: ['llama3.1:8b', 'qwen2.5:14b'],
    error: null,
  });
  renderPage();

  await waitFor(() => expect(screen.getByLabelText('Ollama endpoint')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));

  expect(api.testAiConnection).toHaveBeenCalledWith({ endpoint: 'http://ollama.local:11434' });
  await waitFor(() => expect(screen.getByText(/2 model\(s\) found/i)).toBeInTheDocument());
  expect(screen.getByText('llama3.1:8b, qwen2.5:14b')).toBeInTheDocument();
});
