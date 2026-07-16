import type {
  CreateIdeaRequest,
  Idea,
  IdeaListResponse,
  IdeaResponse,
  IdeaWorkboardState,
  UpdateIdeaRequest,
} from '@bettertrack/contracts';

import type { ConglomerateRepository } from '../../data/repositories/conglomerateRepository';
import type { IdeaRecord, IdeaRepository } from '../../data/repositories/ideaRepository';
import { badRequest, notFound } from '../../errors';
import type { AudienceService } from '../social/audienceService';

/**
 * Ideas — saved & shareable Workboard analyses (PROJECTPLAN.md §13.4 V4-P9).
 *
 * CRUD over a named Workboard state (owner-scoped, §8), plus the audience-gated
 * clone. The service owns two rules the handlers stay thin about:
 *
 *  - **Owner validation of a referenced conglomerate.** When a saved state points
 *    at a conglomerate, the caller must own it — you cannot stash a reference to
 *    someone else's basket in your own idea (no IDOR / no probing, §8). Ad-hoc
 *    asset sets are stored verbatim; visibility of their assets is re-resolved by
 *    the Workboard/backtest on reopen, never here.
 *  - **Clone is audience-gated, never a back-door.** Cloning routes through the
 *    ONE enforcement layer ({@link AudienceService.authorizeIdeaRead}): a viewer
 *    the idea's audience does not admit gets a uniform 404 (never 403, no
 *    existence leak). An admitted viewer gets a byte-exact private copy — the
 *    conglomerate reference (if any) is copied verbatim, since exact reproduction
 *    is the point; the clone owner simply may not be able to run that basket until
 *    they own it, which the Workboard surface handles.
 *
 * Sharing itself (the audience picker, Shared-With-Me / My-items groups, the
 * chat chip, the follow.published fan-out) lives in the audience/social/chat
 * services — ideas are the fourth kind through that same model, never a parallel
 * path.
 */

export interface IdeasServiceDeps {
  repo: IdeaRepository;
  /** Ownership check for a referenced conglomerate on create/update (§8). */
  conglomerates: Pick<ConglomerateRepository, 'findByIdForOwner'>;
  /** The ONE enforcement layer — gates clone + drops the audience row on delete. */
  audience: Pick<AudienceService, 'authorizeIdeaRead' | 'clearForSubject'>;
}

export interface IdeasService {
  /** The caller's saved ideas, newest first. */
  list(ownerId: string): Promise<IdeaListResponse>;
  /** One of the caller's own ideas. Unknown/foreign id → 404. */
  get(ownerId: string, ideaId: string): Promise<IdeaResponse>;
  /** Persist a new idea. A conglomerate ref the caller doesn't own → 400. */
  create(ownerId: string, input: CreateIdeaRequest): Promise<IdeaResponse>;
  /** Patch name/thesis/state. Unknown/foreign id → 404; foreign conglomerate ref → 400. */
  update(ownerId: string, ideaId: string, patch: UpdateIdeaRequest): Promise<IdeaResponse>;
  /** Delete an own idea + its audience row. Unknown/foreign id → 404. */
  remove(ownerId: string, ideaId: string): Promise<void>;
  /** Clone an audience-admitted idea into an own private copy. Non-admitted → 404. */
  clone(viewerId: string, ideaId: string): Promise<IdeaResponse>;
}

const IDEA_NOT_FOUND = () => notFound('Idea not found.');
const CONGLOMERATE_NOT_OWNED = () =>
  badRequest('Referenced conglomerate not found.', 'IDEA_CONGLOMERATE_NOT_FOUND');

function toIdea(record: IdeaRecord): Idea {
  return {
    id: record.id,
    name: record.name,
    thesis: record.thesis,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createIdeasService(deps: IdeasServiceDeps): IdeasService {
  const { repo, conglomerates, audience } = deps;

  /** A conglomerate-sourced state must reference one the owner actually owns (§8). */
  async function assertSourceOwned(ownerId: string, state: IdeaWorkboardState): Promise<void> {
    if (state.source.kind !== 'conglomerate') return;
    const owned = await conglomerates.findByIdForOwner(ownerId, state.source.conglomerateId);
    if (!owned) throw CONGLOMERATE_NOT_OWNED();
  }

  return {
    async list(ownerId) {
      const records = await repo.listForOwner(ownerId);
      return { ideas: records.map(toIdea) };
    },

    async get(ownerId, ideaId) {
      const record = await repo.findByIdForOwner(ownerId, ideaId);
      if (!record) throw IDEA_NOT_FOUND();
      return { idea: toIdea(record) };
    },

    async create(ownerId, input) {
      await assertSourceOwned(ownerId, input.state);
      const record = await repo.create(ownerId, {
        name: input.name,
        thesis: input.thesis ?? null,
        state: input.state,
      });
      return { idea: toIdea(record) };
    },

    async update(ownerId, ideaId, patch) {
      if (patch.state !== undefined) await assertSourceOwned(ownerId, patch.state);
      const record = await repo.update(ownerId, ideaId, {
        name: patch.name,
        // `thesis: undefined` (omitted) leaves it untouched; `null` clears it.
        thesis: patch.thesis === undefined ? undefined : (patch.thesis ?? null),
        state: patch.state,
      });
      if (!record) throw IDEA_NOT_FOUND();
      return { idea: toIdea(record) };
    },

    async remove(ownerId, ideaId) {
      const deleted = await repo.delete(ownerId, ideaId);
      if (!deleted) throw IDEA_NOT_FOUND();
      // Drop the audience row + any item-follow bookmarks for the vanished subject
      // (hygiene; the authorization joins already exclude a deleted idea).
      await audience.clearForSubject('idea', ideaId);
    },

    async clone(viewerId, ideaId) {
      // Audience-gated, recomputed now: the owner sees their own idea (ownership),
      // an admitted friend/public viewer passes the enforcement join, everyone
      // else gets `undefined` → a uniform 404 (no existence leak).
      const authorized = await audience.authorizeIdeaRead(viewerId, ideaId);
      const isOwner = (await repo.findByIdForOwner(viewerId, ideaId)) !== null;
      if (!authorized && !isOwner) throw IDEA_NOT_FOUND();
      const source = await repo.findById(ideaId);
      if (!source) throw IDEA_NOT_FOUND();
      // Byte-exact private copy (exact reproduction is the point). A conglomerate
      // reference is copied verbatim even across owners — the Workboard resolves
      // ownership on reopen; we never rewrite the saved state on clone.
      const record = await repo.create(viewerId, {
        name: source.name,
        thesis: source.thesis,
        state: source.state,
      });
      return { idea: toIdea(record) };
    },
  };
}
