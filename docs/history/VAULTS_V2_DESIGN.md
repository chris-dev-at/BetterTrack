# Vaults v2 — per-portfolio paranoid mode as multi-vault wallets

> **SUPERSEDED AND WITHDRAWN — 2026-08-19 owner ruling (PROJECTPLAN §16).**
> This design is no longer binding on anything. BetterTrack has exactly ONE
> paranoid implementation: the account-level V5-P13 mode (PROJECTPLAN §13.5).
>
> The per-portfolio surface described below was built, shipped, and has now been
> removed in full — routes, services, tables, client, contracts and conformance
> vectors. It shipped a **false privacy promise**: the create wizard offered
> `server` / `drive` / `both` storage backends while containing no Google Drive
> code at all, so a user choosing "Drive only" had every byte of ciphertext
> stored on the BetterTrack server and none on Drive.
>
> There is deliberately **no port path** from v2 to v1. The server-side v2 rows
> were quarantined by migration `0089_vault_v2_quarantine.sql` for external
> backup and destruction via `scripts/ops/export-vault-v2-backup.mjs`.
>
> Kept only as the historical record of a withdrawn design. Do not implement
> from it, and do not cite it as a contract — the mobile app's matching v2
> conformance replay must be dropped too.

Owner-directed redesign (2026-08-07/08). Supersedes the account-level paranoid
model (§13.5) as the product shape; the account-level machinery remains the
crypto substrate. This document is the binding contract for the platform
(server + web) and the mobile app. Deviations go through the platform chief.

## 1. Model

- A **vault** is a named, user-owned container with:
  - its **own 12-word passphrase** (generated, shown once, confirmed),
  - its **own storage backend set**: `server` | `drive` | `both` (extensible),
  - a user-chosen cleartext **name** (e.g. "Drive vault") — never secret data.
- A **portfolio is paranoid iff it belongs to a vault** (`portfolios.vaultId`).
  Accounts mix freely: normal portfolios (server cleartext, full server
  features) + vaulted portfolios (ciphertext only, client-computed).
- Multiple vaults per account are first-class: some portfolios on Drive-only
  vaults, some on server vaults, **separate passphrases** — exactly the
  owner's ask.

## 2. Cryptography (reuses the proven BTVAULT1 substrate)

```
12-word passphrase P (per vault)      device password D (per device)
        │                                   │
   Argon2id(P, vault.kdfSalt)          Argon2id(D, deviceSalt)
        │                                   │
        ▼                                   ▼
   master key K_p                      device key K_d
        │                                   └── AES-GCM-encrypts P for local
        ▼                                       storage on that device only
   unwraps keySlots[0] ──► content key K_c (random 256-bit)
                                │
                                ▼
              AES-256-GCM decrypts each portfolio blob
```

- **Vault header doc** (server- or Drive-stored, versioned): format version,
  `kdfSalt`, `keySlots[]` (wrapped copies of `K_c`), portfolio index
  (portfolioIds + display aliases), backend config echo.
- **`keySlots[]` is the future-sharing hook**: today exactly one slot
  (passphrase-wrapped). A future shared vault adds slots wrapping `K_c` to
  other users' public keys (group paranoid portfolios). Designed now, built
  later — no schema change needed when it comes.
- **Per-portfolio content blobs**: `AES-GCM(K_c, portfolioDoc)`, individually
  CAS-versioned. Portfolio doc schema = the existing vault entity kinds scoped
  to one portfolio (transactions, dividends, cash sources/movements,
  portfolio settings, custom assets, standing orders).
- Device storage of `P`: password-wrapped by default; **raw opt-in** behind an
  explicit warning (compromised device ⇒ vault opens instantly).
- **QR handoff**: payload `btvault1:{"v":2,"vaultId":…,"name":…,"p":…}`,
  rendered only after re-auth, on-screen max 60 s, never transmitted.
  Receiving device stores under its own device password.

## 3. Server surface (P2)

- Tables: `vaults` (id, userId, name, backends, createdAt), `vault_docs`
  (vaultId, docKind `header`|`portfolio`, portfolioId?, ciphertext, version,
  updatedAt). Server never parses ciphertext; sizes capped.
