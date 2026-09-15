# Control Center — functional inventory

_Archived 2026-09-02 — the Origin redesign record; the shipped design language now lives in `apps/web/src/styles/origin.css`, and the ground-up v6 redesign is tracked in #544._

What the Control Center can actually do today, control by control, before the R2
restructure. One table per panel: **control** → **what it does** → **what is behind
it** → **verdict**.

Read with `docs/redesign/REAL_APP_REDESIGN_PROMPT.md` (visual language) and
`PROJECTPLAN.md` §6.1 / §6.9 / §6.10 / §6.11 / §6.13 / §13.x (behaviour).

Verdict legend: **keep** = same panel, rebuilt dense · **merge** = folded into another
panel · **move** = different panel than today · **split** = its own panel now ·
**park** = stays a Coming-Soon surface · **retire** = the wrapper goes away, the
capability does not.

---

## 0. The shell itself — `ControlCenterOverlay.tsx`

| Control                | What it does                                                                 | Behind it                                | Verdict                                   |
| ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `/control`             | Opens the popup on the first panel in the map                                | `PANELS[0]`                              | keep                                      |
| `/control/:panel`      | Deep-links one panel; unknown id silently falls back to the first            | `useParams().panel`                      | keep + **panel-id aliases** (see §14)     |
| Panel nav (grouped)    | 4 groups × 9 panels, `replace` links so the whole visit is ONE history entry | `CONTROL_GROUPS`                         | keep mechanism, **new taxonomy**          |
| Filter box             | Substring match on translated panel + link labels; hides empty groups        | local `filter` state, `matches()`        | keep                                      |
| "No panel matches."    | Empty state for a filter that matches nothing                                | `empty` flag                             | keep                                      |
| Link rows (↗)          | Leave the popup for a real page; parked ones carry the gold dot              | `CONTROL_LINKS`                          | keep (Developer, Review, Data management) |
| Close ✕ / scrim / Esc  | `history.state.idx > 0 ? navigate(-1) : navigate('/')`                       | `close()`                                | keep                                      |
| Nested-modal Esc guard | An inner `[role=dialog][aria-modal]` owns Escape first                       | `hasNestedDialog()`                      | keep                                      |
| Focus discipline       | Focus into the dialog on open, restore to opener on close, Tab trap          | `panelRef`, `focusableIn()`, `onKeyDown` | keep                                      |
| Body scroll lock       | `body.style.overflow = 'hidden'` while open                                  | mount effect                             | keep                                      |
| `.bt-cc` compaction    | CSS that shrinks the mounted PAGE components' heads from the outside         | `origin.css` `.bt-cc .bt-page-head` etc. | **retire** — panels are popup-native now  |
| Panel title `h2`       | "Control Center" — the popup's accessible name                               | `t('control.title')`                     | keep (`aria-labelledby`)                  |

**The core problem, precisely.** Every panel is an untouched `/settings/*` PAGE
component: `SectionHead`/`PageHead` title stacks, `bt-panel bt-panel--pad` cards
stacked at `gap-5`/`gap-7`, an explanation paragraph under every heading, and
`max-w-sm`/`max-w-xl` form columns sized for a 1200px canvas. The overlay then
tries to claw the size back with eight `.bt-cc …` override rules. `DeleteAccountPage`
is the extreme case: it is a **standalone gate screen** (`bt-app bt-gate`, wordmark,
gate card) mounted inside the popup, with three more CSS rules to strip its paint.

---

## 1. Account — `AccountSettingsPage.tsx`

| Control              | What it does                                                 | Behind it                                                                             | Verdict                     |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------- |
| Identity strip       | Read-only username · email · member-since                    | `GET /auth/me` → `['auth','me']`                                                      | keep                        |
| Display language     | Switches runtime locale instantly + persists per user        | `PATCH /settings/account {locale}` + `useI18n().setLocale`                            | keep                        |
| Base currency        | Denomination of every valuation/chart/report; refetches ALL  | `PATCH /settings/account {baseCurrency}`, `setMoneyCurrency`, `invalidateQueries()`   | keep                        |
| Change password      | Current + new + confirm; rotates the session server-side     | `POST /auth/change-password`, invalidates `['auth','me']`                             | **move → Sign-in**          |
| "Sharing moved" note | Signpost only; links to `/people/shared`                     | static copy + `Link`                                                                  | **retire** (dead-end prose) |
| Export my data       | Password re-auth → async zip → expiring token-gated download | `POST /account/export`, `GET /account/export` poll, `localStorage['bt.export.token']` | keep                        |
| Danger zone          | Signpost `Link` to `/account/delete`                         | static                                                                                | **merge → Delete account**  |

