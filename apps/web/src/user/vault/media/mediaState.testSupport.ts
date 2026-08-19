import {
  paranoidVaultMediaStateSchema,
  type ParanoidServerCandidateMetadata,
  type ParanoidVaultMediaState,
  type RetiredServerMetadata,
  type VaultMedium,
} from '@bettertrack/contracts';

/**
 * The facts the server actually stores about one paranoid account's media.
 * `disposition` is deliberately absent: it is not an input but a label the
 * server derives from these facts, and hand-writing it is how tests end up
 * asserting states the API can never emit.
 */
export interface MediaStateFacts {
  /** The durable selection, as the account row holds it. */
  mediaSet: readonly VaultMedium[];
  driveAttestedVersion?: number | null;
  /**
   * Whether a live server vault row exists. Defaults to "`server` is a selected
   * medium", the only pairing the media transitions produce; pass it explicitly
   * only to build a deliberately torn state.
   */
  activeServerVault?: boolean;
  /** A staged, not-yet-promoted server copy. */
  candidate?: ParanoidServerCandidateMetadata | null;
  /** The recovery copy a switch to Drive-only left behind. */
  retired?: RetiredServerMetadata | null;
}

/**
 * Build a media state the way the server does.
 *
 * This mirrors `mediaStateOf` in `apps/api/src/data/repositories/paranoidVaultRepository.ts`,
 * whose `disposition` is a PRIORITY-ORDERED label over the same three facts —
 * `active` beats a staged `candidate`, which beats a `retired` copy — not an
 * independent flag. The contract type is structurally wider than that producer
 * (any disposition type-checks beside any candidate), so a hand-written literal
 * can encode a combination no request will ever return, and a test asserting
 * over it proves nothing. Every fixture goes through here, and through the
 * contract schema, so that gap cannot reopen one literal at a time.
 */
export function mediaStateFacts(facts: MediaStateFacts): ParanoidVaultMediaState {
  const candidate = facts.candidate ?? null;
  const retired = facts.retired ?? null;
  const active = facts.activeServerVault ?? facts.mediaSet.includes('server');
  return paranoidVaultMediaStateSchema.parse({
    mediaSet: (['server', 'drive'] as const).filter((medium) => facts.mediaSet.includes(medium)),
    driveAttestedVersion: facts.driveAttestedVersion ?? null,
    server: {
      disposition: active
        ? 'active'
        : candidate
          ? 'inactive-candidate'
          : retired
            ? 'retired'
            : 'empty',
      candidate,
      retired,
    },
  });
}
