import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// The overlay mounts the EXISTING settings pages in place; this suite is about
// the overlay itself (nav, filter, focus, Escape), so every panel is stubbed to
// a bare marker. Their real behavior stays covered by their own suites.
vi.mock('../settings/AccountSettingsPage', () => ({
  AccountSettingsPage: () => createElement('p', null, 'account-panel'),
}));
vi.mock('../settings/ApiAccessPage', () => ({
  ApiAccessPage: () => createElement('p', null, 'api-panel'),
}));
vi.mock('../settings/ConnectionsPage', () => ({
  ConnectionsPage: () => createElement('p', null, 'connections-panel'),
}));
vi.mock('../settings/DeleteAccountPage', () => ({
  DeleteAccountPage: () => createElement('p', null, 'delete-account-panel'),
}));
vi.mock('../settings/NewPortfolioDefaultsPage', () => ({
  NewPortfolioDefaultsPage: () => createElement('p', null, 'portfolio-defaults-panel'),
}));
vi.mock('../settings/SecuritySettingsPage', () => ({
  SecuritySettingsPage: () => createElement('p', null, 'security-panel'),
}));
vi.mock('../settings/SettingsSection', () => ({
  NotificationSettingsPage: () => createElement('p', null, 'notifications-panel'),
}));
vi.mock('../settings/WebhooksSection', () => ({
  WebhooksSection: () => createElement('p', null, 'webhooks-panel'),
}));
// The webhooks panel stands in for "a panel that opens a nested modal".
vi.mock('../hub/HubPages', () => ({
  PrivacyPanel: () =>
    createElement(
      'div',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Nested modal' },
      'privacy-panel-with-nested-modal',
    ),
}));

import { I18nProvider } from '../../i18n';
import { ControlCenterOverlay } from './ControlCenterOverlay';

/** A shell-level control that stays mounted, so focus restore is observable. */
function Opener() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate('/control/account')} type="button">
      opener
    </button>
  );
}

function renderAt(path: string, { entries }: { entries?: string[] } = {}) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={entries ?? [path]} initialIndex={(entries?.length ?? 1) - 1}>
        <Opener />
        <Routes>
          <Route path="/" element={<p>home-canvas</p>} />
          <Route path="/elsewhere" element={<p>elsewhere-canvas</p>} />
          <Route path="/developer" element={<p>developer-page</p>} />
          <Route path="/control" element={<ControlCenterOverlay />} />
          <Route path="/control/data" element={<p>data-management-page</p>} />
          <Route path="/control/:panel" element={<ControlCenterOverlay />} />
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
    ['/control/security', 'security-panel', 'Security'],
    ['/control/connections', 'connections-panel', 'Connections'],
    ['/control/portfolio-defaults', 'portfolio-defaults-panel', 'Portfolio defaults'],
    ['/control/notifications', 'notifications-panel', 'Notifications'],
    ['/control/api', 'api-panel', 'API keys'],
    ['/control/webhooks', 'webhooks-panel', 'Webhooks'],
    ['/control/delete-account', 'delete-account-panel', 'Delete account'],
  ])('%s deep-links its panel', (path, marker, label) => {
    renderAt(path);

    expect(within(popup()).getByText(marker)).toBeInTheDocument();
    expect(within(popup()).getByRole('link', { name: label, current: 'page' })).toBeVisible();
  });

  test('an unknown panel id falls back to the default panel instead of blanking', () => {
    renderAt('/control/nope');

    expect(within(popup()).getByText('account-panel')).toBeInTheDocument();
  });

  test('clicking a nav row switches the panel without leaving the popup', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.click(within(popup()).getByRole('link', { name: 'Security' }));

    expect(within(popup()).getByText('security-panel')).toBeInTheDocument();
    expect(within(popup()).queryByText('account-panel')).not.toBeInTheDocument();
    expect(within(popup()).getByRole('link', { name: 'Account' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  test('the filter narrows the panel nav as you type', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.type(within(popup()).getByRole('searchbox', { name: 'Filter panels' }), 'secu');

    expect(within(popup()).getByRole('link', { name: 'Security' })).toBeInTheDocument();
    expect(within(popup()).queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
    // Filtering never unmounts the active panel — only the nav narrows.
    expect(within(popup()).getByText('account-panel')).toBeInTheDocument();
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

  test('a nested modal owns Escape — the overlay stays open behind it', async () => {
    const user = userEvent.setup();
    renderAt('/control/privacy');

    expect(screen.getByRole('dialog', { name: 'Nested modal' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // The overlay ignored it (the inner dialog closes itself first).
    expect(screen.getByRole('dialog', { name: 'Control Center' })).toBeInTheDocument();
    expect(screen.queryByText('home-canvas')).not.toBeInTheDocument();
  });

  test('the scrim closes the popup', async () => {
    const user = userEvent.setup();
    renderAt('/control/account');

    await user.click(screen.getAllByRole('button', { name: 'Close' })[0]!);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('focus moves into the popup on open and returns to the opener on close', async () => {
    const user = userEvent.setup();
    renderAt('/');

    const opener = screen.getByRole('button', { name: 'opener' });
    await user.click(opener);

    expect(document.activeElement).toBe(popup());

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(opener);
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

  test('body scroll is locked while the popup owns the screen and released after', () => {
    const view = renderAt('/control/account');

    expect(document.body.style.overflow).toBe('hidden');

    view.unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
