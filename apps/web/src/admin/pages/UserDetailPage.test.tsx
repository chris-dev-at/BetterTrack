import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminUser,
  AdminUserAccessResponse,
  AdminUserNote,
  AdminUserSharingResponse,
  AdminUserSupportResponse,
  AuditLogEntry,
  EmailLogEntry,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { AuthProvider } from '../AuthContext';
import { UserDetailPage } from './UserDetailPage';

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
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const jane: AdminUser = {
  id: 'user-1',
  email: 'jane@bettertrack.test',
  username: 'jane',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  chatBanned: false,
  lastLoginAt: null,
  createdAt: '2026-02-02T00:00:00.000Z',
};

const auditEntry: AuditLogEntry = {
  id: '00000000-0000-7000-8000-000000000001',
  actorId: 'admin-1',
  action: 'user.email_changed',
  targetType: 'user',
  targetId: 'user-1',
  ip: '127.0.0.1',
  meta: { email: 'jane@bettertrack.test' },
  createdAt: '2026-03-03T00:00:00.000Z',
};

const emailEntry: EmailLogEntry = {
  id: '00000000-0000-7000-8000-000000000002',
  userId: 'user-1',
  recipient: 'jane@bettertrack.test',
  template: 'temp-password',
  subject: 'Your temporary password',
  status: 'sent',
  errorCode: null,
  createdAt: '2026-03-04T00:00:00.000Z',
};

const emptyAccess: AdminUserAccessResponse = {
  sessions: [],
  apiKeys: [],
  oauthGrants: [],
  identities: [],
};

const emptySharing: AdminUserSharingResponse = {
  portfolioCount: 0,
  sharedPortfolioCount: 0,
  shareAudienceCount: 0,
  activeShareLinkCount: 0,
  revokedShareLinkCount: 0,
  friendCount: 0,
  followerCount: 0,
  followingCount: 0,
};

const emptySupport: AdminUserSupportResponse = { items: [], total: 0, openCount: 0 };

