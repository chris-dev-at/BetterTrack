# `btvault1:` native handoff contract

The binding payload is `btvault1:m=<words>&v=<vaultId>[&n=<name>][&f=<fingerprint>]`.
There is deliberately no `//` authority: split at the first colon and parse the remainder as one
`application/x-www-form-urlencoded` query.

The version token `N` is a **canonical decimal integer** — `^[1-9][0-9]*$`, so no leading zeros and
no zero. Validate that shape BEFORE any integer conversion: `Number("02")` and Kotlin `"007".toInt()`
both silently accept padded forms we never mint. `btvault1:` is this version; a canonical token
above 1 is update-required. `btvault0:`, `btvault01:`, `btvault02:` and `btvault007:` are
not-a-bettertrack-code, as is input carrying no `btvaultN:` prefix at all — but that bucket is
**not exhaustively defined here**, and membership in it is expected to narrow: a `btvault1:` code
whose body is not a form-encoded query (a JSON body, say) is a BetterTrack code we recognize and
decline, so §13 may classify such input under its own outcome rather than as foreign input.

Reject a body that starts with the query delimiter `?` as malformed — it is a break in the body
grammar, not a missing key, and calling it a missing key makes the answer depend on which key the
sender wrote first. Reject either missing required key, reject repeated `m` or `v` keys rather than
selecting one occurrence, and ignore unknown query keys.

`m` is the lowercase, NFKD, single-space-separated 12-word English BIP39 phrase, including its
checksum. `v` is the lowercase hyphenated vault UUID. `n` is an optional percent-encoded display
hint of at most 64 Unicode code points; trim its edges and treat a blank result as absent;
otherwise preserve the decoded value exactly without normalization.
`f` is the optional 16-character base64url key fingerprint. Encode the QR as UTF-8 byte mode with
exact error-correction level M. Native clients must run the exported conformance vectors against
their scanner before shipping.

### Implementation notes for `n`

PROJECTPLAN.md §13 is the normative home for both of these rules (#1502); they are restated here
because a client author reads this file first, and both are places where two correct-looking
implementations disagree.

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
  the padding, see 66, and fail the whole transfer as invalid-name.

Fingerprint verification is fetch-then-compare: the receiver must fetch the opaque header envelope,
unwrap its active key slot with the phrase, compare the derived content-key fingerprint, and only
then decrypt the header. An offline fingerprint pre-check is impossible because the fingerprint is
derived from the content key stored inside that fetched envelope.

Both secret-bearing native screens require platform capture protection for their entire lifetime:

- Android must apply `FLAG_SECURE` before either the transfer-QR screen or scanner screen becomes visible, and retain it until that screen is destroyed.
- iOS must enable capture detection before either screen becomes visible, obscure the app-switcher snapshot, and blank/refuse the QR or scanned phrase while capture is active.

This applies equally to showing and scanning. Payloads must never enter logs, analytics, crash reports, persistence, the clipboard, or a network request.
