# PARANOID VAULTS — per-portfolio client-encrypted privacy (V5-P13 arc b, redefined 2026-08-19)

**Status:** ACKED & RULED 2026-08-20 — the five gate questions are answered
(§21) and the owner delegated all further paranoid decisions to the Chief;
implementation issues may be cut from §20. Epics E0–E10 have since shipped as
code. §17 is an owner-run runbook that has NOT been executed on production, so
the §19 deletion train has not run and every v1 account-level table and route
is still live. The one-implementation ruling (§16, 2026-08-19, PR #1392)
stands: this REPLACES the account-level model inside the single paranoid
implementation — not a second variant, and the torn-down "vaults v2" surface is
not resurrected.

This note is NORMATIVE and describes what the code does today, with citations;
anything designed but unbuilt says so and names its issue. The arc's narrative
— the superseded account-level model, the transition analysis, the alternatives
not built, the epic table — is archived verbatim in
`docs/history/paranoid-design-history.md`.

**Table of contents**

1 Model + glossary · 2 The owner's ruling (verbatim) · 3 Vault + server data
model · 4 Seed phrase → keys · 5 Envelope v2 + the doc set · 6 Sync, CAS, merge
· 7 Media switching, retirement, signed purge · 8 Google Drive · 9 Move-in ·
10 Move-out · 11 Feature-kill matrix + full-functionality proof · 12 Device
custody · 13 QR seed-phrase transfer · 14 Client engine + composition · 15
Step-up re-auth · 16 Recovery semantics · 17 Transition (§17) · 18 Interplay
seams · 19 What stays and what dies · 20 Build decomposition · 21 The five gate
rulings · 22 Constraints & non-goals

---

## 1. The model in one paragraph + glossary

An account owns **N paranoid vaults**. A vault is a **storage config** — where
its encrypted bytes live: the BetterTrack server, a **separately authenticated
Google Drive connection**, or both (a phone-local-only medium is reserved for a
future version, never silently promised). Each vault is encrypted client-side
and opens **only with its own 12-word seed phrase**, like a crypto wallet: no
escrow, no reset, no support path — lost phrase means that vault's data is
cryptographically gone, while every other vault and the rest of the account are
untouched. **Portfolios move INTO a vault**: move-in hard-deletes the
portfolio's server cleartext and re-homes it into the vault's encrypted
document set, so only end devices holding the phrase can read it; move-out
(from an unlocked device) rehydrates it back. Server features die **per vaulted
portfolio only** — sharing, public-profile inclusion, server-computed stats,
server jobs, imports, portfolio-scoped API access to that portfolio — while
every non-vaulted portfolio of the same account keeps FULL functionality,
proven by a registry-driven matrix test. On a device a stored phrase is
protected by a **device password** never cached across sessions, or — behind a
strong warning — stored plain ("encrypted and unreadable for BetterTrack" is
then the whole promise). A QR flow hands the phrase to the phone. The client
does all money math for vaulted portfolios with the **same audited domain code
the server uses** (`packages/domain` — never reimplemented), reading through
the `PortfolioStore` seam, so day to day a vaulted portfolio looks like a
normal one on an unlocked device.

Glossary: _doc_ = one encrypted blob of a vault's set (header / common / one
per portfolio); _medium_ = a place docs sync to; _Drive connection_ = one
separately-OAuth'd Google account usable as a medium, N per account; _endpoint_
= one installed client; _endpoint keystore_ = its device-local store of seed
phrases; _K_c_ = a vault's random 256-bit content key; _locked stub_ = the
content-free server row a vaulted portfolio keeps.

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
ruling's own words. Knowing THAT a vault exists, where it stores and WHICH
portfolios are inside is required to enforce §11 and render locked stubs; it is
not portfolio content. What the server can never do is read a doc.

Shipped in `apps/api/src/data/schema.ts` (migration `0091_paranoid_vaults_keystone`);
each bullet names its Drizzle table export, not a line:

- **`vaults`** — `id`, `user_id`, `name` (cleartext by design: it is
  config and the UI needs it while locked), `media`, `drive_connection_id`,
  `retirement_proof_public_key` (the per-vault Ed25519 purge verifier, §7),
  `key_fingerprint` (a non-secret HKDF tag of K_c that lets a client confirm
  "these words open THIS vault" before destructive steps, §4),
  `header_doc_id`/`common_doc_id`, `retirement_generation`, `media_attested_at`
  plus `media_attested_drive_connection_id` (§7 consequence 3). One CHECK
  carries the whole media contract (the `vaults_media_state` CHECK): the set is
  exactly `{server}`, `{drive}` or `{server,drive}` — non-empty and
  duplicate-free by enumeration, `local` refused at the deepest boundary, the
  drive ⇔ connection binding as its second half. `local` is RESERVED in the
  contract enum (`VAULT_MEDIA_VALUES`), rejected as `reserved_medium`.
- **`vault_blobs`** — `(vault_id, doc_id)` PK, `doc_kind`
  (`header`|`common`|`portfolio`), `portfolio_id` (set iff `portfolio`,
  CHECK-pinned equal to `doc_id`), `version` (the per-doc CAS token),
  `format_version`, `size_bytes`, `blob` (bytea, never interpreted past the
  envelope header). Caps per kind — header 1 MiB, common 4 MiB, portfolio 8 MiB
  (`BT_VAULT_MAX_BYTES_*`).
- **`vault_blob_history`**, **`vault_server_candidates`** and
  **`vault_retired`** are per doc; **`vault_retirements`** is keyed by
  `vault_id` ALONE — one record per vault. Bounded history (10 versions /
  30 days, `BT_VAULT_HISTORY_MAX_*`) is the bad-write safety net.
- **`drive_connections`** (§8) — `google_sub` is unique per user, not globally:
  two users may connect the same Google account.
- **`portfolios.vault_id`** + **`vault_alias`** (the locked-row label; the true name travels inside the ciphertext). NULL ⇒ normal
  portfolio, today's behavior byte-for-byte; NOT NULL ⇒ the locked stub: zero
  content rows (probed), only identity + alias + membership. The stub exists for
  (a) enforcement keying, (b) same-UUID move-out, (c) rendering "N locked
  portfolios" and the unlock affordance.

**Mounted routes** under `/api/v1`, all in `http/routes/vaultRoutes.ts` except
the last two, which are in `portfolioRoutes.ts`: `GET`/`POST /vaults` and
`GET`/`PATCH`/`DELETE /vaults/:vaultId`; `GET`/`PUT
/vaults/:vaultId/docs/:docId` and `/history[/:version]`; `GET`/`PATCH
/vaults/:vaultId/media`; `PUT
/vaults/:vaultId/media/server-candidate/:transitionId/docs/:docId` and its
`GET` readback; `POST /vaults/:vaultId/media/retired/purge` and `/challenge`;
the `drive-connections` family; `GET
/portfolios/:id/vault/{revision,lifecycle}`; `POST
/portfolios/:id/vault/move-in` and `move-out[/challenge]`. `DELETE
/vaults/:vaultId` refuses while
a portfolio references the vault (`VAULT_REFERENCED_BY_PORTFOLIO`) or a
retirement is pending (`VAULT_RETIREMENT_PENDING`); doc GET/PUT are
ETag/`If-Match` CAS and answer 428 `VAULT_PRECONDITION_REQUIRED` with no
precondition.