function renderPage(locale = 'en', entry = '/admin/users/user-1') {
  return render(
    <I18nProvider initialLocale={locale}>
      <AuthProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/admin/users/:userId" element={<UserDetailPage />} />
            <Route path="/admin/users" element={<div>Users list</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

/** Open one of the six 360 tabs by its visible label. */
async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('tab', { name: new RegExp(name) }));
}

beforeEach(() => {
  // Reset call history + per-test implementations between cases; without this the
  // mocked adminApi retains calls from a sibling test and `toHaveBeenCalledWith`
  // matches (or reports) a stale mutation from the wrong test (#337).
  vi.clearAllMocks();
  vi.mocked(api.getMe).mockResolvedValue(admin);
  vi.mocked(api.getTwoFactorStatus).mockResolvedValue({
    setupRequired: false,
    totpEnabled: true,
    totpPending: false,
    emailEnabled: false,
    twoFactorEmail: null,
    recoveryCodesRemaining: 8,
  });
  vi.mocked(api.getUser).mockResolvedValue(jane);
  vi.mocked(api.getUserAccess).mockResolvedValue(emptyAccess);
  vi.mocked(api.getUserSharing).mockResolvedValue(emptySharing);
  vi.mocked(api.getUserSupport).mockResolvedValue(emptySupport);
  vi.mocked(api.listUserNotes).mockResolvedValue({ notes: [] });
  vi.mocked(api.listUserAudit).mockResolvedValue({ entries: [auditEntry], nextCursor: null });
  vi.mocked(api.listUserEmails).mockResolvedValue({ entries: [emailEntry], nextCursor: null });
});

test('reads the one account it is showing instead of downloading the whole list', async () => {
  renderPage();

  expect(await screen.findByDisplayValue('jane')).toBeInTheDocument();
  expect(api.getUser).toHaveBeenCalledWith('user-1', expect.anything());
  // The pre-W2 page pulled every account to find one row. That must not come back.
  expect(api.listUsers).not.toHaveBeenCalled();
});

test('renders the six recovered tabs and lands on Summary', async () => {
  renderPage();

  for (const label of ['Summary', 'Access', 'Support', 'Sharing', 'Activity', 'Notes']) {
    expect(await screen.findByRole('tab', { name: new RegExp(label) })).toBeInTheDocument();
  }
  expect(screen.getByRole('tab', { name: /Summary/ })).toHaveAttribute('aria-selected', 'true');
  expect(await screen.findByDisplayValue('jane@bettertrack.test')).toBeInTheDocument();
});

test('a tab is a link, not component state: ?tab= opens it directly', async () => {
  renderPage('en', '/admin/users/user-1?tab=sharing');

  expect(await screen.findByRole('tab', { name: /Sharing/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await waitFor(() => expect(api.getUserSharing).toHaveBeenCalled());
});

test('the account actions stay reachable from the detail view', async () => {
  renderPage();

  expect(await screen.findByRole('button', { name: 'Disable' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Send test email' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copy support snapshot' })).toBeInTheDocument();
});

test('the Activity tab carries the per-user audit log and email log', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');

  await openTab(user, 'Activity');

  expect(await screen.findByText('user.email_changed')).toBeInTheDocument();
  expect(await screen.findByText('Your temporary password')).toBeInTheDocument();
});

test('localizes the empty per-user email log label', async () => {
  vi.mocked(api.listUserEmails).mockResolvedValue({ entries: [], nextCursor: null });

  const user = userEvent.setup();
  renderPage('de');
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Aktivität');

  expect(
    await screen.findByText('Noch keine E-Mails an jane@bettertrack.test gesendet.'),
  ).toBeInTheDocument();
});

test('editing the username persists via updateUser', async () => {
  vi.mocked(api.updateUser).mockResolvedValue({ ...jane, username: 'jane2' });

  const user = userEvent.setup();
  renderPage();

  const usernameField = await screen.findByLabelText('Username');
  // Wait for the controlled value to settle before editing — otherwise a late
  // hydration can re-fill the field after `clear` and the typed text appends (#337).
  await waitFor(() => expect(usernameField).toHaveValue('jane'));
  await user.clear(usernameField);
  await user.type(usernameField, 'jane2');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(api.updateUser).toHaveBeenCalledWith('user-1', { username: 'jane2' }));
  expect(await screen.findByText('Profile updated.')).toBeInTheDocument();
});

test('editing the email persists via updateUser', async () => {
  vi.mocked(api.updateUser).mockResolvedValue({ ...jane, email: 'jane.doe@bettertrack.test' });

  const user = userEvent.setup();
  renderPage();

  const emailField = await screen.findByLabelText('Email');
  await waitFor(() => expect(emailField).toHaveValue('jane@bettertrack.test'));
  await user.clear(emailField);
  await user.type(emailField, 'jane.doe@bettertrack.test');
  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() =>
    expect(api.updateUser).toHaveBeenCalledWith('user-1', { email: 'jane.doe@bettertrack.test' }),
  );
});

test('keeps a reset temporary password open until it is acknowledged', async () => {
  vi.mocked(api.resetPassword).mockResolvedValue({ user: jane, tempPassword: 'Reset-Pass-4242' });

  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Reset password' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Reset password' }));

  const resultDialog = await screen.findByRole('dialog', { name: 'Password reset' });
  expect(within(resultDialog).getByText('Reset-Pass-4242')).toBeInTheDocument();
  expect(api.resetPassword).toHaveBeenCalledWith('user-1');

  await user.keyboard('{Escape}');
  fireEvent.mouseDown(resultDialog.parentElement!);
  expect(screen.getByText('Reset-Pass-4242')).toBeInTheDocument();

  await user.click(within(resultDialog).getByRole('button', { name: 'Copy' }));
  expect(await within(resultDialog).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByText('Reset-Pass-4242')).not.toBeInTheDocument());
});

test('delete is gated behind type-username confirmation', async () => {
  vi.mocked(api.deleteUser).mockResolvedValue();

  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete account' });
  const confirmButton = within(dialog).getByRole('button', { name: 'Delete account' });
  expect(confirmButton).toBeDisabled();

  await user.type(within(dialog).getByLabelText('Confirm username'), 'jane');
  await waitFor(() => expect(confirmButton).toBeEnabled());

  await user.click(confirmButton);
  expect(api.deleteUser).toHaveBeenCalledWith('user-1', 'jane');
});

// ── Privacy boundaries (#1406 kill list, §3, §6.12) ─────────────────────────

test('the paranoid card shows metadata only, and says why there is nothing more', async () => {
  vi.mocked(api.getUser).mockResolvedValue({
    ...jane,
    privacyMode: 'paranoid',
    paranoid: {
      mediaSet: ['server', 'drive'],
      vault: { version: 14, sizeBytes: 63897, updatedAt: '2026-08-20T10:00:00.000Z' },
      historyCount: 13,
    },
  });
  renderPage();

  expect(await screen.findByText('Paranoid account')).toBeInTheDocument();
  expect(screen.getByText('server + drive')).toBeInTheDocument();
  expect(screen.getByText('14')).toBeInTheDocument();
  expect(screen.getByText('13')).toBeInTheDocument();
  expect(screen.getByText(/no support action can open it/i)).toBeInTheDocument();

  // The page must offer no way to act on the vault. If any of these ever appear
  // it means a kill-listed capability was built.
  for (const forbidden of [/decrypt/i, /impersonat/i, /view as user/i, /download export/i]) {
    expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
  }
});