Error mapping worth preserving: `INVALID_CREDENTIALS` / `WEAK_PASSWORD` (password);
`INVALID_CREDENTIALS` / `TWO_FACTOR_INVALID_CODE` / `EXPORT_RATE_LIMITED`|429 (export).

---

## 2. Security — `SecuritySettingsPage.tsx` (1349 lines, five distinct jobs)

| Control                    | What it does                                                        | Behind it                                              | Verdict        |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ | -------------- |
| Session info line          | Signed-in-at / expires-at; different copy for ephemeral sessions    | `GET /auth/session`                                    | **→ Sessions** |
| Active sessions list       | Device, persistent/ephemeral badge, current marker, timestamps      | `GET /auth/sessions`                                   | **→ Sessions** |
| Log out (one device)       | Revokes one other session                                           | `DELETE /auth/sessions/:id`                            | **→ Sessions** |
| Log out all others         | Two-step confirm, then revokes every other session                  | `POST /auth/sessions/revoke-others`                    | **→ Sessions** |
| PIN enable / change        | 6-digit PIN + confirm (`PinInput`)                                  | `PUT /auth/pin`                                        | **→ Sessions** |
| PIN disable                | Turns the app lock off                                              | `DELETE /auth/pin`                                     | **→ Sessions** |
| PIN idle window            | 1/5/10/15/30/60 min before the PIN is asked again; inactivity only  | `PATCH /auth/pin/idle`                                 | **→ Sessions** |
| 2FA — authenticator        | QR + manual key/URI, confirm a live TOTP code; disable needs a code | `POST /auth/2fa/enroll`, `/confirm`, `/disable`        | **→ Sign-in**  |
| 2FA — email codes          | Enroll (sends a code) → confirm → on; disable is one click          | `POST /auth/2fa/email/{enroll,confirm,disable}`        | **→ Sign-in**  |
| Recovery codes             | Shown ONCE on first method enabled or regenerate; copy + download   | `POST /auth/2fa/recovery-codes`                        | **→ Sign-in**  |
| Passkeys list              | Name, added, last-used/never                                        | `GET /auth/passkeys`                                   | **→ Sign-in**  |
| Add passkey                | Name + password re-auth, then the WebAuthn prompt                   | `registerPasskey()` (WebAuthn + `POST /auth/passkeys`) | **→ Sign-in**  |
| Rename / delete passkey    | Inline rename; delete needs password re-auth + a last-key warning   | `PATCH`/`DELETE /auth/passkeys/:id`                    | **→ Sign-in**  |
| Unsupported-browser notice | Hides the add form when WebAuthn is absent                          | `browserSupportsWebAuthn()`                            | **→ Sign-in**  |

Split rationale: **"how I prove it's me"** (password, 2FA, passkeys) and **"where am I
signed in / when does the app lock"** (session, sessions, PIN) are two questions.

---

## 3. Connections — `ConnectionsPage.tsx`

