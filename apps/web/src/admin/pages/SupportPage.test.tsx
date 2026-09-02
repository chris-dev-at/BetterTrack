import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  AdminFeedbackListResponse,
  AdminFeedbackSubmission,
  AdminUserSupportResponse,
  FeedbackThreadResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');

import { I18nProvider } from '../../i18n';
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
import { setViewportWidth } from '../../test/viewport';
import { AuthProvider, useAuth } from '../AuthContext';
import { SupportPage } from './SupportPage';

const admin: MeResponse = {
  user: {
    id: 'admin-1',
    email: 'jane@bettertrack.test',
    username: 'jane',
    role: 'admin',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
} as unknown as MeResponse;

function submission(overrides: Partial<AdminFeedbackSubmission> = {}): AdminFeedbackSubmission {
  return {
    id: 'sub-1',
    category: 'bug',
    subject: 'Dividend total is off by one payout',
    message: 'The August payout is missing from the yearly total.',
    context: { platform: 'web', appVersion: '5.2.0' },
    status: 'triaged',
    lastStatusChangeAt: '2026-08-25T08:00:00.000Z',
    declinedReason: null,
    shippedVersion: null,
    deletedByUser: false,
    archivedAt: null,
    submitter: { id: 'user-7', username: 'martin_k', email: 'martin@example.at' },
    unreadCount: 1,
    messageCount: 2,
    lastMessageAt: '2026-08-26T08:00:00.000Z',
    lastAuthorSide: 'submitter',
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-25T08:00:00.000Z',
    ...overrides,
  };
}

function listOf(rows: AdminFeedbackSubmission[]): AdminFeedbackListResponse {
  return {
    submissions: rows,
    pagination: { page: 1, limit: 25, total: rows.length, totalPages: 1 },
  };
}

const emptyThread: FeedbackThreadResponse = {
  thread: { id: 'sub-1', unreadCount: 0 },
  messages: [],
  nextCursor: null,
};

const noHistory: AdminUserSupportResponse = { items: [], total: 1, openCount: 1 };

/** Shows the live URL so tests can assert what a link would carry. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

/** Surfaces the auth status, so "was the operator signed out" is observable. */
function AuthProbe() {
  return <span data-testid="auth-status">{useAuth().status}</span>;
}

function renderPage(initialEntry = '/admin/support', locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <LocationProbe />
          <AuthProbe />
          <Routes>
            <Route path="/admin/support" element={<SupportPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setViewportWidth(1440);
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    enabled: true,
    methods: { totp: true, email: true },
    recoveryCodesRemaining: 8,
  } as unknown as Awaited<ReturnType<typeof api.getTwoFactorStatus>>);
  vi.mocked(api.listAdminFeedback).mockResolvedValue(listOf([submission()]));
  vi.mocked(api.getAdminFeedback).mockResolvedValue(submission());
  vi.mocked(api.getAdminFeedbackThread).mockResolvedValue(emptyThread);
  vi.mocked(api.getUserSupport).mockResolvedValue(noHistory);
  vi.mocked(api.markAdminFeedbackRead).mockResolvedValue(undefined);
});

