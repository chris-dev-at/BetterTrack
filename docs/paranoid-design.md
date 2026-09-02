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

Glossary: _vault_ = one storage config + one seed phrase + the encrypted doc
set of its member portfolios; _doc_ = one encrypted blob of that set (header /
common / one per portfolio); _medium_ = a place docs sync to (server / a Drive
connection); _Drive connection_ = one separately-OAuth'd Google account usable
as a medium, N per account; _move-in / move-out_ = a portfolio entering or
leaving a vault; _endpoint_ = one installed client; _endpoint keystore_ = the
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
ruling's own words. Knowing THAT a vault exists, where it stores and WHICH
portfolios are inside is required to enforce §11 and render locked stubs; it is
not portfolio content. What the server can never do is read a doc.

Shipped in `apps/api/src/data/schema.ts` (migration `0091_paranoid_vaults_keystone`):

- **`vaults`** (`:4163`) — `id`, `user_id`, `name` (cleartext by design: it is
  config and the UI needs it while locked), `media`, `drive_connection_id`,
  `retirement_proof_public_key` (the per-vault Ed25519 purge verifier, §7),
  `key_fingerprint` (a non-secret HKDF tag of K_c that lets a client confirm
  "these words open THIS vault" before destructive steps, §4),
  `header_doc_id`/`common_doc_id`, `retirement_generation`, `media_attested_at` plus
  `media_attested_drive_connection_id` (§7 consequence 3). One CHECK carries
  the whole media contract (`vaults_media_state`, `:4250`): the set is exactly
  `{server}`, `{drive}` or `{server,drive}` — non-empty and duplicate-free by
  enumeration, `local` refused at the deepest boundary, drive ⇔ connection
  binding as its second half. `local` is RESERVED in the contract enum
  (`packages/contracts/src/vaults.ts:113`), rejected as `reserved_medium`.
- **`vault_blobs`** (`:4304`) — `(vault_id, doc_id)` PK, `doc_kind`
  (`header`|`common`|`portfolio`), `portfolio_id` (set iff `portfolio`,
  CHECK-pinned equal to `doc_id`), `version` (the per-doc CAS token),
  `format_version`, `size_bytes`, `blob` (bytea, never interpreted past the
  envelope header). Caps per kind — header 1 MiB, common 4 MiB, portfolio 8 MiB
  (`BT_VAULT_MAX_BYTES_*`).
- **`vault_blob_history`** (`:4376`), **`vault_server_candidates`** (`:4404`)
  and **`vault_retired`** (`:4472`) are per doc; **`vault_retirements`**
  (`:4452`) is keyed by `vault_id` ALONE — one record per vault. Bounded
  history (10 versions / 30 days) is the bad-write safety net; the retirement
  set + signed purge gate (§7) carry over per vault.
- **`drive_connections`** (`:4132`, §8) — `google_sub` is unique per user, not
  globally: two users may connect the same Google account.
- **`portfolios.vault_id`** (`:1383`) + **`vault_alias`** (`:1386`, the locked-
  row label; the true name travels inside the ciphertext). NULL ⇒ normal
  portfolio, today's behavior byte-for-byte; NOT NULL ⇒ the locked stub: zero
  content rows (probed), only identity + alias + membership. The stub exists
  for (a) enforcement keying, (b) same-UUID move-out, (c) rendering "N locked
  portfolios" and the unlock affordance.

**Mounted routes** under `/api/v1` — `http/routes/vaultRoutes.ts`: `GET`/`POST
/vaults` and `GET`/`PATCH`/`DELETE /vaults/:vaultId` (`:847`–`:924`);
`GET`/`PUT /vaults/:vaultId/docs/:docId` + `/history[/:version]`
(`:958`–`:1069`); `GET`/`PATCH /vaults/:vaultId/media` (`:1086`); `PUT
/vaults/:vaultId/media/server-candidate/:transitionId/docs/:docId` (`:1166`)
and its `GET` readback (`:1219`); `POST /vaults/:vaultId/media/retired/purge`
and `/challenge` (`:1249`); the `drive-connections` family (`:755`–`:791`).
`portfolioRoutes.ts`: `GET /portfolios/:id/vault/{revision,lifecycle}`
(`:189`/`:210`), `POST /portfolios/:id/vault/move-in` and
`move-out[/challenge]` (`:226`–`:276`). `DELETE /vaults/:vaultId` refuses while
a portfolio references the vault (`VAULT_REFERENCED_BY_PORTFOLIO`) or a
retirement is pending (`VAULT_RETIREMENT_PENDING`); doc GET/PUT are
ETag/`If-Match` CAS and answer 428 `VAULT_PRECONDITION_REQUIRED` with no
precondition.

**Deliberately NOT a server fact:** seed phrases, the endpoint keystore, the
device password, unlock state, and which endpoints hold which phrases. There is
no server table for endpoint custody, ever. `users.privacy_mode` and the
account-level media columns (`:230`–`:264`) retire at the end of §17; until
then they serve the live accounts.

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

Every literal is a contract constant (`packages/contracts/src/vaults.ts:67`–`:77`),
implemented in `apps/web/src/user/vault/keys/keyCore.ts` (HKDF `:52`,
fingerprint `:182`, account binding `:271`) over `@scure/bip39`.

**Binding `seed-v1` key-slot wire contract for phone unwrap:** wrap the random
32-byte `K_c` with AES-256-GCM under `K_wrap`, fresh 12-byte IV, UTF-8 AAD
exactly `bettertrack-vault-key-slot-v1:${vaultId}:${keyId}`. `wrappedKc` is
unpadded base64url of `IV || ciphertext || 16-byte GCM tag` (WebCrypto's
ciphertext already carries the tag); a consumer MUST read this layout
byte-for-byte and fail closed on malformed length or authentication
(`keyCore.ts:30`, `:94`, `:139`).

