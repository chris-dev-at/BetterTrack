import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

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
  droppedCaptures: 0,
  droppedCapturesTotal: 0,
};

/** One more row for the paging cases, distinguishable by title. */
function pageRow(index: number): Problem {
  return {
    ...problem,
    id: `00000000-0000-7000-8000-00000000000${index}`,
    title: `PagedError${index}`,
  };
}

function renderPage(entry = '/admin/problems') {
  return render(
    <AuthProvider>
      {/* W4 folded Operations: the page renders the workspace tab strip, which
          needs a router. */}
      <MemoryRouter initialEntries={[entry]}>
        <ProblemsPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

/** A page's worth of rows, matching the page's own PAGE_SIZE. */
const PAGE_SIZE = 25;

/** The cadence `useLiveRefresh` runs a cockpit page at by default. */
const LIVE_CADENCE_MS = 30_000;

function capture(index: number, overrides: Partial<Problem> = {}): Problem {
  return {
    ...problem,
    id: `capture-${index}`,
    fingerprint: `fingerprint-${index}`,
    title: `Problem ${index}`,
    ...overrides,
  };
}

/**
 * Serve windows out of a MUTATING set, the way the server does: `offset` is a
 * position in `lastSeenAt desc` order, so a capture arriving at the head shifts
 * every later row down by one. This is the whole of #1848's D1 — a fixed
 * fixture per offset cannot reproduce it.
 */
function serveFrom(set: () => Problem[]) {
  vi.mocked(api.listProblems).mockImplementation(async (params = {}) => {
    const rows = set();
    const offset = params.offset ?? 0;
    const limit = params.limit ?? PAGE_SIZE;
    const window = rows.slice(offset, offset + limit);
    return {
      problems: window,
      openCount: rows.filter((row) => row.status === 'open').length,
      total: rows.length,
      hasMore: offset + window.length < rows.length,
      droppedCaptures: 0,
      droppedCapturesTotal: 0,
    };
  });
}

/** The rendered rows, in order, by title. */
function renderedTitles(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((row) => row.querySelector('.text-\\[13px\\]')?.textContent ?? '');
}

/** Load page 1 + page 2 with the live cadence running. */
async function loadTwoPages(user: ReturnType<typeof userEvent.setup>, entry?: string) {
  renderPage(entry);
  await screen.findByText('Problem 0');
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText(`Problem ${PAGE_SIZE}`);
}

/** Advance to the next live tick and let its reads settle. */
async function liveTick() {
  await act(async () => {
    vi.advanceTimersByTime(LIVE_CADENCE_MS);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
      ? { ...list, problems: [pageRow(1)], openCount: 2, total: 2, hasMore: true }
      : { ...list, problems: [pageRow(2)], openCount: 2, total: 2, hasMore: false },
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('PagedError1')).toBeInTheDocument());
  expect(screen.queryByText('PagedError2')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Load more' }));

  // Both pages are on screen, and the second page's row can be acted on. The
  // second window is asked for at a PAGE_SIZE boundary (#1848) — not at
  // `rows.length`, which was a position in a set that had already moved.
  await waitFor(() => expect(screen.getByText('PagedError2')).toBeInTheDocument());
  expect(screen.getByText('PagedError1')).toBeInTheDocument();
  expect(vi.mocked(api.listProblems).mock.calls.at(-1)?.[0]).toMatchObject({ offset: 25 });
  expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
});

/**
 * D1 (#1848). The page used to splice each response into a growing array by
 * numeric offset, over a set that mutates under it. These three cases are the
 * three ways that lied: a duplicate, a dropped row, and a frozen first page.
 */
test('a capture arriving during the live tick renders no row twice', async () => {
  // `shouldAdvanceTime` keeps testing-library's own waiting working while the
  // cadence stays under the test's control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  let set = Array.from({ length: 2 * PAGE_SIZE }, (_, index) => capture(index));
  serveFrom(() => set);
  const duplicateKeyWarning = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await loadTwoPages(user);
  expect(screen.getAllByRole('listitem')).toHaveLength(2 * PAGE_SIZE);

  // One new capture at the head: the whole set shifts down by one, so the
  // second window now starts one row earlier than when it was read.
  set = [capture(999, { title: 'Fresh capture' }), ...set];
  await liveTick();

  await waitFor(() => expect(screen.getByText('Fresh capture')).toBeInTheDocument());
  const titles = renderedTitles();
  expect(new Set(titles).size).toBe(titles.length);
  // The boundary row is the one the splice used to render twice.
  expect(screen.getAllByText(`Problem ${PAGE_SIZE - 1}`)).toHaveLength(1);
  expect(duplicateKeyWarning.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(
    /Encountered two children with the same key/,
  );
});

test('a row leaving the set does not take an unrelated open row with it', async () => {
  // `shouldAdvanceTime` keeps testing-library's own waiting working while the
  // cadence stays under the test's control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  let set = Array.from({ length: 2 * PAGE_SIZE }, (_, index) => capture(index));
  serveFrom(() => set);

  await loadTwoPages(user);
  const boundaryRow = `Problem ${PAGE_SIZE}`;
  expect(screen.getByText(boundaryRow)).toBeInTheDocument();

  // A colleague resolves the head row: under the default `open` filter it
  // leaves the set, and every later row moves up one.
  set = set.slice(1);
  await liveTick();

  await waitFor(() => expect(screen.queryByText('Problem 0')).not.toBeInTheDocument());
  // The row that sat on the page boundary is still listed exactly once — the
  // splice used to drop it, with no way left to reach or resolve it.
  expect(screen.getAllByText(boundaryRow)).toHaveLength(1);
  const titles = renderedTitles();
  expect(titles).toHaveLength(2 * PAGE_SIZE - 1);
  expect(new Set(titles).size).toBe(titles.length);
});

test('a row resolved elsewhere stops offering Resolve on the first page after a tick', async () => {
  // `shouldAdvanceTime` keeps testing-library's own waiting working while the
  // cadence stays under the test's control.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const set = Array.from({ length: 2 * PAGE_SIZE }, (_, index) => capture(index));
  serveFrom(() => set);

  // `status=all`, so a resolved row stays in the set and can be read back.
  await loadTwoPages(user, '/admin/problems?status=all');
  const firstRow = () => within(screen.getAllByRole('listitem')[0]!);
  expect(firstRow().getByRole('button', { name: 'Resolve' })).toBeInTheDocument();

  set[0] = capture(0, { status: 'resolved', resolvedAt: '2026-07-17T03:00:00.000Z' });
  await liveTick();

  // Page 1 is re-read on every tick now; it used to be frozen the moment
  // "Load more" was clicked, and kept offering "Resolve" forever.
  await waitFor(() =>
    expect(firstRow().queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument(),
  );
  expect(firstRow().getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
});

test('shows the failed request’s route, status and id, and the stack collapsed', async () => {
  vi.mocked(api.listProblems).mockResolvedValue({
    ...list,
    problems: [
      {
        ...problem,
        context: {
          method: 'GET',
          route: '/api/v1/portfolios/:id',
          status: 500,
          requestId: '018f4b7e-8d3a-7c19-9d0b-1a2b3c4d5e6f',
          stack: 'TypeError: boom\n    at portfolioRoutes (portfolioRoutes.ts:1:1)',
        },
      },
    ],
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('GET /api/v1/portfolios/:id')).toBeInTheDocument());
  expect(screen.getByText('500')).toBeInTheDocument();
  expect(screen.getByText('018f4b7e-8d3a-7c19-9d0b-1a2b3c4d5e6f')).toBeInTheDocument();

  // Collapsed, not inline: the summary is what shows, the frames sit behind it.
  const stack = screen.getByText('Stack');
  expect(stack.closest('details')?.open).toBe(false);
  expect(stack.closest('details')?.textContent).toContain('portfolioRoutes.ts:1:1');
});

test('warns that the list is incomplete when the capture budget dropped rows', async () => {
  vi.mocked(api.listProblems).mockResolvedValue({ ...list, droppedCaptures: 140 });
  renderPage();

  await waitFor(() => expect(screen.getByText(/140 captures were dropped/)).toBeInTheDocument());
});

test('marks a resolved problem that came back as a regression', async () => {
  vi.mocked(api.listProblems).mockResolvedValue({
    ...list,
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
