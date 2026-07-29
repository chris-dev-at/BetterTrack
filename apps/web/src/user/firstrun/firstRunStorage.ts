/**
 * First-run wizard progress, persisted client-side (`/welcome`).
 *
 * There is deliberately NO server flag for onboarding completion — nothing in
 * `MeResponse` or `AccountSettingsResponse` records it, and inventing one would
 * mean a schema change this workstream does not own. The wizard's own memory is
 * therefore purely local: which steps the user actually completed or skipped,
 * and whether the run has been closed out.
 *
 * That makes this record advisory, never a gate: it decides what the Done
 * summary reads back and nothing else. Every real setting the wizard touches
 * (PIN, 2FA, locale, base currency, tax mode, public profile) is stored
 * server-side by its own endpoint, so a cleared browser loses the summary, not
 * the setup. Storage failures degrade to "nothing recorded" and never throw —
 * the same contract as `rememberedAccount.ts`.
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

const EMPTY: FirstRunState = { done: false, steps: {} };

function isStatus(value: unknown): value is FirstRunStepStatus {
  return value === 'complete' || value === 'skipped';
}

/**
 * Read the persisted run. Anything unparseable, non-object or shaped wrong
 * reads as a fresh run rather than throwing — a hand-edited or half-written
 * record must never be able to break `/welcome`.
 */
export function readFirstRun(): FirstRunState {
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
    const record = parsed as { done?: unknown; steps?: unknown };
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

function write(state: FirstRunState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable/full: the run simply isn't remembered.
  }
}

/** Record how one step ended. Returns the state as written. */
export function markFirstRunStep(id: FirstRunStepId, status: FirstRunStepStatus): FirstRunState {
  const current = readFirstRun();
  const next: FirstRunState = { ...current, steps: { ...current.steps, [id]: status } };
  write(next);
  return next;
}

/** Close the run out — from the last step or from "Do this later". */
export function markFirstRunDone(): FirstRunState {
  const next: FirstRunState = { ...readFirstRun(), done: true };
  write(next);
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
