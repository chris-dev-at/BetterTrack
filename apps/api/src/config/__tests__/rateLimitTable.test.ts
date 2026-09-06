import { FRIEND_GROUP_MEMBERS_MAX } from '@bettertrack/contracts';
import { describe, expect, it } from 'vitest';

import type { ProgressiveSchedule } from '../../services/security/progressiveLimiter';
import { loadConfig, REQUEST_COST_KEYS } from '../env';

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

    // 1200 / 5 min = 240 writes/min sustained, per user (#1855). Modelled
    // heaviest five minutes of V5-P8 interaction = 345 writes → 3.5× headroom.
    // It exists so the ordinary writes V5-P8 hung on the anti-probing `social`
    // bucket — comments, reactions, moderation, friend circles — meter against a
    // ceiling sized by normal use instead of one sized against username probing.
    expect(shape(rateLimits.socialWrite)).toEqual({
      windowSec: 300,
      limit: 1200,
      ...GENERAL_LADDER,
    });

    expect(shape(rateLimits.vault)).toEqual({ windowSec: 60, limit: 60, ...GENERAL_LADDER });
    expect(shape(rateLimits.vaultRead)).toEqual({ windowSec: 60, limit: 600, ...GENERAL_LADDER });
    expect(shape(rateLimits.apiKey)).toEqual({ windowSec: 60, limit: 120, ...GENERAL_LADDER });

    // The COST dimension (#1643): 4000 WORK UNITS / min, per user, on the same
    // escalation ladder as `general` so the 429 envelope never differs. Raised
    // from 3000 in #1755 with the two V5-P6 reads that joined the table, from
    // 3500 in #1829 with the comment thread, and from 3550 in #1855 with the
    // thread's collapsed head and the audience write — the latter alongside a
    // floor that moved from 6 units to 7, which is what let the ceiling move at
    // all (see the weight floor asserted further down).
    expect(shape(rateLimits.expensive)).toEqual({
      windowSec: 60,
      limit: 4000,
      ...GENERAL_LADDER,
    });
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
    // Same rule for the social write budget (#1855): a bucket the app-wide
    // limiter would close first is a lie in the config.
    const socialWritePerMinute =
      (rateLimits.socialWrite.limit / rateLimits.socialWrite.windowSec) * 60;
    expect(generalPerMinute).toBeGreaterThanOrEqual(socialWritePerMinute);
  });
});

