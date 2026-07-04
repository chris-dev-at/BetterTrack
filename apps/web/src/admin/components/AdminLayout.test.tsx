import { render, screen } from '@testing-library/react';
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
