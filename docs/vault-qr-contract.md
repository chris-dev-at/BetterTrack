# `btvault1:` QR seed-phrase transfer — the normative wire contract

**This file is THE specification.** It was extracted verbatim from
`docs/paranoid-design.md` §13 on 2026-09-02 (Chief ruling, post-E9 doc
condensation) because it is a self-contained wire contract with its own
audience: the web renderer, the phone scanner, and any future client are built
against it, and a third implementation must be able to satisfy it without
reading either shipped client's source. Not one rule changed in the move — the
normative body below is byte-identical to what §13 carried.

`docs/paranoid-design.md` §13 keeps the summary and points here.
`apps/web/src/user/vault/qr/README.md` is implementation notes and defers here
for every rule. Where anything disagrees with this file, this file wins.

The rejection vocabulary is **FROZEN** (2026-08-26) and the version token is
canonical: neither may be widened, narrowed or reinterpreted by any client.
Changes to this contract are cross-client breaking and go through the owner via
PROJECTPLAN §16.

## Sender

The device holding the phrase: Vault settings → "Show transfer QR". Requires a
live unlock AND, for wrapped custody, a fresh password entry (≤ 60 s old) — the
QR displays the master secret, so showing it is itself a step-up act
(`apps/web/src/user/vault/qr/senderSource.ts:61`, `qr/encoding.ts:14`). It
renders full-screen with an explicit banner ("Anyone who captures this code owns
this vault — no screenshots, no screen sharing, mind who can see your screen"),
a 60-second auto-expiry that blanks the code (manual re-show), no clipboard
path, no network transmission of any kind (display→camera is the whole
channel), and nothing logged or persisted. The native apps additionally set the
platform secure-screen flag (FLAG_SECURE / iOS capture detection) on both the
show and scan screens — recorded as a mobile-board contract item.

## The contract

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

## Shipped-client conformance

`apps/web/src/user/vault/qr/payload.ts` is the reference implementation and
`qr/conformanceVectors.ts` holds the cross-client oracle vectors. The closed
vocabulary, the version-token shape check, the leading-`?` refusal,
duplicate-key rejection, `m`-before-`v`, blank-is-absent, the trim set,
trim-before-cap, render-time sanitization and the fetch-then-compare `f` rule
all match this specification.

**One deviation is recorded, not blessed:** the web decoder calls
`new URLSearchParams(body)` (`payload.ts:113`) instead of the self-contained
decoder this contract requires. It compensates by refusing a leading `?` first
(`:105`), which closes the one divergence the contract names for that type, but
the rule as written is stricter than the shipped client. Tracked as web-hygiene
scope on #1621.

The `n` byte bound is a wire budget rather than a parse rule — the parser
enforces only the 64-code-point cap, and the sender enforces a 220-byte
whole-payload budget (`payload.ts:21`).
