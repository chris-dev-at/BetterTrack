import {
  COMMENT_PAGE_SIZE,
  type CommentThreadResponse,
  type CommentThreadSummaryResponse,
  type CreateCommentResponse,
  type ItemComment,
  type ReactionListResponse,
  type ReactionSummary,
  type ShareKind,
} from '@bettertrack/contracts';

import { coerceProfileIcon } from '../../http/serializers';
import type { CommentCreatedEvent, EventBus } from '../../events';
import type { Logger } from '../../logger';
import type { NotificationCenter } from '../notifications/notificationCenter';
import type { ItemCommentRepository } from '../../data/repositories/itemCommentRepository';
import type {
  ReactionAggregate,
  ItemReactionRepository,
} from '../../data/repositories/itemReactionRepository';
import type { UserRepository } from '../../data/repositories/userRepository';
import { notFound } from '../../errors';
import type { ParanoidModeGuard } from '../account/paranoidEnforcement';
import {
  VaultedPortfolioError,
  type VaultedPortfolioGuard,
} from '../account/vaultedPortfolioEnforcement';
import type { AudienceService } from './audienceService';

/**
 * Comments + reactions on shared items (§13.5 V5-P8). Every read AND write here
 * derives its authorization ENTIRELY from the item's current audience, resolved
 * through the ONE {@link AudienceService} enforcement layer (fail-closed): a
 * viewer may read/comment/react on an item's thread iff the item's audience
 * currently admits them (a friend the owner shares with) OR they own the item.
 * Narrowing the audience narrows the thread on the very next read — nothing is
 * cached. A public link is read-only and never reaches these endpoints (they all
 * sit behind `requireUser`, and the non-owner path requires a friendship join),
 * so there are no public comments (§16).
 *
 * Not authorized → a uniform 404, never a 403, consistent with every other
 * social read (§6.9 no-enumeration): the thread of an item you can't see is
 * indistinguishable from one that doesn't exist.
 */

export interface CommentServiceDeps {
  comments: ItemCommentRepository;
  reactions: ItemReactionRepository;
  /** The single sharing-enforcement layer — the sole source of read/write authorization. */
  audience: AudienceService;
  /** Public-safe author identity for the just-posted comment echo. */
  userRepo: Pick<UserRepository, 'findById'>;
  /** Locks viewer/owner plus optional thread actors across reads and writes. */
  paranoid?: Pick<ParanoidModeGuard, 'runAllowedMany' | 'runAllowedWithOptional'>;
  /** Holds the portfolio boundary across every thread read/write when the subject is a portfolio. */
  vaultedPortfolio?: Pick<VaultedPortfolioGuard, 'runOwnedPortfolioAllowed'>;
  /**
   * The ONE notification entry point (§6.10, #368) — emits `comment.created` to
   * the item OWNER so the thread they moderate is not write-only. Omit to
   * disable the arrival signal entirely (in-app-only unit setups).
   */
  notify?: NotificationCenter;
  /** Ephemeral bus publish for the realtime/webhook consumers. Best-effort. */
  events?: Pick<EventBus, 'publish'>;
  logger?: Logger;
}

