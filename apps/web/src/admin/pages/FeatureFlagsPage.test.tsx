import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  AdminFeatureFlag,
  AdminFeatureFlagsResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { I18nProvider, localizedMessage } from '../../i18n';
import { AuthProvider } from '../AuthContext';
import { FeatureFlagsPage } from './FeatureFlagsPage';

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

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const flag = (
  key: AdminFeatureFlag['key'],
  enabled: boolean,
  rollout: Partial<Pick<AdminFeatureFlag, 'rolloutPercent' | 'allowUserIds' | 'denyUserIds'>> = {},
): AdminFeatureFlag => ({
  key,
  enabled,
  rolloutPercent: rollout.rolloutPercent ?? 100,
  allowUserIds: rollout.allowUserIds ?? [],
  denyUserIds: rollout.denyUserIds ?? [],
  description: `${key} desc`,
  updatedAt: null,
  updatedBy: null,
});

const list: AdminFeatureFlagsResponse = {
  flags: [
    flag('realtime', true),
    flag('liveMode', true),
    flag('chat', true),
    flag('alerts', true),
    flag('imports', true),
    flag('ai', true),
  ],
};

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter initialEntries={['/admin/feature-flags']}>
        <AuthProvider>
          <FeatureFlagsPage />
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

/**
 * The panel a given flag owns, found by its localized name.
 *
 * Queried as a HEADING, not as text: the page carries the Product & Comms tab
 * strip since the W7c fold (#1406), and one of its tabs — "AI" — has the same
 * text as a flag name. A heading query cannot match a strip link, so the page's
 * own structure disambiguates instead of a brittle index.
 */
function panelFor(name: string): HTMLElement {
  return flagHeading(name).closest('section')!;
}

function flagHeading(name: string): HTMLElement {
  return screen.getByRole('heading', { name, level: 2 });
}

beforeEach(() => {
  // Call history only (implementations survive): several tests below assert that
  // a control did NOT write, and a leaked call from the previous test would make
  // those assertions lie in the direction that hides a bug.
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
  vi.mocked(api.getFeatureFlags).mockResolvedValue(list);
});

test('lists every localized flag with its On state', async () => {
  renderPage();

  await waitFor(() => expect(flagHeading('Chat')).toBeInTheDocument());
  expect(flagHeading('Realtime')).toBeInTheDocument();
  expect(flagHeading('Live Mode')).toBeInTheDocument();
  expect(flagHeading('Price alerts')).toBeInTheDocument();
  expect(flagHeading('Imports')).toBeInTheDocument();
  // "AI" is also a Product & Comms TAB since the fold — the heading query is
  // what keeps this assertion about the flag.
  expect(flagHeading('AI')).toBeInTheDocument();
  expect(screen.getAllByText('On').length).toBe(6);
});

test('toggling a flag OFF calls the API with the flipped value', async () => {
  const user = userEvent.setup();
  vi.mocked(api.setFeatureFlag).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, enabled: false } : f)),
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  await user.click(within(panelFor('Chat')).getByRole('button', { name: 'Disable' }));

  // The kill switch patches ONLY `enabled` — it must not carry a rollout along
  // and silently rewrite targeting the operator never touched.
  await waitFor(() => expect(api.setFeatureFlag).toHaveBeenCalledWith('chat', { enabled: false }));
});

test('shows an error state when the fetch fails', async () => {
  vi.mocked(api.getFeatureFlags).mockRejectedValue(new Error('boom'));
  renderPage();

  await waitFor(() =>
    expect(screen.getByText('Could not load feature flags.')).toBeInTheDocument(),
  );
});

/**
 * The state badge has to be HONEST: "On" is the claim that every account has the
 * feature, and a 25 % rollout is not that. An operator reading this page after a
 * partial rollout must be able to tell the two apart at a glance.
 */
test('the state badge reads honestly for off, partial and allowlisted flags', async () => {
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: [
      flag('realtime', true),
      flag('liveMode', false),
      flag('chat', true, { rolloutPercent: 25 }),
      flag('alerts', true, { rolloutPercent: 0, allowUserIds: [ALICE, BOB] }),
      flag('imports', true, { rolloutPercent: 0, allowUserIds: [ALICE] }),
      flag('ai', true, { rolloutPercent: 50, allowUserIds: [ALICE] }),
    ],
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  expect(within(panelFor('Realtime')).getByText('On')).toBeInTheDocument();
  expect(within(panelFor('Live Mode')).getByText('Off')).toBeInTheDocument();
  expect(within(panelFor('Chat')).getByText('On for 25 %')).toBeInTheDocument();
  expect(within(panelFor('Price alerts')).getByText('On for 2 accounts')).toBeInTheDocument();
  // Singular, not "1 accounts": `t()` does plain substitution, so the catalog
  // carries the one/other pair and the page picks between them.
  expect(within(panelFor('Imports')).getByText('On for 1 account')).toBeInTheDocument();
  expect(within(panelFor('AI')).getByText('On for 50 % + 1 account')).toBeInTheDocument();
  // A killed flag says so about its own rollout rather than leaving an operator
  // to discover it by saving a rollout that changes nothing.
  expect(
    within(panelFor('Live Mode')).getByText(
      localizedMessage('en', 'admin.featureFlags.killedNote'),
    ),
  ).toBeInTheDocument();
});

