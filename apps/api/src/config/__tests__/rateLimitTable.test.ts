import { describe, expect, it } from 'vitest';

import type { ProgressiveSchedule } from '../../services/security/progressiveLimiter';
import { loadConfig } from '../env';

/**
 * Pins the §10 LIMITER TABLE (see the block comment above `rateLimits` in
 * `env.ts`) so that every future edit to a ceiling is VISIBLE in a diff instead
 * of arriving as a silent loosening.
 *
 * The table is split in two on purpose:
 *
 *  - CAPACITY limiters exist to keep one account from overloading the API.
 *    Normal use must clear them by ≥3× (owner directive 2026-09-02, §16), so
 *    they are expected to move when the app's request shape changes — and each
 *    move has to be argued here, next to the modelled bar it is sized against.
 *
 *  - STRICT limiters are ABUSE controls: credential stuffing, username probing,
 *    owner-queue spam. They are NOT sized by normal use, and the 2026-09-02
 *    pass deliberately left every one of them exactly as it was. Raising one is
 *    a security decision, so it fails this file first.
 */

/** A minimal valid production env — the defaults ARE the production control. */
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  SESSION_SECRET: 'a-sufficiently-long-secret-value',
  BT_DATA_ENCRYPTION_KEY_ID: 'test-current',
  BT_DATA_ENCRYPTION_KEY: 'test-record-encryption-material-at-least-32-characters',
};

const config = () => loadConfig(env);

const shape = (schedule: ProgressiveSchedule) => ({
  windowSec: schedule.windowSec,
  limit: schedule.limit,
  cooldownsSec: [...schedule.cooldownsSec],
  decaySec: schedule.decaySec,
  ...(schedule.retainCountOnViolation ? { retainCountOnViolation: true } : {}),
});

/** The general escalation ladder: a short first pause that only climbs on repeats. */
const GENERAL_LADDER = { cooldownsSec: [20, 60, 180, 600], decaySec: 900 };
/** The security ladder: a longer first pause, climbing to an hour. */
const STRICT_LADDER = { cooldownsSec: [60, 300, 900, 3600], decaySec: 900 };
/** The auth ladder (§6.1). */
const AUTH_LADDER = { cooldownsSec: [30, 300, 600, 900], decaySec: 900 };

describe('§10 limiter table — capacity limiters', () => {
  it('matches the documented ceilings exactly', () => {
    const { rateLimits } = config();

    // 9000 / 15 min = 600 req/min sustained, per user. Modelled two-tab bar for
    // the heaviest realistic 15 minutes = 1576 requests → 5.7× headroom.
    expect(shape(rateLimits.general)).toEqual({
      windowSec: 900,
      limit: 9000,
      ...GENERAL_LADDER,
    });

    // 600 / 30 s. Modelled worst realistic 30 s ≈ 200 requests (two tabs cold-
    // loading a widget board, plus a navigation and a search) → 3× headroom.
    expect(shape(rateLimits.generalBurst)).toEqual({
      windowSec: 30,
      limit: 600,
      ...GENERAL_LADDER,
    });

    // 300 / min. One deliberate asset search costs up to ~24 requests in 15 s
    // (debounced prefixes × the 1.5 s enrichment poll) → ~96 for a busy minute
    // → 3× headroom. Cheap bounded read: answered from Postgres only.
    expect(shape(rateLimits.search)).toEqual({
      windowSec: 60,
      limit: 300,
      ...GENERAL_LADDER,
    });

    expect(shape(rateLimits.vault)).toEqual({ windowSec: 60, limit: 60, ...GENERAL_LADDER });
    expect(shape(rateLimits.vaultRead)).toEqual({ windowSec: 60, limit: 600, ...GENERAL_LADDER });
    expect(shape(rateLimits.apiKey)).toEqual({ windowSec: 60, limit: 120, ...GENERAL_LADDER });
  });

  it('lets the burst window absorb a spike without raising the sustained rate above it', () => {
    const { rateLimits } = config();
    const burstPerSecond = rateLimits.generalBurst.limit / rateLimits.generalBurst.windowSec;
    const steadyPerSecond = rateLimits.general.limit / rateLimits.general.windowSec;

    // The burst dimension is a SPIKE allowance: it must sit above the sustained
    // rate, or it becomes the de-facto steady-state ceiling and the 15-minute
    // window stops meaning anything.
    expect(burstPerSecond).toBeGreaterThan(steadyPerSecond);
    // …but not so far above that a caller can hold burst rate indefinitely: the
    // steady window has to catch a sustained hammer inside its own window.
    const secondsToExhaustSteadyAtBurstRate = rateLimits.general.limit / burstPerSecond;
    expect(secondsToExhaustSteadyAtBurstRate).toBeLessThan(rateLimits.general.windowSec);
  });

  it('gives the vault read budget room to actually be spent', () => {
    const { rateLimits } = config();
    // Regression guard: `vaultRead` was 600/min while the app-wide `general`
    // limiter capped every caller at 300/min first, so the dedicated read
    // allowance could never be reached. A per-family budget the global limiter
    // swallows is a lie in the config.
    const generalPerMinute = (rateLimits.general.limit / rateLimits.general.windowSec) * 60;
    const vaultReadPerMinute = (rateLimits.vaultRead.limit / rateLimits.vaultRead.windowSec) * 60;
    expect(generalPerMinute).toBeGreaterThanOrEqual(vaultReadPerMinute);
  });
});

