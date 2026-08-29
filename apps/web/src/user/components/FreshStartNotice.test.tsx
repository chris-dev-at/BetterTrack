import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';

/**
 * The §17 fresh-start notice (PARANOID E9) — `docs/paranoid-design.md` §17 step 3.
 *
 * The negative cases carry the weight here. This banner tells a user their data
 * was retired; showing it to the wrong account, or on a stale/unknown flag, is
 * the failure that matters, so "false" and "undefined" are asserted separately
 * rather than folded into one truthiness check.
 */

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn(async () => undefined),
  pending: undefined as boolean | undefined,
}));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', paranoidFreshStartPending: mocks.pending },
    acknowledgeFreshStartNotice: mocks.acknowledge,
  }),
}));

const { FreshStartNotice } = await import('./FreshStartNotice');

function renderNotice() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <FreshStartNotice />
      </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.acknowledge.mockClear();
  mocks.pending = undefined;
});

test('shows the notice, the create-a-vault CTA and no passphrase prompt when it is owed', async () => {
  mocks.pending = true;
  renderNotice();

  const notice = screen.getByTestId('paranoid-fresh-start-notice');
  expect(notice).toBeInTheDocument();
  // §17 step 3: the CTA is "create a vault", pointing at the per-portfolio model.
  expect(screen.getByRole('link')).toHaveAttribute('href', '/control/privacy');
  // "No conversion ceremony, no legacy passphrase prompt."
  expect(notice.textContent ?? '').not.toMatch(/passphrase/iu);
});

test('renders nothing for an account the transition never touched', () => {
  mocks.pending = false;
  renderNotice();
  expect(screen.queryByTestId('paranoid-fresh-start-notice')).toBeNull();
});

test('renders nothing when the server did not send the flag at all', () => {
  // `undefined` is an older server, which the contract says to read as "unknown".
  // Guessing "owed" here would announce a retirement that never happened.
  mocks.pending = undefined;
  renderNotice();
  expect(screen.queryByTestId('paranoid-fresh-start-notice')).toBeNull();
});

test('dismissing acknowledges through the auth action exactly once', async () => {
  mocks.pending = true;
  renderNotice();

  await userEvent.click(screen.getByRole('button'));

  expect(mocks.acknowledge).toHaveBeenCalledTimes(1);
});
