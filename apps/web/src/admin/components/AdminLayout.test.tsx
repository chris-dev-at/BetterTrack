import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { username: 'root', email: 'admin@bettertrack.test' },
    logout: vi.fn(),
  }),
}));

import { AdminLayout } from './AdminLayout';

function Bomb(): never {
  throw new Error('kaboom');
}

function renderAdmin(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/admin/users" element={<Bomb />} />
          <Route path="/admin/invites" element={<p>Invites page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test('a page that throws renders the error boundary fallback while the admin chrome survives', () => {
  renderAdmin('/admin/users');

  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Invites' })).toBeInTheDocument();
  expect(screen.getByText('admin@bettertrack.test')).toBeInTheDocument();
});

test('navigating to a different route clears a stuck error boundary', async () => {
  renderAdmin('/admin/users');

  expect(screen.getByRole('alert')).toBeInTheDocument();

  await userEvent.setup().click(screen.getByRole('link', { name: 'Invites' }));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Invites page')).toBeInTheDocument();
});

test('the admin nav is a vertical sidebar — no horizontal scroll, no wrap', () => {
  renderAdmin('/admin/invites');

  const nav = screen.getByRole('navigation', { name: 'Admin' });
  expect(nav.className).not.toContain('overflow-x-auto');
  expect(nav.className).not.toContain('flex-wrap');
  expect(nav.className).toContain('flex-col');

  const link = screen.getByRole('link', { name: 'Invites' });
  expect(link.className).toContain('min-h-[40px]');
});

test('the burger button opens the mobile drawer with an i18n aria-label and closes on Escape', async () => {
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  const burger = screen.getByRole('button', { name: 'Open admin menu' });
  expect(burger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();

  await user.click(burger);

  const drawer = screen.getByRole('dialog', { name: 'Admin menu' });
  expect(drawer).toBeInTheDocument();
  expect(within(drawer).getByRole('button', { name: 'Close admin menu' })).toBeInTheDocument();

  await user.keyboard('{Escape}');

  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
});

test('navigating from inside the drawer closes it', async () => {
  const user = userEvent.setup();
  renderAdmin('/admin/invites');

  await user.click(screen.getByRole('button', { name: 'Open admin menu' }));
  const drawer = screen.getByRole('dialog', { name: 'Admin menu' });

  // Click the "Users" link inside the drawer (both drawer and desktop sidebar
  // render one; scope to the drawer so this exercises the drawer's own link).
  await user.click(within(drawer).getByRole('link', { name: 'Users' }));

  expect(screen.queryByRole('dialog', { name: 'Admin menu' })).not.toBeInTheDocument();
});
