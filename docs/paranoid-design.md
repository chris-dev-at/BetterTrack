# PARANOID VAULTS — per-portfolio client-encrypted privacy (V5-P13 arc b, redefined 2026-08-19)

**Status:** ACKED & RULED 2026-08-20 — the five gate questions are answered
(§21) and the owner delegated all further paranoid decisions to the Chief;
implementation issues may be cut from §20. This note is the complete rewrite of the
paranoid design under the owner's **final, total redefinition of 2026-08-19**
(§2 below, verbatim — the binding text). It supersedes the account-level model
of the 2026-07-21 #651 note that previously lived at this path, the 2026-07-17
account-level clarification in §13.5, and — where anything differs — the
2026-08-12 per-portfolio spec on #665 (whose aligned parts it absorbs: per-vault
12-word seed phrases, one device password per endpoint, protection levels, QR
handoff, the UX charter). The one-implementation ruling recorded in §16 on
2026-08-19 (PR #1392) stands: this redesign REPLACES the account-level model
inside the single paranoid implementation — it is not a second variant, and the
torn-down per-portfolio "vaults v2" surface is not resurrected (its data is
quarantined as `zz_vault_v2_backup_*`; no port function). Implementation issues
are composed ONLY after the owner acks this note; deviations found during
implementation go back through PROJECTPLAN §16.

**Table of contents**

1. The model in one paragraph + glossary
2. The owner's 2026-08-19 ruling (verbatim, binding)
3. Vault model & server data model
4. Seed phrase → keys (BIP39, derivation, rotation)
5. Blob format + versioning (envelope v2, the per-vault doc set)
6. Sync, CAS and the merge protocol
7. Per-vault media switching, retirement, signed purge
8. Google Drive — separate authentication, multi-connection, collision-safe namespace
9. Portfolio move-in
10. Portfolio move-out (the designed exit)
11. The per-portfolio feature-kill matrix + the full-functionality proof
12. Device custody — password, plain storage, lockout
13. QR seed-phrase transfer
14. Client engine & cross-portfolio composition
15. Step-up re-auth on destructive operations (#1326 carry-over)
16. Recovery semantics — lost phrase = lost vault
17. Transition plan for live account-level paranoid accounts
18. Interplay: exports, deletion, admin, mirrorchain, autonomy seams
19. What changes and what dies in the live codebase
20. Build decomposition (epics, ordered)
21. Ruled — the five gate decisions (2026-08-20)
22. Constraints & non-goals

---

## 1. The model in one paragraph + glossary

An account owns **N paranoid vaults**. A vault is a **storage config** — where
its encrypted bytes live: the BetterTrack server, a **separately authenticated
Google Drive connection**, or both (a phone-local-only medium is explicitly
reserved for a future version, never silently promised). Each vault is
encrypted client-side and opens **only with its own 12-word seed phrase**, like
a crypto wallet: no escrow, no reset, no support path — lost phrase means that
vault's data is cryptographically gone, while every other vault and the rest of
the account are untouched. **Portfolios move INTO a vault**: the move-in
hard-deletes the portfolio's server cleartext and re-homes it into the vault's
encrypted document set, so only end devices holding the phrase can read it;
move-out (from an unlocked device) rehydrates it back. Server features die
**per vaulted portfolio only** — sharing, public-profile inclusion,
server-computed stats, server jobs, imports, portfolio-scoped API access to
that portfolio — while every non-vaulted portfolio of the same account keeps
FULL functionality, proven by a registry-driven matrix test. On a device, a
stored seed phrase is protected by a **device password** that is never cached
across sessions, or — behind a strong warning — stored plain ("encrypted and
unreadable for BetterTrack" is then the whole promise). A QR flow hands the
phrase to the phone. The client does all money math for vaulted portfolios with
the **same audited domain code the server uses** (`packages/domain` — never
reimplemented), reading through the `PortfolioStore` seam, so day to day a
vaulted portfolio looks like a normal one on an unlocked device.

Glossary: _vault_ = one storage config + one seed phrase + the encrypted
document set of its member portfolios; _doc_ = one encrypted blob of a vault's
doc set (header / common / one per portfolio); _medium_ = a place docs sync to
(server / a Drive connection); _Drive connection_ = one separately-OAuth'd
Google account usable as a medium, N per BetterTrack account; _move-in /
move-out_ = a portfolio entering/leaving a vault; _endpoint_ = one installed
client (a browser profile, the phone app); _endpoint keystore_ = the
device-local store of seed phrases; _device password_ = the per-endpoint
password wrapping stored phrases; _K_c_ = a vault's random 256-bit content key;
_locked stub_ = the content-free server row a vaulted portfolio keeps.

## 2. The owner's 2026-08-19 ruling (verbatim, binding)

> "there are paranoid vaults on your account. these are just configs on how to
> save something. so a vault has the config to save stuff on better track or on
> google drive or on both or on other storage media. and the vault is encrypted
> on that media and only accessable via a 12 word seed phrase like a crypto
> wallet. then the portfolios you have can be moved into a vault thereby
> deleting them as a public portfolio and moving them into the vault so only
> end devices with the 12 word seed phrase can read it. then also for phone
> there is the option to only store the portfolio on the phone and no google
> drive or bettertrack (but leave that out for now this will come in future
> versions) and to secure on the devices there will be a password which will
> encrypt your 12 word seed phrase locally so if your end device gets
> compromised you still have some security. and the password never gets cached
> across sessions. and then there is also the risky option of just storing the
> 12 word seedphrase plain on the end device which you will be warned is way
> less secure but also possible if you just want it to be encrypted and
> unreadable for bettertrack. the features (for example share and all other
> features the server is needed for) are only deactivated for the portfolio
> inside of the vault, and full functionality will still be there for all other
> portfolios. thats how the paranoid mode should work and no other way. thats
> exactly how i want it and any other (if described otherwise in any other
> document) gets rewritten. and also to quickly share the 12 word seedphrase to
> your phone there is the option of a QR code scan that instantly transmits the
> 12 word seedphrase. and also i am not sure if the google drive stuff works.
> can you make it so google drive has to be authenticated seperately? so you
> could hypothetically have your account be bound to GMAIL X but connect
> GoogleDrive from accoutn Y and use accoutn Y and maybe connect Google Account
> Z and move another vault into Google Account Z? and maybe 2 users will use
> the same google drive to backup there so make sure there is no collisions
> there."

Every section below is this text made implementable. Where the live codebase
or any earlier document disagrees, the document is wrong and §19 names what
gets rewritten.

## 3. Vault model & server data model

**A vault is account config, so its config rows live on the server** — the
ruling's own words ("paranoid vaults on your account… just configs on how to
save something"). Knowing THAT a vault exists, where it stores, and WHICH
portfolios are inside is required to enforce §11 and to render locked stubs; it
is not portfolio content. What the server can never do is read a doc.

New tables (fresh append-only migrations; the quarantined v2 names `vaults`/
`vault_docs` are free again after the #1392 backup ceremony destroys the
`zz_vault_v2_backup_*` set, but nothing here depends on that ceremony):

- **`vaults`** — `id` (uuidv7), `user_id` (FK, cascade), `name` (user-visible
  label, cleartext by design — it is config, and the UI needs it while locked),
  `media` (text[] ⊆ {`server`,`drive`}, non-empty — the `local` value is
  RESERVED in the contract enum but rejected by the server until the future
  version ships), `drive_connection_id` (nullable FK → `drive_connections`,
  required iff `drive ∈ media`, enforced by a CHECK),
  `retirement_proof_public_key` (the per-vault Ed25519 purge verifier, §7 —
  same semantics as today's `paranoid_vaults.retirement_proof_public_key`),
  `key_fingerprint` (a non-secret HKDF-derived verification tag of K_c, §4 —
  lets a client confirm "these words open THIS vault" before destructive
  steps), `created_at`, `updated_at`.
- **`vault_blobs`** — `(vault_id, doc_id)` PK, `doc_kind`
  (`header`|`common`|`portfolio`), `portfolio_id` (nullable, set iff
  `portfolio`), `version` (monotonic CAS token per doc), `format_version`,
  `size_bytes`, `blob` (bytea, never interpreted past the envelope header).
  Size caps per kind (header 1 MiB, common 4 MiB, portfolio 8 MiB — env-tunable
  like today's `BT_VAULT_MAX_BYTES`).
- **`vault_blob_history`**, **`vault_server_candidates`**,
  **`vault_retirements`**, **`vault_retired`** — today's account-singleton
  machinery (`paranoid_vault_history`, `paranoid_vault_server_candidates`,
  `paranoid_vault_retirements`, `paranoid_vault_retired`,
  `apps/api/src/data/schema.ts:3711–3830`) re-keyed to `(vault_id, doc_id)`.
  Bounded history (last 10 versions / 30 days, env-tunable) stays the
  bad-write safety net; the retirement set + signed purge gate (§7) carry over
  per vault.
- **`drive_connections`** — §8.
- **`portfolios.vault_id`** (nullable FK → `vaults`) + **`portfolios.vault_alias`**
  (the locked-row display label; the true name travels inside the ciphertext).
  `vault_id IS NULL` ⇒ normal portfolio, today's behavior byte-for-byte;
  `vault_id IS NOT NULL` ⇒ the locked stub: zero content rows (probed), only
  identity + alias + vault membership. PR #1392 dropped the v2 columns of the
  same intent; these are re-introduced fresh, with the stub row's purpose being
  (a) enforcement keying, (b) same-UUID move-out, (c) rendering "N locked
  portfolios" and the unlock affordance.

**Routes** (all under the existing `/api/v1` surface; exact naming
composer-refined, shapes binding):

- `GET/POST /vaults`, `PATCH/DELETE /vaults/:vaultId` — config CRUD. DELETE
  refuses while any portfolio references the vault.
- `GET/PUT /vaults/:vaultId/docs/:docId` — the blind blob store with ETag /
  `If-Match` CAS, exactly today's `GET/PUT /vault` contract per doc
  (`apps/api/src/http/routes/vaultRoutes.ts:464–520`).
- `GET /vaults/:vaultId/docs/:docId/history[/:version]` — restore picker reads.
- `PATCH /vaults/:vaultId/media`, server-candidate staging, retirement
  challenge/purge — §7, re-keyed from today's `/vault/media*` family.
- `POST /portfolios/:id/vault/move-in`, `POST /portfolios/:id/vault/move-out` —
  §9/§10, step-up-gated (§15).
- `GET /portfolios/:id/vault/revision` — the per-portfolio capture token (§9).

**What is deliberately NOT a server fact:** seed phrases, the endpoint
keystore, the device password, unlock state, and which endpoints hold which
phrases. There is no server table for endpoint custody, ever.

`users.privacy_mode` and the account-level media columns
(`paranoid_media_set`, `paranoid_drive_attested_version`,
`users_paranoid_media_state` CHECK — `schema.ts:205–253`) retire at the end of
the §17 transition; until then they keep serving the live accounts.

## 4. Seed phrase → keys (BIP39, derivation, rotation)

**BIP39 is adopted as the standard.** 12 words from the English wordlist =
128-bit entropy + 4-bit checksum. It is boring, ubiquitous, checksum-validated
at entry (typo detection), has excellent test vectors, and matches the owner's
"like a crypto wallet" framing exactly. Words are generated client-side from
CSPRNG entropy at vault creation and NEVER leave the device except via the §13
QR flow or the user's own pen.

**Derivation chain (binding — boring, standard primitives only):**

```
mnemonic (12 words)
  → BIP39 seed          PBKDF2-HMAC-SHA512(mnemonic, "mnemonic", 2048) — the standard, empty passphrase
  → K_wrap              HKDF-SHA256(seed, info = "bettertrack-vault-wrap-v1:" + vaultId)
  → K_c                 unwrap keySlots[0] (AES-256-GCM wrap of the random content key)
  → docs                AES-256-GCM per doc, full serialized header as AAD
key_fingerprint = base64url(HKDF-SHA256(K_c, info = "bettertrack-vault-fingerprint-v1"))[0..16]
```

**Binding `seed-v1` key-slot wire contract for E7 phone unwrap:** wrap the
random 32-byte `K_c` with AES-256-GCM under `K_wrap`, using a fresh 12-byte IV
and UTF-8 AAD exactly `bettertrack-vault-key-slot-v1:${vaultId}:${keyId}`.
`wrappedKc` is unpadded base64url of
`IV || ciphertext || 16-byte GCM tag` (WebCrypto's ciphertext result already
contains the appended tag); E7 MUST consume this layout byte-for-byte and fail
closed on malformed length or authentication.

Notes, each deliberate:

- No Argon2id on the mnemonic: KDF stretching defends low-entropy human
  secrets; a 128-bit random mnemonic needs none, and the standard BIP39 PBKDF2
  step keeps us vector-compatible with every BIP39 tool. Argon2id remains
  exactly where a human secret exists — the §12 device password (the server's
  own cost family: m = 64 MiB, t = 3, p = 1, WASM as today).
- HKDF already exists in the client (`apps/web/src/user/vault/hkdf.ts`);
  AES-256-GCM via WebCrypto as today (`apps/web/src/user/vault/crypto.ts`). No
  new primitives anywhere.
- **`keySlots[]` indirection stays** (v1's `wrappedKeys` pattern,
  header-carried): the content key K_c is random, wrapped by K_wrap. That is
  what makes §4-rotation and any far-future sharing possible without
  re-issuing words.
- The seed phrase is per vault. Two vaults never share key material; the
  `vaultId` in the HKDF info string domain-separates even a re-used mnemonic
  (which the UI never offers).
- **Rotation:** post-compromise, the client can re-encrypt a vault under fresh
  words (new mnemonic → new K_wrap → new K_c → full doc-set re-encrypt +
  verified round trips + history invalidation) — offered in vault settings,
  never forced. There is no "change phrase but keep K_c" path: if the words
  leaked, K_c must go too.
- The v1 recovery kit (raw-VK download) is RETIRED. The ruling makes the
  phrase the sole credential ("only accessable via a 12 word seed phrase");
  the write-it-down ceremony (§9 of the UX epic) replaces the kit. One
  credential, one mental model.

## 5. Blob format + versioning (envelope v2, the per-vault doc set)

**One envelope format for every medium**, evolved from the shipped `BTVAULT1`
(`packages/contracts/src/vault.ts`, `apps/web/src/user/vault/envelope.ts`) —
what it got right is kept verbatim: magic + 4-byte header length + cleartext
JSON header + ciphertext; the **full serialized header bound as AES-GCM AAD**
so any header tamper (version rollback included) fails decryption; deflate
compression before encryption; strict fail-closed versioning.

**Envelope v2 header** (cleartext; counters, ids and crypto parameters only —
never portfolio information):

```
{ formatVersion: 2, cipher: 'A256GCM', iv, keyId,
  keySlots: [{ keyId, slot: 'seed-v1', wrappedKc }],
  vaultId, docId, docKind: 'header' | 'common' | 'portfolio',
  accountBinding: <base64url sha256("bettertrack-vault-owner-v1:" + accountId)>,
  docVersion: <int, monotonic — the per-doc CAS token>,
  schemaVersion, deviceId, writeId, writtenAt }
```

`vaultId` + `docId` + `accountBinding` in the AAD are the anti-swap guarantee
§8 relies on: a doc copied between vaults, accounts or Drive folders fails
decryption even before any namespace check.

**The doc set of a vault:**

- **`header` doc** — vault metadata under encryption: true vault name, member
  portfolio roster (ids + display names), keySlots echo, creation record.
  Small, rewritten rarely.
- **`common` doc** — account-scoped material the vault's portfolios reference:
  the custom-asset bucket (the client's local asset table — same
  snapshot/tombstone/strict-restore-narrowing semantics as v1 §1, including
  the `asset_identities` claim seam), severed-fork mirrorchain provenance for
  member portfolios (v1 §7.1 discipline, unchanged), the retirement-proof
  Ed25519 private key, mergeLog.
- **`portfolio` doc, one per member portfolio** — every `vault`-classified row
  of that portfolio: transactions, dividends, cash sources + movements,
  per-portfolio settings, tax settlement rows, standing-order definitions +
  the `standing_order_runs` ledger (the exactly-once record — v1 §7's "what
  step 2 must read" carries over per portfolio), import batches/rows,
  expense rows scoped to it. Snapshots stay derived-and-purged, never carried.

Per-doc granularity is what makes move-in/move-out incremental (one portfolio
doc appears/disappears; the header roster and common doc fold), keeps size caps
honest, and lets two devices editing two different portfolios not conflict at
all.

**Payload document rules carried verbatim from v1 §2/§4:** uuidv7 entity ids,
per-entity monotonic `rev` + `editedAt` + writing `deviceId`, tombstones kept
≥ 180 days, pure `v(n)→v(n+1)` schema migrations on load, NEWER-version docs go
read-only with an "update the app" notice — never best-effort parsed. The
per-table completeness discipline stays: every Drizzle table classifies into
`vault` | `server` | `purge` (`PARANOID_TABLE_CLASSIFICATION`,
`apps/api/src/services/export/manifest.ts:413`), CI fails on an unclassified
table, and the classification now additionally names the **doc bucket**
(portfolio-scoped → portfolio doc; account-scoped-but-vault-referenced →
common doc). `PARANOID_PURGED_TABLE_NAMES` (`manifest.ts:674`) and the
`purge`-reason roster (`PARANOID_PURGE_REASONS`, pinned membership in
`paranoidClassification.test.ts`) survive re-keyed to the portfolio scope —
`usage_events` capture suppression now keys on "does the request target a
vaulted portfolio / does the account own any vault" for asset-quote reads by
the client engine (the #1344 holdings-roster leak must not reopen per
portfolio).

## 6. Sync, CAS and the merge protocol

v1 §4 is the storage protocol and carries over **per doc**:

- **Server medium:** ETag/`If-Match` CAS per `(vaultId, docId)`, atomic under
  the vault row's lock, 412 on mismatch, bounded history, dedicated
  `limiters.vault` rate family, server reads nothing past the envelope header.
- **Drive medium:** per-doc file (§8 naming), `appProperties` carry
  `{docVersion, formatVersion, ownerDigest, vaultDigest, docKind}`; CAS
  approximated via appProperties + `headRevisionId` with the accepted TOCTOU
  window (writers are one user's own devices; the merge repairs races). Drive
  native revisions are that medium's history net.
- **Local cache:** per-endpoint encrypted cache of last-known docs
  (IndexedDB/OPFS) — a cache, not a medium; the future phone-local-only medium
  arrives through the `DataHome` seam (§18), not by promoting this cache.
- **Write path:** local commit → encrypt affected docs (docVersion + 1) → CAS
  to primary (server when present, else Drive) → replicate identical bytes to
  the secondary.
- **Conflict rule (binding, unchanged):** entity granularity, never field
  granularity; higher `rev` wins → later `editedAt` → lexicographically higher
  `deviceId`; tombstone vs concurrent edit → the edit wins; merged docVersion =
  max(parents) + 1; commutative + idempotent; corrupt candidates kept for the
  restore picker, never silently discarded. Fork provenance merges by
  content-addressed union with the v1 §7.1 prune-in-three-places lifecycle.
- **`vault:sync` bearer exception** (v1 §4.1, owner mandate 2026-08-04)
  carries over re-keyed: opaque per-doc GET/PUT + media/history reads for the
  native client; destructive and recovery-media transitions stay off the plain
  bearer path except as §15 explicitly gates them; the retirement-proof header
  stays ignored-on-bearer so a token can never pin a verifier.

## 7. Per-vault media switching, retirement, signed purge

v1 §5 verbatim, re-keyed per vault — this machinery shipped, survived a COD
reconciliation (#895/#896) and is kept because it is right:

1. **Add a medium:** write the full doc set there → verified round trip (read
   back, decrypt, compare writeId/hash per doc) → `PATCH /vaults/:id/media`
   records the set. Adding `server` goes through staged server candidates
   (today's `PUT /vault/media/server-candidate` flow, per vault).
2. **Remove a medium:** only while another medium holds a verified-fresh copy.
   Removing `server` atomically moves the vault's blobs + history into the
   retired recovery set (`vault_retired`), destroyable only through the signed
   purge gate: minimum 7-day retention, fresh other-medium readback, server
   challenge, **Ed25519 proof with the private key held inside the encrypted
   common doc** — possession of the vault's key, not of a session. Removing
   `drive` best-effort deletes the Drive files and says so when it could not
   (the leftover is the user's own ciphertext in their own Drive).
3. The last medium can never be removed.

Changing a vault's **Drive connection** (Y → Z) is a media migration with the
same discipline, and it starts one step earlier than a byte copy (E5): the
header doc's §8 `driveConnection` identity echo is first rewritten to Z through
the NORMAL replicated write path — every active medium, server included — and
only then is the (now Z-naming) doc set written to Z's namespace, verified,
the binding PATCHed, and Y best-effort deleted. A byte-only copy would leave
the encrypted header naming Y, so words + the right Google login would no
longer discover the vault after the move; and for a replicated vault the
server's per-doc attestation rows would disagree with the new Drive bytes,
which is exactly what `PATCH /vaults/:vaultId/media` verifies. Source and
target connection must differ — a same-connection "move" resolves both homes to
one object, so the copy is skipped as already-equal and the cleanup would then
delete the only copy while reporting success.

## 8. Google Drive — separate authentication, multi-connection, collision-safe namespace

**Drive is authenticated separately from the login identity, by construction.**
A **Drive connection** is its own end-user OAuth consent to whichever Google
account the user picks in Google's own chooser — completely decoupled from how
they log in to BetterTrack (password, or Google login as GMAIL X). Login with
X, back up to Drive Y, put another vault on Drive Z: supported natively.

**Ground truth first, because the owner asked "does the Drive stuff work":**
the shipped transport (`apps/web/src/user/vault/drive/gisTokenClient.ts`,
`driveDataHome.ts`) is real, tested, browser-only code requesting exactly one
Drive scope (`DRIVE_FILE_SCOPE`, `gisTokenClient.ts:2`) — up to E5 that scope
was `https://www.googleapis.com/auth/drive.appdata`; E5 moved it to
`https://www.googleapis.com/auth/drive.file` per the §21 Q5 ruling recorded
below, and no other scope is ever requested — but it has NEVER run on production: prod's web
runtime config serves `googleDriveClientId: ""` because
`BT_GOOGLE_DRIVE_CLIENT_ID` was never set on the host (docs/ops.md, "Browser
Google Drive runtime configuration"). So no live user has ever written a Drive
byte; what v2 CLAIMED was a Drive path never existed at all (PR #1392). The
redesign builds on the real transport and is free to change its storage plane
with zero user migration.

- **Connection identity — where it lives and how it persists.** GIS mints
  ephemeral access tokens with no durable notion of "connection Y vs Z", so
  the client captures the identity at connect time: after the first consent it
  calls Drive `about.get(fields=user)` with the fresh token and records the
  Google account's stable subject id + email. The authoritative registry is
  the server-side **`drive_connections`** table — `id`, `user_id`,
  `google_sub` (UNIQUE per user), `email`, `display_name`, `created_at`,
  `last_verified_at`; **no tokens, no refresh tokens, no file ids — ever.**
  It is account CONFIG under the ruling's own definition (§3): it lets the UI
  list connections, lets a vault bind to one (`vaults.drive_connection_id`),
  and tells a fresh signed-in device WHICH Google account to ask for. For the
  autonomy principle the same identity is ALSO echoed inside the encrypted
  vault header doc, and a device with only the words + the right Google login
  can discover its docs by query (below) — the server registry is convenience
  and config, never a decryption or discovery prerequisite. Two different
  BetterTrack users may hold connections to the same `google_sub` — the
  shared-physical-Drive case, allowed.
- **Token model — client-side only, unchanged in kind from v1 §6:** GIS token
  client, SPA client id from env, tokens minted in the browser **per
  connection** with `login_hint` = the connection's **email**, ~1 h
  lifetime, memory-only, never sent to or stored by the server, no server
  proxy endpoints. (E5 correction: GIS documents `hint`/`login_hint` as an
  email address or an ID-token `sub`. What the registry stores as `google_sub`
  is Drive's `about.get` `user.permissionId` — an opaque Permission-resource
  id that Google does not document as a hint value, so it is kept for the
  post-consent principal check and the email is the hint.) Consequence (the binding Drive-only guarantee, carried
  over): for a Drive-only vault the server holds zero cleartext, zero active
  ciphertext, and zero CAPABILITY to fetch the Drive copy. Refresh = GIS
  re-mint (silent while the Google session lives, a user gesture otherwise).
  **Every re-mint repeats `about.get` and compares its `permissionId` with the
  connection's stored `google_sub`; a chooser switch fails closed as the
  distinct `identity-mismatch` state before the new token can reach storage.**
  The sync indicator (§14) surfaces "sign in to Google (Y) to sync" — never a
  silent stall.
- **Scope RULED (2026-08-20, §21 Q5) — move from `drive.appdata` to
  `drive.file` with a visible "BetterTrack Vaults" folder.** The hidden `appDataFolder` is
  namespaced per (Google account × OAuth client), NOT per BetterTrack user —
  today two BetterTrack users backing up to the same Google account, or one
  user with several vaults, share one invisible namespace. That is workable
  (the naming scheme below isolates them regardless of scope), but `appdata`
  fails the owner's mental model twice: the user can never SEE that the backup
  exists ("i am not sure if the google drive stuff works" — a visible file is
  the proof), and the bytes are reachable only through our OAuth client,
  which fights the autonomy principle. Under **`drive.file`** the app touches
  ONLY files it created (still least-privilege — it can never read the user's
  other Drive content), the vault docs sit in a visible folder the user can
  eyeball and even hand-download (ciphertext + their words = a recovery path
  needing nothing from us), and rename/move by the user is harmless because
  lookups go by cached fileId + `appProperties` query, never by name. Risks
  named honestly: the user can delete the visible files (their own backup,
  their own act — the sync indicator flags "Drive copy missing", Drive trash
  holds 30 days) and co-users of a shared Google account see the folder
  (they share the whole Drive anyway; names carry no PII, below). Since
  production never had a working Drive path, the scope switch costs zero
  migration — the one moment this is free. Owner call recorded in §21.
- **Revocation:** the user can revoke at Google's security settings at any
  time (the app detects `invalid_grant`-class failures and flags the
  connection); in-app **disconnect** refuses while any vault is bound to the
  connection unless the vault first migrates off it (§7) — or, behind an
  explicit acknowledgment, the user accepts that the app loses reach to that
  copy (the files remain their property in their Drive). **A Drive-ONLY vault
  is the one case the acknowledgment cannot cover** (E5, PROJECTPLAN §16
  2026-08-21): dropping its last medium would leave the empty media set the
  `vaults_media_state` CHECK rejects, and the only copy of every doc behind a
  binding that no longer exists — the refusal (`DRIVE_CONNECTION_LAST_MEDIUM`)
  is decided before the acknowledgment is read, so the owner is never offered
  a loss of reach that was never on the table. Add and attest the server
  medium first, then disconnect.
- **Collision-safe namespace (two users, one physical Drive):** whatever the
  scope, both users' files can share one container (appdata: one hidden
  folder per Google account × client; drive.file: one visible folder), so the
  naming + ownership discipline is the isolation, never the folder:

  ```
  name = "bettertrack-vault-" + base64url(sha256(
           "bettertrack-drive-vault-v2:" + accountId + ":" + vaultId + ":" + docId
         )) + ".btenc"
  appProperties = { ownerDigest: sha256("bettertrack-drive-owner-v1:" + accountId),
                    vaultDigest, docKind, docVersion, formatVersion }
  ```

  - **Cannot clobber:** names are digests over (account, vault, doc) — two
    users' names never collide; a client lists/queries by its own
    `ownerDigest` `appProperties` filter (rename/move-proof) and NEVER writes
    a file whose `ownerDigest` is not its own (checked before every update);
    concurrent creates dedupe by re-querying before first write.
  - **The visible folder is reconciled, not assumed unique (E5):** lookup-
    then-create is not atomic on Drive, so two devices — or two per-document
    homes starting together — can both create one. Every creator re-lists
    afterwards, adopts the same deterministic winner (lowest folder id) and
    discards the folder it created if it lost and is still empty. Objects are
    always found by `appProperties`, never by parent, so even a stray folder
    never hides a doc.
  - **Cannot read each other:** contents are AEAD ciphertext under different
    K_c; and even a maliciously renamed/copied file fails decryption because
    `accountBinding`/`vaultId`/`docId` sit in the AAD (§5). Names and
    appProperties are digests — no emails, no vault names, no portfolio hints
    in anything a co-user of the Drive could see.
  - **Bounded paged lookup (E5 follow-up):** `docId` remains out of
    `appProperties`, so all documents with the same (`ownerDigest`,
    `vaultDigest`, `docKind`) share one list address. The chosen resolution is
    pagination, not a new `docDigest` object-format field: the client reads
    100 objects per Drive page and supports at most **1,000 candidate objects
    per address** (therefore up to 1,000 portfolio documents for the usual
    portfolio address). It reads every page before declaring a document
    absent; a repeated page token or an address above the supported ceiling
    fails closed. This removes the former 100-object cliff while bounding the
    request/download work a shared Drive can impose.
  - **Residual shared-Drive denial of service (accepted, manual remedy):** a
    co-tenant of the same physical Drive can create an app-owned file carrying
    another user's `ownerDigest`/`vaultDigest`/`docKind` and a copied plaintext
    header with a higher `docVersion`. AEAD still prevents the co-tenant from
    reading or clobbering the real document, so the confidentiality/integrity
    property above holds, but the forged higher-version candidate can wedge
    that address. This design **does not claim DoS resistance against a
    co-tenant of the same Drive**. The manual remedy is to remove the forged
    candidate from the visible **BetterTrack Vaults** folder (or Drive trash)
    and retry sync.
  - This extends the shipped derivation
    (`driveDataHome.ts#driveVaultFileName`,
    `sha256("bettertrack-drive-vault-account-v1:" + accountId)`) from
    account-singleton to per-doc; the platform-blessed mobile contract
    (§16 row 2026-08-04, PLATFORM_ASKS reply #41) gets a v2 addendum on the
    board when the epic lands.

## 9. Portfolio move-in

Move-in = capture → encrypt → verify → destructive commit, generalizing the
shipped enable pipeline (`paranoidTransitionService`,
`apps/api/src/http/routes/accountRoutes.ts:141–226`) from account scope to
portfolio scope. The v1 capture discipline carries over because every piece of
it exists for a reason that is still true:

1. **Preconditions** (server-checked, clear errors): the target vault exists,
   its media are verified-live, the portfolio has no active mirrorchain
   membership (leave-with-fork first; `docs/mirrorchain-design.md` §14 keeps
   the other side), no in-flight import batch or export job touches it.
2. **Capture with a portfolio-scoped CAS token:**
   `GET /portfolios/:id/vault/revision` — an opaque content digest over
   exactly the portfolio's restorable `vault`-classified rows (the
   `computeNormalDataRevision` machinery re-scoped; `purge`-only tables
   excluded for the same spurious-conflict reason recorded in
   `manifest.ts:679–687`). The client reads the token FIRST, pulls the
   portfolio's dataset through the existing read APIs, re-reads the token, and
   accepts only when the pair agrees — the v1 "capture validates before it
   accepts" rule, because capture reads still write (tax self-heal, seeded
   defaults). One rebuild on mismatch; fail with its own error if it moves
   again.
3. **Encrypt + verify:** the portfolio doc is written to every vault medium,
   the common doc folds in the portfolio's custom-asset snapshots and fork
   provenance, the header roster gains the portfolio — each write CAS'd and
   round-trip verified (§7 rule 1).
4. **Destructive commit:** `POST /portfolios/:id/vault/move-in` with body
   `{ vaultId, docVersion, portfolioDataRevision, stepUp }` (§15). One
   account-locked transaction: re-verify preconditions + the revision token →
   hard-delete every `vault`-classified row keyed to the portfolio
   (`PARANOID_PURGED_TABLE_NAMES` re-keyed; mechanically the V4-P2c sweep
   pattern) → destroy its `purge`-classified rows → revoke every share /
   audience entry / public-profile inclusion OF THAT PORTFOLIO → set
   `vault_id` + `vault_alias` on the stub → zero-cleartext probe over the
   classified set. Idempotent retry per the v1 "never destroys gated state"
   rule.

**What happens to each attached thing, explicitly:**

| Thing                                                                   | On move-in                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transactions, dividends, cash sources + movements, history              | Into the portfolio doc; server rows hard-deleted; client engine re-derives all series                                                               |
| Snapshots / derived rows                                                | Purged, never carried (re-derived on move-out)                                                                                                      |
| Tax settlement rows for the portfolio                                   | Into the doc; cross-portfolio tax composes per §14                                                                                                  |
| Standing orders + run ledger                                            | Into the doc; client materializes due rows with deterministic UUIDv5 occurrence ids (v1 §8 item 9)                                                  |
| Existing shares / audiences / public-profile inclusion of the portfolio | Revoked permanently; NOT restored on move-out (the v1 #730/#992 rule, now portfolio-scoped)                                                         |
| Price alerts                                                            | Untouched — asset-level rows, zero portfolio reference (v1 §9); nothing to kill                                                                     |
| Conglomerates / workboard                                               | Untouched — hypothetical baskets reference `asset_identities`, not portfolios; custom-asset identity claims survive via the v1 tombstone/claim seam |
| Home board widgets scoped to it                                         | Render through the `PortfolioStore` seam: live when the vault is unlocked, a locked-state tile with the unlock affordance otherwise                 |
| Imports in flight                                                       | Precondition-blocked; historical import batches ride the doc                                                                                        |

## 10. Portfolio move-out (the designed exit)

"Deleting them as a public portfolio" makes move-in reversible **only via a
device holding the phrase** — so the exit is designed exactly there. From an
unlocked endpoint: `POST /portfolios/:id/vault/move-out` streams the strict
restore document for that portfolio (the `toStrictRestoreDocument` /
`strictVaultDocumentForDisable` discipline per portfolio: catalog-asset
snapshots dropped and re-resolved, own-manual-asset restatement, retained
identities accounted for, fork-provenance validation per v1 §7.1, solvency
validation per the #865 option-B rule), plus the §15 step-up. One
account-locked transaction: rows re-created through the normal services in
dependency order **under the SAME portfolio UUID** (the stub row is the
identity anchor), `vault_id`/`vault_alias` cleared, the portfolio doc removed
from the server medium (into bounded history, ordinary retention), the header
roster updated; after commit the deterministic plan rebuilds snapshots and
invalidates derived consumers. The client then tombstones the portfolio doc in
the vault, syncs, and best-effort deletes the doc's Drive file. Payload ceiling
per the v1 factor rule (`PARANOID_RESTORE_PLAINTEXT_FACTOR`). Idempotent-
resumable exactly like today's disable. Shares are not restored; the vault
itself keeps existing (possibly empty).

Move-out is also the account's escape hatch: unlike v1's all-or-nothing
disable, a user can exit one portfolio while others stay vaulted.

## 11. The per-portfolio feature-kill matrix + the full-functionality proof

**The account keeps everything.** Profile, friends, chat, comments/reactions,
watchlists, conglomerates + backtests, alerts, notifications, API keys/OAuth
grants, imports, mirrorchain, expense tracking, the Home board — and the FULL
feature set of every non-vaulted portfolio, including sharing them and reading
them over bearer scopes. The account-wide kill rail dies: the `PARANOID_MODE`
account guard, the bearer scope kill in
`apps/api/src/http/middleware/bearerAuth.ts:758`, `MeResponse.privacyMode` as a
mode signal (#1052/#1055 — replaced by `vaultId` on portfolio rows + a narrow
`GET /vaults` projection), and the account-keyed halves of the enforcement
registry (`apps/api/src/services/account/paranoidEnforcement.ts`). This
permanently fixes the class of bug where owning any vault killed cash-on-mobile
for the whole account.

**Killed for a VAULTED portfolio** (each enforced server-side at the portfolio
boundary with one stable error code, e.g. `VAULTED_PORTFOLIO`; hidden
client-side as absent affordances on that portfolio; every row covered by the
registry-driven matrix test):

1. Sharing/public: cannot be shared, added to any audience, or included in the
   public profile; existing grants revoked at move-in (§9).
2. Every server-computed portfolio read: summary/series/snapshots, analytics,
   Live-Mode frames, projected dividend income, portfolio news digest,
   real-portfolio backtest, AI insights over it, the server tax engine for it.
   The client engine owns all of it (§14).
3. Server jobs: snapshot jobs, dividend/earnings scans keyed to its holdings,
   standing-order server execution — skip it (its input tables are empty; the
   probe keeps that true).
4. Imports targeting it server-side.
5. Portfolio-scoped API access to it: a bearer or session request addressing
   the vaulted portfolio gets the portfolio-scoped refusal; **the scope itself
   stays valid account-wide.** `vault:sync` remains the deliberate ciphertext
   path.
6. Mirrorchain: cannot create/join/be invited while vaulted; mutual exclusion
   is now portfolio-scoped.
7. Webhooks: no portfolio-content events for it (there is nothing server-side
   to fire).

**Proof strategy (the acceptance backbone):**

- **Registry re-key:** the shipped enforcement inventory + completeness
  harness (`paranoidEnforcement.ts`,
  `paranoidEnforcementCompleteness.test.ts` — every mounted route, callable
  context method and registered job must carry exactly one policy) survives
  re-keyed portfolio-first. The kill matrix is derived from the registry, not
  hand-listed twice.
- **Zero-cleartext probe per portfolio:** after move-in, iterate
  `PARANOID_PURGED_TABLE_NAMES` and prove zero rows keyed to the portfolio.
- **Full-functionality regression, the headline test:** an account owning a
  vaulted portfolio exercises the COMPLETE feature surface against a plain
  portfolio — sharing it, server stats, bearer `cash:write`, imports, a
  mirrorchain membership, expense pages — byte-identical to a vault-free
  account (matrix + e2e). Plus: `usage_events` capture suppressed only for
  vaulted-portfolio-driven reads.
- **Discreet mode is untouched** — it composes (hides amounts the client just
  computed) and is not part of this arc's diff.

## 12. Device custody — password, plain storage, lockout

**The endpoint keystore** (IndexedDB / platform storage; no server table):
per stored phrase an entry `{ vaultId, custody: 'wrapped' | 'plain', payload }`.

- **Wrapped (default):** ONE device password per endpoint (the 2026-08-12
  spec's correction survives: never per-vault passwords). Argon2id(password,
  per-endpoint salt; m = 64 MiB, t = 3, p = 1) → K_dev; each stored mnemonic
  entropy is AES-256-GCM-wrapped under K_dev; a wrap-check value verifies
  entry. Entering it once per session unlocks ALL wrapped phrases on that
  endpoint.
- **"Never cached across sessions" — the precise meaning (binding):** the
  password and K_dev exist only in volatile process memory. They are never
  written to IndexedDB, localStorage, sessionStorage, cookies, service-worker
  caches, or any log. A **session** ends at: tab/app close (memory dies with
  the process), an explicit "Lock vaults" action, or the existing PIN
  idle-lock timer when the user has PIN lock on (one timer, one mental model —
  no second setting). After any of these, the next vault read prompts again.
  There is NO "keep unlocked on this device" checkbox for wrapped custody —
  v1's persisted-VK convenience (`custody.ts` keep-unlocked) is deliberately
  retired; the convenience path is plain custody, below. Unlocked K_c keys are
  likewise memory-only and die with the session.
- **Plain (the warned option):** the mnemonic entropy sits unwrapped in the
  keystore; the vault opens without any prompt. Choosing it requires the
  friction ladder's strong rung — an explicit acknowledgment that a
  compromised end device exposes the phrase outright, and that the protection
  is then ONLY "encrypted and unreadable for BetterTrack". Default is always
  wrapped; the toggle is per stored phrase, changeable both ways (re-wrap
  prompts for the password). On platforms with native custody (Android
  Keystore / iOS keychain) "plain" still means "not protected by the device
  password" — the platform baseline applies underneath.
- **Wrong password / lockout UX:** verification is local (wrap-check). Failures
  escalate a client-side delay (5 wrong → 30 s, doubling, capped at 5 min) —
  there is no server lockout because the server is not involved. The prompt
  always offers "Forgot the password?" → **keystore reset**: wipes the stored
  phrases on THIS endpoint only, loses NO data (the phrases re-enter by typing
  or §13 QR from another device), and says exactly that in one sentence.
- Vault states on an endpoint and their affordances (binding — a state without
  a next action is a design bug; the recorded v2 anti-pattern was a locked
  vault with no unlock path): stored+wrapped → "Unlock" (password);
  stored+plain → opens silently; not-on-this-endpoint → "Enter words / Scan QR
  from another device". Every surface that renders a vault or locked stub
  carries its state's action inline.

## 13. QR seed-phrase transfer

The owner wants a scan that instantly moves the phrase to the phone — designed
safely, not refused:

**Sender (the device holding the phrase):** Vault settings → "Show transfer
QR". Requires a live unlock AND, for wrapped custody, a fresh password entry
(≤ 60 s old) — the QR displays the master secret, so showing it is itself a
step-up act. The QR is rendered full-screen with: an explicit banner ("Anyone
who captures this code owns this vault — no screenshots, no screen sharing,
mind who can see your screen"), a 60-second auto-expiry that blanks the code
(manual re-show), no clipboard path, no network transmission of any kind
(display→camera is the whole channel), and nothing logged or persisted. The
native apps additionally set the platform secure-screen flag (FLAG_SECURE /
iOS capture detection) on both the show and scan screens — recorded as a
mobile-board contract item.

**Payload format (binding — the ONE spec the web renderer and the phone
scanner are both built against; requested by the mobile dev 2026-08-19):**

```
btvault1:m=<words>&v=<vaultId>[&n=<name>][&f=<fingerprint>]
```

- **Version = the scheme prefix.** `btvault1:` is the version marker. An
  unknown prefix (`btvault2:`, anything else) is REJECTED with an "update the
  app" notice — never best-effort parsed; within `btvault1:` unknown query
  keys are IGNORED (additive extension), and a missing required key is a
  reject. Deliberately `scheme:query`, no `//` authority — platform URL
  parsers disagree about custom-scheme authorities, so everything after the
  first `:` is parsed as one `application/x-www-form-urlencoded` query
  string, which every platform parses identically.
- **`m` (required):** the 12 BIP39 English-wordlist words themselves —
  lowercase, NFKD, single-space separated, percent-encoded (spaces become
  `%20` or `+`). Words, not entropy bytes and not wordlist indices: the BIP39
  checksum already rides IN the words (the last word carries the 4 checksum
  bits), so the scanner validates integrity against the standard wordlist
  with zero extra fields; words are what the user wrote down, so a generic QR
  reader shows a human-recoverable payload (worst case: type the words); and
  there is no entropy-encoding/endianness/checksum-recompute step where two
  implementations can silently diverge — which is the whole two-guesses risk
  this spec exists to remove.
- **`v` (required):** the vault UUID (lowercase hyphenated).
- **`n` (optional):** display-name hint, percent-encoded, ≤ 64 chars.
- **`f` (optional, recommended):** the vault's `key_fingerprint` (§4,
  base64url) so the receiver can pre-check the words against the intended
  vault before any network fetch.
- **QR encoding:** byte mode, UTF-8, error-correction level M. The payload is
  ~150–220 chars — a comfortably scannable version-7-ish code.

**Receiver (the phone):** camera scan → prefix check → BIP39 checksum
validation of `m` → the vault id/name hint pre-fills → custody choice
(wrapped default — set/enter the device password; plain behind the §12
warning) → **verified open**: the client fetches the vault header doc from
any reachable medium and proves the words decrypt it (`f`/key_fingerprint
match first when present) BEFORE saving to the keystore, so a mis-scan can
never store dead words.

Manual word entry remains the fallback everywhere the QR is offered.

## 14. Client engine & cross-portfolio composition

- The pure domain layer stays isomorphic in `packages/domain`
  (`@bettertrack/domain`) — money math is NEVER reimplemented client-side
  (review-blocking rule, unchanged). The shipped client engine
  (`apps/web/src/user/vault/engine/`, `vaultPortfolioStore.ts`) re-homes from
  the account singleton onto per-vault portfolio docs: holdings + valuation,
  daily value/cost/P&L series with domain carry-forward, TWR
  (`vaultClientTwrParity.test.ts` stays the parity harness), allocation, cash
  balances, per-year tax through the shared `tax.ts`.
- **Cross-portfolio composition (mixed accounts are the norm):** every
  cross-portfolio quantity is a client-side merge of server-computed plain
  figures and client-computed vaulted figures, merged at the figure level the
  domain engine defines — never by re-implementing offset rules in view code.
  AT/DE cross-portfolio tax (Verlustausgleich spans portfolios) composes this
  way; the year-lock ritual (2026-08-07 §16 row) applies identically.
- **Locked honesty:** while any involved vault is locked, aggregate views
  (dashboard net worth, combined reports, tax composition) render
  **sum-of-visible plus a mandatory lock qualifier** ("+ N locked
  portfolios") — never a bare total, never a silently-partial figure.
- `PortfolioStore` resolves per portfolio: `apiPortfolioStore` for plain rows,
  `vaultPortfolioStore` for vaulted ones — same pages, same components, which
  is why an unlocked vaulted portfolio is indistinguishable day-to-day.
- **The sync-status indicator is an explicit KEEPER — look unchanged, data
  source generalized.** Owner, verbatim (2026-08-19): "i like the 'synched' UI
  up top with the current paranoid mode. its really cool design stuff." That
  is `VaultSyncChip` (`apps/web/src/user/vault/ui/VaultSyncChip.tsx`, mounted
  in the header shell `apps/web/src/user/components/OriginShell.tsx`, fed by
  `projectVaultMediaSyncStatus` in `apps/web/src/user/vault/media/status.ts`).
  Its visual design is NOT redesigned. What generalizes is the projection
  beneath it: with N vaults on different media the chip renders one
  **aggregate state** — `all synced ✓` / `syncing` / `locked (N)` /
  `attention: <vault name>` — computed as the worst state across vaults
  (attention > syncing > locked > synced), and its existing popover gains one
  row per vault (per-vault state, per-medium detail, last-write time, and the
  state's §12 affordance inline: unlock, sign in to Google (Y), open restore
  picker). One chip, never one chip per vault (anti-bloat).

## 15. Step-up re-auth on destructive operations (#1326 carry-over)

Issue #1326 (closed 2026-08-19 as overtaken by this redesign) researched the
pattern; it carries over as the binding gate on every destructive or
data-writing transition, because the threat is identical — a stolen token or
riding session must not be an erasure primitive:

- **Gated operations:** portfolio move-in (destroys cleartext), portfolio
  move-out (writes a caller-authored document), vault deletion, Drive
  disconnect-with-loss acknowledgment, §17 conversion commit. The retired-set
  purge keeps its STRONGER gate (server challenge + Ed25519 proof from inside
  the vault) — no password check bolted on.
- **The credential rides IN the request body** — password, or a fresh TOTP
  `code`, or a `recoveryCode`; at least one required via schema `.refine`,
  mirroring `deleteAccountRequestSchema` / `passkeyDeleteRequestSchema`
  (`packages/contracts/src/auth.ts:675–687`, `:779–788`). Verified inside the
  same account lock as the transition (no check-then-act race); failure rides
  the progressive per-account throttle + an audit record with generic error
  text (`accountDeletionService.ts:103–120` is the model). The in-body
  credential is what replaces CSRF + same-origin on the bearer path — say so
  in the code comment.
- **Both paths, same rule:** the web wizard sends it too; a bearer path is
  never stricter or looser than the browser path. Bearer reachability of the
  transitions follows the owner's 2026-08-17 shared-control-layer ruling under
  `account:security`, default-closed via the method-aware allowlist machinery,
  with the #1326 acceptance battery (wrong-credential = nothing purged,
  INSUFFICIENT_SCOPE naming the scope, unknown-future-route canary) inherited
  as this arc's tests.

## 16. Recovery semantics — lost phrase = lost vault

**Recorded verbatim and binding: a vault's 12 words are the ONLY way in.** If
every copy of the phrase is gone — no endpoint keystore holds it, no paper, no
other device to QR from — that vault's data is cryptographically unrecoverable.
BetterTrack stores no escrow, has no reset path, and support cannot help; admin
cannot help (§18). The only server-side "recovery" is destruction: a
**"start fresh"** flow deletes the vault's blobs (through the §7 gates where
retirement applies) and frees its locked stubs for deletion — it never
recreates data. The creation ceremony makes the user acknowledge exactly this
once, compactly, and the phrase-issuance step verifies one randomly chosen
word as the write-down check (§21 Q2 ruling; §20 E8). Contrast, always stated
beside it: a
forgotten **device password** loses nothing (§12 keystore reset); a lost
**phone** loses nothing while another copy of the phrase exists. Per-vault
blast radius is the design's mercy: one lost phrase never touches the other
vaults or the account.

## 17. Transition plan for live account-level paranoid accounts

**RULED 2026-08-20 (§21 Q3): (C) backup + wipe.** The owner chose the cheap
path over a lossless conversion; the in-place wizard (former recommendation A)
is never built. The plan:

1. **External ciphertext backup first** — the PR #1392 ops pattern
   (`scripts/ops/export-vault-v2-backup.mjs` is the verified-dump precedent):
   dump every `paranoid_vaults` account blob + bounded history to a verified
   archive on the prod host, offsite copy confirmed, THEN any destructive
   step. The owner runs/authorizes the backup, exactly as with the v2
   teardown.
2. **Wipe + reset**: one migration retires the account-level rows (quarantined
   behind the backup, `zz_`-prefix pattern), flips affected accounts'
   `privacy_mode` to `normal`, and clears the account-kill state. Those
   accounts come back feature-complete and empty of previously vaulted
   content; the legacy passphrase and recovery kit die with the wipe.
3. **Notice**: affected accounts get a one-time in-app notice at next login —
   "Paranoid mode has a new shape; the old paranoid data was retired with the
   old system" — with the create-a-vault CTA. No conversion ceremony, no
   legacy passphrase prompt.
4. **The account-level surface is deleted in the same arc** (§19) — the
   one-implementation rule holds with zero unconverted-account bookkeeping.

**Evidence this is safe** (kept from the analysis): every live paranoid
account is server-media-only in practice. Google Drive never worked on
production — `BT_GOOGLE_DRIVE_CLIENT_ID` was never set on the prod host, so
the web runtime config served `googleDriveClientId: ""` and the GIS client
could not even initialize (docs/ops.md, "Browser Google Drive runtime
configuration"; §8) — so no Drive-only data exists to strand. The wipe
migration still verifies actual `paranoid_media_set` values rather than
assuming.

**Alternatives, listed and not built:** (A) in-place re-encryption ceremony at
next unlocked login — fully designed in this note's git history (PR #1401
draft revisions); revive it only if a real, non-test paranoid population ever
needs a lossless path. (B) rehydrate-first — rejected outright: it parks the
user's portfolio in server cleartext mid-flight, exactly the betrayal a
paranoid user opted out of.

## 18. Interplay: exports, deletion, admin, mirrorchain, autonomy seams

- **Account export:** the zip carries `server`-classified data plus — for
  vaults whose media include `server` — the ciphertext docs and manifest
  entries; never cleartext vaulted content, never key material (phrases and
  the endpoint keystore never export). The client-side cleartext export of an
  unlocked vault's portfolios stays the user's own exit (v1 §12 semantics).
- **Account deletion (V4-P2c):** the sweep deletes `vaults`, `vault_blobs`,
  history/retirement rows and `drive_connections`; Drive files get best-effort
  client deletion when the deletion runs from a reachable device, otherwise
  they remain the user's own ciphertext in their own Drive (the confirm says
  so, and app access is revocable at Google).
- **Admin:** per-user view shows vault count, per-vault media + doc
  sizes/versions/timestamps, legacy-wiped marker (§17 — the account went
  through the backup+wipe), Drive-connection count — no portfolio numbers to
  show, which is the feature. Admin can never reset a phrase or device
  password, never read a doc, never restore wiped data.
- **Mirrorchain:** mutual exclusion is portfolio-scoped (§9 precondition, §11
  item 6); severed-fork provenance rides the owning vault's common doc with
  the v1 §7.1 capture/merge/prune/validate discipline intact.
- **Autonomy seams (binding beyond paranoid, unchanged):** `PortfolioStore`,
  `DataHome`, `MarketDataSource` stay the three binding interfaces; the future
  phone-local-only medium (the ruling's "leave that out for now") arrives as a
  `localDataHome`-backed medium through the same seam — reserved in the
  contract enum, rejected by the server, designed nowhere else yet.

## 19. What changes and what dies in the live codebase

**Stays (proven substrate, re-keyed not rewritten):** the envelope crypto +
AAD discipline (`envelope.ts`, `crypto.ts`, `hkdf.ts`), the CAS/merge engine
(`merge.ts`, `sync.ts`), the media runtime + retirement/signed-purge machinery
(`media/`, per vault), the Drive transport + GIS client (`drive/` — the
storage plane re-plumbs per §8's scope recommendation, the transport survives),
the sync-status indicator (`VaultSyncChip.tsx` — look unchanged, projection
generalized per §14), the client
engine + store seam (`engine/`, `vaultPortfolioStore.ts`), `packages/domain`,
the classification axes + completeness tests (`manifest.ts`,
`paranoidClassification.test.ts`, `completeness.test.ts`), the enforcement
inventory harness (`paranoidEnforcement.ts` + completeness test), the
`asset_identities` seam, `limiters.vault`, the `vault:sync` scope. **Discreet
mode: untouched.**

**Dies at the end of §17 (not before):** the account-level enable/disable
pipeline (`paranoidTransitionService`, `POST /account/paranoid/enable|disable`,
`fork-provenance`, `normal-revision` — `accountRoutes.ts:141–226`), the
four-media account-singleton document and its store (`paranoid_vaults`,
`paranoid_vault_history`, `paranoid_enable_transitions`,
`paranoid_vault_server_candidates`, `paranoid_vault_retirements`,
`paranoid_vault_retired`, `paranoid_rehydration_receipts`; `GET/PUT /vault` and
the `/vault/media*` account family), `users.privacy_mode` + the paranoid media
columns + CHECK (`schema.ts:205–253`), the account-wide `PARANOID_MODE` kill
rail in `bearerAuth.ts`, `MeResponse.privacyMode` as a mode signal, the v1
unlock gate that replaced the whole authenticated subtree (per-portfolio
locking needs no app-wide gate), the account-level wizard + recovery-kit flow,
and v1's persisted-VK "keep unlocked" custody. Drops ship as append-only
migrations after an owner-authorized external ciphertext backup for any
straggler accounts (§17).

**Rewritten:** this note (done), PROJECTPLAN §13.5 V5-P13 arc (b) (same PR),
`docs/mirrorchain-design.md` §14 wording account→portfolio (in the E2 epic),
the mobile PLATFORM_ASKS Drive-naming contract (§8, when E5 lands).

## 20. Build decomposition (epics, ordered — contract-form issues cut from these after ack)

| #   | Epic                                            | Scope sketch                                                                                                                                                                                                                                                                                                                                                                  | Rough size / tier                  |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| E0  | **Contracts + schema**                          | `vaults`, `vault_blobs` (+history/candidates/retirement re-key), `drive_connections`, `portfolios.vault_id`/`vault_alias`, envelope v2 + doc-set zod contracts, classification axis gains the doc bucket, per-portfolio revision token contract                                                                                                                               | L, T1 (schema + contract keystone) |
| E1  | **Per-vault blind store**                       | Vault CRUD routes, per-doc GET/PUT CAS + history, size caps per kind, `vault:sync` re-key, OpenAPI                                                                                                                                                                                                                                                                            | M, T2                              |
| E2  | **Per-portfolio enforcement + account un-kill** | Registry re-key portfolio-first, `VAULTED_PORTFOLIO` guard, bearer un-kill (delete account rail), matrix + probe + full-functionality regression, mirrorchain exclusion re-scope                                                                                                                                                                                              | L, T1 (security boundary)          |
| E3  | **Client key core**                             | BIP39 gen/validate, derivation chain (§4), keySlots, key_fingerprint, endpoint keystore + device password custody + plain-custody warning + lockout/reset (§12); test vectors incl. tamper/rollback                                                                                                                                                                           | L, T1 (keystone crypto)            |
| E4  | **Move-in / move-out pipeline**                 | Per-portfolio capture token + double-read capture, purge sweep + share revocation + stub, strict per-portfolio restore + solvency + fork-provenance validation, §15 step-up on both, idempotent retry semantics                                                                                                                                                               | XL, T1 (the destructive core)      |
| E5  | **Drive multi-connection**                      | `drive_connections` CRUD + UI, per-connection GIS with login_hint, per-vault binding + connection migration, §8 namespace + ownerDigest discipline, revocation/disconnect flows, mobile contract addendum                                                                                                                                                                     | L, T2                              |
| E6  | **Client engine re-home + composition**         | Store resolution per portfolio, engine on portfolio docs, cross-portfolio tax/aggregate composition + lock qualifiers, standing-order client materialization, client cleartext export per vault                                                                                                                                                                               | XL, T1 (money)                     |
| E7  | **QR transfer**                                 | The §13 `btvault1:` payload spec verbatim (web renderer + phone scanner against ONE spec); sender step-up + expiring full-screen QR, receiver scan → checksum → verified open → custody choice, secure-screen flags contract for native                                                                                                                                       | M, T2                              |
| E8  | **Web UX**                                      | Vault manager (create ceremony: name → media/connection → 12 words + ONE-word verify + lost-phrase ack + custody, §21 Q2), locked stubs + state→affordance invariant everywhere, the `VaultSyncChip` per-vault generalization (§14 — aggregate state + per-vault popover rows, visual design untouched, owner keeper), move-in/out wizards, Settings → Privacy rewrite, EN+DE | L, T2 (flagship UX, owner-eye)     |
| E9  | **Transition + v1 retirement**                  | §17 as ruled (C): owner-run verified ciphertext backup (export-script pattern) → wipe/reset migration (privacy_mode→normal, account-kill cleared, rows quarantined) → one-time fresh-start notice, then the §19 deletion train (append-only drops)                                                                                                                            | M, T2 with T1 review on the wipe   |
| E10 | **e2e + gate**                                  | Playwright: full create→move-in→lock→unlock→move-out arc; Drive-only vault round trip; two-users-one-Drive isolation; mixed-account full-functionality sweep; QR handoff (mocked camera); wrong-password lockout; fresh-start notice after the §17 wipe; joins the V5-P14 suite                                                                                               | M, T3/T2                           |

Ordering: E0 first; E1+E3 parallel after E0; E2 after E1; E4 after E1+E3; E5
after E1; E6 after E4; E7 after E3; E8 after E4 (wizards) with early shell
work parallel; E9 after E4+E6+E8; E10 last. Every epic: suite green, EN+DE,
append-only migrations, OpenAPI/route-census regeneration where touched.

## 21. Ruled — the five gate decisions (2026-08-20)

Asked and answered in chat on 2026-08-20. The owner answered Q1–Q4 and
delegated everything further to the Chief ("you are now responsible for all
following decisions"), who ruled Q5. Binding:

1. **Move-out: ALLOWED.** §10 stands exactly as designed — unlocked device,
   loud "becomes server-readable again" warning, restore as a normal server
   portfolio.
2. **Creation ceremony: middle ground** (owner verbatim: "validate only one
   word. no 20 years waiting and lots of friction"). Issuance shows the 12
   words, then verifies exactly ONE randomly chosen word plus one compact
   lost-phrase-means-lost-data acknowledgment. No multi-word drills, no
   added waiting.
3. **Transition: (C) backup + wipe.** §17 is rewritten accordingly; the
   in-place conversion wizard (former recommendation A) is never built.
4. **Vault names: cleartext, stated calmly.** Names and locked-stub aliases
   stay server-visible config (§3). The paranoid explainer communicates it as
   a plain fact among the feature points — "encrypted: everything inside the
   portfolio; not encrypted: the vault's name and storage config; features
   X/Y keep working" — no alarm banners, no bloat (owner wording).
5. **Drive: `drive.file` with the visible "BetterTrack Vaults" folder**
   (Chief's delegated ruling). §8's recommendation is adopted; the hidden
   app-data folder retires. Zero migration cost — Drive never worked on prod.

## 22. Constraints & non-goals

- **No key escrow, ever.** No owner/admin/support recovery; lost phrase ⇒ lost
  vault, by design (§16).
- **No server-held Drive tokens, ever** — one rule for every vault kind; the
  Drive-only "zero capability" guarantee depends on it (§8).
- **Local-only (phone-only) storage is reserved, not built** — contract enum
  value exists, server rejects it, no flows designed (the ruling's "leave that
  out for now").
- **Doc granularity is the sync unit** — no per-entity server sync, no
  server-visible oplog; entity granularity exists only inside the encrypted
  payload for merges.
- **No client-side broker/bank import for vaulted portfolios in this arc** —
  manual entry works; a client import engine stays a later candidate, not a
  silent promise.
- **Encrypted-vault SHARING is far future** — `keySlots[]` keeps it possible;
  no flows are designed now.
- **Metadata honesty, recorded:** the server still sees that vaults exist,
  their names (ruled cleartext, §21 Q4), media configs, Drive-connection identities
  (email/sub — config, not content), locked-stub portfolio ids + aliases, doc
  sizes/versions/timestamps, login/session activity, alert rules and
  watchlists (asset-level interest), and market-data request patterns. None of
  it is portfolio content; every portfolio byte inside a vault is
  client-encrypted.
- **Discreet mode** is a separate arc and is untouched by this redesign.
- Size caps, history depth, retention windows, rate limits — env-tunable ops
  knobs, not product surface.
