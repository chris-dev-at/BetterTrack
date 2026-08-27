/**
 * FAILURE-ARTIFACT SECRET HYGIENE — the mechanism, measured rather than assumed.
 *
 * Shared by every spec that puts real key material into the DOM: PD9
 * (`paranoid.spec.ts`) and E10 (`paranoid-e10.spec.ts`) today. It lives in a
 * neutral module rather than beside either one's harness because the hazard is a
 * property of the RUNNER, not of a particular epic — a third secret-bearing spec
 * needs it on day one.
 *
 * The obvious protection is `assertNoPd9Secrets`, which those arcs run in their
 * `finally`. Two things it CANNOT do were measured against Playwright 1.61.1,
 * and pretending otherwise is how key material ships to a GitHub artifact:
 *
 *  1. **`error-context.md` is written after the scan.** The runner writes it
 *     from `ArtifactsRecorder` during FIXTURE TEARDOWN — strictly after the test
 *     body's own `finally`, so the scan of `testInfo.outputDir` runs before the
 *     file exists and can never see it.
 *  2. **`testInfo.errors` is EMPTY at scan time.** Measured: a `test.step` whose
 *     locator assertion fails, caught in the body, reports
 *     `testInfo.errors.length === 0` inside that same `finally`. The runner
 *     records the failure only once the test function rejects. So the scan's
 *     coverage of error TEXT is real only for errors pushed before it runs —
 *     never for the body failure that produced the artifact.
 *
 * The artifact is therefore protected by SUPPRESSION, not by the scan, and it
 * takes two switches because Playwright has two independent producers of the
 * aria snapshot that prints input values (`type="password"` included) and a
 * rendered BIP39 word list:
 *
 *  - **Teardown fallback** — `ArtifactsRecorder._takePageSnapshot()`, disabled by
 *    `PLAYWRIGHT_NO_COPY_PROMPT`, set at config load in `playwright.config.ts`
 *    and again in `e2e-nightly.yml`. Covers non-matcher failures: a helper
 *    `throw`, a hook error, a test timeout.
 *  - **The matcher itself** — a failing `expect(locator)` carries an aria
 *    snapshot on the thrown error (`matcherResult.ariaSnapshot`), which the
 *    runner copies to `TestError.errorContext` and `buildErrorContext` renders
 *    as a YAML block. Playwright 1.61.1 exposes NO switch for it, so each arc
 *    strips it before rethrowing — {@link withoutMatcherAriaSnapshot}.
 *
 * Measured by forcing a failure while a real secret was in the DOM, counting
 * cleartext hits in `error-context.md`:
 *
 * | failure kind | neither switch | env var only | env var + strip |
 * | ------------ | -------------- | ------------ | --------------- |
 * | failed matcher | leaks (YAML)  | leaks (YAML) | **clean**       |
 * | plain throw / timeout | leaks (`# Page snapshot`) | **clean** | **clean** |
 *
 * Both rows were reproduced against the real specs, not only a probe: E10's
 * ceremony step leaked all twelve BIP39 words with the env var alone, and PD9's
 * Drive-only arc leaked the `fillPd9Secret` passphrase the same way. Both read
 * zero with the strip in place.
 *
 * RESIDUAL, stated rather than hidden: `error-context.md` also embeds a ±100
 * line code frame of the spec source, so a failure within 100 lines of a secret
 * LITERAL echoes that literal. E10's device password is such a constant — but it
 * is already committed to this repo, and an artifact reader needs repo access
 * anyway, so it discloses nothing new. (PD9 does not even have that exposure: it
 * encodes its canaries as character codes.) The RUNTIME secrets — the phrase a
 * ceremony mints, a passphrase typed at the keyboard — exist only in the DOM and
 * are fully covered by the two switches above.
 */
export function withoutMatcherAriaSnapshot(error: unknown): unknown {
  // Playwright attaches the snapshot to the public `matcherResult` of an expect
  // failure. Dropping the one field keeps the message, stack and code frame —
  // the failure stays as debuggable as any non-locator assertion.
  const matcherResult = (error as { matcherResult?: { ariaSnapshot?: string } } | null | undefined)
    ?.matcherResult;
  if (matcherResult?.ariaSnapshot !== undefined) delete matcherResult.ariaSnapshot;
  return error;
}
