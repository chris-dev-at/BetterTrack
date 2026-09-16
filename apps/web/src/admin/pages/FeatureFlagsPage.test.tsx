import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import {
  FEATURE_FLAG_CONFIG_CHANGED,
  FEATURE_FLAG_CONFIG_UNREADABLE,
} from '@bettertrack/contracts';
import type {
  AdminFeatureFlag,
  AdminFeatureFlagsResponse,
  MeResponse,
} from '@bettertrack/contracts';

vi.mock('../../lib/adminApi');
import * as api from '../../lib/adminApi';
import { ApiError } from '../../lib/apiClient';
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
  rollout: Partial<
    Pick<AdminFeatureFlag, 'rolloutPercent' | 'allowUserIds' | 'denyUserIds' | 'stored'>
  > = {},
): AdminFeatureFlag => ({
  key,
  enabled,
  rolloutPercent: rollout.rolloutPercent ?? 100,
  allowUserIds: rollout.allowUserIds ?? [],
  denyUserIds: rollout.denyUserIds ?? [],
  // A healthy row unless a test says otherwise — the default has to be the
  // state that wears NO badge, so a fixture that forgets to say cannot make the
  // degraded-row assertions below pass for the wrong reason.
  stored: rollout.stored ?? 'parsed',
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

/**
 * A degraded row has to LOOK degraded (#1950).
 *
 * #1946 made the read honest — a row whose stored configuration cannot be parsed
 * no longer reports an invented healthy one — but the console still drew it
 * exactly like a clean row. The rollout an operator saw was the default the app
 * falls back to, not what is on disk, and the only way to find that out was to
 * attempt a write and collect a 409.
 */
test('marks the rows whose stored configuration could not be read, and only those', async () => {
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: [
      flag('realtime', true),
      flag('liveMode', true, { stored: 'parsed' }),
      flag('chat', true, { stored: 'salvaged' }),
      flag('alerts', true),
      flag('imports', true, { stored: 'unreadable' }),
      flag('ai', true),
    ],
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const salvaged = localizedMessage('en', 'admin.featureFlags.stored.salvagedBadge');
  const unreadable = localizedMessage('en', 'admin.featureFlags.stored.unreadableBadge');

  // The two degradations are told apart: a salvaged row still has a trustworthy
  // kill switch, an unreadable one has nothing.
  expect(within(panelFor('Chat')).getByText(salvaged)).toBeInTheDocument();
  expect(
    within(panelFor('Chat')).getByText(
      localizedMessage('en', 'admin.featureFlags.stored.salvagedNote'),
    ),
  ).toBeInTheDocument();
  expect(within(panelFor('Imports')).getByText(unreadable)).toBeInTheDocument();
  expect(
    within(panelFor('Imports')).getByText(
      localizedMessage('en', 'admin.featureFlags.stored.unreadableNote'),
    ),
  ).toBeInTheDocument();

  // Negative space: a healthy row wears no badge at all. Without this the test
  // would pass just as happily if the badge were rendered on every row.
  for (const name of ['Realtime', 'Live Mode', 'Price alerts', 'AI']) {
    expect(within(panelFor(name)).queryByText(salvaged)).toBeNull();
    expect(within(panelFor(name)).queryByText(unreadable)).toBeNull();
  }
  expect(screen.getAllByText(salvaged).length).toBe(1);
  expect(screen.getAllByText(unreadable).length).toBe(1);
});

/**
 * The repair path. On a degraded row the server refuses anything partial, so
 * Save has to send the WHOLE configuration — and it has to be reachable without
 * first making a pointless edit, because the operator's intent is "replace what
 * is on disk with what this panel shows", not "change something".
 */
test('Save on a degraded row sends the COMPLETE four-field configuration, untouched form included', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: list.flags.map((f) =>
      f.key === 'chat' ? { ...f, enabled: false, stored: 'salvaged' as const } : f,
    ),
  });
  vi.mocked(api.setFeatureFlag).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, enabled: false } : f)),
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  const save = within(chat).getByRole('button', { name: 'Save rollout' });
  // Nothing has been edited: on a healthy row this button is disabled, and it
  // must not be here — the stored row differs from what is displayed, so saving
  // it unchanged is a real write.
  expect(save).toBeEnabled();
  await user.click(save);

  await waitFor(() =>
    expect(api.setFeatureFlag).toHaveBeenCalledWith('chat', {
      // `enabled` rides along ONLY because the row is degraded. It carries the
      // value the console is showing, so the replacement states the switch
      // rather than letting the server inherit it from a row it cannot read.
      enabled: false,
      // …and `repair` states WHICH degraded row it is replacing, so this body
      // cannot land on a row somebody else has already fixed. Exact match, so a
      // Save that forgot the precondition fails here.
      repair: 'salvaged',
      rolloutPercent: 100,
      allowUserIds: [],
      denyUserIds: [],
    }),
  );
});

