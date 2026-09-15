# Paranoid vaults — design history (archive)

Moved out of `docs/paranoid-design.md` on 2026-09-02 (owner-ordered doc
condensation, the post-E9 half PR #1571 deferred). Every block below is
**verbatim** — byte-identical to the text it replaced, not edited, paraphrased
or summarised. This file is **append-only**: entries are never rewritten or
deleted, and a later era is appended below rather than merged in.

It holds the arc's NARRATIVE: the supersession record, the transition analysis
now that E9 has executed the machinery, the alternatives considered and not
built, the bookkeeping list of documents to rewrite, and the epic
decomposition. Every **ruling** stayed behind in `docs/paranoid-design.md`,
which remains the single normative document — if anything here disagrees with
it, the live note wins.

**Contents:** A. The supersession record · B. §17 transition — evidence and the
alternatives not built · C. §19 — the documents-to-rewrite list · D. §20 —
build decomposition (the epic table)

---

## A. The supersession record

From the note's status block, before the post-E9 condensation replaced it with
a pointer here.

> (§2 below, verbatim — the binding text). It supersedes the account-level model
> of the 2026-07-21 #651 note that previously lived at this path, the 2026-07-17
> account-level clarification in §13.5, and — where anything differs — the
> 2026-08-12 per-portfolio spec on #665 (whose aligned parts it absorbs: per-vault
> 12-word seed phrases, one device password per endpoint, protection levels, QR
> handoff, the UX charter). The one-implementation ruling recorded in §16 on
> 2026-08-19 (PR #1392) stands: this redesign REPLACES the account-level model
> inside the single paranoid implementation — it is not a second variant, and the
> torn-down per-portfolio "vaults v2" surface is not resurrected (its data is
> quarantined as `zz_vault_v2_backup_*`; no port function). Implementation issues
> are composed ONLY after the owner acks this note; deviations found during
> implementation go back through PROJECTPLAN §16.

---

## B. §17 — evidence for the (C) ruling, and the alternatives not built

E9 (#1419) shipped the machinery for this plan; `docs/ops.md` carries the
owner-run runbook and `docs/paranoid-design.md` §17 keeps the ruled sequence
and the 2026-08-29 ordering ruling. The analysis below is what justified the
choice at the time.

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

---

## C. §19 — the transition-era list of documents to rewrite

The "Rewritten" half of §19. All four items are done: this note and the
PROJECTPLAN cell landed with the 2026-08-19 redesign PR, the mirrorchain
wording landed with E2, and the Drive-naming addendum is recorded in the live
§8 as still unwritten.

**Rewritten:** this note (done), PROJECTPLAN §13.5 V5-P13 arc (b) (same PR),
`docs/mirrorchain-design.md` §14 wording account→portfolio (in the E2 epic),
the mobile PLATFORM_ASKS Drive-naming contract (§8, when E5 lands).

---

## D. §20 — build decomposition (epics, ordered)

The epic table as written when the arc was cut, followed by the ordering rule.
All eleven epics are merged; what remains open from each is named in place in
the live note, not here.

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
