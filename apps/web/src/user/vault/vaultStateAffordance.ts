import type { EndpointVaultState } from './keystore';

type StateCase<State extends EndpointVaultState> = State extends {
  status: 'stored+wrapped';
}
  ? `${State['status']}:${State['session']}:${State['requiredAction']['kind']}`
  : `${State['status']}:${State['requiredAction']['kind']}`;

export type EndpointVaultStateCase = StateCase<EndpointVaultState>;

export const VAULT_STATE_ACTION_KINDS = [
  'unlock',
  'open',
  'provide-phrase',
  'scan-qr',
  'reset-endpoint',
] as const;

export type VaultStateActionKind = (typeof VAULT_STATE_ACTION_KINDS)[number];

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
  if (state.status === 'endpoint-keystore-invalid') {
    return 'endpoint-keystore-invalid:reset-endpoint-keystore';
  }
  // Exhaustive by construction: a state added to E3 without a branch here fails
  // to widen to `never` and the build stops. Without this, a new state would
  // fall through to the catch-all and silently offer "Reset this device" — the
  // most destructive affordance in the set — for a state nobody mapped.
  return assertNeverVaultState(state);
}

function assertNeverVaultState(state: never): never {
  throw new Error(`unmapped-endpoint-vault-state:${JSON.stringify(state)}`);
}

export function vaultStateAffordance(state: EndpointVaultState): VaultStateAffordance {
  return VAULT_STATE_AFFORDANCES[endpointVaultStateCase(state)];
}

export function isVaultStateActionKind(action: string): action is VaultStateActionKind {
  return (VAULT_STATE_ACTION_KINDS as readonly string[]).includes(action);
}

/**
 * The actions a state actually offers. `not-on-this-endpoint` offers two — the
 * row renders "Enter words" next to "Scan QR" — every other state offers exactly
 * the one its affordance names.
 */
export function vaultStateOfferedActions(
  state: EndpointVaultState,
): readonly VaultStateActionKind[] {
  const { action } = vaultStateAffordance(state);
  return action === 'provide-phrase' ? ['provide-phrase', 'scan-qr'] : [action];
}

/**
 * Whether a requested action — typically one carried by a `?action=` deep link —
 * is still on offer for this live state. A URL is a request, not a state: a link
 * made before the fifth wrong password still says `unlock` long after the
 * endpoint withdrew it.
 */
export function vaultStateOffersAction(state: EndpointVaultState, action: string): boolean {
  return (
    isVaultStateActionKind(action) &&
    (vaultStateOfferedActions(state) as readonly string[]).includes(action)
  );
}

/**
 * The badge tone a state wears. Kept beside the affordance table because it is
 * the same total map over the same union — and because the one distinction the
 * COPY cannot make lives here: a locked vault and a locked-OUT vault share
 * `state.locked` ("Locked on this device"), so only the tone separates "type
 * your password" from "five wrong tries, wait". No new string, no new state.
 */
export type VaultStateTone = 'pos' | 'neg' | 'gold' | 'blue';

export function vaultStateTone(state: EndpointVaultState): VaultStateTone {
  if (vaultStateRetryAt(state) != null) return 'neg';
  switch (endpointVaultStateCase(state)) {
    case 'stored+wrapped:unlocked:open-silently':
    case 'stored+plain:open-silently':
      return 'pos';
    case 'not-on-this-endpoint:provide-phrase':
      return 'blue';
    case 'endpoint-keystore-invalid:reset-endpoint-keystore':
      return 'neg';
    default:
      return 'gold';
  }
}

/** The instant a locked-out endpoint accepts a device password again, if it is. */
export function vaultStateRetryAt(state: EndpointVaultState): number | null {
  return state.status === 'stored+wrapped' &&
    state.session === 'locked' &&
    state.requiredAction.kind === 'wait-or-reset'
    ? state.requiredAction.retryAt
    : null;
}

export function vaultStateActionHref(vaultId: string, action: VaultStateActionKind): string {
  const params = new URLSearchParams({ vault: vaultId, action });
  return `/control/privacy?${params.toString()}`;
}
