import type { ShareKind } from '@bettertrack/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  CommentRow,
  CommentSubjectRef,
  ItemCommentRepository,
} from '../../../data/repositories/itemCommentRepository';
import type {
  ItemReactionRepository,
  ReactionAggregate,
} from '../../../data/repositories/itemReactionRepository';
import type { UserRepository } from '../../../data/repositories/userRepository';
import type { AudienceService } from '../audienceService';
import { createCommentService } from '../commentService';

const OWNER = 'owner-1';
const AUTHOR = 'author-1';
const VIEWER = 'viewer-1';
const OUTSIDER = 'outsider-1';
const SUBJECT_ID = 'subject-1';
const COMMENT_ID = 'comment-1';
const CREATED_AT = new Date('2026-07-27T00:00:00.000Z');

const SHARE_KINDS: readonly ShareKind[] = ['portfolio', 'conglomerate', 'idea', 'watchlist'];

function makeHarness() {
  const comments = {
    listForItem: vi.fn<ItemCommentRepository['listForItem']>().mockResolvedValue([]),
    create: vi
      .fn<ItemCommentRepository['create']>()
      .mockResolvedValue({ id: COMMENT_ID, createdAt: CREATED_AT }),
    getById: vi.fn<ItemCommentRepository['getById']>().mockResolvedValue(undefined),
    softDelete: vi.fn<ItemCommentRepository['softDelete']>().mockResolvedValue(true),
  };
  const reactions = {
    toggleItem: vi.fn<ItemReactionRepository['toggleItem']>().mockResolvedValue(undefined),
    toggleComment: vi.fn<ItemReactionRepository['toggleComment']>().mockResolvedValue(undefined),
    summaryForItem: vi.fn<ItemReactionRepository['summaryForItem']>().mockResolvedValue([]),
    summaryForComment: vi.fn<ItemReactionRepository['summaryForComment']>().mockResolvedValue([]),
    summaryForComments: vi
      .fn<ItemReactionRepository['summaryForComments']>()
      .mockResolvedValue(new Map<string, ReactionAggregate[]>()),
  };
  const audience = {
    ownsSubject: vi.fn<AudienceService['ownsSubject']>().mockResolvedValue(false),
    // Identity-only owner discovery: moderation resolves the item owner before
    // it can lock both principals, so it never reads the audience matrix.
    subjectOwner: vi.fn<AudienceService['subjectOwner']>().mockResolvedValue(OWNER),
    authorizePortfolioRead: vi
      .fn<AudienceService['authorizePortfolioRead']>()
      .mockResolvedValue(undefined),
    authorizeConglomerateRead: vi
      .fn<AudienceService['authorizeConglomerateRead']>()
      .mockResolvedValue(undefined),
    authorizeIdeaRead: vi.fn<AudienceService['authorizeIdeaRead']>().mockResolvedValue(undefined),
    authorizeWatchlistRead: vi
      .fn<AudienceService['authorizeWatchlistRead']>()
      .mockResolvedValue(undefined),
    authorizePublicItemRead: vi
      .fn<AudienceService['authorizePublicItemRead']>()
      .mockResolvedValue(undefined),
  };
  const userRepo = {
    findById: vi.fn<UserRepository['findById']>().mockResolvedValue(undefined),
  };

  return {
    service: createCommentService({
      comments: comments as unknown as ItemCommentRepository,
      reactions: reactions as unknown as ItemReactionRepository,
      audience: audience as unknown as AudienceService,
      userRepo,
    }),
    comments,
    reactions,
    audience,
    userRepo,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function commentRef(overrides: Partial<CommentSubjectRef> = {}): CommentSubjectRef {
  return {
    id: COMMENT_ID,
    kind: 'portfolio',
    subjectId: SUBJECT_ID,
    authorId: AUTHOR,
    deletedAt: null,
    ...overrides,
  };
}

function commentRow(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: COMMENT_ID,
    authorId: AUTHOR,
    authorUsername: 'author',
    authorProfileIcon: null,
    body: 'A comment',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function admit(harness: Harness, kind: ShareKind, viewerIds: readonly string[]) {
  const resolve = async (viewerId: string, subjectId: string) =>
    viewerIds.includes(viewerId) && subjectId === SUBJECT_ID
      ? {
          ownerId: OWNER,
          ownerUsername: 'owner',
          ownerProfileIcon: null,
          name: 'Shared subject',
        }
      : undefined;

  switch (kind) {
    case 'portfolio':
      harness.audience.authorizePortfolioRead.mockImplementation(resolve);
      return;
    case 'conglomerate':
      harness.audience.authorizeConglomerateRead.mockImplementation(resolve);
      return;
    case 'idea':
      harness.audience.authorizeIdeaRead.mockImplementation(resolve);
      return;
    case 'watchlist':
      harness.audience.authorizeWatchlistRead.mockImplementation(resolve);
      return;
  }
}

function admitWhile(harness: Harness, kind: ShareKind, isAdmitted: () => boolean) {
  const resolve = async (viewerId: string, subjectId: string) =>
    isAdmitted() && viewerId === VIEWER && subjectId === SUBJECT_ID
      ? {
          ownerId: OWNER,
          ownerUsername: 'owner',
          ownerProfileIcon: null,
          name: 'Shared subject',
        }
      : undefined;

  switch (kind) {
    case 'portfolio':
      harness.audience.authorizePortfolioRead.mockImplementation(resolve);
      return;
    case 'conglomerate':
      harness.audience.authorizeConglomerateRead.mockImplementation(resolve);
      return;
    case 'idea':
      harness.audience.authorizeIdeaRead.mockImplementation(resolve);
      return;
    case 'watchlist':
      harness.audience.authorizeWatchlistRead.mockImplementation(resolve);
      return;
  }
}

function admitOwner(harness: Harness, kind: ShareKind) {
  harness.audience.ownsSubject.mockImplementation(
    async (viewerId, candidateKind, subjectId) =>
      viewerId === OWNER && candidateKind === kind && subjectId === SUBJECT_ID,
  );
}

function expectNoAudienceRead(harness: Harness) {
  expect(harness.audience.authorizePortfolioRead).not.toHaveBeenCalled();
  expect(harness.audience.authorizeConglomerateRead).not.toHaveBeenCalled();
  expect(harness.audience.authorizeIdeaRead).not.toHaveBeenCalled();
  expect(harness.audience.authorizeWatchlistRead).not.toHaveBeenCalled();
}

async function expectNotFound(
  operation: Promise<unknown>,
  code: 'NOT_FOUND' | 'COMMENT_NOT_FOUND',
) {
  await expect(operation).rejects.toMatchObject({ statusCode: 404, code });
}

describe('commentService — audience and moderation boundaries', () => {
  describe.each(SHARE_KINDS)('%s thread access', (kind) => {
    it('uses the live audience matrix for owner, admitted viewer, and unauthorized viewer', async () => {
      const harness = makeHarness();
      admitOwner(harness, kind);
      admit(harness, kind, [VIEWER]);

      await expect(harness.service.getThread(OWNER, kind, SUBJECT_ID)).resolves.toMatchObject({
        kind,
        subjectId: SUBJECT_ID,
      });
      await expect(harness.service.getThread(VIEWER, kind, SUBJECT_ID)).resolves.toMatchObject({
        kind,
        subjectId: SUBJECT_ID,
      });
      await expectNotFound(harness.service.getThread(OUTSIDER, kind, SUBJECT_ID), 'NOT_FOUND');

      // The denied subject never reaches comment or reaction reads.
      expect(harness.comments.listForItem).toHaveBeenCalledTimes(2);
      expect(harness.reactions.summaryForComments).toHaveBeenCalledTimes(2);
      expect(harness.reactions.summaryForItem).toHaveBeenCalledTimes(2);
    });
  });

  it('fails closed on the next thread, comment, and item-reaction operation after revocation', async () => {
    const harness = makeHarness();
    let currentlyAdmitted = true;
    admitWhile(harness, 'portfolio', () => currentlyAdmitted);

    // Establish that the viewer was admitted, then revoke them before the next operation.
    await expect(harness.service.getThread(VIEWER, 'portfolio', SUBJECT_ID)).resolves.toBeDefined();
    harness.comments.listForItem.mockClear();
    harness.comments.create.mockClear();
    harness.reactions.toggleItem.mockClear();
    harness.reactions.summaryForComments.mockClear();
    harness.reactions.summaryForItem.mockClear();
    harness.userRepo.findById.mockClear();
    currentlyAdmitted = false;

    await expectNotFound(harness.service.getThread(VIEWER, 'portfolio', SUBJECT_ID), 'NOT_FOUND');
    await expectNotFound(
      harness.service.addComment(VIEWER, 'portfolio', SUBJECT_ID, 'no longer admitted'),
      'NOT_FOUND',
    );
    await expectNotFound(
      harness.service.toggleItemReaction(VIEWER, 'portfolio', SUBJECT_ID, '👍'),
      'NOT_FOUND',
    );

    expect(harness.comments.listForItem).not.toHaveBeenCalled();
    expect(harness.comments.create).not.toHaveBeenCalled();
    expect(harness.userRepo.findById).not.toHaveBeenCalled();
    expect(harness.reactions.toggleItem).not.toHaveBeenCalled();
    expect(harness.reactions.summaryForComments).not.toHaveBeenCalled();
    expect(harness.reactions.summaryForItem).not.toHaveBeenCalled();
  });

  it('does not admit a public-link reader into a thread', async () => {
    const harness = makeHarness();
    harness.audience.authorizePublicItemRead.mockResolvedValue({ name: 'Public item' });

    await expectNotFound(harness.service.getThread(VIEWER, 'portfolio', SUBJECT_ID), 'NOT_FOUND');

    expect(harness.audience.authorizePublicItemRead).not.toHaveBeenCalled();
    expect(harness.comments.listForItem).not.toHaveBeenCalled();
    expect(harness.reactions.summaryForItem).not.toHaveBeenCalled();
  });

  it('only gives canDelete to an item owner or the comment author', async () => {
    const harness = makeHarness();
    harness.comments.listForItem.mockResolvedValue([commentRow()]);
    admitOwner(harness, 'portfolio');
    admit(harness, 'portfolio', [AUTHOR, VIEWER]);

    const ownerThread = await harness.service.getThread(OWNER, 'portfolio', SUBJECT_ID);
    const authorThread = await harness.service.getThread(AUTHOR, 'portfolio', SUBJECT_ID);
    const viewerThread = await harness.service.getThread(VIEWER, 'portfolio', SUBJECT_ID);

    expect(ownerThread.comments[0]?.canDelete).toBe(true);
    expect(authorThread.comments[0]?.canDelete).toBe(true);
    expect(viewerThread.comments[0]?.canDelete).toBe(false);
  });

  it('lets an author clean up their comment after audience revocation', async () => {
    const harness = makeHarness();
    harness.comments.getById.mockResolvedValue(commentRef());

    await expect(harness.service.deleteComment(AUTHOR, COMMENT_ID)).resolves.toBeUndefined();

    expectNoAudienceRead(harness);
    expect(harness.comments.softDelete).toHaveBeenCalledWith(COMMENT_ID, AUTHOR);
  });

  it('lets the current item owner moderate any live comment', async () => {
    const harness = makeHarness();
    harness.comments.getById.mockResolvedValue(commentRef());
    harness.audience.ownsSubject.mockImplementation(
      async (viewerId, kind, subjectId) =>
        viewerId === OWNER && kind === 'portfolio' && subjectId === SUBJECT_ID,
    );

    await expect(harness.service.deleteComment(OWNER, COMMENT_ID)).resolves.toBeUndefined();

    expect(harness.comments.softDelete).toHaveBeenCalledWith(COMMENT_ID, OWNER);
  });

  it('does not let a third admitted viewer delete another author’s comment', async () => {
    const harness = makeHarness();
    harness.comments.getById.mockResolvedValue(commentRef());
    admit(harness, 'portfolio', [VIEWER]);

    await expectNotFound(harness.service.deleteComment(VIEWER, COMMENT_ID), 'COMMENT_NOT_FOUND');

    expect(harness.comments.softDelete).not.toHaveBeenCalled();
  });

  for (const [label, ref] of [
    ['unknown', undefined],
    ['tombstoned', commentRef({ deletedAt: CREATED_AT })],
  ] as const) {
    it(`rejects a ${label} comment deletion without an authorization or mutation`, async () => {
      const harness = makeHarness();
      harness.comments.getById.mockResolvedValue(ref);

      await expectNotFound(harness.service.deleteComment(AUTHOR, COMMENT_ID), 'COMMENT_NOT_FOUND');

      expect(harness.audience.ownsSubject).not.toHaveBeenCalled();
      expect(harness.comments.softDelete).not.toHaveBeenCalled();
    });
  }

  it('returns not found when the comment soft-delete loses a concurrent race', async () => {
    const harness = makeHarness();
    harness.comments.getById.mockResolvedValue(commentRef());
    harness.comments.softDelete.mockResolvedValue(false);

    await expectNotFound(harness.service.deleteComment(AUTHOR, COMMENT_ID), 'COMMENT_NOT_FOUND');

    expect(harness.comments.softDelete).toHaveBeenCalledWith(COMMENT_ID, AUTHOR);
  });

  for (const [label, ref] of [
    ['unknown', undefined],
    ['tombstoned', commentRef({ deletedAt: CREATED_AT })],
  ] as const) {
    it(`rejects a ${label} comment reaction before reaction reads or mutations`, async () => {
      const harness = makeHarness();
      harness.comments.getById.mockResolvedValue(ref);

      await expectNotFound(
        harness.service.toggleCommentReaction(VIEWER, COMMENT_ID, '👍'),
        'COMMENT_NOT_FOUND',
      );

      expectNoAudienceRead(harness);
      expect(harness.reactions.toggleComment).not.toHaveBeenCalled();
      expect(harness.reactions.summaryForComment).not.toHaveBeenCalled();
    });
  }

  it('rechecks a comment’s current parent audience before every reaction toggle', async () => {
    const harness = makeHarness();
    harness.comments.getById.mockResolvedValue(commentRef());
    let currentlyAdmitted = true;
    admitWhile(harness, 'portfolio', () => currentlyAdmitted);
    harness.reactions.summaryForComment.mockResolvedValue([
      { emoji: '👍', count: 1, reacted: true },
    ]);

    await expect(harness.service.toggleCommentReaction(VIEWER, COMMENT_ID, '👍')).resolves.toEqual({
      reactions: [{ emoji: '👍', count: 1, reacted: true }],
    });
    currentlyAdmitted = false;

    await expectNotFound(
      harness.service.toggleCommentReaction(VIEWER, COMMENT_ID, '👍'),
      'COMMENT_NOT_FOUND',
    );

    expect(harness.comments.getById).toHaveBeenCalledTimes(2);
    expect(harness.reactions.toggleComment).toHaveBeenCalledTimes(1);
    expect(harness.reactions.summaryForComment).toHaveBeenCalledTimes(1);
  });

  it('uses that same live access rule for item reactions', async () => {
    const harness = makeHarness();
    let currentlyAdmitted = true;
    admitWhile(harness, 'portfolio', () => currentlyAdmitted);
    harness.reactions.summaryForItem.mockResolvedValue([{ emoji: '🔥', count: 1, reacted: true }]);

    await expect(
      harness.service.toggleItemReaction(VIEWER, 'portfolio', SUBJECT_ID, '🔥'),
    ).resolves.toEqual({ reactions: [{ emoji: '🔥', count: 1, reacted: true }] });
    currentlyAdmitted = false;

    await expectNotFound(
      harness.service.toggleItemReaction(VIEWER, 'portfolio', SUBJECT_ID, '🔥'),
      'NOT_FOUND',
    );

    expect(harness.reactions.toggleItem).toHaveBeenCalledTimes(1);
    expect(harness.reactions.summaryForItem).toHaveBeenCalledTimes(1);
  });
});
