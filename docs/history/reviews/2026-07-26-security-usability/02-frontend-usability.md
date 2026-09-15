# Frontend security and usability review

_Archived 2026-09-02 — part of the 2026-07-26 review round; its findings were triaged into issues and are recorded in `PROJECTPLAN.md` §16._

**Date:** 2026-07-26
**Scope:** `apps/web`, `apps/landing`, and frontend-facing contracts used by those applications
**Review type:** Static security, privacy, usability, accessibility, responsive-layout, resilience, localization, and test-coverage review

## Executive summary

No critical client-side authorization bypass or direct HTML/JavaScript injection sink was found in the reviewed web application or landing site. React rendering is consistently used for user-, admin-, and server-supplied content, authentication state is separated between the user and admin applications, and destructive user-facing sharing/account-deletion workflows contain useful friction.

The highest-priority frontend risk is that capability-bearing URLs are present throughout the application while Sentry has no URL or query sanitization. The most consequential confirmed usability issues are incomplete overlay focus management, outages being presented as invalid sessions or links, the OAuth cancellation flow not returning a protocol response, contradictory landing-page registration messaging, and inaccessible or undiscoverable mobile navigation/data surfaces.

The review found:

- 1 high-severity conditional security risk;
- 15 medium-severity security, privacy, accessibility, resilience, localization, or usability findings;
- 2 low-severity hardening findings;
- several intentionally unfinished roadmap surfaces, documented separately so they are not mistaken for regressions.

## Findings

### FRONTEND-01 — Capability-bearing URLs are not scrubbed from Sentry

**Severity:** High, conditional on Sentry being enabled
**Category:** Security / privacy

Sentry is initialized without a `beforeSend` hook or any other URL/query sanitization:

