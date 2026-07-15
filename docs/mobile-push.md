# Mobile push (FCM) — contract for the app track

Written for the Android app track. Documents the FCM HTTP v1 push channel as it
currently ships (V3-P11c prep #351, HTTP v1 sends #368, key placement #421,
V4-P3 go-live). Every claim below carries a file/line pointer so the app team
can grep the truth against this doc.

The single source of truth in code:

- `apps/api/src/services/notifications/fcm.ts` — the channel (build, send, prune)
- `apps/api/src/services/notifications/notificationDispatcher.ts` — what a
  `PushMessage` looks like per event type (title/body/data/deep-link ids)
- `apps/api/src/http/routes/notificationsRoutes.ts` — the device endpoints
- `apps/api/src/http/middleware/bearerAuth.ts` — bearer auth + scope policy
- `apps/api/src/config/env.ts` — the `BT_FCM_SERVICE_ACCOUNT_FILE` env gate
- `packages/contracts/src/notifications.ts` — device request/response schemas
- `packages/contracts/src/oauth.ts` — plain-language scope labels

---

## 1. Device-token lifecycle

The device-token flow is a straight loop between the FCM SDK on device, the two
`/notifications/devices` endpoints on the API, and the automatic server-side
prune when FCM tells us a token is dead.

**Obtain (client).** The FCM SDK mints a registration token per install and
rotates it whenever the SDK decides it must (reinstall, restore, notification
permission granted, project change). The app treats every fresh token as a new
registration — do NOT try to detect "same token" client-side and skip the call.

**Register.** POST the token to the API:

```
POST /api/v1/notifications/devices
Content-Type: application/json

{ "token": "<fcm-registration-token>", "platform": "android" }
→ 200 { "ok": true }
```

- Idempotent by design: the DB uses a UNIQUE constraint on `token` and the
  upsert re-binds owner + platform + bumps `last_seen_at` on conflict — never a
  duplicate row (`apps/api/src/data/repositories/deviceTokenRepository.ts:29–37`,
  table def `apps/api/src/data/schema.ts:526–542`).
- **Re-binding is deliberate:** if the device logs into another account, that
  account's next register call takes ownership so pushes follow the current
  user, not the previous one. Documented in the code and the schema comment
  (`deviceTokenRepository.ts:8–13`, `schema.ts:519–523`).
- `platform` must be one of `"android" | "ios" | "web"` — the contract enum
  (`packages/contracts/src/notifications.ts:68`). `token` is 1–4096 chars
  (`notifications.ts:79`).
- **Works while the channel is off.** The endpoint stores the token even when
  `BT_FCM_SERVICE_ACCOUNT_FILE` is unset; the row will be picked up when the
  key is mounted later (see §5). Route note:
  `apps/api/src/http/routes/notificationsRoutes.ts:73–80`.

**Refresh.** When the SDK reports a new token, call the same POST again with
the new token. No separate refresh endpoint — the upsert IS the refresh path.
The app SHOULD also unregister the previous token (see below) so the fan-out
set stays clean, but the server prune (below) is the ultimate safety net.

**Sign-out cleanup.** On explicit sign-out, delete the token before dropping
the session/bearer:

```
DELETE /api/v1/notifications/devices
Content-Type: application/json

{ "token": "<fcm-registration-token>" }
→ 200 { "ok": true }
```

Strictly caller-scoped: a token owned by another user (or unknown) deletes
nothing — a client CANNOT unregister another user's device
(`deviceTokenRepository.ts:44–48`, route
`notificationsRoutes.ts:82–87`). Idempotent — repeat calls are still `200`.

**Server-side UNREGISTERED pruning.** After each send the channel inspects the
FCM v1 error body. When it sees the structured `errorCode: UNREGISTERED` (both
the canonical NOT_FOUND/404 shape and the 400 variant), it calls
`devices.deleteByToken(token)` and moves on to the next device. Nothing else
prunes — a bare 404, a 400 `INVALID_ARGUMENT` (payload regression), a transient
5xx never wipe tokens (`apps/api/src/services/notifications/fcm.ts:164–227`;
prune call at `:222–227`). Practical consequence for the app: an uninstalled or
notification-disabled device stops receiving pushes on its own; no client
action required.