- `portfolios.vaultId` nullable FK. Vaulted portfolios: server-side jobs,
  sharing, mirrorchain, alerts are killed for them (extend the existing
  paranoid kill-rails, now portfolio-scoped).
- **Erratum (2026-08-08) — alerts are NOT portfolio-killable.** An alert carries
  no portfolio reference: alerts are account-level and fire on an asset, so
  there is nothing to scope a kill to. Account-level alerts therefore SURVIVE
  vaulting untouched and keep working for a vaulted portfolio's assets. What
  does die is alert _sharing_, and it dies with sharing generally rather than as
  a rule of its own. The original line above overstated the kill list.
- Endpoints (session): vault CRUD (create takes the client-built header;
  server stores blindly), backend config change, **join** =
  `POST /portfolios/{id}/vault` (body: vaultId + client-encrypted blob) — one
  transaction: store blob, purge that portfolio's cleartext rows, set
  `vaultId`; **leave/disable** = reverse (client posts plaintext rows back,
  server repopulates, clears `vaultId`, retires blob).
- Endpoints (bearer, `vault:sync`, per-vault): header/blob GET + PUT with
  `If-Match` CAS — the existing vault:sync discipline widened from
  account-singleton to `{vaultId}`-scoped routes. Transitions stay
  session-only (unchanged principle). Shipped paths (P2/P3 reconciliation,
  2026-08-08): `/vaults/{vaultId}/header`, `/vaults/{vaultId}/common`,
  `/vaults/{vaultId}/portfolios/{portfolioId}`.
- `POST /vaults` **takes the client-minted `id`**: §11 derives the vault id
  deterministically from the legacy vault, and the client must know it before
  it writes any doc. A client refuses loudly if a server ever reassigns it.
- `POST /auth/reauth` (session-only, `{ password }`, login-class rate limit,
  204, audited) is the step-up verifier the QR reveal is gated on. Clients FAIL
  CLOSED: an absent or failing verifier refuses the reveal, never degrades to
  showing the secret ungated.
- `PATCH /portfolios/{id}/alias` sets the cleartext display alias a locked row
  renders, so the label survives independently of the header doc.
- Migration: accounts in old per-account paranoid get vault #1 ("My vault")
  wrapping their existing vault doc; the v1→v2 header upgrade happens
  client-side on next unlock (silent-upgrade precedent). Old routes serve
  until both clients confirm v2 adoption.

## 4. Web surface (P3)

- **Portfolio settings, every portfolio, always visible**: a "Vault /
  Paranoid mode" section (owner order — discoverability). States:
  - no vaults yet → explainer teaser + **"Create a vault"** CTA (wizard:
    name → backend choice → 12 words shown/confirmed → done);
  - vaults exist, portfolio normal → vault picker + "Move into vault"
    (client encrypts, calls join; progress + irreversibility copy);
  - portfolio vaulted → vault name, lock state, unlock, "Move out", QR share
    (re-auth-gated), backend info.
- Locked vaulted portfolios render as locked rows (alias + lock glyph)
  everywhere money renders; unlock prompt on interaction.
- **Explainer page** (`/vault/how-it-works`, linked from the settings section
  and the wizard): the §2 diagram rendered properly, what the server sees,
  what a breach yields, what a stolen device yields (both storage modes),
  lost-words consequence, ticker-visibility caveat.
- Control-Center Privacy panel: account-level enable wizard replaced by a
  pointer into the new per-portfolio flow (plus legacy-migration entry).

## 5. Mobile (P4 — mobile dev, after board review of this doc)

- Same contract: vault list, QR scan → device-password wrap → unlock,
  per-vault Drive backend (existing Drive machinery re-scoped), portfolio
  settings section mirroring §4, storage wizard folds into vault creation.
- Kotlin engine unchanged (same entity kinds, same conformance vectors; new
  vectors ship for the v2 header + per-portfolio doc split).

## 6. Deliberately future (designed-for, not built)

- **Shared vaults** (group paranoid portfolios): additional `keySlots`
  wrapping `K_c` to member public keys; membership/invite flow TBD.
- **More backends**: WebDAV/iCloud/file — the backend enum + per-backend CAS
  adapter interface is the extension point.
