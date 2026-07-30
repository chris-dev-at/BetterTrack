import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParanoidEnableResponse, ParanoidMediaStateResponse } from '@bettertrack/contracts';

vi.mock('../../lib/userApi', () => ({
  getParanoidMediaState: vi.fn(),
}));

import { usePrivacyMode, vaultMediaQueryKey } from './usePrivacyMode';

const ACCOUNT_A = '018f0000-0000-7000-8000-000000000001';
const ACCOUNT_B = '018f0000-0000-7000-8000-000000000002';
const NORMAL: ParanoidMediaStateResponse = { privacyMode: 'normal', mediaState: null };
const ENABLED: ParanoidEnableResponse = {
  mode: 'paranoid',
  mediaSet: ['server'],
  vaultVersion: 4,
  completedAt: '2026-07-30T10:00:00.000Z',
  idempotent: false,
};

function harness(client: QueryClient) {
  return function Harness({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('usePrivacyMode', () => {
  it('accepts a committed mode receipt without changing another account cache', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(vaultMediaQueryKey(ACCOUNT_B), NORMAL);
    const { result } = renderHook(() => usePrivacyMode(false, ACCOUNT_A), {
      wrapper: harness(client),
    });

    act(() => result.current.acceptEnabled(ENABLED));

    expect(client.getQueryData(vaultMediaQueryKey(ACCOUNT_A))).toMatchObject({
      privacyMode: 'paranoid',
      mediaState: { mediaSet: ['server'] },
    });
    expect(client.getQueryData(vaultMediaQueryKey(ACCOUNT_B))).toEqual(NORMAL);
    expect(localStorage.getItem(`bettertrack:vault-mode:${ACCOUNT_A}`)).toContain(
      '"privacyMode":"paranoid"',
    );
    expect(localStorage.getItem(`bettertrack:vault-mode:${ACCOUNT_B}`)).toBeNull();
  });

  it('fails closed from only the matching account offline marker', () => {
    localStorage.setItem(
      `bettertrack:vault-mode:${ACCOUNT_A}`,
      JSON.stringify({
        privacyMode: 'paranoid',
        mediaState: {
          mediaSet: ['server'],
          driveAttestedVersion: null,
          server: { disposition: 'active', candidate: null, retired: null },
        },
      }),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const accountA = renderHook(() => usePrivacyMode(false, ACCOUNT_A), {
      wrapper: harness(client),
    });
    const accountB = renderHook(() => usePrivacyMode(false, ACCOUNT_B), {
      wrapper: harness(client),
    });

    expect(accountA.result.current.privacyMode).toBe('paranoid');
    expect(accountB.result.current.privacyMode).toBeNull();
  });
});
