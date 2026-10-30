# Announcements and the acknowledgement gate — the wire contract

**This file is THE specification** for every client that shows announcements or honours the acknowledgement gate: the web app, the mobile app, and any future client. It was written on 2026-10-29 from the owner directive of that date (`PROJECTPLAN.md` §6.19, §16 2026-10-29). §6.19 carries the product design, the data model and the build lanes and points here for everything on the wire; where the two disagree on a wire detail, this file wins.

**Status: DESIGN.** Everything marked NEW below is not live until the lanes of §6.19.14 merge; each lane updates this file in the PR that ships its part, and the mobile board announces it. Everything marked KEPT is live today and stays byte-identical. T2-A's first PR (#2094) ships the data model, the §3 shared types, the §4 user endpoints, `MeResponse.pendingAcknowledgements` (§4.6) and the §6 inbox changes; the gate (§5) and the admin endpoints (§7) follow.

Conventions are the API's (§8): base `/api/v1`, JSON, camelCase, errors `{ "error": { "code", "message", "details"? } }`, instants are RFC 3339 UTC strings, ids are UUID strings. **Clients ignore unknown response fields**, and each enum below says what a client does with a value it does not know. Cookie-session callers send `X-Requested-With: BetterTrack` on every state-changing request (§10); bearer callers send `Authorization: Bearer <token>` and need no CSRF header.

## 1. Existing operations — kept, extended, deprecated

| Existing operation                               | Verdict                        | What changes                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /notifications/announcements`               | extended (new optional fields) | Same path, envelope and five fields (`id`, `severity`, `title`, `body`, `publishedAt`). Items gain the NEW fields of §3.3. The list now also carries `once` and `ack_required` items, honours the audience, and a window's end is exclusive (was inclusive).             |
| `POST /notifications/announcements/{id}/dismiss` | extended                       | Same path, same `200 { "ok": true }`, still idempotent. NEW refusals: `409 ANNOUNCEMENT_NOT_DISMISSIBLE` for an `ack_required` item, and `404 ANNOUNCEMENT_NOT_FOUND` for an id the caller cannot currently see (before, any existing id answered 200, drafts included). |
| `GET /auth/me` and every `MeResponse`            | extended (new optional field)  | Gains `pendingAcknowledgements` (§4.6). Nothing else moves.                                                                                                                                                                                                              |
| `account.notice` inbox rows                      | kept (one payload key added)   | Type, deep-link and payload keys unchanged; the payload gains `announcementKind`; `body` becomes the plain-text projection of the announcement (§6).                                                                                                                     |
| Realtime gateway                                 | extended                       | NEW server event `announcement.changed` and NEW connection error `ACKNOWLEDGEMENT_REQUIRED` (§5.6).                                                                                                                                                                      |
| `GET /admin/announcements`                       | extended (admin console only)  | Items gain the admin fields of §7.1; `deliveryState` gains `archived`; `titleDe`/`bodyDe` become nullable.                                                                                                                                                               |
| `POST /admin/announcements`                      | changed (admin console only)   | Always creates a draft; the `active` request field is removed (dated 2026-10-29); NEW `kind`, `audience`, `notifyByEmail` and `notifyByEmailAfterDays`; DE optional.                                                                                                     |
| `PATCH /admin/announcements/{id}`                | changed (admin console only)   | `active` removed (dated 2026-10-29), replaced by the transitions of §7.2; edits after publishing are restricted per kind (§7.3).                                                                                                                                         |
| `DELETE /admin/announcements/{id}`               | changed (admin console only)   | Drafts only; anything published answers `409 ANNOUNCEMENT_NOT_DRAFT` (use archive).                                                                                                                                                                                      |
| `POST /admin/announcements/{id}/redeliver`       | kept                           | Unchanged; the pass it queues now walks the announcement's audience (§6).                                                                                                                                                                                                |
| `DELETE /account`                                | kept                           | Wire unchanged, and exempt from the gate (§5.3). Server-side, the account's acknowledgements are now kept pseudonymised instead of deleted (§7.5).                                                                                                                       |

**Deprecations — paste-ready for the mobile board.** None on the mobile wire. No user-facing operation, field or route key is deprecated or removed: `GET /notifications/announcements` and `POST /notifications/announcements/{id}/dismiss` keep their paths, envelopes and existing fields, and the `account.notice` inbox rows the app already renders keep their type, payload keys and deep-link. Every addition is optional to decode. Two behaviours narrow: dismiss now refuses an `ack_required` item (`409`) and an id the caller cannot see (`404`), and a window's end is now exclusive. The one removal is admin-console-only and dated 2026-10-29: the `active` request field of `POST /admin/announcements` and `PATCH /admin/announcements/{id}`, replaced by `POST /admin/announcements/{id}/publish`, `…/unpublish` and `…/archive`; the app never called those routes.

**The web's own decoder** (CEO ruling 2026-10-30). The shipping web app parses the list with `activeAnnouncementSchema` and `activeAnnouncementListResponseSchema` (`packages/contracts/src/notifications.ts`), which are `.strict()` today — so "clients ignore unknown fields" is not yet true of the web. The lane that ships the new fields (T2-A) drops `.strict()` from both in the same PR. A browser tab already open on the previous web bundle fails to decode the new fields and loses the banner until it reloads; should an `ack_required` go live before it reloads, its refused calls show generic errors until then. The mobile app never called these routes and is unaffected.

## 2. Concepts

- **Kind** (`kind`): `notice` — passive information shown while its window is open, dismissible per user. `once` — a card shown to each audience member until they close it once; closing it is the dismissal and it never returns. `ack_required` — a blocking acknowledgement: until the user acknowledges it, the gate (§5) refuses everything else. A client that meets an unknown `kind` renders the item like `notice` and never offers to acknowledge it.
- **Severity** (`severity`, KEPT): `info` · `warning` · `critical`, styling only and orthogonal to the kind. Unknown value → render as `info`.
- **Audience** (server-side only, never on the user wire): `everyone` — every user-kind account, including accounts created later; `existing_at_publish` — only accounts created strictly before the announcement's frozen cutoff: the instant it first became visible, i.e. the later of the publish instant and `startsAt` (confirmed by Chief ruling 2026-10-29). A caller outside the audience simply never sees the item; every per-id route answers `404` for it.
- **Window** (`startsAt`, `endsAt`): half-open `[startsAt, endsAt)`; `null` start = from publication, `null` end = no end. For `ack_required`, `endsAt: null` means **binding until acknowledged**, and a non-null `endsAt` is the instant the obligation **lapses**: from then on it gates nobody, can no longer be acknowledged, and the server records the users who had not acknowledged as lapsed — only if the obligation actually went live; archiving one that was still scheduled records nothing.
- **Status** (`status`): `active` (published, window open), `ended` (`endsAt` passed; for `ack_required` this is the lapse), `archived` (withdrawn by an operator; for `ack_required`, a manual lapse). Drafts and not-yet-open announcements are invisible to users. Unknown value → treat as `ended`.
- **Pending acknowledgement**: an `ack_required` item that is `active`, in the caller's audience, and that the caller has not acknowledged. Only these feed `pendingAcknowledgements` and the gate. `notice` and `once` never block anything.

## 3. Shared types

### 3.1 Locale and content

The server renders `title` and `body` in one locale per item. The requested locale (the `locale` query parameter where offered, else the caller's stored locale, reduced to its primary subtag) is used when the announcement has content in it; otherwise English. `contentLocale` says which one was rendered, `availableLocales` which exist. `ack_required` announcements always carry both `en` and `de`; `notice` and `once` may be English-only.

### 3.2 `BodyDoc` — the body as a typed tree

The server parses every body with one parser (`packages/contracts`, grammar in §3.4) and serves the result as `bodyDoc`. **Clients render `bodyDoc`, never `body`, whenever `bodyDoc` is present** — so web and mobile can never disagree about what a body means, and no client ever needs a markdown library or an HTML sanitizer.

```text
BodyDoc = { "v": 1, "blocks": Block[] }

