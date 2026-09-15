# CI Security-Gate Policy

The protected-branch-required CI `verify` job gates production dependency
auditing and committed-secret scanning. Its dependency-audit policy lives in
[`.github/security/dependency-audit-waivers.mjs`](../.github/security/dependency-audit-waivers.mjs).
The Gitleaks release archive is version-pinned and SHA-256 verified. For pull
requests the scanner receives the event's base and head SHAs directly, so its
Git range covers every PR commit without depending on a paginated API list.

An advisory must be fixed in a reviewed dependency update whenever practical.
If a pre-existing advisory cannot safely be fixed in the same change, its waiver
must name the exact GHSA and audited package, explain the compatibility work still
needed, and expire quickly. The verifier fails for an unwaived advisory, an
expired or malformed waiver, a package mismatch, or a waiver no longer reported
by `pnpm audit --prod`. Expiries are staggered by remediation family so their
renewal work remains incremental rather than creating one repository-wide expiry
cliff.

The advisory registry is treated as a separate failure mode from the audit
result. `pnpm audit` reports an unreachable registry as a JSON `error` envelope
on stdout — sometimes with exit code 0 — which is shaped nothing like a report,
so the verifier classifies it explicitly instead of blaming a malformed advisory
map. That endpoint is intermittently flaky, so a registry error is retried up to
three times; each attempt is bounded to a single 60s fetch
(`npm_config_fetch_retries` / `npm_config_fetch_timeout`), which keeps all three
attempts cheaper than one unbounded attempt. If every attempt fails the verifier
**fails closed** and names the cause: an audit that could not run is not an audit
that passed. Do not reach for `pnpm audit --ignore-registry-errors` — it turns a
registry outage into a silent green.

The **Supply-chain security** workflow builds all three deployable images and
uploads readable Trivy reports plus CycloneDX SBOMs. It runs on image-affecting
pull requests, daily, and manually; fixable CRITICAL container findings gate the
build, while HIGH findings remain in the nightly report for triage. The operator
workflow and the narrow waiver path are documented in
[`docs/supply-chain.md`](supply-chain.md).

Three dependencies sit partly outside the automated lanes and are therefore
**tracked by hand**:

- `drizzle-orm` / `drizzle-kit` — Dependabot is fenced off their 0.x minors
  (`.github/dependabot.yml`), because a 0.x minor spans the schema layer and
  needs a dedicated PR that re-runs `db:generate` (#1217). Patches still flow
  through the grouped lane, so **a drizzle advisory fixed only in the next
  minor will not open a PR on its own** — check the drizzle releases when one
  is reported and raise the upgrade issue manually.
- `shell-quote` is pinned forward in the root `pnpm.overrides` block
  (GHSA-395f-4hp3-45gv). Nothing here depends on it directly:
  `drizzle-orm`'s optional `gel` peer drags it onto the **production** audit
  path, so the pin is what keeps `pnpm audit --prod` clean without a waiver.
  Drop the override only after confirming the package has left the production
  tree (`pnpm why shell-quote`).
- `js-yaml` is pinned forward in the root `pnpm.overrides` block (`^4.3.2`) for
  the same reason and looks even more pointless than `shell-quote`, because the
  only thing that pulls it in is ESLint: `eslint -> @eslint/eslintrc -> js-yaml`.
  What makes it a **production** dependency is that `packages/config` — a private
  workspace package — declares its lint toolchain (`eslint-config-prettier`,
  `typescript-eslint`, `@eslint/js`) under `dependencies`, not `devDependencies`.
  `pnpm audit --prod` walks each workspace project's own manifest, so those are
  production edges from the root's point of view even though nothing ships them.
  Verified by pinning `js-yaml` to a vulnerable `4.1.0` and re-auditing: three
  high advisories come back on paths reading
  `packages/config > typescript-eslint@… > @eslint/eslintrc@… > js-yaml@4.1.0`.
  So the override is what keeps `pnpm audit --prod` green without a waiver.
  **Do not delete it because `pnpm why -r --prod js-yaml` "only shows ESLint"** —
  that is exactly the path the audit gate fails on. Drop it only after
  `packages/config` moves its lint toolchain to `devDependencies` (which would
  also end the `--prod` exposure), and re-run `pnpm audit --prod` to confirm.

Dependabot owns GitHub Actions and npm updates. Renovate owns the deployable
Dockerfiles via [`renovate.json`](../renovate.json): its Dockerfile manager
updates every `FROM` stage and groups base-image digest changes into one
reviewable pull request.

## The SQL-identifier reachability gate (`pnpm lint`)

Drizzle parameterises values but cannot parameterise identifiers, so
`sql.identifier()`, `sql.raw()`, `alias()` and a subquery's `.as()` are the only
places in this repository where a JavaScript string becomes SQL text verbatim.
The vault/paranoid review signed those call sites off on a claim — _no
user-controlled string ever reaches them_ — that held only as long as every one
of those arguments stayed a literal, which nothing checked.

[`packages/config/rules/noDynamicSqlIdentifier.js`](../packages/config/rules/noDynamicSqlIdentifier.js)
is that check, wired in `eslint.config.js` over `apps/api/src`, `packages/*/src`
and `e2e` (tests included). A non-literal argument fails `pnpm lint` and
therefore CI. The escape hatch is one shape only —
`// eslint-disable-next-line sql/no-dynamic-identifier -- <why the value is from
a closed allow-list>` — and the rule reports the exemption itself when it names
no reason, uses the `-line` or block form, or hides behind a blanket directive.
An exemption's reason must name the closed list the value comes from (a
module-level constant, an `as const` table list, a checked-in migration file);
"it is safe" is not one.