describe('the inbox pane', () => {
  test('renders the queue as a listbox with thread state on each row', async () => {
    renderPage();

    const list = await screen.findByRole('listbox', { name: 'Support submissions' });
    const option = within(list).getByRole('option');
    expect(option).toHaveTextContent('Dividend total is off by one payout');
    expect(option).toHaveTextContent('martin_k');
    // "who spoke last" is the triage tell the row exists to carry.
    expect(option).toHaveTextContent('they replied last');
    expect(within(option).getByLabelText('Unread reply')).toBeInTheDocument();
  });

  test('a row with no replies says so instead of claiming somebody answered', async () => {
    vi.mocked(api.listAdminFeedback).mockResolvedValue(
      listOf([submission({ lastAuthorSide: null, messageCount: 0, unreadCount: 0 })]),
    );
    renderPage();

    const list = await screen.findByRole('listbox', { name: 'Support submissions' });
    const option = within(list).getByRole('option');
    expect(option).toHaveTextContent('no replies yet');
    expect(within(option).queryByLabelText('Unread reply')).not.toBeInTheDocument();
  });

  test('distinguishes "no results for this filter" from "nothing submitted"', async () => {
    vi.mocked(api.listAdminFeedback).mockResolvedValue(listOf([]));

    const bare = renderPage('/admin/support');
    expect(await screen.findByText('Nothing has been submitted yet.')).toBeInTheDocument();
    bare.unmount();

    renderPage('/admin/support?status=shipped');
    expect(await screen.findByText('No submission matches these filters.')).toBeInTheDocument();
  });

  test('the archived queue gets its own empty sentence', async () => {
    vi.mocked(api.listAdminFeedback).mockResolvedValue(listOf([]));
    renderPage('/admin/support?archived=true');

    expect(await screen.findByText('Nothing has been archived.')).toBeInTheDocument();
  });

  test('offers a retry when the failure is an outage', async () => {
    vi.mocked(api.listAdminFeedback).mockRejectedValue(
      new ApiError(503, 'UPSTREAM', 'upstream is down'),
    );
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('a failure it cannot classify still gets a primitive, never bare text', async () => {
    // No Retry button here on purpose: offering to retry something that is not
    // known to be transient is a promise the console cannot keep.
    vi.mocked(api.listAdminFeedback).mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  test('a filter change lands in the URL and resets paging', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?page=4');

    await screen.findByRole('listbox');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'shipped');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('status=shipped');
    });
    // Page 4 of a result set that just shrank would read as "no results".
    expect(screen.getByTestId('location')).not.toHaveTextContent('page=4');
  });

  test('the version filter is controlled: a link populates it and Clear empties it', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?version=5.2.0');
    await screen.findByRole('listbox');

    // An uncontrolled field would ignore the URL entirely.
    const version = screen.getByRole('textbox', { name: 'Shipped version' });
    expect(version).toHaveValue('5.2.0');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    // ...and would survive the reset, then re-apply itself on the next blur.
    await waitFor(() => expect(version).toHaveValue(''));
    expect(screen.getByTestId('location')).not.toHaveTextContent('version=');
  });

  test('both free-text filters cap their length at the contract bound', async () => {
    renderPage('/admin/support');
    await screen.findByRole('listbox');

    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveAttribute('maxlength', '120');
    expect(screen.getByRole('textbox', { name: 'Shipped version' })).toHaveAttribute(
      'maxlength',
      '64',
    );
  });

  test('sends the filters from the URL to the API, unread included as a boolean', async () => {
    renderPage('/admin/support?status=shipped&category=bug&version=5.2.0&unread=read&sort=aging');

    await waitFor(() => expect(api.listAdminFeedback).toHaveBeenCalled());
    expect(api.listAdminFeedback).toHaveBeenCalledWith(
      {
        status: 'shipped',
        category: 'bug',
        version: '5.2.0',
        unread: false,
        archived: false,
        sort: 'aging',
        page: 1,
        limit: 25,
      },
      expect.any(AbortSignal),
    );
  });
});