Block   = { "t": "p",  "c": Inline[] }                          paragraph
        | { "t": "h",  "level": 2 | 3, "c": Inline[] }          heading
        | { "t": "ul", "items": Inline[][] }                    bulleted list
        | { "t": "ol", "start": integer, "items": Inline[][] }  numbered list

Inline  = { "t": "text",   "v": string }
        | { "t": "br" }                                         hard line break
        | { "t": "strong", "c": Inline[] }
        | { "t": "em",     "c": Inline[] }
        | { "t": "code",   "v": string }                        literal, monospace
        | { "t": "link",   "href": string, "c": Inline[] }
```

Rendering rules (normative):

1. Every string becomes a text node. Nothing in a `BodyDoc` is ever interpreted as HTML or markup; the web app renders it through React text nodes and keeps the repository's zero-`dangerouslySetInnerHTML` invariant.
2. `link.href` is one of three shapes, already validated by the server: an `https://` URL (open in the external browser; on the web in a new tab with `rel="noopener noreferrer"`), a `mailto:` address (hand to the mail client), or an app path beginning with a single `/` (navigate in-app; a client without that route opens the web app's origin plus the path). A client that meets any other `href` renders the link's children as plain text.
3. Unknown block `t` → skip the block. Unknown inline `t` → render its `c` children if present, else its `v` as text if present, else nothing.
4. `v` greater than 1 → ignore `bodyDoc` and render `body` as plain text with line breaks preserved.

### 3.3 `UserAnnouncement`

| Field              | Type                                       | Status                  | Meaning                                                                                          |
| ------------------ | ------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `id`               | string (uuid)                              | KEPT                    |                                                                                                  |
| `severity`         | `"info"` or `"warning"` or `"critical"`    | KEPT                    |                                                                                                  |
| `title`            | string, 1–120                              | KEPT                    | In `contentLocale`.                                                                              |
| `body`             | string                                     | KEPT, meaning qualified | The source text in `contentLocale`, to be read per `bodyFormat`. Prefer `bodyDoc`.               |
| `publishedAt`      | string (instant) or null                   | KEPT                    | When the inbox fan-out completed, as today — not when the operator pressed Publish.              |
| `kind`             | `"notice"` or `"once"` or `"ack_required"` | NEW                     | §2.                                                                                              |
| `bodyFormat`       | `"plain"` or `"markdown"`                  | NEW                     | `plain` for announcements written before this change; `markdown` (the §3.4 subset) for new ones. |
| `bodyDoc`          | `BodyDoc`                                  | NEW                     | §3.2. Render this.                                                                               |
| `contentLocale`    | `"en"` or `"de"`                           | NEW                     | The locale actually rendered.                                                                    |
| `availableLocales` | array of `"en"` or `"de"`                  | NEW                     | The locales this announcement has.                                                               |
| `contentSha256`    | string, 64 lowercase hex                   | NEW                     | Server-computed hash of exactly what was rendered (§3.5). Echo it when acknowledging.            |
| `startsAt`         | string (instant) or null                   | NEW                     | Window start.                                                                                    |
| `endsAt`           | string (instant) or null                   | NEW                     | Window end, exclusive. For `ack_required`: `null` = binding until acknowledged.                  |
| `dismissible`      | boolean                                    | NEW                     | `false` exactly for `ack_required`.                                                              |
| `status`           | `"active"` or `"ended"` or `"archived"`    | NEW                     | Always `active` in the list (§4.1).                                                              |
| `receipt`          | `AnnouncementReceipt`                      | NEW                     | The caller's own record for this item.                                                           |

`AnnouncementReceipt`:

| Field            | Type                              | Meaning                                                |
| ---------------- | --------------------------------- | ------------------------------------------------------ |
| `seenAt`         | string (instant) or null          | First time a client reported the item as shown (§4.3). |
| `dismissedAt`    | string (instant) or null          | `notice`/`once` closed by the user.                    |
| `acknowledgedAt` | string (instant) or null          | `ack_required` acknowledged.                           |
| `lapsedAt`       | string (instant) or null          | `ack_required` lapsed without an acknowledgement.      |
| `lapseReason`    | `"ended"` or `"archived"` or null | Why it lapsed.                                         |

