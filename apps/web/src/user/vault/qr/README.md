# `btvault1:` native handoff contract — implementation notes

`docs/paranoid-design.md` §13 is the normative spec for this wire format — the ONE
document a third client is built against. **This file is not the spec.** It is
implementation notes for an engineer already holding §13, collecting the file
references, gotchas, and shipped-client detail that don't belong in the prose
specification itself. Where anything below reads as a restatement of a rule,
§13 is the tie-breaker if the two ever disagree.

The binding payload is `btvault1:m=<words>&v=<vaultId>[&n=<name>][&f=<fingerprint>]`.
There is deliberately no `//` authority: split at the first colon and parse the remainder as one
`application/x-www-form-urlencoded` query, with a self-contained decoder — never the platform
URL/URI type (§13 records why: Android's and OpenJDK's `URLDecoder` disagree on `+` and on
malformed escapes, and `Uri.parse` additionally strips a trailing `#fragment`).

The version token `N` is a **canonical decimal integer** — `^[1-9][0-9]*$`, so no leading zeros and
no zero. Validate that shape BEFORE any integer conversion: `Number("02")` and Kotlin `"007".toInt()`
both silently accept padded forms we never mint. `btvault1:` is this version; a canonical token
above 1 is `update-required`. `btvault0:`, `btvault01:`, `btvault02:` and `btvault007:` are
`not-a-bettertrack-code`, as is input carrying no `btvaultN:` prefix at all. A `btvault1:` body
that is JSON rather than form-encoded (the pre-form-encoding wire shape) is `legacy-code`, not
foreign input — it's our scheme in an obsolete shape.

Reject a body that starts with the query delimiter `?` as `malformed` — it is a break in the body
grammar, not a missing key, and calling it a missing key makes the answer depend on which key the
sender wrote first. Reject a repeat of any known key (`m`, `v`, `n`, `f`) as `duplicate-key` rather
than selecting one occurrence, and ignore unknown query keys no matter how often they repeat.
Required-key check order is `m` before `v`; a whitespace-only required value (`m=+`) is
`missing-mnemonic`, not `invalid-mnemonic`.

`m` is the lowercase, NFKD, single-space-separated 12-word English BIP39 phrase, including its
checksum. `v` is the lowercase hyphenated vault UUID. `n` is an optional percent-encoded display
hint of at most 64 Unicode code points (≤ 256 UTF-8 bytes derived); trim its edges and treat a
blank result as absent; otherwise preserve the decoded value exactly without normalization —
sanitization for display (control/bidi stripping) happens at render, not at parse.
`f` is the optional 16-character base64url key fingerprint, shape-validated at parse and compared
only after the header envelope is fetched and unwrapped — there is no offline pre-check. Encode
the QR as UTF-8 byte mode with exact error-correction level M. Native clients must run the exported
conformance vectors against their scanner before shipping.

The full rejection vocabulary (twelve literals, frozen 2026-08-26) and the reasoning behind each
one lives in §13, not here.

**Web/spec drift note:** the shipped web parser (`payload.ts`) predates the 2026-08-26 vocabulary
freeze and hasn't been renamed onto it yet (`invalid-name` instead of `name-too-long`, no
`duplicate-key`/`legacy-code` outcomes, duplicate `n`/`f` still first-wins) — tracked separately
in #1513, out of scope for the doc that introduced §13's normative text (#1502).

### Implementation notes for `n`

§13 is the normative home for both of these rules; they are restated here because a client author
reads this file first, and both are places where two correct-looking implementations disagree.

- **Trim set.** The set is **Unicode `White_Space` ∪ the C0/C1 controls ∪ U+FEFF** — named
  explicitly, never "whatever the host runtime's trim does". ECMAScript `String.prototype.trim`
  strips U+FEFF but leaves U+001C–U+001F standing; Kotlin `String.trim()` / `Char.isWhitespace()`
  does the exact opposite. Either built-in alone makes the two clients disagree about whether a
  scanned code carries a name. This set is a strict superset of both. U+FEFF is listed by hand: it
  is category `Cf` with `White_Space=No`, so no Unicode property covers it. Only the EDGES are
  trimmed — an interior control is preserved on the wire and stripped by the render sanitizer, not
  by the parser. A name composed entirely of trim-set code points is ABSENT.
- **Order: trim, then cap.** Trim the edges first, then apply the 64-code-point cap to the result.
  A name already at 64 code points must survive being padded on the wire; capping first would count
  the padding and fail the whole transfer as `invalid-name` (§13: `name-too-long`).

Fingerprint verification is fetch-then-compare: the receiver must fetch the opaque header envelope,
unwrap its active key slot with the phrase, compare the derived content-key fingerprint, and only
then decrypt the header. An offline fingerprint pre-check is impossible because the fingerprint is
derived from the content key stored inside that fetched envelope.

Both secret-bearing native screens require platform capture protection for their entire lifetime:

- Android must apply `FLAG_SECURE` before either the transfer-QR screen or scanner screen becomes visible, and retain it until that screen is destroyed.
- iOS must enable capture detection before either screen becomes visible, obscure the app-switcher snapshot, and blank/refuse the QR or scanned phrase while capture is active.

This applies equally to showing and scanning. Payloads must never enter logs, analytics, crash reports, persistence, the clipboard, or a network request.
