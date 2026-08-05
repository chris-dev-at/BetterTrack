import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import { ResolvedPrivacyModeProvider } from '../vault/usePrivacyMode';

const mocks = vi.hoisted(() => ({
  lock: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  toggleDiscreetMode: vi.fn(async () => undefined),
}));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: {
      username: 'jane',
      email: 'jane@bettertrack.test',
      profileIcon: null,
      discreetMode: false,
    },
    logout: mocks.logout,
    toggleDiscreetMode: mocks.toggleDiscreetMode,
  }),
}));
vi.mock('../vault/VaultRuntimeContext', () => ({
  useOptionalVaultRuntime: () => ({ lock: mocks.lock }),
}));

import { AccountMenu } from './OriginShell';

beforeEach(() => {
  vi.clearAllMocks();
});

test('paranoid profile menu has a one-click lock and no public-profile entry', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ResolvedPrivacyModeProvider mode="paranoid">
        <AccountMenu collapsed={false} />
      </ResolvedPrivacyModeProvider>
    </MemoryRouter>,
  );

  await user.click(screen.getByRole('button', { name: 'Account menu' }));
  expect(screen.queryByRole('menuitem', { name: 'My profile' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('menuitem', { name: 'Lock vault' }));
  expect(mocks.lock).toHaveBeenCalledOnce();
});
