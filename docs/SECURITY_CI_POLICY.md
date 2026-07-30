# CI Security-Gate Policy

The pull-request **Supply-chain security** workflow is a required gate for
production dependency auditing and committed-secret scanning. Its dependency
audit policy lives in
[`.github/security/dependency-audit-waivers.mjs`](../.github/security/dependency-audit-waivers.mjs).

An advisory must be fixed in a reviewed dependency update whenever practical.
If a pre-existing advisory cannot safely be fixed in the same change, its waiver
must name the exact GHSA, explain the compatibility work still needed, and expire
quickly. The verifier fails for an unwaived advisory, an expired or malformed
waiver, or a waiver no longer reported by `pnpm audit --prod`.

The nightly portion of that workflow builds all three deployable images and
uploads readable Trivy reports. Those scans are intentionally report-only so a
new container finding does not block unrelated pull requests; it must instead be
triaged and remediated through a reviewed Dependabot update or a tracked fix.
