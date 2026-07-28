# Pass 06 — Validation, methodology, and limitations

## Repository scope

- Review date: 2026-07-26
- Reviewed revision: `68105467c910b6e64b8383ecb1b97f28ebb725a4`
- Tracked files inventoried: 875
- Approximate tracked source/configuration/documentation lines: 247,000

At publication time, the remote `main` branch had advanced to `14554a4`, 126 commits beyond the reviewed revision. Evidence links are pinned to the reviewed commit. This bundle must be treated as a snapshot and revalidated against any newer release.

The review covered:

- React user and administrator applications;
- static English/German landing pages;
- Express HTTP routes and middleware;
- authentication, sessions, PIN, 2FA, API keys, Google login, and OAuth;
- Socket.IO realtime events and live market mode;
- PostgreSQL/Drizzle schema and repositories;
- Redis/BullMQ jobs, imports, exports, notifications, and account deletion;
- Dockerfiles and every repository Compose topology;
- nginx templates and bespoke live-edge configuration;
- CI workflows, updater scripts, backup/offsite scripts, and documentation;
- single- and multi-agent autonomous factory tooling;
- privacy, cookie, terms, and Impressum content;
- unit, integration, E2E, and operational test structure.

## Validation completed

- All reviewed production, development, factory, and multifactory Compose combinations passed `docker compose config -q`.
- Reviewed shell scripts passed `bash -n` or `sh -n`.
- Selected JavaScript entrypoints passed `node --check`.
- `multi-factory/test.sh`: 77 passed, 0 failed.
- Targeted source and history patterns found no obvious committed private key or high-confidence token.
- Manual sink review found no production `eval`, direct shell execution in application request paths, obvious dynamic SQL concatenation, `dangerouslySetInnerHTML`, `innerHTML`, or `document.write` in the web/landing applications.
- The project contains 81 frontend unit-test files and 20 Playwright E2E specifications.

## Checks that could not be completed

### Full TypeScript, unit, and E2E execution

The checkout's installed dependencies were already incomplete/stale relative to the manifests and lockfile. Typecheck reported missing installed packages rather than a verified source-level type defect.

An offline frozen reinstall was attempted, but the local pnpm store lacked the required Playwright browser archive. The root `node_modules` is therefore currently incomplete. Before using this checkout for development or test execution, run:

```sh
pnpm install --frozen-lockfile
```

Then run at minimum:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm e2e
```

The lint attempt found errors only in generated, git-ignored multifactory authentication middleware. The ESLint configuration does not currently exclude that generated tree; this was treated as a developer-tooling issue rather than a shipped product defect.

### Dependency vulnerability audit

`pnpm audit` could not contact the npm audit service under the available restricted network authorization. No claim is made that the dependency graph is free of known vulnerabilities.

ShellCheck, Hadolint, Trivy, Grype, Syft, Cosign, Actionlint, Yamllint, gitleaks, TruffleHog, and Semgrep were unavailable. The targeted pattern review is not a substitute for these tools.

## External state not available in the repository

The following controls intentionally live outside the checkout and were not attestable:

- live Compose overrides and environment values;
- the edge authentication secret and whether the edge gate is enabled;
- Cloudflare, TLS, DNS, DDNS, firewall, and origin-ingress restrictions;
- host cron and monitoring/alert configuration;
- GitHub branch protection, rulesets, environments, and approval policy;
- container registry permissions, scanning, signing, and retention;
- actual production secret age and rotation history;
- backup freshness, remote object retention, and restore-drill evidence;
- production database contents and whether demo/bootstrap accounts exist.

Repository findings about these controls describe what the checked-in deployment verifies or fails to verify. They do not assert that an external control is absent.

## Static-review limitations

This assessment is not:

- an external black-box penetration test;
- a runtime load or denial-of-service test;
- a browser/assistive-technology usability study with real participants;
- a formal WCAG conformance audit;
- a formal privacy impact assessment;
- jurisdiction-specific legal advice;
- an attestation of the current production environment.

Findings should be reproduced in an isolated environment and closed with regression tests.

## Worktree handling

No tracked application or infrastructure source file was changed as part of the review itself. Pre-existing modified and untracked files were preserved. This documentation bundle was added separately at the user's request.

Ignored dependency-installation state was affected by the unsuccessful offline reinstall described above.