test('a normal account says plainly that there is no vault', async () => {
  renderPage();
  expect(await screen.findByText(/There is no vault/i)).toBeInTheDocument();
});

test('the Access tab is read-only — no session, key or grant revoke', async () => {
  vi.mocked(api.getUserAccess).mockResolvedValue({
    sessions: [
      {
        id: 'handle-abc',
        device: 'Safari on iPhone',
        createdAt: '2026-08-01T10:00:00.000Z',
        lastSeenAt: '2026-08-20T10:00:00.000Z',
        persistent: true,
      },
    ],
    apiKeys: [
      {
        id: '00000000-0000-7000-8000-0000000000aa',
        name: 'home dashboard',
        scopes: ['read:portfolio'],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: '2026-08-01T10:00:00.000Z',
      },
    ],
    oauthGrants: [],
    identities: [{ provider: 'google', emailVerified: true, linkedAt: '2026-07-01T10:00:00.000Z' }],
  });

  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Access');

  expect(await screen.findByText('Safari on iPhone')).toBeInTheDocument();
  expect(screen.getByText('API key “home dashboard”')).toBeInTheDocument();
  expect(screen.getByText('google')).toBeInTheDocument();

  // STRUCTURAL, not label-coupled. Matching /revoke/i and /sign out/i passed
  // happily with a working "Terminate all sessions" button sitting on the tab,
  // which is exactly the capability the #1406 kill list says must not exist.
  // So: the loaded Access panel must contain NO actionable control of any kind.
  // Any button, link, input, checkbox or form added here fails this test
  // whatever it is called, and shipping one becomes a deliberate act.
  const panel = screen.getByRole('tabpanel');
  for (const role of ['button', 'link', 'checkbox', 'textbox', 'combobox', 'radio', 'switch']) {
    expect(
      within(panel)
        .queryAllByRole(role)
        .map((el) => el.textContent?.trim() || el.outerHTML),
      `the read-only Access tab must expose no ${role}`,
    ).toEqual([]);
  }
  expect(panel.querySelectorAll('form, input, select, textarea, button, a')).toHaveLength(0);

  // Control: the guard is scoped to the panel, not the whole page — the header's
  // account actions still exist, so an empty-page false positive cannot pass it.
  expect(screen.getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
});

test('the Sharing tab reports counts and never an inventory', async () => {
  vi.mocked(api.getUserSharing).mockResolvedValue({
    ...emptySharing,
    portfolioCount: 4,
    sharedPortfolioCount: 1,
    activeShareLinkCount: 2,
    revokedShareLinkCount: 3,
    friendCount: 5,
  });

  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Sharing');

  expect(await screen.findByText('Shared with friends')).toBeInTheDocument();
  expect(screen.getByText('Active share links')).toBeInTheDocument();
  expect(screen.getByText('3 revoked')).toBeInTheDocument();
  expect(screen.getByText(/Admins cannot browse/i)).toBeInTheDocument();
});

test('the Support tab summarizes threads and links to the helpdesk for the bodies', async () => {
  vi.mocked(api.getUserSupport).mockResolvedValue({
    total: 2,
    openCount: 1,
    items: [
      {
        id: '00000000-0000-7000-8000-0000000000b1',
        category: 'bug',
        subject: 'Dividend rounding',
        status: 'new',
        deletedByUser: false,
        archived: false,
        unreadByAdmin: true,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
      },
    ],
  });

  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Support');

  expect(await screen.findByText('Dividend rounding')).toBeInTheDocument();
  expect(screen.getByText('Unread')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open the helpdesk' })).toHaveAttribute(
    'href',
    '/admin/support',
  );
});

// ── Operator notes ──────────────────────────────────────────────────────────

const note: AdminUserNote = {
  id: '00000000-0000-7000-8000-0000000000c1',
  body: 'Prefers German copy.',
  authorId: 'admin-1',
  authorUsername: 'rootadmin',
  createdAt: '2026-08-10T10:00:00.000Z',
};

test('an operator note is written, listed and removed behind a confirmation', async () => {
  vi.mocked(api.createUserNote).mockResolvedValue(note);
  vi.mocked(api.deleteUserNote).mockResolvedValue();
  vi.mocked(api.listUserNotes).mockResolvedValue({ notes: [note] });

  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Notes');

  expect(await screen.findByText('Prefers German copy.')).toBeInTheDocument();
  expect(screen.getByText('rootadmin')).toBeInTheDocument();

  await user.type(screen.getByPlaceholderText(/What should the next operator know/), 'New note');
  await user.click(screen.getByRole('button', { name: 'Save note' }));
  await waitFor(() =>
    expect(api.createUserNote).toHaveBeenCalledWith('user-1', { body: 'New note' }),
  );

  // Removal takes two clicks: a note is operator speech about a real person.
  await user.click(screen.getByRole('button', { name: 'Remove' }));
  expect(api.deleteUserNote).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Remove note' }));
  await waitFor(() => expect(api.deleteUserNote).toHaveBeenCalledWith('user-1', note.id));
});

test('a note that is already gone surfaces a banner and keeps the session', async () => {
  vi.mocked(api.listUserNotes).mockResolvedValue({ notes: [note] });
  vi.mocked(api.deleteUserNote).mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));

  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Notes');

  await user.click(await screen.findByRole('button', { name: 'Remove' }));
  await user.click(screen.getByRole('button', { name: 'Remove note' }));

  expect(await screen.findByText('That note is already gone.')).toBeInTheDocument();
  // The page is still here: a benign 404 must not log the operator out (W1 B2).
  expect(screen.getByRole('tab', { name: /Notes/ })).toBeInTheDocument();
});

