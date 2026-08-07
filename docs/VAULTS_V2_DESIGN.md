# Vaults v2 — per-portfolio paranoid mode as multi-vault wallets

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
- Error codes (EN+DE strings ship with the platform i18n catalog):
  `VAULT_NOT_FOUND`, `VAULT_NOT_EMPTY`, `VAULT_VERSION_CONFLICT`,
  `VAULT_DOC_TOO_LARGE`, `VAULT_LOCKED_WRITE_REFUSED`,
  `VAULT_MIGRATION_CLAIMED`, `VAULT_MIGRATION_INCOMPLETE`,
  `VAULT_CROSS_BLOB_REFUSED`, `VAULT_FORMAT_UPDATE_REQUIRED`,
  `VAULT_BACKEND_UNAVAILABLE`.
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
