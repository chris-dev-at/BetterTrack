import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse } from '@bettertrack/contracts';

/**
 * #2026 — the §6.1 sibling of #2000, end to end through the REAL api client:
 * turning the authenticator method off asks for a TOTP or recovery code, and
 * the server refuses a wrong one with a GENERIC `401` (`disableTotp`,
 * `apps/api/src/services/auth/twoFactorService.ts:472`). Under the app-wide auth
 * policy that 401 is indistinguishable from an expired session, so a typo used
 * to tear the session down and bounce the owner to `/login` mid-dialog.
 *
 * Nothing between the dialog and `fetch` is mocked, on purpose: `SignInPanel`,
 * `twoFactorApi` and `apiRequest`'s response policy are all real, because the
 * wire is exactly where the bug lives. `SignInPanel.test.tsx` mocks
 * `twoFactorApi` (rightly, for its own concerns) and therefore cannot see this
 * class of bug at all — it would keep passing with the suppression removed.
 * Only the WebAuthn seam is stubbed; it decides no auth policy.
 */
vi.mock('../../../lib/passkeys', () => ({
  browserSupportsWebAuthn: () => false,
  isPasskeyCancellation: () => false,
  registerPasskey: vi.fn(),
}));

import { setAuthResponsePolicy } from '../../../lib/apiClient';
import { SignInPanel } from './SignInPanel';

const ME: MeResponse = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'ada@example.com',
  username: 'ada',
  role: 'user',
  status: 'active',
  mustChangePassword: false,
  pinEnabled: false,
  pinLockIdleMinutes: null,
  baseCurrency: 'EUR',
  locale: 'en',
  lastLoginAt: '2026-07-01T10:00:00.000Z',
  createdAt: '2026-01-15T09:00:00.000Z',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * The refusal `POST /auth/2fa/disable` actually sends on a mistyped factor:
 * `401 TWO_FACTOR_INVALID_CODE`, generic about WHICH factor was wrong.
 */
function refusedCode(): Response {
  return json(
    { error: { code: 'TWO_FACTOR_INVALID_CODE', message: 'That two-factor code is incorrect.' } },
    401,
  );
}

/** The throttle the same endpoint trips after repeated wrong codes. */
function throttled(): Response {
  return json(
    {
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many incorrect codes. Please wait and try again.',
        details: { retryAfter: 30 },
      },
    },
    429,
    { 'Retry-After': '30' },
  );
}

/** A GENUINELY expired session: no credential was offered, the cookie is dead. */
function sessionExpired(): Response {
  return json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } }, 401);
}

/** The reads `SignInPanel` needs before the two-factor group is interactive. */
function panelReads(totpEnabled: boolean, recoveryCodesRemaining: number) {
  return {
    'GET /api/v1/auth/me': () => json(ME),
    'GET /api/v1/auth/passkeys': () => json({ passkeys: [] }),
    'GET /api/v1/auth/2fa/status': () =>
      json({
        totpEnabled,
        totpPending: false,
        emailEnabled: false,
        recoveryCodesRemaining,
      }),
  };
}

/** One routing stub, so each case declares only the refusal it is about. */
function stubApi(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const key = `${init.method ?? 'GET'} ${url.split('?')[0]}`;
    const route = routes[key];
    if (!route) return Promise.reject(new Error(`unrouted request: ${key}`));
    return Promise.resolve(route());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Every hook the app-wide policy owns; a gated refusal may fire NONE of them. */
function installAuthPolicy() {
  const policy = {
    onUnauthorized: vi.fn(),
    onPasswordChangeRequired: vi.fn(),
    onRateLimited: vi.fn(),
  };
  const dispose = setAuthResponsePolicy(policy);
  return { policy, dispose };
}

function expectSessionIntact(policy: ReturnType<typeof installAuthPolicy>['policy']) {
  expect(policy.onUnauthorized).not.toHaveBeenCalled();
  expect(policy.onPasswordChangeRequired).not.toHaveBeenCalled();
  expect(policy.onRateLimited).not.toHaveBeenCalled();
}

let seenPath = '';

function LocationProbe() {
  seenPath = useLocation().pathname;
  return null;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/control/sign-in']}>
        <LocationProbe />
        <SignInPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Open the authenticator row's disable form and submit `code`. */
async function submitDisableCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  await user.click(await screen.findByRole('button', { name: 'Turn off' }));
  await user.type(screen.getByLabelText(/authenticator code or recovery code/i), code);
  await user.click(screen.getByRole('button', { name: 'Turn off authenticator app' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  seenPath = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a wrong §6.1 two-factor credential never logs the user out', () => {
  it('disable 2FA: the refusal stays in the dialog, the session and the route are untouched', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      const fetchMock = stubApi({
        ...panelReads(true, 5),
        'POST /api/v1/auth/2fa/disable': refusedCode,
      });
      const user = userEvent.setup();
      renderPanel();

      await submitDisableCode(user, '000000');

      expect(await screen.findByText('That two-factor code is incorrect.')).toBeInTheDocument();
      // The form is still standing, with the field the owner can correct — not a
      // login screen.
      expect(screen.getByLabelText(/authenticator code or recovery code/i)).toBeInTheDocument();
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/2fa/disable')),
      ).toHaveLength(1);
      expect(seenPath).toBe('/control/sign-in');
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('disable 2FA: the wrong-code throttle is shown in the form, not as a global toast', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({
        ...panelReads(true, 5),
        'POST /api/v1/auth/2fa/disable': throttled,
      });
      const user = userEvent.setup();
      renderPanel();

      await submitDisableCode(user, '000000');

      // Opting out of the policy silences the app-wide "too fast" toast for this
      // call as well, so the dialog owns the message — and does show it.
      expect(
        await screen.findByText('Too many incorrect codes. Please wait and try again.'),
      ).toBeInTheDocument();
      expectSessionIntact(policy);
    } finally {
      dispose();
    }
  });

  it('regenerate recovery codes: a credential-free call still bounces on a real 401', async () => {
    const { policy, dispose } = installAuthPolicy();
    try {
      stubApi({
        ...panelReads(true, 3),
        'POST /api/v1/auth/2fa/recovery-codes': sessionExpired,
      });
      const user = userEvent.setup();
      renderPanel();

      await user.click(await screen.findByRole('button', { name: 'Regenerate recovery codes' }));

      // Precision: nothing was typed, so a 401 here can only mean the session is
      // gone. Suppressing this one would strand the user in a dead session.
      await waitFor(() => expect(policy.onUnauthorized).toHaveBeenCalledTimes(1));
    } finally {
      dispose();
    }
  });
});