test('the rollout round-trips through an EXPLICIT save, never as a side effect of typing', async () => {
  const user = userEvent.setup();
  vi.mocked(api.setFeatureFlag).mockResolvedValue({
    flags: list.flags.map((f) =>
      f.key === 'chat' ? { ...f, rolloutPercent: 25, allowUserIds: [ALICE] } : f,
    ),
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  const percent = within(chat).getByLabelText('Rollout %');
  await user.clear(percent);
  await user.type(percent, '25');
  await user.type(within(chat).getByLabelText('Always on for'), ALICE);

  // Typing has changed nothing on the server: a kill switch must never move as
  // a side effect of editing a field next to it.
  expect(api.setFeatureFlag).not.toHaveBeenCalled();
  expect(within(chat).getByText('Unsaved changes')).toBeInTheDocument();

  await user.click(within(chat).getByRole('button', { name: 'Save rollout' }));

  await waitFor(() =>
    expect(api.setFeatureFlag).toHaveBeenCalledWith('chat', {
      rolloutPercent: 25,
      allowUserIds: [ALICE],
      denyUserIds: [],
    }),
  );
  // The saved state comes back from the server, so the badge is not optimistic.
  expect(await within(panelFor('Chat')).findByText('On for 25 % + 1 account')).toBeInTheDocument();
});

test('refuses a malformed rollout locally — the write never leaves the browser', async () => {
  const user = userEvent.setup();
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  await user.type(within(chat).getByLabelText('Always on for'), 'not-a-uuid');
  await user.click(within(chat).getByRole('button', { name: 'Save rollout' }));

  expect(
    await within(chat).findByText(localizedMessage('en', 'admin.featureFlags.idError')),
  ).toBeInTheDocument();
  expect(api.setFeatureFlag).not.toHaveBeenCalled();
});

test('discarding restores the stored rollout and re-disables the save', async () => {
  const user = userEvent.setup();
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  const percent = within(chat).getByLabelText('Rollout %');
  expect(within(chat).getByRole('button', { name: 'Save rollout' })).toBeDisabled();

  await user.clear(percent);
  await user.type(percent, '10');
  expect(within(chat).getByRole('button', { name: 'Save rollout' })).toBeEnabled();

  await user.click(within(chat).getByRole('button', { name: 'Discard changes' }));
  expect(percent).toHaveValue(100);
  expect(within(chat).getByRole('button', { name: 'Save rollout' })).toBeDisabled();
  expect(api.setFeatureFlag).not.toHaveBeenCalled();
});

test('renders German chrome for every new control', async () => {
  renderPage('de');

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  for (const key of [
    'admin.featureFlags.rolloutHeading',
    'admin.featureFlags.percentLabel',
    'admin.featureFlags.allowLabel',
    'admin.featureFlags.denyLabel',
    'admin.featureFlags.saveRollout',
    'admin.featureFlags.resetRollout',
  ] as const) {
    expect(within(chat).getByText(localizedMessage('de', key))).toBeInTheDocument();
  }
});

/**
 * The console's token layer (#1406 W2). A page that hand-rolls `rounded-md
 * border border-neutral-800` is a page that drifts away from the language the
 * rest of the console speaks — the exact drift `tokens.ts` warns about.
 */
test('paints no rounded corner anywhere on the page', async () => {
  const { container } = renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const rounded = container.querySelectorAll('[class*="rounded-"]:not([class*="rounded-none"])');
  expect([...rounded].map((el) => el.className)).toEqual([]);
});

/**
 * The page IS a tab of the Product & Comms workspace since the W7c fold (#1406),
 * and this is what makes that true of the PAGE rather than only of the strip
 * component. `WorkspaceTabs.test.tsx` renders the strip on its own and
 * `AdminLayout.test.tsx` mounts route stubs, so without an assertion here
 * deleting `<WorkspaceTabs />` from this component left the whole suite green.
 */
test('renders the Product & Comms tab strip with this page as the current tab', async () => {
  renderPage();

  const nav = await screen.findByRole('navigation', { name: 'Product & Comms' });
  expect(within(nav).getByRole('link', { name: 'Feature flags' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