- **Watch-only crypto wallets** (owner idea, separate feature, not
  vault-specific): add a portfolio fed by a public chain address (BTC/ETH…),
  auto-tracking balances via a chain-data provider. Lands in the provider
  domain backlog, not in this arc.

## 7. Non-goals / invariants

- No passphrase, derived key, or plaintext ever reaches the server. No
  server-side recovery. AA/a11y and i18n bars unchanged. `packages/domain`
  stays pure and shared. Conformance-vector discipline holds for every format
  change (both clients re-pin).

---

# Revision 2 — rulings from the mobile review (#73, docs/VAULTS_V2_MOBILE_REVIEW.md in the app repo)

Binding amendments. Where r2 conflicts with the text above, r2 wins.

## 8. Document model (supersedes parts of §2/§3)

- Three doc kinds per vault: **`header`**, **`common`**, **`portfolio`** (one per
  member portfolio). All CAS-versioned independently.
- **Custom-asset creation context (2026-08-08).** Which document a custom asset
  belongs to is decided by WHERE IT WAS CREATED, not by what references it. An
  asset created while working inside a vaulted portfolio lands in that vault's
  `common` doc and is invisible to the server. An asset that already existed
  server-side when the portfolio was vaulted STAYS cleartext on the server —
  other, normal portfolios of the same account still reference it, and a join
  must not break them. This is the concrete mechanism behind §4's
  ticker-visibility caveat, and it is why the leave restore graph carries no
  user-scoped kinds.
- **`common` owns every account/vault-scoped entity kind** for that vault:
  `customAsset`, `customAssetValue`, `clientSecurity`, `mirrorProvenance`,
  `mergeLog`, `cashTag`, `cashRule`, `cashBudget`, `expenseCategory`,
  `expenseRule`, `expenseBudget`, `taxSetting`, plus the four child kinds
  ruled in during P3 reconciliation (2026-08-08) — `expenseTransaction`,
  `expenseBudgetFire`, `cashBudgetFire` and `cashRuleTag`. Those four have no
  portfolio linkage at all: their parents live in `common`, so a portfolio doc
  could never route them and every migration would orphan them. With them the
  partition is exact — 13 kinds in `common`, 13 in `portfolio`, covering all 26
  `VAULT_ENTITY_KINDS` with no overlap and no remainder, which is what lets the
  v1→v2 split assert "entities in === entities out".
  Ids are namespaced per vault;
  the same conceptual custom asset in two vaults is two independent lineages
  by design (no cross-vault dedup). Retirement-proof/`clientSecurity` and
  `mirrorProvenance` are per-vault; divergence rules apply within one vault
  only — leave/disable consults only the owning vault's provenance.
- **Single-blob mutation rule: every mutation touches exactly one doc.**
  - Cross-portfolio transfer within a vault: REFUSED as one op. The UX offers
    a guided two-step (withdrawal commits in blob A, then deposit in blob B;
    each step independently consistent; a cosmetic `transferGroupId` links
    them for display only — no transactional meaning; an unmatched first leg
    renders honestly as an unmatched withdrawal).
  - Cross-VAULT transfer: refused at UI and op layer in v2.
- **Locked vault = no reads AND no writes.** A locked portfolio's add-entry
  surfaces prompt inline unlock; there is no queued-write path (keeps vault
  ops terminal; no new idempotency machinery for locked-state applies).
- **Unfetchable/undecryptable blob** named by the header index: that
  portfolio renders as `unavailable` (a distinct error state — never empty,
  never €0); the rest of the vault stays usable; a banner names the doc and
  version for recovery.
- Size caps: header 1 MB, common 4 MB, portfolio 8 MB.

## 9. Format versioning

- The v2 header declares **`formatVersion: 2`** (v1 parsers get a clean
  UPDATE_REQUIRED path — never "vault corrupt"). Header remains AAD; AAD input
  includes `formatVersion`, `vaultId`, and slot index for each key slot.
