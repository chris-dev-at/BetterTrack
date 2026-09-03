import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type { MeResponse, Problem, ProblemListResponse } from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { AuthProvider } from '../AuthContext';
import { ProblemsPage } from './ProblemsPage';

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

const problem: Problem = {
  id: '00000000-0000-7000-8000-000000000001',
  kind: 'error',
  fingerprint: 'abc123',
  title: 'TypeError',
  message: 'cannot read property',
  context: { path: '/api/v1/foo' },
  status: 'open',
  occurrenceCount: 4,
  firstSeenAt: '2026-07-16T02:00:00.000Z',
  lastSeenAt: '2026-07-17T02:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  regressed: false,
};

const list: ProblemListResponse = {
  problems: [problem],
  openCount: 1,
  total: 1,
  hasMore: false,
};

/** One more row for the paging cases, distinguishable by title. */
function pageRow(index: number): Problem {
  return {
    ...problem,
    id: `00000000-0000-7000-8000-00000000000${index}`,
    title: `PagedError${index}`,
  };
}

function renderPage() {
  return render(
    <AuthProvider>
      {/* W4 folded Operations: the page renders the workspace tab strip, which
          needs a router. */}
      <MemoryRouter initialEntries={['/admin/problems']}>
        <ProblemsPage />
      </MemoryRouter>
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
  vi.mocked(api.listProblems).mockResolvedValue(list);
});

test('renders captured problems with kind, occurrences and a resolve action', async () => {
  renderPage();

  await waitFor(() => expect(screen.getByText('TypeError')).toBeInTheDocument());
  // "Error" appears as both the kind filter option and the row's kind badge.
  expect(screen.getAllByText('Error').length).toBeGreaterThan(0);
  expect(screen.getByText('cannot read property')).toBeInTheDocument();
  expect(screen.getByText('1 open')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
});

test('resolving a problem calls the API and reloads', async () => {
  const user = userEvent.setup();
  vi.mocked(api.resolveProblem).mockResolvedValue({ ...problem, status: 'resolved' });
  renderPage();

  await waitFor(() => expect(screen.getByText('TypeError')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Resolve' }));

  await waitFor(() => expect(api.resolveProblem).toHaveBeenCalledWith(problem.id));
});

test('loads the next page and keeps the rows already shown', async () => {
  const user = userEvent.setup();
  vi.mocked(api.listProblems).mockImplementation(async (params = {}) =>
    (params.offset ?? 0) === 0
      ? { problems: [pageRow(1)], openCount: 2, total: 2, hasMore: true }
      : { problems: [pageRow(2)], openCount: 2, total: 2, hasMore: false },
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('PagedError1')).toBeInTheDocument());
  expect(screen.queryByText('PagedError2')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more' }));

  // Both pages are on screen, and the second page's row can be acted on.
  await waitFor(() => expect(screen.getByText('PagedError2')).toBeInTheDocument());
  expect(screen.getByText('PagedError1')).toBeInTheDocument();
  expect(vi.mocked(api.listProblems).mock.calls.at(-1)?.[0]).toMatchObject({ offset: 1 });
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

test('marks a resolved problem that came back as a regression', async () => {
  vi.mocked(api.listProblems).mockResolvedValue({
    problems: [
      {
        ...problem,
        status: 'open',
        regressed: true,
        resolvedAt: '2026-07-16T12:00:00.000Z',
        resolvedBy: admin.id,
      },
    ],
    openCount: 1,
    total: 1,
    hasMore: false,
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Came back')).toBeInTheDocument());
});

test('shows an error state when the list fetch fails', async () => {
  vi.mocked(api.listProblems).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() => expect(screen.getByText('Could not load problems.')).toBeInTheDocument());
});
