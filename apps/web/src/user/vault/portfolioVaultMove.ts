import { uuidv7 } from 'uuidv7';

import type {
  PortfolioSummary,
  PortfolioVaultMoveInResponse,
  PortfolioVaultMoveOutResponse,
  VaultConfig,
  VaultStepUpCredential,
  VaultStrictDocumentV1,
} from '@bettertrack/contracts';

import {
  getPortfolioVaultRevision,
  movePortfolioIntoVault,
  movePortfolioOutOfVault,
  requestPortfolioMoveOutChallenge,
} from '../../lib/vaultApi';
import type { VaultMovePrecondition } from './ui/PortfolioVaultMoveWizard';
import type { EndpointVaultState } from './keystore';
import { vaultStateAffordance, vaultStateActionHref } from './vaultStateAffordance';

/**
 * The client half of the §9/§10 move pipeline.
 *
 * E4 (#1414) owns the server: `move-in` hard-deletes the captured rows once the
 * client has written and round-trip-verified the portfolio's encrypted document,
 * `move-out` restores the strict graph the client decrypts. Everything that has
 * to touch ciphertext — writing that document, rebuilding the restore graph and
 * signing E4's challenge with the retirement-proof key that lives inside the
 * encrypted common doc — belongs to the E6 client engine (#1416) and is reached
 * through {@link PortfolioVaultMoveCapture}.
 *
 * Everything else is here: the revision read that binds the capture, the
 * challenge round trip, the step-up credential the wizard collected, and the
 * preconditions that decide whether a destructive request may fire at all.
 */
export interface PortfolioVaultMoveCapture {
  /**
   * Write this portfolio's encrypted document into the vault and verify it on
   * every selected medium. Returns the doc version E4 commits against.
   */
  captureMoveIn(input: {
    portfolioId: string;
    vault: VaultConfig;
  }): Promise<{ docVersion: number }>;
  /**
   * Open the vault, build the strict restore graph for this portfolio, and
   * return the signer for E4's short-lived challenge.
   */
  captureMoveOut(input: { portfolioId: string; vault: VaultConfig }): Promise<{
    lifecycleGeneration: number;
    documentDigest: string;
    documentSetHash: string;
    document: VaultStrictDocumentV1;
    sign(challenge: string): Promise<string>;
  }>;
}

/**
 * The capture implementation for this build, or `null` when it has none.
 *
 * One resolver, so every surface asks the same question once and states the
 * answer up front instead of discovering it at the destructive step. E6 (#1416)
 * returns its engine here and both wizards light up unchanged.
 */
export function resolvePortfolioVaultMoveCapture(): PortfolioVaultMoveCapture | null {
  return null;
}

export interface MoveInPreconditionInput {
  portfolio: PortfolioSummary;
  /** The chosen target, or null while the wizard has no selection yet. */
  vault: VaultConfig | null;
  vaultState: EndpointVaultState | undefined;
  capture: PortfolioVaultMoveCapture | null;
}

/**
 * Every reason this portfolio cannot move in right now, each as its own fixable
 * step (§9). The wizard renders them and keeps the commit blocked while any
 * remains — the destructive request never fires from an unmet precondition.
 */
export function moveInPreconditions(input: MoveInPreconditionInput): VaultMovePrecondition[] {
  const preconditions: VaultMovePrecondition[] = [];
  if (input.portfolio.mirror) {
    preconditions.push({
      id: 'mirrorchain',
      messageKey: 'vault.portfolioMove.precondition.mirrorchain',
      fixLabelKey: 'vault.portfolioMove.precondition.mirrorchainFix',
      fixHref: `/portfolio/settings?portfolio=${encodeURIComponent(input.portfolio.id)}`,
    });
  }
  if (input.vault && input.vaultState) {
    const affordance = vaultStateAffordance(input.vaultState);
    if (affordance.action !== 'open') {
      preconditions.push({
        id: 'vault-locked',
        messageKey: 'vault.portfolioMove.precondition.vaultLocked',
        fixLabelKey: affordance.labelKey,
        fixHref: vaultStateActionHref(input.vault.id, affordance.action),
      });
    }
  }
  if (input.capture === null) {
    // Not fixable by the user, so it carries no fix link — but it is stated
    // before the twelve-word ceremony's worth of effort, not after it.
    preconditions.push({
      id: 'capture-unavailable',
      messageKey: 'vault.portfolioMove.precondition.captureUnavailable',
    });
  }
  return preconditions;
}

/** True when a vaulted portfolio can be moved out from THIS device (§10). */
export function moveOutUnlocked(
  state: EndpointVaultState | undefined,
  capture: PortfolioVaultMoveCapture | null,
): boolean {
  if (capture === null || !state) return false;
  return vaultStateAffordance(state).action === 'open';
}

export async function submitPortfolioMoveIn(input: {
  portfolio: PortfolioSummary;
  vault: VaultConfig;
  stepUp: VaultStepUpCredential;
  capture: PortfolioVaultMoveCapture;
}): Promise<PortfolioVaultMoveInResponse> {
  // Read the revision FIRST: it binds the capture that follows, and E4 refuses
  // the commit when any write lands in between rather than deleting rows the
  // encrypted document never captured.
  const { portfolioDataRevision } = await getPortfolioVaultRevision(input.portfolio.id);
  const { docVersion } = await input.capture.captureMoveIn({
    portfolioId: input.portfolio.id,
    vault: input.vault,
  });
  return movePortfolioIntoVault(input.portfolio.id, {
    vaultId: input.vault.id,
    docVersion,
    portfolioDataRevision,
    stepUp: input.stepUp,
  });
}

export async function submitPortfolioMoveOut(input: {
  portfolio: PortfolioSummary;
  vault: VaultConfig;
  stepUp: VaultStepUpCredential;
  capture: PortfolioVaultMoveCapture;
}): Promise<PortfolioVaultMoveOutResponse> {
  const draft = await input.capture.captureMoveOut({
    portfolioId: input.portfolio.id,
    vault: input.vault,
  });
  const challenge = await requestPortfolioMoveOutChallenge(input.portfolio.id, {
    vaultId: input.vault.id,
    lifecycleGeneration: draft.lifecycleGeneration,
    documentDigest: draft.documentDigest,
    documentSetHash: draft.documentSetHash,
  });
  return movePortfolioOutOfVault(input.portfolio.id, {
    vaultId: input.vault.id,
    moveOutId: uuidv7(),
    lifecycleGeneration: draft.lifecycleGeneration,
    documentSetHash: draft.documentSetHash,
    document: draft.document,
    vaultProof: {
      challenge: challenge.challenge,
      signature: await draft.sign(challenge.challenge),
    },
    stepUp: input.stepUp,
  });
}