**Deliberately NOT a server fact:** seed phrases, the endpoint keystore, the
device password, unlock state, and which endpoints hold which phrases. There is
no server table for endpoint custody, ever. `users.privacy_mode` and the
account-level media columns (`privacyMode`, `paranoidMediaSet` on the `users`
table) retire at the end of §17.

## 4. Seed phrase → keys (BIP39, derivation, rotation)

**BIP39 is the standard.** 12 English-wordlist words = 128-bit entropy + 4-bit
checksum: boring, ubiquitous, checksum-validated at entry (typo detection),
excellent test vectors, exactly the owner's "like a crypto wallet". Words are
generated client-side from CSPRNG entropy at vault creation and NEVER leave the
device except via the §13 QR flow or the user's own pen.

**Derivation chain (binding — standard primitives only):**

```
mnemonic (12 words)
  → BIP39 seed          standard BIP39: PBKDF2-HMAC-SHA512(mnemonic, "mnemonic", 2048), empty passphrase
  → K_wrap              HKDF-SHA256(seed, info = "bettertrack-vault-wrap-v1:" + vaultId)
  → K_c                 unwrap keySlots[0] (AES-256-GCM wrap of the random content key)
  → docs                AES-256-GCM per doc, full serialized header as AAD
key_fingerprint = base64url(HKDF-SHA256(K_c, info = "bettertrack-vault-fingerprint-v1"))[0..16]
```

Every literal is a contract constant (`VAULT_WRAP_HKDF_INFO_PREFIX`,
`VAULT_KEY_FINGERPRINT_HKDF_INFO`, `VAULT_ACCOUNT_BINDING_INFO_PREFIX` in
`packages/contracts/src/vaults.ts`),
implemented in `apps/web/src/user/vault/keys/keyCore.ts` (HKDF `:52`,
fingerprint `:182`, account binding `:271`) over `@scure/bip39`.

**Binding `seed-v1` key-slot wire contract for phone unwrap:** wrap the random
32-byte `K_c` with AES-256-GCM under `K_wrap`, fresh 12-byte IV, UTF-8 AAD
exactly `bettertrack-vault-key-slot-v1:${vaultId}:${keyId}`. `wrappedKc` is
unpadded base64url of `IV || ciphertext || 16-byte GCM tag` (WebCrypto's
ciphertext already carries the tag); a consumer MUST read this layout
byte-for-byte and fail closed on malformed length or authentication
(`keys/keyCore.ts`).

Notes, each deliberate: **no Argon2id on the mnemonic** — stretching defends
low-entropy human secrets, a 128-bit random mnemonic needs none, and the
standard PBKDF2 step keeps us vector-compatible with every BIP39 tool; Argon2id
stays where a human secret exists, the §12 device password. The **`keySlots[]`
indirection stays** (header-carried): K_c is random and wrapped by K_wrap,
which is what makes rotation and any far-future sharing possible without
re-issuing words. The phrase is **per vault** — the `vaultId` in the HKDF info
domain-separates even a re-used mnemonic (which the UI never offers).
**Rotation** re-encrypts under fresh words (full doc-set re-encrypt + verified
round trips + history invalidation), never forced; there is no "change phrase
but keep K_c" path, because if the words leaked K_c must go too — **planned,
not built.** The v1 recovery kit (raw-VK download) is RETIRED by ruling: the
phrase is the sole credential and the write-it-down ceremony replaces it. The
v1 kit still ships for live account-level accounts until §17 runs.

## 5. Blob format + versioning (envelope v2, the per-vault doc set)

**One envelope format for every medium**, evolved from the shipped `BTVAULT1`
(`packages/contracts/src/vault.ts`, `apps/web/src/user/vault/envelope.ts`).
What it got right is kept: magic + 4-byte header length + cleartext JSON header
then ciphertext; the **full serialized header bound as AES-GCM AAD** so any
header tamper (version rollback included) fails decryption; deflate before
encryption; strict fail-closed versioning.

**Envelope v2 header** — cleartext, counters/ids/crypto parameters only, never
portfolio information (`vaultDocEnvelopeHeaderSchema`, `.strict()`):

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
decryption before any namespace check. The server never parses more than the
six-field projection `vaultDocServerHeaderSchema`.

**The doc set.** The **`header` doc** carries vault metadata under encryption
(true name, member roster, keySlots echo, creation record, the §8
`driveConnection` identity echo). The **`common` doc** carries account-scoped
material the vault's portfolios reference: the custom-asset bucket with the v1
snapshot/tombstone/strict-restore-narrowing semantics and the
`asset_identities` claim seam, severed-fork mirrorchain provenance, the
retirement-proof Ed25519 private key (the header doc's `clientSecurity`
member), mergeLog. One
**`portfolio` doc per member** carries every `vault`-classified row of that
portfolio — transactions, dividends, cash sources + movements, per-portfolio
settings, tax settlement rows, standing-order definitions + the
`standing_order_runs` exactly-once ledger, historical import batches/rows (a
portfolio carrying any is refused at capture today —
`VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED`, §9 step 2), scoped expense rows;
snapshots stay derived-and-purged, never carried. Per-doc granularity is
what makes move-in/move-out incremental, keeps the size caps honest, and lets
two devices editing two different portfolios not conflict at all.

**Payload document rules carried from v1:** uuidv7 entity ids, per-entity
monotonic `rev` + `editedAt` + writing `deviceId`, tombstones kept ≥ 180 days,
pure `v(n)→v(n+1)` schema migrations on load, NEWER-version docs go read-only
with an "update the app" notice — never best-effort parsed.

