import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParanoidDisableRequest } from '@bettertrack/contracts';

const api = vi.hoisted(() => ({
  disableParanoidMode: vi.fn(async (_body: unknown) => ({
    mode: 'normal' as const,
    rehydrationId: '018f0000-0000-7000-8000-0000000000aa',
    completedAt: '2026-07-30T10:00:00.000Z',
    idempotent: false,
    postCommit: { invalidate: [] as never[] },
  })),
}));

vi.mock('../../../lib/userApi', () => api);

import { discardLockedVault } from './disable';

const ACCOUNT_ID = '018f0000-0000-7000-8000-0000000000ab';
const CREDENTIAL = { confirmUsername: 'ada', password: 'hunter2hunter2' };

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage?.clear();
});

describe('discardLockedVault', () => {
  it('restores nothing and says so explicitly — the locked client has no rows to hand back (§3)', async () => {
    await discardLockedVault(ACCOUNT_ID, CREDENTIAL);

    expect(api.disableParanoidMode).toHaveBeenCalledTimes(1);
    const body = api.disableParanoidMode.mock.calls[0]![0] as ParanoidDisableRequest;
    expect(body.document).toEqual({ schemaVersion: 1, entities: [], mergeLog: [] });
    // The flag is what authorizes destruction; an empty graph alone is refused
    // server-side precisely so a lost-rows bug cannot wipe an account.
    expect(body.discard).toBe(true);
    expect(body.confirm).toBe(true);
    expect(body.rehydrationId).toMatch(/^[0-9a-f-]{36}$/i);
    // The account-deletion rung travels with it: the server re-verifies both
    // halves, so a caller that skips them is refused before anything is wiped.
    expect(body.confirmUsername).toBe('ada');
    expect(body.password).toBe('hunter2hunter2');
  });

  it('reuses an interrupted rehydration id so the server can answer idempotently', async () => {
    const key = `bettertrack:vault-rehydration:${ACCOUNT_ID}`;
    const interrupted = '018f0000-0000-7000-8000-0000000000ac';
    globalThis.sessionStorage.setItem(key, interrupted);

    await discardLockedVault(ACCOUNT_ID, CREDENTIAL);

    const body = api.disableParanoidMode.mock.calls[0]![0] as ParanoidDisableRequest;
    expect(body.rehydrationId).toBe(interrupted);
    // The completed transition releases the marker.
    expect(globalThis.sessionStorage.getItem(key)).toBeNull();
  });

  it('keeps the retry marker when the transition fails', async () => {
    api.disableParanoidMode.mockRejectedValueOnce(new Error('offline'));

    await expect(discardLockedVault(ACCOUNT_ID, CREDENTIAL)).rejects.toThrow('offline');
    expect(
      globalThis.sessionStorage.getItem(`bettertrack:vault-rehydration:${ACCOUNT_ID}`),
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