describe('the split pane and its keyboard', () => {
  test('Enter on the highlighted row opens the thread and puts it in the URL', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('listbox');

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('thread=sub-1');
    });
    // The pane reads the submission by id — that is what makes the link work
    // for someone whose filters exclude the row.
    expect(api.getAdminFeedback).toHaveBeenCalledWith('sub-1', expect.any(AbortSignal));
  });

  test('Escape closes the thread and returns to the inbox', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?thread=sub-1');

    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.getByTestId('location')).not.toHaveTextContent('thread=');
    });
  });

  test('j and k walk the queue without opening anything', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAdminFeedback).mockResolvedValue(
      listOf([submission({ id: 'sub-1' }), submission({ id: 'sub-2', subject: 'Second' })]),
    );
    renderPage();
    await screen.findByRole('listbox');

    await user.keyboard('jj');

    // Scanning the queue must not mark threads read on the way past.
    expect(screen.getByTestId('location')).not.toHaveTextContent('thread=');
    expect(api.markAdminFeedbackRead).not.toHaveBeenCalled();
  });

  test('typing j in the search box searches — it does not walk the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('listbox');

    const search = screen.getByRole('searchbox', { name: 'Search' });
    await user.click(search);
    await user.keyboard('jk');

    expect(search).toHaveValue('jk');
    expect(screen.getByTestId('location')).not.toHaveTextContent('thread=');
  });

  // ── K1 / K2 regressions (review round 1) ─────────────────────────────────
  // The window-level shortcut handler used to claim EVERY key whose target was
  // not an <input>/<textarea>/<select>, which meant it swallowed Enter from
  // every button in the workspace.

  test('Enter on a focused button activates the button and does not touch the thread', async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendAdminFeedbackReply).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof api.sendAdminFeedbackReply>>,
    );
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    await user.type(screen.getByRole('textbox', { name: 'Reply to martin_k' }), 'On it.');
    // Reach the control by keyboard, the way an operator actually would.
    screen.getByRole('button', { name: 'Send reply' }).focus();
    await user.keyboard('{Enter}');

    expect(api.sendAdminFeedbackReply).toHaveBeenCalledWith('sub-1', { body: 'On it.' });
    expect(screen.getByTestId('location')).toHaveTextContent('thread=sub-1');
  });

  test('Enter on the Refresh button does not swap the open thread', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listAdminFeedback).mockResolvedValue(
      listOf([submission({ id: 'sub-1' }), submission({ id: 'sub-2', subject: 'Second' })]),
    );
    renderPage('/admin/support?thread=sub-2');
    await screen.findByRole('listbox');

    // Move the HIGHLIGHT off the open thread first, so "open the focused row"
    // and "keep the current thread" are different outcomes. Without this the
    // assertion cannot fail.
    await user.keyboard('{ArrowUp}');
    screen.getByRole('button', { name: 'Refresh' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('location')).toHaveTextContent('thread=sub-2');
    expect(screen.getByTestId('location')).not.toHaveTextContent('thread=sub-1');
  });

  test('Escape does not destroy a half-written reply', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    await user.type(
      screen.getByRole('textbox', { name: 'Reply to martin_k' }),
      'Half a sentence that must survive',
    );
    // Tab out of the field, then Escape — the reviewer's exact sequence.
    screen.getByRole('button', { name: 'Send reply' }).focus();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('location')).not.toHaveTextContent('thread=');
    });

    // Reopening the same thread must bring the draft back.
    await user.click(within(await screen.findByRole('listbox')).getAllByRole('option')[0]!);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Reply to martin_k' })).toHaveValue(
        'Half a sentence that must survive',
      ),
    );
  });

  test('Escape twice from inside the composer keeps the draft', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    const box = screen.getByRole('textbox', { name: 'Reply to martin_k' });
    await user.type(box, 'Draft text');
    // First Escape leaves the field; the second closes the pane.
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByTestId('location')).not.toHaveTextContent('thread=');
    });

    await user.click(within(await screen.findByRole('listbox')).getAllByRole('option')[0]!);
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Reply to martin_k' })).toHaveValue('Draft text'),
    );
  });

  test('an open thread survives a reload of the link, and marks itself read once', async () => {
    renderPage('/admin/support?thread=sub-1');

    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });
    await waitFor(() => expect(api.markAdminFeedbackRead).toHaveBeenCalledWith('sub-1'));
    expect(api.markAdminFeedbackRead).toHaveBeenCalledTimes(1);
  });

  test('a link to a deleted submission is a stated dead end, not a sign-out', async () => {
    // The admin area answers non-admins with 404, so an unguarded 404 here
    // would clear the session and bounce the operator to the login screen for
    // the crime of clicking a stale link. The row-scoped reads declare
    // `notFound: 'gone'`, so the SAME 404 resolves to "this row is gone".
    vi.mocked(api.getAdminFeedback).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    vi.mocked(api.getAdminFeedbackThread).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    renderPage('/admin/support?thread=missing');

    expect(await screen.findByText('This submission no longer exists.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the inbox' })).toBeInTheDocument();
    // Still signed in: the inbox beside it is still rendering the queue.
    expect(screen.getByRole('listbox', { name: 'Support submissions' })).toBeInTheDocument();
  });

  test('the converse: a de-admined operator on a thread link IS signed out', async () => {
    // The list read keeps the default `session` policy, which is what makes the
    // `gone` policy above safe to grant to the two by-id reads. If BOTH reads
    // treated 404 as "gone", a revoked admin would sit on a stale pane forever.
    vi.mocked(api.getAdminFeedback).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    vi.mocked(api.getAdminFeedbackThread).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    vi.mocked(api.listAdminFeedback).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'nope'));
    renderPage('/admin/support?thread=sub-1');

    await waitFor(() => expect(screen.getByTestId('auth-status')).toHaveTextContent('anonymous'));
  });

  test('both panes stay mounted below lg, so the session-policy read keeps running', async () => {
    // The panes are shown one at a time on a phone with CSS, NOT by unmounting:
    // the inbox read is the only one on this screen whose 404 means auth loss.
    setViewportWidth(390);
    renderPage('/admin/support?thread=sub-1');

    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });
    // The inbox is mounted (its listbox exists) even though the thread is open.
    expect(screen.getByRole('listbox', { name: 'Support submissions' })).toBeInTheDocument();
    expect(api.listAdminFeedback).toHaveBeenCalled();
  });

  test('with nothing selected the right pane invites a selection', async () => {
    renderPage();
    expect(
      await screen.findByText('Select a submission to read and answer it.'),
    ).toBeInTheDocument();
  });
});

