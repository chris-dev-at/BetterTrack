# MIRRORCHAIN — group portfolios design note (V5-P7)

**Status:** binding design, §16-logged 2026-07-18 (issue #578). Merged BEFORE any
P7 feature code per the §13.5 design-note-first rule. The implementation issues in
§12 build against this text; every "planner-defined" point in the §13.5 spec row
is decided here. Deviations found during implementation go back through §16.

**The model in one paragraph.** A MIRRORCHAIN is ONE logical portfolio that
exists as a **real, ordinary `portfolios` row in every member's account** (a
_copy_). Any member's write to their copy is recorded as an **operation** in a
per-chain, totally-ordered oplog and re-applied — through the normal service
layer — to every other copy, attributed to the acting member. Because each copy
is a normal portfolio, everything that already works per portfolio (holdings,
TWR, snapshots #553, tax V3-P4, analytics, sharing, alerts) works per copy with
**zero changes**, and "kick keeps a fork" is trivially true: severing the link
leaves a fully materialized, fully working portfolio behind. Sync is entirely
server-side logical replication between rows of one Postgres database — there is
no cross-device transport and **a member never configures anything**.

Glossary: _chain_ = the logical group portfolio; _copy_ = one member's
materialization; _op_ = one replicated write in the chain oplog; _origin copy_ =
the acting member's copy (where the write is first applied); _fork_ = a copy
whose membership ended and which is now a normal, un-synced portfolio;
_watermark_ = the highest op seq a copy has applied.

---

## 1. Data model

Design choice — **N real portfolio rows + chain link tables**, not one shared row
with a membership join. A shared row would force every portfolio-scoped engine
(snapshots, tax settlement, cash ledger, TWR, audiences) to become
membership-aware and would require materializing a copy at kick time — the most
failure-prone operation at the worst moment. With real copies, the fork already
exists, per-copy tax/TWR hold by construction, and a member's account deletion
cascades exactly their copy away. **No existing table changes**; everything below
is additive.

New tables (exact DDL is issue M1's job; constraints here are binding):

- **`mirror_chains`** — `id` (uuidv7 PK), `name` (chain-scoped, see below),
  `status` enum `active | dissolved`, `last_seq` bigint not null default 0 (the
  op counter — §2), `created_by` uuid FK users ON DELETE SET NULL +
  `created_by_username` text (denormalized), `created_at`, `dissolved_at`.
  Chain rows are **never hard-deleted** (they anchor attribution and history for
  forks); a chain with no active members flips to `dissolved`.
- **`mirror_chain_members`** — `id` PK, `chain_id` FK, `user_id` uuid **nullable**
  FK users ON DELETE SET NULL, `username` text (denormalized at join — renders
  "alice (account deleted)" after SET NULL, the chat-anonymization pattern of §16
  2026-07-09), `portfolio_id` uuid **nullable** FK portfolios ON DELETE SET NULL
  (the copy; tombstones must survive the copy), `role` enum
  `owner | manager | member`, `status` enum
  `active | left | removed | dissolved | account_deleted`, `applied_seq` bigint
  not null default 0 (this copy's watermark), `joined_at`, `invited_by` uuid SET
  NULL, `ended_at`. Invariants as partial unique indexes over `status='active'`:
  exactly ≤1 `role='owner'` per chain; ≤1 row per `(chain_id, user_id)`; ≤1 row
  per `portfolio_id` (a portfolio belongs to at most one chain). Ended
  memberships are kept forever as tombstones.
- **`mirror_chain_invites`** — `id`, `chain_id`, `from_user` SET NULL, `to_user`
  FK CASCADE, `status` enum `pending | accepted | declined | revoked | expired`,
  `created_at`, `responded_at`; partial unique `(chain_id, to_user)` where
  pending.
- **`mirror_chain_ops`** — the oplog, append-only, retained forever (it is the
  chain-level audit trail and the join-replay source): `id`, `chain_id`, `seq`
  bigint, **unique `(chain_id, seq)`**, `kind` (op kind, §2), `mirror_id` uuid
  nullable (the logical entity targeted; null for chain/membership ops),
  `actor_user_id` SET NULL + `actor_username` denormalized,
  `origin_portfolio_id` uuid SET NULL, `payload` jsonb (full-state, versioned —
  §2), `created_at`. Index `(chain_id, mirror_id, seq)` for the §3 conflict
  guard.
- **`mirror_rows`** — the logical↔local identity map + per-row attribution:
  `chain_id` FK (plain — chains never hard-delete), `kind` enum
  `transaction | dividend | cash_movement | cash_source`, `mirror_id` uuid,
  `portfolio_id` FK portfolios ON DELETE CASCADE, `local_id` uuid (the row in
  this copy), `created_by` uuid SET NULL + `created_by_username` text. PK
  `(kind, mirror_id, portfolio_id)`, unique `(kind, local_id)`. A logical
  entity's `mirror_id` is minted at the origin as the **origin row's local id**
  (so on the origin copy `local_id = mirror_id`). Rows **survive forks** (they
  keep attribution rendering in a fork) and die only with their copy.

**Chain-scoped (replicated):** the portfolio's _content_ — transactions,
dividends, external cash movements (deposit / withdrawal / transfer legs /
set-balance delta), the cash-source list (create / rename / archive / restore),
and the portfolio **name** (authoritative on `mirror_chains.name`; each copy's
`portfolios.name` syncs to it, resolving the per-user unique-name collision with
a ` (2)`-style suffix — the chain name, not the suffixed local name, renders on
chain UI).

**Copy-scoped (never replicated):** visibility + V3-P5 audiences (each member
shares only THEIR copy under THEIR social graph — §10), `sortOrder`,
`defaultPayFromCash`, `archivedAt` (a member may locally archive a synced copy;
**sync continues while archived** so restore is consistent), all derived rows
(buy/sell_proceeds cash legs, tax_withholding/tax_refund movements — §9),
snapshots (#553 state is per portfolio), tax facts frozen on rows (§9), alerts,
watchlist/workboard references, and idempotency keys.

Identifying a synced copy: a partial index on
`mirror_chain_members(portfolio_id) WHERE status='active'`; the HTTP layer routes
portfolio-content writes for such portfolios through `mirrorService` (§2) and
leaves every other portfolio byte-identical to today.

## 2. Replication

**Decision: event/job-driven op replication through the existing services — NOT
synchronous multi-copy transactions and NOT row copying.** Rationale: (a) the
services own their own DB transactions (binding pattern, §16 2026-07-16 imports
row) — a single N-copy transaction would restructure the money path; (b) a
replica-side failure must never fail the acting member's own write; (c) applying
ops through `portfolioService`/`taxService` per copy reuses ALL existing
correctness machinery — solvency, oversell acknowledgment, tax freeze, append-only
settlement, #553 snapshot invalidation — so per-copy books are right by
construction. Ops replicate **user intent**; each copy derives its own side
effects (cash legs, tax movements) locally.

**Op kinds** (payloads are full-state, zod-validated in
`packages/contracts` mirror schemas, each carrying `opVersion: 1` for forward
evolution):

- Ledger ops (applied per copy): `tx.create`, `tx.update`, `tx.delete`,
  `dividend.record`, `dividend.delete`, `cash.deposit`, `cash.withdraw`,
  `cash.transfer` (one op, two legs — payload carries both minted leg
  `mirror_id`s), `cash.setBalance` (replicated as the **origin-computed signed
  delta** deposit/withdrawal — §8), `source.create`, `source.rename`,
  `source.archive`, `source.restore`. External cash movements are append-only
  (matching today's product surface — no movement edit/delete exists).
- Chain/membership ops (executed once against chain tables at append time;
  copies only advance their watermark past them): `chain.genesis` (§ join),
  `chain.rename`, `member.joined`, `member.left`, `member.removed`,
  `role.granted`, `role.revoked`, `owner.transferred`, `chain.dissolved`.

**Total order & the linearization point.** Appending an op runs
`UPDATE mirror_chains SET last_seq = last_seq + 1 ... RETURNING last_seq` — the
row lock serializes all concurrent writers of one chain and assigns `seq`. In
the same append transaction the actor's **active membership and role are
checked**: an op appended after a kick op took seq k is refused (the membership
row already flipped under the same serialization), so a kicked member can never
race a write past their removal. A batch submit (multi-row transaction create)
appends its ops with consecutive seqs in one append transaction.

**Apply order is sacred — on every copy, including the origin.** The submit path
is (amended 2026-07-22, §16 — the original text listed the append first, but
§1's rule that `mirror_id` IS the origin row's local id means the origin service
call mints it, so the origin apply necessarily precedes the append): (1) under
the per-chain apply lock, bring the origin copy up to date by applying any
pending earlier ops to it; (2) apply the new write through the normal service
call (own transaction) — the origin's validation is authoritative and a
rejection appends nothing; (3) append the op(s) under the in-transaction
membership/`baseSeq` guards, record `mirror_rows`, bump `applied_seq`; (4)
return the DTO; (5) enqueue `mirror.replicate` for the chain. The lock keeps the
origin's local apply order identical to seq order; the swap's cost is a crash
window between the origin service commit and the append (an origin-only,
mirror-linked row with no op) — detectable by the repair sweep below. The
replicate job (BullMQ, existing `jobs/**` patterns + `DEFAULT_JOB_OPTIONS`
backoff + dead-letter) walks each other active membership and applies ops
`applied_seq+1 … last_seq` strictly in seq order. Producers enqueue plainly per
write — deliberately NO job-id dedupe (amended 2026-07-22, §16: BullMQ silently
ignores an `add` whose id still exists in the retained completed/failed sets, so
a fixed per-chain job id would halt a chain's replication after its first run);
instead `replicateChain` itself serializes, replaying each copy under the SAME
per-chain Redis lock (token-fenced, TTL-renewed while applying) the submit path
holds — exactly one applier per copy at any moment, and concurrent or redundant
jobs no-op cheaply off the watermark. If the origin copy cannot catch up in
step 1 (a stalled earlier op — bug-level), the write is refused
`503 MIRROR_SYNC_STALLED` rather than applied out of order.

**Idempotency (at-least-once delivery, exactly-once effect).** Creates: skip if
`mirror_rows(kind, mirror_id, portfolio_id)` already exists (the natural key —
a crash between service commit and watermark bump re-applies harmlessly).
Updates: full-state payloads are replay-idempotent. Deletes: missing row ⇒
already done. The watermark bump is the last step of each per-op apply.

**Attribution + source tags.** Every applied op writes (a) the
`mirror_rows` link with `created_by`/`created_by_username` (from the create op),
and (b) an `audit_log` row per copy — actor = the acting member, target = the
local row, `meta = { chainId, seq, kind, actorUsername }` — so **each copy's
audit trail is complete and survives forks and actor deletion** (auditLog
already keeps SET-NULL actors). Row source tags (V5-P0c): the **origin copy**
keeps the tag of the real write path (`manual`, `import:<broker>`,
`standing-order` — imports and standing orders into a synced copy replicate like
any write); **replica copies always get `sync:mirrorchain`** (a reserved
`sync:<slug>` per the existing `sourceTagSchema`; the origin tag rides in the op
payload for the activity feed). This keeps "show synced rows" filterable per
copy with zero new columns.

**Solvency across copies (force-apply).** Holdings derive only from replicated
transactions, so oversell checks agree on every copy; the origin's validation is
authoritative. Cash balances, however, legitimately skew per copy because tax
settlement movements are copy-local (§9) — so replica-side applies run in
**force mode**: the overdraw guard (`INSUFFICIENT_CASH`) and the
zero-balance-to-archive guard are waived on replica application (and on join
replay). A copy whose source goes negative purely from its own tax skew renders
the negative balance honestly — "each member's books are their own".

**Tax-immutable rows.** V3-P4 (§16 2026-07-08 rule 5) makes rows carrying
recorded tax financially immutable, with delete-and-re-add as the sanctioned
correction. A chain `tx.update` therefore applies per copy as: note-only changes
edit in place; a financial change on a copy where the local row carries recorded
tax executes as the correction path — delete + re-create through the services
(tax re-derived append-only), with `mirror_rows.local_id` re-pointed to the new
row. Convergence is unaffected: the final financial state is the op's full
state on every copy. The correction is made crash-safe at re-delivery (amended
2026-07-22, §16): a `tx.update` that finds the mirror link but not the local row
(the delete committed, the re-create didn't) re-creates the row from the op's
full-state payload — asset identity from the entity's create op — and re-points
the link, instead of skipping (a skip would advance the watermark and silently
lose the row on that copy). The residual window (re-create committed, re-point
not) can leave one orphaned re-created row — strictly narrower (the data is
present, merely duplicated locally) and detectable by sweep (b) below.

**Partial-failure repair.** A persistently failing per-copy apply dead-letters
(existing machinery), flips that membership to a visible `sync stalled` state
(member + owner see it; the V5-P2 Problems page captures the error), and a
"retry sync" action resumes from the watermark. Ops are never skipped and order
is never broken — a stalled copy lags; it does not diverge. Realtime: each
successful replica apply publishes the existing `portfolio.changed` event for
that copy's user; no new event types are needed for data sync.

**Crash-window repair sweeps** (added 2026-07-22, §16 — the two sub-transactional
windows the amended orderings open, both detectable by query; wire them into the
M4 repair sweep):

- (a) origin-commit-then-append (submit path): an origin `mirror_rows` link
  whose `mirror_id` has no op —
  `select mr.* from mirror_rows mr where not exists (select 1 from
mirror_chain_ops o where o.chain_id = mr.chain_id and o.mirror_id =
mr.mirror_id)`. Such a row exists only on the origin copy and silently
  diverges (later full-state updates no-op on copies that lack it) until
  repaired (synthesize its create op from the local row, or surface it).
- (b) correction re-create-then-re-point: a copy-local row in a synced
  portfolio with no `mirror_rows` link pointing at it —
  `select t.* from transactions t where t.portfolio_id = $copy and not exists
(select 1 from mirror_rows mr where mr.portfolio_id = t.portfolio_id and
mr.local_id = t.id)`. Local-only duplicate; safe to delete through the
  services.

**Joining = replaying the one true log.** When a chain is **created** — either
"make this portfolio a group portfolio" (convert) or "new group portfolio"
(empty) — the creator's portfolio becomes the origin copy and, for a convert,
**genesis ops** are synthesized into the oplog in chronological (`executedAt`,
then insertion) order: one op per existing transaction / dividend / external
movement / cash source, actor = the creator, `mirror_id` = the existing row id.
From then on the oplog is complete from seq 1, and **every join is the same
mechanism as steady-state sync**: create the member's copy (auto-named, Main
auto-provisioned and mirror-linked — §8), set `applied_seq = 0`, and let the
replicate job replay the log through the joiner's services (force mode) while
the UI shows a syncing progress state. No snapshot copying, no reference copy,
one code path. Ops are retained forever, so late joiners always have a complete
source; volumes are personal-finance scale, so no compaction is designed.

## 3. Conflict convergence

Two layers, both binding:

1. **Convergence rule (the invariant): per-chain total order + full-state
   last-writer-wins.** Every op has a unique chain seq; every copy applies ops
   strictly in seq order; edit payloads are full state, never field diffs. Hence
   all copies that reach watermark W hold byte-identical chain-scoped content —
   for the same `mirror_id`, the highest-seq op ≤ W is the state (a whole-op
   win, never a field merge: a field merge could manufacture a financial row no
   member ever reviewed). A `*.delete` is terminal: appending any later op
   targeting a deleted `mirror_id` is refused at the door (`409
MIRROR_ROW_DELETED`).

2. **Stale-edit guard (the UX): optimistic concurrency at append.** Chain DTOs
   expose per-row `mirror.version` = the seq of the last op that targeted that
   `mirror_id`. `tx.update`, `tx.delete`, `dividend.delete` and `source.*`
   mutation ops carry `baseSeq`; the append transaction refuses with `409
MIRROR_CONFLICT` when the entity's latest op seq ≠ `baseSeq`. The losing
   client refetches and re-submits against fresh data — so a member's edit is
   never _silently_ clobbered; LWW only ever resolves the (unpreventable) case
   of two appends that both passed the guard before either replicated.

**Worked example (the "concurrent edits converge" test writes itself from
this):** transaction T exists everywhere at version 40. Alice submits quantity
5 → 6 and Bob simultaneously submits price 100 → 110, both with `baseSeq: 40`.
Case A (normal): Alice's append wins the `last_seq` race → op 41
`{qty 6, price 100, …}`, version becomes 41; Bob's append now sees latest seq
41 ≠ 40 → `409 MIRROR_CONFLICT`; Bob's client refetches (qty 6), he re-submits
price 110 as op 42 `{qty 6, price 110, …}`. Every copy applies 41 then 42; all
copies end at qty 6, price 110; the oplog and each copy's audit trail show both
edits with both actors. Case B (guard raced — both appends read version 40
inside the window before either committed is impossible: the version check and
seq assignment share the append transaction and the `mirror_chains` row lock
serializes them — so Case B cannot occur; the test asserts exactly that by
firing both concurrently and requiring one 409). Convergence under a
deliberately-bypassed guard (defense-in-depth test): inject ops 41 and 42
directly → every copy ends with op 42's full payload `{qty 5, price 110}`.

## 4. Invite / join

**Friends-only:** an invite requires an active `friendships` row between inviter
and invitee, checked at send AND at accept (an unfriend between send and accept
voids the invite). Senders: owner + managers (§5). Pending invites are unique
per (chain, invitee); declining allows a later re-invite (pending-uniqueness +
the standard rate limits are the spam guard, mirroring the friend-request
pattern); invites expire with the standard token hygiene (30 days) and are
revocable by owner/managers.

**Friction ladder placement:** chain membership is person-specific
(specific-friends rung ⇒ no extra nag), BUT joining goes beyond passive sharing
— other members' writes will land in the joiner's own books, and the joiner's
chain activity becomes visible to all members. So the **accept step itself
carries one explicit plain-language acknowledgment** (ladder-consistent: the
confirmation IS the accept, not an extra dialog): "Members of _⟨chain⟩_ will see
everything in this portfolio and can add or edit entries that appear in your
account. Your other portfolios stay private. You can leave anytime and keep your
copy." Nothing else is ever asked.

**Join experience (zero member-side config, the owner's overboard mandate):**
accept → the copy exists immediately (auto-created, auto-named with collision
suffix, Main auto-linked) and appears in the member's portfolio switcher with a
"Syncing… n %" state (watermark / `last_seq`) until replay completes; then it is
simply a portfolio. The member configures nothing, names nothing, maps nothing.
Delivery of the invite rides the notification matrix (`mirror.invite` type,
in-app default ON, email per lean defaults) and the Social surface's request
list. Cap: `MIRROR_MAX_MEMBERS = 16` active members per chain (env-tunable;
bounded fan-out).

## 5. Transfer + roles — the authority matrix

| Capability                                                                                                                                                       | Owner               | Manager | Member |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------- | ------ |
| Ledger writes (tx/dividend/cash/source ops), incl. editing/deleting rows **any** member created — it is one shared book; attribution + audit record who did what | ✓                   | ✓       | ✓      |
| Invite / add member                                                                                                                                              | ✓                   | ✓       | —      |
| Kick a plain member                                                                                                                                              | ✓                   | ✓       | —      |
| Kick a manager                                                                                                                                                   | ✓                   | —       | —      |
| Grant / revoke manage rights                                                                                                                                     | ✓                   | —       | —      |
| Rename the chain                                                                                                                                                 | ✓                   | ✓       | —      |
| Transfer ownership (to any active member)                                                                                                                        | ✓                   | —       | —      |
| Leave (keeping a fork, §6)                                                                                                                                       | via succession (§7) | ✓       | ✓      |
| Dissolve the chain (all copies fork)                                                                                                                             | ✓                   | —       | —      |

Managers act **autonomously and immediately** — no owner approval queue, owner
offline is irrelevant (the "managers add/remove while owner offline" edge):
their membership ops append like any op, are audited, and notify the owner
(`mirror.member_joined` / `mirror.member_removed`). Races between membership
ops resolve by the same total order as everything else (e.g. owner revokes
Bob's manage rights while Bob kicks Carol: whichever op appends first wins;
Bob's kick after the revoke is refused at append by the role check).
**Transfer:** owner-only, target must be an active member, executes as
`owner.transferred` — the target becomes owner and **the old owner becomes a
plain member** (matching the §13.5 done-when; the new owner may re-grant them
manager). Nothing changes on any copy's data — roles are chain metadata.
Manager grant/revoke = `role.granted` / `role.revoked`, owner-only, audited.

## 6. Kick / leave → fork

Un-sync mechanics, exactly: the membership row flips `status` to `removed`
(kick) or `left` (leave) with `ended_at` — appended as a `member.removed` /
`member.left` op under the chain lock, so no later op from that member can
slip in (§2). From that seq on, the replicate job skips the membership; the
copy **freezes at its current watermark** (a lagging copy forks with its lag —
severance is immediate, not "after catch-up").

**What stays (everything material):** the `portfolios` row and all its content —
transactions, dividends, movements, sources, snapshots, source tags
(`sync:mirrorchain` rows keep their historical tag), `mirror_rows` attribution
links (so "added by alice" still renders in the fork's history), and the copy's
complete `audit_log` trail. The fork is a fully working, fully editable normal
portfolio from the first second — nothing to migrate, nothing to rebuild.

**What is severed:** the active membership (chain queries exclude it),
replication both ways (their future writes stay local; chain ops no longer
reach them), the member list / activity feed / chain oplog access, and the
chain name binding (the fork keeps its current local name; renames stop
following). The fork's portfolio header shows one provenance line — "Forked
from _⟨chain⟩_ · ⟨date⟩" — rendered from the membership tombstone.

The removed member is notified (`mirror.removed`); remaining members see the
membership change in the member list and activity feed. Their copies keep every
row the departed member ever wrote (delivered writes are never recalled — the
same principle as §16 2026-07-09 chat semantics). **Re-inviting** a forked
member later creates a brand-new copy via the normal join replay; the fork
remains a separate, untouched portfolio (no re-merge — ever; `mirror_rows`
uniqueness is per portfolio, so old fork links never collide with the new
copy's). A member deleting a synced copy outright is intercepted as
leave-then-delete (owner: succession first, §7).

## 7. Deletion succession

**DECIDED: transfer-on-delete to the oldest manager; with no manager, the chain
dissolves into forks.** Precisely: on owner departure without prior transfer
(account deletion, or owner-leave / owner copy-deletion — one rule for all
three), ownership transfers to the **active manager with the earliest
`joined_at`** (tie → lowest user id, deterministic); if no active manager
exists, a `chain.dissolved` op ends every membership (`status='dissolved'`),
every copy becomes a fork per §6, and members are notified
(`mirror.chain_dissolved`). _Rationale:_ managers explicitly accepted
stewardship, so promoting the most senior one preserves a living chain without
surprising anyone; a plain member never volunteered to run a shared financial
structure, and silently crowning one violates least-surprise — with no willing
steward, honest dissolution (everyone keeps their book) beats a zombie chain.
Oldest-by-join beats oldest-by-grant because join tenure is the intuitive "most
senior" reading and is stamped immutably at one place.

**Mechanics in the V4-P2c pipeline:** `accountDeletionService` (and the admin
delete) call `mirrorService.handleAccountDeletion(userId)` **synchronously
before the user row is deleted** (the same pre-delete slot as session
revocation): for each active membership — if owner, execute succession
(`owner.transferred` to the oldest manager, or `chain.dissolved`); then end the
membership (`status='account_deleted'`). The subsequent user-row delete cascades
the deleted member's own copy away, while SET NULL + denormalized usernames
keep the chain's member history, op attribution and `mirror_rows` attribution
rendering ("alice (account deleted)"). Every other copy and the chain itself
are untouched — the §13.5 "deletion leaves the others' copies + sync intact"
test follows directly. **Defense-in-depth:** a periodic repair sweep (existing
scheduler pattern) detects an active chain with zero active owners (only
reachable by bypassing the service, e.g. manual SQL) and applies the same
succession rule.

**Worked example (the succession test writes itself from this):** chain C —
owner O; manager M1 (joined Jan 5); manager M2 (joined Mar 2); member B. O
deletes their account via `DELETE /api/v1/account`: the pipeline transfers
ownership to **M1** (earliest-joined active manager), ends O's membership as
`account_deleted`, then O's copy cascades away with O's account. Result: C is
`active` with owner M1, manager M2, member B; all three copies and sync are
intact; the oplog shows `owner.transferred` (actor O, `via: account_deletion`)
then `member.left`-equivalent tombstoning. _Variant:_ if M1 and M2 had never
been granted manager, C would instead append `chain.dissolved`, and B's (and
M1's, M2's) copies would become forks per §6 — each still holding the full
shared history. _Non-owner deletion:_ B deletes their account → B's membership
ends, B's copy dies with B, C continues untouched with owner O and both
managers; B's past rows remain in every copy, attributed "B (account deleted)".

## 8. Cash sources across copies

Cash sources are **chain-scoped entities** (§1): `source.create` /
`source.rename` / `source.archive` / `source.restore` replicate, and each copy
materializes its own local `portfolio_cash_sources` row, mirror-linked. At
join, the chain's **Main maps onto the copy's auto-provisioned Main**
(every portfolio has exactly one — the existing invariant); named chain sources
materialize with their chain name/type (a fresh copy has only Main, so no
collisions; the suffix rule of §1 covers pathological later cases). Replicated
movements resolve their target source **by mirror id per copy**, so "the
dividend lands in Bank X" means each member's own local "Bank X". Local-only
sources do not exist in a synced copy — creating a source there IS a chain op
(uniform rule: portfolio content is chain content); a member wanting private
cash keeps it in their other portfolios.

Per-copy balances are each copy's own movement sums and may **legitimately
skew** across copies by exactly the copy-local tax movements (§9) — displayed
honestly per copy, never reconciled. Consequences, decided: `cash.setBalance`
replicates the **origin-computed delta** as a plain deposit/withdrawal (flows
stay identical on every copy; a tax-skewed copy may show a balance ≠ the target
X — its book, its truth; replicating "set to X" instead would mint different
TWR flows per copy, which is worse). `source.archive` requires €0.00 on the
**origin** copy only; replicas force-archive (§2 force mode) — an archived
source stays fully queryable, so a skewed copy loses nothing. Transfers
replicate as one op writing both legs against the mirror-resolved local
sources, sharing a fresh local `transfer_id` per copy.

## 9. Per-copy independence (TWR / tax)

Replication applies ops **through each copy's own services under that copy's
own user context**, so per-account books hold by construction: a replicated
sell is taxed on Bob's copy per **Bob's** tax mode/country at the moment his
copy records it (the V3-P4 freeze — for a replicated row, "recording time" is
apply time on that copy; a stalled copy that catches up after a mode switch
records under the new mode, exactly the forward-only rule). Tax settlement
movements, loss pools, allowances and year re-derivations run per portfolio
(already the §16 2026-07-08 / 2026-07-17 scoping) — **zero interaction** with
any other member's settlement: tax rows are copy-local, never replicated, never
visible to other members. TWR: external flows are identical across copies
(deposits/withdrawals/transfer legs replicate; tax movements are TWR-internal
by the existing classification), so members' returns differ only by their own
tax reality — each member's performance is their book's truth. Snapshots: every
per-copy apply invalidates through the copy's own `invalidateHistory` (#553
rules apply verbatim — the services already do this). Backtest, analytics,
alerts, watchlists: per-copy reads, untouched.

## 10. Privacy boundary

Members see, per chain: the chain name, the member list (username, profile
icon, role, joined date), per-row attribution on chain rows, the activity feed
(the oplog rendered per their copy), and sync status. Members see **nothing
else about each other** — not other portfolios, not net worth, not cash sources
outside the chain, not each other's tax settings or tax amounts (tax rows never
replicate, §9), not copy-scoped settings or audiences. The chain surface adds
no reachability beyond what friendship already grants (invites are
friends-only).

**Sharing a synced copy** (V3-P5 audiences) stays a member's right — it is
their portfolio, their audience controls, their friction ladder. Binding rule:
**attribution renders only to viewers who are themselves active members of the
chain**; any other viewer of a shared/public copy sees the rows with actor
identity stripped (a generic "group member" chip) — a member may expose their
own book, never their co-members' identities. The share dialog for a synced
copy states this in one line. Per-copy audit trail: every applied op writes an
`audit_log` row on every copy (§2), actor-attributed, surviving forks and
account deletions — the "per-copy audit trail is complete" test enumerates one
audit row per applied op per copy.

## 11. UX flows (the overboard-seamless mandate, anti-bloat-compliant)

Everything chain-related lives behind **one affordance**: an avatar stack
(members' profile icons, V5-P0c curated set) on the portfolio header of a
synced copy. Non-chain portfolios render byte-identically to today — zero new
chrome. From the stack:

- **"Who else is on this portfolio":** tap the stack → a compact member sheet —
  avatars, usernames, role badges, joined dates, sync state; owner/managers
  additionally see Invite, Kick, Grant/Revoke manage, Transfer, (owner)
  Dissolve. That sheet is the entire management surface.
- **Create:** "New group portfolio" next to "New portfolio", and "Make this a
  group portfolio" in an existing portfolio's menu (convert, §2 genesis). Both
  immediately open the friend-picker invite step.
- **Invite → join:** invitee gets a notification + Social request entry; accept
  = the §4 one-screen acknowledgment; the copy appears instantly with the
  syncing progress state; done. Zero configuration, zero naming, zero mapping.
- **Leave:** member sheet → "Leave" → one confirm stating the §6 outcome ("You
  keep your copy; it just stops syncing") → the portfolio stays, now with the
  fork provenance line. Kick mirrors it from the other side (`mirror.removed`
  notification; the fork line explains what happened).
- **Attribution:** chain rows show a small actor chip (avatar/username) in the
  transaction/dividend/cash lists (additive DTO field from `mirror_rows`);
  the activity feed lives in the member sheet.
- **Transfer:** member sheet → member → "Make owner" → confirm; old owner's
  badge flips to member (§5).

All new user-facing strings ship EN + DE keys (binding i18n rule). New
notification types (`mirror.invite`, `mirror.member_joined`,
`mirror.member_left`, `mirror.member_removed`, `mirror.removed`,
`mirror.ownership_transferred`, `mirror.chain_dissolved`, `mirror.sync_stalled`)
join the matrix as ONE compact group row (anti-bloat), in-app ON / email per
the lean-default rule. Mirror writes mount the V4-P2a `Idempotency-Key`
middleware like every portfolio mutation (mobile offline queue).

## 12. Implementation decomposition (ordered; for the composer)

1. **M1 — Schema + contracts** (`diff:intermediate`): the five §1 tables +
   enums + indexes/invariants, `sync:mirrorchain` tag adoption, mirror op
   payload schemas (`opVersion: 1`), additive DTO fields (`mirror.version`,
   attribution chip data), migration. No behavior.
2. **M2 — Replication core** (`diff:max` — the money/sync keystone): the
   `mirrorService` seam + HTTP routing for synced copies; op append (chain-lock
   seq, membership/role check, §3 baseSeq guard); origin catch-up apply;
   `mirror.replicate` job (per-chain serialization, idempotent per-op apply,
   watermarks, force mode, tax-immutable correction path, attribution links +
   per-copy audit rows, `portfolio.changed` fan-out); genesis + join replay;
   stall/dead-letter → Problems + retry. Unit tests: total-order convergence,
   idempotent replay, conflict guard, per-copy tax freeze, force-mode
   solvency, set-balance delta.
3. **M3 — Membership lifecycle + invites** (`diff:hard`): create/convert, the
   friends-only invite flow + acknowledgment accept, roles + authority matrix
   enforcement, transfer, kick/leave → fork severing + provenance, notification
   types + matrix group, member cap. Tests: matrix enforcement, kick-freeze,
   re-invite-new-copy, invite-void-on-unfriend.
4. **M4 — Deletion succession + repair** (`diff:hard`): the §7 pre-delete hook
   in the V4-P2c pipeline + admin delete, succession rule, dissolution, the
   ownerless-chain repair sweep. Tests: worked examples of §7 verbatim.
5. **M5 — UI** (`diff:intermediate`): avatar stack + member sheet, create/
   convert/invite/join/syncing/leave/kick/transfer flows, attribution chips,
   activity feed, share-attribution stripping (§10), fork provenance line,
   EN+DE strings. **MUST wire the §3 `baseSeq` guard end-to-end**: M2 exposes
   `baseSeq` at the service seam only — no HTTP edit contract carries it yet,
   so until wired a real client's concurrent edits silently take latest-seq
   (LWW, exactly what §3 forbids). Add `baseSeq` (from the DTO's
   `mirror.version`) to the tx/dividend/source edit request contracts and send
   it from the edit dialogs so `409 MIRROR_CONFLICT` can actually fire.
6. **M6 — e2e + gate** (`diff:intermediate`): the six §13.5 done-when
   scenarios as Playwright specs (see §13), joining the V5-P14 suite.

Order is strict (each builds on the previous); M3/M5 may overlap once M2's
service surface is merged.

## 13. Done-when traceability

| §13.5 "done when" criterion                                                | Decided by                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------ |
| A member's buy appears in every copy, attributed (e2e)                     | §2 (replication, attribution, tags), §11 (chips) |
| Kick leaves a fully working un-synced fork (test)                          | §6                                               |
| Ownership transfer works; old owner becomes a normal member (test)         | §5                                               |
| A member's account deletion leaves the others' copies + sync intact (test) | §7 (non-owner mechanics + worked variant)        |
| Concurrent edits converge per the design note (test)                       | §3 (rule + worked example)                       |
| Per-copy audit trail is complete (test)                                    | §2 + §10 (audit row per applied op per copy)     |

## 14. Constraints & non-goals

- **Paranoid mode (V5-P13):** MIRRORCHAIN requires the server to read and
  re-apply portfolio content; it is therefore **absent by design for paranoid
  accounts** (consistent with their no-sharing/no-social posture). A paranoid
  member cannot join or create chains; this is a constraint recorded here, not
  designed here (the P13 note owns its side).
- No cross-instance or cross-device replication — one database, server-side
  logical replication only. No re-merge of forks. No compaction of the oplog.
- No public chains, no non-friend invites, no per-row member permissions
  (the shared-book model is deliberate — §5).
- Chain count per user is governed by the future v6 per-user limits work;
  member cap per chain is §4's env-tunable 16.