/**
 * The stale tab (#1950 M1). The list is fetched on mount, so this view can be
 * arbitrarily old; the server refuses the replacement it offers once the row has
 * moved, and the operator has to be told to refresh rather than left looking at
 * a page that still claims the row is broken.
 */
test('a repair the server says is out of date tells the operator to refresh', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, stored: 'salvaged' as const } : f)),
  });
  vi.mocked(api.setFeatureFlag).mockRejectedValue(
    new ApiError(409, FEATURE_FLAG_CONFIG_CHANGED, 'envelope', { stored: 'parsed' }),
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  await user.click(within(panelFor('Chat')).getByRole('button', { name: 'Save rollout' }));

  expect(
    await screen.findByText(localizedMessage('en', 'admin.featureFlags.stored.changedError')),
  ).toBeInTheDocument();
  // Not the repair instruction: sending the same body again is exactly what must
  // not be suggested here.
  expect(
    screen.queryByText(localizedMessage('en', 'admin.featureFlags.stored.conflictError')),
  ).toBeNull();
});

/**
 * The clobber the PATCH-merge design exists to avoid: two operators, one widening
 * a rollout and one flipping the switch. A healthy row must therefore keep
 * sending the three targeting fields and NOTHING else — `toHaveBeenCalledWith`
 * is exact, so a stray `enabled` fails here.
 */
test('Save on a healthy row still sends a PARTIAL patch — no `enabled` tagging along', async () => {
  const user = userEvent.setup();
  vi.mocked(api.setFeatureFlag).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, rolloutPercent: 40 } : f)),
  });
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  const percent = within(chat).getByLabelText('Rollout %');
  await user.clear(percent);
  await user.type(percent, '40');
  await user.click(within(chat).getByRole('button', { name: 'Save rollout' }));

  await waitFor(() =>
    expect(api.setFeatureFlag).toHaveBeenCalledWith('chat', {
      rolloutPercent: 40,
      allowUserIds: [],
      denyUserIds: [],
    }),
  );
});

/**
 * The kill switch deliberately stays a one-field patch even on a degraded row —
 * making it send all four would reintroduce exactly the clobber above, and it is
 * the control an operator reaches for mid-incident. What it owes the operator is
 * an honest refusal: the server's 409 envelope is English-only by policy, so the
 * console maps the CODE to catalog copy that names the repair.
 */
test('the kill switch still patches only `enabled`, and its 409 names the repair', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, stored: 'unreadable' as const } : f)),
  });
  vi.mocked(api.setFeatureFlag).mockRejectedValue(
    new ApiError(
      409,
      FEATURE_FLAG_CONFIG_UNREADABLE,
      "The stored configuration for 'chat' cannot be read, so a partial change would have to invent the fields it does not set.",
      { stored: 'unreadable' },
    ),
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  await user.click(within(panelFor('Chat')).getByRole('button', { name: 'Disable' }));

  await waitFor(() => expect(api.setFeatureFlag).toHaveBeenCalledWith('chat', { enabled: false }));
  expect(
    await screen.findByText(localizedMessage('en', 'admin.featureFlags.stored.conflictError')),
  ).toBeInTheDocument();
  // The generic banner would leave the operator with "could not update" and no
  // way forward — that is the bug, so assert it is NOT what is rendered.
  expect(screen.queryByText(localizedMessage('en', 'admin.featureFlags.actionError'))).toBeNull();
});

