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
`apps/api/src/http/middleware/bearerAuth.ts` by `enforceApiKeyScope` via
`scopeSatisfies`). Policy map for `/notifications`: `MODULE_POLICIES` in
`bearerAuth.ts`. Plain-language consent labels the OAuth
authorize screen shows: `packages/contracts/src/oauth.ts:50–51`.

Cookie sessions bypass the scope map (full access) so the web app is
unaffected.

Common failure modes for a bearer request:

- `401 API_KEY_INVALID` — the header was malformed or the token is unknown/
  revoked (`bearerAuth.ts`, `loadBearerAuth`'s `API_KEY_INVALID` branch).
- `403 INSUFFICIENT_SCOPE` — the token authenticates but lacks
  `notifications:write` (or `:read` on GETs) (`bearerAuth.ts`,
  `enforceApiKeyScope`'s `INSUFFICIENT_SCOPE` denial; the denial is audited on
  the personal-key or OAuth-grant record).

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
- **`data.type` is always present** and equals the push message's type. For
  normal events that is a canonical notification type (§3.1); the one
  synthetic digest summary is documented in §3.3. The channel writes it on top
  of every payload (`fcm.ts:202`, `data: { ...message.data, type: message.type }`),
  so a foregrounded client can route the tap deterministically off `data.type`
  alone.
- `android.priority: "HIGH"` on every message — the mobile client's contract
  (`fcm.ts:204`).

The `PushMessage` the dispatcher hands to the channel is the same struct
consumed by web-push, so the payload semantics are identical across both push
channels (`apps/api/src/services/notifications/notificationDispatcher.ts:584–589`).

### 3.1. Canonical notification types and FCM `data` keys

`packages/contracts/src/notifications.ts` defines the 26-member
`NOTIFICATION_TYPES` taxonomy. The dispatcher’s `render(...)` function is the
sole author of the per-type keys; `fcm.ts` then adds `type` to every sent
payload. The table is therefore the complete **pre-merge** data contract
(`apps/api/src/services/notifications/notificationDispatcher.ts:439–723`).

| `type`                         | Trigger                                                  | FCM `data` keys before `type` is merged                    |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| `friend.request`               | Someone sent the user a friend request                   | `requestId`                                                |
| `friend.accepted`              | A friend request the user sent was accepted              | `requestId`                                                |
| `portfolio.shared`             | A friend shared a portfolio with the user                | `portfolioId`                                              |
| `watchlist.shared`             | A friend shared a watchlist with the user                | `watchlistId`                                              |
| `conglomerate.shared`          | A friend shared a conglomerate with the user             | `conglomerateId`                                           |
| `friend.activity`              | A friend's activity (buy/sell/watchlist add)             | `itemKind`, `itemId`, `username` (the actor's public slug) |
| `follow.published`             | A followed user newly published an item                  | `itemKind`, `itemId`, `username` (the actor's public slug) |
| `follow.alert.created`         | A followed user created a price alert                    | `alertId`, `assetId`                                       |
| `follow.alert.fired`           | A followed user's alert fired                            | `alertId`, `assetId`                                       |
| `account.invite`               | Account invitation                                       | _(not dispatcher/FCM-dispatched; email-only)_              |
| `account.temp_password`        | An admin reset the user's password                       | _(none)_                                                   |
| `account.data_export`          | A requested account-data export is ready                 | _(none)_                                                   |
| `alert.triggered`              | The user's own price alert fired                         | `alertId`, `assetId`                                       |
| `earnings.reminder`            | A held asset's earnings date is approaching              | `assetId`                                                  |
| `chat.message`                 | New chat message                                         | `conversationId`, `messageId`                              |
| `dividend.event`               | A held asset's upcoming ex-date                          | `assetId`                                                  |
| `budget.exceeded`              | A category budget exceeded its monthly target            | `categoryId`, `period`                                     |
| `mirror.invite`                | Invitation to a MIRRORCHAIN group portfolio              | `chainId`, `inviteId`                                      |
| `mirror.member_joined`         | A member joined a MIRRORCHAIN group portfolio            | `chainId`                                                  |
| `mirror.member_left`           | A member left a MIRRORCHAIN group portfolio              | `chainId`                                                  |
| `mirror.member_removed`        | A member was removed from a MIRRORCHAIN group portfolio  | `chainId`                                                  |
| `mirror.removed`               | The recipient was removed from a MIRRORCHAIN             | `chainId`                                                  |
| `mirror.ownership_transferred` | MIRRORCHAIN ownership changed                            | `chainId`                                                  |
| `mirror.chain_dissolved`       | A MIRRORCHAIN group portfolio was dissolved              | `chainId`                                                  |
| `mirror.sync_stalled`          | A MIRRORCHAIN copy needs a manual retry                  | `chainId`                                                  |
| `standing_order.skipped`       | Standing-order periods were deferred, dropped, or failed | `standingOrderId`, `periodKey`, `outcome`, `droppedCount`  |

### 3.2. `data` encoding

After the FCM merge every dispatched payload also carries `data.type`. The
`username` key above intentionally mirrors the in-app payload's
`actorUsername`, because FCM data uses the public-profile slug. All values are
strings, including `period` and the ids. `standing_order.skipped.droppedCount`
is present only for `outcome: "dropped"`; it is the number of old occurrences
represented by that one aggregate notice.

### 3.3. Synthetic `notifications.digest` push

`notifications.digest` is a dispatcher-level summary push, built by
`digestService.ts` after the dispatcher has queued the canonical events selected
for a user's daily or weekly cadence. It is deliberately **not** in
`NOTIFICATION_TYPES`: it is not an independently routed notification or a
settings-matrix row, but the delivery envelope for a grouped set of those rows.

`digestService.ts` creates `{ type: 'notifications.digest', data: { cadence } }`;
the FCM channel adds the type in the normal way. `cadence` is always `daily` or
`weekly`; a daily payload, for example, is:

```json
{ "cadence": "daily", "type": "notifications.digest" }
```

No individual notification ids are included. A tap must therefore open the
notification inbox rather than attempt to resolve an individual item.

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

## 4. Deep-link keys — finalized route-key contract (V4-P0c)

Deep-link routing uses `data.type` as the discriminator plus the type's `data`
ids from §3.1. Each id below rides both the in-app row payload and the FCM
`data` map. The in-app payload calls the public-profile slug `actorUsername`;
FCM calls the same value `username`.

This is the mobile route-key contract. An **inbox fallback** means open (or
leave the user in) the notification inbox rather than manufacture a route from
insufficient keys. In particular, `chainId` identifies a MIRRORCHAIN but is not
a portfolio id.

| `type`                         | Target / route                                                          | Route key(s)                                              | Fallback when a key cannot resolve                      |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `alert.triggered`              | Asset detail: `/assets/{assetId}`                                       | `assetId`                                                 | `/workbench/alerts`                                     |
| `follow.alert.created`         | Asset detail: `/assets/{assetId}`                                       | `assetId`                                                 | `/workbench/alerts`                                     |
| `follow.alert.fired`           | Asset detail: `/assets/{assetId}`                                       | `assetId`                                                 | `/workbench/alerts`                                     |
| `friend.request`               | Friend requests: `/people#requests`                                     | _(none)_                                                  | `/people`                                               |
| `friend.accepted`              | Friends: `/people`                                                      | _(none)_                                                  | `/people`                                               |
| `portfolio.shared`             | Shared portfolio: `/people/shared/{portfolioId}`                        | `portfolioId`                                             | `/people`                                               |
| `watchlist.shared`             | Shared watchlist: `/people/shared/watchlists/{watchlistId}`             | `watchlistId`                                             | `/people`                                               |
| `conglomerate.shared`          | Shared conglomerate: `/people/shared/conglomerates/{id}`                | `conglomerateId`                                          | `/people`                                               |
| `friend.activity`              | Actor profile: `/u/{username}`                                          | `username` (`itemKind`, `itemId`)                         | `/people`                                               |
| `follow.published`             | Actor profile: `/u/{username}`                                          | `username` (`itemKind`, `itemId`)                         | `/people`                                               |
| `chat.message`                 | DM thread: `/people/chat/c/{conversationId}`                            | `conversationId`, `messageId`                             | `/people/chat`                                          |
| `account.invite`               | Account settings: `/settings/account` (email-only)                      | _(none)_                                                  | `/settings/account`                                     |
| `account.temp_password`        | Security settings: `/settings/security`                                 | _(none)_                                                  | `/settings/security`                                    |
| `account.data_export`          | Account export block: `/settings/account`                               | _(none)_                                                  | `/settings/account`                                     |
| `earnings.reminder`            | Asset detail: `/assets/{assetId}`                                       | `assetId`                                                 | Notification inbox                                      |
| `dividend.event`               | Asset detail: `/assets/{assetId}`                                       | `assetId`                                                 | Notification inbox                                      |
| `budget.exceeded`              | Notification inbox; never construct an expense URL                      | `categoryId`, `period`                                    | Notification inbox                                      |
| `mirror.invite`                | Social MIRRORCHAIN invitation                                           | `chainId`, `inviteId`                                     | Notification inbox                                      |
| `mirror.member_joined`         | Notification inbox / Social group context from `chainId`                | `chainId`                                                 | Notification inbox                                      |
| `mirror.member_left`           | Notification inbox / Social group context from `chainId`                | `chainId`                                                 | Notification inbox                                      |
| `mirror.member_removed`        | Notification inbox / Social group context from `chainId`                | `chainId`                                                 | Notification inbox                                      |
| `mirror.removed`               | Notification inbox                                                      | `chainId`                                                 | Notification inbox                                      |
| `mirror.ownership_transferred` | Notification inbox / Social group context from `chainId`                | `chainId`                                                 | Notification inbox                                      |
| `mirror.chain_dissolved`       | Notification inbox                                                      | `chainId`                                                 | Notification inbox                                      |
| `mirror.sync_stalled`          | Notification inbox / Social group context from `chainId`                | `chainId`                                                 | Notification inbox                                      |
| `standing_order.skipped`       | Standing order: `/workbench/forecasts#standing-order-{standingOrderId}` | `standingOrderId`, `periodKey`, `outcome`, `droppedCount` | `/workbench/forecasts#forecast-standing-orders-heading` |
| `notifications.digest`         | Notification inbox; it has no individual-item route                     | `cadence`                                                 | Notification inbox                                      |

Mobile clients SHOULD preserve the listed no-dead-tap fallbacks. The inbox-first
rows deliberately do not invent a URL from the dispatcher keys.

`account.invite` is the only `NOTIFICATION_TYPES` member that is never pushed;
its row gives a bearer client that synthesizes one a safe target. The one-off
`account.notice` in-app announcement (V4-P0c lean email defaults) is web/in-app
only, never pushed, and deep-links to `/settings/notifications`.

Any future addition stays **additive** on top of these keys.

### 4.1 In-app row copy is localizable (#1138)

Beside the routing ids, every dispatcher-written **in-app row payload** carries

```jsonc
"message": { "key": "friendRequest", "params": { "actor": "anna" } }
```

— a stable key from `NOTIFICATION_MESSAGE_KEYS` (`@bettertrack/contracts`) plus
the `{{token}}` values its copy interpolates. This is additive and purely about
rendering; it changes no route key and it is **not** part of the FCM `data` map,
whose wire shape (§3) is unchanged.

A client that knows the key SHOULD render the inbox row from its own catalog in
the **device** locale, so switching language re-renders existing rows instead of
leaving them frozen in the language they were dispatched in. A client that does
not know the key (or reads a historical row, which has no descriptor) MUST fall
back **per field** to the persisted `title` / `body`, which the API renders in
the recipient's account locale at dispatch time. Never render a raw key or
catalog path. Delivered push text stays frozen at its dispatch-time locale — a
notification already handed to APNs/FCM cannot be re-rendered.

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