describe('§10 COST TABLE — weights for the expensive reads (#1643)', () => {
  /**
   * The MODELLED NORMAL-USE BAR for the unit budget: one active user
   * pessimistically doing all four expensive things inside the SAME minute.
   * Engineering estimates read off the client, exactly like the request-count
   * bar below — restated here so a weight edit has to be argued, not just made.
   */
  const COST_BAR = {
    /**
     * Builder weight-tuning: one debounced preview every ~3 s, in BASKET UNITS
     * per minute — `backtestPreview` is priced per 50 positions and the route
     * multiplies by ⌈positions / 50⌉ (#1877). A Builder draft is capped at 50
     * positions by §6.5, so every preview in this term is exactly one unit; a
     * blueprint detail page replaying a 250-asset flatten pays five, and is not
     * slider-driven.
     */
    backtestPreviewPerMinute: 20,
    /**
     * N-way comparison, in SERIES per minute — `backtestCompare` is priced per
     * series and the route multiplies by the series count (#1755). Two
     * deliberate three-basket comparisons: the page runs on an explicit
     * selection or range change, not on a slider, and its core is memoised
     * across every permutation of one set.
     */
    backtestComparePerMinute: 5,
    /**
     * Shared what-if sandbox. Deliberately a BROWSING minute, not a tuning one:
     * nobody drags a friend's sliders while also driving the Builder at 20
     * previews/min, and a viewer who does drag is bounded by this endpoint's own
     * allowance (140 req/min below), not by this term.
     */
    backtestSharedSandboxPerMinute: 2,
    /**
     * The Invest Calculator (#1877). A deliberate submit, not a slider: one
     * calculation plus two re-runs from changing the budget or toggling
     * whole-shares — the toggle re-runs the last calculation immediately.
     */
    conglomerateAllocatePerMinute: 3,
    /** Analytics range / filter / compare changes. */
    analyticsSeriesPerMinute: 12,
    /** Shared-with-me list on tab focus + reconnect refetch. */
    socialSharedPerMinute: 6,
    /**
     * Friend circles. Both surfaces that read them — /people and every
     * AudiencePicker open — share one 30 s-stale query key, so a minute of
     * hopping between them issues the request about twice.
     */
    socialGroupsPerMinute: 2,
    /**
     * Comment threads — the PAGE read and, since #1855, the collapsed head at
     * `…/thread/summary`, which is mounted with the same weight key because it
     * runs the same access resolution.
     *
     * Three shared items opened in the minute mount three collapsed heads; one
     * of them is expanded (one page read) and its 30 s poll ticks twice; and the
     * reader walks back one page. Seven reads.
     *
     * The poll term is what #1855 corrected. `CommentThread.tsx` polled through
     * a `useInfiniteQuery` with no `maxPages`, and TanStack v5 refetches EVERY
     * loaded page on a background refetch — so a reader who had clicked "load
     * older" nine times issued twenty reads a minute against a term that said
     * three, and the understatement grew with how far back they had paged. The
     * client now polls the newest window only, which is the behaviour this term
     * always assumed.
     */
    socialThreadPerMinute: 7,
    /**
     * Setting a shared item's audience (#1855). A deliberate, rare act: two in
     * the minute is a user reworking who can see a couple of items.
     */
    socialAudienceSetPerMinute: 2,
    /** Two CSV uploads. */
    importCreatePerMinute: 2,
    /** One bulk kind sweep over a statement's undecided rows (one PATCH each). */
    importRowResolvePerMinute: 20,
  };

  it('pins every weight, so a future edit is visible in a diff', () => {
    const { requestCosts } = config().rateLimits;
    // Exactly the declared cost-metered endpoints — a new key here means a new
    // route was given a weight, which is a decision to argue, not a detail.
    expect(Object.keys(requestCosts).sort()).toEqual([...REQUEST_COST_KEYS].sort());
    expect(requestCosts).toEqual({
      // Unbounded `Promise.all` fan-out over friends × shared items.
      socialShared: 10,
      // Groups + rosters + share counts in three grouped reads, bounded by the
      // friend-group ceilings (#1780) — cheaper than `socialShared`'s open
      // fan-out, and at the floor where the unit budget still binds before the
      // request COUNT limiter would. That floor is `expensive.limit / 600`, so
      // it moved from 6 to 7 with the ceiling in #1855.
      socialGroups: 7,
      // Two access resolutions, one bounded participant probe, an index-served
      // page and two grouped reaction aggregates — bounded work, but polled
      // every 30 s per open thread (#1829). At the same floor as `socialGroups`,
      // and shared since #1855 with the collapsed head at `…/thread/summary`,
      // which does all of that except fetch the page.
      socialThread: 7,
      // The owner's whole friendship set with no LIMIT, a group roster of up to
      // 200, a paranoid transition lock across the derived recipient set and one
      // notification emit each — the largest fan-out of any social write, and
      // until #1855 metered by nothing at all.
      socialAudienceSet: 20,
      // A perturbed weight vector is a cache MISS by construction; a miss walks
      // the positions' history sequentially through the provider layer. PER
      // 50-POSITION BASKET UNIT since #1877: the preview bound is now the
      // flatten bound (250), so one body can carry five drafts' worth of that
      // walk. A ≤ 50-position Builder preview still costs exactly this.
      backtestPreview: 25,
      // PER SERIES (#1755) — the route multiplies by the number of baskets the
      // body overlays, so a 6-way comparison spends 120. Just under a preview
      // each: the series share one de-duplicated asset fan-out.
      backtestCompare: 20,
      // A preview's engine run with no memo behind it, so every request pays.
      backtestSharedSandbox: 25,
      // The Invest Calculator (#1877), until then metered by nothing: one asset
      // read, one quote and one FX conversion for each of up to 250 RESOLVED
      // assets — the flatten bound, not the 50-position write cap. Under a
      // comparison series, which pays for the same fan-out plus an engine run.
      conglomerateAllocate: 15,
      // Series + optional compare series + contribution table, over a window
      // that ANALYTICS_MAX_RANGE_DAYS now bounds.
      analyticsSeries: 10,
      // The row classifier drives ≈450 pg_trgm scans per staged batch.
      importCreate: 100,
      // One call per row in the wizard's bulk sweep; each re-derives a row's
      // instrument, hash and duplicate verdict against the portfolio. At the
      // same floor as `socialGroups`.
      importRowResolve: 7,
    });
  });

  it('clears the modelled normal minute with at least 3x headroom', () => {
    const { expensive, requestCosts } = config().rateLimits;
    const worstMinute =
      COST_BAR.backtestPreviewPerMinute * requestCosts.backtestPreview +
      COST_BAR.backtestComparePerMinute * requestCosts.backtestCompare +
      COST_BAR.backtestSharedSandboxPerMinute * requestCosts.backtestSharedSandbox +
      COST_BAR.conglomerateAllocatePerMinute * requestCosts.conglomerateAllocate +
      COST_BAR.analyticsSeriesPerMinute * requestCosts.analyticsSeries +
      COST_BAR.socialSharedPerMinute * requestCosts.socialShared +
      COST_BAR.socialGroupsPerMinute * requestCosts.socialGroups +
      COST_BAR.socialThreadPerMinute * requestCosts.socialThread +
      COST_BAR.socialAudienceSetPerMinute * requestCosts.socialAudienceSet +
      COST_BAR.importCreatePerMinute * requestCosts.importCreate +
      COST_BAR.importRowResolvePerMinute * requestCosts.importRowResolve;
    // Pins the model's arithmetic, not a measurement: editing a term above has
    // to restate this number deliberately.
    expect(worstMinute).toBe(1318);
    expect(expensive.windowSec).toBe(60);
    expect(expensive.limit).toBeGreaterThanOrEqual(worstMinute * 3);
  });

  it('leaves no expensive endpoint outside the budget it is supposed to bound', () => {
    const { requestCosts } = config().rateLimits;
    // The two V5-P6 reads joined the table in #1755. Before that the most
    // expensive read in the app — an N-way comparison, up to six baskets each
    // flattening to 250 assets — spent nothing here, and `rateLimitNormalUse`
    // pinned the omission as "nothing else meters against expensive".
    expect(requestCosts.backtestCompare).toBeGreaterThan(0);
    expect(requestCosts.backtestSharedSandbox).toBeGreaterThan(0);
    // …and #1855 did the same for the audience write, whose per-recipient
    // fan-out was the largest of any V5-P8 write and metered by nothing.
    expect(requestCosts.socialAudienceSet).toBeGreaterThan(0);
    // …and #1877 for the Invest Calculator, the last V5-P6 read whose fan-out
    // follows the 250-asset flatten while `general` was its only guard.
    expect(requestCosts.conglomerateAllocate).toBeGreaterThan(0);
    // A preview of a full flatten is priced as the five drafts' worth of work it
    // is, so it can never cost less than the comparison of two baskets that
    // resolve to the same assets.
    expect(requestCosts.backtestPreview * 5).toBeGreaterThan(requestCosts.backtestCompare * 2);
    // A comparison is priced per SERIES, so the cheapest one (2 baskets) already
    // costs more than the strictly cheaper single-basket preview, and the
    // dearest (6) costs proportionally more than that.
    const cheapest = requestCosts.backtestCompare * 2;
    const dearest = requestCosts.backtestCompare * 6;
    expect(cheapest).toBeGreaterThan(requestCosts.backtestPreview);
    expect(dearest).toBe(cheapest * 3);
  });

  it('bounds a pathological caller by WORK before the request count would', () => {
    const { expensive, general, requestCosts } = config().rateLimits;
    const generalPerMinute = (general.limit / general.windowSec) * 60;
    for (const [endpoint, units] of Object.entries(requestCosts)) {
      // Requests per minute a caller doing nothing but this endpoint gets
      // through before the unit budget refuses it. If this ever climbed above
      // `general`'s allowance the cost dimension would be decorative: the count
      // limiter would trip first and the weight would mean nothing.
      const requestsBeforeCost = expensive.limit / units;
      expect(requestsBeforeCost, endpoint).toBeLessThan(generalPerMinute);
      // …and no weight may be so heavy that the modelled normal rate cannot be
      // sustained: every endpoint keeps at least 3× its own bar on its own.
      expect(requestsBeforeCost, endpoint).toBeGreaterThanOrEqual(
        3 * COST_BAR[`${endpoint as keyof typeof requestCosts}PerMinute`],
      );
    }
  });

  it('reuses the general escalation ladder, so the 429 contract is identical', () => {
    const { expensive, general } = config().rateLimits;
    expect(expensive.cooldownsSec).toEqual(general.cooldownsSec);
    expect(expensive.decaySec).toBe(general.decaySec);
    expect(expensive.retainCountOnViolation).toBeUndefined();
  });
});

