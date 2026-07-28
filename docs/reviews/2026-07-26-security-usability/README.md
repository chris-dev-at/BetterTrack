# BetterTrack security and usability review

Review date: 2026-07-26
Reviewed revision: `68105467c910b6e64b8383ecb1b97f28ebb725a4`
Review type: repository-wide source, configuration, deployment, privacy, and usability assessment

## Publication note

During publication, `origin/main` advanced by 126 commits to `14554a4`. This report intentionally remains an immutable assessment of the reviewed revision above; evidence links therefore point to that exact commit rather than the moving branch.

Some findings may already have changed or been fixed in later commits. Revalidate each item against the deployed revision before treating this document as current-state attestation or closing work solely from the report.

## Outcome

BetterTrack has solid security foundations, but this review does not recommend a public production launch until the High-priority findings are remediated and regression-tested.

No Critical-class vulnerability, conventional SQL injection, direct React HTML-injection sink, or clear owner-authorization bypass was identified. The most important risks instead arise at boundaries between otherwise well-designed components:

1. administrator MFA state is attached to an account rather than the active session;
2. disabled accounts retain previously issued bearer credentials;
3. realtime connections discard scopes, remain active after revocation, and lack resource quotas;
4. documented secret rotation can make encrypted TOTP and Discord data unreadable;
5. production bootstrap values can create predictable administrator access;
6. autonomous factory and deployment tooling combines mutable code, broad credentials, automatic merging, and an unsigned deployment path;
7. the multifactory control API has no real authentication;
8. account exports do not work in the documented split-container topology;
9. legal, privacy, cookie, retention, and deployment statements do not consistently match the implementation;
10. shared frontend primitives have systemic keyboard, focus, mobile, and failure-state defects.

## Review passes

| Pass                                                                            | Focus                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [01 — Backend security](01-backend-security.md)                                 | Authentication, authorization, sessions, OAuth, API keys, realtime, imports, notifications, races, and data handling |
| [02 — Frontend usability](02-frontend-usability.md)                             | Client security, privacy, accessibility, resilience, responsive behavior, localization, and product completeness     |
| [03 — Infrastructure and supply chain](03-infrastructure-supply-chain.md)       | Docker, nginx, CI/CD, autonomous factories, secrets, deployment, backups, health, and operations                     |
| [04 — Privacy, legal, and data governance](04-privacy-legal-data-governance.md) | Deletion, retention, exports, processors, cookies, legal routes, and policy/implementation consistency               |
| [05 — Remediation roadmap](05-remediation-roadmap.md)                           | Ordered release gates, implementation guidance, and required regression tests                                        |
| [06 — Validation and limitations](06-validation-and-limitations.md)             | Scope, commands that ran, unavailable checks, external-state boundaries, and worktree notes                          |

## Severity model

- **Critical:** readily exploitable compromise with broad system or user impact and no substantial precondition.
- **High:** credible authorization, credential, confidentiality, integrity, or availability failure that should block release.
- **Medium:** meaningful security, privacy, reliability, accessibility, or operational weakness that should be scheduled promptly.
- **Low:** hardening, defense-in-depth, or localized usability defect with limited direct impact.

Severity reflects the repository and documented deployment as reviewed. Conditional findings state their important preconditions. This is practical release triage rather than a formal CVSS score.

## Recommended release decision

Treat the following as release gates:

- session-bound administrator MFA, session rotation, and Bull Board protection;
- active-user checks and revocation for every bearer and realtime credential;
- realtime scope enforcement, connection/watch quotas, and revocation handling;
- a stable, dedicated, versioned encryption-key lifecycle;
- safe one-use production bootstrap credentials and production-disabled demo seeding;
- authenticated multifactory control access;
- pinned and attested factory/build/deployment inputs with a protected human release gate;
- a shared durable export store tested in the actual API/worker topology;
- accurate deletion, retention, processor, cookie, backup, and legal documentation;
- baseline accessibility fixes for modal focus, navigation, forms, mobile tables, and chat.

## Important scope note

This was a repository review, not an external black-box penetration test or legal opinion. Live production overrides, secrets, ingress rules, GitHub rulesets, registry settings, cron, monitoring, and backup evidence are intentionally outside this checkout and must be verified separately.
