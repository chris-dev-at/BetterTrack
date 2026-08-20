# `btvault1:` native handoff contract

The binding payload is `btvault1:m=<words>&v=<vaultId>[&n=<name>][&f=<fingerprint>]`.
There is deliberately no `//` authority: split at the first colon and parse the remainder as one
`application/x-www-form-urlencoded` query. Reject every prefix except `btvault1:` with an
update-required result, reject either missing required key, and ignore unknown query keys.
Reject repeated `m` or `v` keys rather than selecting one occurrence.

`m` is the lowercase, NFKD, single-space-separated 12-word English BIP39 phrase, including its
checksum. `v` is the lowercase hyphenated vault UUID. `n` is an optional percent-encoded display
hint of at most 64 Unicode code points; preserve its decoded value exactly without normalization.
`f` is the optional 16-character base64url key fingerprint. Encode the QR as UTF-8 byte mode with
exact error-correction level M. Native clients must run the exported conformance vectors against
their scanner before shipping.

Fingerprint verification is fetch-then-compare: the receiver must fetch the opaque header envelope,
unwrap its active key slot with the phrase, compare the derived content-key fingerprint, and only
then decrypt the header. An offline fingerprint pre-check is impossible because the fingerprint is
derived from the content key stored inside that fetched envelope.

Both secret-bearing native screens require platform capture protection for their entire lifetime:

- Android must apply `FLAG_SECURE` before either the transfer-QR screen or scanner screen becomes visible, and retain it until that screen is destroyed.
- iOS must enable capture detection before either screen becomes visible, obscure the app-switcher snapshot, and blank/refuse the QR or scanned phrase while capture is active.

This applies equally to showing and scanning. Payloads must never enter logs, analytics, crash reports, persistence, the clipboard, or a network request.
