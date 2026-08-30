import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// This suite is about the overlay itself (taxonomy, nav, filter, focus, Escape),
// so every panel is stubbed to a bare marker. Their real behaviour stays covered
// by their own suites under `./panels/`.
vi.mock('./panels/AccountPanel', () => ({
  AccountPanel: () => createElement('p', null, 'account-panel'),
}));
vi.mock('./panels/AppearancePanel', () => ({
  AppearancePanel: () => createElement('p', null, 'appearance-panel'),
}));
vi.mock('./panels/ProfilePanel', () => ({
  ProfilePanel: () => createElement('p', null, 'profile-panel'),
}));
vi.mock('./panels/SignInPanel', () => ({
  SignInPanel: () => createElement('p', null, 'sign-in-panel'),
}));
vi.mock('./panels/SessionsPanel', () => ({
  SessionsPanel: () => createElement('p', null, 'sessions-panel'),
}));
vi.mock('./panels/TrustedDevicesPanel', () => ({
  TrustedDevicesPanel: () => createElement('p', null, 'trusted-devices-panel'),
}));
vi.mock('./panels/DefaultsPanel', () => ({
  DefaultsPanel: () => createElement('p', null, 'defaults-panel'),
}));
vi.mock('./panels/NotificationsPanel', () => ({
  NotificationsPanel: () => createElement('p', null, 'notifications-panel'),
}));
vi.mock('./panels/NotificationLogPanel', () => ({
  NotificationLogPanel: () => createElement('p', null, 'notification-log-panel'),
}));
vi.mock('./panels/ConnectionsPanel', () => ({
  ConnectionsPanel: () => createElement('p', null, 'connections-panel'),
}));
vi.mock('./panels/ApiKeysPanel', () => ({
  ApiKeysPanel: () => createElement('p', null, 'api-panel'),
}));
vi.mock('./panels/OAuthAppsPanel', () => ({
  OAuthAppsPanel: () => createElement('p', null, 'oauth-apps-panel'),
}));
vi.mock('./panels/AuthorizedAppsPanel', () => ({
  AuthorizedAppsPanel: () => createElement('p', null, 'authorized-apps-panel'),
}));
vi.mock('./panels/WebhooksPanel', () => ({
  WebhooksPanel: () => createElement('p', null, 'webhooks-panel'),
}));
vi.mock('./panels/DeleteAccountPanel', () => ({
  DeleteAccountPanel: () => createElement('p', null, 'delete-account-panel'),
}));
vi.mock('./panels/FeedbackPanel', () => ({
  FeedbackPanel: ({ screen }: { screen?: string }) =>
    createElement('p', { 'data-screen': screen }, 'feedback-panel'),
}));
// The privacy panel stands in for a panel whose modal replaces (and detaches)
// its opener, reproducing the focus-restoration corner case from the review.
vi.mock('./panels/PrivacyPanel', async () => {
  const { createElement, useState } = await import('react');
  const { Dialog } = await import('../components/Dialog');

  function PrivacyPanel() {
    const [open, setOpen] = useState(false);
    return open
      ? createElement(Dialog, {
          children: createElement('button', { type: 'button' }, 'Nested action'),
          onClose: () => setOpen(false),
          title: 'Nested modal',
        })
      : createElement(
          'button',
          { onClick: () => setOpen(true), type: 'button' },
          'Open nested modal',
        );
  }

  return { PrivacyPanel };
});

import { I18nProvider } from '../../i18n';
import { setViewportWidth } from '../../test/viewport';
import { CONTROL_GROUPS, ControlCenterOverlay } from './ControlCenterOverlay';

/** A shell-level control that stays mounted, so focus restore is observable. */
function Opener() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/control/account')} type="button">
      opener
    </button>
  );
}