| Control                     | What it does                                                                 | Behind it                                                 | Verdict                                   |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Google account status       | Linked identity + linked-on date, or "Not linked"                            | `GET /auth/google/link-status` (404 → whole block hidden) | keep                                      |
| Connect Google              | Full-page OAuth start; callback returns to `?google=linked` / `?error=…`     | `googleStartUrl()`                                        | keep                                      |
| Unlink Google               | Password re-auth; refused while Google is the only sign-in (`canUnlink`)     | `POST /auth/google/unlink`                                | keep                                      |
| Callback notice/marker wipe | Consumes `?google=` / `?error=google_*` once so a reload stops re-announcing | `useSearchParams`, `setSearchParams(replace)`             | keep (**test-covered redirect contract**) |
| Drive vault card            | Paranoid-mode media home: connect / sign in / disconnect                     | `getParanoidMediaState`, `DriveConnectionController`      | keep                                      |
| Drive storage disposition   | Drive-only ↔ Drive+server copy                                               | `useDriveOnly()` / `addServerCopy()`                      | keep                                      |
| Retired-server purge        | Purges the retired server copy after its cool-off                            | `purgeRetiredServer()`                                    | keep                                      |
| Vault passphrase unlock     | Unlocks the client vault when an action needs it                             | `unlockWithPassphrase()`                                  | keep                                      |
| Connector slots             | Bank/cash + Parqet as inert "coming soon" rows with sync semantics           | static `CONNECTOR_SLOTS`                                  | keep (dense rows)                         |

Google error codes surfaced: `google_email_mismatch`, `google_already_linked`,
`google_admin`; unlink: 401 wrong password, `GOOGLE_ONLY_SIGN_IN`.

---

## 4. API access — `ApiAccessPage.tsx` (three topics in one page)

| Control                  | What it does                                                          | Behind it                                 | Verdict                     |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------------- | --------------------------- |
| Create API key           | Name + ≥1 scope (write implies read); token shown ONCE in a modal     | `POST /api-keys`, `withImpliedReadScopes` | **split → API keys**        |
| API key list / revoke    | Name, scope chips, created/last-used; two-step revoke                 | `GET`/`DELETE /api-keys/:id`              | **split → API keys**        |
| Register OAuth app       | Name, 1–10 redirect URIs, scopes, public/confidential; secret ONCE    | `POST /oauth/clients`                     | **split → OAuth apps**      |
| OAuth app list / delete  | client_id, type badge, scopes, URIs; delete cascades its grants       | `GET`/`DELETE /oauth/clients/:id`         | **split → OAuth apps**      |
| Authorized apps (grants) | Third-party apps that can reach YOUR account, with scope descriptions | `GET /oauth/grants`                       | **split → Authorized apps** |
| Revoke access            | Two-step confirm, then revokes one grant                              | `DELETE /oauth/grants/:id`                | **split → Authorized apps** |
| `/docs` intro prose      | Three-sentence paragraph about `Authorization: Bearer …`              | static                                    | **retire** (one line kept)  |

Split rationale: minting a key for yourself, publishing an app for others, and
auditing who can read your data are three different questions with three different
audiences (the third is a privacy control, not a developer one).

---

## 5. Webhooks — `WebhooksSection.tsx`

| Control            | What it does                                                           | Behind it                             | Verdict                      |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------- | ---------------------------- |
| Collapse toggle    | Whole section collapsed by default; list only fetches once opened      | local `expanded`, `enabled: expanded` | **retire** (it IS the panel) |
| Create webhook     | URL + optional label + ≥1 of 24 event types; secret shown ONCE         | `POST /webhooks`                      | keep                         |
| Subscription list  | Status badge (active/paused/auto-disabled), URL, events, last delivery | `GET /webhooks`                       | keep                         |
| Pause / enable     | Toggles delivery                                                       | `PATCH /webhooks/:id {enabled}`       | keep                         |
| Delete             | Two-step confirm                                                       | `DELETE /webhooks/:id`                | keep                         |
| Recent deliveries  | Per-subscription, fetched on demand; success/failed + HTTP status      | `GET /webhooks/:id/deliveries`        | keep                         |
| Auto-disabled hint | Explains the consecutive-failure cutoff                                | `disabledReason === 'auto'`           | keep (real constraint)       |

---

## 6. New portfolio defaults — `NewPortfolioDefaultsPage.tsx` + `taxModePicker.tsx`