test('the save button stays disabled for a blank note', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByDisplayValue('jane');
  await openTab(user, 'Notes');

  const save = await screen.findByRole('button', { name: 'Save note' });
  expect(save).toBeDisabled();

  await user.type(screen.getByPlaceholderText(/What should the next operator know/), '   ');
  expect(save).toBeDisabled();
});

// ── Support snapshot ────────────────────────────────────────────────────────

// The literal-copy AST guard cannot see inside a string builder, so the snapshot
// is the one surface where a hardcoded English label could ship unnoticed under
// German chrome. This is that guard, done behaviourally.
test('the support snapshot is fully localized — no English labels survive under DE', async () => {
  vi.mocked(api.getUser).mockResolvedValue({
    ...jane,
    privacyMode: 'paranoid',
    paranoid: {
      mediaSet: ['server'],
      vault: { version: 14, sizeBytes: 63897, updatedAt: '2026-08-20T10:00:00.000Z' },
      historyCount: 13,
    },
  });
  vi.mocked(api.getUserSupport).mockResolvedValue({ items: [], total: 2, openCount: 1 });

  const user = userEvent.setup();
  renderPage('de');
  await user.click(await screen.findByRole('button', { name: 'Support-Auszug kopieren' }));

  const dialog = await screen.findByRole('dialog', { name: 'Support-Auszug' });
  const body = dialog.querySelector('pre')?.textContent ?? '';
  expect(body).not.toBe('');

  // Every English label the builder used to hardcode, plus the yes/no values.
  const ENGLISH_LABELS = [
    'username:',
    'email:',
    'kind:',
    'state:',
    'must change password:',
    'chat banned:',
    'created:',
    'last login:',
    'privacy mode:',
    'vault media:',
    'vault version:',
    'vault size:',
    'vault updated:',
    'vault history entries:',
    'support submissions:',
  ];
  for (const label of ENGLISH_LABELS) {
    expect(body, `snapshot still ships the English label "${label}" under DE`).not.toContain(label);
  }
  expect(body).not.toMatch(/:\s(yes|no)$/m);
  expect(body).not.toContain(' open)');

  // ...and the German ones are actually there, so "no English" cannot be
  // satisfied by an empty or truncated dump.
  expect(body).toContain('Benutzername: jane');
  expect(body).toContain('Passwort muss geändert werden: Nein');
  expect(body).toContain('Tresor-Version: 14');
  expect(body).toContain('Support-Anfragen: 2 (1 offen)');

  // The enum values stay verbatim on purpose — the wire says `paranoid`.
  expect(body).toContain('Privatsphäre-Modus: paranoid');
});

test('the support snapshot carries account facts and no vault contents', async () => {
  vi.mocked(api.getUser).mockResolvedValue({
    ...jane,
    privacyMode: 'paranoid',
    paranoid: {
      mediaSet: ['server'],
      vault: { version: 14, sizeBytes: 63897, updatedAt: '2026-08-20T10:00:00.000Z' },
      historyCount: 13,
    },
  });

  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Copy support snapshot' }));

  const dialog = await screen.findByRole('dialog', { name: 'Support snapshot' });
  // Scope to the payload itself, NOT the dialog: the surrounding explainer
  // legitimately uses the words the payload must never contain, and asserting on
  // the whole dialog would make this test unable to fail. (The modal is a
  // portal, so the query starts from the dialog node, not the render container.)
  const payload = dialog.querySelector('pre');
  expect(payload).not.toBeNull();
  const body = payload!.textContent ?? '';

  expect(body).toContain('username: jane');
  expect(body).toContain('email: jane@bettertrack.test');
  expect(body).toContain('privacy mode: paranoid');
  expect(body).toContain('vault version: 14');
  // Composed only from what this page holds, so it structurally cannot carry
  // holdings, decrypted content or storage identifiers. Assert the promise.
  expect(body).not.toMatch(/holding/i);
  expect(body).not.toMatch(/drive/i);
  expect(body).not.toMatch(/decrypt/i);
});
