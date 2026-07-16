import { z } from 'zod';

import {
  backtestBenchmarkInputSchema,
  backtestModeSchema,
  backtestPreviewRangeSchema,
  rebalanceFrequencySchema,
} from './backtest';

/**
 * Ideas — saved & shareable Workboard analyses (PROJECTPLAN.md §13.4 V4-P9).
 *
 * An idea persists a **named Workboard state** so it can be reopened later
 * exactly as saved, or shared with friends read-only for them to clone. The
 * saved state is either a reference to one of the owner's conglomerates OR an
 * ad-hoc weighted asset set, plus the backtest parameters (range, benchmark,
 * late-listing mode, rebalance schedule) — the same knobs `POST /backtest/preview`
 * speaks (§6.6, V4-P7) — plus a free-text thesis note.
 *
 * Ideas are the **fourth shareable kind** and route through the ONE audience
 * model (`private` default → `specific_friends` → `all_friends` → `public_link`,
 * §13.3 V3-P5): audience is set via `PUT /social/audience/idea/:subjectId` and
 * enforced on EVERY read, never cached, never a parallel path. The workboard
 * state itself lives here; sharing/enforcement lives in `social.ts`.
 */

/** Free-text thesis note cap — one paragraph of rationale. */
export const IDEA_THESIS_MAX = 4000;
/** Idea name cap (mirrors conglomerate/portfolio naming). */
export const IDEA_NAME_MAX = 120;
/** Max ad-hoc positions in a saved idea (mirrors the backtest basket cap). */
export const IDEA_ADHOC_MAX = 50;

/**
 * One ad-hoc basket member of a saved idea: an asset and its relative weight.
 * Weights are relative (normalised by the engine when reopened), so any positive
 * number is valid — identical to a backtest-preview position.
 */
export const ideaAdhocPositionSchema = z
  .object({
    assetId: z.string().uuid(),
    weight: z.number().finite().gt(0, 'Weight must be greater than 0.'),
  })
  .strict();
export type IdeaAdhocPosition = z.infer<typeof ideaAdhocPositionSchema>;

/**
 * What a saved idea's basket comes from — EXACTLY one of:
 *  - `conglomerate` — a reference to one of the owner's own conglomerates;
 *  - `adhoc` — an inline weighted asset set the owner assembled directly.
 * A discriminated union so a stored state can never be ambiguous, and reopening
 * dispatches on `kind` without guessing.
 */
export const ideaSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conglomerate'), conglomerateId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('adhoc'),
      positions: z.array(ideaAdhocPositionSchema).min(1).max(IDEA_ADHOC_MAX),
    })
    .strict(),
]);
export type IdeaSource = z.infer<typeof ideaSourceSchema>;

/**
 * The exact Workboard state a saved idea reproduces (V4-P9): the basket source
 * plus the backtest parameters. Reopening an idea rebuilds the Workboard from
 * this verbatim — a roundtrip (save → reopen) is deep-equal by contract.
 */
export const ideaWorkboardStateSchema = z
  .object({
    source: ideaSourceSchema,
    /** Backtest range preset (§6.5). */
    range: backtestPreviewRangeSchema,
    /** Benchmark choice, or none (V4-P7). */
    benchmark: backtestBenchmarkInputSchema.nullable(),
    /** Late-listing mode (§14). */
    mode: backtestModeSchema,
    /** Scheduled-rebalance frequency (V4-P7). */
    rebalance: rebalanceFrequencySchema,
  })
  .strict();
export type IdeaWorkboardState = z.infer<typeof ideaWorkboardStateSchema>;

/** A saved idea as returned to its owner (or a clone author). */
export const ideaSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /** Free-text rationale; `null` when none was written. */
    thesis: z.string().nullable(),
    state: ideaWorkboardStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Idea = z.infer<typeof ideaSchema>;

/** `GET /ideas` response — the caller's saved ideas, newest first. */
export const ideaListResponseSchema = z.object({ ideas: z.array(ideaSchema) }).strict();
export type IdeaListResponse = z.infer<typeof ideaListResponseSchema>;

/** `POST /ideas` body — persist a named Workboard state + optional thesis. */
export const createIdeaRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(IDEA_NAME_MAX),
    thesis: z.string().trim().max(IDEA_THESIS_MAX).nullish(),
    state: ideaWorkboardStateSchema,
  })
  .strict();
export type CreateIdeaRequest = z.infer<typeof createIdeaRequestSchema>;

/** `PATCH /ideas/:ideaId` body — rename, re-note, or re-save the state. */
export const updateIdeaRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(IDEA_NAME_MAX).optional(),
    thesis: z.string().trim().max(IDEA_THESIS_MAX).nullish(),
    state: ideaWorkboardStateSchema.optional(),
  })
  .strict();
export type UpdateIdeaRequest = z.infer<typeof updateIdeaRequestSchema>;

/** `POST /ideas` / `PATCH /ideas/:ideaId` / `POST /ideas/:ideaId/clone` response. */
export const ideaResponseSchema = z.object({ idea: ideaSchema }).strict();
export type IdeaResponse = z.infer<typeof ideaResponseSchema>;

/** Route params for the single-idea endpoints. */
export const ideaIdParamSchema = z.object({ ideaId: z.string().uuid() }).strict();
export type IdeaIdParam = z.infer<typeof ideaIdParamSchema>;
