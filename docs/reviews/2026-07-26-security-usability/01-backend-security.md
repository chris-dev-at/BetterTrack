# BetterTrack Backend Security Review

**Review date:** 2026-07-26
**Scope:** `apps/api`, backend-facing contracts, database schema and migrations, authentication and sessions, OAuth and API keys, authorization, realtime, imports/exports, outbound integrations, administration, privacy, and production composition.
**Method:** Read-only source review with line-level validation. No production probing, dependency penetration testing, or code changes were performed.

## Executive summary

The backend has a strong conventional security baseline: password and PIN hashing use Argon2id, opaque credentials are generated with sufficient entropy and normally stored only as hashes, HTTP cookies/CORS/CSRF controls are thoughtfully composed, Google OAuth uses state binding, and repository ownership checks make conventional IDOR difficult.

The most important risks sit at trust-boundary transitions that are less mature than the normal HTTP session path:

- Disabling an account kills cookie sessions but leaves personal API keys and OAuth credentials usable.
- Admin MFA is an account property rather than a property of the current session, and Bull Board bypasses the MFA gate entirely.
- Realtime authentication discards bearer scopes, does not observe later credential revocation, and exposes unbounded live-market work.
- The documented session-signing-key rotation procedure changes the fallback data-encryption key, making existing TOTP secrets and Discord webhooks unreadable.
- Several security-setting endpoints allow a stolen authenticated session to establish durable access without recent-authentication proof.

No Critical issue was confirmed. This review records six High findings, eleven Medium/Medium-High findings, and five Low or conditional findings. The recommended remediation order is:

1. Enforce active-user status for every bearer and OAuth exchange path.
2. Introduce session-bound MFA assurance and put every admin surface, including Bull Board, behind it.
3. Carry scopes and revocation state into realtime, then add connection/event/watch budgets.
4. Separate long-lived encryption keys from session-cookie rotation.
5. Add step-up authentication and lifecycle revocation for security credentials.
6. Make reset/refresh/admin invariants transactional.

## Severity model

- **High:** Practical compromise of a major security boundary, administrator assurance, or shared service availability.
- **Medium-High:** Material security failure with stronger preconditions or a narrower post-compromise capability.
- **Medium:** Meaningful confidentiality, integrity, availability, or privacy weakness with bounded exploitability.
- **Low:** Defense-in-depth, side-channel, conditional deployment, or limited-impact issue.

---

## High findings

### H-01 — Disabled accounts retain API-key and OAuth access

**Severity:** High
**Preconditions:** The attacker possesses a personal API key, OAuth access token, refresh token, or unexpired authorization code issued before the account is disabled.

**Impact**

Disabling a user destroys their cookie sessions but does not revoke or status-gate bearer credentials. A suspended account can continue reading or mutating every API surface authorized by its token, refresh an OAuth grant, or exchange an already-issued authorization code. Personal API keys have no expiry, so this can be durable.

**Evidence**

