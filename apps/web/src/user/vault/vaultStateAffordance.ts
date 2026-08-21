import type { EndpointVaultState } from './keystore';

type StateCase<State extends EndpointVaultState> = State extends {
  status: 'stored+wrapped';
}
  ? `${State['status']}:${State['session']}:${State['requiredAction']['kind']}`
  : `${State['status']}:${State['requiredAction']['kind']}`;

export type EndpointVaultStateCase = StateCase<EndpointVaultState>;

export type VaultStateActionKind =
  | 'unlock'
  | 'open'
  | 'provide-phrase'
  | 'scan-qr'
  | 'reset-endpoint';

export interface VaultStateAffordance {
  action: VaultStateActionKind;
  labelKey: string;
  stateKey: string;
}

/**
 * A total map over E3's state union. Because the keys are derived from that
 * union, adding a state/action in E3 without an E8 affordance is a type error.
 */
export const VAULT_STATE_AFFORDANCES = {
  'stored+wrapped:locked:unlock': {
    action: 'unlock',
    labelKey: 'vault.manager.action.unlock',
    stateKey: 'vault.manager.state.locked',
  },
  'stored+wrapped:locked:wait-or-reset': {
    action: 'reset-endpoint',
    labelKey: 'vault.manager.action.resetEndpoint',
    stateKey: 'vault.manager.state.locked',
  },
  'stored+wrapped:unlocked:open-silently': {
    action: 'open',
    labelKey: 'vault.manager.action.open',
    stateKey: 'vault.manager.state.ready',
  },
  'stored+plain:open-silently': {
    action: 'open',
    labelKey: 'vault.manager.action.open',
    stateKey: 'vault.manager.state.ready',
  },
  'not-on-this-endpoint:provide-phrase': {
    action: 'provide-phrase',
    labelKey: 'vault.manager.action.providePhrase',
    stateKey: 'vault.manager.state.notOnEndpoint',
  },
  'endpoint-keystore-invalid:reset-endpoint-keystore': {
    action: 'reset-endpoint',
    labelKey: 'vault.manager.action.resetEndpoint',
    stateKey: 'vault.manager.state.invalidEndpoint',
  },
} as const satisfies Record<EndpointVaultStateCase, VaultStateAffordance>;

export function endpointVaultStateCase(state: EndpointVaultState): EndpointVaultStateCase {
  if (state.status === 'stored+wrapped') {
    if (state.session === 'unlocked') return 'stored+wrapped:unlocked:open-silently';
    return state.requiredAction.kind === 'unlock'
      ? 'stored+wrapped:locked:unlock'
      : 'stored+wrapped:locked:wait-or-reset';
  }
  if (state.status === 'stored+plain') return 'stored+plain:open-silently';
  if (state.status === 'not-on-this-endpoint') {
    return 'not-on-this-endpoint:provide-phrase';
  }
  return 'endpoint-keystore-invalid:reset-endpoint-keystore';
}

export function vaultStateAffordance(state: EndpointVaultState): VaultStateAffordance {
  return VAULT_STATE_AFFORDANCES[endpointVaultStateCase(state)];
}

export function vaultStateActionHref(vaultId: string, action: VaultStateActionKind): string {
  const params = new URLSearchParams({ vault: vaultId, action });
  return `/control/privacy?${params.toString()}`;
}
