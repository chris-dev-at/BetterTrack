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

The daily **Supply-chain security** workflow builds all three deployable images
and uploads readable Trivy reports. Those scans are intentionally report-only so
a new container finding does not block unrelated pull requests; it must instead
be triaged and remediated through a reviewed dependency update or a tracked fix.

Dependabot owns GitHub Actions and npm updates. Renovate owns the deployable
Dockerfiles via [`renovate.json`](../renovate.json): its Dockerfile manager
updates every `FROM` stage and groups base-image digest changes into one
reviewable pull request.