- **No header integrity tag ships in v2** (P3 reconciliation, 2026-08-08). A
  draft sealed the header with a fixed-nonce GMAC under `K_c`; that is unsafe
  here, because the header is rewritten whenever the portfolio index changes,
  and two GMAC tags under one key with a reused nonce leak the authentication
  subkey. The exposure is real and acknowledged — a blob store can relabel,
  add or drop a portfolio index entry — and it is deferred to the **P5
  hardening pass** with a per-write random IV stored beside the tag, or by
  folding the index into the key-slot AAD. Header schemas on both clients MUST
  therefore accept and preserve unknown members so the tag lands additively.
- The QR payload's version member is renamed **`qr: 1`** (no collision with
  `VAULT_DOCUMENT_VERSION`). Recovery kit gets a v2 layout (kit lists vault
  name, id, backend set, and the 12 words; kit format documented with the
  vector family below).
- 12-word passphrase = **BIP39 English wordlist, 12 words, NFKD, single-space
  separated, BIP39 checksum valid**. Free-text passphrases remain valid input
  for v1-migrated vaults only.

## 10. QR handoff (supersedes §2's payload)

- Payload: `btvault1:{"qr":1,"vaultId":…,"name":…,"w":…}` where `w` =
  AES-GCM(KDF(pin), P) with a 6-digit one-time PIN. The QR alone is useless —
  **a screenshot no longer captures the secret**.
- Flow: re-auth → QR screen (no PIN shown) → receiver scans → sender taps
  "reveal code" (second screen) → receiver types the PIN → P unwrapped and
  stored under the receiver's device custody. Total TTL 120 s.
- Native clients MUST exclude these screens from screenshots/recents
  (FLAG_SECURE); web shows an explicit screenshot warning.
- Device custody of P: platform-appropriate. Password-wrap is the default;
  **the raw-storage opt-in is platform-optional** — a platform with stronger
  native custody (Android Keystore) MAY decline to offer raw storage.

## 11. v1→v2 migration protocol (supersedes §3's one-liner)

1. **Claim**: CAS write of `{migratingBy: clientNonce, ttl: 15min}` on the
   legacy vault row; the claim is renewable; losers see the claim and wait
   (read-only on v1 meanwhile).
2. **Write**: claim holder writes all v2 docs — deterministic doc identities
   (`vaultId` = derived from legacy vault id; portfolio docs keyed by
   portfolioId) make every write idempotent on resume.
3. **Verify**: holder lists written docs and checks completeness against the
   legacy content.
4. **Flip**: single CAS write `{migratedTo: vaultId}` on the legacy row —
   this is the commit point. Before it, v1 is authoritative; after it, v1 is
   a read-only tombstone and v2 is authoritative.
5. **Resume**: a returning claim holder re-lists and continues from step 2;
   a crashed half-migration is invisible to other clients (flip never
   happened).

- **Op idempotency**: op `clientId`s are preserved verbatim into split docs;
  every executor MUST honor `op.clientId` on replay (no fresh-id minting on
  a replayed op).

## 12. Aggregates, coverage, and account surfaces

- Price/coverage arithmetic gains a fourth state: **`lockedExcluded`**.
- Net worth and any cross-portfolio total render as **sum-of-visible plus a
  mandatory lock qualifier** ("+ N locked portfolios") — never a bare total
  while any vault is locked; identical arithmetic on web and mobile.
- Account-scoped list surfaces (tags, rules, budgets): server-side entries
  always visible; a locked vault's entries are hidden behind a per-vault lock
  chip ("entries from '<vault>' hidden") — not all-or-nothing.

## 13. Backends

- `both` = the same doc set mirrored to both media, **independent CAS per
  medium**; reconcile = highest (version, then updatedAt) wins; writes go
  write-through to both, tolerating one medium temporarily behind.
- Drive naming (appDataFolder is flat): `btv2.{vaultId}.header`,
  `btv2.{vaultId}.common`, `btv2.{vaultId}.p.{portfolioId}`. Rename
  migration for existing single-file vaults: copy to new names → verify →
  write `btv2.{vaultId}.migrated` marker → retire old names; resumable by
  re-listing at every step.

## 14. Server knowledge (honest metadata note)

- The server learns vault membership (`portfolios.vaultId`), blob sizes and
  write timings. **Accepted by design in v2** (routing and purge require it);
  stated plainly in the explainer. Hiding membership (padding, uniform ids)
  is future work if ever wanted.

