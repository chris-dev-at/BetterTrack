import type { FeedbackCategory, FeedbackStatus } from '@bettertrack/contracts';

import type { Tone } from '../components/tokens';

/**
 * Shared vocabulary for the Support workspace (#1406 W3).
 *
 * Tone maps live here rather than in a component so the inbox row and the
 * thread header cannot drift into calling the same status two different
 * colours — which is precisely how a queue stops being scannable.
 */

/** Category colour. Carried over from the W1 inbox so nothing recolours. */
export const CATEGORY_TONE: Record<FeedbackCategory, Tone> = {
  feature: 'sky',
  bug: 'red',
  other: 'neutral',
  help: 'amber',
  improvement: 'green',
};

/**
 * Status colour, read as "does this need me": amber for anything owing the
 * operator work, green for a shipped outcome, red for a declined one, neutral
 * once it is parked.
 */
export const STATUS_TONE: Record<FeedbackStatus, Tone> = {
  new: 'amber',
  triaged: 'sky',
  working_on_it: 'amber',
  saved_as_future_idea: 'neutral',
  declined: 'red',
  shipped: 'green',
};

/**
 * Whole seconds between an ISO stamp and now, floored at zero.
 *
 * Clamping matters: a server clock a second ahead of the browser otherwise
 * renders a negative age, and `formatDuration` would turn that into a
 * confidently wrong "0 s" beside a row that is genuinely days old. Returns null
 * for an unparseable stamp so the caller can omit the age rather than print
 * `NaN`.
 */
export function ageSeconds(iso: string, now: number = Date.now()): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now - at) / 1000));
}

/**
 * The six-key diagnostics allowlist (#1316). Anything else a client sends is
 * dropped rather than rendered: the context object is deliberately extensible
 * on the wire, and an admin surface that printed every key would turn that
 * convenience into an unreviewed display surface.
 */
export const DIAGNOSTIC_KEYS = [
  'platform',
  'appVersion',
  'osVersion',
  'device',
  'locale',
  'screen',
] as const;

export type DiagnosticKey = (typeof DIAGNOSTIC_KEYS)[number];

/** Only string/finite-number values survive; blanks are not facts worth a row. */
export function diagnosticEntries(
  context: Readonly<Record<string, unknown>> | null,
): Array<[DiagnosticKey, string]> {
  if (!context) return [];
  return DIAGNOSTIC_KEYS.flatMap<[DiagnosticKey, string]>((key) => {
    const value = context[key];
    if (typeof value === 'string' && value.trim() !== '') return [[key, value]];
    if (typeof value === 'number' && Number.isFinite(value)) return [[key, String(value)]];
    return [];
  });
}