- [`apps/web/src/lib/sentry.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/sentry.ts#L12-L20)

At the same time, several routes carry bearer-like capabilities in the current browser URL:

- Password-reset, invite, and public-share tokens are route segments in [`apps/web/src/user/UserApp.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/UserApp.tsx#L103-L116).
- Registration access tokens are read from `?token=` in [`apps/web/src/user/auth/RegisterPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/RegisterPage.tsx#L100-L112).
- OAuth `redirect_uri`, `state`, and PKCE parameters remain in the authorize query in [`apps/web/src/user/oauth/ConsentPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L47-L67).

Standard browser error telemetry commonly attaches the current URL. Consequently, an exception on one of these screens can expose a reset, invite, registration, or share capability to the monitoring system and everyone with access to it. OAuth `state` is also sensitive request context.

**Recommendation**

- Add a central Sentry `beforeSend` sanitizer that removes the full query string and redacts token segments after `/reset/`, `/invite/`, and `/s/`.
- Avoid placing new secrets in query strings or paths where an exchange flow is possible.
- For one-time reset/invite/registration capabilities, exchange the token and replace the visible URL as early as the protocol permits.
- Add tests that pass representative token-bearing URLs through the sanitizer.

### FRONTEND-02 — Data-export download tokens are durably stored and placed in query strings

**Severity:** Medium
**Category:** Security / privacy

The raw export token is intentionally persisted in `localStorage`:

- Storage design and helpers: [`apps/web/src/user/settings/AccountSettingsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/AccountSettingsPage.tsx#L33-L59)
- Token written after export creation: [`apps/web/src/user/settings/AccountSettingsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/AccountSettingsPage.tsx#L332-L341)
- Token used in a visible download link: [`apps/web/src/user/settings/AccountSettingsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/AccountSettingsPage.tsx#L345-L379)
- Token added to the download query string: [`apps/web/src/lib/userApi.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/userApi.ts#L420-L427)

Although the server also requires the owner’s session, this design increases exposure to same-origin XSS, browser history, proxy/access logs, screenshots, extensions, crash telemetry, and later sessions on a shared browser. A removal helper exists, but no production call clears the token after download, expiration, or logout.

**Recommendation**

- Prefer an authenticated POST or a short server-side exchange that sets an HttpOnly, one-use download cookie.
- If JavaScript must retain the token, use `sessionStorage` rather than `localStorage`.
- Clear the token on download initiation/completion, expiration, account switch, and logout.
- Do not carry the token in a query string; use a request header or body.

### FRONTEND-03 — Every successful login permanently stores the account identifier without consent

**Severity:** Medium
**Category:** Privacy / shared-device usability

The login form always prefills the last successful email or username:

- Always-on identifier memory: [`apps/web/src/user/auth/LoginPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/LoginPage.tsx#L88-L100)
- Identifier saved after successful password verification: [`apps/web/src/user/auth/LoginPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/LoginPage.tsx#L165-L180)
- Durable `localStorage` implementation and currently unused clearing function: [`apps/web/src/user/auth/rememberedAccount.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/rememberedAccount.ts#L127-L149)
- Logout clears auth/query state but not this identifier: [`apps/web/src/user/AuthContext.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/AuthContext.tsx#L625-L642)

On a shared computer, the next visitor can learn the prior user’s email address or username. There is no opt-out or visible “forget this account” control for this always-on record.

**Recommendation**

- Make identifier persistence an explicit choice.
- Provide a visible “forget saved identifier” action.
- Consider clearing it on explicit logout while retaining it only for users who opted in.
- Document the distinction between identifier memory and the separate signed remembered-device flow.

### FRONTEND-04 — Third-party OAuth logos can act as pre-consent tracking pixels

**Severity:** Medium
**Category:** Privacy / OAuth

A third-party app’s registered logo URL is loaded directly on the consent page before the user approves access:

- Direct remote `<img>` load: [`apps/web/src/user/oauth/ConsentPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L84-L124)
- Contract permits any syntactically valid HTTPS URL: [`packages/contracts/src/oauth.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/oauth.ts#L103-L125)

An app developer can assign a unique image URL and observe the visitor’s IP address, user agent, and consent-page timing before authorization. The image has no explicit `referrerPolicy`.

**Recommendation**

- Fetch, validate, resize, and cache logos through a BetterTrack-controlled image proxy.
- Enforce image content type, dimensions, byte limits, and refresh policy.
- If direct loading remains, set `referrerPolicy="no-referrer"` and a restrictive image CSP.
- Preserve the current HTTPS-only contract validation.

### FRONTEND-05 — Landing-page registration messaging contradicts the live registration mode

**Severity:** Medium
**Category:** Usability / trust / content integrity

The English landing page statically advertises “Invite-only” in its description, hero, and footer:

- Metadata: [`apps/landing/site/index.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L6-L10)
- Hero eyebrow and invite note: [`apps/landing/site/index.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L33-L60)
- Footer: [`apps/landing/site/index.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L155-L162)

The runtime script hides only the invite note and reveals one generic “Create an account” CTA for every mode other than `closed`:

- [`apps/landing/site/index.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L177-L200)

The German page duplicates the same behavior:

- Static copy: [`apps/landing/site/de.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/de.html#L31-L58)
- Runtime mode handling: [`apps/landing/site/de.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/de.html#L176-L199)

This creates multiple contradictions:

- `open` mode still displays invite-only metadata, hero, and footer language.
- `approval` mode looks like immediate account creation even though the application waits for approval.
- `invite_token` mode displays a generic registration CTA even though a token is required.
- A network error silently leaves the site claiming the instance is closed.

**Recommendation**

- Render distinct copy and CTA labels for `closed`, `invite_token`, `approval`, and `open`.
- Make all visible registration claims mode-dependent, not only the invite note.
- Use neutral metadata that remains accurate across runtime modes, or generate deployment-specific metadata.
- Show a restrained “registration status unavailable” state when discovery fails.

### FRONTEND-06 — OAuth cancellation does not complete the OAuth protocol

**Severity:** Medium
**Category:** Usability / interoperability / OAuth

The third-party consent screen’s Cancel button only sets local component state:

- Cancel handler: [`apps/web/src/user/oauth/ConsentPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L313-L333)
- Local cancellation page: [`apps/web/src/user/oauth/ConsentPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L189-L203)

The requesting OAuth client never receives `error=access_denied` and the original `state`. It can remain stuck waiting for a callback, while BetterTrack continues to display the authorization query in its URL.

The current caution against navigating to the raw `redirect_uri` is correct. The missing piece is a server-validated denial response.

**Recommendation**

- Add a denial endpoint that validates the client and redirect URI exactly as approval does.
- Return a server-generated redirect carrying `error=access_denied`, optional description, and the original `state`.
- Navigate only to that validated server response.
- Test success, denial, malformed redirect, and state preservation end to end.

### FRONTEND-07 — Network and server failures masquerade as invalid sessions, tokens, or resources

**Severity:** Medium
**Category:** Resilience / usability

Several high-value workflows collapse every non-abort error into a terminal business state:

- User-session bootstrap treats all failures other than password-change-required as anonymous: [`apps/web/src/user/AuthContext.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/AuthContext.tsx#L345-L373).
- Admin-session bootstrap does the same: [`apps/web/src/admin/AuthContext.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/AuthContext.tsx#L142-L176).
- Invite validation maps all errors to “invalid invite”: [`apps/web/src/user/auth/InvitePage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/InvitePage.tsx#L52-L66).
- Public-share failures become “not available”: [`apps/web/src/user/social/PublicSharePage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/social/PublicSharePage.tsx#L35-L52).
- Public-profile failures become “not available”: [`apps/web/src/user/social/PublicProfileViewPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/social/PublicProfileViewPage.tsx#L191-L208).
- Google registration-ticket failures become “expired”: [`apps/web/src/user/auth/RegisterPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/RegisterPage.tsx#L140-L158).
- Login-page registration discovery silently hides signup on failure: [`apps/web/src/user/auth/LoginPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/LoginPage.tsx#L112-L130).

A temporary outage can therefore appear to log a user out, revoke a valid invite/share, or expire a valid registration flow.

**Recommendation**

- Classify `ApiError` by status/code: reserve anonymous/not-found/expired states for confirmed 401/404/domain responses.
- Show explicit offline or server-unavailable states for status `0` and 5xx.
- Preserve retryable flows and provide a visible Retry action.
- Avoid prompting an already-authenticated user to re-enter credentials until session invalidity is confirmed.

### FRONTEND-08 — Modal and menu primitives do not manage focus correctly

**Severity:** Medium
**Category:** Accessibility / keyboard usability

The shared user dialog and admin modal support Escape and body scroll locking, but do not move focus into the dialog, trap focus, make the background inert, or restore focus:

- User dialog: [`apps/web/src/user/components/Dialog.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/Dialog.tsx#L35-L111)
- Admin modal: [`apps/web/src/admin/components/Modal.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/Modal.tsx#L17-L45)
- Command palette: [`apps/web/src/user/components/CmdKPalette.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/CmdKPalette.tsx#L21-L64)

Custom widgets also declare ARIA menu semantics without implementing the corresponding keyboard interaction:

- Profile menu: [`apps/web/src/user/components/ProfileMenu.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/ProfileMenu.tsx#L20-L58)
- Portfolio switcher: [`apps/web/src/user/portfolio/PortfolioSwitcher.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/portfolio/PortfolioSwitcher.tsx#L93-L107), [`apps/web/src/user/portfolio/PortfolioSwitcher.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/portfolio/PortfolioSwitcher.tsx#L259-L289)
- Asset search pickers: [`apps/web/src/user/components/AssetSearchBox.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AssetSearchBox.tsx#L458-L478), [`apps/web/src/user/components/AssetSearchBox.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AssetSearchBox.tsx#L538-L572)
- Notification popover: [`apps/web/src/user/components/NotificationBell.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/NotificationBell.tsx#L212-L269)

Keyboard users can tab into page content behind modal overlays, lose focus when a focused menu item unmounts, and cannot use expected Arrow/Home/End navigation.

**Recommendation**

- Adopt native `<dialog>` or a well-tested accessible overlay primitive.
- Implement initial focus, focus containment, background inertness, Escape handling, and trigger focus restoration.
- For menus, either implement the complete ARIA menu pattern or use ordinary disclosure/list semantics with normal tab order.

### FRONTEND-09 — Authentication pages lack landmarks/headings, and form help/errors are not associated with fields

**Severity:** Medium
**Category:** Accessibility

The shared authentication card renders the screen title as a paragraph and has no `main` landmark:

- [`apps/web/src/user/components/ui.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/ui.tsx#L134-L151)

This affects login, registration, invite acceptance, forgot/reset password, and forced-password-change screens. Admin login likewise lacks an `h1` and `main`:

- [`apps/web/src/admin/pages/LoginPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/LoginPage.tsx#L80-L110)

Authenticated shells provide a `main` landmark but no skip link before repeated navigation:

- User shell: [`apps/web/src/user/components/AppLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AppLayout.tsx#L59-L114)
- Admin shell: [`apps/web/src/admin/components/AdminLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/AdminLayout.tsx#L135-L197), [`apps/web/src/admin/components/AdminLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/AdminLayout.tsx#L254-L260)

Shared text fields display hints without an ID or `aria-describedby` and provide no field-level error/`aria-invalid` API:

- User field: [`apps/web/src/user/components/ui.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/ui.tsx#L40-L65)
- Admin field: [`apps/web/src/admin/components/ui.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/ui.tsx#L39-L63)

Errors are commonly rendered as a form-level alert, so screen-reader users are not told which field is invalid or which help text belongs to it.

**Recommendation**

- Give every standalone screen a `main` landmark and descriptive `h1`.
- Add visible-on-focus skip links to user and admin shells.
- Generate stable hint/error IDs in `TextField`, wire `aria-describedby`, and set `aria-invalid`.
- On submission failure, focus the first invalid field or an error summary linked to affected fields.

### FRONTEND-10 — The admin user table is mouse-only and not safely responsive

**Severity:** Medium
**Category:** Accessibility / mobile usability

User details are opened by clicking a `<tr>`:

- [`apps/web/src/admin/pages/UsersPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/UsersPage.tsx#L166-L192)

The row is not focusable, has no key handler, and contains no link, so keyboard and assistive-technology users cannot discover or activate the primary action.

The table wrapper uses `overflow-hidden`, and the table has neither horizontal scrolling nor a minimum width:

- [`apps/web/src/admin/pages/UsersPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/UsersPage.tsx#L149-L195)

Columns can squeeze or clip on phone-width admin screens.

**Recommendation**

- Place a real link in the primary user cell and retain independent checkbox behavior.
- Use `overflow-x-auto` with a meaningful minimum table width, or switch to a mobile card/list layout.
- Keep row-hover styling as enhancement, not the only action affordance.

### FRONTEND-11 — Chat lacks accessible realtime semantics and disrupts readers of older history

**Severity:** Medium
**Category:** Accessibility / mobile usability

The message composer textarea has no label or `aria-label`; its placeholder is the only name:

- [`apps/web/src/user/social/ChatPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/social/ChatPage.tsx#L577-L614)

The Enter handler also does not check IME composition, so an Enter used to confirm CJK or other composed text can prematurely send the message.

Messages are rendered as plain mapped components rather than a semantic list or a live chat log:

- [`apps/web/src/user/social/ChatPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/social/ChatPage.tsx#L752-L790)

Every newest-message change forcibly scrolls the thread to the bottom:

- [`apps/web/src/user/social/ChatPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/social/ChatPage.tsx#L671-L690)

This prevents screen readers from receiving a useful polite announcement and pulls sighted users away from older messages they are reading. The unconditional composer focus can also summon the mobile keyboard as soon as a thread opens.

**Recommendation**

- Add a proper accessible name to the composer.
- Use a semantic list or `role="log"` with carefully scoped `aria-live="polite"`.
- Do not resend Enter while `nativeEvent.isComposing`.
- Autoscroll only when the user is already near the bottom or has just sent their own message.
- Otherwise show a “new messages” affordance.

### FRONTEND-12 — Mobile navigation and dense financial tables conceal important controls

**Severity:** Medium
**Category:** Responsive/mobile usability

The global search button is hidden below the `sm` breakpoint:

- [`apps/web/src/user/components/AppLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AppLayout.tsx#L87-L105)

On a touch-only phone, the Cmd-K feature consequently has no direct trigger.

Primary and section navigation deliberately hide horizontal scrollbars:

- Primary navigation: [`apps/web/src/user/components/AppLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AppLayout.tsx#L61-L85)
- Section navigation: [`apps/web/src/user/components/SubNav.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/SubNav.tsx#L51-L81)
- Hidden-scrollbar CSS: [`apps/web/src/index.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/index.css#L3-L15)

Settings contains eight tabs:

- [`apps/web/src/user/settings/SettingsSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/SettingsSection.tsx#L67-L87)

A direct deep link to a late tab can load with the selected tab completely offscreen and no visible scroll cue. There is no selected-tab `scrollIntoView` behavior or edge fade.

Several dense nested financial tables also lack their own responsive wrapper/minimum width:

- Six-column tax drill-down: [`apps/web/src/user/portfolio/TaxReportPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/portfolio/TaxReportPage.tsx#L63-L110)
- Transaction detail table: [`apps/web/src/user/portfolio/PortfolioPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/portfolio/PortfolioPage.tsx#L738-L760)

**Recommendation**

- Keep a compact search icon available on mobile.
- Auto-scroll the selected navigation item into view and provide a visible overflow cue.
- Consider a compact mobile navigation pattern for long sections.
- Wrap every dense table in an explicit horizontal scroller with an appropriate minimum width, or provide a stacked mobile representation.

### FRONTEND-13 — The landing header is likely to overflow at common phone widths

**Severity:** Medium
**Category:** Responsive/mobile usability

The header contains a wordmark, two-option language selector, and full “Open the web app” CTA in one row:

- English markup: [`apps/landing/site/index.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L16-L30)
- German markup: [`apps/landing/site/de.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/de.html#L16-L28)

CSS forces a fixed 64px single-row layout, and the header actions do not wrap:

- [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L73-L95)

The only responsive rule changes feature-grid and hero spacing; it does not adapt the header:

- [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L319-L327)

At 320–375px, the combined natural width of the wordmark, language control, gaps, padding, and full CTA exceeds the available inner width. German text increases the pressure further.

**Recommendation**

- Add a phone breakpoint that shortens or iconizes the web-app CTA, reduces gaps/padding, or stacks/wraps controls.
- Verify at 320, 360, 375, and 400 CSS pixels in both languages.
- Add screenshot regression tests for the landing header.

### FRONTEND-14 — Destructive admin mutations lack confirmation, while one-time secrets are easy to dismiss

**Severity:** Medium
**Category:** Operational safety / usability

Several consequential admin actions execute immediately:

- Announcement deletion: [`apps/web/src/admin/pages/AnnouncementsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/AnnouncementsPage.tsx#L179-L191), [`apps/web/src/admin/pages/AnnouncementsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/AnnouncementsPage.tsx#L407-L413)
- OAuth application deletion: [`apps/web/src/admin/pages/OAuthAppsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/OAuthAppsPage.tsx#L155-L165), [`apps/web/src/admin/pages/OAuthAppsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/OAuthAppsPage.tsx#L271-L277)
- Bulk user disabling: [`apps/web/src/admin/pages/UsersPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/UsersPage.tsx#L77-L100), [`apps/web/src/admin/pages/UsersPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/UsersPage.tsx#L121-L130)
- Invite revocation: [`apps/web/src/admin/pages/InvitesPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/InvitesPage.tsx#L59-L70)
- Registration-token revocation: [`apps/web/src/admin/pages/SettingsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/SettingsPage.tsx#L284-L292)

At the same time, values that are shown only once use generic backdrop- and Escape-dismissable modals:

- Temporary password: [`apps/web/src/admin/pages/UsersPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/UsersPage.tsx#L209-L220)
- Invite URL: [`apps/web/src/admin/pages/InvitesPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/InvitesPage.tsx#L157-L168)
- OAuth client secret: [`apps/web/src/admin/pages/OAuthAppsPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/pages/OAuthAppsPage.tsx#L298-L315)
- Personal API token: [`apps/web/src/user/settings/ApiAccessPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/ApiAccessPage.tsx#L102-L139)

An accidental click outside the dialog can permanently discard the displayed credential. Conversely, an accidental click on Delete can disrupt users or integrations immediately.

**Recommendation**

- Require named confirmation or show blast radius for destructive delete/disable operations.
- Provide undo where technically possible.
- Use lighter confirmation for reversible revocations, but still prevent double activation.
- For one-time credentials, require an explicit “I saved this” acknowledgement or disable backdrop dismissal until the value has been copied/downloaded.

### FRONTEND-15 — Muted small text does not consistently meet contrast requirements

**Severity:** Medium
**Category:** Accessibility / visual usability

The landing palette defines `--faint: #737373`:

- [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L10-L21)

That color has an approximate contrast ratio of:

- 4.18:1 on `#0a0a0a`;
- 3.78:1 on `#171717`.

Both are below the 4.5:1 WCAG AA threshold for normal-size text. It is used for 13.5–14px content:

- Invite note: [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L183-L190)
- Footer: [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L261-L277)

The React app similarly uses `text-neutral-500` and especially `text-neutral-600` for 12–14px hints, timestamps, placeholders, and legal links:

- Shared field hints: [`apps/web/src/user/components/ui.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/ui.tsx#L45-L64)
- Footer links: [`apps/web/src/user/components/AppLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AppLayout.tsx#L115-L134)

Landing links globally remove underlines:

- [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L44-L47)

Footer links then rely primarily on a modest color change from surrounding text, which is an insufficient non-color affordance.

**Recommendation**

- Raise normal muted text to at least the neutral-400 range.
- Reserve lower-contrast colors for decorative or disabled content that does not convey necessary information.
- Underline inline/footer links or provide another persistent non-color cue.
- Run automated contrast checks and manually verify computed colors over translucent backgrounds.

### FRONTEND-16 — Price charts have no usable data alternative

**Severity:** Medium
**Category:** Accessibility / financial-data usability

`PriceChart` exposes the chart as an empty container with `role="img"` and a generic label:

- [`apps/web/src/ui/charts/PriceChart.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/ui/charts/PriceChart.tsx#L380-L400)

All values remain in the canvas-based chart implementation, so a screen-reader user cannot inspect the start value, end value, minimum, maximum, change, or individual time points.

The allocation donut demonstrates a stronger pattern by including a textual summary and DOM legend:

- [`apps/web/src/ui/charts/AllocationDonut.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/ui/charts/AllocationDonut.tsx#L64-L119)

**Recommendation**

- Add a concise localized summary containing period, start/end values, absolute/percentage change, and extrema.
- Offer an expandable accessible data table for exact points.
- Associate the summary/table with the visual chart through `aria-describedby`.

### FRONTEND-17 — Admin localization is largely nonfunctional despite being advertised

**Severity:** Medium
**Category:** Localization / usability

`AdminApp` states that admin surfaces render the chosen language:

- [`apps/web/src/admin/AdminApp.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/AdminApp.tsx#L64-L77)

However:

- There is no admin locale picker.
- The admin origin has separate `localStorage`, so a user-origin language choice does not transfer.
- Most navigation entries and sign-out text are literal English in [`apps/web/src/admin/components/AdminLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/AdminLayout.tsx#L10-L44) and [`apps/web/src/admin/components/AdminLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/AdminLayout.tsx#L162-L191).
- Most admin pages, tables, buttons, errors, and dialogs are hardcoded English.

The user application also retains smaller localization leaks:

- Hardcoded “Prev Close” and watchlist accessible labels in [`apps/web/src/user/assets/AssetDetailPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/assets/AssetDetailPage.tsx#L188-L210) and [`apps/web/src/user/assets/AssetDetailPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/assets/AssetDetailPage.tsx#L373-L390).
- Hardcoded notification trigger label in [`apps/web/src/user/components/NotificationBell.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/NotificationBell.tsx#L231-L239).
- Hardcoded English rate-limit banner construction in [`apps/web/src/user/AuthContext.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/AuthContext.tsx#L325-L342).
- Multiple API error paths display server-provided English messages directly.

**Recommendation**

- Either translate the complete admin surface and add an admin locale selector, or explicitly document the admin console as English-only.
- Eliminate remaining user-app literal labels and error construction.
- Map stable API error codes to localized client messages rather than displaying raw server text.

### FRONTEND-18 — Raw render-exception messages are displayed to users

**Severity:** Low
**Category:** Security hardening / usability

The default error boundary renders `error.message` directly:

- [`apps/web/src/ui/ErrorBoundary.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/ui/ErrorBoundary.tsx#L45-L75)

React escapes the value, so this is not an XSS sink. It can nevertheless expose component/library implementation details, internal identifiers, or validation paths and gives users no actionable support reference.

**Recommendation**

- Show a localized generic error plus a generated incident/correlation ID.
- Keep detailed exception messages in development builds and sanitized telemetry only.

### FRONTEND-19 — Landing runtime configuration is interpolated into executable JavaScript without encoding

**Severity:** Low
**Category:** Deployment hardening / client security

Runtime origin values are inserted directly into a single-quoted JavaScript assignment:

- Template: [`apps/landing/site/env.js.template`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/env.js.template#L1)
- `envsubst` rendering: [`apps/landing/docker-entrypoint.sh`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/docker-entrypoint.sh#L10-L19)

The page then trusts `webOrigin` as an anchor destination and concatenates `apiOrigin` into a fetch URL:

- English landing script: [`apps/landing/site/index.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L165-L200)
- Mobile placeholder script: [`apps/landing/site/mobile.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/mobile.html#L36-L44)

This is not directly controllable by an ordinary application user; it requires privileged deployment misconfiguration or environment compromise. Nevertheless, quote/newline characters can break the generated JavaScript, and a non-HTTP scheme can become a dangerous link target.

**Recommendation**

- Generate runtime configuration using a real JSON encoder.
- Parse values with `new URL()` and permit only `https:` plus explicitly allowed development loopback `http:`.
- Fail container startup on an invalid configured origin.

### FRONTEND-20 — Reduced-motion support is incomplete

**Severity:** Low
**Category:** Accessibility

The PIN shake correctly honors `prefers-reduced-motion`:

- [`apps/web/src/index.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/index.css#L17-L45)

Other repeated motion does not share a global reduced-motion policy:

- Skeleton pulse: [`apps/web/src/ui/Skeleton.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/ui/Skeleton.tsx#L22-L34)
- User spinner: [`apps/web/src/user/components/ui.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/ui.tsx#L84-L94)
- Landing smooth scrolling and button transitions: [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L30-L32), [`apps/landing/site/styles.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/styles.css#L115-L130)

These animations are not severe flashing hazards, but users who request reduced motion should receive a consistent experience.

**Recommendation**

- Add a global `prefers-reduced-motion: reduce` rule that disables smooth scrolling and nonessential pulse/transition animations.
- Keep progress state understandable through text and static visuals.

### FRONTEND-21 — Unknown routes silently redirect instead of showing a not-found state

**Severity:** Low
**Category:** Navigation / supportability

Unknown user routes redirect to home:

- [`apps/web/src/user/UserApp.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/UserApp.tsx#L221-L227)

Unknown admin routes redirect to the users page:

- [`apps/web/src/admin/AdminApp.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/AdminApp.tsx#L53-L59)

This avoids a raw browser 404 but makes mistyped, stale, or broken deep links look like successful navigation. It complicates user support and can hide defects in notifications or shared links.

**Recommendation**

- Render a designed localized not-found page with Home/Back actions.
- Preserve the requested path for diagnostics.
- Keep explicit redirects only for intentionally retired routes.

## Roadmap and intentionally unfinished surfaces

The following routes are explicitly represented as `ComingSoon` or placeholder experiences. They are product-completeness gaps, not security regressions:

- Portfolio Transactions and Custom Assets: [`apps/web/src/user/portfolio/PortfolioSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/portfolio/PortfolioSection.tsx#L41-L60)
- Asset overview and category browsers: [`apps/web/src/user/assets/AssetsSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/assets/AssetsSection.tsx#L7-L21), [`apps/web/src/user/assets/AssetsSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/assets/AssetsSection.tsx#L31-L77)
- Workboard Backtests, Calculators, and Comparisons: [`apps/web/src/user/workboard/WorkboardSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/workboard/WorkboardSection.tsx#L49-L84)
- Settings Imports & Exports, Connections, and Backups: [`apps/web/src/user/settings/SettingsSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/SettingsSection.tsx#L1167-L1196)
- Social Ideas: [`apps/web/src/user/social/SocialSection.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/social/SocialSection.tsx#L30-L35)
- Native mobile application placeholder: [`apps/landing/site/mobile.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/mobile.html#L16-L34), [`apps/landing/site/mobile.de.html`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/mobile.de.html#L16-L34)

### Stale roadmap affordance

The profile menu labels “Share Profile” as disabled/coming soon:

- [`apps/web/src/user/components/ProfileMenu.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/ProfileMenu.tsx#L99-L113)

Profile sharing is already implemented through `/social/profile` and the public `/u/:username` route:

- [`apps/web/src/user/UserApp.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/UserApp.tsx#L195-L205)

This is a confirmed information-architecture defect rather than an intentional missing feature. Link the menu item to the implemented profile-sharing settings.

## Positive security and usability patterns

### Security

- No `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, `document.write`, or `srcDoc` sink was found in `apps/web` or `apps/landing`.
- React rendering therefore escapes chat messages, announcements, usernames, asset data, and other server/user content by default.
- The API client centralizes requests, includes credentials, and adds a custom CSRF header on unsafe methods: [`apps/web/src/lib/apiClient.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/apiClient.ts#L103-L140).
- Admin and user route trees/auth contexts are selected by per-origin runtime configuration rather than URL alone: [`apps/web/src/App.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/App.tsx#L7-L38).
- Login return paths accept only same-origin absolute paths and reject protocol-relative destinations: [`apps/web/src/user/auth/LoginPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/LoginPage.tsx#L27-L34).
- OAuth approval navigates only to the server-returned validated destination, never directly to the query’s raw `redirect_uri`: [`apps/web/src/user/oauth/ConsentPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L140-L159).
- Notifications build internal destinations using encoded identifiers.
- Explicit logout and 401 handling clear the entire TanStack Query cache, preventing one account’s cached financial/social data from flashing for the next account: [`apps/web/src/user/AuthContext.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/AuthContext.tsx#L306-L319).
- Remembered-device storage validates its shape and deliberately excludes tokens/scopes: [`apps/web/src/user/auth/rememberedAccount.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/rememberedAccount.ts#L58-L95).
- External links opened with `_blank` consistently use `rel="noreferrer"` in the reviewed React application.

### Destructive and privacy-sensitive workflows

- Account deletion uses a warning list, typed username confirmation, password/second-factor reauthentication, and pending-state protection: [`apps/web/src/user/settings/DeleteAccountPage.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/DeleteAccountPage.tsx#L87-L163).
- Public-link sharing requires explicit acknowledgement before a capability link is minted: [`apps/web/src/user/components/AudiencePicker.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/components/AudiencePicker.tsx#L359-L385).
- The audience picker clearly distinguishes private, all-friends, specific-friends, and public-link exposure.
- Share-chip resolution is performed per viewer; inaccessible item identities are not rendered by the chat UI.
- User portfolio/watchlist deletion flows generally use confirmation, showing that the missing admin confirmations can follow an existing product pattern.

### Accessibility and responsive design

- Most fields have visible labels and appropriate `type`, `inputMode`, `autocomplete`, and disabled-pending behavior.
- Loading, empty, error, success, and retry states are widely represented rather than relying on blank screens.
- The admin mobile drawer implements initial focus, Tab trapping, Escape handling, scroll locking, and trigger focus restoration: [`apps/web/src/admin/components/AdminLayout.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/admin/components/AdminLayout.tsx#L77-L124).
- The PIN rejection animation honors reduced-motion preferences: [`apps/web/src/index.css`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/index.css#L17-L45).
- The allocation donut includes an accessible textual summary and DOM legend: [`apps/web/src/ui/charts/AllocationDonut.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/ui/charts/AllocationDonut.tsx#L64-L119).
- Financial deltas include textual plus/minus signs in addition to color in the shared money component: [`apps/web/src/ui/MoneyText.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/ui/MoneyText.tsx#L54-L69).
- Most large tables already use `overflow-x-auto`, and the admin navigation switches to a dedicated mobile drawer.
- Section-navigation links retain a minimum tap height and preserve selected portfolio query state.
- Landing screenshots include dimensions and useful alternative text, limiting layout shift and providing a textual substitute.

### Localization and formatting

- Locale changes update `document.documentElement.lang`: [`apps/web/src/i18n/I18nProvider.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/i18n/I18nProvider.tsx#L94-L113).
- English fallback behavior is centralized: [`apps/web/src/i18n/I18nProvider.tsx`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/i18n/I18nProvider.tsx#L61-L67).
- Number, money, percentage, and date formatting is centralized and locale-aware.
- English and German landing/mobile pages set the correct root `lang` attribute.

### Testing foundations

- The repository contains 81 frontend unit-test files and 20 Playwright end-to-end specs.
- End-to-end projects cover both Desktop Chrome and a Pixel 7 profile: [`playwright.config.ts`](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/playwright.config.ts#L48-L62).
- Existing tests cover authentication traps, PIN interaction, route separation, query-state preservation, chart toggle semantics, share acknowledgements, and the admin mobile drawer.

## Missing and insufficient tests

### Accessibility

- No `axe-core`, `jest-axe`, Playwright accessibility scan, or equivalent systematic WCAG regression suite was found.
- `Dialog`, admin `Modal`, and `ProfileMenu` have no direct keyboard/focus tests.
- Cmd-K tests cover rendering, Escape, backdrop clicks, and actions, but not focus containment or focus restoration.
- Menu-role components are not tested for Arrow/Home/End navigation.
- No tests assert skip links, page landmarks, heading structure, `aria-describedby`, `aria-invalid`, or focus-on-error.
- Price-chart tests cover toggles but not an accessible data alternative.
- Chat tests cover input focus and send failure, but not an accessible label, live announcements, semantic log structure, IME composition, or preserving scroll position.
- No automated color-contrast tests exist.

### Security and privacy

- No Sentry sanitizer/redaction tests exist for reset, invite, registration, public-share, or OAuth URLs.
- Export-token tests assert `localStorage` persistence, but do not require cleanup after download, expiration, logout, or account switch.
- No test covers the privacy behavior of the always-saved last-login identifier on explicit logout/shared devices.
- No browser test verifies remote OAuth logo referrer behavior or image-proxy restrictions.
- OAuth consent tests currently assert the local cancellation page rather than a standards-compatible denial callback.
- No tests verify landing runtime-config encoding or URL-scheme rejection.

### Resilience

- Session bootstrap tests do not sufficiently distinguish 401 from network/5xx behavior.
- Invite, public-share, public-profile, and Google registration-ticket tests do not enforce separate retryable outage states.
- Login/landing registration discovery lacks a user-visible failure/retry test.

### Mobile and visual regression

- Although the main Playwright suite has a Pixel 7 project, there are no targeted assertions for:
  - the hidden mobile search trigger;
  - active section-tab visibility after a deep link;
  - admin user-table keyboard behavior or clipping;
  - dense nested tax/transaction tables;
  - chat behavior with the software keyboard;
  - 320px-wide layouts.
- The landing application has no automated tests at all.
- No landing screenshot/visual-regression matrix exists for 320, 360, 375, and 400px in English and German.
- No registration-mode landing test covers all four modes and discovery failure.

### Direct page/component gaps

Notable components or workflows without focused direct tests include:

- User `Dialog`, `ProfileMenu`, `InvitePage`, `ForgotPasswordPage`, `ForcedPasswordChangePage`, `RequireUser`, `ProfileSettingsPage`, and several shared social pages.
- Admin `Modal`, admin `AuthContext`, `AnnouncementsPage`, `OAuthAppsPage`, `InvitesPage`, `AuditPage`, account defaults, and forced-password/2FA screens.
- Every static landing and mobile-placeholder page.

### Validation limitation

The review attempted to run:

- `pnpm --filter @bettertrack/web typecheck`
- `pnpm --filter @bettertrack/web test`

Both commands stopped before compilation/test execution because the workspace dependency installation is incomplete: `tsc` and `vitest` were not present. This is an environment limitation, not evidence that the product checks fail.

## Recommended implementation order

1. Add Sentry URL/query redaction and tests.
2. Remove durable/query-string export capabilities.
3. Correct landing registration-mode behavior and OAuth denial handling.
4. Fix error classification for session, invite, public-link, and registration workflows.
5. Replace or repair shared dialog/menu primitives.
6. Add authentication landmarks/headings, field error associations, and skip links.
7. Fix admin user-row semantics and add confirmations/one-time-secret safeguards.
8. Address mobile search/navigation visibility, landing header overflow, and dense tables.
9. Add chat log/IME/scroll behavior and chart data alternatives.
10. Complete contrast and localization passes.
11. Add automated accessibility, landing, privacy, resilience, and targeted mobile regression coverage.