## 15. Wire contract additions

- **412 responses carry the current version** (`{error, currentVersion}`) on
  every CAS surface.
- Error codes (EN+DE strings ship with the platform i18n catalog). The
  canonical ten:
  `VAULT_NOT_FOUND`, `VAULT_NOT_EMPTY`, `VAULT_VERSION_CONFLICT`,
  `VAULT_DOC_TOO_LARGE`, `VAULT_LOCKED_WRITE_REFUSED`,
  `VAULT_MIGRATION_CLAIMED`, `VAULT_MIGRATION_INCOMPLETE`,
  `VAULT_CROSS_BLOB_REFUSED`, `VAULT_FORMAT_UPDATE_REQUIRED`,
  `VAULT_BACKEND_UNAVAILABLE`.
- **Erratum (P2/P3 reconciliation, 2026-08-08): seven further codes ship**, for
  outcomes the canonical ten cannot express without lying about what happened.
  All seventeen carry EN+DE strings — mobile renders every error from the
  catalog, so a code with no string surfaces raw:
  `VAULT_PRECONDITION_REQUIRED` (a write with neither `If-Match` nor
  `If-None-Match: *`, 428), `VAULT_NAME_TAKEN` (409),
  `VAULT_PORTFOLIO_ALREADY_VAULTED` (409), `VAULT_JOIN_BLOCKED` (a precondition
  such as live mirrorchain membership, 409), `VAULT_RESTORE_INVALID` (the leave
  payload failed the portfolio-scoped invariants, 400), `VAULT_ID_TAKEN` (a
  client-minted id collision — distinct from a name clash, because ids are
  DERIVED and a collision reads as "you are resuming", 409), and
  `VAULT_PORTFOLIO_NOT_VAULTED` (409 — distinct from `VAULT_NOT_FOUND` because a
  non-vaulted portfolio is an ordinary portfolio the client should just render).
- Vault membership (list of vaultIds + names + which portfolios) is exposed
  to authenticated clients of the owning account only.

## 16. Vectors (platform ships; mobile replays)

Six families, produced by the platform hardening pass and published in the
**shared vectors location** (`packages/domain` fixture area — vault vectors
relocate out of `apps/web` as part of this arc): (1) v2 header
derive/wrap/unwrap, (2) multi-slot unwrap, (3) per-portfolio split across all
26 entity kinds, (4) a full migration transcript (claim→write→verify→flip),
(5) recovery-kit v2, (6) canonical QR string (exact member order + encoding
for a fixed input).

---

# Revision 3 — hardening rulings (P5, 2026-08-08)

Binding amendments from the platform chief's rulings on the mobile r2
verification appendix (`docs/VAULTS_V2_MOBILE_REVIEW.md`, appendix A1–A9 in the
app repo). Where r3 conflicts with r2 or the base text, r3 wins. Every format
statement below is pinned by the §25 vector families.

## 17. `both` reconciles by per-document MERGE (supersedes §13's rule — A8)

- r2 §13's "reconcile = highest (version, then updatedAt) wins" was wrong: it
  promoted the engines' degenerate corrupt-bytes fallback to the primary path
  and would discard a whole divergent document — a trade booked offline on one
  device, silently dropped because a browser's clock ran ahead.
- **The rule:** when both media hold a READABLE candidate for one document, the
  client decrypts both and applies the engine's existing per-entity merge rules
  to that document — union by entity id; whole-entity winner by
  `rev → live-beats-tombstone → editedAt → editedBy → canonical content`;
  `mirrorProvenance` united then pruned against the merged entities;
  `clientSecurity` divergence throws (within one vault). The merged document is
  written through to BOTH media at `max(candidate versions) + 1`.
- **`(version, then updatedAt)` survives ONLY as the fallback for undecryptable
  candidates:** a readable candidate always beats an unreadable one regardless
  of version; among unreadable candidates the highest `(version, updatedAt)`
  selects which bytes are kept — quarantined for the restore picker, never
  silently discarded, never merged.
- Identical bytes / linear successors short-circuit exactly as in the v1
  engine (`documentDominates`); no new merge generation is minted for them.