/**
 * The MODELLED NORMAL-USE BAR for the V5-P8 interaction surface (#1855).
 *
 * V5-P8 hung four ordinary writes — comments, item reactions, comment
 * reactions, comment moderation — plus the whole friend-circle surface on
 * `social`, which §10 lists in the STRICT set and therefore EXEMPTS from the
 * sizing rule. The result was a bucket normal use could reach that nothing had
 * ever sized: filling the 200-member circle the contract advertises took ~7
 * hours of perfectly paced clicking, and spent the same counter that answers
 * "may I send a friend request?".
 *
 * This table is the fix's other half. Every ordinary V5-P8 interaction is listed
 * with the bucket it meters on, so moving one back onto a strict bucket fails
 * the first assertion below rather than silently shipping an unsized ceiling.
 */
describe('§10 — the V5-P8 interaction bar (#1855)', () => {
  /** The §10 strict set, by config key. NOT sized by normal use. */
  const STRICT_BUCKETS = ['social', 'feedback', 'feedbackThread', 'loginIp', 'loginAccount'];

  /**
   * One row per ordinary V5-P8 interaction: what it is, which bucket meters it,
   * and how many of it one active user reaches inside that bucket's window.
   * Engineering estimates read off the client, exactly like the bars above.
   */
  const V5_P8_INTERACTIONS = [
    {
      what: 'fill one circle to FRIEND_GROUP_MEMBERS_MAX, one click per member',
      bucket: 'socialWrite',
      perWindow: 200,
    },
    {
      what: 'curate circles: create / rename / delete, and remove members',
      bucket: 'socialWrite',
      perWindow: 20,
    },
    { what: 'a lively thread, a comment every ~12 s', bucket: 'socialWrite', perWindow: 25 },
    {
      what: 'an item owner moderating a spam flood off their portfolio',
      bucket: 'socialWrite',
      perWindow: 40,
    },
    {
      what: 'the six item chips plus the six on each of a few comments, toggled',
      bucket: 'socialWrite',
      perWindow: 60,
    },
  ] as const;

  it('never meters an ordinary interaction on a bucket the sizing rule exempts', () => {
    for (const interaction of V5_P8_INTERACTIONS) {
      // A strict bucket is an ABUSE control. If normal use reaches one, §10 says
      // the client gets fixed — so an ordinary interaction may never name one.
      expect(STRICT_BUCKETS, interaction.what).not.toContain(interaction.bucket);
    }
  });

  it('clears the modelled window of every bucket it reaches with at least 3x headroom', () => {
    const { rateLimits } = config();
    const barByBucket = new Map<string, number>();
    for (const interaction of V5_P8_INTERACTIONS) {
      barByBucket.set(
        interaction.bucket,
        (barByBucket.get(interaction.bucket) ?? 0) + interaction.perWindow,
      );
    }
    // Every bucket the surface reaches is present, and every one is sized.
    expect([...barByBucket.keys()]).toEqual(['socialWrite']);
    for (const [bucket, bar] of barByBucket) {
      const schedule = (rateLimits as unknown as Record<string, ProgressiveSchedule>)[bucket]!;
      expect(schedule, bucket).toBeDefined();
      expect(schedule.limit, bucket).toBeGreaterThanOrEqual(bar * 3);
    }
    // Pins the model's arithmetic: editing a row above has to restate this.
    expect(barByBucket.get('socialWrite')).toBe(345);
  });

  it('makes the advertised 200-member circle reachable one request at a time', () => {
    const { rateLimits } = config();
    // There is no bulk add endpoint, so the contract's ceiling is only reachable
    // one POST at a time — and has to fit inside ONE window, or it is decorative.
    expect(FRIEND_GROUP_MEMBERS_MAX).toBe(200);
    expect(rateLimits.socialWrite.limit).toBeGreaterThanOrEqual(FRIEND_GROUP_MEMBERS_MAX);
    // The regression this row exists to prevent: on the anti-probing bucket a
    // single circle could not be filled inside an hour, let alone one window.
    expect(rateLimits.social.limit).toBeLessThan(FRIEND_GROUP_MEMBERS_MAX);
  });

  it('keeps the interaction budget in its own namespace, on the general ladder', () => {
    const { rateLimits } = config();
    // A capacity limiter: a short first pause that only climbs on repeats. If
    // this ever inherited the strict ladder it would be an abuse control again.
    expect(rateLimits.socialWrite.cooldownsSec).toEqual(rateLimits.general.cooldownsSec);
    expect(rateLimits.socialWrite.decaySec).toBe(rateLimits.general.decaySec);
    expect(rateLimits.socialWrite.retainCountOnViolation).toBeUndefined();
    // …and it is genuinely a different budget from the one it was carved out of.
    expect(rateLimits.socialWrite.limit).not.toBe(rateLimits.social.limit);
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
   * The DOCUMENTED MODEL of the SPA's request shape — one active user, two tabs.
   *
   * These are engineering estimates derived by reading the client (widget
   * fan-out, TanStack polling intervals, the search debounce and its enrichment
   * poll), NOT numbers captured from a running browser or a production trace.
   * They are restated here so that a future limiter edit is argued against a
   * written-down model instead of a feeling — and so that the model itself can
   * be challenged and corrected in one place when someone does measure it.
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

  it('clears the modelled worst 30 seconds with at least 3x headroom', () => {
    const { generalBurst } = config().rateLimits;
    const worst30s = BAR.coldLoadPerTab * 2 + BAR.navigation + BAR.search + BAR.invalidateAll;
    // Pins the model's arithmetic, not a measurement: if someone edits a term
    // above, this number has to be restated deliberately.
    expect(worst30s).toBe(188);
    expect(generalBurst.windowSec).toBe(30);
    expect(generalBurst.limit).toBeGreaterThanOrEqual(worst30s * 3);
  });

  it('clears the modelled worst 15 minutes with at least 3x headroom', () => {
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