function renderAt(
  path: string,
  {
    entries,
    locale,
    screen: backgroundScreen,
  }: { entries?: string[]; locale?: string; screen?: string } = {},
) {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={entries ?? [path]} initialIndex={(entries?.length ?? 1) - 1}>
        <Opener />
        <Routes>
          <Route path="/" element={<p>home-canvas</p>} />
          <Route path="/elsewhere" element={<p>elsewhere-canvas</p>} />
          <Route path="/developer" element={<p>developer-page</p>} />
          {/* Mirrors UserApp: ONE optional-param node — two separate nodes
              would remount the overlay when a click crosses between them. */}
          <Route path="/control/data" element={<p>data-management-page</p>} />
          <Route
            path="/control/:panel?"
            element={<ControlCenterOverlay screen={backgroundScreen} />}
          />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function popup(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Control Center' });
}

beforeEach(() => {
  // MemoryRouter never touches window.history; the "is there history?" probe
  // reads it, so pin it to a fresh entry (idx 0) unless a test says otherwise.
  window.history.replaceState({ idx: 0 }, '');
});

describe('ControlCenterOverlay', () => {
  test('`/control` opens the popup on the default panel over the shell', () => {
    renderAt('/control');

    const dialog = popup();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('account-panel')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Account', current: 'page' })).toBeVisible();
    // Portalled to the body, so the shell stays mounted (and dimmed) behind it —
    // and the portal root carries `bt-app`, or it would lose the app's ink,
    // type scale and gold focus ring.
    const root = dialog.closest('.bt-cc-root');
    expect(root).toHaveClass('bt-app');
    expect(root?.parentElement).toBe(document.body);
    expect(screen.getByRole('button', { name: 'opener' })).toBeInTheDocument();
  });

  test.each([
    ['/control/appearance', 'appearance-panel', 'Appearance'],
    ['/control/profile', 'profile-panel', 'Public profile'],
    ['/control/sign-in', 'sign-in-panel', 'Sign-in'],
    ['/control/sessions', 'sessions-panel', 'Sessions'],
    ['/control/trusted-devices', 'trusted-devices-panel', 'Trusted devices'],
    ['/control/defaults', 'defaults-panel', 'Portfolio defaults'],
    ['/control/notifications', 'notifications-panel', 'Notifications'],
    ['/control/notification-log', 'notification-log-panel', 'Notification log'],
    ['/control/feedback', 'feedback-panel', 'Send feedback'],
    ['/control/connections', 'connections-panel', 'Connections'],
    ['/control/api', 'api-panel', 'API keys'],
    ['/control/oauth-apps', 'oauth-apps-panel', 'OAuth apps'],
    ['/control/authorized-apps', 'authorized-apps-panel', 'Authorized apps'],
    ['/control/webhooks', 'webhooks-panel', 'Webhooks'],
    ['/control/delete-account', 'delete-account-panel', 'Delete account'],
  ])('%s deep-links its panel', (path, marker, label) => {
    renderAt(path);

    expect(within(popup()).getByText(marker)).toBeInTheDocument();
    expect(within(popup()).getByRole('link', { name: label, current: 'page' })).toBeVisible();
  });

  test('passes the page behind the popup to the feedback panel', () => {
    renderAt('/control/feedback', { screen: '/portfolio?portfolio=portfolio-1' });

    expect(within(popup()).getByText('feedback-panel')).toHaveAttribute(
      'data-screen',
      '/portfolio?portfolio=portfolio-1',
    );
  });

  test('every declared panel id renders its own panel', () => {
    const ids = CONTROL_GROUPS.flatMap((group) => group.panels.map((panel) => panel.id));
    // The taxonomy and the deep-link table above must not drift apart (the
    // table covers all but `privacy`, whose stub is the nested-modal fixture).
    expect(ids).toHaveLength(17);
    for (const id of ids) {
      const view = renderAt(`/control/${id}`);
      expect(
        within(popup()).getByRole('link', { current: 'page' }),
        `panel "${id}" did not mark its nav row current`,
      ).toBeVisible();
      view.unmount();
    }
  });

  test('an unknown panel id falls back to the default panel instead of blanking', () => {
    renderAt('/control/nope');

    expect(within(popup()).getByText('account-panel')).toBeInTheDocument();
  });

  // Ids this restructure renamed must resolve to their NEW panel, not silently
  // fall back to Account — old bookmarks and deep links stay honest.
  test.each([
    ['/control/security', 'sign-in-panel'],
    ['/control/portfolio-defaults', 'defaults-panel'],
    ['/control/taxes', 'defaults-panel'],
    ['/control/api-keys', 'api-panel'],
  ])('%s resolves through the alias map', (path, marker) => {
    renderAt(path);

    expect(within(popup()).getByText(marker)).toBeInTheDocument();
    expect(within(popup()).queryByText('account-panel')).not.toBeInTheDocument();
  });

  test('clicking a nav row switches the panel without leaving the popup', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.click(within(popup()).getByRole('link', { name: 'Sign-in' }));

    expect(within(popup()).getByText('sign-in-panel')).toBeInTheDocument();
    expect(within(popup()).queryByText('account-panel')).not.toBeInTheDocument();
    expect(within(popup()).getByRole('link', { name: 'Account' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  test('the filter narrows the panel nav as you type', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.type(within(popup()).getByRole('searchbox', { name: 'Filter panels' }), 'sess');

    expect(within(popup()).getByRole('link', { name: 'Sessions' })).toBeInTheDocument();
    expect(within(popup()).queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
    // Filtering never unmounts the active panel — only the nav narrows.
    expect(within(popup()).getByText('account-panel')).toBeInTheDocument();
  });

  test.each([
    ['password', 'Sign-in', '/control/sign-in'],
    ['2FA', 'Sign-in', '/control/sign-in'],
    ['export', 'Account', '/control/account'],
    ['PIN', 'Sign-in', '/control/sign-in'],
  ])('the %s setting keyword surfaces its owning panel', async (query, panelLabel, href) => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.type(within(popup()).getByRole('searchbox', { name: 'Filter panels' }), query);

    expect(within(popup()).getByRole('link', { name: panelLabel })).toHaveAttribute('href', href);
  });

  test('setting keywords are matched in the active locale', async () => {
    const user = userEvent.setup();
    renderAt('/control/account', { locale: 'de' });
    const dialog = screen.getByRole('dialog', { name: 'Kontrollzentrum' });

    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Bereiche filtern' }),
      'Passwort',
    );

    expect(within(dialog).getByRole('link', { name: 'Anmeldung' })).toHaveAttribute(
      'href',
      '/control/sign-in',
    );
  });

  test('a filter that matches nothing says so', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.type(within(popup()).getByRole('searchbox', { name: 'Filter panels' }), 'zzzz');

    expect(within(popup()).getByText('No panel matches.')).toBeInTheDocument();
  });

  test('rows that leave the popup are links to real pages, not panels', () => {
    renderAt('/control');

    const dialog = popup();
    for (const [name, href] of [
      ['Developer overview', '/developer'],
      ['Review Planned', '/review'],
      ['Data management Planned', '/control/data'],
    ]) {
      expect(within(dialog).getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  test('panel switches keep the overlay alive and close leaves in ONE step', async () => {
    // MemoryRouter never writes the router idx into window.history — seed it
    // like the "goes back" test below, and reset at the end for later tests.
    window.history.pushState({ idx: 1 }, '');
    const user = userEvent.setup();
    renderAt('/control', { entries: ['/elsewhere', '/control'] });

    // Liveness probe: text typed into the filter must survive panel switches —
    // a remounting overlay (the visual "reopen" bug) would blank it.
    const filter = within(popup()).getByRole('searchbox', { name: 'Filter panels' });
    await user.type(filter, 'e');

    await user.click(within(popup()).getByRole('link', { name: 'Sessions' }));
    expect(await screen.findByText('sessions-panel')).toBeInTheDocument();
    expect(within(popup()).getByRole('searchbox', { name: 'Filter panels' })).toHaveValue('e');

    await user.click(within(popup()).getByRole('link', { name: 'Webhooks' }));
    expect(await screen.findByText('webhooks-panel')).toBeInTheDocument();

    // Two panel hops later, ONE Escape returns to the pre-overlay page: the
    // switches replaced the history entry instead of stacking on it.
    await user.keyboard('{Escape}');
    expect(await screen.findByText('elsewhere-canvas')).toBeInTheDocument();

    window.history.pushState({ idx: 0 }, '');
  });

  test('Escape closes the popup; with no history it lands on the home canvas', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('home-canvas')).toBeInTheDocument();
  });

  test('Escape goes back when the app has history behind the popup', async () => {
    window.history.pushState({ idx: 1 }, '');
    const user = userEvent.setup();
    renderAt('/control/account', { entries: ['/elsewhere', '/control/account'] });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByText('elsewhere-canvas')).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Control Center' })).not.toBeInTheDocument();
  });

  test('a nested modal owns Escape and restores focus into the overlay when its opener detached', async () => {
    const user = userEvent.setup();
    renderAt('/control/privacy');

    const opener = await screen.findByRole('button', { name: 'Open nested modal' });
    await user.click(opener);
    expect(screen.getByRole('dialog', { name: 'Nested modal' })).toBeInTheDocument();
    expect(opener.isConnected).toBe(false);

    await user.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Nested modal' })).not.toBeInTheDocument(),
    );
    const controlCenter = screen.getByRole('dialog', { name: 'Control Center' });
    const overlayRoot = controlCenter.closest<HTMLElement>('.bt-cc-root')!;
    expect(controlCenter).toBeInTheDocument();
    expect(overlayRoot).toHaveFocus();
    expect(overlayRoot).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).closest('[inert]')).toBeNull();
    expect(screen.queryByText('home-canvas')).not.toBeInTheDocument();
  });

  test('the scrim closes the popup', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    const dialog = popup();
    const root = dialog.closest<HTMLElement>('.bt-cc-root')!;
    const scrim = root.querySelector<HTMLElement>('.bt-scrim')!;
    expect(scrim.tagName).toBe('DIV');
    expect(scrim).toHaveAttribute('aria-hidden', 'true');
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1);

    await user.click(scrim);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('focus moves into the popup on open and returns to the opener on close', async () => {
    const user = userEvent.setup();
    renderAt('/');

    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);

    expect(popup()).toContainElement(document.activeElement as HTMLElement);
    expect(opener.closest('[inert]')).not.toBeNull();
    expect(popup().closest('[inert]')).toBeNull();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
    expect(opener.closest('[inert]')).toBeNull();
  });

  test('Tab is trapped inside the popup in both directions', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    const dialog = popup();
    const stops = [...dialog.querySelectorAll<HTMLElement>('a[href], button, input')];
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  test('the destructive row is inked negative — never gold, never an edge marker', () => {
    renderAt('/control/delete-account');

    const row = within(popup()).getByRole('link', { name: 'Delete account', current: 'page' });
    expect(row).toHaveClass('is-danger');
    expect(row.className).not.toMatch(/gold/);
  });

  // The one irreversible action never shares a group with routine settings.
  test('delete account sits alone in its own trailing group', () => {
    const last = CONTROL_GROUPS[CONTROL_GROUPS.length - 1]!;
    expect(last.titleKey).toBe('control.groups.danger');
    expect(last.panels.map((panel) => panel.id)).toEqual(['delete-account']);
    // …and no other group carries a destructive panel.
    for (const group of CONTROL_GROUPS.slice(0, -1)) {
      expect(group.panels.some((panel) => panel.danger)).toBe(false);
    }
  });

  test('body scroll is locked while the popup owns the screen and released after', () => {
    const view = renderAt('/control/account');

    expect(document.body.style.overflow).toBe('hidden');

    view.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  test('phone navigation keeps every settings panel reachable in one compact selector', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    renderAt('/control/account');

    const selector = within(popup()).getByRole('combobox', {
      name: 'Control Center panels',
    });
    expect(within(selector).getAllByRole('option')).toHaveLength(
      CONTROL_GROUPS.flatMap((group) => group.panels).length,
    );
    expect(within(popup()).queryByRole('searchbox', { name: 'Filter panels' })).toBeNull();

    await user.selectOptions(selector, 'notifications');
    expect(await within(popup()).findByText('notifications-panel')).toBeInTheDocument();
    expect(selector).toHaveValue('notifications');
  });
});
