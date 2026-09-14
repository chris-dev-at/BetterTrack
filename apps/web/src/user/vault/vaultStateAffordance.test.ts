import { describe, expect, it } from 'vitest';

import type { EndpointVaultState } from './keystore';
import {
  endpointVaultStateCase,
  VAULT_STATE_ACTION_KINDS,
  VAULT_STATE_AFFORDANCES,
  vaultStateAffordance,
  vaultStateOffersAction,
  vaultStateRetryAt,
  vaultStateTone,
} from './vaultStateAffordance';

const STATES: EndpointVaultState[] = [
  {
    status: 'stored+wrapped',
    session: 'locked',
    requiredAction: { kind: 'unlock', credential: 'device-password' },
  },
  {
    status: 'stored+wrapped',
    session: 'locked',
    requiredAction: {
      kind: 'wait-or-reset',
      retryAt: 1,
      alternative: 'reset-endpoint-keystore',
    },
  },
  {
    status: 'stored+wrapped',
    session: 'unlocked',
    requiredAction: { kind: 'open-silently' },
  },
  { status: 'stored+plain', requiredAction: { kind: 'open-silently' } },
  {
    status: 'not-on-this-endpoint',
    requiredAction: { kind: 'provide-phrase', methods: ['enter-words', 'scan-qr'] },
  },
  {
    status: 'endpoint-keystore-invalid',
    requiredAction: { kind: 'reset-endpoint-keystore' },
  },
];

describe('vault state affordances', () => {
  it('maps every E3 endpoint state to one concrete action', () => {
    expect(STATES.map(endpointVaultStateCase).sort()).toEqual(
      Object.keys(VAULT_STATE_AFFORDANCES).sort(),
    );
    for (const state of STATES) {
      expect(vaultStateAffordance(state)).toMatchObject({
        action: expect.any(String),
        labelKey: expect.stringMatching(/^vault\.manager\.action\./),
        stateKey: expect.stringMatching(/^vault\.manager\.state\./),
      });
    }
  });

  it('offers exactly the actions the state names, so a deep link can be reconciled', () => {
    const offered = STATES.map((state) =>
      VAULT_STATE_ACTION_KINDS.filter((action) => vaultStateOffersAction(state, action)),
    );

    expect(offered).toEqual([
      ['unlock'],
      // Locked out: the password form is withdrawn, only the reset remains.
      ['reset-endpoint'],
      ['open'],
      ['open'],
      // The one state with two: the row renders "Enter words" beside "Scan QR".
      ['provide-phrase', 'scan-qr'],
      ['reset-endpoint'],
    ]);
    // A hand-edited or stale `?action=` is never on offer by accident.
    expect(STATES.some((state) => vaultStateOffersAction(state, 'rotate'))).toBe(false);
  });

  it('carries the retry instant only for a live lockout', () => {
    expect(STATES.map(vaultStateRetryAt)).toEqual([null, 1, null, null, null, null]);
  });

  it('separates locked from locked-OUT by tone, since the copy cannot', () => {
    // Both states resolve to the same string — "Locked on this device" — so the
    // row badge's tone is the only thing that distinguishes "type your device
    // password" from "five wrong tries, wait". Assert the pairing directly.
    const [locked, lockedOut] = STATES;
    expect(vaultStateAffordance(locked!).stateKey).toBe(vaultStateAffordance(lockedOut!).stateKey);
    expect(STATES.map(vaultStateTone)).toEqual([
      'gold', // locked, password accepted
      'neg', // locked out, password withdrawn
      'pos', // unlocked
      'pos', // plain custody, open silently
      'blue', // words needed on this endpoint
      'neg', // endpoint keystore invalid
    ]);
  });
});