describe('the status controls (FEEDBACK-7 / #1341)', () => {
  test('declining is blocked in the UI until a reason is written', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Set status' }), 'declined');

    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    expect(
      screen.getByText('Declining needs a reason before it can be saved.'),
    ).toBeInTheDocument();
    // The operator is told the reason is what the submitter reads.
    expect(screen.getAllByText('This is what the submitter will see.').length).toBeGreaterThan(0);

    await user.type(
      screen.getByRole('textbox', { name: 'Reason for declining' }),
      'Working as designed.',
    );
    expect(apply).toBeEnabled();

    vi.mocked(api.updateFeedbackStatus).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof api.updateFeedbackStatus>>,
    );
    await user.click(apply);

    await waitFor(() =>
      expect(api.updateFeedbackStatus).toHaveBeenCalledWith('sub-1', {
        status: 'declined',
        declinedReason: 'Working as designed.',
      }),
    );
  });

  test('shipping is blocked until a version is written', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Set status' }), 'shipped');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(
      screen.getByText('Shipping needs a version before it can be saved.'),
    ).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Shipped in version' }), '5.3.0');

    vi.mocked(api.updateFeedbackStatus).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof api.updateFeedbackStatus>>,
    );
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(api.updateFeedbackStatus).toHaveBeenCalledWith('sub-1', {
        status: 'shipped',
        shippedVersion: '5.3.0',
      }),
    );
  });

  test('a plain transition sends neither detail field', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateFeedbackStatus).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof api.updateFeedbackStatus>>,
    );
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Set status' }), 'working_on_it');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    // A stale detail from a status the operator moved away from is a 400.
    await waitFor(() =>
      expect(api.updateFeedbackStatus).toHaveBeenCalledWith('sub-1', { status: 'working_on_it' }),
    );
  });

  test('Apply is inert until something actually changed', async () => {
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });

  test('a settled outcome quotes back what the submitter is being shown', async () => {
    vi.mocked(api.getAdminFeedback).mockResolvedValue(
      submission({ status: 'declined', declinedReason: 'Out of scope for now.' }),
    );
    renderPage('/admin/support?thread=sub-1');

    expect(
      await screen.findByText('Shown to the submitter right now: Out of scope for now.'),
    ).toBeInTheDocument();
  });
});