export interface CommentService {
  /**
   * ONE bounded page of the item's thread + item-level reactions, or 404 when
   * unauthorized. Without a cursor the newest page is served; `cursor` (the
   * previous page's `nextCursor`) walks backwards into older comments.
   */
  getThread(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    cursor?: string,
  ): Promise<CommentThreadResponse>;
  /**
   * The collapsed head — live comment count + item reactions, no bodies. Same
   * audience rule and the same uniform 404 as {@link getThread}.
   */
  getThreadSummary(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<CommentThreadSummaryResponse>;
  /**
   * Post one comment on an authorized item, or 404 when unauthorized. Emits
   * `comment.created` to the item OWNER (never to the author themselves, and
   * never to the rest of the audience) so the thread they moderate announces
   * itself — matrix-routed, quiet-hours- and digest-aware like every other type.
   */
  addComment(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    body: string,
  ): Promise<CreateCommentResponse>;
  /** Soft-delete a comment: its author, or the item owner. 404 otherwise. */
  deleteComment(viewerId: string, commentId: string): Promise<void>;
  /** Toggle the viewer's reaction on an item; returns the fresh aggregate. */
  toggleItemReaction(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    emoji: string,
  ): Promise<ReactionListResponse>;
  /** Toggle the viewer's reaction on a comment; returns the fresh aggregate. */
  toggleCommentReaction(
    viewerId: string,
    commentId: string,
    emoji: string,
  ): Promise<ReactionListResponse>;
}

const THREAD_NOT_FOUND = () => notFound('Not found.', 'NOT_FOUND');
const COMMENT_NOT_FOUND = () => notFound('Comment not found.', 'COMMENT_NOT_FOUND');

/**
 * The ceiling on how many third-party participants ONE thread read may name in
 * its privacy-lock set (#1829).
 *
 * A thread's distinct participants are a subset of the item's audience plus its
 * owner, and the widest audience the picker can express is a single friend group
 * — `FRIEND_GROUP_MEMBERS_MAX` = 200. 250 therefore clears any audience that can
 * actually exist, with headroom for participants left over from an audience that
 * has since been narrowed. Past it we do NOT lift the filter: the read falls back
 * to the required principals' own contributions, so an unbounded thread degrades
 * to showing less, never to disclosing a participant nobody could lock.
 *
 * This ceiling is only ever reached in the branch where a participant genuinely
 * needs the paranoid treatment; the ordinary read enumerates nobody at all.
 */
const THREAD_ACTOR_LIMIT = 250;

/** How a viewer relates to a shared item they may access. */
interface ThreadAccess {
  ownerId: string;
  isOwner: boolean;
}

/**
 * The participants one locked read/write has to reason about, expressed as the
 * two questions the service asks about them — never as a list it always loads.
 * `hasRestricted` is the cheap, thread-length-independent probe; `all` is the
 * bounded enumeration that only a positive probe pays for.
 */
interface ActorScope {
  hasRestricted(): Promise<boolean>;
  all(limit: number): Promise<string[]>;
}

function toReactionSummaries(aggs: ReactionAggregate[]): ReactionSummary[] {
  return aggs.map((a) => ({ emoji: a.emoji, count: a.count, reacted: a.reacted }));
}

export function createCommentService(deps: CommentServiceDeps): CommentService {
  const { comments, reactions, audience, userRepo } = deps;

  /**
   * Portfolio comments are part of the sharing surface. Resolve the authoritative
   * owner without reading content, then hold the portfolio guard across the whole
   * operation. The owner gets the stable refusal they are entitled to; every
   * other caller keeps the route's existing opaque not-found result.
   */
  async function withAllowedPortfolioSubject<T>(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    missing: () => Error,
    action: () => Promise<T>,
  ): Promise<T> {
    if (kind !== 'portfolio' || !deps.vaultedPortfolio) return action();
    const ownerId = await audience.subjectOwner(kind, subjectId);
    if (!ownerId) return action();
    try {
      return await deps.vaultedPortfolio.runOwnedPortfolioAllowed(ownerId, subjectId, action);
    } catch (error) {
      if (error instanceof VaultedPortfolioError && viewerId !== ownerId) throw missing();
      throw error;
    }
  }

  /**
   * The heart of the fail-closed rule: resolve whether `viewerId` may currently
   * read/write the thread of (kind, subjectId), and whether they own the item.
   * The owner is never their own friend, so the friendship-gated audience reads
   * don't grant them — they're admitted here by ownership. `undefined` → 404.
   */
  async function resolveAccess(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
  ): Promise<ThreadAccess | undefined> {
    if (await audience.ownsSubject(viewerId, kind, subjectId)) {
      return { ownerId: viewerId, isOwner: true };
    }
    const shared =
      kind === 'portfolio'
        ? await audience.authorizePortfolioRead(viewerId, subjectId)
        : kind === 'conglomerate'
          ? await audience.authorizeConglomerateRead(viewerId, subjectId)
          : kind === 'idea'
            ? await audience.authorizeIdeaRead(viewerId, subjectId)
            : await audience.authorizeWatchlistRead(viewerId, subjectId);
    if (!shared) return undefined;
    return { ownerId: shared.ownerId, isOwner: false };
  }

  async function withLockedAccess<T>(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    action: (access: ThreadAccess) => Promise<T>,
    // Comment-scoped callers keep their own COMMENT_NOT_FOUND code: a reaction
    // on an unreachable thread must stay indistinguishable from a reaction on a
    // deleted comment, which is what the route contract already promises.
    notFound: () => Error = THREAD_NOT_FOUND,
  ): Promise<T> {
    const candidate = await resolveAccess(viewerId, kind, subjectId);
    if (!candidate) throw notFound();
    const revalidateAndRun = async () => {
      const access = await resolveAccess(viewerId, kind, subjectId);
      if (!access || access.ownerId !== candidate.ownerId) throw notFound();
      return action(access);
    };
    return deps.paranoid
      ? deps.paranoid.runAllowedMany([viewerId, candidate.ownerId], 'sharing', revalidateAndRun)
      : revalidateAndRun();
  }

  /**
   * Access resolution + the privacy locks a thread read or reaction write needs,
   * and — the point of #1829 — the DECISION about how much of that machinery to
   * pay for.
   *
   * Before #1829 the paranoid branch was unconditional in production (the guard
   * is always wired), so every read enumerated the thread's distinct authors and
   * reaction actors with no LIMIT, opened a transaction taking `FOR KEY SHARE` on
   * one `users` row per participant, and then handed a non-empty id list to every
   * aggregate — which is exactly the filter that stops the partial thread index
   * serving them. All of that exists to hide ONE thing: a participant whose
   * account is not in the `normal` privacy mode. So we ask that question first,
   * with a bounded probe that touches an index holding one entry per paranoid
   * account (usually zero rows):
   *
   *  - No such participant — the shape of every ordinary thread: lock only the
   *    required principals (viewer + item owner, and the comment's author where
   *    one is named), re-resolve access under that lock, and run the read with NO
   *    actor filter at all. Identical to what the guard-less path always did.
   *  - Otherwise: exactly the behaviour that shipped before, with the enumeration
   *    now bounded by {@link THREAD_ACTOR_LIMIT} and a truncated answer failing
   *    closed to the required principals' own rows.
   *
   * The probe is a live read of the same column the lock would read. It is not
   * held under a lock, so an account that turns paranoid between the probe and
   * the page is filtered from the NEXT read rather than this one — a window one
   * request wide, which is the price of not locking every participant of every
   * poll. A required principal turning paranoid is still refused, as before.
   */
  async function withLockedActors<T>(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    scope: ActorScope,
    action: (access: ThreadAccess, allowedActorIds?: readonly string[]) => Promise<T>,
    additionalRequiredActorIds: readonly string[] = [],
    notFound: () => Error = THREAD_NOT_FOUND,
  ): Promise<T> {
    const candidate = await resolveAccess(viewerId, kind, subjectId);
    if (!candidate) throw notFound();
    const requiredActorIds = [
      ...new Set([viewerId, candidate.ownerId, ...additionalRequiredActorIds]),
    ];
    // Re-resolved INSIDE the lock, every time: nothing about the audience is
    // carried over from the candidate resolution above except the owner identity
    // the lock was taken for.
    const revalidated = async (): Promise<ThreadAccess> => {
      const access = await resolveAccess(viewerId, kind, subjectId);
      if (!access || access.ownerId !== candidate.ownerId) throw notFound();
      return access;
    };
    const guard = deps.paranoid;
    if (!guard) return action(await revalidated());

    if (!(await scope.hasRestricted())) {
      return guard.runAllowedMany(requiredActorIds, 'sharing', async () =>
        action(await revalidated()),
      );
    }

    // Somebody here does need the treatment. Discover the participants — ids
    // only, no bodies, usernames, icons, emojis or aggregates — so the admitted
    // ones can be locked alongside the required principals. Every candidate is
    // OPTIONAL: a paranoid third party disappears from the thread instead of
    // making unrelated rows fail or revealing their mode.
    const participants = await scope.all(THREAD_ACTOR_LIMIT + 1);
    if (participants.length > THREAD_ACTOR_LIMIT) {
      // Truncated: we cannot name everyone, so we show the least — never more.
      return guard.runAllowedMany(requiredActorIds, 'sharing', async () =>
        action(await revalidated(), requiredActorIds),
      );
    }
    const optionalActorIds = participants.filter((id) => !requiredActorIds.includes(id));
    return guard.runAllowedWithOptional(
      requiredActorIds,
      optionalActorIds,
      'sharing',
      async (allowedOptionalActorIds) => {
        const access = await revalidated();
        // Required principals may themselves have authored/reacted; include them
        // alongside the admitted optional set. SQL filters make a newly
        // appearing, undiscovered actor invisible until the next locked read.
        return action(access, [
          ...requiredActorIds,
          ...optionalActorIds.filter((id) => allowedOptionalActorIds.has(id)),
        ]);
      },
    );
  }

  /** Everyone whose comment OR reaction can appear in one item's thread. */
  function threadScope(kind: ShareKind, subjectId: string): ActorScope {
    return {
      hasRestricted: async () => {
        const [inComments, inReactions] = await Promise.all([
          comments.hasRestrictedParticipant(kind, subjectId),
          reactions.hasRestrictedThreadActor(kind, subjectId),
        ]);
        return inComments || inReactions;
      },
      all: async (limit) => {
        const [commentAuthorIds, reactionActorIds] = await Promise.all([
          comments.listParticipantsForItem(kind, subjectId, limit),
          reactions.listActorIdsForThread(kind, subjectId, limit),
        ]);
        return [...new Set([...commentAuthorIds, ...reactionActorIds])];
      },
    };
  }

  /** Everyone whose reaction contributes to ONE item-level aggregate. */
  function itemReactionScope(kind: ShareKind, subjectId: string): ActorScope {
    return {
      hasRestricted: () => reactions.hasRestrictedItemActor(kind, subjectId),
      all: (limit) => reactions.listActorIdsForItem(kind, subjectId, limit),
    };
  }

  /** Everyone whose reaction contributes to ONE comment's aggregate. */
  function commentReactionScope(commentId: string): ActorScope {
    return {
      hasRestricted: () => reactions.hasRestrictedCommentActor(commentId),
      all: (limit) => reactions.listActorIdsForComment(commentId, limit),
    };
  }

  /**
   * Take back the viewer's OWN reaction, if they currently hold one — the
   * cleanup right that mirrors "the author deletes their own comment regardless
   * of current visibility" (see `deleteComment`). Without it, an owner narrowing
   * the audience strands the reaction forever: the toggle 404s and no other
   * removal path exists (#1780).
   *
   * The delete is scoped to (viewer, target, emoji), so it can only ever reach a
   * row the viewer authored, and its own result — not a preceding read — decides
   * whether this call was a withdrawal. The viewer is the only principal locked:
   * exactly like the own-comment delete, an owner's account mode must neither
   * block nor disclose itself through someone else's cleanup.
   *
   * Since #1829 this runs only AFTER the audience has refused the caller, and
   * `holds` — a single-row question about the caller's OWN reaction — decides
   * whether the scoped delete is attempted at all. That is what keeps a stranger
   * from driving a write against any subject id they can name. Both stay inside
   * the viewer's own lock, and the delete's own result still decides the
   * outcome: if the row goes between the two, this was not a withdrawal.
   */
  async function withdrawOwnReaction(
    viewerId: string,
    holds: () => Promise<boolean>,
    remove: () => Promise<boolean>,
  ): Promise<boolean> {
    const withdraw = async () => ((await holds()) ? remove() : false);
    return deps.paranoid
      ? deps.paranoid.runAllowedMany([viewerId], 'sharing', withdraw)
      : withdraw();
  }

  /**
   * The answer to a withdrawal by someone the item no longer admits: the
   * viewer's OWN remaining reactions, through the same `actorIds` filter
   * paranoid mode applies. Reporting the target's full aggregate would disclose
   * activity on an item they can no longer read — the cleanup gives back a
   * removal right, not a read.
   */
  function ownReactionsOnly(aggregates: ReactionAggregate[]): ReactionListResponse {
    return { reactions: toReactionSummaries(aggregates) };
  }

  /**
   * The read side of a thread — access resolution, the portfolio boundary and
   * the participant/lock decision — done ONCE for both the page read and the
   * collapsed summary. `allowedActorIds` is undefined when no privacy filter
   * applies, which is the ordinary case (§6.9, #1829).
   */
  async function withThreadActors<T>(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    action: (access: ThreadAccess, allowedActorIds?: readonly string[]) => Promise<T>,
  ): Promise<T> {
    return withAllowedPortfolioSubject(viewerId, kind, subjectId, THREAD_NOT_FOUND, () =>
      withLockedActors(viewerId, kind, subjectId, threadScope(kind, subjectId), action),
    );
  }

  /**
   * The owner-facing arrival signal (§13.5 V5-P8). Without it the thread is
   * write-only from the owner's side: they hold the moderation right over every
   * comment on their item and nothing would ever tell them one exists.
   *
   * Exactly ONE recipient — the item owner. A comment is deliberately NOT fanned
   * out to the rest of the audience: that would turn every shared item into a
   * mailing list. The author never notifies themselves, so an owner commenting
   * on their own item emits nothing.
   *
   * Both hops are best-effort and run inside the caller's already-resolved
   * access: the comment is committed, so a transport hiccup must cost the
   * notice, never the write. The bus publish feeds the ephemeral realtime /
   * webhook consumers, `notify.emit` the durable matrix-routed fan-out.
   */
  async function notifyOwner(
    access: ThreadAccess,
    kind: ShareKind,
    subjectId: string,
    authorId: string,
    authorUsername: string,
    created: { id: string; createdAt: Date },
  ): Promise<void> {
    if (access.isOwner || access.ownerId === authorId) return;
    if (!deps.notify && !deps.events) return;
    let itemName = '';
    try {
      itemName = (await audience.subjectIdentity(kind, subjectId))?.name ?? '';
    } catch (err) {
      deps.logger?.warn({ err, kind, subjectId }, 'comment.created subject lookup failed');
    }
    const event: CommentCreatedEvent = {
      type: 'comment.created',
      userId: access.ownerId,
      actorId: authorId,
      actorUsername: authorUsername,
      itemKind: kind,
      itemId: subjectId,
      itemName,
      commentId: created.id,
      occurredAt: created.createdAt.toISOString(),
    };
    try {
      await deps.events?.publish(event);
    } catch (err) {
      deps.logger?.warn({ err, commentId: created.id }, 'comment.created publish failed');
    }
    await deps.notify?.emit(event);
  }

  async function buildThread(
    viewerId: string,
    kind: ShareKind,
    subjectId: string,
    access: ThreadAccess,
    cursor: string | undefined,
    allowedActorIds?: readonly string[],
  ): Promise<CommentThreadResponse> {
    // One row beyond the page tells us whether an older page exists without a
    // second query; it never leaves this function. The cursor is just the
    // boundary comment's id — its ordering key is resolved in SQL, so nothing
    // rounds a microsecond timestamp down to a millisecond and skips a row.
    const page = await comments.listForItem(kind, subjectId, {
      limit: COMMENT_PAGE_SIZE + 1,
      before: cursor,
      authorIds: allowedActorIds,
    });
    const hasOlder = page.length > COMMENT_PAGE_SIZE;
    // Newest-first out of SQL; oldest-first for the reader.
    const rows = (hasOlder ? page.slice(0, COMMENT_PAGE_SIZE) : page).reverse();
    const oldest = rows[0];
    // The newest page can PROVE the whole thread's count whenever it did not
    // fill: no cursor means the page starts at the newest comment, and no older
    // page means it ends at the oldest, so the page IS the live thread under the
    // very filter `countForItem` would apply (#1725). Counting it costs nothing,
    // and that is the shape of every ordinary thread — so the poll that refetches
    // page 0 every 30 s stops issuing a `count(*)` alongside it. A page that
    // filled, or any older page, still asks the repository: the count stays exact
    // for every caller, and the partial thread index makes it an index-only scan.
    const provenCount = cursor === undefined && !hasOlder ? rows.length : undefined;
    const [reactionMap, itemReactions, commentCount] = await Promise.all([
      reactions.summaryForComments(
        viewerId,
        rows.map((row) => row.id),
        allowedActorIds,
      ),
      reactions.summaryForItem(viewerId, kind, subjectId, allowedActorIds),
      provenCount ?? comments.countForItem(kind, subjectId, allowedActorIds),
    ]);
    const commentList: ItemComment[] = rows.map((row) => ({
      id: row.id,
      author: {
        id: row.authorId,
        username: row.authorUsername,
        profileIcon: coerceProfileIcon(row.authorProfileIcon),
      },
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      // Author deletes their own; the item owner moderates every comment.
      canDelete: access.isOwner || row.authorId === viewerId,
      reactions: toReactionSummaries(reactionMap.get(row.id) ?? []),
    }));
    return {
      kind,
      subjectId,
      commentCount,
      comments: commentList,
      nextCursor: hasOlder && oldest ? oldest.id : null,
      reactions: toReactionSummaries(itemReactions),
    };
  }

  return {
    async getThread(viewerId, kind, subjectId, cursor) {
      return withThreadActors(viewerId, kind, subjectId, (access, allowedActorIds) =>
        buildThread(viewerId, kind, subjectId, access, cursor, allowedActorIds),
      );
    },

    async getThreadSummary(viewerId, kind, subjectId) {
      return withThreadActors(viewerId, kind, subjectId, async (_access, allowedActorIds) => {
        const [commentCount, itemReactions] = await Promise.all([
          comments.countForItem(kind, subjectId, allowedActorIds),
          reactions.summaryForItem(viewerId, kind, subjectId, allowedActorIds),
        ]);
        return { kind, subjectId, commentCount, reactions: toReactionSummaries(itemReactions) };
      });
    },

    async addComment(viewerId, kind, subjectId, body) {
      return withAllowedPortfolioSubject(viewerId, kind, subjectId, THREAD_NOT_FOUND, () =>
        withLockedAccess(viewerId, kind, subjectId, async (access) => {
          const created = await comments.create(kind, subjectId, viewerId, body);
          const author = await userRepo.findById(viewerId);
          await notifyOwner(access, kind, subjectId, viewerId, author?.username ?? '', created);
          return {
            id: created.id,
            author: {
              id: viewerId,
              username: author?.username ?? '',
              profileIcon: coerceProfileIcon(author?.profileIcon ?? null),
            },
            body,
            createdAt: created.createdAt.toISOString(),
            canDelete: true,
            reactions: [],
          };
        }),
      );
    },

    async deleteComment(viewerId, commentId) {
      const candidate = await comments.getById(commentId);
      // A tombstoned or unknown comment is a uniform 404 (idempotent re-delete).
      if (!candidate || candidate.deletedAt) throw COMMENT_NOT_FOUND();
      return withAllowedPortfolioSubject(
        viewerId,
        candidate.kind,
        candidate.subjectId,
        COMMENT_NOT_FOUND,
        async () => {
          // A subject that no longer exists resolves no owner. That must NOT
          // strand the comment: its author keeps their cleanup right over their
          // own text (pre-purge orphans from before subject teardown cleared
          // threads still exist). With no owner there is simply nobody holding
          // the moderation right, so every non-author still gets the uniform 404.
          const ownerId = await audience.subjectOwner(candidate.kind, candidate.subjectId);
          if (!ownerId && candidate.authorId !== viewerId) throw COMMENT_NOT_FOUND();
          const remove = async () => {
            const comment = await comments.getById(commentId);
            if (
              !comment ||
              comment.deletedAt ||
              comment.kind !== candidate.kind ||
              comment.subjectId !== candidate.subjectId
            ) {
              throw COMMENT_NOT_FOUND();
            }
            const currentOwnerId = await audience.subjectOwner(comment.kind, comment.subjectId);
            if (currentOwnerId !== ownerId) throw COMMENT_NOT_FOUND();
            // Author deletes their own regardless of current visibility (cleanup);
            // the item owner moderates any comment on their item. Anyone else → 404.
            const isAuthor = comment.authorId === viewerId;
            const isOwner = ownerId !== undefined && ownerId === viewerId;
            if (!isAuthor && !isOwner) throw COMMENT_NOT_FOUND();
            // The tombstone stays (thread continuity + an auditable
            // `deleted_by`), but the text and the comment's reactions go with
            // it, in ONE transaction (#1780): a moderated body retained forever
            // is not moderation, and reactions on a tombstone are unreachable
            // through every read AND unremovable through the toggle.
            const removed = await comments.softDelete(commentId, viewerId, (tx) =>
              reactions.deleteForComment(commentId, tx),
            );
            if (!removed) throw COMMENT_NOT_FOUND();
          };
          if (!deps.paranoid) return remove();
          // The deleter is the only REQUIRED principal. The item owner is
          // optional: an author removing their own text must not be blocked —
          // nor told anything — by the OWNER's account mode, which would both
          // strand the comment forever and disclose that mode through a 403.
          return deps.paranoid.runAllowedWithOptional(
            [viewerId],
            ownerId && ownerId !== viewerId ? [ownerId] : [],
            'sharing',
            remove,
          );
        },
      );
    },

    async toggleItemReaction(viewerId, kind, subjectId, emoji) {
      return withAllowedPortfolioSubject(viewerId, kind, subjectId, THREAD_NOT_FOUND, async () => {
        // Authorization FIRST (#1829). The caller names the subject id, so
        // nothing may act on it — no write, no DISTINCT scan over its actors —
        // before the audience has been asked. A caller the item does not admit
        // keeps exactly ONE right here: taking back their own reaction (#1780),
        // decided from their own row and nothing else.
        if (!(await resolveAccess(viewerId, kind, subjectId))) {
          const withdrawn = await withdrawOwnReaction(
            viewerId,
            () => reactions.hasOwnItemReaction(viewerId, kind, subjectId, emoji),
            () => reactions.removeItem(viewerId, kind, subjectId, emoji),
          );
          if (!withdrawn) throw THREAD_NOT_FOUND();
          return ownReactionsOnly(
            await reactions.summaryForItem(viewerId, kind, subjectId, [viewerId]),
          );
        }
        return withLockedActors(
          viewerId,
          kind,
          subjectId,
          itemReactionScope(kind, subjectId),
          async (_access, allowedActorIds) => {
            await reactions.toggleItem(viewerId, kind, subjectId, emoji);
            const summary = await reactions.summaryForItem(
              viewerId,
              kind,
              subjectId,
              allowedActorIds,
            );
            return { reactions: toReactionSummaries(summary) };
          },
        );
      });
    },

    async toggleCommentReaction(viewerId, commentId, emoji) {
      const candidate = await comments.getById(commentId);
      if (!candidate || candidate.deletedAt) throw COMMENT_NOT_FOUND();
      return withAllowedPortfolioSubject(
        viewerId,
        candidate.kind,
        candidate.subjectId,
        COMMENT_NOT_FOUND,
        async () => {
          // Authorization FIRST, exactly as for the item toggle (#1829): the
          // withdrawal right is all that survives losing access, and it reaches
          // only the caller's own row.
          if (!(await resolveAccess(viewerId, candidate.kind, candidate.subjectId))) {
            const withdrawn = await withdrawOwnReaction(
              viewerId,
              () => reactions.hasOwnCommentReaction(viewerId, commentId, emoji),
              () => reactions.removeComment(viewerId, commentId, emoji),
            );
            if (!withdrawn) throw COMMENT_NOT_FOUND();
            return ownReactionsOnly(
              await reactions.summaryForComment(viewerId, commentId, [viewerId]),
            );
          }
          // Reacting needs the SAME access as reading the thread the comment
          // lives in, and the comment itself is re-read under the lock: it may
          // have been moderated away, or its subject moved, since the entry read.
          return withLockedActors(
            viewerId,
            candidate.kind,
            candidate.subjectId,
            commentReactionScope(commentId),
            async (_access, allowedActorIds) => {
              const comment = await comments.getById(commentId);
              if (
                !comment ||
                comment.deletedAt ||
                comment.kind !== candidate.kind ||
                comment.subjectId !== candidate.subjectId ||
                comment.authorId !== candidate.authorId
              ) {
                throw COMMENT_NOT_FOUND();
              }
              await reactions.toggleComment(viewerId, commentId, emoji);
              const summary = await reactions.summaryForComment(
                viewerId,
                commentId,
                allowedActorIds,
              );
              return { reactions: toReactionSummaries(summary) };
            },
            [candidate.authorId],
            COMMENT_NOT_FOUND,
          );
        },
      );
    },
  };
}