## 18. Byte-idempotent migration (A2.1/A2.2) — derived key, deterministic bytes

The r2 §11 claim protocol gave idempotent _addressing_; r3 makes the migration
idempotent in _bytes_, so any claim holder — first, resumed, or racing — writes
identical ciphertext from identical legacy content.

- **Derived content key.** The migration-created vault's content key is
  `K_c = HKDF-SHA256(salt = <empty>, IKM = VK, info = "btv2-migration-v1", L = 32)`
  where `VK` is the legacy BTVAULT1 vault key (the 32-byte content key every
  claim holder already possesses once the legacy vault is unlocked). Two claim
  holders can no longer mint divergent random keys and write mutually
  undecryptable blobs under one identity. The migrated vault's key material is
  therefore exactly as strong (and as exposed — e.g. to an old recovery kit) as
  the legacy vault's, by design: migration moves format, not trust. A future v2
  rekey mints a fresh random `K_c`.
- **Deterministic IVs — migration writes ONLY.** Each migration blob's GCM IV is
  `IV = HKDF-SHA256(salt = <empty>, IKM = K_c, info = utf8("btv2-migration-iv") ‖ utf8(docId), L = 12)`
  with `docId = "common"` or `"p.{portfolioId}"`. **Why this is safe:** GCM
  breaks only when one `(key, IV)` pair encrypts two DIFFERENT plaintexts. In
  the migration context the plaintext for a `docId` is a pure function of the
  legacy document (the split is deterministic, §20, pinned byte-exactly by
  vector family 4), the key is a pure function of `VK`, and the IV is a pure
  function of `(K_c, docId)` — so each `(key, IV, plaintext)` triple is fixed
  and unique per `docId`, and any two conforming writers produce identical
  ciphertext. A client whose split serialization deviates from the pinned
  vectors MUST NOT write migration blobs — that is what vector conformance
  means. Normal (non-migration) operation keeps random IVs.
- **Deterministic writer identity.** For blob-header bytes to be identical, the
  migration also fixes the header's writer fields:
  `deviceId = uuid(HKDF(K_c, "btv2-migration-device", 16))`,
  `writeId(doc) = uuid(HKDF(K_c, utf8("btv2-migration-write") ‖ utf8(docId), 16))`,
  `writtenAt` = the legacy envelope header's `writtenAt` verbatim,
  `blobVersion = 1`. (`uuid(bytes)` = the 16 bytes with the RFC 4122 version
  nibble forced to 4 and the variant bits to 10.)
- **Deterministic header doc.** The successor header reuses the legacy vault's
  KDF salt (`kdfSalt` = the legacy active wrapper's `kdf.salt`), and draws slot
  0's `slotId` (16 bytes) and wrap IV (12 bytes) from one 28-byte expansion
  `HKDF(K_c, "btv2-migration-header", 28)`; `writtenAt` as above. A v1-migrated
  vault keeps its legacy free-text passphrase (r2 §9), so the header's KEK is
  derived from the words the user already knows.
- **Successor vault id.** `vaultId = uuid(SHA-256(utf8("btv2-migration-vault-id:") ‖ utf8(scopeId))[0..16))`
  where `scopeId` is the account `userId` for server-coordinated migrations and
  the Drive-local `accountId` for Drive-only vaults (§23). Public, derivable
  before any unlock, and collision-answered by `VAULT_ID_TAKEN` = "you are
  resuming".
- **Server enforcement — the `If-Claim` precondition (A2.2).** While the legacy
  row carries a live claim, every vault document write must send
  `If-Claim: <clientNonce>`. Missing → `428 VAULT_PRECONDITION_REQUIRED`;
  present but not the live claim's nonce (expired, superseded, or arriving
  after the flip) → `409 VAULT_MIGRATION_CLAIMED`. Both carry the migration
  `state` beside `error`. The check runs inside the write transaction. "Losers
  wait" is enforced by the server, not by good manners.

## 19. QR wrap hardened (supersedes §10's 6-digit PIN — A4.1)