**Three classification axes, all CI-gated** (`services/export/manifest.ts`).
Every Drizzle table classifies `vault` | `server` | `purge`
(`PARANOID_TABLE_CLASSIFICATION`) and CI
fails on an unclassified table. Two more ride alongside, neither hand-listed in
that map: the **doc bucket** (`PARANOID_VAULT_DOC_BUCKETS`, `:759`, derived
from `VAULT_TABLE_ENTITY_KINDS` × `VAULT_ENTITY_DOC_BUCKETS` —
portfolio-scoped → portfolio doc, account-scoped-but-vault-referenced → common
doc) and the **rehydration policy** (`ParanoidRehydrationPolicy` —
`restore(entity)` vs
`purge-only`). `PARANOID_PURGED_TABLE_NAMES` and `PARANOID_PURGE_REASONS`
(pinned in `paranoidClassification.test.ts`) are portfolio-scoped —
`usage_events` capture suppression keys on "does the request target a vaulted
portfolio / does the account own any vault" for the client engine's quote reads
(the #1344 holdings-roster leak must not reopen per portfolio).

## 6. Sync, CAS and the merge protocol

The v1 storage protocol carries over **per doc**:

- **Server medium:** ETag/`If-Match` CAS per `(vaultId, docId)` — the HTTP
  precondition is the entire server-side CAS decision
  (`vaultBlobRepository`), and `docVersion` is never version-gated. 412
  `VAULT_PRECONDITION_FAILED` on mismatch, a distinct terminal 412
  `VAULT_WRITE_ID_REPLAYED` for a replayed write, 428 with no precondition.
  Bounded history; the server reads nothing past the envelope header. Rate
  limiting is **two** families, not one: `limiters.vaultRead` for GET/HEAD
  (600/min) and `limiters.vault` for everything else (60/min).
- **Drive medium:** per-doc file (§8 naming), `appProperties` carrying exactly
  `{ownerDigest, vaultDigest, docKind, docVersion, formatVersion}`
  (`drive/driveDataHome.ts`); CAS approximated via appProperties +
  `headRevisionId` with the accepted TOCTOU window (writers are one user's own
  devices; the merge repairs races). Drive revisions are that medium's history.
- **Local cache:** a per-endpoint encrypted cache of last-known docs — a cache,
  not a medium; the future phone-local-only medium arrives through the
  `DataHome` seam (§18), not by promoting it. **Write path:** local commit →
  encrypt affected docs (docVersion + 1) → CAS to primary (server when present,
  else Drive) → replicate identical bytes to the secondary.
- **Conflict rule (binding, unchanged):** entity granularity, never field
  granularity; higher `rev` wins → later `editedAt` → lexicographically higher
  `deviceId`; tombstone vs concurrent edit → the edit wins; merged docVersion =
  max(parents) + 1; commutative + idempotent; corrupt candidates kept for the
  restore picker, never silently discarded. Fork provenance merges by
  content-addressed union with the v1 prune-in-three-places lifecycle. As
  shipped (`vault/merge.ts`) the ladder resolves `rev` →
  live-beats-tombstoned → `editedAt` → `editedBy` (which IS the deviceId) → a
  canonical-JSON comparison as the total-order tiebreak the prose leaves
  implicit.
- **`vault:sync` bearer exception** (owner mandate 2026-08-04), re-keyed:
  opaque per-doc GET/PUT, both history reads, `GET /vaults/:vaultId/media` and
  the `GET /vaults[/:vaultId]` config reads (the `vault:sync` allowlist in
  `bearerAuth.ts`). Destructive
  and recovery-media transitions stay off the plain bearer path except as §15
  gates them; the retirement-proof header stays ignored-on-bearer so a token
  can never pin a verifier.

## 7. Per-vault media switching, retirement, signed purge

The v1 machinery, re-keyed per vault — it shipped, survived a COD
reconciliation (#895/#896) and is kept because it is right:

1. **Add a medium:** write the full doc set there → verified round trip (read
   back, decrypt, compare writeId/hash per doc) → `PATCH /vaults/:id/media`
   records the set. Adding `server` goes through staged server candidates and
   needs an exact candidate roster plus one signed readback receipt each, else
   412 `VAULT_MEDIA_PARTIAL_SET`.
2. **Remove a medium:** only while another medium holds a verified-fresh copy.
   Removing `server` atomically moves the vault's blobs + history into the
   retired recovery set (`vault_retired`), destroyable only through the signed
   purge gate: minimum 7-day retention, fresh other-medium readback, server
   challenge, **Ed25519 proof with the private key held inside the encrypted
   common doc** — possession of the vault's key, not of a session. Removing
   `drive` best-effort deletes the Drive files and says so when it could not
   (the leftover is the user's own ciphertext in their own Drive).
3. The last medium can never be removed (`vaultMediaListSchema.min(1)` plus the
   `vaults_media_state` CHECK).

**Recorded honestly against the code — rule 2 is not fully enforced (#1637).**
On an ordinary transition `vaultBlobRepository` accepts a readback attestation
of EITHER kind, so removing `server` can be authorised by a _server_-kind
attestation — an attestation against the medium being removed rather than the
one that must survive. Strict enforcement exists only in the same-selection
refresh and Drive-replacement branches. Nothing is lost today (the media CHECK
still refuses an empty set and no vault has a second medium yet), but #1637
must land before Drive provisioning ships.

**Staged-candidate lifetime — retained to TTL, never deleted at success
(#1491, Chief 2026-08-22).** A staged batch (`vault_server_candidates`, 10-minute
`expires_at` per row) is consumed only when it is PROMOTED into the active plane
(`added = ['server']`, which copies the bytes into `vault_blobs`) or dropped by a
gate that makes it unusable (retirement-pending refusal, a newer transition id
replacing it — the signed purge never drops a live batch; it prunes only
already-expired rows and otherwise refuses, see consequence 2). The destructive
per-portfolio commits — move-in
(§9) and move-out (§10) — no longer delete it: the rows live out their own
`expires_at` and are disposed by the lazy expiry checks plus the bounded
retention sweep (#1521). The reason is the §8 attestation boundary: the server's
Drive attestation is a consistency check against its own rows and can never be
evidence that bytes reached Drive, so deleting the batch at commit would turn a
lying or buggy client into irrecoverable data loss. Retention converts that into
"recoverable inside the window", and the window is the honest boundary — after
`expires_at` a lost Drive write is gone. Throughout, the batch stays INACTIVE:
`media` remains the only authority on where a vault is stored, reads resolve
against `vault_blobs` only (a Drive-only vault answers `medium_inactive`), and
the media state reports the rows as `inactive-candidates`, never as a data home.
Four consequences, all accepted and all bounded by the same TTL:

1. **Drive-connection replacement waits.** While a retained batch is live,
   replacing the vault's Drive connection (below) refuses with its existing
   state conflict, because that edge requires zero candidate rows. Self-healing
   at `expires_at`; no user-facing surface exists yet (the Y → Z move has no
   production caller until E8), so the specific "try again in N minutes" copy
   belongs with that UI, not here.
2. **A signed purge of retired server data waits too** — `purgeRetired` refuses
   while any live candidate exists, so after a Drive-only move-in/move-out the
   purge is delayed by up to the TTL. Deliberate asymmetry with the
   retirement-pending branch of `transitionMedia`, which still DROPS the batch
   on purpose: where the explicit-purge ruling (2026-07-28) and recoverability
   collide, the purge wins — on a Drive-only vault carrying a retirement row, a
   refused add-server attempt does destroy a live recovery copy before its TTL,
   and that is the accepted price of keeping the ruled purge path immediately
   reachable. Here (no retirement pending) the batch is the recovery copy, so
   the purge is what waits.
3. **A move-out straight after a move-in can prove its roster from the retained
   batch.** `completeMoveIn` stamps `mediaAttestedAt` itself, so the batch it
   retained satisfies `verifyMoveOutDocuments`' `createdAt <= mediaAttestedAt`
   pairing (§10), where pre-#1491 a fresh full-set stage was required. It stays
   fail-closed one level up: the roster proof yields the `documentSetHash` the
   service compares against the client's own declared value, so a set stale
   relative to the client's view is refused (`DOCUMENT_SET_STALE`).
4. **A retained batch stays PROMOTABLE for the rest of its TTL** — the one way
   the "inactive" rows become active again. Pre-#1491 the commit-time delete
   closed that window immediately; now promotion (`added = ['server']`) is
   TTL-closed twice over: `exactCandidateRoster` requires every row's
   `expires_at > now`, and the readback token embeds the candidate's own
   `expiresAt`, re-checked at `transitionMedia` — the receipt dies with the
   candidate. Note the honest boundary: rows stop being READABLE at
   `expires_at` (every read path disposes-and-refuses), while the bytes leave
   disk at the next lazy touch or the daily retention sweep (#1521) — up to
   ~24h later on a vault nobody opens.

What the server does NOT enforce: that a client opens a NEW transition id after
a commit. Staging under a different id wipes the batch wholesale, but a client
reusing its own committed id tops the batch up — mixing a fresh document with
up-to-TTL-old siblings. Bounded by the TTL and by the same owner, and every
consumer compares the batch against a client-declared value, so this is a
recorded property, not a proof the server makes.

Consequence 3's service literal is `DOCUMENT_SET_STALE`; the wire code is
`PORTFOLIO_VAULT_DOCUMENT_SET_STALE`. The staged-candidate TTL and the
retirement retention floor are **compile-time contract constants, not env
knobs** (`VAULT_SERVER_CANDIDATE_TTL_MS` 10 min,
`VAULT_RETIRED_SERVER_MIN_RETENTION_MS` 7 d) — §22's "retention windows are
env-tunable ops knobs" holds for history depth
(`BT_VAULT_HISTORY_MAX_VERSIONS`/`_AGE_DAYS`) and the size caps, but NOT for
these two, which no deployment can move. The daily sweep is
`createDataRetentionCleanupJob`.

Changing a vault's **Drive connection** (Y → Z) is a media migration with the
same discipline, and it starts one step earlier than a byte copy: the header
doc's §8 `driveConnection` identity echo is first rewritten to Z through the
NORMAL replicated write path — every active medium, server included — and only
then is the (now Z-naming) doc set written to Z's namespace, verified, the
binding PATCHed, and Y best-effort deleted. A byte-only copy would leave the
encrypted header naming Y, so words + the right Google login would no longer
discover the vault; and for a replicated vault the server's attestation rows
would disagree with the new Drive bytes, which is what `PATCH
/vaults/:vaultId/media` verifies. Source and target must differ — a
same-connection "move" resolves both homes to one object, so the copy is
skipped as already-equal and the cleanup would delete the only copy while
reporting success. **Built but deliberately unwired (#1638)**
(`vault/media/driveMigration.ts`): production still composes the v1
account-scoped Drive home, and the per-vault client media switcher
(`media/mediaSwitcher.ts`) also still speaks the v1 account-level API. E6
(#1416) and E8 (#1418) are both closed, so #1638 is the tracker; it must land
with Drive provisioning, not after it.

## 8. Google Drive — separate authentication, multi-connection, collision-safe namespace

**Drive is authenticated separately from the login identity, by construction.**
A **Drive connection** is its own end-user OAuth consent to whichever Google
account the user picks in Google's chooser, decoupled from how they log in.
Login with X, back up to Drive Y, put another vault on Drive Z: supported.

**Not yet provisionable.** `PER_VAULT_DRIVE_PROVISIONING_AVAILABLE = false`
(`apps/web/src/user/vault/capabilities.ts`) — a plain constant, deliberately
not an env or feature flag, so nothing an operator can flip brings the missing
epic's code with it. `provisionVault.ts` refuses any `media` containing
`drive`, the create ceremony renders the option disabled and names the gap, and
`[E10-A9]` is a `test.fixme` on the same flag. The registry, the transport and
the namespace discipline below all ship; the per-vault provisioning path does
not (**planned, E5 residual — no open issue tracks it; nearest #1597, #1598**).

- **Connection identity.** GIS mints ephemeral tokens with no durable notion of
  "connection Y vs Z", so the client captures identity at connect time: after
  consent it calls Drive `about.get(fields=user)` with the fresh token and
  records the account's stable subject id + email (`drive/driveIdentity`). The
  authoritative registry is server-side **`drive_connections`** —
  `id`, `user_id`, `google_sub` (unique per user), `email`, `display_name`,
  `created_at`, `last_verified_at`; **no tokens, no refresh tokens, no file ids
  — ever.** It is account CONFIG under the ruling's definition (§3): it lets
  the UI list connections, lets a vault bind to one, and tells a fresh
  signed-in device WHICH Google account to ask for. For autonomy the same
  identity is ALSO echoed inside the encrypted header doc, so a device with
  only the words + the right Google login can discover its docs by query — the
  registry is convenience, never a decryption or discovery prerequisite. Two
  BetterTrack users may hold connections to the same `google_sub`: the
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
  ciphertext, and zero CAPABILITY to fetch the Drive copy. "Zero ACTIVE
  ciphertext" is exact, and the §7 retention is what lives inside that word: a
  staged batch stays as bounded, self-expiring INACTIVE rows for its 10-minute
  TTL after a Drive-only move-in or move-out — never a medium, never served,
  never a data home. The user is told so with the TTL at the moment of the
  CHOICE (the create ceremony's Drive-only radio, which therefore does not
  promise "nothing, not even encrypted" without naming the exception) and again
  in both move ceremonies, in and out. That retention exists precisely BECAUSE this bullet is true: since the
  server can never verify a Drive write, a client that attests one that did not
  land must stay recoverable for a bounded window. Refresh = GIS
  re-mint (silent while the Google session lives, a user gesture otherwise).
  **Every re-mint repeats `about.get` and compares its `permissionId` with the
  connection's stored `google_sub`; a chooser switch fails closed as the
  distinct `identity-mismatch` state before the new token can reach storage.**
  The sync indicator (§14) surfaces "sign in to Google (Y) to sync" — never a
  silent stall.
  Verification runs on fresh consent and real re-mints;
  `registerClient.authorize()` skips `about.get` when the client already held a
  live token (`media/driveConnectionRegistry#authorize`), and every Drive
  header read re-checks independently (`qr/driveHeader`).
- **Scope RULED (§21 Q5) — `drive.file` with a visible "BetterTrack Vaults"
  folder**, shipped: `DRIVE_FILE_SCOPE` (`drive/gisTokenClient`),
  `DRIVE_FOLDER_NAME` (`drive/driveDataHome`); no `drive.appdata` remains
  anywhere. The hidden app-data folder was namespaced per (Google account ×
  OAuth client), NOT per BetterTrack user, and failed the owner's mental model
  twice: the user could never SEE that the backup exists ("i am not sure if the
  google drive stuff works" — a visible file is the proof), and the bytes were
  reachable only through our OAuth client, which fights autonomy. Under
  `drive.file` the app touches ONLY files it created, the docs sit where the
  user can eyeball and hand-download them (ciphertext + their words = a
  recovery path needing nothing from us), and rename/move is harmless because
  lookups go by cached fileId + `appProperties`, never by name. Risks named
  honestly: the user can delete their own backup (the sync indicator flags it;
  Drive trash holds 30 days), and co-users of a shared Google account see the
  folder (they share the whole Drive anyway; the names carry no PII).
- **Revocation.** The user can revoke at Google at any time (the app detects
  `invalid_grant`-class failures and flags the connection); in-app
  **disconnect** refuses while any vault is bound unless the vault first
  migrates off it (§7) — or, behind an explicit acknowledgment, the user
  accepts that the app loses reach to that copy. **A Drive-ONLY vault is the
  one case the acknowledgment cannot cover** (PROJECTPLAN §16 2026-08-21):
  dropping its last medium would leave the empty media set
  `vaults_media_state` rejects, and the only copy of every doc behind a binding
  that no longer exists — so the refusal (`DRIVE_CONNECTION_LAST_MEDIUM`) is
  decided BEFORE the acknowledgment is read (`driveConnectionRepository`), and
  the owner is never offered a loss
  of reach that was never on the table. Add and attest the server medium first.
- **Collision-safe namespace (two users, one physical Drive).** Both users'
  files share one visible folder, so the naming + ownership discipline is the
  isolation, never the folder (`driveDataHome#driveVaultFileName` and the
  `appProperties` it writes beside it):

  ```
  name = "bettertrack-vault-" + base64url(sha256(
           "bettertrack-drive-vault-v2:" + accountId + ":" + vaultId + ":" + docId
         )) + ".btenc"
  appProperties = { ownerDigest: sha256("bettertrack-drive-owner-v1:" + accountId),
                    vaultDigest, docKind, docVersion, formatVersion }
  ```

  `vaultDigest` has its own context `bettertrack-drive-vault-id-v1:`; the v1
  account-singleton form `bettertrack-drive-vault-account-v1:` still ships
  alongside until §19 drops the v1 surface. **Cannot clobber:** names are
  digests over (account, vault, doc), so two users' names never collide; a
  client lists by its own `ownerDigest` filter (rename/move-proof), NEVER
  writes a file whose `ownerDigest` is not its own, and concurrent creates
  dedupe by re-querying before first write. **The folder is reconciled, not
  assumed unique:** lookup-then-create is not atomic on Drive, so two devices
  can both create one — every creator re-lists, adopts the deterministic winner
  (lowest folder id) and discards its own if it lost and is still empty;
  objects are always found by `appProperties`, never by parent, so a
  stray folder never hides a doc. **Cannot read each other:** contents are AEAD
  ciphertext under different K_c, and even a renamed or copied file fails
  decryption because `accountBinding`/`vaultId`/`docId` sit in the AAD (§5);
  names and appProperties are digests, so no emails, vault names or portfolio
  hints are visible to a co-user. **Bounded paged lookup:** `docId` stays out
  of `appProperties`, so every document sharing (`ownerDigest`, `vaultDigest`,
  `docKind`) shares one list address; the resolution is pagination, not a new
  `docDigest` field — 100 objects per page, at most **1,000 candidate objects
  per address** (`DRIVE_LIST_PAGE_SIZE`, `DRIVE_ADDRESS_OBJECT_LIMIT`), every
  page read before declaring a document
  absent, and a repeated page token or over-ceiling address fails closed.
  **Residual shared-Drive denial of service (accepted, manual remedy):** a
  co-tenant can create an app-owned file carrying another user's digests and a
  copied plaintext header with a higher `docVersion`; AEAD still prevents them
  reading or clobbering the real document, but the forged candidate can wedge
  that address. This design **does not claim DoS resistance against a co-tenant
  of the same Drive** — the remedy is to remove the forged candidate from the
  visible folder (or Drive trash) and retry sync.

- The mobile PLATFORM_ASKS v2 addendum for this naming contract is **not
  written** — E5 closed without it and no issue tracks it.

## 9. Portfolio move-in

Move-in = capture → encrypt → verify → destructive commit
(`services/account/portfolioVaultTransitionService.ts`,
`apps/web/src/user/vault/portfolioMoveCapture.ts`):

1. **Preconditions**, server-checked with one code each: the
   vault exists and its media are verified-live (`VAULT_MEDIA_NOT_VERIFIED`),
   the portfolio holds no active mirrorchain membership
   (`PORTFOLIO_VAULT_ACTIVE_MIRRORCHAIN` — leave-with-fork first;
   `docs/mirrorchain-design.md` §14 keeps the other side), and no in-flight
   import or export touches it (`PORTFOLIO_VAULT_PENDING_{IMPORT,EXPORT}`).
2. **Capture with a portfolio-scoped CAS token:** `GET
/portfolios/:id/vault/revision` is an opaque digest over exactly the
   portfolio's restorable `vault`-classified rows (`purge`-only tables excluded
   for the spurious-conflict reason recorded in `manifest.ts`). The client
   reads the token FIRST, pulls the dataset through the existing read APIs,
   re-reads the token, and accepts only when the pair agrees — capture reads
   still write (tax self-heal, seeded defaults), so capture must validate
   before it accepts. One rebuild on mismatch, then
   `VAULT_MOVE_CAPTURE_UNSTABLE`. The same response carries
   `importBatchCount`; a portfolio with any historical import batch is refused
   at capture today (`VAULT_MOVE_IMPORT_HISTORY_UNSUPPORTED`; lifting it is
   #1529).
3. **Encrypt + verify:** the portfolio doc is written to every vault medium,
   the common doc folds in that portfolio's custom-asset snapshots and fork
   provenance, the header roster gains the portfolio — each write CAS'd and
   round-trip verified (§7 rule 1).
4. **Destructive commit:** `POST /portfolios/:id/vault/move-in` with body
   `{ vaultId, docVersion, portfolioDataRevision, stepUp }`
   (`portfolioVaultMoveInRequestSchema`; §15). One account-locked transaction
   (`FOR UPDATE`): re-verify preconditions + the revision
   token → hard-delete every `vault`-classified row keyed to the portfolio →
   destroy its `purge`-classified rows → revoke every share, audience entry,
   comment, follow and public-profile inclusion OF THAT PORTFOLIO
   (`portfolioVaultTransitionRepository`) → set `vault_id` + `vault_alias` on
   the stub → zero-cleartext probe over the classified set
   (`vaultedPortfolioProbe`). A replay returns `idempotent: true` rather
   than destroying gated state.

**What happens to each attached thing, explicitly:**

| Thing                                                                   | On move-in                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Transactions, dividends, cash sources + movements, history              | Into the portfolio doc; server rows hard-deleted; client engine re-derives all series                                      |
| Snapshots / derived rows                                                | Purged, never carried (re-derived on move-out)                                                                             |
| Tax settlement rows for the portfolio                                   | Into the doc; cross-portfolio tax composes per §14                                                                         |
| Standing orders + run ledger                                            | Into the doc; client materializes due rows with deterministic UUIDv5 occurrence ids                                        |
| Existing shares / audiences / public-profile inclusion of the portfolio | Revoked permanently; NOT restored on move-out (the #730/#992 rule, portfolio-scoped)                                       |
| Price alerts                                                            | Untouched — asset-level rows, zero portfolio reference; nothing to kill                                                    |
| Conglomerates / workboard                                               | Untouched — baskets reference `asset_identities`, not portfolios; custom-asset claims survive via the tombstone/claim seam |
| Home board widgets scoped to it                                         | Render through the `PortfolioStore` seam: live when unlocked, a locked-state tile with the unlock affordance otherwise     |
| Imports in flight                                                       | Precondition-blocked; a portfolio with historical import batches is refused at capture (#1529)                             |

### 9a. Legacy `country_specific` rows with no frozen country (#1635)

Rows settled before `drizzle/0021_tax_engine.sql` can carry
`tax_mode = 'country_specific'` with `tax_country = NULL` — the migration added
the column and never backfilled it. **Server-side this is not ambiguous:**
`frozenTaxCountryEngine(null)` settles it as **AT** (the `rowEngineCountry`
legacy rule), and the #1512 shared row-engine classifier and its committed
vectors pin that reading. Nothing in this section changes it.

The vault side cannot inherit that fallback. A vault document is the only
remaining copy of the row, so `assertProvenTaxFacts` (capture), the strict
restore contract, the server's rehydration validator and the client snapshot
gate (`engine/session.ts validateFrozenTaxShape`) all require a country
whenever the mode is `country_specific`: a mode without its country cannot be
re-settled the same way twice by construction. A portfolio holding such a row
therefore **cannot move in**, and the refusal is typed —
`VAULT_MOVE_LEGACY_TAX_FACTS_UNSUPPORTED`, naming the offending rows, raised
before a single ciphertext write — not the untyped row-schema `Error` it used
to be.

**Migration path (recommended, not yet shipped):** a one-off backfill
migration

```sql
UPDATE transactions SET tax_country = 'AT'
  WHERE tax_mode = 'country_specific' AND tax_country IS NULL;
UPDATE dividends    SET tax_country = 'AT'
  WHERE tax_mode = 'country_specific' AND tax_country IS NULL;
```

writing down exactly what the engine already reads. One source of truth, no
settlement change, and the refusal above then has nothing left to reject. The
rejected alternative was the capture rewriting the frozen fact to `AT` on the
way in: capture must carry what the server holds byte for byte, or move-out
cannot restore it, and a second place that decides what a frozen fact means is
precisely the drift this section exists to prevent. Rows in any other mode
(`none`, `manual_per_trade`, `custom`) legitimately carry a null country and
are untouched by either the refusal or the backfill.

## 10. Portfolio move-out (the designed exit)

"Deleting them as a public portfolio" makes move-in reversible **only via a
device holding the phrase**, so the exit is designed exactly there. From an
unlocked endpoint, `POST /portfolios/:id/vault/move-out` (challenge first)
streams the strict restore document for that portfolio — catalog-asset
snapshots dropped and re-resolved, own-manual-asset restatement, retained
identities accounted for, fork-provenance validation, solvency validation per
the #865 option-B rule (`PORTFOLIO_VAULT_RESTORE_INSOLVENT`) — plus the §15
step-up. One account-locked transaction: rows re-created through the normal
services in dependency order **under the SAME portfolio UUID** (the stub is the
identity anchor), `vault_id`/`vault_alias` cleared
(`portfolioVaultTransitionRepository`), the portfolio doc removed from
the server medium into bounded history, the header roster updated; after commit
the deterministic plan rebuilds snapshots and invalidates derived consumers.
The client then tombstones the portfolio doc, syncs, and best-effort deletes
the doc's Drive file. Payload ceiling per the factor rule
(`PARANOID_RESTORE_PLAINTEXT_FACTOR = 8`, `http/bodyLimits.ts`).
Idempotent-resumable. Shares are not restored; the vault keeps existing
(possibly empty). Move-out is also the account's escape hatch: unlike v1's
all-or-nothing disable, a user can exit one portfolio while others stay
vaulted.

## 11. The per-portfolio feature-kill matrix + the full-functionality proof

**The account keeps everything.** Profile, friends, chat, comments/reactions,
watchlists, conglomerates + backtests, alerts, notifications, API keys/OAuth
grants, imports, mirrorchain, expense tracking, the Home board — and the FULL
feature set of every non-vaulted portfolio, including sharing them and reading
them over bearer scopes. This permanently fixes the class of bug where owning
any vault killed cash-on-mobile for the whole account.

The account-wide kill rail is **demoted, not yet deleted**: the `PARANOID_MODE`
refusal (`http/middleware/bearerAuth.ts`) now fires only for a live v1
account whose durable `users.privacy_mode` is still `paranoid`, and
`MeResponse.privacyMode` (`packages/contracts/src/auth.ts`) is
`@deprecated` and documented as not a vault signal. Both die with the §17 wipe
and the §19 train; a vault's own signal is `vaultId` on portfolio rows plus the
narrow `GET /vaults` projection.

**Killed for a VAULTED portfolio** — each enforced server-side at the portfolio
boundary with one stable error code, `VAULTED_PORTFOLIO`
(`services/account/vaultedPortfolioGuard.ts`); hidden client-side as absent
affordances; every row covered by the matrix test:

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
   stays valid account-wide.** `vault:sync` remains the ciphertext path.
6. Mirrorchain: cannot create/join/be invited while vaulted; mutual exclusion
   is portfolio-scoped.
7. Webhooks: no portfolio-content events for it (nothing server-side to fire).

**Proof strategy (the acceptance backbone).** The enforcement inventory +
completeness harness (`services/account/paranoidEnforcement.ts`;
`paranoidEnforcementCompleteness.test.ts` — every mounted route, callable
context method and registered job must carry exactly one policy) is keyed
portfolio-first as `{ vaulted, siblingPlain, vaultFree, allowedParity }`, so
the kill matrix is DERIVED from the registry, never hand-listed twice. After
move-in a per-portfolio zero-cleartext probe iterates
`PARANOID_PURGED_TABLE_NAMES` and proves zero rows. The headline test is the
full-functionality regression: an account owning a vaulted portfolio exercises
the COMPLETE feature surface against a plain portfolio — sharing it, server
stats, bearer `cash:write`, imports, a mirrorchain membership, expense pages —
byte-identical to a vault-free account
(`__tests__/vaultedPortfolioFullFunctionality.test.ts`), with `usage_events`
capture suppressed only for vaulted-portfolio-driven reads. **Discreet mode is
untouched** and is not part of this arc's diff.

## 12. Device custody — password, plain storage, lockout

**The endpoint keystore** (IndexedDB / platform storage; no server table —
`apps/web/src/user/vault/keystore/`): per stored phrase an entry
`{ vaultId, custody: 'wrapped' | 'plain', payload }` (`keystore/types.ts`).

- **Wrapped (default):** ONE device password per endpoint, never per-vault
  passwords. Argon2id(password, per-endpoint salt; m = 64 MiB, t = 3, p = 1) →
  K_dev (`keystore/deviceCrypto#deriveDeviceKey`); each stored mnemonic
  entropy is
  AES-256-GCM-wrapped under K_dev, and a wrap-check value verifies entry
  (`keystore/deviceCrypto.ts`). Entering it once per session unlocks ALL
  wrapped phrases on that endpoint.
- **What a session is, and what ends it (binding; amended by the owner
  2026-09-03):** the password, the mnemonic entropy and every K_c exist only in
  volatile process memory and are never written anywhere. A **session belongs
  to the device** and ends at: an explicit "Lock vaults" action, sign-out, an
  account switch on the same profile, the existing PIN idle-lock timer when the
  user has PIN lock on (one timer, one mental model — no second setting), or
  the absolute lifetime below. After any of these, the next vault read prompts
  again. **A reload, a closed tab or an OAuth round-trip does NOT end it** — the
  owner ruled on 2026-09-03 that a vault must stay unlocked "for the rest of
  the session" and never re-lock because a sub-page was opened. To make that
  true across full page loads, K_dev is kept on the device as a
  **non-extractable AES-256-GCM `CryptoKey`** in a dedicated IndexedDB
  (`keystore/sessionPersistence.ts`, `bettertrack-paranoid-session-v1`,
  keyed by account) — the same shape the cross-tab channel already carries: a
  handle that can decrypt but whose bytes no script on this origin can read
  out. The record expires `ENDPOINT_SESSION_PERSISTENCE_TTL_MS` (7 days) after
  the unlock that created it; every user-intended lock writes the §12
  device-locked marker synchronously FIRST and then deletes the record, and the
  resume path refuses a persisted key while the marker is set and installs one
  only after the wrap-check proves it was derived from this endpoint's
  password. There is still NO "keep unlocked" checkbox — the device session is
  the default and the only mode; the convenience path without any password
  remains plain custody, below. v1's persisted-VK `custody.ts` keep-unlocked
  stays retired.
  Shipped: the device key is a private field zeroed by `clearSessionSecrets()`
  (`keystore/core.ts`), the keystore's own IndexedDB holds only KDF
  parameters, the wrap-check and lockout metadata (`keystore/storage.ts`), and
  the session record holds only the CryptoKey handle plus its expiry.
  `keystore/runtime.ts` binds `bindToVaultLockSignal()` for the app singleton,
  so sign-out, an account switch and the PIN idle lock reach the endpoint
  keystore; `ui/useEndpointVaultLock.ts` ships the "Lock vault" control in the
  account menu and in the shield chip's popover.
- **A session belongs to the ENDPOINT, not to one tab (ruled 2026-09-01, §16;
  binding).** "Unlocks ALL wrapped phrases on that endpoint" is read the way it
  is written: an endpoint is a device. A newly opened tab therefore asks the
  account's other same-origin tabs for the live session on an account-scoped
  `BroadcastChannel` (`keystore/sessionChannel.ts`), and a tab that holds one
  answers with K_dev imported as a NON-EXTRACTABLE `CryptoKey` —
  structured-cloneable between same-origin contexts, with non-extractability
  surviving the clone. This writes nothing anywhere, so the clause above is
  untouched: the session still dies when the LAST tab of the device closes, and
  "tab/app close" ends it exactly when there is no other tab left to hold it.
  Nothing but K_dev crosses; the receiver re-derives entropy and K_c from its
  own keystore and installs the session only after the wrap-check proves the key
  belongs to this endpoint's password. A lock in any tab (manual, sign-out, PIN
  idle) revokes the session in every tab. Persisting K_dev to survive a full
  close was retired with PR #1604 and **revived by the owner's 2026-09-03
  amendment above** — the persisted record is the second source the resume
  path consults, after a sibling tab, and under the same verification.
- **Plain (the warned option):** the mnemonic entropy sits unwrapped and the
  vault opens without any prompt. Choosing it requires the friction ladder's
  strong rung — an explicit acknowledgment that a compromised end device
  exposes the phrase outright, and that the protection is then ONLY "encrypted
  and unreadable for BetterTrack" (`ui/VaultCreationCeremony.tsx:266`,
  `ui/VaultReceivePhrase.tsx:385`). Default is always wrapped; the toggle is
  per stored phrase and changeable both ways. On platforms with native custody
  (Android Keystore / iOS keychain) "plain" still means "not protected by the
  device password" — the platform baseline applies underneath.
- **Wrong password / lockout:** verification is local (wrap-check,
  `keystore/core.ts`). Failures escalate a client-side delay — 5 wrong → 30 s,
  doubling, capped at 5 min — and there is no server
  lockout because the server is not involved. The prompt always offers "Forgot
  the password?" → **keystore reset**: wipes the stored phrases
  on THIS endpoint only, loses NO data (the phrases re-enter by typing or §13
  QR from another device), and says exactly that in one sentence.
- **Vault states and their affordances (binding — a state without a next action
  is a design bug;** the recorded v2 anti-pattern was a locked vault with no
  unlock path): stored+wrapped → "Unlock" (password); stored+plain → opens
  silently; not-on-this-endpoint → "Enter words / Scan QR from another device".
  Every surface that renders a vault or locked stub carries its state's action
  inline. The map is total and compile-checked (`vaultStateAffordance.ts`);
  the QR-receiver half is still deferred at runtime (`ui/VaultManager.tsx:77`).
  **The action is performed where the user stands (owner, 2026-09-03):** the
  locked stub's "Unlock" and "Enter recovery words" are in-place dialogs
  (`ui/VaultUnlockDialog.tsx`, `ui/VaultProvidePhraseDialog.tsx`) that never
  navigate; only the settings-sized acts (reset this device, storage, rename,
  start fresh) link into the vault manager. And a vault that is UNLOCKED but
  whose portfolio cannot be opened is never rendered as "locked": the loader
  surfaces the typed failure (`useVaultedPortfolioStores` → `failures`) and the
  stub says so, with Retry — a swallowed resolver error used to paint a
  "Locked" badge with an "Open" link after a successful unlock.

## 13. QR seed-phrase transfer

The owner wants a scan that instantly moves the phrase to the phone, designed
safely rather than refused. **The normative wire contract lives in
`docs/vault-qr-contract.md`** — extracted verbatim from this section on
2026-09-02 because a third client must be buildable from it alone. That file is
the tie-breaker for every rule; nothing below narrows it.

In summary: the sender needs a live unlock plus, for wrapped custody, a fresh
password entry (the QR shows the master secret, so displaying it is a step-up
act), and the code is full-screen, banner-warned, 60-second-expiring,
clipboard-free and never transmitted over any network — display→camera is the
whole channel. The payload is `btvault<N>:m=<words>&v=<vaultId>[&n=<name>][&f=<fingerprint>]`,
a scheme-plus-query that every client decodes itself rather than through a
platform URL type, carrying the 12 BIP39 words themselves so the checksum rides
in the payload. Parsing answers exactly one of a **frozen twelve-outcome
vocabulary** and no client may widen, narrow or invent an outcome. The receiver
validates the checksum, then performs a **verified open** — fetch the vault
header from any reachable medium, unwrap it with the phrase-derived key, and
compare the fingerprint BEFORE saving to the keystore, so a mis-scan can never
store dead words. Custody choice follows §12 (wrapped default, plain behind the
warning). Manual word entry remains the fallback everywhere the QR is offered.

## 14. Client engine & cross-portfolio composition

- The pure domain layer stays isomorphic in `packages/domain` — money math is
  NEVER reimplemented client-side (review-blocking rule, unchanged). The client
  engine (`apps/web/src/user/vault/engine/`, `vaultPortfolioStore.ts`) runs on
  per-vault portfolio docs: holdings + valuation, daily value/cost/P&L series
  with domain carry-forward, TWR (`vaultClientTwrParity.test.ts` stays the
  parity harness), allocation, cash balances, per-year tax through `tax.ts`.
- **Cross-portfolio composition (mixed accounts are the norm):** every
  cross-portfolio quantity is a client-side merge of server-computed plain
  figures and client-computed vaulted figures, merged at the figure level the
  domain engine defines — never by re-implementing offset rules in view code.
  `composePortfolioFigures` is wired into the Home board (`home/homeData.ts`);
  AT/DE cross-portfolio tax (`engine/composition#composeCountryTaxYear`,
  Verlustausgleich spans portfolios) is **built and tested but has no
  production caller yet** — planned with the remaining store-seam routing
  (#1599). The living-tax-year marker (the 2026-08-19 §16 row that removed
  year locking, superseding the 2026-08-07 lock ritual) applies identically to
  a composed year: every Vienna year stays mutable and recomputes live.
- **Locked honesty:** while any involved vault is locked, aggregate views
  render **sum-of-visible plus a mandatory lock qualifier** ("+ N locked
  portfolios") — never a bare total, never a silently-partial figure. Enforced
  by construction: `QualifiedPortfolioFigure` cannot exist without its coverage
  qualifier, and a scope with zero readable members returns
  `UnavailableComposition` instead (`engine/composition.ts`).
- `PortfolioStore` resolves per portfolio (`portfolioStoreResolver.ts`):
  `apiPortfolioStore` for plain rows, `vaultPortfolioStore` for vaulted ones —
  same pages, same components, which is why an unlocked vaulted portfolio is
  indistinguishable day-to-day. Only the overview tab routes at the seam so far
  (#1599).
- **The sync-status indicator is an explicit KEEPER — look unchanged, data
  source generalized.** Owner, verbatim (2026-08-19): "i like the 'synched' UI
  up top with the current paranoid mode. its really cool design stuff." Its
  visual design is NOT redesigned; what generalizes is the projection beneath
  it. With N vaults on different media the chip renders one **aggregate
  state** — `all synced ✓` / `syncing` / `locked (N)` / `attention: <name>` —
  as the worst state across vaults (attention > syncing > locked > synced,
  `media/status#projectVaultMediaSyncStatus`), and its popover gains one row
  per vault (state,
  per-medium detail, last-write time, the state's §12 affordance inline). One
  chip, never one per vault. `DirectoryVaultSyncChip` ships
  (`ui/VaultSyncChip.tsx`, mounted in `components/OriginShell.tsx`); the
  account-singleton `LegacyVaultSyncChip` is mounted beside it until §19.

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
- **The credential rides IN the request body** — `{ password?, code?,
recoveryCode? }`, at least one required via schema `.refine`
  (`vaultStepUpCredentialSchema`), mirroring
  `deleteAccountRequestSchema`. It is verified inside the same account lock as
  the transition (no check-then-act race); failure rides the progressive
  per-account throttle plus an audit record with generic error text. The
  in-body credential replaces CSRF + same-origin on the bearer path.
- **Both paths, same rule:** the web wizard sends it too; a bearer path is
  never stricter or looser than the browser path. Bearer reachability follows
  the owner's 2026-08-17 shared-control-layer ruling under `account:security`,
  default-closed via the method-aware allowlist (`bearerAuth.ts`), with the
  #1326 acceptance battery (wrong-credential = nothing purged,
  INSUFFICIENT_SCOPE naming the scope, unknown-future-route canary) inherited
  as this arc's tests.

**Shipped today: three of the five.** Move-in, move-out
(`portfolioVaultTransitionService`) and vault deletion (`vaultService`) verify
the in-body credential. **Drive disconnect-with-loss takes only the
`acknowledgeBound` query flag and no step-up** (`vaultRoutes`, the
`drive-connections` DELETE handler) — tracked as **#1632**. The §17 commit is
not a gap: the wipe has **no HTTP route at all** (§17), so there is no request
for a credential to ride in; it is owner-run from a shell behind the recorded
backup attestation.

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

**The ordering ruling that shipped it** (PROJECTPLAN §16, 2026-08-29, PR #1559
— ruling verbatim, rationale summarised). Step 2's "one migration retires the
account-level rows" is implemented as
**migration-ships-the-gate + service-side, owner-triggered destruction.**
Migration `0102_paranoid_v1_transition` creates the attestation gate, the
wipe-receipt table and the seven `zz_paranoid_v1_backup_*` quarantine mirrors,
and wipes nobody; `paranoidV1WipeService` performs the retirement per account
behind that gate once the owner-run `scripts/ops/export-paranoid-v1-backup.mjs`
has recorded a verified, offsite-confirmed attestation. The wipe is reachable
from no HTTP route and no job. Merge is deploy, so a migration body runs
unattended the instant a PR lands — putting the wipe there would execute the
destructive step BEFORE the backup step 1 makes its precondition, the exact
inversion the (C) ruling forbids. The row's second ruling: an account the wipe
has already retired is REFUSED by the v1 enable path (`PARANOID_LEGACY_WIPED`, 409) — a targeted per-account refusal, NOT a retirement of the enable route,
which §19 keeps alive until the end of §17 for un-wiped stragglers.

**Status: not executed.** The machinery shipped with E9 (#1419) and the
three-step owner runbook lives in `docs/ops.md` ("Retiring the account-level
(v1) paranoid surface — §17"), but it has not been run on production, so every
v1 account, table and route is still live. The fresh-start notice rides the
session payload (`paranoidFreshStartPending`,
`packages/contracts/src/auth.ts`) and is acknowledged once via
`POST /auth/fresh-start-notice/acknowledge`. The evidence analysis behind the
(C) choice and the two alternatives that were considered and not built are
archived in `docs/history/paranoid-design-history.md` §B.

## 18. Interplay: exports, deletion, admin, mirrorchain, autonomy seams

- **Account export:** the zip carries `server`-classified data plus — for
  vaults whose media include `server` — the ciphertext docs and manifest
  entries; never cleartext vaulted content, never key material (phrases and the
  endpoint keystore never export). The client-side cleartext export of an
  unlocked vault's portfolios stays the user's own exit.
- **Account deletion (V4-P2c):** the sweep deletes `vaults`, `vault_blobs`,
  history/retirement rows and `drive_connections`; Drive files get best-effort
  client deletion when the deletion runs from a reachable device, otherwise
  they remain the user's own ciphertext in their own Drive (the confirm says
  so, and app access is revocable at Google).
- **Admin:** per-user view shows vault count, per-vault media + doc
  sizes/versions/timestamps, the legacy-wiped marker (§17) and Drive-connection
  count — no portfolio numbers to show, which is the feature. Admin can never
  reset a phrase or device password, never read a doc, never restore wiped data.
- **Mirrorchain:** mutual exclusion is portfolio-scoped (§9 precondition, §11
  item 6); severed-fork provenance rides the owning vault's common doc with the
  v1 capture/merge/prune/validate discipline intact.
- **Autonomy seams (binding beyond paranoid, unchanged):** `PortfolioStore`,
  `DataHome` and `MarketDataSource` stay the three binding interfaces; the
  future phone-local-only medium (the ruling's "leave that out for now")
  arrives as a `localDataHome`-backed medium through the same seam — reserved
  in the contract enum, rejected by the server, designed nowhere else yet.

## 19. What changes and what dies in the live codebase

**Stays (proven substrate, re-keyed not rewritten):** the envelope crypto + AAD
discipline (`envelope.ts`, `crypto.ts`, `hkdf.ts`, `keys/keyCore.ts`), the
CAS/merge engine (`merge.ts`, `sync.ts`), the media runtime +
retirement/signed-purge machinery (`media/`, per vault), the Drive transport +
GIS client (`drive/`), the sync-status indicator (§14), the client engine +
store seam (`engine/`, `vaultPortfolioStore.ts`), `packages/domain`, the
classification axes + completeness tests, the enforcement inventory harness,
the `asset_identities` seam, `limiters.vault`, the `vault:sync` scope.
**Discreet mode: untouched.**

**Dies at the end of §17 (not before) — the deletion train is PENDING, and
every item below is still ALIVE at HEAD because §17 has not been run:** the
account-level enable/disable pipeline (`paranoidTransitionService`, `POST
/account/paranoid/enable|disable`, `fork-provenance`, `normal-revision` —
`accountRoutes.ts`), the account-singleton document and its store
(`paranoid_vaults`, `paranoid_vault_history`, `paranoid_enable_transitions`,
`paranoid_vault_server_candidates`, `paranoid_vault_retirements`,
`paranoid_vault_retired`, `paranoid_rehydration_receipts` —
all still exported from `schema.ts`; `GET/PUT /vault` and the `/vault/media*`
account family in `vaultRoutes.ts`), `users.privacy_mode` + the paranoid media
columns + the `users_paranoid_media_state` CHECK, the account-wide
`PARANOID_MODE` kill rail (`bearerAuth.ts`), `MeResponse.privacyMode` as a
mode signal, the v1 app-wide unlock gate (`VaultUnlockGate.tsx`), the
account-level wizard (`ParanoidEnableWizard.tsx`) + recovery-kit flow
(`recovery.ts`), and v1's persisted-VK "keep unlocked" custody (`custody.ts`).
Drops ship as append-only migrations after an owner-authorized external
ciphertext backup for any straggler accounts (§17); the
`zz_paranoid_v1_backup_*` quarantine is dropped by the same train, never by
hand (`docs/ops.md`). The transition-era list of documents to rewrite is
archived in `docs/history/paranoid-design-history.md` §C.

## 20. Build decomposition (epics, ordered)

E0–E10 are all merged; the table, its scope sketches and its per-epic outcome
are archived in `docs/history/paranoid-design-history.md` §D. What remains open
is named in place above: Drive provisioning (§8), the media-switcher and
Drive-migration wiring (§7), session-end wiring (§12), store-seam routing and
tax composition (§14, #1599), the disconnect step-up (§15), and the §19 train.

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
