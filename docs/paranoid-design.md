# PARANOID v2 — per-portfolio privacy (the only privacy model)

**Status:** rewritten under issue #665 ([v6][PP7]) per the two owner decisions
of 2026-08-12 recorded on that issue — the **ruling** (no legacy account-wide
vault, no forward-port, brute-deletion with backup) and the **owner spec**
(the later, authoritative comment: per-endpoint master password, per-vault
seed phrases, protection levels, UX charter). **Awaiting owner ack —
implementation issues are cut only after the ack** (the #665 charter's gate).
This note **supersedes the v1 account-wide paranoid design in full** (the
#651/#653 note that previously lived at this path; #654 stays closed as
superseded — nobody composes work from the v1 text, ever). The v1 text
remains reachable in git history for the deletion work's reference; no part
of it is binding. Where this note conflicts with the #651 note, the #665
charter's July wording, or PROJECTPLAN prose, **the 2026-08-12 owner spec
wins**.

**Owner ruling (2026-08-12, in chat, recorded on #665 — quoted faithfully,
binding):**

> No legacy account-wide vault support of any kind. The app is under full
> development, so existing features do NOT need porting onto the new model —
> there is explicitly no forward-port path for account-wide vault data.
> Implement paranoid mode per the owner's per-portfolio specification (this
> issue's charter). Brute-deletion of legacy account-wide vault code and data
> is authorized, WITH a backup taken first.

**Owner spec (2026-08-12, in chat, the later #665 comment — authoritative;
architecture and UX-charter points restated normatively in §3 and §9):**
per-ENDPOINT paranoid activation with ONE master password per endpoint whose
derived key encrypts ALL opted-in 12-word seed phrases locally on-device
(never one master password per vault); flow = activate → create vaults (each
with a 12-word seed phrase) → assign portfolios; multiple vaults exist for
future sharing, per-vault storage backend, and per-vault protection level
(clear-stored seed phrase behind a signed warning); keep the explanatory
tone, redesign the overcrowded pages; setup in a handful of intuitive steps;
every vault state carries its affordance. Owner: _"I want that to fully work.
Clean and understandable. Simple, easy."_

Both are §16-logged (PROJECTPLAN.md, 2026-08-12). Deletion runs only after
(a) the owner acks this note and (b) the Appendix B backup is taken and
verified — in that order, both mandatory.

**Companion contract:** `docs/VAULTS_V2_DESIGN.md` (r1–r3) remains the
binding format/protocol contract for the multi-vault surface — crypto,
document model, CAS/merge, QR handoff, header MAC, conformance vectors. This
note does not restate it; it sits above it and owns the **privacy model**:
what paranoid means per portfolio, the custody model, the enforcement matrix,
the UX charter, the Portfolio-Platform boundary fit, what is deleted, and the
ack-gated build plan. Where this note voids or amends parts of that contract
(the v1→v2 migration machinery, §10; the per-vault device-password custody
wording, §3), this note wins; VAULTS_V2_DESIGN.md is amended in the
implementation PRs, not before ack.

---

## 1. The model in one paragraph

The **portfolio** — never the account — is the unit of privacy. A portfolio
is paranoid **iff it belongs to a vault** (`portfolios.vault_id`). A
**vault** is a named, user-owned container with its own **12-word seed
phrase**, its own storage backend set (`server` | `drive` | `both`), and
three CAS-versioned encrypted documents server- and/or Drive-side: a `header`
doc (key slots, portfolio index), a `common` doc (account/vault-scoped entity
kinds), and one `portfolio` doc per member portfolio. On each **endpoint**
(each app / webapp install) the user activates paranoid mode by setting
**one master password**; its derived key encrypts, locally on that device,
every seed phrase the user opts into storing there (§3). Accounts **mix
freely**: normal portfolios keep today's full server feature set, vaulted
portfolios are ciphertext-only and client-computed, and one account can hold
several vaults with separate seed phrases, separate backends, and separate
protection levels. The ACCOUNT keeps everything that is not the vaulted
portfolio's content: identity, auth, profile, friends, chat, notifications,
watchlists, conglomerates, alerts, and every OTHER portfolio's full
functionality — including sharing and bearer-API access. No account-wide
paranoid mode exists; `users.privacy_mode` and everything keyed on it is
deleted (§10, Appendix A). Lost seed phrase (and recovery kit) ⇒ that
vault's data is lost, by design — no escrow, no reset, no support backdoor.
A lost **master password** is deliberately NOT data loss: re-enter the seed
phrases (§3).

## 2. What is already true on `main` (the v2 foundation)

Per-portfolio paranoid is not greenfield. The Vaults v2 arc shipped it as the
owner-directed redesign of 2026-08-07/08:

- **Server (PR #1176, migration 0087):** `vaults` + `vault_docs` tables,
  `portfolios.vault_id` + `portfolios.alias`, blind CAS storage
  (`/vaults/{vaultId}/header|common|portfolios/{portfolioId}`), session-only
  transitions (vault CRUD; join = encrypt + purge-cleartext + set `vault_id`
  in one transaction with a per-table zero-cleartext probe; leave = restore +
  clear), `POST /auth/reauth` step-up, and the `vault:sync` bearer scope
  widened from the account singleton to `{vaultId}`-scoped routes. The
  per-portfolio guard seed exists (`createVaultedPortfolioRouteGuard`,
  `PARANOID_PORTFOLIO_SCOPED_CAPABILITIES`).
- **Web (PR #1177):** per-portfolio vault section in portfolio settings,
  vault wizard (name → backends → 12 words), locked-row rendering, explainer,
  the v2 engine modules under `apps/web/src/user/vault/v2/`.
- **Hardening + vectors (PR #1178):** r3 rulings — per-document merge
  reconcile for `both` backends, header MAC, QR wrap KDF, the 26-kind
  `common`/`portfolio` partition, conformance vectors under
  `packages/domain`.
- **Mobile (P4, app repo):** the same contract via `vault:sync` bearer CAS.

This note's job is therefore NOT to design the vault — that contract exists
and is built. Its job is to (a) declare the per-portfolio model the ONLY
model, (b) fix the custody model per the owner spec, (c) define the
enforcement matrix that replaces the account-wide kill rail, (d) set the UX
charter, (e) fit the Portfolio-Platform boundaries (PP1–PP6), (f) order the
legacy account-wide implementation deleted with a verified backup, and (g)
break the remaining work into ack-gated packages that end in **fully working
software**, not architecture.

## 3. Key custody — the 2026-08-12 owner spec (binding)

Two layers, deliberately distinct:

**Layer 1 — the vault secret (unchanged from shipped v2):** each vault has
its own 12-word seed phrase (BIP39 wordlist, checksum-valid). Phrase →
Argon2id → unwraps the vault's content key `K_c` via `keySlots[0]` → per-doc
AES-256-GCM. `keySlots[]` remains the future-sharing hook. Any device that
knows the words can open the vault from any backend. Recovery kit per vault
(words + name + id + backends). **Lost words + lost kit + no endpoint
holding the phrase ⇒ that vault's data is cryptographically gone**; other
vaults and the rest of the account are untouched.

**Layer 2 — endpoint custody (the owner spec's correction to r2's per-vault
device password):** paranoid mode is **activated per endpoint** by setting
that endpoint's **master password**. There is exactly **one master password
per endpoint**, and its Argon2id-derived key encrypts **ALL** seed phrases
the user opts into storing on that endpoint — one local keystore, never one
master password per vault. The master password never leaves the device and
never reaches any server. Shipped `v2/devicePassphrase.ts` (per-vault device
custody) is rewritten into this endpoint keystore (Appendix A).

**Per-vault protection level (owner spec, reason c for multiple vaults):** a
vault MAY opt out of master-password protection and store its seed phrase
**in clear** on the endpoint. That vault is then secure against a
BetterTrack-server compromise only, not against a compromised device. Opting
out requires an explicit **signed warning** — a checkbox acknowledgment that
a compromised device exposes the seed phrase outright (friction-ladder
strong rung). Default is always master-password-wrapped. On platforms with
stronger native custody (e.g. Android Keystore) "clear" still means "not
protected by the master password"; the platform's baseline custody applies —
the level is about what the master password protects, not about bypassing OS
security.

**Recovery semantics, normative:**

- Master password forgotten ⇒ **no data loss.** The endpoint keystore is
  reset and the user re-enters (or QR-imports) seed phrases. The reset flow
  says exactly this in one sentence.
- Seed phrase lost (all copies) ⇒ **that vault's data is lost**, by design.
  No escrow, no reset, no support path — unchanged, re-affirmed.
- The master password is **vault custody only**. It is not a general app
  lock — PIN lock remains the app lock; no second idle-timer setting
  (anti-bloat). Conservative default, flagged for ack (§13 Q3).

**Vault states on an endpoint** (each carries its affordance, §9):

| State                | Meaning                                         | Affordance                                                                        |
| -------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| stored + wrapped     | words in the keystore under the master password | unlock by master password (once per endpoint session, unlocks ALL wrapped vaults) |
| stored + clear       | words on the endpoint, signed-warning opt-out   | opens without prompt                                                              |
| not on this endpoint | words never entered here                        | enter words / QR handoff from another device                                      |

**Charter reconciliation, recorded:** the #665 charter (July) said "ONE
account vault passphrase → KEK → wraps per-portfolio VKs; one recovery kit".
The owner spec resolves it: the "one passphrase" instinct survives as the ONE
master password per endpoint (local custody layer); the vault secrets are
per-vault seed phrases (the shipped v2 model); per-portfolio key granularity
is available by giving a portfolio its own vault. The r2 wording "device
password (per device)" with a per-vault raw-storage opt-in is superseded by
this section: one master password per endpoint, protection level per vault.

## 4. Data model

- `portfolios.vault_id` (nullable FK → `vaults.id`): **the** paranoid flag.
  `vault_id IS NULL` ⇒ normal portfolio, today's behavior byte-for-byte.
  `vault_id IS NOT NULL` ⇒ vaulted: zero cleartext content rows server-side
  (enforced by the join transaction's per-table probe and CI's classification
  completeness test), `portfolios.alias` renders the locked row.
- `vaults` (id — client-minted, userId, name, backends, createdAt) and
  `vault_docs` (vaultId, docKind `header`|`common`|`portfolio`, portfolioId?,
  ciphertext, version, updatedAt): the blind store. The server never parses
  past what CAS needs; sizes capped (header 1 MB, common 4 MB, portfolio
  8 MB, DB-CHECK-enforced).
- The 26 vault entity kinds split 13/13 between `portfolio` docs and the
  `common` doc exactly per VAULTS_V2_DESIGN §20 (normative, vector-pinned).
  The v1 note's `PARANOID_TABLE_CLASSIFICATION` completeness discipline
  survives **re-keyed to the portfolio scope**: every schema table must be
  classified, and a `vault`-classified table is automatically enrolled in the
  join purge + probe and the leave restore — a future table cannot silently
  leak (rewrite, not delete; Appendix A).
- **Endpoint keystore (client-local only):** the §3 master-password record
  (KDF salt, verifier) and the wrapped/clear seed-phrase entries live in
  device storage (IndexedDB / platform storage). **No server table** — the
  server learns nothing about endpoint custody.
- **Deleted:** `users.privacy_mode` (+ its enum), the paranoid media columns
  on `users`, and the seven account-wide vault tables (exact list in
  Appendix A). No schema row anywhere says "this ACCOUNT is paranoid",
  because that is no longer a fact about accounts.

## 5. Enforcement — the per-portfolio exclusion matrix (replaces KILLED_SCOPES)

The v1 model enforced privacy account-wide: one route-group guard answering
`403 PARANOID_MODE` for the whole account plus a bearer **kill rail**
(`KILLED_SCOPES`) that refused portfolio/cash/tax/import/mirrorchain scopes
for ANY token of a paranoid account. That model dies with the account-wide
mode. Its replacement is keyed on the **portfolio**:

**The account keeps everything.** Profile, chat, friends, social surfaces,
comments/reactions, watchlists, conglomerates, alerts, API keys and OAuth
grants, imports, mirrorchain, and the full feature set of every non-vaulted
portfolio — including sharing them and reading them over bearer scopes.

**The vaulted PORTFOLIO is excluded from** (each item enforced server-side at
the portfolio boundary, surfaced client-side as absent affordances on that
portfolio, and covered by one registry-driven matrix test):

1. **Sharing/public** — cannot be shared, added to an audience, or surfaced
   on a public profile; share attempts answer the portfolio-scoped refusal.
2. **Nesting, both directions (PP2)** — cannot nest others, cannot be nested.
3. **Connections/sync (PP4/PP5/PP6)** — cannot hold a provider mapping; sync
   engines never see it.
4. **Server-computed reads** — summary/series/analytics/tax/report endpoints
   for that portfolio refuse; the client engine computes them from the
   decrypted doc.
5. **Server jobs** — snapshots, dividend/earnings scans, standing-order
   execution: skip it (its input tables hold no rows for it — the probe
   guarantees this stays true).
6. **Imports** — an import cannot target it server-side; vaulted-portfolio
   entry is client-side only.
7. **Portfolio-scoped API access to it** — a bearer request addressing the
   vaulted portfolio gets the same refusal a session gets. The scope itself
   stays valid (next paragraph).

**Bearer scopes are never account-killed.** `KILLED_SCOPES` and the
account-wide `PARANOID_MODE` rail are deleted. A token with
`portfolio:read`/`portfolio:write`, `cash:read`/`cash:write`,
`mirrorchain:*`, tax or import scopes works normally against every
non-vaulted portfolio of any account — **this permanently fixes cash on
mobile** for accounts that also own vaulted portfolios, which the
account-wide rail broke by construction. `vault:sync` remains the deliberate
ciphertext path (per-vault CAS routes, session-only transitions — the #1049
discipline, already re-scoped by #1176; the 0081 first-party seed stays).
Addressing a VAULTED portfolio over a portfolio scope is refused per item 7
with a portfolio-scoped error, not with an account-wide 403.

**Mechanics:** one guard keyed on the resolved portfolio's `vault_id`, driven
by one registry (the enforcement registry pattern survives from v1 — rewrite,
not delete). The seed already shipped in #1176:
`createVaultedPortfolioRouteGuard` + `VAULTED_PORTFOLIO_PATH_RULES`
(`apps/api/src/services/vault/vaultedPortfolioGuard.ts`) and the
`PARANOID_PORTFOLIO_SCOPED_CAPABILITIES` subset inside the v1 registry
(`portfolioServer`, `portfolioJobs`, `sharing`, `mirrorchain`, `imports`,
`standingOrderExecution`); WP2 grows that seed into the full matrix and the
account-keyed remainder dies. Refusals use the shipped error families (a
non-vaulted portfolio on a vault route answers
`VAULT_PORTFOLIO_NOT_VAULTED`). The registry × route matrix test
(`paranoidEnforcementCompleteness.test.ts` — every route, service method and
job must be classified) survives re-keyed portfolio-first and **much
smaller** in its killed set. `MeResponse.privacyMode` (#1052/#1055) is
retired with the account mode; bearer clients detect vaulting per portfolio
(`GET /vaults` narrow projection + `vaultId` on portfolio rows), which the
mobile contract already consumes.

## 6. Storage-axis interplay (PP3 boundary)

Paranoid is the **passphrase tier on top of the PP3 storage axis** — the
umbrella #658 matrix is verbatim and binding. The account-key tier
(`bt+drive-backup`, `drive-only` with the server-held account storage key) is
**NOT paranoid**: the server holds the key, the account's devices read
transparently, and no seed phrase exists. A portfolio is paranoid only
through vault membership. Vault backends (`server`/`drive`/`both`, per vault
— the owner spec's reason (b) for multiple vaults) are the paranoid
instantiation of the same media discipline: Drive OAuth entirely client-side
(`drive.appdata` only, no server-held tokens — binding, unchanged),
migrate-then-drop with verified round trips on backend changes, independent
CAS per medium with per-document merge reconcile (VAULTS_V2 §13/§17). PP3
must not build anything that conflicts with per-vault seed-phrase custody;
PP3's `DataHome` adapters and the vault's are the same seam (§8).

## 7. Cross-portfolio composition — tax and aggregates (charter items 4–5)

Mixed accounts are the norm, so every cross-portfolio quantity is a
**client-side merge of server-computed plain figures and client-computed
vaulted figures**:

- **Tax (§16 decision, binding):** cross-portfolio tax with a vaulted
  portfolio in the mix (AT Verlustausgleich spans portfolios) is
  client-composed — the server computes figures for plain portfolios exactly
  as today (#635/#656 engine as merged, including the closed-year lock
  boundary recorded there and the 2026-08-07 year-lock ritual), the client
  computes the vaulted portfolios' figures through the SAME audited
  `packages/domain` tax code (never reimplemented — the v1 review-blocking
  rule stands), and the browser merges. The merge happens at the figure level
  the domain engine defines (per-year, per-pot), never by re-implementing
  offset rules in view code. While any involved vault is locked, tax
  composition renders the lock qualifier instead of a silently-partial
  figure (next item).
- **Aggregate views:** dashboard all-portfolios net worth, combined reports,
  and any cross-portfolio total render **sum-of-visible plus a mandatory lock
  qualifier** ("+ N locked portfolios") while any vault is locked — never a
  bare total; `lockedExcluded` is the fourth coverage state. Identical
  arithmetic web and mobile (shipped, VAULTS_V2 §12; this note extends the
  same rule to combined reports and tax composition).
- **Unlocked** vaults contribute client-computed figures indistinguishable in
  presentation from server figures — same pages, same components, through the
  `PortfolioStore` seam.

## 8. Autonomy seams (binding, carried forward)

The three client seams remain architecture-binding beyond paranoid, verbatim
from v1: **`PortfolioStore`** (per-portfolio read/write surface;
`apiPortfolioStore` for plain portfolios, the vault-backed store for vaulted
ones — now resolved PER PORTFOLIO, not per account), **`DataHome`** (server /
Drive / local-cache blob adapters, shared with PP3), **`MarketDataSource`**
(BT API today; direct-provider later). Every v6+ client feature that touches
portfolio or market data goes through them (review criterion, both apps).

## 9. UX charter (owner spec, binding)

- **Keep the tone, redesign the pages.** The explanatory voice of the shipped
  explainer/wizard is right ("I like how it's getting explained" — keep it);
  the PAGES are overcrowded, confusing, badly designed. Redesign for radical
  simplicity and progressive disclosure — main things visible, everything
  else folded (the standing anti-bloat rule).
- **Setup is a handful of intuitive steps.** The full path — set the master
  password → create a vault (name, backend, 12 words shown once + confirmed)
  → put a portfolio in — must be a handful of steps, not today's ~20
  unintuitive ones. The step count is a gate criterion (WP6), owner-eyed.
- **Every vault state carries its affordance — a state without a next action
  is a design bug.** Documented live dead-end, recorded here as the
  anti-pattern: a LOCKED vault offers no unlock path anywhere, so a
  portfolio cannot be moved into it at all. Binding invariant: wherever a
  vault or vaulted portfolio renders (locked row, settings section,
  move-into-vault picker, aggregate lock chip), the render includes the
  state's action — unlock (master password), open (clear-stored), or
  import words / QR (not on this endpoint). The picker never offers a vault
  it cannot open without also offering the unlock inline. WP9 carries the
  state × surface affordance regression.
- **"I want that to fully work. Clean and understandable. Simple, easy."**
  The §14 breakdown ends in working software: a vaulted portfolio's day-to-day
  money surfaces (values, series, tax, standing orders, exports) work through
  the client engine, on web and mobile, with the redesigned UX — not an
  architecture that renders locked rows.
- EN + DE for every new string (binding i18n rule); phone viewports on the
  gate checklist as everywhere.

## 10. What does NOT exist (explicit, binding)

1. **No account-wide paranoid mode.** No `users.privacy_mode`, no
   account-level enable/disable/purge/rehydrate, no account-wide unlock gate
   replacing the authenticated subtree, no account-wide wizard. The
   Control-Center privacy surface points at the per-portfolio flow only.
2. **No forward-port and no migration of account-wide vault data.** The
   v1→v2 migration protocol is **voided unexecuted**: VAULTS_V2_DESIGN
   §3-migration/§11/§18/§23, the `/vaults/migration` +
   `/vaults/migration/claim|renew|flip` routes, the `If-Claim` write rail,
   the Drive claim-file protocol, the client migration/upgrade entry points,
   and conformance-vector family 4 (`v2Migration`) are all decommissioned
   without ever running against live data (Appendix A). VAULTS_V2_DESIGN.md
   is amended accordingly in the deletion PRs.
3. **No legacy `/vault` account-singleton surface.** The v1 blob routes
   (GET/PUT `/vault`, media, history, server-candidates, retirement/purge),
   the `/account/paranoid/*` transition routes, fork-provenance capture, the
   normal-revision capture↔commit token, and the retirement-proof signed
   purge gate are deleted with the mode they served. (Per-vault
   `clientSecurity` inside the v2 `common` doc is unaffected — it is vault
   substrate, not account surface.)
4. **No account-wide kill rail.** `KILLED_SCOPES`, the account-keyed
   `PARANOID_MODE` guard, and the account-keyed enforcement registry die;
   §5's portfolio-keyed matrix replaces them.
5. **No per-vault master passwords** (owner spec: "never") and **no
   server-side anything for endpoint custody** — no escrow, no reset, no
   support recovery for seed phrases; master-password reset is a local
   keystore reset, never a server flow.
6. **Recorded non-goals (owner, #658 + spec reason a):** encrypted-portfolio
   sharing is FAR future — `keySlots[]` keeps it possible, no flows are
   designed now; full client autonomy stays a direction the seams keep open,
   not a deliverable; heavy client features may phase to a later version
   (owner pre-approved).

## 11. Interplay: exports, deletion, admin, mirrorchain

- **Account export:** the zip carries `server`-classified data plus — for
  vaults whose backends include `server` — the ciphertext docs and manifest
  entries; never cleartext vaulted content, never key material (seed phrases
  and the endpoint keystore are device-local and are never exported).
  The client-side cleartext export of an UNLOCKED vault's portfolios remains
  the user's own exit (v1 §12 semantics, per vault).
- **Account deletion:** the sweep also deletes the account's `vaults` and
  `vault_docs` rows; Drive files are the user's own property (best-effort
  client delete when reachable, said plainly in the confirm).
- **Admin:** per-user view shows vault count, per-vault backend set, doc
  sizes/versions/timestamps — no portfolio numbers to show, which is the
  feature. Admin can never reset a seed phrase or master password or read a
  doc.
- **Mirrorchain:** a vaulted portfolio cannot create/join/be invited to a
  chain, and a chain member cannot be vaulted without leaving (fork) first —
  the same mutual exclusion as v1, now portfolio-scoped
  (`VAULT_JOIN_BLOCKED`); `docs/mirrorchain-design.md` §14 keeps the other
  side. Severed-fork provenance rides the owning vault's `common` doc
  (`mirrorProvenance`, shipped v2 member) with the v1 §7.1 validation
  discipline applied at portfolio-leave time.

## 12. Sibling-issue dispositions

- **#1188 (vault-side standing-order restore-tombstone parity): NOT mooted —
  re-scoped.** Its substance (deterministic `standingOrderOccurrenceId`
  UUIDv5 ids on vault-side portfolio restore; two-device convergence on the
  #1176/#1178 merge surface) is v2-surface work and remains required; the
  ruling only removes any obligation to fix the same behavior on the legacy
  account-singleton surface, which is deleted instead. Fold into WP8 (§14).
- **#1186 (QR import dialog unwired): absorbed** — wiring the receiving half
  of the QR handoff is exactly the "not on this endpoint" affordance §9
  requires; lands with WP3/WP6.
- **PP1/PP2/PP4/PP5/PP6 (#659/#660/#662/#663/#664):** unchanged in scope;
  their vaulted-portfolio exclusions are §5 items 2–3 and are enforced from
  this arc's registry, so those builds consume the guard rather than
  inventing their own.

## 13. Open questions for owner ack

Deliberately few — the 2026-08-12 spec answered the custody and UX unknowns.

1. **Legacy vault DATA disposition:** live accounts still in account-wide
   paranoid (if any) hold their portfolio data ONLY inside the legacy blob —
   their cleartext was purged at enable. Brute-deletion per the ruling means
   those accounts return to normal mode with EMPTY portfolios; their data
   survives only in the Appendix B backup (and any copies in their own
   Drive/exports). Confirm this is accepted — there is deliberately no
   forward-port alternative to offer.
2. **Backup scope + retention (Appendix B):** confirm the procedure — full
   dump via the existing backup sidecar + a targeted legacy-vault dump, both
   offsite, the legacy-final artifacts kept OUTSIDE the 14-day retention
   sweep until you explicitly discard them — before the deletion packages
   run.
3. **Master-password scope (conservative default, §3):** the endpoint master
   password protects vault seed phrases only — it is NOT a general app lock
   (PIN lock remains the app lock; no second idle timer). Confirm, or name
   the wider behavior you want.

## 14. Ack-gated implementation breakdown (for the composer)

Composed ONLY after the owner acks this note. **Ordering:** WP0 strictly
first (backup before any deletion); WP1+WP2 are one server train; WP3 lands
before WP6 (the UX sits on the custody model); WP4/WP5 before WP7 (nothing
that still renders through a v1 module may lose that module before its v2
replacement lands — main stays green at every merge); WP8 after WP4; WP9
last. Every package: suite green, EN+DE strings, migrations append-only,
OpenAPI/route-census/module-map regeneration where touched.

| WP                                                                         | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Label / tier                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **WP0 — Verified legacy backup (live ops, NOT a factory issue)**           | Execute Appendix B on the live box: full dump via the existing backup sidecar + targeted dump of the Appendix A data set; verify + offsite; record artifact ids on #665. Owner confirms per §13 Q2                                                                                                                                                                                                                                                                                         | ops (Chief-run); blocking gate for WP1/WP7                                    |
| **WP1 — Server decommission of the account-wide mode**                     | Delete the legacy `/vault` singleton + `/account/paranoid/*` routes and their services/repositories, the account-keyed guard/registry composition, `KILLED_SCOPES` + the bearer kill check, `MeResponse.privacyMode`, `PRIVACY_MODES` contract members, the server migration bridge (`/vaults/migration*`, `If-Claim`, `vaultMigrationRepository`); append drop migrations for the 7 legacy tables + `users` columns/CHECK/enum; re-key the table-classification axis portfolio-first (§4) | `diff:max` / T1 (one-way schema + security boundary)                          |
| **WP2 — Per-portfolio enforcement completion + bearer un-kill**            | Grow `createVaultedPortfolioRouteGuard` + `PARANOID_PORTFOLIO_SCOPED_CAPABILITIES` into the full §5 matrix (incl. job/webhook/import filters and the PP2/PP4 hooks); bearer scopes valid account-wide (headline regression: `cash:write` on a plain portfolio of a vault-owning account); matrix completeness test re-keyed                                                                                                                                                                | `diff:max` / T1 (security boundary; the matrix test is the durable guarantee) |
| **WP3 — Endpoint custody: master password + keystore + protection levels** | The §3 model: one master password per endpoint, Argon2id-derived key over a local keystore of ALL opted-in seed phrases; per-vault protection level with the signed clear-storage warning; rewrite `v2/devicePassphrase.ts`; wire the QR-import receiving half (#1186); mobile counterpart via the app-repo board                                                                                                                                                                          | `diff:max` / T1 (key custody)                                                 |
| **WP4 — Per-portfolio client money engine re-home**                        | `vaultPortfolioStore` + `engine/` + `standingOrders/` + `export/` re-homed from the account singleton onto per-vault v2 docs + the keyring; per-portfolio capture replaces `captureNormalVault`; `PortfolioStore` resolves per portfolio; per-portfolio tax report                                                                                                                                                                                                                         | `diff:max` / T1 (money math through `packages/domain`)                        |
| **WP5 — Per-vault media runtime**                                          | `drive/` + `media/` + data homes re-scoped to per-vault doc sets (`btv2.*` Drive naming); v2 reconcile driver wired as the `both` path; per-vault sync status surfaced                                                                                                                                                                                                                                                                                                                     | `diff:hard` / T2                                                              |
| **WP6 — Vault UX redesign (the §9 charter)**                               | Redesigned pages keeping the tone; setup in a handful of steps (gate-checked count, owner-eye); the state → affordance invariant on every surface incl. the locked-vault dead-end fix; progressive disclosure; EN+DE                                                                                                                                                                                                                                                                       | `diff:hard` / T2 (flagship UX)                                                |
| **WP7 — Web decommission + migration-machinery removal**                   | Delete the v1-only client modules + account-wide UI surfaces (Appendix A delete list); Control-Center → per-portfolio only; remove client migration machinery (`v2/migration.ts`, `v2/migrationCrypto.ts`, `drive/driveMigrationClaim.ts`, `v2Migration` vectors, `upgrade.ts` legacy entry points); amend VAULTS_V2_DESIGN.md §3/§11/§18/§23/§25                                                                                                                                          | `diff:hard` / T2                                                              |
| **WP8 — Cross-portfolio composition**                                      | §7 client-composed tax (mixed accounts, lock qualifier) + combined reports; #1188 folded in (deterministic occurrence ids on v2 restore, two-device convergence)                                                                                                                                                                                                                                                                                                                           | `diff:max` / T1 (money)                                                       |
| **WP9 — e2e + gate**                                                       | Playwright: mixed-account sweep (vaulted + plain side by side — sharing/nesting/sync refusals, bearer cash on the plain portfolio, locked-total qualifiers, per-vault Drive round trip, full setup flow at the §9 step count, state × surface affordance regression); zero-cleartext probe as a standing invariant; mobile contract re-confirmation                                                                                                                                        | `diff:intermediate` / T2                                                      |

## 15. Traceability

| Source item                                                                      | Where decided                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Charter 1 — scope = portfolio, mixed accounts, per-portfolio transitions         | §1, §4; join/leave shipped (#1176)                                    |
| Charter 2 — key hierarchy                                                        | §3 (superseded by the 2026-08-12 owner spec, reconciliation recorded) |
| Charter 3 — kill list dissolves into per-portfolio exclusions                    | §5                                                                    |
| Charter 4 — cross-portfolio tax client-composed                                  | §7                                                                    |
| Charter 5 — aggregate views for mixed accounts                                   | §7                                                                    |
| Charter 6 — storage-tier interplay                                               | §6                                                                    |
| Charter 7 — recorded non-goals                                                   | §10 item 6                                                            |
| Ruling — no legacy support / no forward-port / brute-delete WITH backup          | §10, Appendix A, Appendix B, WP0/WP1/WP7                              |
| Ruling — mobile bearer-scope story                                               | §5 (bearer un-kill), WP2                                              |
| Spec — per-endpoint master password, one per endpoint, local seed-phrase custody | §3, WP3                                                               |
| Spec — flow: activate → create vaults → assign portfolios                        | §3, §9, WP6                                                           |
| Spec — multi-vault reasons (sharing / backend / protection level)                | §3, §6, §10 item 6                                                    |
| Spec — clear-stored seed phrase behind a signed warning                          | §3, WP3                                                               |
| Spec — UX charter (tone, steps, state affordances, dead-end)                     | §9, WP6, WP9                                                          |
| Spec — "fully work"                                                              | §9, WP4/WP5/WP6 end-state, WP9                                        |
| New ack gate                                                                     | §13 + the `awaiting-owner` gate issue filed with the PR               |

---

## Appendix A — deletion inventory (code)

Classification: **DELETE** = removed outright once WP0's backup is verified
and the owner has acked; **KEEP** = v2 foundation, stays as-is; **REWRITE** =
the mechanism survives re-keyed (per-portfolio / per-vault / per-endpoint).
File paths repo-relative. Tests follow their subject's classification unless
named.

### A.1 apps/api

| Artifact                                                                                                                                                                                                                      | Class                 | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http/routes/vaultRoutes.ts` (552) — GET/PUT `/vault`, history, media, server-candidate, retired-purge/challenge                                                                                                          | DELETE                | the whole account-singleton blob surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/http/routes/accountRoutes.ts` — the four `/account/paranoid/*` routes (`enable`, `disable`, `fork-provenance`, `normal-revision`) + `PARANOID_DISABLE_HTTP_PATH`, `paranoidDisableJsonLimitBytes`                        | DELETE (partial file) | account transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/services/account/paranoidVaultService.ts` (419)                                                                                                                                                                          | DELETE                | v1 blob service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/services/account/paranoidTransitionService.ts` (671)                                                                                                                                                                     | DELETE                | enable pipeline + staging TTL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/services/account/paranoidRehydrationService.ts` (2684)                                                                                                                                                                   | DELETE                | disable/rehydrate — largest v1 file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/services/account/paranoidDiscardReauth.ts` (121)                                                                                                                                                                         | DELETE                | discard re-auth gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/data/repositories/paranoidVaultRepository.ts` (1327)                                                                                                                                                                     | DELETE                | CAS/history/candidate/retirement persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/data/repositories/paranoidTransitionRepository.ts`, `paranoidRehydrationRepository.ts`                                                                                                                                   | DELETE                | transition persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/services/account/paranoidEnforcement.ts` (2253)                                                                                                                                                                          | REWRITE               | keep `PARANOID_PORTFOLIO_SCOPED_CAPABILITIES`, `isVaultedPortfolioKilledCapability`, the owned-subject (`vaultId`) checks, the `PARANOID_MODE` error code; delete `createParanoidRouteGuard`, `createParanoidModeGuard`, the account-keyed `PARANOID_KILL_REGISTRY` composition, `PARANOID_SERVICE_BINDINGS`/exemptions/`PARANOID_JOB_POLICIES` account keying, `PARANOID_API_SCOPE_CLASSIFICATIONS`, and **`KILLED_SCOPES`** (`portfolio:read`, `portfolio:write`, `tax:read`, `tax:write`, `import:read`, `import:write`, `cash:read`, `cash:write`, `mirrorchain:read`, `mirrorchain:write` — the four `tax:*`/`import:*` entries are dead strings that are not even `API_KEY_SCOPES` members) |
| `src/data/repositories/paranoidEnforcementRepository.ts`                                                                                                                                                                      | REWRITE               | account privacy-mode locks die; the `ParanoidOwnedSubject.vaultId` view survives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/jobs/paranoidJobs.ts`                                                                                                                                                                                                    | REWRITE               | job filter re-keyed: jobs skip vaulted portfolios, not paranoid users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/jobs/definitions/retentionJobs.ts` — enable-staging prune                                                                                                                                                                | DELETE (partial)      | staging table dies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/http/middleware/bearerAuth.ts`                                                                                                                                                                                           | REWRITE               | delete `VAULT_SYNC_BEARER_ROUTE_ALLOWLIST` (v1 `/vault` rows) + the `isParanoidKilledScope` check (L614); keep the v2 `VAULTS_SYNC_BEARER_ROUTE_ALLOWLIST`, session-only pins (minus migration rows)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/app.ts` (guard mounts), `src/http/context.ts` (`paranoidVault`, `paranoidTransitions`, `paranoidGuard` threading into ~15 services)                                                                                      | REWRITE (partial)     | unmount v1, keep `vaults` + vaulted-portfolio guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/services/vault/vaultedPortfolioGuard.ts`, `vaultService.ts`, `data/repositories/vaultRepository.ts`, `vaultPortfolioPurge.ts`, `src/http/routes/vaultsRoutes.ts`                                                         | KEEP                  | the v2 surface (minus migration routes below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/http/routes/vaultsRoutes.ts` — `GET /vaults/migration`, `POST /vaults/migration/claim\|renew\|flip`                                                                                                                      | DELETE (partial)      | migration voided unexecuted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/data/repositories/vaultMigrationRepository.ts` (199) + the `If-Claim` enforcement in the doc-write path                                                                                                                  | DELETE                | v1→v2 bridge dies with v1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/services/oauth/firstPartyClients.ts` + seed `drizzle/0081_…` (`vault:sync` on BetterTrackMobile)                                                                                                                         | KEEP                  | `vault:sync` survives per §5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tests: `__tests__/vault.test.ts` (1234), `vaultBearerSync.test.ts` v1 halves, `services/account/__tests__/paranoidEnforcement.test.ts` (2498), `bearerAuth.paranoid.test.ts`, transition/rehydration suites (~15 named files) | DELETE/REWRITE        | follow their surfaces; `paranoidEnforcementCompleteness.test.ts` is REWRITE (re-keyed, stays the completeness gate); `vaultsV2.test.ts` KEEP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### A.2 Schema + migrations (all drops via NEW append-only migrations — the migration-immutability gate stands)

| Artifact                                                                                                                                                                                                                                                                                 | Class          | Note                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Tables `paranoid_vaults` (incl. bridge cols `migrating_by`, `migration_expires_at`, `migrated_to`), `paranoid_vault_history`, `paranoid_vault_server_candidates`, `paranoid_vault_retirements`, `paranoid_vault_retired`, `paranoid_rehydration_receipts`, `paranoid_enable_transitions` | DELETE         | the seven account-keyed tables (created by 0069/0070/0072/0082/0087)                                                       |
| `users.privacy_mode` (+ enum `privacy_mode`), `users.paranoid_media_set`, `users.paranoid_drive_attested_version`, CHECK `users_paranoid_media_state`                                                                                                                                    | DELETE         | account-mode columns; dropping them is what returns any legacy-paranoid account to normal (with empty portfolios — §13 Q1) |
| Tables `vaults`, `vault_docs`, `vault_leave_receipts`; `portfolios.vault_id`, `portfolios.alias`; enums `vault_backends`, `vault_doc_kind` (migration 0087)                                                                                                                              | KEEP           | the v2 store                                                                                                               |
| Released migrations 0069/0070/0072/0081/0082/0087                                                                                                                                                                                                                                        | KEEP (history) | immutable journal; objects dropped by the new migration                                                                    |

### A.3 packages/

| Artifact                                                            | Class            | Note                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/src/vault.ts` (1737)                                     | REWRITE (trim)   | keep the vault-document entity-kind schemas (consumed by the v2 split/capture) and shared crypto constants; DELETE `PRIVACY_MODES`/`privacyModeSchema`, media-set/candidate/retirement/history/transition DTOs, the account `vaultEtag` surface |
| `contracts/src/vaults.ts`, `vaultV2.ts`                             | KEEP (trim)      | DELETE `VAULT_IF_CLAIM_HEADER`, `VAULT_MIGRATION_CLAIM_TTL_MS`, migration error codes (`VAULT_MIGRATION_CLAIMED`/`VAULT_MIGRATION_INCOMPLETE`) with the machinery                                                                               |
| `contracts/src/webhooks.ts` — `PARANOID_KILLED_WEBHOOK_EVENT_TYPES` | REWRITE          | portfolio-filtered event suppression replaces the account kill                                                                                                                                                                                  |
| `contracts/src/apiKeys.ts` — `vault:sync` in `API_KEY_SCOPES`       | KEEP             | §5                                                                                                                                                                                                                                              |
| `domain/src/vaultVectors/v1.ts` (175)                               | DELETE           | the v1 BTVAULT1 account-envelope family loses every producer/consumer                                                                                                                                                                           |
| `domain/src/vaultVectors/v2.ts` — family 4 (`v2Migration`)          | DELETE (partial) | migration voided; families 1–3, 5–6 KEEP                                                                                                                                                                                                        |

### A.4 apps/web (`src/user/vault/`, 72 v1 source files excluding `v2/`; 31 v1 test files follow their modules)

| Group                                                                                                                         | Class        | Files                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared substrate v2 already imports                                                                                           | KEEP (7)     | `errors.ts`, `bytes.ts`, `crypto.ts`, `hkdf.ts`, `canonicalJson.ts`, `merge.ts`, `envelope.ts`                                                                                                                                                                          |
| Client money/tax engine                                                                                                       | REWRITE (14) | `engine/*` — re-homed per-portfolio on v2 docs (WP4); money math stays in `packages/domain`                                                                                                                                                                             |
| Standing orders, exports                                                                                                      | REWRITE (10) | `standingOrders/*`, `export/*` — per-portfolio (WP4)                                                                                                                                                                                                                    |
| Media + Drive + data homes                                                                                                    | REWRITE (14) | `media/*` (8), `drive/driveDataHome.ts`, `drive/gisTokenClient.ts`, `drive/index-ish` (3 of 4), `dataHome.ts`, `localDataHome.ts`, `serverBlobDataHome.ts` — re-scoped per vault (WP5)                                                                                  |
| Store + sync + restore                                                                                                        | REWRITE (7)  | `vaultPortfolioStore.ts` (4067), `sync.ts` (1213), `restore.ts`, `quarantine.ts`, `mirrorProvenance.ts`, `assetSnapshot.ts`, `ui/migration.ts` (`captureNormalVault` → per-portfolio capture; the ONE v1 UI module v2 imports today)                                    |
| Account-mode runtime + custody + transitions                                                                                  | DELETE (13)  | `VaultRuntimeProvider.tsx`, `VaultRuntimeContext.ts`, `VaultAccountRoot.tsx`, `usePrivacyMode.ts`, `lock.ts`, `lockSignal.ts`, `custody.ts`, `rekey.ts`, `paranoidDisable.ts`, `plaintextQueries.ts`, `migration.ts`, `recovery.ts` (v1 raw-key kit), `index.ts` (trim) |
| Account-mode UI                                                                                                               | DELETE (6)   | `ui/VaultUnlockGate.tsx`, `ui/ParanoidEnableWizard.tsx`, `ui/enable.ts`, `ui/disable.ts`, `ui/VaultSyncChip.tsx`, `ui/ParanoidSurfaceGate.tsx`                                                                                                                          |
| Drive migration claim                                                                                                         | DELETE (1)   | `drive/driveMigrationClaim.ts`                                                                                                                                                                                                                                          |
| Outside `vault/`: `AccountModeRoot.tsx`, `control/panels/PrivacyVaultSection.tsx`, `control/panels/ParanoidAccountExport.tsx` | DELETE       | account-wide surfaces; `control/panels/PrivacyPanel.tsx`, `OriginShell.tsx`, `CmdKPalette.tsx`, `commands.ts`, `sectionNav.ts` are partial edits                                                                                                                        |
| `portfolio/ParanoidTaxReport.tsx`                                                                                             | REWRITE      | per-portfolio tax report (WP4/WP8)                                                                                                                                                                                                                                      |
| `v2/*` (52 files)                                                                                                             | KEEP (49)    | minus: `v2/migration.ts`, `v2/migrationCrypto.ts` DELETE; `v2/devicePassphrase.ts` REWRITE (per-vault device custody → the §3 endpoint keystore); `v2/upgrade.ts` REWRITE (keep doc-building for capture, drop the legacy-split entry)                                  |
| E2E: `e2e/paranoid.spec.ts` (784), `e2e/support/pd9.ts`, `pd9Drive.ts`                                                        | DELETE       | replaced by the WP9 mixed-account suite; `e2e/mobile-overflow.spec.ts` v2 halves KEEP                                                                                                                                                                                   |

### A.5 Env / config

| Artifact                                                                                                                         | Class  | Note                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `BT_VAULT_MAX_BYTES`, `BT_VAULT_HISTORY_MAX_VERSIONS`, `BT_VAULT_HISTORY_MAX_AGE_DAYS` (env.ts, `infra/.env.production.example`) | DELETE | v1 body sizing + history retention; v2 caps are contract constants + the `vault_docs_size_cap` CHECK |
| `BT_VAULT_RATE_WINDOW_SEC`, `BT_VAULT_RATE_LIMIT` (`limiters.vault`)                                                             | KEEP   | the limiter is shared with the v2 routes                                                             |
| `PRIVACY_MODES`                                                                                                                  | n/a    | never an env var — a contracts constant (A.3); no paranoid/vault feature flag exists anywhere        |

**Summary counts:** apps/api — 8 dedicated files DELETE, 3 REWRITE, 1 bridge
DELETE, 6 partial edits, 5 v2 files KEEP. apps/web — of 72 v1 source files:
20 DELETE, 45 REWRITE, 7 KEEP; of 52 v2 files: 49 KEEP, 2 DELETE, 1 REWRITE
(+1 trim); ~8 files outside `vault/` deleted or edited. Schema — 7 tables +
3 `users` columns + 1 CHECK + 1 enum DELETE; 3 tables + 2 `portfolios`
columns + 2 enums KEEP.

## Appendix B — live DATA: what holds account-wide vault bytes, and the backup that precedes deletion

**Who runs this:** the Chief, on the live box (compose project
`bettertrack-live`), by hand — never the factory, never a PR, and nothing in
this docs PR touches live. WP1 does not merge until the artifacts below are
verified and recorded on #665 and the owner has confirmed §13 Q1+Q2.

**B.1 What holds account-wide vault data on live**

- `paranoid_vaults` — the active ciphertext blob per paranoid account
  (bytea) + version metadata (+ unexecuted bridge columns).
- `paranoid_vault_history` — bounded ciphertext history (last 10 versions /
  30 days).
- `paranoid_vault_server_candidates`, `paranoid_vault_retired`,
  `paranoid_vault_retirements` — media-transition staging + the retired
  recovery set + retirement proof keys.
- `paranoid_rehydration_receipts`, `paranoid_enable_transitions` —
  transition bookkeeping (no blob bytes).
- `users.privacy_mode`, `users.paranoid_media_set`,
  `users.paranoid_drive_attested_version` — which accounts are paranoid and
  their media state.
- NOT affected: `vaults`/`vault_docs` (v2, stays), the `oauth_clients`
  `vault:sync` seed (stays), users' own Google-Drive copies (their property;
  never touched by us).

**B.2 Backup procedure (existing conventions — the `backup-scheduler`
sidecar, `infra/backup/`)**

1. **Full dump:** take the day's scheduled artifact (03:00 UTC cron) or
   trigger `backup.sh` in the backup container now. Convention:
   `pg_dump --clean --if-exists --no-owner | gzip` →
   `/backups/bettertrack-<UTC yyyymmdd-HHMMSS>.sql.gz` in the `pgbackups`
   volume, `last_artifact` + `last_artifact_sha256` recorded in the status
   file (`backupstatus` volume).
2. **Targeted legacy-final dump** (so the legacy bytes survive independently
   of the 14-day full-dump rotation), from inside the db container:
   `pg_dump -Fc -U "$DB_USER" -d "$DB_NAME" --table=paranoid_vaults
--table=paranoid_vault_history --table=paranoid_vault_server_candidates
--table=paranoid_vault_retirements --table=paranoid_vault_retired
--table=paranoid_rehydration_receipts --table=paranoid_enable_transitions`
   → `/backups/bettertrack-legacy-vault-final-<UTC ts>.dump`, plus a CSV
   extract of the `users` privacy columns:
   `\copy (SELECT id, email, privacy_mode, paranoid_media_set,
paranoid_drive_attested_version FROM users WHERE privacy_mode <> 'normal'
OR paranoid_media_set IS NOT NULL) TO
'/backups/bettertrack-legacy-vault-users-<UTC ts>.csv' CSV HEADER`.
3. **Verify:** `gunzip -t` the full dump; `pg_restore --list` on the `-Fc`
   dump; `sha256sum` all three artifacts; log per-table row counts
   (`SELECT count(*)` for the seven tables + the paranoid-user count) beside
   the hashes.
4. **Offsite:** confirm the #481 offsite sidecar uploaded ALL artifacts
   (status keys `offsite_outcome`, `offsite_uploaded_count`). The
   `legacy-vault-final` artifacts are additionally copied OUT of the
   retention-swept `/backups` dir (control-dir backup area or equivalent) so
   `BACKUP_RETENTION_DAYS=14` cannot age them out — they are kept until the
   owner explicitly discards them (§13 Q2).
5. **Record** artifact names, sha256 sums and row counts as a comment on
   #665. Only then is WP0 satisfied.

**Restore path (if ever needed):** the `-Fc` dump restores the seven tables
byte-identically (`pg_restore --data-only --table=…`); the ciphertext is
useless without the account owner's key material — the backup preserves
bytes, not readability, which is exactly the property the vault always had.