- **The one-time code is 8 characters of Crockford base32** — alphabet
  `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U) — exactly 40 bits, drawn
  uniformly (5 CSPRNG bytes → eight 5-bit groups). Displayed grouped
  `XXXX-XXXX`; entry normalization per Crockford: uppercase, separators
  stripped, `I`/`L`→`1`, `O`→`0`.
- **The KDF is normative:** `w = salt(16) ‖ iv(12) ‖ AES-256-GCM(KDF(code), P)`
  with `KDF = Argon2id, m = 65536 (64 MiB), t = 3, p = 1`, 32-byte output, the
  canonical code string (8 uppercase characters, no separators) as the UTF-8
  password over the random 16-byte salt, and `AAD = utf8(vaultId)` — the same
  Argon2id profile as the vault KDF, so no client ships a second cost profile.
- **Threat math (normative).** A photograph or screen-grab of the QR screen
  alone yields `w` and its GCM tag — an offline verification oracle whose
  search space is the code: `2^40` candidates × one 64 MiB Argon2id evaluation
  each. At ~0.35 s per guess that is ≈12,000 CPU-years, memory-hard and
  GPU-hostile — versus ≈97 CPU-hours for the 6-digit PIN r2 specified. A
  capture of BOTH screens (the QR and the reveal-code screen) defeats any
  short-code wrap by construction; against that the controls remain the
  re-auth gate, the 120 s TTL, the one-time single-use code, FLAG_SECURE +
  recents exclusion on native, and the explicit screenshot warning on web.

## 20. The §8 partition, corrected (A1.1–A1.3)

- **`clientSecurity`, `mirrorProvenance` and `mergeLog` are document MEMBERS,
  not entity kinds.** r2 §8 listed them among what `common` "owns"; a `common`
  doc carrying them as entity kinds is rejected by both engines' fail-closed
  parsers. `clientSecurity` and `mirrorProvenance` are members of the `common`
  doc (per-vault, divergence rules within one vault). **`mergeLog` stays
  PER-DOCUMENT**: every portfolio doc and the common doc carries its own —
  merge records name bare document versions and cannot share one array across
  N independently-versioned lineages (A1.2).
- **The mergeLog bound is a write-side TRIM, never a parse-time rejection.**
  Writers keep the newest 20 records; readers accept any length. A parse-time
  cap would let a bookkeeping array make `common` unreadable and take
  `clientSecurity` and `mirrorProvenance` — the whole vault — down with it.
- **The exact 26-kind partition** (normative; pinned by vector family 3):
  - `portfolio` doc (13): `portfolio`, `transaction`, `dividend`, `cashSource`,
    `cashMovement`, `cashMovementTag`, `portfolioSetting`, `standingOrder`,
    `standingOrderRun`, `importBatch`, `importRow`, `portfolioDailySnapshot`,
    `portfolioSnapshotState`.
  - `common` doc (13): `taxSetting`, `customAsset`, `customAssetValue`,
    `cashTag`, `cashRule`, `cashBudget`, `expenseCategory`, `expenseRule`,
    `expenseBudget`, `expenseTransaction`, `expenseBudgetFire`,
    `cashBudgetFire`, `cashRuleTag`.
  - No overlap, no remainder; the split asserts entities-in == entities-out and
    UNKNOWN entity keys stay fatal on both ends (fail-closed, unchanged).
- **Two-step transfer legs are normatively `withdrawal` then `deposit`**
  (A1.3) — the two external cash-movement kinds. Never `transfer_out` /
  `transfer_in`: both engines define those as never-external, so misusing them
  silently corrupts time-weighted return (a phantom market loss in A, a
  phantom gain in B). `transferGroupId` remains display-only.

## 21. Header integrity tag — the §9 gap, closed (no GCM/GMAC)

r2 §9 withdrew a fixed-nonce GMAC seal (correctly: two GMAC tags under one key
with a reused nonce leak the authentication subkey) and deferred header
integrity to this pass. The replacement is a deterministic MAC, safe under key
reuse by construction:

- **`header.mac = { "v": 1, "tag": base64(HMAC-SHA256(K_mac, canonicalHeaderBytes)) }`**
  with `K_mac = HKDF-SHA256(salt = <empty>, IKM = K_c, info = "btv2-header-mac-v1", L = 32)`.
- **`canonicalHeaderBytes`** = UTF-8 of the canonical JSON of the header object
  with the `mac` member removed: object keys sorted lexicographically (by UTF-16
  code unit) at every nesting level, arrays in order, no insignificant
  whitespace, finite numbers only — the same canonical-JSON discipline the §4
  merge already uses. Unknown members are INCLUDED: what a client preserves, it
  authenticates.
- **Write rule:** REQUIRED on every `formatVersion: 2` header written from r3
  onward (build, passphrase change, every revision).
- **Read rule (this arc):** absent → the header opens as **`unsealed`** —
  tolerated for pre-r3 headers, and the next header write attaches the tag
  (upgrade-on-write). Present and valid → **`verified`**. Present and INVALID →
  authentication failure, fail closed. Clients surface the unsealed/verified
  distinction; a later revision may end the tolerance.
- **What it closes:** a blob store relabeling, adding or dropping portfolio
  index entries, or editing `name`/`backends`/KDF parameters, is now detected
  whenever a tag is present. **What it does not do:** replay of a complete
  older `(header, mac)` pair — rollback protection remains the transport CAS's
  job, which is why `headerVersion` is inside the authenticated bytes.

## 22. "Locked = no reads", scoped (A5.1)

r2 §8's "locked vault = no reads and no writes" means: **no plaintext
RENDERING and no NEW WRITES while locked.** A client's working store may hold
plaintext at rest under its own storage design (Room, IndexedDB); encrypting
working stores at rest is explicitly out of this arc's scope. The no-new-writes
half is unchanged (inline unlock, no queued writes).

## 23. Drive-only migration claim (the §11 variant — A2.3)

Drive-only installs have no server row to CAS, so the claim moves onto the
medium, following §13's copy → verify → marker → retire pattern:

- **Claim file** `btv2.migration.claim`, content
  `{ "claim": 1, "nonce": <clientNonce>, "expiresAt": <ISO-8601> }`, 15-minute
  TTL, renewable by its holder only.
- Drive has no CAS, so arbitration is observational: after any create the
  client RE-LISTS; duplicate claim files from a create race resolve to the
  lexicographically smallest Drive file id on every device; losers delete only
  their own file and wait. A takeover of an expired (or unparseable) claim is
  an UPDATE of the existing file, never a second create, and nothing is
  believed until a read-back shows the claimant's nonce alone.
- **The flip** is the `btv2.{vaultId}.migrated` marker (§13). It is written
  only by the live claim holder (re-checked immediately before the write — the
  Drive analogue of `If-Claim`), then the claim file is retired. Marker
  present → every later claim answers `already-migrated`. Resume at any
  interruption = re-list and continue; before the marker, v1 is authoritative.

## 24. v1 412 conflict hint, restored as a body member (A9)

Every legacy `/vault` CAS 412 again tells the loser the winning version — as
`currentVersion` at the top level of the body, the same shape the v2 surface
uses, not as the ETag header the route once set: the 2026-08-06 ruling that
error responses carry no cache validators (#1161) stands. One 412, zero
follow-up GETs, no misleading validator on an error.

## 25. Vectors — §16 delivered

Published under `packages/domain/src/vaultVectors/` (the v1 vectors relocated
there from `apps/web`, bytes unchanged); each family is a JSON fixture plus a
replay test, fully deterministic (fixed keys, fixed salts, derived or fixed
IVs, no randomness):

1. `v2Header` — header build/derive/wrap/unwrap including the §21 `mac`;
   negative cases: wrong words, tampered slot, tampered index with mac,
   future formatVersion.
2. `v2MultiSlot` — two passphrase slots wrapping one `K_c`; either phrase
   opens its slot; slot order is authenticated (AAD binds the index).
3. `v2Partition` — the §20 partition across all 26 kinds: a v1 document
   containing every kind splits into the exact expected doc set.
4. `v2Migration` — the full §18 transcript: legacy envelope in;
   claim → write → verify → flip; derived `K_c`, deterministic IVs and writer
   identity; byte-exact header and blob envelopes out.
5. `v2RecoveryKit` — the v2 kit layout (vault name, id, backend set, the 12
   words) and its import rules.
6. `v2Qr` — the canonical QR string for a fixed input under the §19 code KDF,
   plus the unwrap.
