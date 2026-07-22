import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

// `ProfileMenu` and `NotificationBell` reach into auth/network state that is
// out of scope for this layout test — stub them so only the boundary wiring
// (the thing under test) is exercised.
vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: { username: 'jane', email: 'jane@bettertrack.test', discreetMode: false },
    logout: vi.fn(),
    toggleDiscreetMode: vi.fn(),
  }),
}));
vi.mock('../../lib/notificationsApi', () => ({
  listNotifications: vi.fn().mockResolvedValue({ items: [], unreadCount: 0 }),
  markNotificationsRead: vi.fn(),
}));

import { AppLayout } from './AppLayout';

function Bomb(): never {
  throw new Error('kaboom');
}

function renderApp(initialPath: string) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/portfolio" element={<p>Portfolio page</p>} />
            <Route path="/workboard" element={<Bomb />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test('a page that throws renders the error boundary fallback while the app chrome survives', () => {
  renderApp('/workboard');

  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  // Chrome (nav + profile) is unaffected — the whole SPA does not white-screen.
  expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Portfolio' })).toBeInTheDocument();
});

test('navigating to a different route clears a stuck error boundary', async () => {
  renderApp('/workboard');

  expect(screen.getByRole('alert')).toBeInTheDocument();

  await userEvent.setup().click(screen.getByRole('link', { name: 'Portfolio' }));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Portfolio page')).toBeInTheDocument();
});

test('the primary nav scrolls horizontally rather than wrapping on phones', () => {
  renderApp('/portfolio');

  const nav = screen.getByRole('navigation', { name: 'Primary' });
  expect(nav.className).toContain('overflow-x-auto');
  expect(nav.className).toContain('no-scrollbar');
  expect(nav.className).not.toContain('flex-wrap');
});
