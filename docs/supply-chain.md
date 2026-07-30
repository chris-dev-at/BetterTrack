# Supply-chain container scans and SBOMs

The **Supply-chain security** workflow builds the deployable `api`, `web`, and
`landing` images, scans them with Trivy, and creates a CycloneDX JSON SBOM for
each image. It keeps `contents: read` permissions; producing artifacts does not
grant the workflow repository write access.

## When it runs

- Pull requests run the image gate when their diff changes an image build input:
  the image contexts, shared packages, Docker build configuration, workspace
  manifests or lockfile, or `.github/workflows/security.yml` itself.
- The full three-image scan still runs every day at 03:30 UTC and can be run
  manually with **Run workflow**.

## Gate and artifacts

Every trigger fails its image job when Trivy finds a **fixable CRITICAL** OS or
library vulnerability. `ignore-unfixed: true` keeps advisories without an
upstream fix out of the blocking set. HIGH findings are not merge-blocking: the
nightly run saves them for routine triage instead. CRITICAL is the initial gate
because it provides a clear, urgent remediation threshold without blocking
unrelated changes on the broader, often transitive HIGH advisory backlog.

Each matrix job uploads 30-day retained artifacts on its GitHub Actions run,
including after a failed gate:

- `trivy-<image>-<run-id>` contains the CRITICAL gate report and, on nightly
  runs, the additional HIGH report.
- `sbom-<image>-<run-id>` contains `sbom-<image>.cdx.json`, a machine-readable
  CycloneDX SBOM.

Open the workflow run's **Artifacts** section to download either file.

## Triage and waivers

Start with the Trivy report: identify the CVE, package, image, and whether the
affected layer comes from a pinned base image or a production dependency. Update
the base-image digest or dependency in a reviewed PR, then confirm the gate is
green on the replacement image.

For an advisory with no available fix, create a tracked security issue recording
the CVE, affected image, exposure assessment, and the upstream fix to monitor.
It is intentionally non-blocking while `ignore-unfixed` applies, but must be
rechecked when the upstream package changes. Do not use `continue-on-error` or a
severity-wide exception to waive a gate. A temporary exception for a fixable
CRITICAL finding needs a reviewed, CVE-specific `.trivyignore` entry with a link
to the tracking issue and an expiry; remove it as soon as the fix can ship.
