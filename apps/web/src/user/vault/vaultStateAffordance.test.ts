import { describe, expect, it } from 'vitest';

import type { EndpointVaultState } from './keystore';
import {
  endpointVaultStateCase,
  VAULT_STATE_AFFORDANCES,
  vaultStateAffordance,
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
});