Notes, each deliberate: **no Argon2id on the mnemonic** — stretching defends
low-entropy human secrets, a 128-bit random mnemonic needs none, and the
standard PBKDF2 step keeps us vector-compatible with every BIP39 tool; Argon2id
stays exactly where a human secret exists, the §12 device password. The
**`keySlots[]` indirection stays** (header-carried): K_c is random and wrapped
by K_wrap, which is what makes rotation and any far-future sharing possible
without re-issuing words. The phrase is **per vault** — two vaults never share
key material, and the `vaultId` in the HKDF info domain-separates even a
re-used mnemonic (which the UI never offers). **Rotation** re-encrypts under
fresh words (new mnemonic → new K_wrap → new K_c → full doc-set re-encrypt +
verified round trips + history invalidation), offered in vault settings, never
forced; there is no "change phrase but keep K_c" path, because if the words
leaked K_c must go too — **planned, not built.** The v1 recovery kit (raw-VK
download) is RETIRED by ruling: the phrase is the sole credential and the
write-it-down ceremony replaces the kit, one credential and one mental model.
The v1 kit itself still ships for live account-level accounts until §17 runs.

## 5. Blob format + versioning (envelope v2, the per-vault doc set)

**One envelope format for every medium**, evolved from the shipped `BTVAULT1`
(`packages/contracts/src/vault.ts`, `apps/web/src/user/vault/envelope.ts`).
What it got right is kept: magic + 4-byte header length + cleartext JSON header
then ciphertext; the **full serialized header bound as AES-GCM AAD** so any header
tamper (version rollback included) fails decryption; deflate before encryption;
strict fail-closed versioning.

**Envelope v2 header** — cleartext, counters/ids/crypto parameters only, never
portfolio information (`packages/contracts/src/vaults.ts:463`, `.strict()`):

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
six-field projection `vaultDocServerHeaderSchema` (`vaults.ts:494`).

**The doc set.** The **`header` doc** carries vault metadata under encryption
(true name, member roster, keySlots echo, creation record, the §8
`driveConnection` identity echo). The **`common` doc** carries account-scoped
material the vault's portfolios reference: the custom-asset bucket with the v1
snapshot/tombstone/strict-restore-narrowing semantics and the
`asset_identities` claim seam, severed-fork mirrorchain provenance, the
retirement-proof Ed25519 private key (`vaults.ts:744`), mergeLog. One
**`portfolio` doc per member** carries every `vault`-classified row of that
portfolio — transactions, dividends, cash sources + movements, per-portfolio
settings, tax settlement rows, standing-order definitions + the
`standing_order_runs` exactly-once ledger, import batches/rows, scoped expense
rows; snapshots stay derived-and-purged, never carried. Per-doc granularity is
what makes move-in/move-out incremental, keeps the size caps honest, and lets
two devices editing two different portfolios not conflict at all.

**Payload document rules carried from v1:** uuidv7 entity ids, per-entity
monotonic `rev` + `editedAt` + writing `deviceId`, tombstones kept ≥ 180 days,
pure `v(n)→v(n+1)` schema migrations on load, NEWER-version docs go read-only
with an "update the app" notice — never best-effort parsed.

**Three classification axes, all CI-gated** (`services/export/manifest.ts`).
Every Drizzle table classifies `vault` | `server` | `purge` (`:471`) and CI
fails on an unclassified table. Two more ride alongside, neither hand-listed in
that map: the **doc bucket** (`PARANOID_VAULT_DOC_BUCKETS`, `:759`, derived
from `VAULT_TABLE_ENTITY_KINDS` × `VAULT_ENTITY_DOC_BUCKETS` —
portfolio-scoped → portfolio doc, account-scoped-but-vault-referenced → common
doc) and the **rehydration policy** (`:424` — `restore(entity)` vs
`purge-only`). `PARANOID_PURGED_TABLE_NAMES` and `PARANOID_PURGE_REASONS`
(`:454`, membership pinned in `paranoidClassification.test.ts`) are
portfolio-scoped — `usage_events` capture suppression keys on "does the request
target a vaulted portfolio / does the account own any vault" for the client
engine's quote reads (the #1344 holdings-roster leak must not reopen per
portfolio).

## 6. Sync, CAS and the merge protocol

The v1 storage protocol carries over **per doc**:

- **Server medium:** ETag/`If-Match` CAS per `(vaultId, docId)` — the HTTP
  precondition is the entire server-side CAS decision
  (`vaultBlobRepository.ts:860`), and `docVersion` is never version-gated. 412
  `VAULT_PRECONDITION_FAILED` on mismatch, a distinct terminal 412
  `VAULT_WRITE_ID_REPLAYED` for a replayed write, 428 with no precondition.
  Bounded history; the server reads nothing past the envelope header. Rate
  limiting is **two** families, not one: `limiters.vaultRead` for GET/HEAD
  (600/min) and `limiters.vault` for everything else (60/min)
  (`vaultRoutes.ts:841`).
- **Drive medium:** per-doc file (§8 naming), `appProperties` carrying exactly
  `{ownerDigest, vaultDigest, docKind, docVersion, formatVersion}`
  (`driveDataHome.ts:762`); CAS approximated via appProperties +
  `headRevisionId` with the accepted TOCTOU window (writers are one user's own
  devices; the merge repairs races). Drive revisions are that medium's history.
