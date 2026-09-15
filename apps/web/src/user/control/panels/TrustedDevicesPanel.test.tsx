import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { RememberedDeviceSummary } from '@bettertrack/contracts';

vi.mock('../../../lib/userApi', () => ({
  listRememberedDevices: vi.fn(),
  revokeAllRememberedDevices: vi.fn(),
  revokeRememberedDevice: vi.fn(),
}));

import {
  listRememberedDevices,
  revokeAllRememberedDevices,
  revokeRememberedDevice,
} from '../../../lib/userApi';
import { TrustedDevicesPanel } from './TrustedDevicesPanel';

const DEVICES: RememberedDeviceSummary[] = [
  {
    handle: 'trusted-device-one',
    createdAt: '2026-07-01T08:00:00.000Z',
    lastSeenAt: '2026-07-07T09:00:00.000Z',
    expiresAt: '2026-08-01T08:00:00.000Z',
  },
  {
    handle: 'trusted-device-historical',
    createdAt: null,
    lastSeenAt: null,
    expiresAt: '2026-08-02T08:00:00.000Z',
  },
];

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <MemoryRouter initialEntries={['/control/trusted-devices']}>
      <QueryClientProvider client={client}>
        <TrustedDevicesPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listRememberedDevices).mockResolvedValue(DEVICES);
  vi.mocked(revokeRememberedDevice).mockResolvedValue();
  vi.mocked(revokeAllRememberedDevices).mockResolvedValue();
});

describe('TrustedDevicesPanel', () => {
  test('lists trusted devices and renders historical timestamp gaps as em dashes', async () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Trusted devices' })).toBeInTheDocument();
    expect(await screen.findAllByText('Trusted device')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(2);
    expect(screen.getAllByRole('listitem')[0]!).toHaveTextContent(/added.*last active.*expires/i);
    expect(screen.getAllByRole('listitem')[1]!).toHaveTextContent('—');
    expect(screen.getAllByRole('listitem')[1]!).toHaveTextContent(/expires/i);
  });

  test('revokes one device and removes its row without reloading the list', async () => {
    const user = userEvent.setup();
    vi.mocked(listRememberedDevices)
      .mockResolvedValueOnce(DEVICES)
      .mockResolvedValueOnce(DEVICES.slice(1));
    renderPanel();

    await user.click((await screen.findAllByRole('button', { name: 'Revoke' }))[0]!);

    await waitFor(() => expect(revokeRememberedDevice).toHaveBeenCalledWith('trusted-device-one'));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1));
    expect(listRememberedDevices).toHaveBeenCalledTimes(2);
  });

  test('requires confirmation before revoking all devices, then clears the list', async () => {
    const user = userEvent.setup();
    vi.mocked(listRememberedDevices).mockResolvedValueOnce(DEVICES).mockResolvedValueOnce([]);
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Revoke all trusted devices' }));
    expect(revokeAllRememberedDevices).not.toHaveBeenCalled();
    expect(screen.getByText(/no longer be available for pin sign-in/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revoke all trusted devices' }));

    await waitFor(() => expect(revokeAllRememberedDevices).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('No trusted devices')).toBeInTheDocument();
  });

  test('renders the compact empty state', async () => {
    vi.mocked(listRememberedDevices).mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText('No trusted devices')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke all trusted devices' }),
    ).not.toBeInTheDocument();
  });
});