All NEW fields are optional in the schema so an older server's payload still decodes; a current server always sends every one of them.

### 3.4 The markdown subset (bodies with `bodyFormat: "markdown"`)

Clients do not parse this — the server does (§3.2). It is specified here so the admin composer, the server and any future client agree, and because the admin preview runs the same parser.

1. Line endings are normalised to LF. The server refuses, when the announcement is saved, any C0 control character other than LF and TAB, any C1 control character, and the bidirectional controls U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069, in titles and bodies alike (`400 ANNOUNCEMENT_TEXT_INVALID`).
2. Blocks are separated by one or more blank lines. A line starting with `## ` is a level-2 heading and `### ` a level-3 heading (one line each). A run of consecutive lines each starting with `- ` or `* ` is a bulleted list, one item per line. A run of consecutive lines each starting with 1–3 digits followed by `. ` is a numbered list starting at the first line's number. Anything else is a paragraph, in which a single line break is a hard break. Blocks do not nest; quotes, code blocks, tables, rules, images and raw HTML do not exist — their syntax is ordinary text.
3. Inline, within a paragraph, heading or list item: `**strong**`; `*emphasis*` or `_emphasis_` (an underscore inside a word is text, so `snake_case` stays as typed); a span between two backticks is literal code; `[text](target)` is a link. A backslash makes the next character literal when it is a backslash, a backtick, or one of `*`, `_`, `[`, `]`, `(`, `)`, `#`, `-`, `.`. An opener with no matching closer in the same block is text. Strong and emphasis nest at most three deep; links do not nest; code holds no markup.
4. A link target must be an `https://` URL with a host and no user-info, a `mailto:` with exactly one address, or an app path that starts with exactly one `/` and contains only letters, digits and `/ _ . ~ ? = & % # -`. Every other target — `http:`, `javascript:`, `data:`, a protocol-relative `//host`, anything else — is refused at save (`400 ANNOUNCEMENT_BODY_INVALID`, `details.issues` naming field, line and column).
5. Limits: title 1–120 characters; body 1–2000 characters for `notice`, 1–10000 for `once` and `ack_required`; at most 100 blocks and 25 links per body.

A `plain` body (written before this change) becomes paragraphs split at blank lines, with single line breaks as `br` and no inline markup — exactly how the banner rendered it before.

**Plain-text projection** (the inbox body, §6, and the fallback of rendering rule 4): blocks joined by one blank line; `br` becomes a line break; list items are prefixed `- ` or `n. `; links, strong, emphasis and code contribute their text only.

### 3.5 `contentSha256`

SHA-256, lowercase hex, over the UTF-8 bytes of `bt-announcement-v1`, LF, `kind`, LF, `contentLocale`, LF, `bodyFormat`, LF, `title`, LF, `body` — the stored source, after the locale fallback. Clients never compute it; they echo the value of the item they displayed. It is what makes an acknowledgement name the exact text the person confirmed.

### 3.6 `PendingAcknowledgement`

| Field      | Type                                    | Meaning                                                             |
| ---------- | --------------------------------------- | ------------------------------------------------------------------- |
| `id`       | string (uuid)                           | The announcement.                                                   |
| `severity` | `"info"` or `"warning"` or `"critical"` |                                                                     |
| `title`    | string                                  | Locale chosen per §4.6 (`Accept-Language`, stored locale, English). |
| `startsAt` | string (instant) or null                |                                                                     |
| `endsAt`   | string (instant) or null                | `null` = binding until acknowledged; otherwise the lapse instant.   |

Arrays of it are ordered oldest obligation first — the order in which a client presents them.

## 4. User endpoints

All require an authenticated **user-kind** principal (an admin-kind session answers `403 ADMIN_ACCOUNT_KIND`, an admin-kind bearer `404`, as everywhere). Bearer scopes: reads need `notifications:read`; `seen`, `dismiss` and `acknowledge` need `notifications:write` (write implies read). `acknowledge` is additionally **first-party only**: a cookie session or a first-party OAuth token; a personal API key or a third-party OAuth token that holds the scope gets `403 API_KEY_FORBIDDEN` (audited as `api_key.scope_denied`, reason `first-party-only`) — a person acknowledges, in the web app or the first-party app, never automation (Chief ruling 2026-10-29). Every route of this section except `dismiss` is exempt from the gate (§5.3). The general rate limit applies.

### 4.1 `GET /notifications/announcements` — EXTENDED

Query: `locale` — optional, `en` or `de`; overrides the stored locale for this read.

`200`:

```text
{ "announcements": UserAnnouncement[] }
```

Contains every published announcement whose window is open now and whose audience includes the caller, except `notice`/`once` items the caller dismissed and `ack_required` items the caller acknowledged. Order: `ack_required` first (oldest obligation first), then `once`, then `notice` (each newest first); clients keep the server order. Unpaginated, at most 50 items. A client that only knows the five KEPT fields keeps decoding, but it would offer Dismiss on an `ack_required` item (refused with `409`) — every current client must read `kind`.

### 4.2 `GET /notifications/announcements/{id}` — NEW

Query: `locale` as in §4.1. `200`: one `UserAnnouncement`. Visible here: any published or archived announcement whose window has opened (ended ones included) and whose audience includes the caller — the inbox deep-link and the "what did I acknowledge" view; `status` and `receipt` tell its state. `404 ANNOUNCEMENT_NOT_FOUND` for drafts, not-yet-open announcements, announcements outside the caller's audience and unknown ids alike — indistinguishable.

### 4.3 `POST /notifications/announcements/{id}/seen` — NEW

No body. Records that a client showed the item. `200 { "ok": true }`. Idempotent and first-write-wins: a repeat never moves `seenAt`. Applies to every kind. `404 ANNOUNCEMENT_NOT_FOUND` unless the item is in the caller's current list (the §4.1 predicate, ignoring dismissal and acknowledgement).