describe('§10 limiter table — STRICT limiters (unchanged by the 2026-09-02 pass)', () => {
  it('keeps the credential-stuffing controls exactly where they were', () => {
    const { rateLimits } = config();

    // Per-IP login attempts. The default IS the production control (§6.1).
    expect(shape(rateLimits.loginIp)).toEqual({ windowSec: 60, limit: 25, ...AUTH_LADDER });

    // Per-account failed-credential tracking. This schedule ALSO backs every
    // re-auth ladder — data export, account deletion, 2FA disable, PIN token,
    // passkey re-auth, Google mobile link, paranoid discard / vault delete /
    // portfolio move-in / move-out — so a single edit here loosens all of them.
    expect(shape(rateLimits.loginAccount)).toEqual({
      windowSec: 900,
      limit: 10,
      ...AUTH_LADDER,
    });
  });

  it('keeps the anti-probing and anti-spam controls exactly where they were', () => {
    const { rateLimits } = config();

    // Friend-request creation reveals a target's username (§6.9).
    expect(shape(rateLimits.social)).toEqual({ windowSec: 3600, limit: 30, ...STRICT_LADDER });

    // Feedback capture: five per hour per author, and an exhausted counter is
    // RETAINED so a short cooldown cannot reopen the hourly allowance (#1315).
    expect(shape(rateLimits.feedback)).toEqual({
      windowSec: 3600,
      limit: 5,
      retainCountOnViolation: true,
      ...STRICT_LADDER,
    });

    // Support-thread replies: a conversation budget, deliberately not capture.
    expect(shape(rateLimits.feedbackThread)).toEqual({
      windowSec: 3600,
      limit: 60,
      ...STRICT_LADDER,
    });
  });

  it('never lets a strict limiter drift onto the permissive general ladder', () => {
    const { rateLimits } = config();
    for (const strict of [
      rateLimits.social,
      rateLimits.feedback,
      rateLimits.feedbackThread,
      rateLimits.loginIp,
      rateLimits.loginAccount,
    ]) {
      // The general ladder opens with a 20 s pause; every strict schedule has to
      // open with a materially longer one.
      expect(strict.cooldownsSec[0]).toBeGreaterThanOrEqual(30);
    }
  });
});

describe('§10 limiter table — the modelled normal-use bar', () => {
  /**
   * The measured request shape of the real SPA, one active user, two tabs. Each
   * number is evidence-backed (see the §10 LIMITER TABLE comment in `env.ts`);
   * they are restated here so a future limiter edit is checked against the bar
   * rather than against a feeling.
   */
  const BAR = {
    /** Cold dashboard load, 10-widget board, N=5 portfolios, per tab. */
    coldLoadPerTab: 50,
    /** A portfolio navigation on top of that. */
    navigation: 14,
    /** One deliberate asset search: debounced prefixes × enrichment polls. */
    search: 24,
    /** An unkeyed `invalidateQueries()` replays a cold load in one tick. */
    invalidateAll: 50,
    /** Idle polling for a paranoid account, per tab, per minute. */
    idlePerTabPerMinute: 8,
  };

  it('clears the worst realistic 30 seconds with at least 3x headroom', () => {
    const { generalBurst } = config().rateLimits;
    const worst30s = BAR.coldLoadPerTab * 2 + BAR.navigation + BAR.search + BAR.invalidateAll;
    expect(worst30s).toBe(188);
    expect(generalBurst.windowSec).toBe(30);
    expect(generalBurst.limit).toBeGreaterThanOrEqual(worst30s * 3);
  });

  it('clears the worst realistic 15 minutes with at least 3x headroom', () => {
    const { general } = config().rateLimits;
    // Two tabs, both signed in, for a quarter of an hour of hard use.
    const idle = BAR.idlePerTabPerMinute * 2 * 15;
    // One tab parked in a chat thread scrolled back five pages: the infinite
    // query refetches EVERY loaded page on its 10 s tick (~43 req/min).
    const chatPolling = 43 * 15;
    // The other tab browsing: fifteen page loads / navigations.
    const browsing = 15 * 25;
    const searching = BAR.search * 4;
    // Every portfolio write invalidates prefix-wide, so a mutation costs itself
    // plus the page's refetches.
    const mutations = 20 * 6;
    // A data export builds in the background, polled every 3 s for five minutes.
    const exportPolling = 20 * 5;
    const worst15m = idle + chatPolling + browsing + searching + mutations + exportPolling;
    expect(worst15m).toBe(1576);
    expect(general.windowSec).toBe(900);
    expect(general.limit).toBeGreaterThanOrEqual(worst15m * 3);
    // The pre-2026-09-02 ceiling did NOT clear the bar — this is the regression
    // this row exists to prevent anyone from reintroducing.
    expect(4500).toBeLessThan(worst15m * 3);
  });

  it('still trips a genuine reload flood well inside the burst window', () => {
    const { generalBurst } = config().rateLimits;
    // A page reload costs at least a bootstrap wave; a human mashing reload does
    // roughly one per second. The burst guard has to notice inside its window.
    const reloadsToTrip = Math.ceil(generalBurst.limit / BAR.coldLoadPerTab);
    expect(reloadsToTrip).toBeLessThanOrEqual(generalBurst.windowSec);
  });
});
