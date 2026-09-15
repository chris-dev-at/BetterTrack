# Pass 05 — Remediation roadmap

_Archived 2026-09-02 — part of the 2026-07-26 review round; its findings were triaged into issues and are recorded in `PROJECTPLAN.md` §16._

## Goal

This roadmap turns the review into release gates. Ordering follows exploitability and dependency: establish credential/session invariants first, then contain autonomous and deployment trust, then address data governance, operational resilience, and interface quality.

## Phase 0 — Immediate containment

Complete before further public exposure or autonomous production deployment.

### 0.1 Protect the multifactory control plane

- Keep it loopback-only or expose it through a Unix socket.
- Add a random bearer credential or mutual TLS.
- Enforce exact Host and Origin allowlists, JSON Content-Type, and CSRF protection.
- Restrict provider-spending and Docker-control actions separately.
- Add negative tests for LAN, cross-origin, DNS-rebinding, missing-auth, and malformed-content requests.

### 0.2 Remove dangerous bootstrap states

- Reject known placeholders and weak `ADMIN_PASSWORD` values in production.
- Generate a one-use random setup secret and set `mustChangePassword: true`.
- Do not expose bootstrap credentials to long-running API/worker containers.
- Disable demo seeding by default in production and stop logging passwords.
- Locate and remove unintended production demo accounts and rotate any credential that may have entered persistent logs.

### 0.3 Stabilize encryption keys

- Make a dedicated encryption key mandatory in production.
- Pass it consistently to API and worker.
- Add versioned envelopes and a decrypt keyring.
- Provide an online migration/reencryption procedure before rotating keys.
- Test session-key rotation against existing TOTP and Discord records.

### 0.4 Pause automatic unverified production promotion

- Require protected human approval for production releases.
- Deploy CI-built immutable image digests, not a mutable checkout of `origin/main`.
- Verify signature, SBOM, scan result, and provenance before migrations.
- Prevent workflow, infrastructure, authentication, and authorization changes from autonomous merge without designated review.

## Phase 1 — Authentication and authorization invariants

### 1.1 Session-bound administrator assurance

- Add `mfaVerifiedAt`, authentication method, and assurance level to each session.
- Rotate the session identifier after MFA.
- Revoke or downgrade sessions after promotion, factor enrollment/reset, password change, and recovery events.
- Apply the same session-level MFA and admin limiter to Bull Board.
- Prefer a read-only, payload-redacted queue dashboard.

Required tests:

- old session after factor enrollment;
- user session after administrator promotion;
- admin password-only session against every admin route and Bull Board;
- factor reset/recovery and session downgrade;
- concurrent sessions with different assurance.

### 1.2 Central active-user enforcement

- Create one authentication choke point that requires `user.status === active`.
- Apply it to API keys, OAuth access tokens, refresh tokens, authorization-code exchange, and Socket.IO.
- On disable, revoke keys/grants or record an account security epoch checked by every credential.
- Disconnect active sockets on disable, logout, expiry, key revocation, grant revocation, and password reset.

Required tests:

- disable an account, then exercise every credential type and an already-open socket;
- re-enable behavior only after explicit credential reissuance;
- authorization-code and refresh-token paths for disabled users.

### 1.3 Realtime least privilege and resource control

- Attach credential kind and effective scopes to every socket.
- Scope-gate auto-rooms, notifications, chat, portfolio events, presence, room joins, and live market data.
- Add connection/account, events/second, watches/socket, watches/account, and global provider-loop limits.
- Add backpressure and bounded history work.
- Validate browser Origin with an explicit no-Origin/native-client policy.

Required tests:

- complete negative scope matrix;
- direct-WebSocket Origin rejection;
- revocation after connect;
- connection/watch/event quota boundaries;
- provider failure and backpressure behavior.

## Phase 2 — Atomic security workflows

### 2.1 Consume password-reset tokens atomically

- Atomically mark an unexpired token used before password mutation.
- Complete token consumption, password update, session revocation, and new-session issuance in one transaction.
- Enforce one active reset generation per user.

### 2.2 Make OAuth refresh replay races fail closed

