import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

import { ResolvedPrivacyModeProvider } from '../vault/usePrivacyMode';
import type { PrivacyMode } from '@bettertrack/contracts';

vi.mock('../vault/VaultRuntimeProvider', () => ({
  useVaultRuntime: () => ({ lock: vi.fn() }),
}));

import { CreateMenu } from './OriginShell';

async function openMenu(mode: PrivacyMode, path = '/portfolio') {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <ResolvedPrivacyModeProvider mode={mode}>
        <CreateMenu />
      </ResolvedPrivacyModeProvider>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Create' }));
  return screen.getByRole('menu', { name: 'Create' });
}

test('a normal account gets the cash-flow create entry, pinned to the open portfolio', async () => {
  const menu = await openMenu('normal', '/portfolio?portfolio=p-second');

  expect(within(menu).getByRole('menuitem', { name: 'Income or expense' })).toHaveAttribute(
    'href',
    '/portfolio/cash/movements?create=movement&portfolio=p-second',
  );
});

test('a paranoid account is not offered a create entry its route matrix kills', async () => {
  const menu = await openMenu('paranoid');

  // `/portfolio/cash/movements` is on the paranoid kill list, so the entry
  // would only bounce off the navigation gate — the flow it advertises cannot
  // run. Cash SOURCES stay live, so Transfer stays.
  expect(within(menu).queryByRole('menuitem', { name: 'Income or expense' })).toBeNull();
  expect(within(menu).getByRole('menuitem', { name: 'Transfer' })).toBeInTheDocument();
  expect(within(menu).getByRole('menuitem', { name: 'Buy or sell' })).toBeInTheDocument();
});
