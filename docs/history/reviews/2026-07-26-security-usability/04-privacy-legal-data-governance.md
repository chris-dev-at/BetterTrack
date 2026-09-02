# Pass 04 — Privacy, legal, and data governance

_Archived 2026-09-02 — part of the 2026-07-26 review round; its findings were triaged into issues and are recorded in `PROJECTPLAN.md` §16._

## Summary

The product UI and legal pages make stronger deletion, retention, processor, cookie, and backup claims than the current implementation can support. These are launch-level trust and compliance risks, even where retained data may have a legitimate security or accounting purpose.

This section identifies implementation/documentation mismatches. It is not legal advice; applicable obligations and final wording should be confirmed by qualified counsel.

## Findings

### PL-01 — Account-deletion claims conflict with retained identifying data

**Severity:** High trust/compliance risk

The privacy policy says account and associated financial/message data are permanently removed. In practice:

- audit records survive deletion and retain target identifiers, IP addresses, and metadata;
- email logs survive and retain recipient addresses and subjects after their user foreign key becomes `NULL`;
- the deletion operation writes a new audit entry containing the deleted username;
- remembered-device Redis mappings are not enumerated and removed;
- chat messages intentionally remain under a deleted-user identity, which the UI partly discloses but the privacy policy does not;
- audit and email-log categories are absent from the account-export manifest.

Evidence:

- [audit and email-log schema](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/data/schema.ts#L357)
- [deletion workflow](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/account/accountDeletionService.ts#L134)
- [export manifest](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/manifest.ts#L76)
- [English deletion copy](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/i18n/messages/en.json#L2253)
- [privacy policy deletion section](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/privacy/index.html#L182)

**Recommendation:** define explicit retention purposes and periods; pseudonymize or purge retained identifiers on a schedule; delete remembered-device bindings; reconcile chat behavior; and make product, privacy, and export wording describe the same lifecycle.

### PL-02 — Processor and recipient inventory is incomplete

**Severity:** Medium-High

The privacy page lists a subset of recipients, but the repository supports SMTP delivery, Google authentication, Sentry, Telegram, Discord, browser push services, Cloudflare, and market-data providers. Which integrations are actually enabled is deployment-specific, but the documentation needs a complete conditional inventory and purpose/legal-basis treatment.

Evidence:

- [privacy recipient section](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/privacy/index.html#L149)
- [supported environment configuration](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/config/env.ts#L62)
- [notification service](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/notifications/notificationService.ts#L132)
- [web Sentry initialization](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/sentry.ts#L12)

**Recommendation:** maintain one source-of-truth processor inventory generated or tested against supported production integrations. State which processors are optional, when data leaves the instance, retention terms, and operator responsibilities.

### PL-03 — Cookie/storage notice does not match runtime behavior

**Severity:** Medium

The cookie notice describes only two cookies and limited local storage. The application uses additional session/Google-flow cookies and stores PIN activity, remembered account identifiers, and account-export reauthentication tokens in browser storage.

Evidence:

- [cookie notice](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/cookies/index.html#L85)
- [cookie definitions](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/http/cookies.ts#L16)
- [PIN activity storage](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/AuthContext.tsx#L108)
- [account-export token storage](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/settings/AccountSettingsPage.tsx#L33)
- [remembered account storage](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/rememberedAccount.ts#L132)

**Recommendation:** inventory every cookie and browser-storage key, including purpose, lifetime, sensitivity, and whether it is essential. Update the notice and minimize persistence where possible.

### PL-04 — Backup-encryption language is overly broad

**Severity:** Medium

Local backups are plain gzip archives. Only the optional offsite workflow applies `age` public-key encryption. Stating that backups are encrypted without this distinction is inaccurate, and local backups share the database host by default.

Evidence:

- [privacy backup/log wording](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/privacy/index.html#L193)
- [local backup creation](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/backup.sh#L25)
- [offsite encryption](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/backup/offsite.sh#L65)
- [backup volumes](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/docker-compose.yml#L193)

**Recommendation:** encrypt local backups too, or accurately distinguish local and offsite protection. Document key custody, retention, deletion, restoration, and operator responsibilities.

### PL-05 — Generic deployments do not ship legal routes

**Severity:** Medium-High

The generic landing image copies only `apps/landing/site`, which does not include terms, privacy, Impressum, or cookie pages. Those documents live only in the bespoke live-edge tree. The SPA also hardcodes links to central BetterTrack pages instead of the configured instance origin.

Evidence:

- [landing Dockerfile](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/Dockerfile#L12)
- [landing footer](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/landing/site/index.html#L155)
- [hardcoded SPA legal links](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/legal.ts#L1)
- [generic apex proxy](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/nginx/templates/subdomains.conf.template#L92)

**Recommendation:** include an operator-configurable legal bundle in every supported topology, link it from landing/authenticated surfaces, and add route tests for every locale.

### PL-06 — Impressum contains incomplete production placeholders

**Severity:** Medium-High

The shipped Impressum includes a VAT placeholder and does not provide a complete postal address.

Evidence:

- [Impressum](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/infra/live/edge/html/product/impressum/index.html#L88)

**Recommendation:** replace every placeholder and obtain jurisdiction-specific review before public release. Add a build/test guard that rejects known placeholder markers in production legal content.

### PL-07 — Account-export coverage and future column safety need stronger guarantees

**Severity:** Medium

The export implementation selects complete rows and removes exact blocked column names. This is safe only while every future secret column is remembered in the blocklist. The completeness test classifies tables, but not every sensitive column. Audit/email records and several operational categories are also excluded, so “all my data” expectations require explicit definition.

Evidence:

- [export collector](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/collector.ts#L60)
- [export completeness test](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/__tests__/completeness.test.ts#L12)
- [export manifest](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/api/src/services/export/manifest.ts#L70)

**Recommendation:** use explicit per-table allowlisted export DTOs, test every sensitive column, and publish an accurate inventory of included and excluded categories with the reason for each exclusion.

### PL-08 — Client-side capability data can enter telemetry and browser history

**Severity:** High when client Sentry is enabled; otherwise Medium

Reset, invite, public-share, registration, OAuth-state, PKCE, and export capabilities appear in routes or query strings. The web Sentry integration has no URL scrubber, and export tokens remain in `localStorage` and a GET URL.

Evidence:

- [web Sentry initialization](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/sentry.ts#L12)
- [capability routes](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/UserApp.tsx#L103)
- [registration query token](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/RegisterPage.tsx#L105)
- [OAuth query handling](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L47)
- [export URL construction](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/lib/userApi.ts#L420)

**Recommendation:** scrub query strings and token-bearing path segments before telemetry, exchange capabilities and immediately replace browser URLs, and use one-time HttpOnly download exchanges rather than durable browser storage.

### PL-09 — Remembered login identifiers are stored without an explicit user choice

**Severity:** Medium privacy/usability

Every successful login stores the email or username and prefills it for the next visitor. A clear function exists but is not exposed or called on logout. This leaks account identity on shared devices.

Evidence:

- [login prefill](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/LoginPage.tsx#L96)
- [identifier persistence](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/LoginPage.tsx#L172)
- [unused clear function](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/auth/rememberedAccount.ts#L132)
- [logout flow](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/AuthContext.tsx#L634)

**Recommendation:** provide an opt-in “remember identifier” control and a visible “forget this account” action.

### PL-10 — Third-party OAuth logos can track users before consent

**Severity:** Medium privacy

The consent page fetches a registered OAuth client’s arbitrary HTTPS logo URL directly from the user’s browser. A client can use unique URLs to observe IP address, user agent, and consent-page timing before approval.

Evidence:

- [logo rendering](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/apps/web/src/user/oauth/ConsentPage.tsx#L84)
- [OAuth logo contract](https://github.com/chris-dev-at/BetterTrack/blob/68105467c910b6e64b8383ecb1b97f28ebb725a4/packages/contracts/src/oauth.ts#L103)

**Recommendation:** proxy, validate, resize, and cache logos; alternatively omit remote logos. At minimum set `referrerPolicy="no-referrer"` and enforce a narrow image CSP.

## Governance controls to add

1. A data inventory mapping database columns and browser-storage keys to purpose, retention, export, deletion, and recipient behavior.
2. Automated checks for privacy/legal placeholders and missing legal routes.
3. Retention jobs with testable deletion/anonymization outcomes.
4. A processor/subprocessor register tied to supported feature flags.
5. A recurring account-deletion and export verification test using a fully populated synthetic user.
6. Counsel sign-off on the final public wording and jurisdiction-specific operator obligations.
