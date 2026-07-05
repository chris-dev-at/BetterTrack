import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { getRuntimeConfig } from './lib/runtimeConfig';

// Admin/user separation (#248, §3, §4.6): the top-level router must decide which
// app mounts purely from the per-origin runtime config, never from the URL. We
// stub both app subtrees with sentinels and the runtime config, so these tests
// exercise App.tsx's mount decision in isolation (the real apps' auth/fetching
// is covered by their own suites).
vi.mock('./lib/runtimeConfig', () => ({ getRuntimeConfig: vi.fn() }));
vi.mock('./admin/AdminApp', () => ({ AdminApp: () => <div>ADMIN_APP_MOUNTED</div> }));
vi.mock('./user/UserApp', () => ({ UserApp: () => <div>USER_APP_MOUNTED</div> }));

import App from './App';

function setRuntimeApp(app: 'user' | 'admin') {
  vi.mocked(getRuntimeConfig).mockReturnValue({ app, apiOrigin: '' });
}

/** App uses a BrowserRouter, which reads window.location — drive it via history. */
function navigate(path: string) {
  window.history.pushState({}, '', path);
}

beforeEach(() => {
  navigate('/');
});

afterEach(() => {
  vi.clearAllMocks();
  navigate('/');
});

test('user origin: /admin does NOT mount the admin app', () => {
  setRuntimeApp('user');
  navigate('/admin');
  render(<App />);

  // The admin world is not part of the user origin's route tree at all — the
  // path falls through to the user app, which handles its own not-found.
  expect(screen.queryByText('ADMIN_APP_MOUNTED')).not.toBeInTheDocument();
  expect(screen.getByText('USER_APP_MOUNTED')).toBeInTheDocument();
});

test('user origin: a deep /admin/* path also stays in the user app', () => {
  setRuntimeApp('user');
  navigate('/admin/users');
  render(<App />);

  expect(screen.queryByText('ADMIN_APP_MOUNTED')).not.toBeInTheDocument();
  expect(screen.getByText('USER_APP_MOUNTED')).toBeInTheDocument();
});

test('user origin: root mounts the user app', () => {
  setRuntimeApp('user');
  navigate('/portfolio');
  render(<App />);

  expect(screen.getByText('USER_APP_MOUNTED')).toBeInTheDocument();
  expect(screen.queryByText('ADMIN_APP_MOUNTED')).not.toBeInTheDocument();
});

test('admin origin: /admin/* mounts only the admin app', () => {
  setRuntimeApp('admin');
  navigate('/admin/users');
  render(<App />);

  expect(screen.getByText('ADMIN_APP_MOUNTED')).toBeInTheDocument();
  expect(screen.queryByText('USER_APP_MOUNTED')).not.toBeInTheDocument();
});

test('admin origin: the user app is never reachable — root redirects into /admin', () => {
  setRuntimeApp('admin');
  navigate('/portfolio');
  render(<App />);

  // Any non-admin path redirects to /admin; the user app must not render.
  expect(screen.getByText('ADMIN_APP_MOUNTED')).toBeInTheDocument();
  expect(screen.queryByText('USER_APP_MOUNTED')).not.toBeInTheDocument();
});