describe('the conversation', () => {
  test('renders the submission and its replies oldest-first, attributed by side', async () => {
    vi.mocked(api.getAdminFeedbackThread).mockResolvedValue({
      thread: { id: 'sub-1', unreadCount: 1 },
      // The wire is newest-first; a conversation reads the other way.
      messages: [
        {
          id: 'm2',
          feedbackId: 'sub-1',
          senderId: 'user-7',
          authorSide: 'submitter',
          body: 'Main portfolio, all EUR.',
          createdAt: '2026-08-24T08:00:00.000Z',
        },
        {
          id: 'm1',
          feedbackId: 'sub-1',
          senderId: 'admin-1',
          authorSide: 'admin',
          body: 'Which portfolio is this on?',
          createdAt: '2026-08-22T08:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    renderPage('/admin/support?thread=sub-1');

    const items = await screen.findAllByRole('listitem');
    const bodies = items.map((item) => item.textContent ?? '');
    const staffAt = bodies.findIndex((text) => text.includes('Which portfolio is this on?'));
    const userAt = bodies.findIndex((text) => text.includes('Main portfolio, all EUR.'));
    expect(staffAt).toBeGreaterThanOrEqual(0);
    expect(staffAt).toBeLessThan(userAt);
    expect(items[staffAt]).toHaveTextContent('You');
    expect(items[userAt]).toHaveTextContent('martin_k');
  });

  test('sends a reply and clears the composer', async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendAdminFeedbackReply).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof api.sendAdminFeedbackReply>>,
    );
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    const box = screen.getByRole('textbox', { name: 'Reply to martin_k' });
    await user.type(box, 'Fixed in the next build.');
    await user.click(screen.getByRole('button', { name: 'Send reply' }));

    await waitFor(() =>
      expect(api.sendAdminFeedbackReply).toHaveBeenCalledWith('sub-1', {
        body: 'Fixed in the next build.',
      }),
    );
    await waitFor(() => expect(box).toHaveValue(''));
  });

  test('an empty or whitespace-only reply cannot be sent', async () => {
    const user = userEvent.setup();
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    const send = screen.getByRole('button', { name: 'Send reply' });
    expect(send).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Reply to martin_k' }), '   ');
    expect(send).toBeDisabled();
  });

  test('warns before answering a thread the submitter has deleted', async () => {
    vi.mocked(api.getAdminFeedback).mockResolvedValue(submission({ deletedByUser: true }));
    renderPage('/admin/support?thread=sub-1');

    expect(await screen.findByText(/kept here for the record/)).toBeInTheDocument();
  });
});

describe('archiving and submitter context', () => {
  test('archives over the existing PATCH and reloads the row', async () => {
    const user = userEvent.setup();
    vi.mocked(api.setAdminFeedbackArchived).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof api.setAdminFeedbackArchived>>,
    );
    renderPage('/admin/support?thread=sub-1');
    await screen.findByRole('heading', { name: 'Dividend total is off by one payout' });

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(api.setAdminFeedbackArchived).toHaveBeenCalledWith('sub-1', true));
  });

  test('an archived thread offers to put it back, not to archive it again', async () => {
    vi.mocked(api.getAdminFeedback).mockResolvedValue(
      submission({ archivedAt: '2026-08-27T08:00:00.000Z' }),
    );
    renderPage('/admin/support?thread=sub-1');

    expect(await screen.findByRole('button', { name: 'Unarchive' })).toBeInTheDocument();
  });

  test('links the submitter to their User 360 and shows only the six diagnostics', async () => {
    renderPage('/admin/support?thread=sub-1');

    const link = await screen.findByRole('link', { name: 'Open in People →' });
    expect(link).toHaveAttribute('href', '/admin/users/user-7');

    expect(screen.getByText('Platform')).toBeInTheDocument();
    expect(screen.getByText('App version')).toBeInTheDocument();
  });

  test('drops any context key outside the six-key allowlist', async () => {
    vi.mocked(api.getAdminFeedback).mockResolvedValue(
      submission({ context: { platform: 'web', sessionToken: 'super-secret-value' } }),
    );
    renderPage('/admin/support?thread=sub-1');

    await screen.findByText('Platform');
    // The context object is extensible on the wire; the pane is not.
    expect(screen.queryByText('super-secret-value')).not.toBeInTheDocument();
    expect(screen.queryByText(/sessionToken/)).not.toBeInTheDocument();
  });
});

test('ships German copy across both panes', async () => {
  renderPage('/admin/support?thread=sub-1', 'de');

  expect(await screen.findByRole('combobox', { name: 'Kategorie' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Antwort senden' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Archivieren' })).toBeInTheDocument();
  expect(screen.getByText('Absender')).toBeInTheDocument();
});