---

## 2. Auth

Both endpoints sit under `/api/v1/notifications/*` and take **either** a session
cookie (web) **or** a bearer token (personal API key `btk_…` or OAuth access
token `bto_…`). The web app uses cookies; the Android app uses a bearer.

**Scope requirement (bearer only).** The scope policy for `/notifications/*` is:

- `notifications:read` — GET (list, unread count, …)
- `notifications:write` — POST/DELETE (mark-read, archive, hard delete, **device
  register + delete**, web-push subscribe/unsubscribe)

Registering or deleting a device token counts as a **write** (mutation), so the
bearer needs `notifications:write`. `notifications:write` also implies
`notifications:read` — a write-scoped token can call the read endpoints as
well (write-implies-read, enforced centrally in
`apps/api/src/http/middleware/bearerAuth.ts:227–232`). Policy map for
`/notifications`: `bearerAuth.ts:94`. Plain-language consent labels the OAuth
authorize screen shows: `packages/contracts/src/oauth.ts:50–51`.

Cookie sessions bypass the scope map (full access) so the web app is
unaffected.

Common failure modes for a bearer request:

- `401 API_KEY_INVALID` — the header was malformed or the token is unknown/
  revoked (`bearerAuth.ts:49`).
- `403 INSUFFICIENT_SCOPE` — the token authenticates but lacks
  `notifications:write` (or `:read` on GETs) (`bearerAuth.ts:238–241`; the
  denial is audited on the personal-key or OAuth-grant record).

---

## 3. Payload contract

Every push sent to a device is a **data message + notification block** with
Android priority `HIGH`. The build site is
`apps/api/src/services/notifications/fcm.ts:196–207`:

```json
{
  "message": {
    "token": "<device token>",
    "data": { "<per-type deep-link keys>": "…", "type": "<notification type>" },
    "notification": { "title": "<title>", "body": "<body>" },
    "android": { "priority": "HIGH" }
  }
}
```

Contract rules:

- `notification.{title,body}` render the system notification when the app is
  backgrounded.
- `data` is a **string→string** map (FCM's requirement; enforced by the
  `PushMessage.data: Record<string, string>` type at
  `fcm.ts:39–46`).
- **`data.type` is always present** and equals one of the canonical notification
  types (§4). The channel writes it on top of every payload (`fcm.ts:202`,
  `data: { ...message.data, type: message.type }`), so a foregrounded client
  can route the tap deterministically off `data.type` alone.
- `android.priority: "HIGH"` on every message — the mobile client's contract
  (`fcm.ts:204`).

The `PushMessage` the dispatcher hands to the channel is the same struct
consumed by web-push, so the payload semantics are identical across both push
channels (`apps/api/src/services/notifications/notificationDispatcher.ts:584–589`).

### 3.1. Canonical notification types

The `type` value is one of the canonical taxonomy in
`packages/contracts/src/notifications.ts:21–35`
(`NOTIFICATION_TYPES`):

| `type`                  | Trigger                                      |
| ----------------------- | -------------------------------------------- |
| `friend.request`        | Someone sent the user a friend request       |
| `friend.accepted`       | A friend request the user sent was accepted  |
| `portfolio.shared`      | A friend shared a portfolio with the user    |
| `watchlist.shared`      | A friend shared a watchlist with the user    |
| `conglomerate.shared`   | A friend shared a conglomerate with the user |
| `friend.activity`       | A friend's activity (buy/sell/watchlist add) |
| `follow.published`      | A followed user newly published an item      |
| `follow.alert.created`  | A followed user created a price alert        |
| `follow.alert.fired`    | A followed user's alert fired                |
| `account.temp_password` | An admin reset the user's password           |
| `alert.triggered`       | The user's own price alert fired             |
| `chat.message`          | New chat message                             |