- **Local cache:** a per-endpoint encrypted cache of last-known docs — a cache,
  not a medium; the future phone-local-only medium arrives through the
  `DataHome` seam (§18), not by promoting this cache.
- **Write path:** local commit → encrypt affected docs (docVersion + 1) → CAS
  to primary (server when present, else Drive) → replicate identical bytes to
  the secondary.
- **Conflict rule (binding, unchanged):** entity granularity, never field
  granularity; higher `rev` wins → later `editedAt` → lexicographically higher
  `deviceId`; tombstone vs concurrent edit → the edit wins; merged docVersion =
  max(parents) + 1; commutative + idempotent; corrupt candidates kept for the
  restore picker, never silently discarded. Fork provenance merges by
  content-addressed union with the v1 prune-in-three-places lifecycle. As
  shipped (`vault/merge.ts:131`) the ladder resolves `rev` →
  live-beats-tombstoned → `editedAt` → `editedBy` (which IS the deviceId) → a
  canonical-JSON comparison as the total-order tiebreak the prose leaves
  implicit.
- **`vault:sync` bearer exception** (owner mandate 2026-08-04), re-keyed:
  opaque per-doc GET/PUT, both history reads, `GET /vaults/:vaultId/media` and
  the `GET /vaults[/:vaultId]` config reads (`bearerAuth.ts:42`). Destructive
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
   412 `VAULT_MEDIA_PARTIAL_SET` (`vaultBlobRepository.ts:1409`).
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

Recorded honestly against the code: for an ordinary transition the server
accepts a readback attestation of EITHER kind (`vaultBlobRepository.ts:1467`),
so "another medium holds a verified-fresh copy" is enforced strictly only in
the same-selection refresh and Drive-replacement branches (`:1332`, `:1459`).

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
`PORTFOLIO_VAULT_DOCUMENT_SET_STALE` (`packages/contracts/src/vaults.ts:1556`).
The TTL and retention floor are compile-time contract constants, not env knobs
(`VAULT_SERVER_CANDIDATE_TTL_MS` 10 min, `VAULT_RETIRED_SERVER_MIN_RETENTION_MS`
7 d — `packages/contracts/src/vault.ts:77`–`:85`); the daily sweep is
`createDataRetentionCleanupJob` (`jobs/definitions/retentionJobs.ts:60`).