- API-key lookup joins the user but filters only token hash and `revokedAt`: [apiKeyRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/apiKeyRepository.ts#L50-L58).
- API-key authentication returns that user without checking `status`: [apiKeyService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/apiKeys/apiKeyService.ts#L116-L133).
- OAuth access-token lookup filters token/grant state but not user status: [oauthRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/oauthRepository.ts#L308-L321).
- Refresh-token lookup does not even join the user: [oauthRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/oauthRepository.ts#L336-L346).
- Access authentication and both token-exchange flows omit an active-user check: [oauthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/oauth/oauthService.ts#L561-L582), [oauthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/oauth/oauthService.ts#L597-L657), [oauthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/oauth/oauthService.ts#L659-L701).
- Admin disable only changes status and destroys sessions: [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L204-L215).
- The cookie-session path correctly rejects non-active users, showing the intended behavior: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L782-L790).

**Recommendation**

- Require `user.status === 'active'` in the personal-key and OAuth authentication choke points.
- Repeat the check when exchanging authorization codes and refresh tokens, not only when using access tokens.
- Revoke personal keys and OAuth grants as part of account disable.
- Emit a security event that disconnects already-connected realtime clients.
- Add integration tests that disable a user and assert rejection of every preexisting credential type.

### H-02 — Administrator MFA assurance is not bound to the current session

**Severity:** High
**Preconditions:** A password-only, stolen, pre-enrollment, or pre-promotion session remains active while the account is later promoted or any other session enrolls MFA.

**Impact**

`requireAdminTwoFactor` asks only whether the administrator account has an enabled method. It does not establish that the current session passed a second factor. Session resolution reloads current role information on every request, while role promotion does not revoke existing sessions. A normal user session can therefore become an administrator session after promotion. Once any session enables MFA, all stale sessions inherit that assurance and can use the administration API.

The admin 2FA-management endpoints are deliberately registered before the setup gate. That is necessary for initial enrollment, but it also means a stale password-only admin session can reach factor-management operations without proving the account's existing factor.

**Evidence**

- The gate checks only account-level `isEnabled(userId)`: [session.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/middleware/session.ts#L135-L152).
- Session resolution reloads the current user row and therefore current role: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L782-L800).
- Role changes do not destroy or rotate sessions: [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L237-L252).
- Admin security routes run before the MFA gate: [adminRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/adminRoutes.ts#L65-L74), [adminSecurityRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/adminSecurityRoutes.ts#L17-L29).
- TOTP confirmation enables the account method but does not rotate/revoke sessions: [twoFactorService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/twoFactorService.ts#L246-L282).

**Recommendation**

- Store authentication assurance in session state, for example `mfaVerifiedAt`, `authLevel`, and the method used.
- Require current-session MFA for every non-bootstrap admin operation.
- Rotate the session ID after successful MFA.
- Destroy existing sessions on role promotion, MFA enrollment, factor reset, and break-glass recovery.
- Permit bootstrap enrollment only when the account genuinely has no enabled method; otherwise require a current factor/recovery proof.

### H-03 — Bull Board bypasses mandatory admin MFA and the admin limiter

**Severity:** High
**Preconditions:** An authenticated administrator session that has not established current-session MFA, including a newly seeded or not-yet-enrolled admin.

**Impact**

The queue inspector is mounted outside and before the normal admin router. It receives `requireAdmin` but not the admin-specific rate limiter or mandatory MFA gate. Bull Board's default adapter is not configured read-only, so the surface exposes job data and queue actions such as retrying, removing, cleaning, pausing, or resuming work. Notification jobs can contain user identifiers and message context.

**Evidence**

- Special mount applies only `requireAdmin`: [app.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/app.ts#L94-L100).
- Normal admin middleware applies the admin limiter, role check, and then MFA: [adminRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/adminRoutes.ts#L62-L75).
- Bull Board constructs default adapters without `readOnlyMode`: [bullBoard.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/bullBoard.ts#L41-L48).
- The source comment incorrectly claims the router is already behind mandatory MFA: [bullBoard.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/bullBoard.ts#L9-L20).

**Recommendation**

- Apply `limiters.admin`, `requireAdmin`, and session-bound MFA explicitly at the Bull Board mount.
- Configure Bull Board read-only unless production operations genuinely require mutation.
- Redact job payloads and return values containing identifiers or notification content.
- Add an integration test proving that an unenrolled/password-only administrator cannot open the UI or invoke its API actions.

### H-04 — Realtime bearer authentication discards scopes

**Severity:** High
**Preconditions:** Any valid personal API key or OAuth token, including one with only a narrow scope such as `chat:read`.

**Impact**

The realtime resolver reduces a valid credential to a user identity and discards token kind and effective scopes. Every accepted bearer automatically joins the user's room and can receive notification, portfolio, and chat events regardless of scope. It can also join asset/portfolio rooms and invoke `live.watch`, which returns real price/history frames despite the source comment claiming that sockets carry only insensitive invalidations.

**Evidence**

- `resolveBearer` returns only identity/role/password-change state: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L95-L105).
- `authenticate` returns only `user.id`: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L200-L215).
- Connections automatically join `user:{id}`: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L503-L505).
- Notification, portfolio, and chat events are emitted to that room: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L421-L466).
- `live.watch` resolves assets and returns actual frames: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L299-L349).
- The current test suite explicitly expects a narrow `chat:read` token to receive a notification event: [gateway.test.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/__tests__/gateway.test.ts#L213-L238).

**Recommendation**

- Return and attach a full credential principal to each socket: kind, credential ID, effective scopes, user status, and expiry.
- Scope-gate automatic room admission, each event family, portfolio/asset joins, presence, and live-market operations.
- Consider a dedicated realtime scope if event-level mappings become ambiguous.
- Build a negative scope matrix covering every event and command for personal and OAuth credentials.

### H-05 — Realtime has no connection, event, or live-watch resource budgets

**Severity:** High for availability
**Preconditions:** One authenticated account or bearer credential. Multiple concurrent sockets and many distinct catalog assets amplify the attack.

**Impact**

There is no cap on sockets per account, client events per second, watched assets per socket/account, or total shared provider loops. Each new distinct `live.watch` can perform asset resolution, start an immediate provider poll, maintain an in-memory timer/loop, write Redis ring frames, and fetch history/quotes for backfill. Clients may request one-second cadence. This can exhaust provider budgets, timers, memory, Redis operations, and shared market-data capacity.

**Evidence**

- Per-socket watched assets are stored in an unbounded `Map`: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L261-L270).
- Each new watch resolves, registers, joins, and backfills: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L299-L349).
- Connection handlers have no rate limiter or admission budget: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L503-L555).
- Each distinct asset creates an immediate polling loop: [liveModeService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/liveMode/liveModeService.ts#L238-L261).
- Backfill may call both provider history and quote APIs: [liveModeService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/liveMode/liveModeService.ts#L286-L314).
- The contract permits a one-second requested rate: [realtime.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/realtime.ts#L145-L165).

**Recommendation**

- Limit concurrent sockets per user and credential.
- Add per-socket and per-account event token buckets.
- Cap active watched assets per socket/account and total live loops globally.
- Require `market:read` for bearer live watches.
- Reject new work under provider/circuit-breaker distress instead of growing queues without bound.
- Test quotas, acknowledgements, and cleanup after disconnect.

### H-06 — Documented session-secret rotation breaks encrypted TOTP and Discord data

**Severity:** High for operational availability and administrator recovery
**Preconditions:** `TOTP_ENCRYPTION_KEY` is unset, as in the supplied production Compose configuration, and an operator rotates `SESSION_SECRET` using the documented comma-separated `new,old` format.

**Impact**

Cookie signing treats `SESSION_SECRET` as a rotation list, but fallback AES key derivation hashes the entire unsplit string. Changing `old` to `new,old` therefore derives a new encryption key. Existing TOTP secrets fail decryption, potentially locking out all TOTP-only users and administrators; Discord webhook envelopes also become unreadable and notifications silently stop.

**Evidence**

- `SESSION_SECRET` is documented as comma-separated rotation material: [env.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L19-L20).
- Fallback encryption derives from the entire raw value before splitting: [env.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L481-L486).
- Cookie secrets are split only afterward: [env.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L498-L500).
- AES-GCM correctly fails on a wrong key: [secretBox.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/crypto/secretBox.ts#L31-L51).
- TOTP verification catches decryption failure and rejects the code: [twoFactorService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/twoFactorService.ts#L164-L177).
- Discord delivery uses the same envelope key: [discordSetupService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/discordSetupService.ts#L58-L72), [discordChannel.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/discordChannel.ts#L125-L135).
- Compose passes `SESSION_SECRET` but not `TOTP_ENCRYPTION_KEY` to API or worker: [docker-compose.yml](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L82-L122), [docker-compose.yml](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L145-L186).

**Recommendation**

- Require a dedicated data-encryption key in production and pass it identically to API and worker.
- Store a key/version identifier in every envelope and support a decryption keyring.
- Re-encrypt stored envelopes before retiring an old key.
- Derive fallback material from the active cookie key only if a development fallback must remain.
- Add a regression test that rotates cookie secrets while preserving old encrypted data.

---

## Medium and Medium-High findings

### M-01 — Active realtime connections ignore later revocation, expiry, logout, and suspension

**Severity:** Medium-High
**Preconditions:** The socket successfully connects before its session/key/grant is revoked, token expires, or user is disabled.

**Impact**

Authentication occurs once during the Socket.IO handshake. All later handlers trust the cached user ID forever. Logout, session revocation, API-key revocation, OAuth grant revocation/access expiry, and administrator suspension do not disconnect the socket. It can continue receiving user-room identifiers, creating live watches, joining still-authorized rooms, and influencing presence.

**Evidence**

- Authentication is performed only in `io.use`: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L487-L501).
- Event handlers trust `socket.data.userId` for the life of the connection: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L503-L555).
- Existing tests cover revocation before connect, not after connect: [gateway.test.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/__tests__/gateway.test.ts#L269-L279).

**Recommendation**

- Maintain a socket index keyed by session/credential/user.
- Publish and consume logout, revocation, disable, and role/password-change events that disconnect affected sockets.
- Revalidate credential expiry periodically or before privileged commands.
- Bound maximum socket age and require reconnect.

### M-02 — Security-setting mutations do not require recent authentication

**Severity:** Medium-High
**Preconditions:** A stolen authenticated cookie session or an OAuth/API credential with `account:security`.

**Impact**

An attacker can replace or disable the PIN, create a long-lived remembered-device credential, make a session persistent without proving the PIN, disable email 2FA, or regenerate and read new recovery codes. Admin email-factor disable and recovery regeneration are reachable before the admin MFA setup gate. These actions let a temporary session compromise become durable.

**Evidence**

- PIN set/change/disable requires only authentication: [authRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/authRoutes.ts#L260-L270).
- Remember-device creation has no current-password/PIN proof: [authRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/authRoutes.ts#L320-L327), [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L1333-L1360).
- Session persistence checks that a PIN exists but never verifies it: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L1444-L1457).
- User email-2FA disable and recovery regeneration require only a session: [authRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/authRoutes.ts#L396-L407), [twoFactorService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/twoFactorService.ts#L386-L420).
- Equivalent admin routes also lack proof: [adminSecurityRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/adminSecurityRoutes.ts#L80-L87), [adminTwoFactorService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminTwoFactorService.ts#L249-L269).
- TOTP disable already verifies a factor, demonstrating the safer pattern: [twoFactorService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/twoFactorService.ts#L285-L303).

**Recommendation**

- Introduce a short-lived, session-bound recent-auth proof.
- Require current password plus an enabled second factor for PIN, persistence, remembered-device, recovery-code, and factor-disable operations.
- Revoke other sessions/remembered devices and send a security notification after high-risk changes.

### M-03 — Remembered-device credentials have no TTL or user-side revocation index

**Severity:** Medium
**Preconditions:** The attacker already holds a remembered-device cookie and knows or has replaced the account PIN.

**Impact**

The Redis mapping is permanent and stored only by device ID. Password changes, session revoke-all, PIN changes, and security resets cannot enumerate or remove it. A disabled account is blocked while disabled because quick-auth reloads status, but the credential survives and can become usable again after re-enable. Deleted-user UUIDs can also remain indefinitely as stale Redis data.

**Evidence**

- The design explicitly uses no server-side TTL: [loginThrottle.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/loginThrottle.ts#L64-L73).
- Quick-auth converts the mapping and PIN into a new session: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L1265-L1330).
- Remember-device writes an unindexed, non-expiring key: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L1333-L1347).
- Only the presenting device's forget flow can delete the mapping: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L1363-L1375).
- Session revoke-all deletes session keys only: [sessionService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/sessions/sessionService.ts#L260-L267).

**Recommendation**

- Add a finite maximum lifetime and idle lifetime.
- Maintain a per-user remembered-device index and expose device management.
- Clear all mappings on password/PIN change, factor reset, revoke-all, admin disable/reset, and account deletion.

### M-04 — Password-reset token consumption has a race

**Severity:** Medium
**Preconditions:** An attacker can submit the same valid reset token concurrently, normally because the token was stolen or the client retried aggressively.

**Impact**

Reset completion reads token state, performs an expensive password hash and password update, and only afterward marks the token used with an unconditional update. Two concurrent calls can both pass, write different passwords, and in some interleavings mint separate sessions. Reset issuance also performs delete-then-insert without a transaction or one-active-token database constraint.

**Evidence**

- Token lookup and unconditional `markUsed` are separate operations: [passwordResetTokenRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/passwordResetTokenRepository.ts#L33-L47).
- Issuance deletes and inserts separately: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L927-L941).
- Completion checks, hashes, updates the password, then consumes/deletes tokens: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L959-L984).
- Existing replay coverage is sequential rather than concurrent: [selfServiceReset.test.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/__tests__/selfServiceReset.test.ts#L163-L176).

**Recommendation**

- Atomically consume with `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING`.
- Complete token consumption, password update, token-family deletion, and session invalidation in one transaction.
- Add a generation or partial unique constraint for the one-active-token invariant.

### M-05 — OAuth refresh-token family replay detection fails under concurrency

**Severity:** Medium
**Preconditions:** A stolen refresh token is replayed concurrently with its legitimate use.

**Impact**

Sequential reuse observes `consumedAt` and revokes the grant. Under a race, both callers can initially read an unconsumed row. The loser of the atomic consume merely throws and does not revoke the grant, leaving the winner's freshly issued access/refresh pair active. This defeats the intended family-compromise response.

**Evidence**

- Atomic token consumption is correctly implemented in the repository: [oauthRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/oauthRepository.ts#L349-L356).
- The service revokes only when `consumedAt` was visible before the consume, not when atomic consume loses: [oauthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/oauth/oauthService.ts#L674-L691).
- Current tests exercise sequential replay: [oauth.test.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/__tests__/oauth.test.ts#L487-L525).

**Recommendation**

- Revoke the grant when `consumeRefreshToken` returns no row.
- Prefer a transactional token-family/generation design so rotation and compromise revocation cannot race.
- Test two concurrent refresh calls and assert the winner's issued pair is also invalidated.

### M-06 — Blind HTTPS SSRF through Web Push subscription endpoints

**Severity:** Medium
**Preconditions:** VAPID is enabled; an authenticated attacker registers a valid Web Push key pair and arbitrary HTTPS endpoint, then causes a notification addressed to that account.

**Impact**

Subscription validation accepts any URL and the worker later hands it directly to `web-push`. An attacker can induce blind HTTPS POSTs from the worker network to internal services or attacker-controlled hosts. The body is encrypted and response data is not returned, which limits impact, but private-network reachability, side effects, and DNS rebinding remain concerns.

**Evidence**

- Contract validation checks URL syntax but not protocol, host, or resolved address: [notifications.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/notifications.ts#L131-L138).
- Subscription service persists the endpoint unchanged: [notificationService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/notificationService.ts#L132-L137).
- Delivery passes the stored endpoint directly to the outbound transport: [webPush.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/webPush.ts#L60-L72).

**Recommendation**

- Require HTTPS.
- Resolve and reject loopback, private, link-local, multicast, and reserved addresses for both IPv4 and IPv6.
- Revalidate after DNS resolution at send time and prevent DNS rebinding.
- Restrict endpoints to known browser push-service domains where operationally possible.
- Cap subscriptions per account.

### M-07 — Direct WebSocket handshakes do not enforce Origin

**Severity:** Medium, conditional
**Preconditions:** For cookie authentication, the attacker controls a malicious same-site sibling subdomain or different port so `SameSite=Lax` still permits the API cookie. A truly unrelated cross-site origin will generally not receive the cookie. Bearer exploitation additionally requires access to a token.

**Impact**

Socket.IO CORS configuration protects HTTP long-polling, not direct WebSocket transport. No `allowRequest` or equivalent Origin admission check is present. A malicious same-site application can connect directly, read user-room identifiers/events, and invoke realtime commands.

**Evidence**

- Socket configuration declares transports and CORS but no handshake admission callback: [gateway.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/realtime/gateway.ts#L470-L485).
- The cookie is host-only and `SameSite=Lax`, reducing but not eliminating same-site sibling risk: [cookies.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/cookies.ts#L16-L30).

**Recommendation**

- Enforce the exact derived web/admin Origin allowlist in `allowRequest`.
- Define an explicit policy for native/no-Origin clients and require bearer authentication for that path.
- Test a direct WebSocket connection from an allowed Origin, disallowed cross-site Origin, and malicious same-site sibling Origin.

### M-08 — Account deletion retains direct identifiers without an implemented retention policy

**Severity:** Medium privacy/compliance risk
**Preconditions:** A user deletes their account or an administrator deletes it.

**Impact**

Audit records retain IP, target UUID, and metadata indefinitely; deletion itself writes the former username after the user row is removed. Email-log rows retain the full recipient address and subject after their user FK becomes null. Export explicitly excludes these records as independently retained. Remembered-device Redis mappings can also survive. The UI promises permanent deletion of data belonging to the account, so implementation, disclosure, and export behavior are not fully aligned.

This is a privacy/product-risk finding, not a legal conclusion. Retaining limited security records can be justified, but it needs a stated purpose, minimized identifiers, and bounded retention.

**Evidence**

- Audit schema intentionally survives deletion and retains IP/meta: [schema.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/schema.ts#L357-L370).
- Email log retains recipient and subject after `userId` is set null: [schema.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/schema.ts#L640-L665).
- Self-delete writes username, IP, and target ID after removal: [accountDeletionService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/account/accountDeletionService.ts#L134-L150).
- Admin deletion writes the old username too: [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L371-L389).
- Export skips both record sets as independently retained: [manifest.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/manifest.ts#L70-L80).
- UI deletion language promises permanent deletion while separately disclosing retained anonymized chat: [en.json](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/i18n/messages/en.json#L2253-L2261).

**Recommendation**

- Define, document, and enforce retention periods per record category.
- Delete or irreversibly anonymize direct identifiers when their purpose no longer requires them.
- Include applicable personal records in export or clearly document a justified exception.
- Add scheduled purge jobs and redact recipient emails/IPs from operational logs where possible.
- Clear non-database credentials such as remembered-device mappings.

### M-09 — Import processing permits multipart and provider-work amplification

**Severity:** Medium for availability
**Preconditions:** Any authenticated user or bearer with portfolio-write access.

**Impact**

Multer holds uploads in memory and limits only file bytes and file count; it does not cap field count, part count, or field size. A nominally valid CSV may contain up to 5,000 rows and 5,000 distinct instruments. Resolution is sequential and can repeatedly invoke search, wait for provider enrichment, and retry, tying up an HTTP request and consuming shared provider/DB capacity.

**Evidence**

- In-memory upload limits omit `fields`, `parts`, and `fieldSize`: [importsRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/importsRoutes.ts#L39-L44).
- Contract permits 5 MB and 5,000 rows: [imports.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/imports.ts#L158-L162).
- Resolution can call search, wait for enrichment, and search again: [importService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/imports/importService.ts#L172-L208).
- Distinct identities are resolved one at a time inside the request: [importService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/imports/importService.ts#L353-L360).

**Recommendation**

- Add strict multipart `fields`, `parts`, `fieldSize`, and header limits.
- Cap distinct instruments well below row count.
- Batch/local-resolve first and move enrichment to a bounded asynchronous job.
- Charge import resolution against search/provider budgets.

### M-10 — The last-active-admin invariant is race-prone

**Severity:** Medium
**Preconditions:** Two active administrators concurrently disable, demote, delete, or bulk-disable one another.

**Impact**

The service counts active admins and then performs a separate update/delete without transaction serialization. Two requests can both observe two active administrators and both proceed, leaving zero active administrators. Multi-field admin updates also perform independent mutations, so a later validation/error can leave earlier fields committed.

**Evidence**

- Count-then-act helper is non-transactional: [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L90-L103).
- Bulk disable uses one precomputed count: [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L105-L149).
- Disable/demote/delete call the check before independent writes: [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L204-L252), [adminService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/admin/adminService.ts#L371-L381).
- Repository count and status updates are ordinary separate statements: [userRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/userRepository.ts#L99-L106), [userRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/userRepository.ts#L285-L290).

**Recommendation**

- Serialize these operations in a database transaction using row/advisory locks.
- Prefer a conditional update or database-enforced invariant where feasible.
- Make multi-field administrator edits atomic.
- Add concurrent disable/demote/delete tests.

### M-11 — Production Compose does not provide shared export storage

**Severity:** Medium availability/usability
**Preconditions:** Production uses the supplied Compose file with separate API and worker containers and leaves `BT_EXPORT_DIR` unset.

**Impact**

The API enqueues export builds to the worker. The worker writes the ZIP to its own container-local temp directory and stores that path in the database. The API container later tries to serve the worker's path, but no export directory or shared volume is configured. Export requests can reach `ready` in the database while downloads fail because the file exists only inside the worker container; restarts also discard it.

**Evidence**

- Configuration explicitly requires a path writable by both processes and durable across restart: [env.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L135-L141).
- The worker writes the ZIP to its local filesystem and records the path: [exportService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/exportService.ts#L230-L253).
- Compose passes neither `BT_EXPORT_DIR` nor a shared export volume to API/worker: [docker-compose.yml](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L72-L133), [docker-compose.yml](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L135-L190).

**Recommendation**

- Define one explicit `BT_EXPORT_DIR` in both containers.
- Mount the same dedicated volume at that path for API and worker.
- Use restrictive ownership/mode and include cleanup/backup behavior in deployment documentation.
- Add a Compose-level smoke test that requests, builds, and downloads an export across the two processes.

---

## Low and conditional findings

### L-01 — Export download credential is stored in `localStorage` and placed in a query string

**Severity:** Low-Medium
**Preconditions:** Browser XSS, a malicious extension/local user, browser history inspection, or infrastructure that logs query strings. A live authenticated session is still required for download.

**Impact**

The raw export token is described as fresh reauthentication proof but is stored indefinitely in `localStorage` and inserted into a GET URL. This broadens exposure beyond the intended one-time response and can place the token in browser history, access logs, monitoring, and extension-visible storage.

**Evidence**

- The SPA persists the raw token under a fixed `localStorage` key: [AccountSettingsPage.tsx](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/AccountSettingsPage.tsx#L33-L55), [AccountSettingsPage.tsx](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/AccountSettingsPage.tsx#L318-L337).
- The download URL places it in `?token=`: [userApi.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/userApi.ts#L420-L427).
- Backend download is session- plus token-gated, limiting impact: [accountRoutes.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/routes/accountRoutes.ts#L73-L84).

**Recommendation**

- Prefer a short-lived one-time HttpOnly cookie or POST body.
- Clear client state immediately after successful download and at server expiry.
- Add `Cache-Control: no-store` and a strict referrer policy.
- Ensure proxies and application access logs redact query strings on this route.

### L-02 — Discord chat notifications permit mention injection

**Severity:** Low
**Preconditions:** An attacker can send a chat message to a user who routes chat notifications to a Discord webhook.

**Impact**

User-controlled sender names and message previews are interpolated into Discord `content`. The webhook request does not set `allowed_mentions`, despite a comment claiming that content cannot ping `@everyone`. This may generate disruptive mass mentions where the webhook has permission.

**Evidence**

- Chat notification body contains user-controlled sender/preview text: [notificationDispatcher.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/notificationDispatcher.ts#L449-L457).
- Discord POST sends only `{ content }`: [discordChannel.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/discordChannel.ts#L93-L112).
- Rendering performs truncation but no mention/Markdown neutralization: [discordChannel.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/discordChannel.ts#L164-L172).

**Recommendation**

- Send `allowed_mentions: { parse: [] }`.
- Escape or neutralize Markdown if formatting spoofing is also undesirable.
- Test `@everyone`, `@here`, role, and user mention strings.

### L-03 — Password-reset account enumeration remains possible through timing

**Severity:** Low-Medium
**Preconditions:** An attacker can make repeated reset requests and measure response time; per-IP limiting constrains but does not eliminate distributed sampling.

**Impact**

The response content is uniform, but only an active user account performs token deletion/insertion, audit writes, and awaited email delivery. Unknown, disabled, and admin accounts return with substantially less work, potentially leaking account state through latency.

**Evidence**

- The entire DB/email branch is conditional on an active user-kind match: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L927-L956).
- Login has a dummy-hash timing defense, showing the intended treatment of account enumeration: [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L435-L441).

**Recommendation**

- Queue email delivery asynchronously and equalize response-side database work.
- Add bounded random delay only as supplementary defense, not instead of consistent work.
- Monitor reset requests across IPs and identifiers.

### L-04 — The one-export-per-day gate is race-prone

**Severity:** Low
**Preconditions:** An authenticated user submits several export requests concurrently after reauthentication.

**Impact**

The service reads the latest job and then independently inserts a new one. Concurrent requests can all observe no recent job and create multiple CPU/storage-intensive export jobs, bypassing the intended daily limit.

**Evidence**

- Rate check and job creation are separate operations: [exportService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/exportService.ts#L184-L206).
- Repository exposes `hasJobSince` but it is still a non-locking read and is not used by the service: [exportRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/exportRepository.ts#L102-L108).

**Recommendation**

- Enforce the limit transactionally with an advisory lock per user, a period key, or a conditional database insert.
- Add a concurrent request test asserting exactly one job and enqueue.

### L-05 — Export file permissions rely on process defaults

**Severity:** Low, deployment-dependent
**Preconditions:** API/worker share a host or volume with other untrusted OS users/containers, and the process umask permits group/world access.

**Impact**

Export ZIPs contain a user's full financial dataset. Directory and file creation do not specify restrictive modes, so confidentiality depends on container/host umask and volume ownership.

**Evidence**

- Export build uses default `mkdir` and `writeFile` modes: [exportService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/exportService.ts#L240-L246).

**Recommendation**

- Create the directory as `0700` and files as `0600`.
- Validate volume ownership at startup and fail closed in production if it is unsafe.
- Keep export storage dedicated rather than reusing a broadly mounted path.

---

## Positive security controls

The following controls materially reduce risk and should be preserved during remediation:

- **Credentialed HTTP CORS uses an exact derived allowlist, never `*`:** [cors.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/middleware/cors.ts#L18-L43).
- **Cookie-authenticated mutations require a custom header and validate Origin:** [csrf.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/middleware/csrf.ts#L22-L41).
- **Session and remembered-device cookies are signed and HttpOnly; sessions use `SameSite=Lax` and TLS-derived `Secure`:** [cookies.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/cookies.ts#L16-L40).
- **Sessions are random server-side credentials and live user status is rechecked for every HTTP request:** [authService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/authService.ts#L782-L800).
- **Passwords and PINs use Argon2id with 64 MiB, three iterations, and parallelism one:** [passwordHasher.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/password/passwordHasher.ts#L3-L19).
- **Personal API keys and OAuth credentials are high-entropy and normally stored only as hashes:** [apiKeyService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/apiKeys/apiKeyService.ts#L64-L68), [exportRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/exportRepository.ts#L6-L12).
- **TOTP secrets use authenticated AES-256-GCM with random 96-bit IVs:** [secretBox.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/crypto/secretBox.ts#L3-L28). The confirmed weakness is key lifecycle, not the primitive.
- **OAuth authorization uses exact registered redirect matching and mandatory PKCE for public clients:** [oauthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/oauth/oauthService.ts#L210-L242).
- **Authorization codes are atomically single-use, and access scopes are clamped to current client policy:** [oauthRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/oauthRepository.ts#L276-L284), [oauthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/oauth/oauthService.ts#L625-L647).
- **Google OAuth state is high-entropy, signed-cookie-bound, Redis-backed, and single-use:** [googleAuthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/googleAuthService.ts#L286-L299), [googleAuthService.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/auth/googleAuthService.ts#L603-L619).
- **Discord webhook input is restricted to HTTPS and exact Discord hosts/path, substantially reducing the obvious SSRF surface:** [settings.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/settings.ts#L325-L356).
- **Export download lookup is owner-, hash-, status-, and expiry-scoped:** [exportRepository.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/repositories/exportRepository.ts#L82-L99).
- **Import size/row caps and atomic import-apply claiming provide useful baseline controls:** [imports.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/imports.ts#L158-L162).
- **Repository access is generally owner-scoped and foreign IDs usually collapse to uniform 404s.** No clear conventional IDOR was found.
- **No production `eval`, child-process execution, obvious SQL string concatenation, or direct raw-query injection was found.** Drizzle's parameterized query builders are used consistently.
- **Error handling avoids returning internal exceptions and logging normally redacts credential fields:** [errorHandler.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/errorHandler.ts#L18-L44), [logger.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/logger.ts#L9-L26).
- **Sentry collection disables default PII and applies a recursive secret/email/token scrubber before transport:** [sentry.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/observability/sentry.ts#L60-L76), [scrubber.ts](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/observability/scrubber.ts#L36-L101).

## Investigated and downgraded concerns

- **Discord webhook SSRF:** Downgraded because contract validation requires HTTPS, exact Discord-owned hosts, and `/api/webhooks/`. The arbitrary outbound endpoint is Web Push, documented in M-06.
- **Cross-site WebSocket hijacking from an unrelated site:** Downgraded from High because `SameSite=Lax` normally withholds cookies cross-site. Same-site sibling origins and alternate ports remain in scope, hence M-07.
- **TOTP cryptography:** The encryption construction itself is sound. The defect is the rotation/fallback key derivation in H-06.
- **Bearer survival after account deletion:** Actual deletion cascades bearer rows. H-01 applies to account disable/suspension, not deletion.
- **Conventional SQL/command injection:** No actionable sink was identified.
- **Conventional owner-IDOR:** No clear unscoped repository path was identified. Realtime scope loss is a separate authorization-boundary failure.
- **Export content leakage:** The exporter deliberately excludes transient credential tables and protects download lookup. Browser token handling, storage topology, and file modes remain separately documented.

## Missing and recommended tests

### Authentication and credential lifecycle

- Disable a user and assert that an existing personal API key, OAuth access token, refresh token, authorization code, and connected socket all fail.
- Re-enable the user and verify that previously revoked credentials do not revive.
- Exercise remembered-device cleanup on password/PIN change, revoke-all, admin reset/disable, MFA reset, and account deletion.
- Test recent-auth expiry and replay for every security-setting mutation.
- Add latency-shape tests or explicit asynchronous behavior for reset-request enumeration resistance.

### Administrator assurance

- Create a user session, promote the account, and verify that the old session cannot enter admin routes.
- Create multiple password-only sessions before MFA enrollment; enroll through one and verify the others remain blocked.
- Verify that MFA reset/break-glass invalidates all current admin sessions.
- Verify Bull Board UI and every action endpoint reject an admin session without current-session MFA.
- Race two administrators disabling, demoting, and deleting one another and assert at least one active administrator remains.

### Realtime

- Build a negative scope matrix for every server event and client command using narrow personal and OAuth tokens.
- Revoke a key/grant/session after connect and assert immediate disconnect.
- Test access-token expiry and user disable after connect.
- Test direct WebSocket Origin rejection separately from polling CORS.
- Test per-account socket, event-rate, watched-asset, and global-loop caps.
- Assert all watches, presence claims, and provider loops are released after disconnect/error.

### Transaction and replay safety

- Submit the same password-reset token concurrently and assert one winner.
- Issue password-reset requests concurrently and assert one active token generation.
- Refresh the same OAuth token concurrently and assert the entire family, including any winner-issued pair, is revoked.
- Request exports concurrently and assert one job/enqueue.
- Exercise partial failure during multi-field admin updates and assert atomic rollback.

### Imports, exports, and outbound integrations

- Reject multipart requests exceeding field, part, header, and text-field limits.
- Reject imports exceeding distinct-instrument/provider-work budgets.
- Reject Web Push endpoints resolving to private, loopback, link-local, IPv6-local, or rebound addresses.
- Cap FCM/Web Push registrations per account and test fan-out bounds.
- Test Discord `@everyone`, `@here`, role, and user mention suppression.
- Run a two-container Compose export smoke test: request via API, build in worker, download via API, restart, and cleanup.
- Verify export directories/files have `0700`/`0600`-equivalent permissions.

### Privacy and deletion

- Verify deletion removes or anonymizes direct email, IP, username, target-ID, and Redis identifiers according to an explicit retention matrix.
- Verify export includes all applicable personal records or documents each justified exclusion.
- Test scheduled retention purges.

## Conclusion

BetterTrack's ordinary HTTP request path is substantially stronger than its auxiliary trust boundaries. The fastest security improvement comes from making one principle consistent everywhere: a principal is not merely a user ID. It is an active user plus a credential, current assurance level, scopes, expiry, and revocation state. Carrying that complete context into bearer exchange, administration, and realtime will close most of the High findings while preserving the solid controls already present.