`account.invite` is defined in the taxonomy but never dispatched through the
push channel (it's an email-only surface).

### 3.2. `data` keys per type

The dispatcher's `render(...)` function is the sole author of `data` for each
event; `fcm.ts` then merges `type` onto it before sending. Source:
`apps/api/src/services/notifications/notificationDispatcher.ts:237–427`.

| `type`                  | `data` keys (before `type` is merged)                           | Source                              |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `friend.request`        | `requestId`                                                     | `notificationDispatcher.ts:251`     |
| `friend.accepted`       | `requestId`                                                     | `notificationDispatcher.ts:264`     |
| `portfolio.shared`      | `portfolioId`                                                   | `notificationDispatcher.ts:277`     |
| `watchlist.shared`      | `watchlistId`                                                   | `notificationDispatcher.ts:290`     |
| `conglomerate.shared`   | `conglomerateId`                                                | `notificationDispatcher.ts:303`     |
| `friend.activity`       | `itemKind`, `itemId`                                            | `notificationDispatcher.ts:319`     |
| `follow.published`      | `itemKind`, `itemId`, `username` (public-profile slug of actor) | `notificationDispatcher.ts:337–341` |
| `follow.alert.created`  | `alertId`, `assetId`                                            | `notificationDispatcher.ts:374`     |
| `follow.alert.fired`    | `alertId`, `assetId`                                            | `notificationDispatcher.ts:374`     |
| `account.temp_password` | _(none)_                                                        | `notificationDispatcher.ts:384`     |
| `alert.triggered`       | `alertId`, `assetId`                                            | `notificationDispatcher.ts:405`     |
| `chat.message`          | `conversationId`, `messageId`                                   | `notificationDispatcher.ts:425`     |

After merge every payload also carries `data.type`.

Titles and bodies for each type live in the same `render(...)` function; they
are English today (i18n of push copy is not in V4). Reference examples:
`alert.triggered` uses `alertTitle(symbol)` / `alertBody(...)` from
`apps/api/src/services/alerts/alertMessages.ts`; `chat.message` **does embed
message content in the push body**: when the message has text the body is
rendered as `"{sender}: {preview}"`, where `preview` is up to 140 characters
of the message text (`PREVIEW_MAX` at `apps/api/src/services/chat/chatService.ts:46`,
sliced at `:296`, used at `notificationDispatcher.ts:413–414`); it falls back
to `"{sender} shared an item with you."` for a chip-only message and
`"{sender} sent you a message."` otherwise (`notificationDispatcher.ts:415–417`).
This is **materially less private than the email surface**, which renders
only the actor's username with no content
(`apps/api/src/services/email/templates.ts:289–310`) — the mobile client's
lock-screen / notification-shade visibility settings should account for
this. The `data` map itself is content-free (only `conversationId` and
`messageId`, per §3.2), so any content-hiding UI can key off `data.type`
without inspecting `notification.body`.

---

## 4. Deep-link keys

Deep-link routing uses `data.type` as the discriminator plus the type's `data`
ids from §3.2. Recommended mapping today (drawn straight from the ids above; no
extra keys are transmitted):

- `alert.triggered`, `follow.alert.created`, `follow.alert.fired`
  → asset detail for `data.assetId`
- `chat.message` → chat conversation `data.conversationId`, scroll to
  `data.messageId`
- `portfolio.shared` → the shared portfolio (`data.portfolioId`)
- `watchlist.shared` → the shared watchlist (`data.watchlistId`)
- `conglomerate.shared` → the shared conglomerate (`data.conglomerateId`)
- `friend.request` → friend-requests screen (deep target uses `data.requestId`)
- `friend.accepted` → the friends list
- `friend.activity`, `follow.published` → the actor's public profile for
  `data.itemKind` + `data.itemId` (`follow.published` also carries
  `data.username` — the public-profile slug — for a direct nav)
- `account.temp_password` → security / password screen

> **Route-key matrix finalized by V4-P0c.**
> V4-P0c ("Notification UX") owns the canonical route-key contract for every
> notification type across in-app deep links + FCM. Until P0c lands, the map
> above IS the contract — the app should route off `data.type` + the ids
> above. When P0c ships, this section is replaced with the finalized matrix
> and the payload keys are guaranteed identical to the in-app deep links
> (PROJECTPLAN.md §13.4 V4-P0c: "the route-key contract lands in
> docs/mobile-push.md so FCM payloads (P3) carry identical deep-link keys").
> Any addition made in P0c will be **additive** on top of today's keys.

---

## 5. Server setup & local testing

### 5.1. Env gate: `BT_FCM_SERVICE_ACCOUNT_FILE`

The push channel is env-gated exactly like SMTP (owner decision #421 — the key
may land on live before or after this code deploys, in any order):

- Absolute in-container path to a mounted Firebase service-account JSON.
- **Unset, missing, unreadable, or not a valid service-account key** →
  `createFcmChannel(...)` returns `null` after **one** warn log; the api and
  worker boot unchanged (`apps/api/src/services/notifications/fcm.ts:119–135`,
  env def `apps/api/src/config/env.ts:83–89`).
- With the channel null the dispatcher simply skips the push fan-out
  (`notificationDispatcher.ts:590–596`) and the `GET /settings/notifications`
  surface reports `push: false`.
- Device registration keeps working with the channel off — tokens accumulate in
  `device_tokens` and start receiving pushes on the next boot after the key
  lands.

The service account file must contain `project_id`, `client_email`, and
`private_key`. The channel logs `push channel enabled (FCM HTTP v1)` with the
`projectId` when it comes up (`fcm.ts:136`).

### 5.2. Behavior when unset

- No FCM traffic. No boot-time warning beyond the single `push channel
disabled: BT_FCM_SERVICE_ACCOUNT_FILE is not set` warn line
  (`fcm.ts:125`).
- The device endpoints still succeed (§1).
- Regression coverage: the "channel is null when the env var is unset" case is
  asserted directly in the unit tests (§5.3).

### 5.3. Mock-credential test path

Both P3 done-when tests live in
`apps/api/src/services/notifications/__tests__/fcm.test.ts`:

- **Mock-credential send is recorded correctly:** "sends a data message +
  notification block with android HIGH priority per device"
  (`fcm.test.ts:133–163`). Uses a locally generated RSA keypair, writes a
  synthetic service-account JSON to a temp file, points
  `BT_FCM_SERVICE_ACCOUNT_FILE` at it, injects a `fetch` stub and asserts the
  outgoing body: `token`, merged `data` (with `type`), `notification.{title,body}`
  and `android.priority: "HIGH"`.
- **Unconfigured channel is invisible and nothing crashes:** "is disabled (null)
  with one warn when the env var is unset" (`fcm.test.ts:79–88`), reinforced by
  the missing/invalid-file variant at `:90–107`.

Additional coverage in the same file exercises the prune contract
(§1 — UNREGISTERED under both 404 and 400 shapes), the "never prune on a bare
404" and "never prune on 400 INVALID_ARGUMENT" guards, and the "transient send
failure logs, never throws" behavior.

The push dispatcher's fan-out via the matrix (per-user opt-in, presence
suppression, muted user) is tested end-to-end in
`apps/api/src/services/notifications/__tests__/pushDispatch.test.ts`.

Run the FCM unit suite locally:

```
pnpm --filter @bettertrack/api test -- fcm.test.ts
```

### 5.4. Physical-device gate

Sending to a real Android device with real Firebase credentials is
**owner-verified at the V4 gate** (PROJECTPLAN.md §13.4 V4-P3 done-when: "a real
device receives a push (owner-verified at the gate)") and is not part of the
automated test suite.