/** A 409 is not an expired admin session: the console must stay usable. */
test('a conflict leaves the console signed in and the row still operable', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, stored: 'unreadable' as const } : f)),
  });
  vi.mocked(api.setFeatureFlag).mockRejectedValue(
    new ApiError(409, FEATURE_FLAG_CONFIG_UNREADABLE, 'envelope', { stored: 'unreadable' }),
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  await user.click(within(panelFor('Chat')).getByRole('button', { name: 'Disable' }));

  expect(
    await screen.findByText(localizedMessage('en', 'admin.featureFlags.stored.conflictError')),
  ).toBeInTheDocument();
  expect(within(panelFor('Chat')).getByRole('button', { name: 'Disable' })).toBeEnabled();
});

/**
 * A SALVAGED row keeps a kill switch that was genuinely read, so telling the
 * operator the whole configuration is unreadable overstates the damage and
 * contradicts the badge on the same row. The server says which half it refused
 * on; the banner follows it.
 */
test('names the ROLLOUT, not the whole configuration, when only that was unreadable', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, stored: 'salvaged' as const } : f)),
  });
  vi.mocked(api.setFeatureFlag).mockRejectedValue(
    new ApiError(409, FEATURE_FLAG_CONFIG_UNREADABLE, 'envelope', { stored: 'salvaged' }),
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  await user.click(within(panelFor('Chat')).getByRole('button', { name: 'Disable' }));

  expect(
    await screen.findByText(
      localizedMessage('en', 'admin.featureFlags.stored.conflictErrorSalvaged'),
    ),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(localizedMessage('en', 'admin.featureFlags.stored.conflictError')),
  ).toBeNull();
});

/**
 * Negative space for the mapping (#1950 L1). A 409 nobody has written copy for
 * must NOT inherit the repair instruction of the conflict that happens to share
 * its status — on an operator surface, confidently wrong beats nothing only in
 * the wrong direction.
 */
test('falls back to the generic banner for a 409 code nobody mapped', async () => {
  const user = userEvent.setup();
  vi.mocked(api.setFeatureFlag).mockRejectedValue(
    new ApiError(409, 'SOME_OTHER_CONFLICT', 'envelope'),
  );
  renderPage();

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  await user.click(within(panelFor('Chat')).getByRole('button', { name: 'Disable' }));

  expect(
    await screen.findByText(localizedMessage('en', 'admin.featureFlags.actionError')),
  ).toBeInTheDocument();
  for (const key of [
    'admin.featureFlags.stored.conflictError',
    'admin.featureFlags.stored.conflictErrorSalvaged',
    'admin.featureFlags.stored.changedError',
  ] as const) {
    expect(screen.queryByText(localizedMessage('en', key))).toBeNull();
  }
});

/** EN/DE parity for every string this wave adds. */
test('renders the degraded-row chrome in German too', async () => {
  const user = userEvent.setup();
  vi.mocked(api.getFeatureFlags).mockResolvedValue({
    flags: list.flags.map((f) => (f.key === 'chat' ? { ...f, stored: 'salvaged' as const } : f)),
  });
  vi.mocked(api.setFeatureFlag).mockRejectedValue(
    new ApiError(409, FEATURE_FLAG_CONFIG_UNREADABLE, 'envelope', { stored: 'salvaged' }),
  );
  renderPage('de');

  await waitFor(() => expect(screen.getByText('Chat')).toBeInTheDocument());
  const chat = panelFor('Chat');
  for (const key of [
    'admin.featureFlags.stored.salvagedBadge',
    'admin.featureFlags.stored.salvagedNote',
  ] as const) {
    expect(within(chat).getByText(localizedMessage('de', key))).toBeInTheDocument();
  }

  await user.click(
    within(chat).getByRole('button', {
      name: localizedMessage('de', 'admin.featureFlags.disable'),
    }),
  );
  expect(
    await screen.findByText(
      localizedMessage('de', 'admin.featureFlags.stored.conflictErrorSalvaged'),
    ),
  ).toBeInTheDocument();
});
