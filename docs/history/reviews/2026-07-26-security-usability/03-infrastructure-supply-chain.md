# Infrastructure, Supply-Chain, Deployment, and Operations Review

_Archived 2026-09-02 — part of the 2026-07-26 review round; its findings were triaged into issues and are recorded in `PROJECTPLAN.md` §16._

**Review date:** 2026-07-26
**Repository:** BetterTrack
**Scope:** Docker and Compose topology, deployment automation, factory and multi-factory automation, GitHub Actions, dependency controls, secrets handling, backups and restore, observability, runtime health, static web delivery, and operational documentation.

This is a source and local-workspace review, not a certification or a live-environment penetration test. Findings distinguish behavior proven by this repository from controls whose current state exists outside it.

## Executive summary

The strongest infrastructure controls are the API's non-root production image, frozen lockfile installs, read-only GitHub Actions permissions, unexposed database and Redis ports in production overlays, strict and atomic local backup creation, encrypted offsite backups, log/Sentry redaction, and validation-before-reload for live nginx changes.

The most urgent risks are:

1. The multi-factory control API has no request authentication and becomes an unauthenticated administrative API when bound to a LAN address.
2. The factory image installs mutable remote tools, including an unversioned `curl | bash` installer, and later runs those tools with repository-write and provider credentials.
3. Production deploys whichever commit `origin/main` names without verifying a signature, CI attestation, protected release, or immutable image digest.
4. The production template's public placeholder can become a permanent, active administrator password.
5. Normal `SESSION_SECRET` rotation changes the fallback encryption key for every TOTP secret and Discord webhook.
6. Account exports do not work in the documented split API/worker Compose deployment because the containers do not share the export filesystem.

No source files were changed during the audit. This report is the only audit-created file.

## Severity model

- **Critical:** Direct, broadly exploitable compromise with little or no prerequisite.
- **High:** Credible path to privileged compromise, large-scale lockout/data loss, or a core production feature that is predictably broken.
- **Medium:** Material weakness requiring a prerequisite, operational failure with meaningful impact, or significant deployment/usability drift.
- **Low:** Defense-in-depth, resilience, or maintainability weakness with limited immediate impact.
- **Informational:** Positive control, observation, or validation boundary.

## High-severity findings

### INF-01 — Multi-factory control API has no authentication

**Severity:** High when exposed beyond loopback; Medium at the default loopback binding.

**Impact**

When `MF_CONTROL_HOST` is set to a non-loopback address, every private-network peer can operate the factory. The API can start and restart agent runs, change worker/model settings and triggers, invoke paid provider tests, and stop, pause, or remove Docker projects. At the default loopback address, the lack of Host, Origin, content-type, authentication, and CSRF checks still leaves a localhost request-forgery/DNS-rebinding surface. Browser private-network and mixed-content policies may reduce exploitability in some browsers, but they are not server-side authorization.

**Evidence**