### 4.4 `POST /notifications/announcements/{id}/dismiss` — EXTENDED

No body. `notice` and `once`: stamps `dismissedAt` (and `seenAt` when still empty); `200 { "ok": true }`; idempotent. `ack_required`: `409 ANNOUNCEMENT_NOT_DISMISSIBLE`. `404 ANNOUNCEMENT_NOT_FOUND` unless the item is in the caller's current list (the §4.1 predicate, ignoring dismissal).

### 4.5 `POST /notifications/announcements/{id}/acknowledge` — NEW

Body (strict; an unknown field is a `400 VALIDATION_ERROR`):

```text
{
  "confirm": true,              the ticked checkbox; must be the literal true
  "locale": "en" | "de",        the locale of the text the person was shown
  "contentSha256": "<64 hex>"   echoed from the item that was shown
}
```

`200`:

```text
{
  "acknowledgement": {
    "announcementId": "<uuid>",
    "acknowledgedAt": "<instant>",
    "via": "web_session" | "first_party_oauth",
    "locale": "en" | "de",
    "contentSha256": "<64 hex>"
  },
  "pendingAcknowledgements": PendingAcknowledgement[]   still owed after this one
}
```

Evaluated in this order:

1. Announcement not visible to the caller (the §4.2 predicate) → `404 ANNOUNCEMENT_NOT_FOUND`.
2. `kind` is not `ack_required` → `409 ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE`.
3. Already acknowledged by the caller → `200` with the **original** acknowledgement, unchanged, whatever this request's `locale` and `contentSha256` say. Idempotent and first-write-wins; no second audit row. A client may therefore retry a timed-out acknowledge freely; no `Idempotency-Key` is needed.
4. Not pending any more — ended, archived or lapsed → `409 ANNOUNCEMENT_NOT_PENDING`. The client refetches `/auth/me` and moves on.
5. `locale` not in `availableLocales` → `400 ANNOUNCEMENT_LOCALE_UNAVAILABLE`.
6. `contentSha256` differs from the hash of that locale's current content → `409 ANNOUNCEMENT_CONTENT_CHANGED`. The client refetches the item and asks again.
7. Otherwise the acknowledgement is recorded, and the gate lifts for this announcement on the caller's very next request.

### 4.6 `pendingAcknowledgements` on `MeResponse` — EXTENDED

Every `MeResponse` the server emits — `GET /auth/me` and every sign-in or account response that returns the signed-in user — carries:

```text
"pendingAcknowledgements": PendingAcknowledgement[]   [] when nothing is owed
```

