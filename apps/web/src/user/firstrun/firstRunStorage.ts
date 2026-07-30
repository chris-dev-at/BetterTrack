/**
 * First-run wizard progress, persisted client-side (`/welcome`).
 *
 * Completion itself lives on the server (`users.first_run_completed_at`,
 * migration 0074). This record is the local companion: which steps the user
 * completed or skipped, plus a `done` flag that stops a failed completion call
 * from bouncing the user straight back into setup.
 *
 * **It is scoped to ONE account.** The record carries the account it belongs to
 * and reads as empty for anybody else — without that, a browser where someone
 * once pressed "Do this later" would skip setup for every account created on it
 * afterwards, which is exactly the bug the owner hit.
 *
 * Every real setting the wizard touches (PIN, 2FA, locale, base currency, tax
 * mode, public profile) is stored server-side by its own endpoint, so a cleared
 * browser loses the summary, not the setup. Storage failures degrade to "nothing
 * recorded" and never throw — the same contract as `rememberedAccount.ts`.
 */

import { FIRST_RUN_STEP_META } from './stepMeta';
import type { FirstRunStepId, FirstRunStepStatus } from './types';

const STORAGE_KEY = 'bt.firstrun.v1';

/** The ids the registry currently declares — anything else is stale or forged. */
const KNOWN_IDS: ReadonlySet<string> = new Set(FIRST_RUN_STEP_META.map((meta) => meta.id));

export interface FirstRunState {
  /** The run has been closed out — by finishing, or by "Do this later". */
  done: boolean;
  steps: Partial<Record<FirstRunStepId, FirstRunStepStatus>>;
}

/** The account a record belongs to; anything else reads as a fresh run. */
export type FirstRunAccountId = string | null | undefined;

const EMPTY: FirstRunState = { done: false, steps: {} };

function isStatus(value: unknown): value is FirstRunStepStatus {
  return value === 'complete' || value === 'skipped';
}

/**
 * Read the persisted run. Anything unparseable, non-object or shaped wrong
 * reads as a fresh run rather than throwing — a hand-edited or half-written
 * record must never be able to break `/welcome`.
 */
export function readFirstRun(accountId: FirstRunAccountId): FirstRunState {
  if (!accountId) return EMPTY;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    const record = parsed as { account?: unknown; done?: unknown; steps?: unknown };
    // Somebody else's run (or a pre-scoping record): not this account's business.
    if (record.account !== accountId) return EMPTY;
    const steps: FirstRunState['steps'] = {};
    if (record.steps && typeof record.steps === 'object') {
      for (const [key, value] of Object.entries(record.steps as Record<string, unknown>)) {
        // Both the id and the status are checked against what the registry
        // declares today, so a step that was renamed or removed cannot linger
        // in the summary and a hand-edited value cannot smuggle itself in.
        if (KNOWN_IDS.has(key) && isStatus(value)) steps[key as FirstRunStepId] = value;
      }
    }
    return { done: record.done === true, steps };
  } catch {
    return EMPTY;
  }
}

function write(accountId: FirstRunAccountId, state: FirstRunState): void {
  if (!accountId) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ account: accountId, ...state }));
  } catch {
    // Storage unavailable/full: the run simply isn't remembered.
  }
}

/** Record how one step ended. Returns the state as written. */
export function markFirstRunStep(
  accountId: FirstRunAccountId,
  id: FirstRunStepId,
  status: FirstRunStepStatus,
): FirstRunState {
  const current = readFirstRun(accountId);
  const next: FirstRunState = { ...current, steps: { ...current.steps, [id]: status } };
  write(accountId, next);
  return next;
}

/** Close the run out — from the last step or from "Do this later". */
export function markFirstRunDone(accountId: FirstRunAccountId): FirstRunState {
  const next: FirstRunState = { ...readFirstRun(accountId), done: true };
  write(accountId, next);
  return next;
}

/** Drop the record entirely (used by tests and a full re-run). */
export function clearFirstRun(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Non-fatal — see write().
  }
}