- The only gate accepts a request when its socket source is private or loopback: [multi-factory/control/server.mjs, lines 955–971](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/control/server.mjs#L955-L971).
- `POST /api/action` parses any JSON body and dispatches it without authentication, Origin/Host validation, or a CSRF token: [multi-factory/control/server.mjs, lines 1000–1021](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/control/server.mjs#L1000-L1021).
- The handler does not require `application/json`; a cross-origin simple `text/plain` request can contain JSON where the browser permits the network request.
- Privileged actions include factory launch/restart, model/provider operations, and Docker lifecycle control: [multi-factory/control/server.mjs, lines 723–739](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/control/server.mjs#L723-L739), [lines 790–900](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/control/server.mjs#L790-L900).
- The bind address is configurable, while the default is `127.0.0.1`: [multi-factory/control/server.mjs, lines 1032–1034](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/control/server.mjs#L1032-L1034).

**Recommendation**

- Keep the service on loopback or, preferably, a permissioned Unix socket.
- Require a high-entropy bearer token, mutual TLS, or an authenticated local reverse proxy.
- Validate an exact Host and Origin allowlist and require a CSRF token for mutations.
- Reject unexpected content types and methods.
- If LAN operation is required, use TLS, firewall allowlists, rate limits, and per-action audit records.
- Treat source IP as an additional constraint, never as authentication.

### INF-02 — Factory builds execute mutable supply-chain code before later receiving write credentials

**Severity:** High.

**Impact**

A compromised package release, package registry account, installer endpoint, base tag, or mutable apt repository can persist malicious code in the factory image. That image later receives a GitHub token with repository write permissions plus Claude/Codex/Gemini credentials. Malicious tooling could steal credentials, alter code or reviews, create or merge pull requests, or corrupt factory decisions.

The credentials are not present during the image build itself; the risk is that unverified code is baked into the image and then executes after credentials are supplied at runtime.

**Evidence**

- The factory uses mutable `node:22-bookworm`, mutable Debian/GitHub apt repositories, and unpinned global installs of `@anthropic-ai/claude-code` and `@openai/codex`: [factory/Dockerfile, lines 1–8](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/Dockerfile#L1-L8).
- The Antigravity CLI is installed by piping a live, unversioned network response into Bash: [factory/Dockerfile, lines 13–18](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/Dockerfile#L13-L18).
- Factory runtime configuration requests Contents, Issues, and Pull Requests write access and a Claude OAuth token: [factory/.env.example, lines 7–12](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/.env.example#L7-L12).
- The single factory consumes the secret environment file: [factory/compose.yml, lines 3–10](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/compose.yml#L3-L10).
- Multi-factory containers consume the same environment and writable provider-auth mounts: [multi-factory/compose.yml, lines 20–27](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/compose.yml#L20-L27), [lines 29–79](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/compose.yml#L29-L79).

**Recommendation**

- Pin every base image by digest and every CLI to a reviewed version.
- Replace `curl | bash` with a versioned artifact whose checksum or signature is verified before installation.
- Lock the factory's full dependency graph, generate an SBOM, scan it, and sign the resulting image.
- Build the factory image in CI and run only an approved immutable digest.
- Prefer short-lived, narrowly scoped GitHub App installation tokens over long-lived PATs.
- Separate provider credentials by worker and purpose; revoke and rotate them automatically.
- Add an image admission check before starting any credential-bearing factory container.

### INF-03 — Production trusts mutable `origin/main` without a deploy-side provenance gate

**Severity:** High.

**Impact**

Any compromise that can place a commit on `main`—a repository-write credential, GitHub account, branch-rules misconfiguration, compromised factory tool/provider, or dependency-driven malicious change—can reach production automatically. The updater rebuilds and executes application code, runs database migrations and seed logic, changes nginx/static files, and can replace its own future updater code.

Repository protections may exist on GitHub, but no deploy-side check in this repository verifies them. The current audited HEAD was unsigned, and no tag pointed at it.

**Evidence**

- The updater fetches `origin/main` and treats its resolved SHA as the deployment target: [infra/live/updater.sh, lines 183–191](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L183-L191).
- It hard-resets to that SHA, builds locally, starts dependencies, runs migrations and seed, and recreates application services: [infra/live/updater.sh, lines 218–226](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L218-L226).
- It later copies updater code from the newly deployed repository and restarts itself: [infra/live/updater.sh, lines 151–167](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L151-L167).
- The updater is documented as operating through a mounted Docker socket: [infra/live/updater.sh, lines 22–30](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L22-L30).
- The single factory uses an LLM verdict plus CI to merge without a human approval: [factory/run.sh, lines 102–123](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/run.sh#L102-L123).
- The multi-factory merge queue likewise accepts the factory's comment verdict and CI rollup: [multi-factory/master.sh, lines 311–339](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/master.sh#L311-L339).
- Factory commits deliberately use the owner's human identity rather than a distinct automation identity: [factory/run.sh, lines 21–25](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/run.sh#L21-L25), [multi-factory/master.sh, lines 405–408](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/master.sh#L405-L408), [multi-factory/worker.sh, lines 314–317](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/worker.sh#L314-L317).
- At audit time, `git log -1 --format=%G?` returned `N` for commit `68105467c910b6e64b8383ecb1b97f28ebb725a4`, and no tag pointed at HEAD.

**Recommendation**

- Build, test, scan, and sign images in CI once; deploy those exact immutable digests.
- Require a protected environment/manual approval for production, especially for migrations, infrastructure, auth, dependency, and secret-handling changes.
- Verify an artifact attestation, signer identity, source commit, CI workflow, and expected repository before deployment.
- Give factory commits and pull requests an explicit bot identity and signed provenance.
- Enforce protected branches/rulesets, CODEOWNERS, required independent review, and non-bypassable checks.
- Keep deployment credentials distinct from repository-write and factory credentials.

### INF-04 — Public placeholder values can seed a known permanent administrator

**Severity:** High.

**Impact**

An operator following the copy-and-run production instructions can accidentally create an active administrator using a password published in the repository. The account is not forced to change that password. Mandatory administrator 2FA does not prevent the first claimant from logging in and enrolling their own factor.

The same production template contains public placeholders for the database and `SESSION_SECRET`; the environment schema's length-only session validation accepts its placeholder.

**Evidence**

- The production template supplies predictable database and session placeholders: [infra/.env.production.example, lines 4–19](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/.env.production.example#L4-L19).
- It supplies `ADMIN_EMAIL=admin@example.at` and `ADMIN_PASSWORD=CHANGE_ME_IMMEDIATELY_AFTER_FIRST_LOGIN`: [infra/.env.production.example, lines 137–141](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/.env.production.example#L137-L141).
- `SESSION_SECRET` is validated only for a minimum length of 16 characters, while admin fields are merely optional strings: [apps/api/src/config/env.ts, lines 14–20](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L14-L20), [lines 55–61](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L55-L61).
- Seed checks only that the admin fields are present: [apps/api/src/scripts/seed.ts, lines 24–29](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/scripts/seed.ts#L24-L29).
- Seed hashes the raw configured value, creates an active administrator, and explicitly sets `mustChangePassword: false`: [apps/api/src/scripts/seed.ts, lines 37–54](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/scripts/seed.ts#L37-L54).
- An administrator without a factor receives a session after password login: [apps/api/src/services/auth/authService.ts, lines 624–668](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L624-L668).
- The mandatory 2FA middleware intentionally allows factor enrollment before restricting other admin endpoints: [apps/api/src/http/middleware/session.ts, lines 123–153](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/middleware/session.ts#L123-L153).

**Recommendation**

- Reject known placeholders and weak/low-entropy secrets when `NODE_ENV=production`.
- Generate the first administrator's one-time secret rather than publishing a default.
- Set `mustChangePassword: true`, expire the bootstrap credential, and require an out-of-band setup flow.
- Remove `ADMIN_PASSWORD` after first use and rotate it if it has ever been passed to a long-running service.
- Validate session key entropy and format, not only character count.
- Make first-boot seed an explicit one-shot operation with a clear success marker.

### INF-05 — Session-secret rotation invalidates all TOTP and Discord encrypted secrets

**Severity:** High.

**Impact**

The documented zero-downtime session-signing rotation changes the encryption key used for stored TOTP secrets and Discord webhook URLs. Enrolled users, including administrators, can become unable to complete 2FA; Discord notification delivery can fail. A normal security maintenance action can therefore cause broad lockout and availability loss.

**Evidence**

- The production example recommends comma-separated session secrets, with the first key signing new cookies: [infra/.env.production.example, lines 15–19](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/.env.production.example#L15-L19).
- `TOTP_ENCRYPTION_KEY` is optional, and the application documents a fallback to `SESSION_SECRET`: [apps/api/src/config/env.ts, lines 109–117](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L109-L117).
- The fallback hashes the entire current comma-separated string into a single AES key: [apps/api/src/config/env.ts, lines 481–486](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L481-L486).
- TOTP verification treats a secret that cannot decrypt under that key as a failed factor: [apps/api/src/services/auth/twoFactorService.ts, lines 161–174](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/twoFactorService.ts#L161-L174), [lines 251–263](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/twoFactorService.ts#L251-L263).
- Discord webhook URLs use the same key: [apps/api/src/services/notifications/discordChannel.ts, lines 57–68](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/discordChannel.ts#L57-L68), [line 129](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/discordChannel.ts#L129).
- Standard production Compose does not pass a dedicated key in either service's environment: [infra/docker-compose.yml, lines 82–122](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L82-L122), [lines 145–186](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L145-L186).

**Recommendation**

- Make a dedicated, stable encryption key mandatory in production.
- Pass it consistently to API and worker and document its independent lifecycle.
- Support a key ring with key identifiers, old-key decryption, and transactional re-encryption.
- Separate TOTP encryption from third-party webhook encryption so the domains can rotate independently.
- Add a test that prepending a session-signing key does not affect encrypted data.

### USE-01 — Account export is broken in the documented split API/worker deployment

**Severity:** High for usability and data-rights operations.

**Impact**

The worker creates a ready export record whose path refers to its own container filesystem. The API then attempts to download that path from a different container. With the standard Compose file, both processes fall back to separate `/tmp/bettertrack-exports` directories, so a successfully built export cannot be downloaded.

This also undermines durability: a restart can remove a ready export even in a single-process layout.

**Evidence**

- Configuration explicitly says the directory must be writable by API and worker and mounted durably in production: [apps/api/src/config/env.ts, lines 135–164](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L135-L164).
- The worker writes the archive and saves its local path in the database: [apps/api/src/services/export/exportService.ts, lines 230–253](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/exportService.ts#L230-L253).
- The API later resolves that path and calls `res.download`: [apps/api/src/services/export/exportService.ts, lines 270–288](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/exportService.ts#L270-L288), [apps/api/src/http/routes/accountRoutes.ts, lines 73–84](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/accountRoutes.ts#L73-L84).
- Neither the API nor worker environment supplies `BT_EXPORT_DIR`, and neither has a shared export volume: [infra/docker-compose.yml, lines 72–133](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L72-L133), [lines 135–191](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L135-L191).
- Existing export tests use a single process and an explicitly injected local directory rather than the real split topology: [apps/api/src/services/export/**tests**/exportFlow.test.ts, line 25](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/__tests__/exportFlow.test.ts#L25).

**Recommendation**

- Create a named export volume and mount it at one identical path in API and worker.
- Pass that path through `BT_EXPORT_DIR` to both services.
- Set ownership for the non-root `bettertrack` user and enforce bounded retention.
- Add an integration test that runs distinct API and worker processes/containers and downloads the produced archive.
- Consider object storage with short-lived signed downloads if horizontal scaling is planned.

## Medium-severity findings

### INF-06 — GitHub tokens are embedded in persistent Git remote URLs

**Severity:** Medium.

**Impact**

The repository-write PAT is stored in each factory clone's `.git/config`, including clones inside persistent named volumes. It can also appear in process inspection, diagnostics, accidental remote output, or volume backups. Rotating only the environment value does not scrub previously persisted URLs.

**Evidence**

- The single factory embeds the token in both clone and `remote set-url`: [factory/run.sh, lines 19–25](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/run.sh#L19-L25).
- Multi-factory master does the same: [multi-factory/master.sh, lines 405–408](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/master.sh#L405-L408).
- Every worker does the same: [multi-factory/worker.sh, lines 314–317](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/worker.sh#L314-L317).
- The clones reside in persistent per-service named volumes: [factory/compose.yml, lines 7–14](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/compose.yml#L7-L14), [multi-factory/compose.yml, lines 33–79](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/compose.yml#L33-L79).

**Recommendation**

- Keep a credential-free `https://github.com/<owner>/<repo>.git` remote.
- Supply a short-lived token through `GIT_ASKPASS`, a scoped credential helper, or GitHub App authentication.
- Redact URLs in diagnostics.
- Scrub existing `.git/config` files and rotate the current token.

### INF-07 — Live local secret files are world-readable to other host accounts

**Severity:** Medium on a multi-user or remotely administered host; Low on a physically controlled single-user host.

**Impact**

Any local OS account that can traverse the repository directories can read the current application and factory secrets, including a session secret, administrator password, SMTP password, repository-write GitHub token, and Claude OAuth token.

**Evidence**

- Local inspection found `apps/api/.env` and `factory/.env` with mode `0644`, under directories with mode `0755`.
- Key-only inspection confirmed that sensitive fields were populated. Secret values were not printed or copied into this report.
- Both files are correctly ignored by the repository: [.gitignore, lines 6–10](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.gitignore#L6-L10).
- Environment files and the entire factory tree are excluded from application Docker build contexts: [.dockerignore, lines 7–20](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.dockerignore#L7-L20).
- The multi-factory auth root was mode `0700`, and primary auth JSON/config files were generally `0600`, which is the desired pattern.

**Recommendation**

- Set secret files to `0600` and secret directories to `0700`.
- Keep production secrets outside the repository tree in a secret manager or root-owned deployment directory.
- Rotate credentials if another host user, backup consumer, or support tool could have read them.
- Add a startup permission check for local factory credential files.

### INF-08 — Administrator bootstrap secrets remain in long-running API and worker environments

**Severity:** Medium.

**Impact**

`ADMIN_PASSWORD` is needed only by the one-shot seed command but is passed to both long-running API and worker containers. Anyone with container-inspection access, a diagnostic dump, or code execution in either process gains the administrator bootstrap credential. The worker has no legitimate need for it.

**Evidence**

- API receives `ADMIN_EMAIL` and `ADMIN_PASSWORD`: [infra/docker-compose.yml, lines 106–114](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L106-L114).
- Worker receives the same fields: [infra/docker-compose.yml, lines 170–178](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L170-L178).
- The values are consumed by seed, not normal request/worker operation: [apps/api/src/scripts/seed.ts, lines 24–54](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/scripts/seed.ts#L24-L54).

**Recommendation**

- Remove both variables from long-running services.
- Supply a one-shot secret/file only to the seed job.
- Delete or rotate the bootstrap credential immediately after successful seed.

### INF-09 — Production configuration propagation has drifted from the application schema

**Severity:** Medium.

**Impact**

Documented production deployments silently ignore configuration for provider budgets, realtime rollout, Sentry, dedicated encryption, Google sign-in, durable exports, and Telegram. Features appear implemented but cannot be enabled through the supplied Compose/example workflow without editing deployment files. Security and observability controls can therefore remain unintentionally disabled.

**Evidence**

- The application schema defines provider budgets and realtime: [apps/api/src/config/env.ts, lines 62–84](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L62-L84).
- It defines Sentry, TOTP encryption, Google, exports, and Telegram: [apps/api/src/config/env.ts, lines 98–150](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L98-L150).
- The API Compose environment omits those keys: [infra/docker-compose.yml, lines 82–122](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L82-L122).
- The worker's parallel environment omits the same keys: [infra/docker-compose.yml, lines 145–186](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L145-L186).
- The production example likewise omits them.

**Recommendation**

- Define one shared Compose environment anchor for API and worker.
- Document every production-supported variable in the example, including ownership and rotation requirements.
- Add a test that compares the production schema allowlist against Compose and example coverage.
- Fail loudly when a feature is requested in the host env but not propagated to the service.

### INF-10 — Factory automation obscures machine provenance behind a human identity

**Severity:** Medium.

**Impact**

Commits created by autonomous tools look like the owner's ordinary human commits, and co-author attribution is intentionally suppressed. During an incident or review, it is harder to determine whether a change came from a person, a specific factory worker, model, prompt, or credential. This compounds the automatic deployment trust issue.

**Evidence**

- Single factory explicitly configures the owner's name and email and explains why bot attribution is omitted: [factory/run.sh, lines 21–25](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/run.sh#L21-L25).
- Master and workers use the same identity: [multi-factory/master.sh, lines 405–408](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/master.sh#L405-L408), [multi-factory/worker.sh, lines 314–317](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/multi-factory/worker.sh#L314-L317).
- Claude co-author attribution is disabled: [.claude/settings.json, lines 1–3](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.claude/settings.json#L1-L3).

**Recommendation**

- Use a dedicated, signed bot identity.
- Record immutable run ID, worker, provider/model, prompt version, source issue, and reviewer identity in commit/PR metadata.
- Preserve human approval as a distinct signed event rather than making automation appear human-authored.

### INF-11 — GitHub Actions and service images use mutable references

**Severity:** Medium.

**Impact**

Re-running the same commit can execute different action code or service images. A compromised upstream tag or unexpected major-tag movement can alter CI behavior. Production rebuilds can likewise pick up different base content after cache eviction or on a fresh host.

**Evidence**

- CI uses `actions/checkout@v4` and `actions/setup-node@v4`: [.github/workflows/ci.yml, lines 19–30](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L19-L30), [lines 80–91](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L80-L91).
- Nightly E2E additionally uses a mutable artifact action tag: [.github/workflows/e2e-nightly.yml, lines 49–70](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/e2e-nightly.yml#L49-L70).
- CI services use `postgres:17` and `redis:7`: [.github/workflows/ci.yml, lines 53–75](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L53-L75).
- Production uses the same floating database/cache tags: [infra/docker-compose.yml, lines 193–218](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L193-L218).
- Application images use mutable Node/nginx tags: [apps/api/Dockerfile, lines 1–26](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/Dockerfile#L1-L26), [apps/web/Dockerfile, lines 1–28](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/Dockerfile#L1-L28), [apps/landing/Dockerfile, line 9](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/Dockerfile#L9).

**Recommendation**

- Pin GitHub Actions to reviewed commit SHAs.
- Pin base and service images by digest.
- Use Renovate/Dependabot to open reviewed digest/version updates.
- Record image digests in release metadata and verify them at deploy time.

**Remediation status (2026-07-30):** CI, nightly E2E, and application Dockerfile
references were pinned by #952. Compose-file pins remain a separately scoped
follow-up; grouped Dependabot updates cover Actions and npm, while Renovate's
Dockerfile manager groups every deployable base-image stage into a reviewable
digest update.

### INF-12 — CI lacks promised dependency and deployable-artifact security gates

**Severity:** Medium.

**Impact**

Known dependency vulnerabilities, leaked secrets, vulnerable container layers, and build-time differences can reach `main` without an automated gate. CI compiles application packages but does not build the Docker images that production actually runs. The nightly-only browser suite may detect regressions after an auto-deploy.

**Evidence**

- The project plan says `pnpm audit` runs in CI: [PROJECTPLAN.md, line 682](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/PROJECTPLAN.md#L682).
- Actual CI performs install, typecheck, lint, formatting, tests, OpenAPI coverage, and package build, but no audit, secret scan, SBOM, container build, image scan, or attestation: [.github/workflows/ci.yml, lines 15–48](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L15-L48), [lines 50–99](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L50-L99).
- E2E runs only on a nightly schedule or manual dispatch: [.github/workflows/e2e-nightly.yml, lines 1–14](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/e2e-nightly.yml#L1-L14).
- The updater can deploy a main-branch change before the next nightly run: [infra/live/updater.sh, lines 183–226](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L183-L226).

**Recommendation**

- Add dependency auditing with a documented fail/waiver policy.
- Add secret scanning, SAST, Dockerfile linting, SBOM generation, and container vulnerability scanning.
- Build the exact production images in CI, run smoke/integration tests against them, and sign/attest them.
- Run the critical E2E happy path on pull requests or before production promotion.
- Add Dependabot or Renovate with grouped, reviewable updates.

**Remediation status (2026-07-30):** #952 added a PR-gating production
dependency audit with explicit expiring waivers, full-history secret scanning,
and report-only nightly Trivy image reports. SBOMs, attestations, and production
image smoke tests remain follow-up work.

### INF-13 — Backup sidecar uses an unsupported Alpine release

**Severity:** Medium.

**Impact**

The offsite backup encryption/upload toolchain is built on a distro branch past its normal security-support date. Future vulnerabilities in the OS packages may not receive standard fixes, putting the availability and confidentiality tooling for backups at avoidable risk.

**Evidence**

- The sidecar deliberately pins `alpine:3.20`: [infra/backup/Dockerfile, lines 8–19](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/Dockerfile#L8-L19).
- Alpine's official release table lists 3.20 end of support as 2026-04-01: [Alpine releases](https://www.alpinelinux.org/releases/).
- The review date is 2026-07-26.
- Node 22 itself was not EOL at review time; the official schedule lists maintenance through 2027-04-30: [Node.js previous releases](https://nodejs.org/en/about/previous-releases).

**Recommendation**

- Upgrade to a currently supported Alpine release.
- Pin the base by digest and automate reviewed updates.
- Build and scan the sidecar in CI.
- Record and test the included `age` and `rclone` versions.

### INF-14 — Container isolation and internal network segmentation are weak

**Severity:** Medium.

**Impact**

All production services share the default Compose network. Web and landing containers that do not need database/cache access can reach both. Redis has no authentication and holds sessions, rate-limit state, jobs, and operational data; compromise of a public-facing container could therefore disrupt sessions and queues or expose internal metadata. Several containers run as root, and Compose defines no `read_only`, `cap_drop`, `no-new-privileges`, PID/resource limits, or explicit log limits.

This is defense in depth: Postgres is still password protected, neither data service is host-published, and no direct nginx compromise was demonstrated.

**Evidence**

- Base Compose defines no explicit networks or service hardening: [infra/docker-compose.yml, lines 13–228](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L13-L228).
- Redis runs without an ACL/password: [infra/docker-compose.yml, lines 213–223](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L213-L223).
- Session IDs are included in Redis key names and per-user indexes: [apps/api/src/services/sessions/sessionService.ts, lines 103–109](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/sessions/sessionService.ts#L103-L109), [lines 184–190](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/sessions/sessionService.ts#L184-L190).
- API explicitly drops to a non-root user: [apps/api/Dockerfile, lines 26–52](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/Dockerfile#L26-L52).
- Web, landing, and backup runner Dockerfiles do not declare a non-root `USER`: [apps/web/Dockerfile, lines 27–40](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/Dockerfile#L27-L40), [apps/landing/Dockerfile, lines 9–18](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/Dockerfile#L9-L18), [infra/backup/Dockerfile, lines 10–24](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/Dockerfile#L10-L24).

**Recommendation**

- Split edge, application, and data networks; allow only required connections.
- Remove web/landing access to Redis and Postgres.
- Add Redis ACL/password protection and consider TLS when crossing hosts.
- Run every feasible container non-root with a read-only root filesystem, tmpfs scratch paths, dropped capabilities, and `no-new-privileges`.
- Add PID, CPU, memory, and log-size limits.
- Validate hardening in CI with container-structure/runtime tests.

### INF-15 — Static web responses lack standard browser security headers

**Severity:** Medium.

**Impact**

User, admin, product, and mobile static pages do not receive a repository-defined CSP, `frame-ancestors`, `X-Content-Type-Options`, Referrer Policy, or Permissions Policy. This increases clickjacking and content-injection blast radius and leaves browser policy dependent on an external TLS edge whose configuration is not in the repository.

**Evidence**

- Subdomain web/admin locations define caching but no security-header set: [infra/nginx/templates/subdomains.conf.template, lines 40–90](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/nginx/templates/subdomains.conf.template#L40-L90).
- Ports mode is the same: [infra/nginx/templates/ports.conf.template, lines 40–87](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/nginx/templates/ports.conf.template#L40-L87).
- Product/mobile proxy blocks likewise do not add them: [infra/nginx/templates/subdomains.conf.template, lines 92–133](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/nginx/templates/subdomains.conf.template#L92-L133).
- API Helmet coverage does not apply to files nginx serves directly.

**Recommendation**

- Define and test one header policy at the nginx/TLS edge.
- At minimum add `Content-Security-Policy` with `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, a restrictive Referrer Policy, and Permissions Policy.
- Add HSTS only at the HTTPS termination layer and only after all subdomains are HTTPS-ready.
- Adapt inline landing scripts with hashes/nonces or move them into versioned external files.

### INF-16 — Local backups are not automatically scheduled and share the database host

**Severity:** Medium.

**Impact**

A standard deployment has no backup unless an operator separately installs cron. Local dumps and the live database are Docker volumes on the same host, so disk loss, host compromise, ransomware, or Docker-volume deletion can remove both. No repository control alerts when the schedule is missing or stale.

**Evidence**

- Documentation explicitly states that nothing runs backup automatically: [README.md, lines 360–370](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/README.md#L360-L370).
- Database and backup volumes are mounted by the same database service on the same Compose host: [infra/docker-compose.yml, lines 193–228](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L193-L228).
- The backup script itself is robust but only runs when invoked: [infra/backup/backup.sh, lines 1–18](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/backup.sh#L1-L18).

**Recommendation**

- Manage scheduling as deployment code, not an undocumented host prerequisite.
- Alert on last successful dump, archive size, age, and restore-test age.
- Make offsite/immutable backup mandatory for production.
- Store at least one copy in a separate account/provider or offline medium.

### INF-17 — Offsite backup credentials can delete all remote backups

**Severity:** Medium.

**Impact**

The production rclone credential is configured for full Drive access because the same credential performs retention deletion. A compromised deployment host, sidecar, or refresh token can delete the backup set. `age` protects confidentiality but not availability.

**Evidence**

- The runbook instructs operators to grant full Drive access for delete-on-prune: [docs/ops.md, lines 96–119](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/docs/ops.md#L96-L119).
- The script uploads and then deletes matching remote objects using that credential: [infra/backup/offsite.sh, lines 73–89](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/offsite.sh#L73-L89).
- The rclone configuration is mounted read-only into the sidecar, which prevents accidental in-container modification but not use of the token: [infra/docker-compose.offsite.yml, lines 37–48](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.offsite.yml#L37-L48).

**Recommendation**

- Use an append-only/object-lock/versioned backup destination.
- Separate upload and retention credentials; run retention from a more trusted control plane.
- Scope the remote to a dedicated backup folder/account.
- Alert on mass deletion and preserve provider-side version history.

### INF-18 — Offsite retry behavior skips failed prior-day artifacts

**Severity:** Medium for backup completeness.

**Impact**

Documentation says a failed upload will retry the same preserved dump. Under the documented cron sequence, the next run first creates a newer local dump, and the offsite script selects only that newest file. The failed earlier artifact is skipped rather than retried. Although the new dump is a newer full database backup, the promised daily-copy/retry behavior is false and gaps can go unnoticed.

A configured but unreadable recipient file also exits successfully, allowing cron to appear healthy.

**Evidence**

- The script selects exactly one newest filename: [infra/backup/offsite.sh, lines 47–57](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/offsite.sh#L47-L57).
- The documented cron creates a fresh local dump before invoking offsite: [docs/ops.md, lines 140–159](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/docs/ops.md#L140-L159).
- Documentation claims the same dump will be found and retried: [docs/ops.md, lines 64–70](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/docs/ops.md#L64-L70), [lines 284–287](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/docs/ops.md#L284-L287).
- An unreadable configured recipient exits zero: [infra/backup/offsite.sh, lines 42–45](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/offsite.sh#L42-L45).

**Recommendation**

- Enumerate all eligible local artifacts and upload those not already present remotely, or maintain a durable upload queue/marker.
- Exit nonzero when explicitly configured files are unreadable.
- Emit a machine-readable success/failure/freshness metric.
- Add automated tests with mocked `age`/`rclone`, including multi-day failure and retry.

### INF-19 — Deployment migration and rollout are non-atomic

**Severity:** Medium.

**Impact**

The updater builds, starts data services, runs migrations and seed, and then recreates applications. Existing application containers can remain live while the new migration changes the schema. There is no automatic pre-migration backup, compatibility gate, post-deploy readiness verification, blue/green rollout, or schema rollback. A destructive or non-backward-compatible migration can break the old application during rollout or strand production after a failure.

**Evidence**

- Deployment order is local build, data services, migration, seed, and application `up -d`: [infra/live/updater.sh, lines 218–226](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L218-L226).
- Failure is logged and retried, but there is no rollback or pre-deployment backup in the chain: [infra/live/updater.sh, lines 227–236](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L227-L236).
- `docker compose up -d` success is treated as deployment success without an application-level readiness probe.

**Recommendation**

- Take and verify a pre-migration backup.
- Enforce expand/contract, backward-compatible migrations.
- Run a migration compatibility check against the currently deployed version.
- Add post-deploy readiness and smoke tests before marking a SHA deployed.
- Use blue/green or staged application rollout and an explicit rollback plan.

### INF-20 — Docker health can remain green during database, Redis, or worker failure

**Severity:** Medium.

**Impact**

The API container's Docker healthcheck exercises a liveness response that always returns `ok`; it does not prove database or Redis readiness. The worker has no container healthcheck. The richer admin health service reports a never-created worker heartbeat as healthy, so a worker that never successfully starts can be missed.

**Evidence**

- Docker calls `/api/v1/health`: [infra/docker-compose.yml, lines 123–133](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L123-L133).
- That route always creates a static `status: ok` response without dependency checks: [apps/api/src/http/healthRouter.ts, lines 14–23](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/healthRouter.ts#L14-L23).
- Worker has dependencies but no healthcheck: [infra/docker-compose.yml, lines 135–191](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L135-L191).
- Rich health checks DB and Redis correctly: [apps/api/src/services/health/healthService.ts, lines 55–77](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/health/healthService.ts#L55-L77).
- Missing heartbeat state is nevertheless reported `ok`: [apps/api/src/services/health/healthService.ts, lines 88–105](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/health/healthService.ts#L88-L105).

**Recommendation**

- Separate process liveness from dependency readiness.
- Make the container readiness endpoint check DB and Redis with tight timeouts.
- Add a worker healthcheck that requires a heartbeat after a startup grace period.
- Add external synthetic checks and alerts instead of relying only on Docker restart policy.

### INF-21 — Observability is implemented but not operable through documented production Compose

**Severity:** Medium.

**Impact**

Sentry has strong privacy controls in code, but the standard production deployment does not propagate its configuration. No metrics, alert rules, Docker log rotation, or explicit resource limits are defined. Failures can therefore be retained only in unbounded host logs, go unnoticed, or fill disk.

**Evidence**

- Sentry initialization disables default PII and scrubs error and transaction events: [apps/api/src/services/observability/sentry.ts, lines 53–76](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/observability/sentry.ts#L53-L76).
- Sentry variables exist in the application schema: [apps/api/src/config/env.ts, lines 98–107](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L98-L107).
- Those variables are absent from API/worker Compose environments: [infra/docker-compose.yml, lines 82–122](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L82-L122), [lines 145–186](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L145-L186).
- Compose declares restart policies but no `logging`, resource, or PID-limit blocks: [infra/docker-compose.yml, lines 13–228](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L13-L228).

**Recommendation**

- Propagate and document Sentry configuration.
- Add bounded `max-size`/`max-file` logging or enforce equivalent daemon policy.
- Monitor readiness, worker heartbeat, queue age/failures, disk usage, provider breakers, deploy failure, and backup freshness.
- Set service CPU/memory/PID budgets and alert on sustained pressure.

### USE-02 — Production seed creates a demo user and persists its password in logs

**Severity:** Medium.

**Impact**

Every fresh production database receives an extra active, predictable-username account. Its random password is printed once and then persists in updater logs. Anyone who can read a log copy can claim the account and choose a new password. `mustChangePassword: true` limits post-login access but does not protect the first login.

**Evidence**

- Seed defines a fixed demo email and username: [apps/api/src/scripts/seed.ts, lines 15–22](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/scripts/seed.ts#L15-L22).
- It creates an active user and prints the temporary password: [apps/api/src/scripts/seed.ts, lines 57–79](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/scripts/seed.ts#L57-L79).
- The updater runs seed on every deployment and redirects output to its persistent log: [infra/live/updater.sh, lines 218–226](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L218-L226).

**Recommendation**

- Disable demo seeding by default in production.
- Require an explicit non-production/demo flag.
- Never print authentication credentials into durable logs.
- If a production trial user is required, use an expiring, one-use setup link delivered out of band.
- Review and remove unintended existing demo accounts.

### USE-03 — Generic landing deployment omits legal pages and links

**Severity:** Medium for usability/compliance.

**Impact**

The standard Compose landing origin returns 404 for terms, privacy, Impressum, and cookie pages even though canonical versions exist elsewhere in the repository for a bespoke live deployment. Neither English nor German landing footer links to them. This is a material launch/compliance and user-trust gap, particularly for an Austria/EU-hosted service.

**Evidence**

- The generic image copies only `apps/landing/site`: [apps/landing/Dockerfile, lines 9–16](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/Dockerfile#L9-L16).
- That directory has no legal route directories.
- English and German footers contain only the app link and a tagline: [apps/landing/site/index.html, lines 155–163](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L155-L163), [apps/landing/site/de.html, lines 154–162](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/de.html#L154-L162).
- Standard subdomain routing sends every apex path to the generic landing container: [infra/nginx/templates/subdomains.conf.template, lines 92–105](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/nginx/templates/subdomains.conf.template#L92-L105).
- Canonical legal pages exist only under the bespoke live-edge tree, for example [privacy](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/privacy/index.html) and [terms](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/terms/index.html).

**Recommendation**

- Package the canonical legal pages into the generic landing image.
- Add visible EN/DE footer links.
- Add route/link tests for every legal URL in both deployment modes.
- Establish one canonical legal-content source to prevent live/generic drift.

### USE-04 — Landing origins are wrong in ports and custom-domain deployments

**Severity:** Medium.

**Impact**

The landing page can send “Open the web app” links and registration-mode queries to `bettertrack.at` instead of the deployed instance. In ports mode, the documented environment leaves both origins at unrelated subdomain defaults. This can confuse users and cause the site to display an incorrect invite/registration state.

**Evidence**

- Landing startup requires both `BT_WEB_ORIGIN` and `BT_API_ORIGIN` and defaults both to public BetterTrack domains: [apps/landing/docker-entrypoint.sh, lines 10–18](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/docker-entrypoint.sh#L10-L18).
- Both values are written to client runtime configuration: [apps/landing/site/env.js.template, line 1](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/env.js.template#L1).
- Landing JavaScript fetches registration info from the injected API origin: [apps/landing/site/index.html, lines 177–200](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L177-L200).
- Compose passes only `BT_WEB_ORIGIN` and defaults it to a subdomain URL regardless of `BT_MODE`; it never passes `BT_API_ORIGIN`: [infra/docker-compose.yml, lines 62–70](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L62-L70).
- The worked ports example sets topology ports but neither explicit origin: [README.md, lines 193–220](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/README.md#L193-L220).

**Recommendation**

- Derive landing API/web origins from the same topology source as the API and nginx configuration.
- Pass both origins explicitly to the landing service.
- Add Compose-render tests for subdomains, ports, custom domain, and TLS overrides.
- Add a browser test that all CTA/fetch URLs remain on the deployed instance.

## Low-severity and hardening findings

### INF-22 — Post-deploy edge/updater adoption failures are not retried until another commit

**Severity:** Low.

**Impact**

`deployed.sha` is written before static-page, edge-config, and updater self-adoption. Those steps deliberately do not fail the deployment. If adoption fails, the polling loop sees the application SHA as deployed and does not retry the adoption on the next ordinary tick; it waits for another commit/deployment. Security or legal-page updates can therefore remain unapplied longer than expected.

**Evidence**

- The marker is written before all three adoption calls: [infra/live/updater.sh, lines 227–233](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L227-L233).
- Documentation confirms adoption failures do not fail deployment and the marker is already written: [infra/live/README.md, lines 30–37](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/README.md#L30-L37).
- The copy-failure message says “retry next deploy,” not next tick: [infra/live/updater.sh, lines 159–169](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L159-L169).

**Recommendation**

- Track each adopted artifact's digest/status separately.
- Retry failed adoptions on subsequent polling ticks.
- Alert when repository and live artifact digests diverge.

### INF-23 — Live real-IP trust depends on an external edge gate

**Severity:** Low when the gate and origin firewall are enforced; Medium if they are not.

**Impact**

The live nginx configuration trusts `CF-Connecting-IP` from every RFC1918 peer because Docker Desktop NAT obscures the original client. A LAN peer or direct-origin path represented by a private Docker gateway can spoof client IPs and weaken IP-based rate limiting unless the external Cloudflare secret gate and ingress restrictions are active.

**Evidence**

- All RFC1918 peers are trusted for `CF-Connecting-IP`: [infra/live/edge/bt-live-edge.conf, lines 31–39](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/bt-live-edge.conf#L31-L39).
- The edge-secret gate is external and explicitly “OFF until a secret is set”: [infra/live/edge/bt-live-edge.conf, lines 56–60](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/bt-live-edge.conf#L56-L60).
- Only the API server block visibly enforces `$bt_edge_ok`: [infra/live/edge/bt-live-edge.conf, lines 76–102](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/bt-live-edge.conf#L76-L102).

**Recommendation**

- Verify the external gate is enabled in production and alert if its include is absent/disabled.
- Restrict origin ingress to the Cloudflare tunnel/proxy path.
- Prefer an authenticated tunnel or exact trusted proxy addresses over all private ranges.
- Test rate-limit identity from direct, LAN, and Cloudflare paths.

### INF-24 — Repeated local builds and unbounded logs can exhaust the deployment host

**Severity:** Low to Medium depending on host disk size and deployment frequency.

**Impact**

The updater rebuilds four services for every new main SHA, while Compose defines no log rotation and the updater appends indefinitely to a host log. Docker build cache, old layers, container logs, and updater/factory logs can fill disk, affecting Postgres, Redis persistence, backups, and deployment.

**Evidence**

- Every update builds web, API, worker, and landing: [infra/live/updater.sh, lines 205–226](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L205-L226).
- Updater output is append-only to its host-mounted log: [infra/live/updater.sh, lines 38–49](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L38-L49).
- No repository Compose logging limits or maintenance step are defined: [infra/docker-compose.yml, lines 13–228](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L13-L228).

**Recommendation**

- Set Docker log rotation and application log retention.
- Monitor filesystem and Docker storage usage.
- Use CI-produced immutable images instead of repeated production-host builds.
- Schedule safe, measured cache/image cleanup that never touches named data volumes.

## Positive controls

### CI and dependency controls

- Workflows explicitly limit the token to read-only repository contents: [.github/workflows/ci.yml, lines 8–10](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L8-L10), [.github/workflows/e2e-nightly.yml, lines 8–10](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/e2e-nightly.yml#L8-L10).
- No `pull_request_target` workflow was found.
- CI uses `pnpm install --frozen-lockfile`: [.github/workflows/ci.yml, lines 29–30](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L29-L30), [lines 90–91](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.github/workflows/ci.yml#L90-L91).
- The repository pins pnpm through `packageManager`: [package.json, line 6](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/package.json#L6).
- The lockfile resolves exact package versions and records integrity data: [pnpm-lock.yaml, lines 1–31](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/pnpm-lock.yaml#L1-L31).

### Container and network controls

- API uses a multi-stage build, production-only deploy output, an unprivileged runtime user, and no development source tree: [apps/api/Dockerfile, lines 21–52](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/Dockerfile#L21-L52).
- Factory also runs its operational entrypoint as an unprivileged user: [factory/Dockerfile, lines 9–19](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/factory/Dockerfile#L9-L19).
- The base production Compose file publishes no ports; topology overlays expose only the front proxy. Subdomain mode publishes one proxy port: [infra/docker-compose.subdomains.yml, lines 7–19](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.subdomains.yml#L7-L19).
- Postgres and Redis are never host-published by the production topology.
- Database and Redis have basic healthchecks, and API/worker startup dependencies wait for them: [infra/docker-compose.yml, lines 123–133](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L123-L133), [lines 187–223](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L187-L223).

### Secret and privacy controls

- Environment files, logs, runtime state, and provider authentication are ignored: [.gitignore, lines 6–13](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.gitignore#L6-L13), [lines 34–40](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.gitignore#L34-L40).
- Environment files and factory content are excluded from application Docker build contexts: [.dockerignore, lines 1–20](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/.dockerignore#L1-L20).
- Targeted tracked-file and history checks found no obvious committed API keys, private keys, or the local `.env` files.
- Pino removes cookies, authorization headers, password fields, and token/hash fields: [apps/api/src/logger.ts, lines 5–26](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/logger.ts#L5-L26).
- Sentry disables default PII and applies a scrubber to errors and transactions: [apps/api/src/services/observability/sentry.ts, lines 53–76](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/observability/sentry.ts#L53-L76).

### Backup controls

- Local backup uses strict shell mode and a pipeline whose failure propagates: [infra/backup/backup.sh, lines 18–29](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/backup.sh#L18-L29).
- It writes a temporary archive, validates gzip integrity, then atomically renames it; partial output is deleted on failure: [infra/backup/backup.sh, lines 25–37](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/backup.sh#L25-L37).
- Offsite backup mounts the source volume and credentials read-only: [infra/docker-compose.offsite.yml, lines 37–48](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.offsite.yml#L37-L48).
- The server holds only an age recipient/public key; the private identity remains offline according to the runbook: [docs/ops.md, lines 54–94](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/docs/ops.md#L54-L94).
- Plaintext dumps stay local and only encrypted `.age` output is uploaded: [infra/backup/offsite.sh, lines 59–80](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/offsite.sh#L59-L80).
- Upload failure exits nonzero before retention deletion: [infra/backup/offsite.sh, lines 73–89](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/offsite.sh#L73-L89).
- A detailed scratch-database restore drill is documented: [docs/ops.md, lines 195–270](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/docs/ops.md#L195-L270).

### Deployment controls

- Failed deployments are tracked separately from Git HEAD and retried rather than silently abandoned: [infra/live/updater.sh, lines 23–30](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L23-L30), [lines 227–236](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L227-L236).
- Live nginx candidates are staged, checked with `nginx -t`, reloaded only on success, and restored on validation failure: [infra/live/updater.sh, lines 107–148](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L107-L148).
- Updater self-copy is byte-compared before restart: [infra/live/updater.sh, lines 151–169](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L151-L169).
- Nginx `envsubst` is restricted to an explicit variable allowlist, avoiding accidental substitution of nginx runtime variables: [infra/nginx/docker-entrypoint.sh, lines 55–65](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/nginx/docker-entrypoint.sh#L55-L65).

## Validation performed

### Successful checks

- All reviewed Compose configurations parsed successfully with Docker Compose 2.34:
  - base plus subdomains production overlay;
  - base plus ports production overlay;
  - production with the offsite backup overlay;
  - development Compose;
  - single factory Compose;
  - multi-factory base and generated extra-worker Compose.
- Every reviewed Bash/POSIX shell script passed `bash -n` or `sh -n`, as appropriate.
- Selected `.mjs` operational entrypoints passed `node --check`.
- `multi-factory/test.sh` completed with **77 passed, 0 failed**. On macOS, `date -Is` emitted a compatibility warning to stderr in tests; production targets Linux, and it did not cause a test failure.
- Targeted secret-pattern searches of tracked files found no obvious private key block or concrete API-token assignment.
- `git check-ignore` confirmed both local `.env` files are ignored.
- Local file-mode inspection confirmed the multi-factory auth root uses restrictive directory permissions.
- Docker runtime inspection, after approval, found BetterTrack multi-factory containers running non-root, unprivileged, without published ports. Those containers came from a separate temporary checkout, so they were not used to claim the current checkout was deployed.
- Official lifecycle checks confirmed Alpine 3.20 is out of support and Node 22 remains supported at the review date.

### Checks that could not be completed

- `pnpm audit --prod --audit-level=low` retried and failed with DNS `ENOTFOUND`.
- An escalation to send dependency metadata to npm's audit service was not approved, so no alternate external vulnerability query was attempted.
- Targeted Vitest execution could not start because this workspace had no installed `vitest`/`node_modules`.
- ShellCheck, Hadolint, Trivy, Grype, Syft, Cosign, Actionlint, and Yamllint were unavailable.
- No full container CVE scan, SBOM, signature verification, dynamic web scan, destructive restore test, or live fault-injection test was performed.

## Scope and evidence limits

- The actual live `compose.override.yml`, `live.env`, `ddns.env`, secrets, keys, edge-secret include, TLS/Cloudflare rules, and other machine-local control files intentionally live outside the repository: [infra/live/updater.sh, lines 32–45](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L32-L45), [lines 76–85](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/updater.sh#L76-L85).
- GitHub branch protection, rulesets, required reviewers, environment approvals, token expiry, organization security, and registry controls are external state and were not inspected.
- Host cron installation, backup freshness, remote object versioning, restore-journal evidence, disk alerts, and production log permissions were not available.
- The canonical live files describe a self-adopting deployment, but current production convergence to this repository version was not independently proven.
- The generic Compose topology was audited as documented. An external live override could add missing variables, volumes, networks, or hardening; that would not fix the repository's standard-deployment drift.
- Browser localhost/private-network protections vary. The control API's missing authentication, Host/Origin validation, and CSRF controls are proven; exploitability of a particular cross-origin browser path depends on the browser and network policy.
- Targeted regex checks are not a substitute for a dedicated full-history secret scanner.
- Dependency vulnerability status remains unknown because the advisory audit could not access a registry and no local scanner/database was available.
- Existing unrelated working-tree changes were preserved and not reviewed as trusted baseline changes.

## Recommended remediation order

1. Lock the control API to loopback and add authentication, Host/Origin validation, and CSRF protection.
2. Rotate factory/repository credentials; remove tokens from Git remotes; pin and verify all factory tooling.
3. Stop deploying mutable branch source directly. Build, scan, sign, approve, and deploy immutable images.
4. Reject production placeholders, replace the administrator bootstrap flow, and remove bootstrap secrets from long-running services.
5. Introduce a dedicated encryption-key ring before the next `SESSION_SECRET` rotation.
6. Add the shared durable export volume and a split-process integration test.
7. Disable production demo seeding/logged credentials and fix local secret-file permissions.
8. Reconcile the production environment schema with Compose/examples.
9. Upgrade the backup image, correct retry behavior, and enforce monitored immutable offsite backups.
10. Add readiness/worker health, network/container hardening, security headers, bounded logs, and production alerting.
11. Package and link legal pages and derive both landing origins correctly.
12. Complete an online dependency/container audit and establish recurring CI security gates.
