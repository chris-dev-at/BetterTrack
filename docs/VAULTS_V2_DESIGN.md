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
  session-only (unchanged principle).
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