| Control                 | What it does                                                                      | Behind it                                         | Verdict                        |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------ |
| Tax treatment radios    | 6 options: none · manual per trade · AT · DE · FI · custom                        | `PATCH /settings/taxes`                           | keep                           |
| Manual default field    | Amount-or-% prefilled into every sell/dividend, still editable per trade          | `manualDefaultAmountEur` / `manualDefaultRatePct` | keep                           |
| Custom rule builder     | Rate, cost basis, loss-offset / refund / year-reset / carry-forward + info points | `custom: CustomTaxParams`                         | keep                           |
| Per-year report link    | Only once a mode is active                                                        | `Link to="/portfolio/tax"`                        | keep (**e2e-asserted**)        |
| Liability disclaimer    | Owner-mandated wording (#635)                                                     | `Disclaimer`                                      | keep verbatim                  |
| Inheritance explanation | `effective = portfolio override ?? user default ?? system default`                | subtitle + hint prose                             | keep ONE line (real semantics) |

`taxModePicker.tsx` is shared with `TaxReportPage` and the first-run `TaxStep` —
**stays exactly where it is**, untouched.

---

## 7. Notifications — `NotificationSettingsPage` in `SettingsSection.tsx` (1500 lines, two topics)

**Delivery preferences**

| Control               | What it does                                                             | Behind it                                    | Verdict                             |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------- | ----------------------------------- |
| Mute everything       | Global kill switch; greys the whole matrix                               | `PATCH /settings/notifications {muted}`      | keep                                |
| Web push opt-in       | Per-browser; permission prompt ONLY on the button                        | `enableWebPush`/`disableWebPush` + VAPID key | keep                                |
| Telegram link         | Start → deep-link to the bot → confirm → linked (masked chat id); unlink | `/settings/telegram` + `start`/`confirm`     | keep                                |
| Discord webhook       | Save URL, send a test, remove                                            | `/settings/discord` + `test`                 | keep                                |
| Type × channel matrix | 25 types × up to 6 live channels, category master toggles                | `PATCH …{matrix}`                            | keep                                |
| Locked cells          | invite (no per-user routing), temp-password/export/budget email          | `cellLocked()`                               | keep semantics                      |
| MIRRORCHAIN group row | Eight `mirror.*` types collapse to ONE tri-state row per channel         | `MirrorGroupRow`                             | keep                                |
| Delivery frequency    | Per-type instant/daily/weekly; outbound only, bell stays instant         | `PATCH …{cadence}`                           | keep (**e2e uses the `<summary>`**) |
| Quiet hours           | Enable + start/end + timezone (+ "use my timezone")                      | `PATCH …{quietHours}`                        | keep (**e2e uses the `<summary>`**) |

**The inbox** — same file, no relation to the settings above

| Control                 | What it does                               | Behind it                                     | Verdict                      |
| ----------------------- | ------------------------------------------ | --------------------------------------------- | ---------------------------- |
| Paged list              | Newest first, cursor "load more", 30s poll | `GET /notifications` (infinite query)         | **split → Notification log** |
| Active / Archived / All | View filter                                | `view` param                                  | **split**                    |
| Mark read (row)         | Clicking an unread row marks it            | `POST /notifications/read`                    | **split**                    |
| Mark all read           |                                            | `POST /notifications/read {all:true}`         | **split**                    |
| Archive / unarchive     | Per row                                    | `POST /notifications/:id/{archive,unarchive}` | **split**                    |
| Delete (row)            | Per row                                    | `DELETE /notifications/:id`                   | **split**                    |
| Delete all archived     | Behind an explicit destructive dialog      | `DELETE /notifications?scope=archived`        | **split**                    |
| Delete everything       | Behind an explicit destructive dialog      | `DELETE /notifications?scope=all`             | **split**                    |

---

## 8. Privacy — `PrivacyPanel` in `hub/HubPages.tsx`

| Control                | What it does                                                                                                                   | Behind it                        | Verdict                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------ |
| Discreet mode switch   | LIVE. Blurs money figures across the app; optimistic flip with rollback                                                        | `useAuth().toggleDiscreetMode()` | keep                                       |
| Paranoid mode (parked) | Client-side vault semantics: the server stores ciphertext, the key never leaves the browser, a lost passphrase means lost data | `ParkedPage page="paranoid"`     | keep — **copy meaning preserved verbatim** |

---

## 9. Delete account — `settings/DeleteAccountPage.tsx`

| Control                | What it does                                                         | Behind it                              | Verdict                                                                           |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| Standalone gate screen | `/account/delete` — the STABLE public URL the Play listing points at | own `bt-app bt-gate` canvas            | **keep as a page, drop from the popup**                                           |
| Typed username confirm | Must match the signed-in username                                    | client check + `CONFIRMATION_MISMATCH` | keep on the page                                                                  |
| Password re-auth       | Or a fresh TOTP code when 2FA is enrolled                            | `DELETE /account`                      | keep on the page                                                                  |
| Warning list           | Data · social · access · chat, spelled out                           | static                                 | keep on the page                                                                  |
| Popup entry            | —                                                                    | —                                      | **new**: a compact danger panel that states what is removed and links to the page |

---

## 10. Public profile — `social/ProfileSettingsPage.tsx` (**moving in**, owner order)

| Control                  | What it does                                                                         | Behind it                                | Verdict                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------- |
| Profile icon picker      | Curated grid of `PROFILE_ICON_IDS`, collapsed until opened; clearable                | `PATCH /social/profile {profileIcon}`    | **move → Profile panel**                                       |
| Make my profile public   | Publishes `/u/<username>`; off unpublishes instantly (slug 404s)                     | `PATCH /social/profile {isPublic}`       | **move**                                                       |
| §16 acknowledgement gate | Enabling from off REQUIRES the warning + ticked acknowledgment; mirrored server-side | `acknowledgePublic`, `canSave` gate      | **move, gate intact** — this is a privacy boundary, not chrome |
| Bio                      | Free text, `PROFILE_BIO_MAX`, live counter                                           | `PATCH /social/profile {bio}`            | **move**                                                       |
| Public item count        | How many `public_link` items the page would compose                                  | `data.publicItemCount`                   | **move**                                                       |
| Live URL + copy + view   | Only while public on the server                                                      | `window.location.origin + /u/<username>` | **move**                                                       |
| Save (single primary)    | Sends only what changed (`draft*` sentinels)                                         | one mutation                             | **move**                                                       |

No display-name control exists (username is the identity; the bio is the only free
text). `/people/profile`, the account menu's "My profile", the People rail tab and
the ⌘K command all point at the old path → **all keep working via a redirect**.
`/u/:username` (the public VIEW) and the first-run `PublicProfileStep` are untouched.

---

## 11. Parked surfaces that belong to this area

| Surface                  | Path                        | What it will be                             | Verdict                                           |
| ------------------------ | --------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Data management          | `/control/data`             | Imports, exports, backups, retention        | park, ↗ link row                                  |
| Paranoid mode            | inside the Privacy panel    | Client-side encrypted vault                 | park, in-panel                                    |
| MCP                      | `/developer/mcp`            | Model-Context-Protocol server               | park, via ↗ Developer                             |
| Request logs             | `/developer/logs`           | Per-request API log                         | park, via ↗ Developer                             |
| OAuth apps (parked twin) | `/developer/oauth-apps`     | The developer-side view of the same clients | park — the live panel stays in the Control Center |
| Review inbox             | `/review`                   | The approvals/attention queue               | park, ↗ link row                                  |
| Teams · Approvals        | `/people/{teams,approvals}` | Shared workspaces + approval chains         | park (People's)                                   |

`/developer` stays **its own page** and keeps being linked out (↗). The owner wants a
real standalone Developer platform later; nothing about it is absorbed here.

---

## 12. Future features the structure must have room for

From `PROJECTPLAN.md` and `docs/redesign/PRODUCT_BLUEPRINT.md`:

- **Imports / exports / backups / retention** → the Data management page (↗ row); the
  account-level "export my data" stays in Account because it is re-auth-gated.
- **MCP server + request logs + published OAuth apps** → the Developer platform page.
  If OAuth-app registration ever moves there, the Control Center panel becomes a ↗ row —
  the taxonomy already has that shape.
- **Paranoid vault** (passphrase, media home, key rotation, recovery) → grows inside the
  Privacy panel next to Discreet mode; the Drive plumbing already lives in Connections.
- **Teams / approvals** → People's, not the Control Center's; the Review ↗ row is the
  entry point.
- **More new-portfolio defaults** (base currency, DRIP, benchmark) → sibling rows in the
  Defaults panel, which is why it is named for the job and not for "tax".
- **More connectors** (bank/cash, Parqet, brokers) → more rows in Connections' slot list.
- **More notification channels** → more matrix columns; the grid is already
  deployment-gated by `settings.channels`.
- **Billing / plan**, if it ever ships → a new panel in the Account group.

---

## 13. What the rebuild does about it

Structure (see §14) plus a popup-native content grammar:

- ONE compact panel header — the panel's name, nothing else. No page title stack, no
  subtitle restating the name, no `SectionHead`/`PageHead` inside a panel.
- Settings are **rows**: label · optional one-line hint · control right-aligned,
  separated by 1px rules. Related rows sit under a small `bt-label` section header
  instead of one card each. No `bt-panel` cards, no nesting.
- Forms inline, controls ≤ ~420px, `bt-btn--sm`, exactly one primary per panel.
- Prose survives only where it states a real constraint: inheritance semantics, a
  show-once secret, what a token can do, what a lost vault key costs, why a matrix cell
  is locked. Everything that merely narrates a control is deleted.
- Lists (sessions, keys, apps, webhooks, connectors, notifications) are dense rows with
  inline actions that scroll inside the right pane.
- The eight `.bt-cc …` page-compaction overrides go away with the pages they patched.

Unchanged on purpose: every endpoint, query key, validation rule, error-code mapping,
two-step confirm, show-once modal, and aria/label string that tests or users depend on.

---

## 14. The new taxonomy

| Group                 | Panel                  | id                 | Holds                                                                     |
| --------------------- | ---------------------- | ------------------ | ------------------------------------------------------------------------- |
| **Account**           | Account                | `account`          | Identity · language · base currency · export my data                      |
|                       | Public profile         | `profile`          | Icon picker · publish + §16 ack gate · bio · public item count · live URL |
| **Security**          | Sign-in                | `sign-in`          | Password · 2FA (authenticator, email, recovery codes) · passkeys          |
|                       | Sessions               | `sessions`         | This session · active sessions + revoke · PIN app lock + idle window      |
| **Preferences**       | New portfolio defaults | `defaults`         | Tax treatment · manual default · custom rules · report link · disclaimer  |
|                       | Notifications          | `notifications`    | Mute · web push · Telegram · Discord · matrix · frequency · quiet hours   |
|                       | Notification log       | `notification-log` | The paged inbox: views, mark-read, archive, delete, bulk deletes          |
|                       | Privacy                | `privacy`          | Discreet mode (live) · paranoid vault (parked)                            |
| **Connections & API** | Connections            | `connections`      | Google identity · Drive vault · connector slots                           |
|                       | API keys               | `api`              | Mint scoped keys (show-once) · list · revoke                              |
|                       | OAuth apps             | `oauth-apps`       | Register your own clients (show-once secret) · list · delete              |
|                       | Authorized apps        | `authorized-apps`  | Third-party grants on your account · revoke                               |
| **Danger zone**       | Delete account         | `delete-account`   | What deletion removes · link to the `/account/delete` gate                |

↗ link rows (leave the popup, unchanged): **Developer overview** `/developer` ·
**Review** `/review` (parked) · **Data management** `/control/data` (parked).

Five groups, not four: the danger panel gets its own so it is never listed beside
routine settings.

**Panel-id aliases** so old deep links never silently land on the wrong panel (an
unknown id falls back to Account, which would quietly lie about where you are):
`security → sign-in`, `portfolio-defaults → defaults`, `taxes → defaults`,
`api-keys → api`. Every other id is unchanged.

**Routing contracts preserved:** `/control` and `/control/:panel?` remain ONE route
node (two nodes remount the overlay and replay its animation). Panel links keep
`replace`, so the whole visit is one history entry and closing always leaves in one
step. Every `/settings/*` redirect keeps working **with its query string**, including
`/settings/connections?google=…` for the Google OAuth callback. New:
`/settings/profile` and `/people/profile` → `/control/profile`.