Each item's `title` honours the request's `Accept-Language` (no query parameter): the first listed language the announcement has, q-values respected; else the caller's stored locale when the announcement has it; else the announcement's first available locale (English). Live since T2-A (#2094).

Optional in the schema only: an older server omits it, and a client reads absence as "unknown" (show nothing, rely on the gate's `403`), never as "nothing owed". It is present for bearer callers too, independently of the bearer flag (§5.4), so an app can show its dialog before the flag is ever turned on. Admin-kind sessions get `[]`.

## 5. The acknowledgement gate

### 5.1 The rule

While at least one acknowledgement is pending for the caller, every `/api/v1` request from a **gated principal** answers `403 ACKNOWLEDGEMENT_REQUIRED`, except the operations listed in §5.3. Gated principals: every user-kind cookie session, always; first-party OAuth tokens (the mobile app) when the flag of §5.4 is `first_party`. **Personal API keys and third-party (partner) OAuth tokens are never gated**, whatever the flag (Chief ruling 2026-10-29): automation is never blocked by an announcement, and the person behind it acknowledges in the web app or the first-party app. Admin-kind principals are never gated. Pending is evaluated on every request against the server clock, so an announcement starts gating at `startsAt` and stops at `endsAt` exactly, with nobody having to touch it; an acknowledgement, an archive or a shortened window takes effect on the next request.

### 5.2 The refusal

```text
HTTP/1.1 403 Forbidden
Cache-Control: no-store

{
  "error": {
    "code": "ACKNOWLEDGEMENT_REQUIRED",
    "message": "An announcement needs your acknowledgement before you can continue.",
    "details": { "pendingAcknowledgements": PendingAcknowledgement[] }
  }
}
```

`details.pendingAcknowledgements` is never empty and has the shape and order of §3.6, so one decoder serves `/auth/me` and the refusal.

### 5.3 Exempt operations (exact list)

Thirty-six operations (CEO ruling 2026-10-30; `PROJECTPLAN.md` §6.19.7 restates the identical set). Paths are relative to `/api/v1`. Matching is exact on method and path, case-sensitive, with no trailing slash and no prefix matching; `{id}` matches one canonical UUID segment and `{token}` one non-empty segment; `HEAD` is matched as `GET`. Anything not listed here is gated — including every route added in future.

| Method   | Path                                            | Why it stays reachable                                                         |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET`    | `/auth/me`                                      | Identity, carrying `pendingAcknowledgements`.                                  |
| `POST`   | `/auth/logout`                                  | The "Sign out" alternative; a bearer self-revokes its grant.                   |
| `DELETE` | `/account`                                      | Delete account (owner directive), linked from the gate dialog.                 |
| `GET`    | `/auth/2fa/status`                              | Delete account: the form reads it to offer the authenticator-code field.       |
| `POST`   | `/account/export`                               | Export my data, linked from the gate dialog: take your data and leave.         |
| `GET`    | `/account/export`                               | Export my data (export status).                                                |
| `POST`   | `/account/export/download`                      | Export my data (the download).                                                 |
| `GET`    | `/vault/media`                                  | Export my data, vault owner: which medium holds the vault (read-only).         |
| `GET`    | `/vault`                                        | Export my data, vault owner: the server-held ciphertext (read-only).           |
| `GET`    | `/drive-connections`                            | Export my data, vault owner: whether the Drive copy is reachable (read-only).  |
| `POST`   | `/auth/change-password`                         | A forced password change completes first (§5.5); then the gate applies.        |
| `POST`   | `/auth/session/persist`                         | Credential entry: keeps "Stay signed in" for a sign-in that meets the gate.    |
| `POST`   | `/auth/remembered-device`                       | Credential entry: keeps "Remember this device" (binding only; DELETE gated).   |
| `GET`    | `/notifications/announcements`                  | The gate's own content.                                                        |
| `GET`    | `/notifications/announcements/{id}`             | The gate's own content, per item and per locale.                               |
| `POST`   | `/notifications/announcements/{id}/seen`        | Receipt of the shown item.                                                     |
| `POST`   | `/notifications/announcements/{id}/acknowledge` | The acknowledgement itself.                                                    |
| `GET`    | `/feature-flags`                                | Shell bootstrap; a global on/off map, no account data.                         |
| `GET`    | `/auth/pin/status`                              | The PIN app-lock is resolved before the gate is shown.                         |
| `POST`   | `/auth/pin/verify`                              | The PIN app-lock is resolved before the gate is shown.                         |
| `POST`   | `/auth/login`                                   | Credential entry: a stale cookie of a pending account never blocks signing in. |
| `POST`   | `/auth/2fa/verify`                              | Credential entry.                                                              |
| `POST`   | `/auth/2fa/email-code`                          | Credential entry.                                                              |
| `POST`   | `/auth/passkeys/login/options`                  | Credential entry.                                                              |
| `POST`   | `/auth/passkeys/login/verify`                   | Credential entry.                                                              |
| `POST`   | `/auth/pin/quick-auth`                          | Credential entry (OAuth-flow PIN re-auth).                                     |
| `GET`    | `/auth/google/start`                            | Credential entry.                                                              |
| `GET`    | `/auth/google/callback`                         | Credential entry.                                                              |
| `GET`    | `/auth/google/register-ticket`                  | Credential entry (registration).                                               |
| `POST`   | `/auth/google/register`                         | Credential entry (registration).                                               |
| `GET`    | `/auth/registration-info`                       | Credential entry (registration).                                               |
| `POST`   | `/auth/register`                                | Credential entry (registration).                                               |
| `GET`    | `/auth/invite/{token}`                          | Credential entry (invite).                                                     |
| `POST`   | `/auth/accept-invite`                           | Credential entry (invite).                                                     |
| `POST`   | `/auth/password-reset/request`                  | Credential entry (reset).                                                      |
| `POST`   | `/auth/password-reset/complete`                 | Credential entry (reset).                                                      |

**A legal acknowledgement must not hold the user's data hostage** (Chief ruling 2026-10-29): someone who will not accept can always take their data and leave, which is why the deletion and data-egress rows exist and why the dialog links them (§5.7). `GET /auth/2fa/status` is exempt only so the Delete account form can tell a 2FA-enrolled account that an authenticator code is accepted; it returns the caller's own enrolment flags and nothing else.

**Vault owners can leave too** (CEO ruling 2026-10-30). The server export carries no vaulted cleartext, so for an account in the account-level vault the dialog's Export my data also offers the client-side cleartext export, which unlocks the vault in the browser (passphrase or recovery kit — no server call) and builds the archive from the decrypted copy. It needs exactly the three read-only operations above, `GET /vault/media`, `GET /vault` and `GET /drive-connections`; the Drive copy is read from Google Drive directly, not through this API. A gated caller may read vault data **only for that export**: those three rows are an exact allowlist, never a prefix match on `/vault` or `/vaults`. Every vault write stays gated (`PUT /vault`, `PATCH /vault/media`, the `/vault/media/*` transitions), and so does every other vault read (`/vault/history`, the `/vault/media/*` reads) and everything under `/vaults` and `/drive-connections` other than the rows above — **including any route added there later, which does not inherit the exemption** (Chief guard 2026-10-30). Per-portfolio vaults need none of this: their server-held ciphertext is already in the server export (`paranoid/vaults/<vaultId>/docs/`), and their Drive copies are in the owner's own Drive. The web has no per-portfolio cleartext export today; the PR that adds one adds its exact read operations to this table.

Deliberately **not** exempt: `POST /notifications/announcements/{id}/dismiss` (nothing else is usable until acknowledged), the OAuth consent routes `/oauth/authorize` and `/oauth/authorization-details` (a sign-in from the app through the browser meets the web gate first and acknowledges there), `POST /auth/first-run/complete` and the paranoid fresh-start acknowledgement (both come after the gate), `DELETE /auth/remembered-device`, every vault write and every unlisted `/vault`, `/vaults` or `/drive-connections` route, and every settings route. Outside the chain and therefore unaffected: `/oauth/token` (token refresh keeps working), `/version`, the health probes, `/docs`, `/openapi.json`. Translations are compiled into the clients, so no route is needed for them. The realtime handshake is **refused**, not exempt (§5.6).

### 5.4 Bearer enforcement flag

`BT_ANNOUNCEMENT_ACK_GATE_BEARER` — deployment configuration, read at boot:

| Value           | Bearer principals gated                                                |
| --------------- | ---------------------------------------------------------------------- |
| `off` (default) | None. Bearer requests are never refused for a pending acknowledgement. |
| `first_party`   | First-party OAuth tokens (the mobile app) only.                        |

No value gates a personal API key or a third-party (partner) OAuth token (Chief ruling 2026-10-29): automation is never blocked by an announcement, and people acknowledge in the web app or the first-party app. Any other value fails the boot. Whatever the value: cookie sessions are always gated; `pendingAcknowledgements` is on every `MeResponse`; §4 works for bearers under its scopes; acknowledging stays first-party only. **Who flips it, and when** (Chief ruling 2026-10-30 relaying the owner): `BT_ANNOUNCEMENT_ACK_GATE_BEARER` ships OFF and stays OFF by default; flipping it to `first_party` is an OWNER action on the production host's env file (nobody else can touch it), with the documented precondition "the announcements API is live AND every first-party install the owner cares about runs app build 152 or later" — NO calendar date. The admin console shows the current value read-only (`bearerAckGate` on `GET /admin/announcements`); the API can never write it.

### 5.5 Precedence

A request meets the checks in this order, and the first refusal wins: authentication `401` → rate limit `429` → CSRF `403` (cookie sessions) → `403 PASSWORD_CHANGE_REQUIRED` → bearer scope `403 INSUFFICIENT_SCOPE` or `API_KEY_FORBIDDEN` (bearer) → **`403 ACKNOWLEDGEMENT_REQUIRED`** → resource checks (vault, ownership, feature flags) → the route. So a forced password change is completed first, an under-scoped bearer learns about its scope first, and a gated request never reaches a resource lookup. In particular a principal that must change its password cannot read or acknowledge an announcement yet: those calls answer `403 PASSWORD_CHANGE_REQUIRED`, while `POST /auth/change-password` passes both checks (it is exempt here). The sequence is therefore change password → gate: the very next request after the change meets `ACKNOWLEDGEMENT_REQUIRED` (CEO ruling 2026-10-30).

### 5.6 Realtime

- **Connection error `ACKNOWLEDGEMENT_REQUIRED`** (NEW in the handshake vocabulary): a socket handshake from a gated principal with a pending acknowledgement is refused with it. The client does not retry in a loop: it shows the gate and reconnects after the last acknowledgement. Clients treat an unknown connection error like `UNAVAILABLE`.
- **Server event `announcement.changed`** (NEW), payload `{ "announcementId": "<uuid>" }`: sent to every connected user-kind socket (session sockets; bearer sockets holding `notifications:read`) when an announcement goes live (its first delivery pass), is unpublished, archived, has its window edited, or lapses. No content travels on the socket. The client refetches `/auth/me` and `GET /notifications/announcements`; the 30-second poll stays the fallback.
- Sockets already open when an acknowledgement becomes pending are not disconnected by the server: the pending check runs in the handshake only, never in the server's periodic revalidation of open sockets (CEO ruling 2026-10-30). The event above makes the client close its own socket and raise the gate, and every HTTP request is refused in any case. Socket.IO does not reconnect by itself after a handshake refusal, so the client reconnects once the last acknowledgement is done.

### 5.7 Client obligations

1. On launch, on resume, after sign-in and on `announcement.changed`: read `pendingAcknowledgements`; when it is non-empty, show the blocking dialog instead of the app.
2. Treat `403 ACKNOWLEDGEMENT_REQUIRED` from any request the same way, taking the list from `details`; do not retry the refused request until the dialog has been completed.
3. The dialog shows one item at a time in the given order, with the full body (`GET /notifications/announcements/{id}`), an unticked checkbox, a Confirm action enabled only once the box is ticked, and a prominent Sign out (`POST /auth/logout`). Below them a secondary row offers **Export my data** and **Delete account**, both exempt (§5.3), because a legal acknowledgement must not hold the user's data hostage (Chief ruling 2026-10-29); an app without a native flow for one of them opens the web app, whose dialog offers both (for a vault owner including the cleartext export, §5.3). It cannot be dismissed any other way. When both locales exist, offer a language switch (re-fetch with `locale`) and acknowledge with the locale and hash of the text on screen.
4. On `409 ANNOUNCEMENT_NOT_PENDING`, refetch `/auth/me` and continue; on `409 ANNOUNCEMENT_CONTENT_CHANGED`, refetch the item and ask again.

## 6. Inbox rows (`account.notice`)

The `announcements.publishDue` fan-out keeps its shape: one inbox row of type `account.notice` per recipient, once per announcement, never pushed, deep-linking where it does today (`docs/mobile-push.md` §4). Three things change. Recipients are the announcement's audience (user-kind accounts only; for `existing_at_publish`, those created before the cutoff). The payload gains `announcementKind` beside the existing `notice: "announcement"` and `announcementId`. The row's `body` is the plain-text projection (§3.4) — the whole body for `notice` (at most 2000 characters, as today), the first 500 characters plus an ellipsis for `once` and `ack_required`, whose full text is read through §4.2. The `title` is unchanged. An inbox row is a record, not the gate: acknowledging happens only through §4.5.

**E-mail — admin opt-in, `ack_required` only, default off** (Chief ruling 2026-10-29). When the operator ticked "Also notify by e-mail" (`notifyByEmail`, §7.3), a separate periodic pass — not this fan-out — waits `notifyByEmailAfterDays` days after the window opened (default 7; `0` = at window open; Chief ruling 2026-10-30) and then sends each audience member who is **still pending** at that moment exactly one e-mail, ever, through the existing e-mail channel, in their stored locale (English fallback): the title, the plain-text projection and a link to the web app's `/announcements/{id}`. It is meant for the accounts that never show up; an announcement archived or ended before that instant sends none. The e-mail carries no acknowledge link and no token; acknowledging still happens only through §4.5, signed in. Nothing about it is on the mobile wire.

## 7. Admin endpoints (admin console only — not on the mobile wire)

Admin-kind session with confirmed 2FA, as every `/admin/*` route; bearer and user-kind callers get `404`. Every write is audit-logged (`PROJECTPLAN.md` §6.19.11).

### 7.1 `Announcement` (admin shape) — EXTENDED

KEPT fields: `id`, `severity`, `titleEn`, `bodyEn`, `startsAt`, `endsAt`, `publishedAt`, `deliveredCount`, `failedCount`, `createdAt`, `updatedAt`. CHANGED: `titleDe` and `bodyDe` become string or null; `active` is now derived (`true` exactly while `lifecycle` is `published`) and read-only; `deliveryState` gains `archived` (values `draft`, `scheduled`, `publishing`, `published`, `expired`, `archived`). NEW: `kind`; `audience` (`everyone` or `existing_at_publish`); `lifecycle` (`draft`, `published` or `archived`); `bodyFormat`; `releasedAt` (when an operator published it; null for drafts); `audienceCutoffAt` (the frozen cutoff; null for drafts); `archivedAt`; `lapseRecordedAt` (when the lapse pass completed; `ack_required` only); `notifyByEmail` (boolean, default `false`; `true` only on `ack_required`, §6); `notifyByEmailAfterDays` (integer 0–365, default `7`; days after the window opened, `0` = at window open; Chief ruling 2026-10-30); `emailPassRecordedAt` (when the e-mail pass completed; null otherwise).

### 7.2 Lifecycle transitions — NEW

| Operation                                  | From                             | To          | Refusals                                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/announcements/{id}/publish`   | `draft`                          | `published` | `409 ANNOUNCEMENT_NOT_DRAFT`; `400 ANNOUNCEMENT_INCOMPLETE` (`details.missing`: EN title and body always, DE too for `ack_required`); `400 INVALID_ANNOUNCEMENT_WINDOW` (an `endsAt` at or before now, or before `startsAt`) |
| `POST /admin/announcements/{id}/unpublish` | `published`, window not yet open | `draft`     | `409 ANNOUNCEMENT_ALREADY_LIVE` once the window has opened — archive instead                                                                                                                                                 |
| `POST /admin/announcements/{id}/archive`   | `published`                      | `archived`  | `409 ANNOUNCEMENT_NOT_PUBLISHED` for a draft (delete it); idempotent on an archived one                                                                                                                                      |

No body; each answers `200` with the `Announcement`. Each of them, and an `endsAt` edit (§7.3), bumps the gate-cache generation after its commit. If that bump fails, the call answers `503 ANNOUNCEMENT_PROPAGATION_UNCONFIRMED`: the write is kept and takes effect on every instance within 60 seconds at the latest, and the console says so instead of reporting a silent success (CEO ruling 2026-10-30, the `FEATURE_FLAG_PROPAGATION_UNCONFIRMED` pattern). Publishing stamps `releasedAt` and freezes `audienceCutoffAt` as the later of the publish instant and `startsAt` (confirmed by Chief ruling 2026-10-29); the cutoff never moves afterwards.

### 7.3 Create, edit, delete — CHANGED

- `POST /admin/announcements` — body: `kind` (default `notice`), `audience` (default `everyone`), `severity`, `titleEn`, `bodyEn`, `titleDe` (string or null, optional), `bodyDe` (string or null, optional), `startsAt`, `endsAt` (optional), `notifyByEmail` (default `false`; `true` is accepted only together with `kind: "ack_required"`, otherwise `400 VALIDATION_ERROR` naming the field), `notifyByEmailAfterDays` (integer, default `7`; outside 0–365 → `400 VALIDATION_ERROR`). `201` with a draft. The text rules of §3.4 apply on every save.
- `PATCH /admin/announcements/{id}` — the same fields, partial. A draft takes any change. After publishing, `kind`, `audience`, `startsAt`, `notifyByEmail` and `notifyByEmailAfterDays` are locked for every kind; `notice` and `once` still take content and `endsAt` changes; `ack_required` takes only `endsAt` (a new value must lie in the future, or be null). Once `endsAt` has passed, nothing but archive is accepted. A locked field answers `409 ANNOUNCEMENT_FIELD_LOCKED` with `details.fields`; an ended announcement `409 ANNOUNCEMENT_ENDED`.
- `DELETE /admin/announcements/{id}` — drafts only, `204`; otherwise `409 ANNOUNCEMENT_NOT_DRAFT`.

### 7.4 The acknowledgement log — NEW

`GET /admin/announcements/{id}/stats` → `200`:

```text
{
  "announcementId": "<uuid>",
  "kind": "notice" | "once" | "ack_required",
  "audience": integer,         accounts in the audience now (a draft: as if published now)
  "seen": integer,
  "dismissed": integer,
  "acknowledged": integer,     by accounts that still exist
  "acknowledgedByDeletedAccounts": integer,
                               pseudonymised rows of accounts deleted since (§7.5);
                               counted in neither audience nor pending
  "lapsed": integer,
  "pending": integer | null,   ack_required only: audience - acknowledged - lapsed
  "lapseRecorded": boolean,
  "computedAt": "<instant>"
}
```

`GET /admin/announcements/{id}/receipts?state=&cursor=&limit=` → `200 { "items": Receipt[], "nextCursor": string | null }`. `state` is one of `pending`, `acknowledged`, `lapsed`, `seen`, `dismissed`, `unseen`, `all` (default `all`); `limit` 1–200, default 50; keyset-paginated (live accounts by account id, then the rows of deleted accounts by `subjectToken`), `cursor` opaque. `pending` means not acknowledged and not lapsed (`ack_required`), or not dismissed (`notice`, `once`). Receipt:

```text
{
  "userId": "<uuid>" | null,              null once the account is deleted (§7.5)
  "subjectToken": "<64 hex>" | null,      set exactly when userId is null
  "username": string | null,
  "accountCreatedAt": "<instant>" | null,
  "accountStatus": "active" | "disabled" | "deleted",
  "state": "pending" | "acknowledged" | "lapsed" | "seen" | "dismissed" | "unseen",
  "seenAt": instant | null,
  "dismissedAt": instant | null,
  "acknowledgedAt": instant | null,
  "acknowledgedVia": "web_session" | "first_party_oauth" | null,
  "acknowledgedLocale": "en" | "de" | null,
  "contentSha256": string | null,
  "lapsedAt": instant | null,
  "lapseReason": "ended" | "archived" | null
}
```

`GET /admin/announcements/{id}/receipts.csv?state=` → `200 text/csv; charset=utf-8` with `Content-Disposition: attachment`: the same columns in that order under a snake_case header row, streamed in keyset pages; every download writes an `announcement.receipts_export` audit row. Neither form carries e-mail addresses or IP addresses.

### 7.5 Deleted accounts — acknowledgement evidence survives, pseudonymised — NEW

Chief ruling 2026-10-29. Deleting an account (self-service `DELETE /account` or the admin console) deletes its receipts **except** those with an acknowledgement, which are pseudonymised in the same transaction and kept as evidence. Such a row keeps exactly the announcement, `acknowledgedAt` and `contentSha256`, and gains `subjectToken`: HMAC-SHA256 of the former user id under a server-held key, lowercase hex — irreversible, and identical across all of one former account's rows. The keyed HMAC, not a random token, is ruled (Chief ruling 2026-10-30): a dispute must be answerable by the key holder, who can confirm or deny an acknowledgement for a given former user id. Such rows are retained for as long as the announcement exists (Chief ruling 2026-10-30), and the Privacy page says so.

**The token derivation is pinned** (CEO ruling 2026-10-30) so that the server and any later verifier agree byte for byte:

1. IKM is the 32-byte key of the stored-record encryption keyring entry in use — the key the record encryption itself uses, derived from `BT_DATA_ENCRYPTION_KEY`, never the raw environment string. `subject_key_id` is that entry's id.
2. K = HKDF-SHA256(IKM, salt = the empty string, info = the UTF-8 bytes of `bt-announcement-receipt-pseudonym-v1`, length 32).
3. `subjectToken` = lowercase hex of HMAC-SHA256(K, the UTF-8 bytes of the user id in canonical lowercase hyphenated form, 36 bytes).

```text
Test vector
  IKM            000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
  user id        00000000-0000-4000-8000-000000000001
  K              7c5ecb143644a467b966721d77062a4978bab1a3f2eb70373c117a2420e1f80f
  subjectToken   6f48c96a684cc03b8a9367ab7e8d225a70a458cea430c9068c6971f3a9b3cbb3
```

The `announcement.acknowledge` audit row stores no IP, via or locale — only the user, the announcement and the instant (`PROJECTPLAN.md` §6.19.11). After a deletion, then, nothing outside the pseudonymised receipt ties an acknowledgement to an address or a device: the audit row's actor is nulled like every audit row's, and it carries nothing else. Everything else that could point at the person is dropped: `userId`, `username`, `accountCreatedAt`, `acknowledgedVia`, `acknowledgedLocale`, the OAuth grant and every seen, dismissed and lapsed field are null. In the receipts list and CSV it reads `accountStatus: "deleted"` and `state: "acknowledged"`, appears under `acknowledged` and `all` only, after the live accounts, and counts in `acknowledgedByDeletedAccounts`, never in `audience`, `acknowledged` or `pending`.

## 8. Error codes

| Code                                   | Status | Where                                                                                           |
| -------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| `ACKNOWLEDGEMENT_REQUIRED`             | 403    | Any gated request while an acknowledgement is pending (§5); also a realtime connection error.   |
| `ANNOUNCEMENT_NOT_FOUND`               | 404    | Unknown, draft, not-yet-open or out-of-audience id (KEPT code, wider use).                      |
| `ANNOUNCEMENT_NOT_DISMISSIBLE`         | 409    | Dismissing an `ack_required` item.                                                              |
| `ANNOUNCEMENT_NOT_ACKNOWLEDGEABLE`     | 409    | Acknowledging a `notice` or `once` item.                                                        |
| `ANNOUNCEMENT_NOT_PENDING`             | 409    | Acknowledging an ended, archived or lapsed obligation.                                          |
| `ANNOUNCEMENT_CONTENT_CHANGED`         | 409    | The echoed `contentSha256` no longer matches.                                                   |
| `ANNOUNCEMENT_LOCALE_UNAVAILABLE`      | 400    | Acknowledging in a locale the announcement does not have.                                       |
| `ANNOUNCEMENT_TEXT_INVALID`            | 400    | Admin save: a forbidden control or bidirectional character.                                     |
| `ANNOUNCEMENT_BODY_INVALID`            | 400    | Admin save: a refused link target or an exceeded limit; `details.issues`.                       |
| `ANNOUNCEMENT_INCOMPLETE`              | 400    | Admin publish: required content missing; `details.missing`.                                     |
| `ANNOUNCEMENT_NOT_DRAFT`               | 409    | Admin publish or delete of a non-draft.                                                         |
| `ANNOUNCEMENT_NOT_PUBLISHED`           | 409    | Admin archive of a draft.                                                                       |
| `ANNOUNCEMENT_ALREADY_LIVE`            | 409    | Admin unpublish after the window opened.                                                        |
| `ANNOUNCEMENT_FIELD_LOCKED`            | 409    | Admin edit of a field locked after publishing; `details.fields`.                                |
| `ANNOUNCEMENT_ENDED`                   | 409    | Admin edit of an ended announcement.                                                            |
| `ANNOUNCEMENT_PROPAGATION_UNCONFIRMED` | 503    | Admin transition or `endsAt` edit saved, but the gate-cache bump failed; effective within 60 s. |
| `INVALID_ANNOUNCEMENT_WINDOW`          | 400    | Admin save or publish with an impossible window (KEPT code).                                    |
| `API_KEY_FORBIDDEN`                    | 403    | `acknowledge` with a personal API key or a third-party token (KEPT code).                       |

## 9. Mobile rollout sequence

1. **The server ships with the flag `off`.** No app change is required. `pendingAcknowledgements` appears on `MeResponse`; §4 is callable with the app's existing `notifications:*` scopes; the gate refuses nothing the app sends. A sign-in from the app through the browser meets the web gate first, because the consent page runs on a web session.
2. **The app builds the dialog** per §5.7, plus the `announcement.changed` listener and the handshake error. Rendering `notice` and `once` is optional; reading `kind` is not.
3. **The app version with the dialog ships** and the board names it. Only then does the owner set `BT_ANNOUNCEMENT_ACK_GATE_BEARER=first_party` in production. From that moment an older app without the dialog receives `403 ACKNOWLEDGEMENT_REQUIRED` on gated routes while something is pending, so the flag flips only once those versions have aged out.
4. **There is no later step.** Personal API keys and partner apps are never gated (Chief ruling 2026-10-29); the flag has no value that would gate them.