- Revoke the complete grant/token family whenever atomic consume loses a race.
- Couple consume and replacement issuance transactionally.

### 2.3 Serialize the last-administrator invariant

- Use a transaction with an advisory/row lock or a database-enforced invariant.
- Cover single and bulk disable, demotion, and deletion.

### 2.4 Add recent-authentication step-up

- Require current password, existing factor, or a short-lived recent-auth proof before PIN changes, persistent-session creation, remembered-device creation, factor disablement, recovery regeneration, and administrator security changes.
- Notify the user and revoke other sessions after material changes.
- Give remembered devices a TTL and per-user revocation index.

## Phase 3 — Data and integration safety

- Restrict Web Push endpoints to recognized services or reject private, loopback, link-local, and rebinding destinations after DNS resolution.
- Bound multipart fields, parts, field sizes, distinct instruments, and provider enrichment work.
- Move large import resolution into bounded asynchronous jobs.
- Use explicit export allowlists and one-time HttpOnly download exchanges.
- Set Discord `allowed_mentions` to an empty parse list.
- Equalize or queue password-reset delivery work to reduce timing disclosure.
- Proxy/cache OAuth client logos and remove pre-consent third-party loads.

## Phase 4 — Deployment and operational correctness

- Add a shared restricted export volume or object store to API and worker.
- Centralize the supported production environment block and test it against the schema and example.
- Derive web and API origins from the same topology configuration.
- Ship legal routes in every supported deployment.
- Add CSP, `frame-ancestors`, HSTS, Referrer-Policy, and Permissions-Policy to static hosts.
- Configure proxy trust for the real ingress chain rather than a generic hop count.
- Split liveness from readiness; readiness must test Postgres and Redis.
- Add a worker healthcheck and require a heartbeat after startup grace.
- Put backup scheduling under versioned configuration, alert on freshness, use an immutable/versioned offsite destination, and record restore evidence.
- Upload every missing backup rather than only the newest one.
- Upgrade the unsupported Alpine backup base.
- Pin actions, images, factory tools, and installers to reviewed SHAs/digests/checksums.
- Add dependency, secret, container, SBOM, and provenance checks to CI.

## Phase 5 — Privacy and legal alignment

- Define retention and deletion behavior for audit, email, chat, remembered devices, and backups.
- Implement scheduled purge/anonymization.
- Reconcile account-deletion and export claims with tested behavior.
- Maintain a complete processor/cookie/storage inventory.
- Replace legal placeholders and ship instance-correct legal documents.
- Obtain qualified legal review before public launch.

## Phase 6 — Accessibility and usability baseline

- Replace or repair shared dialog/menu primitives with tested focus trapping, initial focus, background inertness, restoration, and complete keyboard interaction.
- Add headings, landmarks, skip links, and field error associations.
- Convert clickable table rows to real links and make dense tables responsive.
- Add a touch-accessible global search entry point and auto-scroll active navigation tabs into view.
- Make chat IME-safe, expose a polite live log, and avoid forced scrolling when reading history.
- Add confirmations/undo for destructive administrator actions and explicit acknowledgement for one-time secrets.
- Correct contrast, link affordances, and chart data alternatives.
- Distinguish offline/5xx failures from invalid credentials, links, and missing resources.
- Render landing registration copy for each actual mode.
- Return standards-compliant OAuth denial redirects.
- Either complete administrator localization or label it English-only.
- Remove stale “Coming Soon” states for implemented features and clearly separate roadmap surfaces.

## Definition of release-ready

Release readiness should require:

1. every High finding closed with a regression test;
2. no bearer or socket credential surviving account suspension;
3. every administrator action requiring session-bound MFA;
4. verified key rotation with existing encrypted data;
5. a two-container export test passing in Compose;
6. an authenticated and network-contained factory control plane;
7. an attested immutable deployment artifact and protected approval;
8. tested deletion/retention behavior and production-complete legal pages;
9. passing typecheck, lint, unit, integration, E2E, accessibility, dependency, secret, and container scans;
10. a successful monitored backup restore drill.
