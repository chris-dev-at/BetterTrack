import type { HomeLayout, HomeLayoutResponse } from '@bettertrack/contracts';

import type { UserRepository } from '../../data/repositories/userRepository';

/**
 * The Home widget board, per account (R2 home-widgets).
 *
 * A verbatim store, on purpose: the board's widget vocabulary belongs to the
 * SPA and changes with every web deploy, so this service reads and writes the
 * document without interpreting a single field of it. The contract
 * (`homeLayoutSchema`) has already bounded its shape and size before anything
 * reaches here; there is deliberately no place in this file where an unknown
 * widget type could be dropped.
 *
 * Every operation is `user_id`-scoped in the repository (§10) — the id always
 * comes from the session, never from the request body.
 */
export interface HomeLayoutServiceDeps {
  userRepo: UserRepository;
}

export interface HomeLayoutService {
  get(userId: string): Promise<HomeLayoutResponse>;
  /** Replace the board, or clear it with `null`. Bumps the revision either way. */
  set(userId: string, layout: HomeLayout | null): Promise<HomeLayoutResponse>;
}

export function createHomeLayoutService(deps: HomeLayoutServiceDeps): HomeLayoutService {
  const { userRepo } = deps;

  return {
    async get(userId) {
      const row = await userRepo.findHomeLayout(userId);
      return {
        // Cast rather than re-parse: the document was validated on the way in,
        // and re-validating on read would let a cap tightened in a later build
        // turn an already-stored board into a 500 for its owner.
        layout: (row.layout as HomeLayout | null) ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null,
      };
    },

    async set(userId, layout) {
      const updatedAt = await userRepo.setHomeLayout(userId, layout);
      return { layout, updatedAt: updatedAt?.toISOString() ?? null };
    },
  };
}