Changing a vault's **Drive connection** (Y → Z) is a media migration with the
same discipline, and it starts one step earlier than a byte copy: the header
doc's §8 `driveConnection` identity echo is first rewritten to Z through the
NORMAL replicated write path — every active medium, server included — and only
then is the (now Z-naming) doc set written to Z's namespace, verified, the
binding PATCHed, and Y best-effort deleted. A byte-only copy would leave the
encrypted header naming Y, so words + the right Google login would no longer
discover the vault; and for a replicated vault the server's per-doc attestation
rows would disagree with the new Drive bytes, which is exactly what `PATCH
/vaults/:vaultId/media` verifies. Source and target must differ — a
same-connection "move" resolves both homes to one object, so the copy is
skipped as already-equal and the cleanup would then delete the only copy while
reporting success. **Built but deliberately unwired**
(`vault/media/driveMigration.ts:91`): production still composes the v1
account-scoped Drive home, and the per-vault client media switcher
(`media/mediaSwitcher.ts`) also still speaks the v1 account-level API. Wiring
belongs to E6 (#1416) / E8 (#1418).

## 8. Google Drive — separate authentication, multi-connection, collision-safe namespace

**Drive is authenticated separately from the login identity, by construction.**
A **Drive connection** is its own end-user OAuth consent to whichever Google
account the user picks in Google's chooser, decoupled from how they log in to
BetterTrack. Login with X, back up to Drive Y, put another vault on Drive Z:
supported natively.

**Not yet provisionable.** `PER_VAULT_DRIVE_PROVISIONING_AVAILABLE = false`
(`apps/web/src/user/vault/capabilities.ts:27`) — a plain constant, deliberately
not an env or feature flag, so nothing an operator can flip brings the missing
epic's code with it. `provisionVault.ts:52` refuses any `media` containing
`drive`, the create ceremony renders the option disabled and names the gap, and
`[E10-A9]` is a `test.fixme` on the same flag. The `drive_connections`
directory, the transport and the namespace discipline below all ship; the
per-vault provisioning path does not (**planned, E5 residual — no open issue
tracks it; nearest are #1597 and #1598**).

- **Connection identity.** GIS mints ephemeral tokens with no durable notion of
  "connection Y vs Z", so the client captures identity at connect time: after
  consent it calls Drive `about.get(fields=user)` with the fresh token and
  records the account's stable subject id + email (`drive/driveIdentity.ts:5`,
  `:76`). The authoritative registry is server-side **`drive_connections`** —
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
  live token (`media/driveConnectionRegistry.ts:133`), and every Drive header
  read re-checks independently (`qr/driveHeader.ts:180`).
- **Scope RULED (§21 Q5) — `drive.file` with a visible "BetterTrack Vaults"
  folder**, shipped: `DRIVE_FILE_SCOPE` (`drive/gisTokenClient.ts:2`),
  `DRIVE_FOLDER_NAME` (`drive/driveDataHome.ts:34`); no `drive.appdata` remains
  anywhere. The hidden app-data folder was namespaced per (Google account ×
  OAuth client), NOT per BetterTrack user, and failed the owner's mental model
  twice: the user could never SEE that the backup exists ("i am not sure if the
  google drive stuff works" — a visible file is the proof), and the bytes were
  reachable only through our OAuth client, which fights autonomy. Under
  `drive.file` the app touches ONLY files it created (still least-privilege),
  the docs sit where the user can eyeball and hand-download them (ciphertext +
  their words = a recovery path needing nothing from us), and rename/move is
  harmless because lookups go by cached fileId + `appProperties`, never by
  name. Risks named honestly: the user can delete their own backup (the sync
  indicator flags it; Drive trash holds 30 days), and co-users of a shared
  Google account see the folder (they share the whole Drive anyway; the names
  carry no PII, below).
- **Revocation.** The user can revoke at Google at any time (the app detects
  `invalid_grant`-class failures and flags the connection); in-app
  **disconnect** refuses while any vault is bound unless the vault first
  migrates off it (§7) — or, behind an explicit acknowledgment, the user
  accepts that the app loses reach to that copy (the files stay their property
  in their Drive). **A Drive-ONLY vault is the one case the acknowledgment
  cannot cover** (PROJECTPLAN §16 2026-08-21): dropping its last medium would
  leave the empty media set `vaults_media_state` rejects, and the only copy of
  every doc behind a binding that no longer exists — so the refusal
  (`DRIVE_CONNECTION_LAST_MEDIUM`) is decided BEFORE the acknowledgment is read
  (`driveConnectionRepository.ts:171`), and the owner is never offered a loss
  of reach that was never on the table. Add and attest the server medium first.
- **Collision-safe namespace (two users, one physical Drive).** Both users'
  files share one visible folder, so the naming + ownership discipline is the
  isolation, never the folder (`driveDataHome.ts:29`–`:33`, `:380`, `:762`):

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
  writes a file whose `ownerDigest` is not its own (checked before every
  update), and concurrent creates dedupe by re-querying before first write.
  **The folder is reconciled, not assumed unique:** lookup-then-create is not
  atomic on Drive, so two devices can both create one — every creator re-lists,
  adopts the same deterministic winner (lowest folder id) and discards its own
  if it lost and is still empty (`:850`); objects are always found by
  `appProperties`, never by parent, so a stray folder never hides a doc.
  **Cannot read each other:** contents are AEAD ciphertext under different K_c,
  and even a renamed or copied file fails decryption because
  `accountBinding`/`vaultId`/`docId` sit in the AAD (§5); names and
  appProperties are digests, so no emails, vault names or portfolio hints are
  visible to a co-user. **Bounded paged lookup:** `docId` stays out of
  `appProperties`, so every document sharing (`ownerDigest`, `vaultDigest`,
  `docKind`) shares one list address; the resolution is pagination, not a new
  `docDigest` field — 100 objects per page, at most **1,000 candidate objects
  per address** (`:26`–`:27`), every page read before declaring a document
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

1. **Preconditions**, server-checked with one code each (`:540`–`:590`): the
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
   `VAULT_MOVE_CAPTURE_UNSTABLE` (`portfolioMoveCapture.ts:742`). The same
   response carries `importBatchCount`; non-zero refuses capture today (§22).
3. **Encrypt + verify:** the portfolio doc is written to every vault medium,
   the common doc folds in that portfolio's custom-asset snapshots and fork
   provenance, the header roster gains the portfolio — each write CAS'd and
   round-trip verified (§7 rule 1).
4. **Destructive commit:** `POST /portfolios/:id/vault/move-in` with body
   `{ vaultId, docVersion, portfolioDataRevision, stepUp }`
   (`packages/contracts/src/vaults.ts:1351`; §15). One account-locked
   transaction (`FOR UPDATE`, `:486`): re-verify preconditions + the revision
   token → hard-delete every `vault`-classified row keyed to the portfolio →
   destroy its `purge`-classified rows → revoke every share, audience entry,
   comment, follow and public-profile inclusion OF THAT PORTFOLIO
   (`portfolioVaultTransitionRepository.ts:951`) → set `vault_id` +
   `vault_alias` on the stub → zero-cleartext probe over the classified set
   (`vaultedPortfolioProbe.ts:727`). A replay returns `idempotent: true` rather
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
| Imports in flight                                                       | Precondition-blocked; historical import batches refuse capture today (§22)                                                 |

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
(`portfolioVaultTransitionRepository.ts:1379`), the portfolio doc removed from
the server medium into bounded history, the header roster updated; after commit
the deterministic plan rebuilds snapshots and invalidates derived consumers.
The client then tombstones the portfolio doc, syncs, and best-effort deletes
the doc's Drive file. Payload ceiling per the factor rule
(`PARANOID_RESTORE_PLAINTEXT_FACTOR = 8`, `http/bodyLimits.ts:11`).
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
refusal (`http/middleware/bearerAuth.ts:923`) now fires only for a live v1
account whose durable `users.privacy_mode` is still `paranoid`, and
`MeResponse.privacyMode` (`packages/contracts/src/auth.ts:343`) is
`@deprecated` and documented as not a vault signal. Both die with the §17 wipe
and the §19 train; a vault's own signal is `vaultId` on portfolio rows plus the
narrow `GET /vaults` projection.

**Killed for a VAULTED portfolio** — each enforced server-side at the portfolio
boundary with one stable error code, `VAULTED_PORTFOLIO`
(`services/account/vaultedPortfolioGuard.ts:5`); hidden client-side as absent
affordances on that portfolio; every row covered by the matrix test:

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
   is portfolio-scoped.
7. Webhooks: no portfolio-content events for it (nothing server-side to fire).

**Proof strategy (the acceptance backbone).** The enforcement inventory +
completeness harness (`services/account/paranoidEnforcement.ts:1185`, `:1239`;
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
untouched** — it composes (hiding amounts the client just computed) and is not
part of this arc's diff.

## 12. Device custody — password, plain storage, lockout

**The endpoint keystore** (IndexedDB / platform storage; no server table —
`apps/web/src/user/vault/keystore/`): per stored phrase an entry
`{ vaultId, custody: 'wrapped' | 'plain', payload }` (`keystore/types.ts:48`).

- **Wrapped (default):** ONE device password per endpoint, never per-vault
  passwords. Argon2id(password, per-endpoint salt; m = 64 MiB, t = 3, p = 1) →
  K_dev (`keystore/types.ts:5`); each stored mnemonic entropy is
  AES-256-GCM-wrapped under K_dev, and a wrap-check value verifies entry
  (`keystore/deviceCrypto.ts:22`). Entering it once per session unlocks ALL
  wrapped phrases on that endpoint.
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
  Shipped: the device key is a private field zeroed by `clearSessionSecrets()`
  (`keystore/core.ts:75`, `:1049`), and the keystore's IndexedDB holds only KDF
  parameters, the wrap-check and lockout metadata — with no localStorage or
  sessionStorage use at all (`keystore/storage.ts:105`). **The session-end
  wiring is incomplete:** `endSession()` exists (`core.ts:657`) but
  `handleIdle()` (`:698`) and `bindToVaultLockSignal()` (`:705`) have no
  production caller, so the PIN idle-lock signal still reaches only the legacy
  v1 runtime and there is no "Lock vaults" control in the UI yet — planned with
  the remaining E8 UX (#1599).
- **Plain (the warned option):** the mnemonic entropy sits unwrapped in the
  keystore and the vault opens without any prompt. Choosing it requires the
  friction ladder's strong rung — an explicit acknowledgment that a compromised
  end device exposes the phrase outright, and that the protection is then ONLY
  "encrypted and unreadable for BetterTrack"
  (`ui/VaultCreationCeremony.tsx:266`, `ui/VaultReceivePhrase.tsx:385`).
  Default is always wrapped; the toggle is per stored phrase and changeable
  both ways (re-wrap prompts for the password). On platforms with native
  custody (Android Keystore / iOS keychain) "plain" still means "not protected
  by the device password" — the platform baseline applies underneath.
- **Wrong password / lockout:** verification is local (wrap-check,
  `core.ts:963`). Failures escalate a client-side delay — 5 wrong → 30 s,
  doubling, capped at 5 min (`core.ts:38`, `:1089`) — and there is no server
  lockout because the server is not involved. The prompt always offers "Forgot
  the password?" → **keystore reset** (`core.ts:712`): wipes the stored phrases
  on THIS endpoint only, loses NO data (the phrases re-enter by typing or §13
  QR from another device), and says exactly that in one sentence.
- **Vault states and their affordances (binding — a state without a next action
  is a design bug;** the recorded v2 anti-pattern was a locked vault with no
  unlock path): stored+wrapped → "Unlock" (password); stored+plain → opens
  silently; not-on-this-endpoint → "Enter words / Scan QR from another device".
  Every surface that renders a vault or locked stub carries its state's action
  inline. The map is total and compile-checked (`vaultStateAffordance.ts:30`);
  the QR-receiver half is still deferred at runtime (`ui/VaultManager.tsx:77`).

## 13. QR seed-phrase transfer

**Sender (the device holding the phrase):** Vault settings → "Show transfer
QR". Requires a live unlock AND, for wrapped custody, a fresh password entry
(≤ 60 s old) — the QR displays the master secret, so showing it is itself a
step-up act (`qr/senderSource.ts:61`, `qr/encoding.ts:14`). It renders
full-screen with an explicit banner ("Anyone who captures this code owns this
vault — no screenshots, no screen sharing, mind who can see your screen"), a
60-second auto-expiry that blanks the code (manual re-show), no clipboard path,
no network transmission of any kind (display→camera is the whole channel), and
nothing logged or persisted. The native apps additionally set the platform
secure-screen flag (FLAG_SECURE / iOS capture detection) on both the show and
scan screens — recorded as a mobile-board contract item.

**Payload format — normative.** This section, not any README, is the ONE
specification the web renderer, the phone scanner, and any future client are
built against (requested by the mobile dev 2026-08-19; made normative and
closed against cross-client conformance testing 2026-08-23 through
2026-08-27). Every rule below is stated so that a third implementation could
satisfy it without reading either shipped client's source;
`apps/web/src/user/vault/qr/README.md` restates none of it normatively — it
is implementation notes and defers here for every rule.

```
btvault<N>:m=<words>&v=<vaultId>[&n=<name>][&f=<fingerprint>]
```

- **Scheme, not URL — and every client decodes it itself.** Deliberately
  `scheme:query`, no `//` authority — platform URL parsers disagree about
  custom-scheme authorities. Split at the first `:`; everything after it is
  one `application/x-www-form-urlencoded` query string, decoded by a
  **self-contained decoder that every client implements itself**, never the
  platform's URL/URI type. This is not a style preference: Android's
  `URLDecoder` and OpenJDK's `URLDecoder` disagree with each other on `+` and
  on malformed percent-escapes, so even a same-language client cannot safely
  delegate; and a client built on `Uri.parse`/the `URL` type would
  additionally strip a trailing `#fragment` before the query string is ever
  read, silently accepting a payload every conformant client currently
  rejects. Both failure modes come from reusing a general-purpose URL type
  for a format that is deliberately not one.
- **Version token — canonical decimal integer.** `N` matches
  `^[1-9][0-9]*$`: no leading zeros, no zero. Validate the SHAPE before any
  integer conversion — `Number("02")` and Kotlin `"007".toInt()` both
  silently accept padded forms no BetterTrack client ever mints, which is
  exactly the divergence this rule closes. `btvault1:` is this
  specification. A canonical token above 1 (`btvault2:`, `btvault14:`) names
  a future BetterTrack version this client doesn't speak yet →
  `update-required`. Any other `btvault<token>:`-shaped input whose token is
  NOT a canonical decimal integer (`btvault0:`, `btvault01:`,
  `btvault007:`), and any input without a `btvaultN:` prefix at all, →
  `not-a-bettertrack-code` — `update-required` is reserved for a token this
  client recognizes as ours but doesn't yet speak, never for a token no
  BetterTrack client has ever emitted.
- **A `btvault1:` body that is JSON, not form-encoded** — the
  pre-form-encoding wire shape used before this specification existed — is
  our scheme in an obsolete body shape, not foreign input: `legacy-code`.
  Its remedy is unique ("this code came from an older version of
  BetterTrack; create a new one on the sending device"), which is why it is
  its own outcome rather than folding into `malformed` or
  `not-a-bettertrack-code`.
- **Structural grammar: a leading `?` is `malformed`.** A body starting with
  `?` is REJECTED, never best-effort parsed — `?` is the URL query
  delimiter, never part of form-encoded data, and a decoder that strips one
  leading `?` (as `URLSearchParams` does) would silently accept a URL-shaped
  body. This is the ruling as it stands after the 2026-08-27 review, and it
  SUPERSEDES an earlier draft that answered `missing-mnemonic` here: which
  key reads as "missing" from a `?v=…&m=…` body depends on which key a given
  implementation happens to check first, so that answer was
  order-dependent. A structural grammar violation must have an
  order-independent outcome across every implementation, which is why
  `malformed` exists in the vocabulary as a distinct, order-independent
  bucket.
- **Duplicate keys — reject, don't resolve.** A repeat of any KNOWN key —
  `m`, `v`, `n`, or `f` — anywhere in the body is REJECTED as
  `duplicate-key`, never resolved by first-wins, last-wins, or collect-all.
  All three behaviors are live across implementations that disagree with
  each other about which occurrence should win; a payload that repeats a
  known key is untrustworthy as a whole, so the outcome must not depend on
  interpretation. Unknown keys are additive extension and stay ignored no
  matter how many times they repeat.
- **Required keys: `m` checked before `v`.** `m` and `v` are both required.
  A body missing BOTH answers `missing-mnemonic`, never `missing-vault-id` —
  the phrase is the payload's entire reason for existing, so reporting its
  absence first is also the honest support answer. A conformant
  implementation checks `m` before `v` so this holds regardless of the
  order the keys appear on the wire.
- **A whitespace-only required value is ABSENT, not invalid.** `m=+` (one
  encoded space) answers `missing-mnemonic`, not `invalid-mnemonic` — a
  mnemonic made only of whitespace is not a mnemonic, and the honest remedy
  is "this code carries no phrase," not "check the words" (there are no
  words to check). The identical rule applies to `v` → `missing-vault-id`.
- **`m` (required):** the 12 BIP39 English-wordlist words themselves —
  lowercase, NFKD, single-space separated, percent-encoded (spaces become
  `%20` or `+`). Words, not entropy bytes and not wordlist indices: the BIP39
  checksum already rides IN the words (the last word carries the 4 checksum
  bits), so the scanner validates integrity against the standard wordlist
  with zero extra fields; words are what the user wrote down, so a generic QR
  reader shows a human-recoverable payload (worst case: type the words); and
  there is no entropy-encoding/endianness/checksum-recompute step where two
  implementations can silently diverge — which is the whole two-guesses risk
  this spec exists to remove. A value that is present, non-blank, and fails
  the BIP39 checksum → `invalid-mnemonic`.
- **`v` (required):** the vault UUID, lowercase hyphenated. A value that is
  present, non-blank, and not a well-formed vault id → `invalid-vault-id`.
- **`n` (optional) — display-name hint:**
  - _Length, unit named._ The cap is **64 Unicode code points**, counted as
    code points — not UTF-16 code units, not bytes. Naming the unit IS the
    rule: 64 emoji are 64 code points but well over 64 UTF-16 units, so a
    client that counts units instead of points accepts what a code-point
    counter refuses (the exact web/Android divergence conformance testing
    found). The derived wire bound is **≤ 256 UTF-8 bytes** (4 bytes ×
    64 code points, worst case). A trimmed value over the cap →
    `name-too-long` — the only rule `n` can violate, which is why the
    vocabulary names it directly instead of a generic `invalid-name`.
  - _Trim, then treat blank as absent._ Trim the edges; a blank result is
    absent, identically to an unset `n`.
  - _The trim set, named explicitly:_ **Unicode `White_Space` ∪ `Cc` (the
    C0/C1 control category) ∪ U+FEFF.** Not "whatever the host runtime's
    `trim()` does": ECMAScript's `String.prototype.trim` strips U+FEFF but
    leaves U+001C–U+001F standing, while Kotlin's `trim()` /
    `Char.isWhitespace()` does the exact opposite — each built-in disagrees
    with the other in the opposite direction, so either one alone makes the
    two clients disagree about whether a scanned code carries a name at
    all. U+FEFF is named by hand because it is category `Cf` with
    `White_Space=No` — no single Unicode property covers it, so it belongs
    to neither `White_Space` nor `Cc` and must be listed explicitly. This
    set is the union of what JS's and Kotlin's built-ins each strip, so no
    client's default trim removes a code point this spec keeps. A name made
    only of trim-set code points comes back empty and is therefore ABSENT.
  - _Trim before cap._ The 64-code-point limit applies to the TRIMMED value.
    A name already at 64 significant code points must survive being padded
    with trim-set characters on the wire, not fail the whole transfer.
  - _Every character is legal at parse; sanitize at RENDER, not parse._
    Rejecting `n` content at parse would discard an entire phrase transfer
    over a cosmetic display hint, and would only protect the clients that
    implement the rejection while every other client still renders whatever
    arrived — so parsing accepts any code point, and interior control and
    bidi characters are preserved on the wire verbatim (only the trimmed
    edges are touched at parse). Before any `n` value reaches a screen,
    strip C0/C1 controls and U+2028/U+2029 (line/paragraph separators);
    strip or Unicode-isolate the explicit bidi-control ranges
    U+202A–U+202E and U+2066–U+2069 (an unisolated bidi override can
    visually reorder surrounding UI chrome, not just the name); collapse
    whitespace runs; render as a single line; ellipsize on overflow. This
    is a display concern that lives wherever `n` is painted, independent of
    the parser.
- **`f` (optional, recommended) — key fingerprint:**
  - _At parse:_ validate SHAPE only — 16-character base64url. A present
    value that fails the shape check → `invalid-fingerprint`.
  - _Never compared before fetch._ The value is compared only AFTER the
    receiver fetches the vault header envelope and unwraps it with the
    phrase-derived key: fetch → unwrap → compare → verified-open (the #1500
    ruling). An offline fingerprint pre-check is cryptographically
    impossible, not merely unimplemented: the fingerprint is derived from
    the content key stored INSIDE the envelope that has not been fetched
    yet, so there is nothing to compare against before the network
    round-trip completes.
- **QR encoding:** byte mode, UTF-8, error-correction level M. The payload is
  ~150–220 wire bytes — a comfortably scannable version-7-ish code. A sender
  must never emit an `n` that would push the code past this budget; a
  receiver must still be able to PARSE whatever another client sent, up to
  the 64-code-point / 256-byte cap.

**Rejection vocabulary — the closed set.** FROZEN 2026-08-26 after the
cross-client pushback round. Every parse outcome is exactly one of these
twelve literals; there is no thirteenth, and no client may invent, narrow, or
widen the set:

`ok` · `not-a-bettertrack-code` · `update-required` · `legacy-code` ·
`malformed` · `missing-mnemonic` · `missing-vault-id` · `duplicate-key` ·
`invalid-mnemonic` · `invalid-vault-id` · `invalid-fingerprint` ·
`name-too-long`

Why the set has this shape, recorded so a reviewer can accept or challenge a
future addition against the same reasoning:

- Granular missing-key codes (`missing-mnemonic`, `missing-vault-id`) win
  over one generic `missing-key`, because granular → generic is always
  derivable by a client that only needs the generic answer, while generic →
  granular is not derivable by a client that needs the granular one.
- `invalid-mnemonic` — a well-formed payload whose phrase fails the BIP39
  checksum — is the single most common real failure, and its remedy ("check
  the words, not rescan") is unique: every other outcome's remedy is "get a
  new code."
- `name-too-long` is the only rule `n` can violate, so the vocabulary names
  the rule directly instead of hiding it inside a generic `invalid-name`.
- `legacy-code` exists because its remedy — "create a new code on the
  sending device" — differs from every other outcome's remedy; folding it
  into `malformed` would send a user with a perfectly good but outdated
  sender down the wrong path.
- `malformed` is the structural residual: what remains after every more
  specific outcome above has had first refusal. It should be rare.

**Receiver (the phone):** camera scan → version-token check → BIP39 checksum
validation of `m` → the vault id/name hint pre-fills → custody choice
(wrapped default — set/enter the device password; plain behind the §12
warning) → **verified open**: the client fetches the vault header doc from
any reachable medium, unwraps it with the phrase-derived key, and compares
the `f`/key_fingerprint when present, all BEFORE saving to the keystore, so a
mis-scan can never store dead words.

Manual word entry remains the fallback everywhere the QR is offered.

**Shipped-client conformance** (`apps/web/src/user/vault/qr/payload.ts`, whose
vectors in `qr/conformanceVectors.ts` are the cross-client oracle): the closed
vocabulary, the version-token shape check, the leading-`?` refusal,
duplicate-key rejection, `m`-before-`v`, blank-is-absent, the trim set,
trim-before-cap, render-time sanitization and the fetch-then-compare `f` rule
all match this specification. **One deviation is recorded, not blessed:** the
web decoder calls `new URLSearchParams(body)` (`payload.ts:113`) instead of the
self-contained decoder this section requires. It compensates by refusing a
leading `?` first (`:105`), closing the one divergence the spec names for that
type, but the rule as written is stricter than the shipped client. The `n` byte
bound is a wire budget rather than a parse rule — the parser enforces only the
64-code-point cap, and the sender enforces a 220-byte whole-payload budget
(`payload.ts:21`).

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
  `composePortfolioFigures` is wired into the Home board
  (`home/homeData.ts:359`); AT/DE cross-portfolio tax
  (`engine/composition.ts:389`, Verlustausgleich spans portfolios) is **built
  and tested but has no production caller yet** — planned with the remaining
  store-seam routing (#1599).
- **Locked honesty:** while any involved vault is locked, aggregate views
  render **sum-of-visible plus a mandatory lock qualifier** ("+ N locked
  portfolios") — never a bare total, never a silently-partial figure. Enforced
  by construction: `QualifiedPortfolioFigure` cannot exist without its coverage
  qualifier, and a scope with zero readable members returns
  `UnavailableComposition` instead (`engine/composition.ts:96`, `:107`).
- `PortfolioStore` resolves per portfolio (`portfolioStoreResolver.ts:184`):
  `apiPortfolioStore` for plain rows, `vaultPortfolioStore` for vaulted ones —
  same pages, same components, which is why an unlocked vaulted portfolio is
  indistinguishable day-to-day. Only the overview tab routes at the seam so far
  (#1599).
- **The sync-status indicator is an explicit KEEPER — look unchanged, data
  source generalized.** Owner, verbatim (2026-08-19): "i like the 'synched' UI
  up top with the current paranoid mode. its really cool design stuff." Its
  visual design is NOT redesigned; what generalizes is the projection beneath
  it. With N vaults on different media the chip renders one **aggregate
  state** — `all synced ✓` / `syncing` / `locked (N)` / `attention: <vault
name>` — as the worst state across vaults (attention > syncing > locked >
  synced, `media/status.ts:149`), and its popover gains one row per vault
  (state, per-medium detail, last-write time, and the state's §12 affordance
  inline). One chip, never one per vault (anti-bloat). `DirectoryVaultSyncChip`
  ships (`ui/VaultSyncChip.tsx:227`, mounted `components/OriginShell.tsx:870`);
  the account-singleton `LegacyVaultSyncChip` is still mounted beside it
  until §19.

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
  (`packages/contracts/src/vaults.ts:319`), mirroring
  `deleteAccountRequestSchema` / `passkeyDeleteRequestSchema`. It is verified
  inside the same account lock as the transition (no check-then-act race);
  failure rides the progressive per-account throttle plus an audit record with
  generic error text. The in-body credential is what replaces CSRF +
  same-origin on the bearer path — say so in the code comment.
- **Both paths, same rule:** the web wizard sends it too; a bearer path is
  never stricter or looser than the browser path. Bearer reachability follows
  the owner's 2026-08-17 shared-control-layer ruling under `account:security`,
  default-closed via the method-aware allowlist (`bearerAuth.ts:155`), with the
  #1326 acceptance battery (wrong-credential = nothing purged,
  INSUFFICIENT_SCOPE naming the scope, unknown-future-route canary) inherited
  as this arc's tests.

**Shipped today: three of the five.** Move-in
(`portfolioVaultTransitionService.ts:534`), move-out (`:908`) and vault
deletion (`vaultService.ts:302`) verify the in-body credential. Drive
disconnect-with-loss takes only the `acknowledgeBound` query flag and no
step-up (`vaultRoutes.ts:790`), and the §17 path is instead hard-gated
session-only on the bearer surface (`bearerAuth.ts:717`). Closing the
disconnect gap is **planned and untracked** — the one ruled gate with no issue
behind it.

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

1. **External ciphertext backup first** — dump every `paranoid_vaults` account
   blob + bounded history to a verified archive on the prod host, offsite copy
   confirmed, THEN any destructive step. The owner runs/authorizes the backup.
2. **Wipe + reset**: the account-level rows are retired behind that backup,
   affected accounts' `privacy_mode` flips to `normal`, and the account-kill
   state is cleared. Those accounts come back feature-complete and empty of
   previously vaulted content; the legacy passphrase and recovery kit die with
   the wipe.
3. **Notice**: affected accounts get a one-time in-app notice at next login —
   "Paranoid mode has a new shape; the old paranoid data was retired with the
   old system" — with the create-a-vault CTA. No conversion ceremony, no
   legacy passphrase prompt.
4. **The account-level surface is deleted in the same arc** (§19) — the
   one-implementation rule holds with zero unconverted-account bookkeeping.

**The ordering ruling that shipped it** (PROJECTPLAN §16, 2026-08-29, PR #1559
— binding). "One migration retires the account-level rows" is implemented as
**migration-ships-the-gate + service-side, owner-triggered destruction.**
Migration `0102_paranoid_v1_transition` creates the attestation gate, the
wipe-receipt table and the seven `zz_paranoid_v1_backup_*` quarantine mirrors,
and wipes nobody; `paranoidV1WipeService` performs the retirement per account
behind that gate once the owner-run `scripts/ops/export-paranoid-v1-backup.mjs`
has recorded a verified, offsite-confirmed attestation. The wipe is reachable
from no HTTP route and no job. Merge is deploy, so a migration body runs
unattended the instant a PR lands — putting the wipe there would execute the
destructive step BEFORE the backup that step 1 makes its precondition, the
exact inversion the (C) ruling forbids. The same row's second ruling: an
account the wipe has already retired is REFUSED by the v1 enable path
(`PARANOID_LEGACY_WIPED`, 409) — a targeted per-account refusal, NOT a
retirement of the enable route, which §19 keeps alive until the end of §17 for
un-wiped stragglers.

**Status: not executed.** The machinery shipped with E9 (#1419) and the
three-step owner runbook lives in `docs/ops.md` ("Retiring the account-level
(v1) paranoid surface — §17"), but it has not been run on production, so every
v1 account, table and route is still live. The fresh-start notice rides the
session payload (`paranoidFreshStartPending`,
`packages/contracts/src/auth.ts:359`) and is acknowledged once via
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
`accountRoutes.ts:145`–`:227`), the account-singleton document and its store
(`paranoid_vaults`, `paranoid_vault_history`, `paranoid_enable_transitions`,
`paranoid_vault_server_candidates`, `paranoid_vault_retirements`,
`paranoid_vault_retired`, `paranoid_rehydration_receipts` —
`schema.ts:3828`–`:3985`; `GET/PUT /vault` and the `/vault/media*` account
family — `vaultRoutes.ts:269`–`:549`), `users.privacy_mode` + the paranoid
media columns + CHECK (`schema.ts:230`–`:264`), the account-wide
`PARANOID_MODE` kill rail (`bearerAuth.ts:923`), `MeResponse.privacyMode` as a
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
