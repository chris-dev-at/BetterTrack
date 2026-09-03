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

The **Supply-chain security** workflow builds all three deployable images and
uploads readable Trivy reports plus CycloneDX SBOMs. It runs on image-affecting
pull requests, daily, and manually; fixable CRITICAL container findings gate the
build, while HIGH findings remain in the nightly report for triage. The operator
workflow and the narrow waiver path are documented in
[`docs/supply-chain.md`](supply-chain.md).

Two dependencies sit partly outside the automated lanes and are therefore
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

Dependabot owns GitHub Actions and npm updates. Renovate owns the deployable
Dockerfiles via [`renovate.json`](../renovate.json): its Dockerfile manager
updates every `FROM` stage and groups base-image digest changes into one
reviewable pull request.
