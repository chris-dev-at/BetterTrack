# BetterTrack docs index

Auxiliary documentation (PROJECTPLAN.md §4.2). `CLAUDE.md`, `PROJECTPLAN.md`,
`MODELUSE.md` and `README.md` stay at the repository root; everything normative
that is not one of those four lives here. Completed rounds, one-off runbooks and
superseded designs move to [`history/`](history/) instead of being deleted.

## Normative docs

| Doc                                              | Purpose                                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [`SECURITY_CI_POLICY.md`](SECURITY_CI_POLICY.md) | What the CI `verify` security gate audits and how a dependency waiver is granted                    |
| [`admin-2fa.md`](admin-2fa.md)                   | Mandatory admin 2FA — enrollment, login challenge, and the shell-only break-glass reset             |
| [`factory-knowledge.md`](factory-knowledge.md)   | The knowledge pack injected into every factory agent, and how it is regenerated                     |
| [`factory-usage.md`](factory-usage.md)           | Per-issue token and cost tracking for the build factory                                             |
| [`i18n.md`](i18n.md)                             | Translation rules — EN is the source of truth, DE is the first translation; key conventions         |
| [`imports.md`](imports.md)                       | Broker CSV imports: autodetect, staging, preview, apply (V4-P8 framework)                           |
| [`mirrorchain-design.md`](mirrorchain-design.md) | Binding design note for MIRRORCHAIN group portfolios (V5-P7)                                        |
| [`mobile-push.md`](mobile-push.md)               | The FCM HTTP v1 push contract for the mobile app track                                              |
| [`monitoring.md`](monitoring.md)                 | Self-provisioned Prometheus + Grafana in the deploy stack, and its exposure guarantee               |
| [`multi-factory.md`](multi-factory.md)           | The parallel build factory — master + workers, claims, and the merge lane                           |
| [`ops.md`](ops.md)                               | Ops runbook: backups, restore drills, offsite upload, retention, provider failover, troubleshooting |
| [`paranoid-design.md`](paranoid-design.md)       | Binding design note for client-encrypted paranoid vaults (V5-P13)                                   |
| [`supply-chain.md`](supply-chain.md)             | Container image scanning (Trivy) and CycloneDX SBOM generation                                      |
| [`vault-qr-contract.md`](vault-qr-contract.md)   | The normative `btvault1:` QR seed-phrase wire contract, extracted from `paranoid-design.md` §13     |

## Archive

[`history/`](history/) — archived, non-normative records kept for provenance:
the pre-condensation decision log, the v1 pre-release notes, the completed
review rounds ([`history/reviews/`](history/reviews/README.md) — the 2026-07-26
security-and-usability round and the 2026-07-30 landing phone-viewport
verification), the Origin redesign record (`history/redesign/`;
the v6 ground-up redesign is tracked in #544), the single-factory and
Fable-outage runbooks, broker-integration research, and the local Ollama setup
runbook ([`history/ollama-runbook.md`](history/ollama-runbook.md) — still the
reference for provisioning the LAN Ollama box, issue #657), the paranoid-vaults
design narrative superseded by the post-E9 condensation
([`history/paranoid-design-history.md`](history/paranoid-design-history.md)) and
the V1-era `PROJECTPLAN.md` §6/§7 text with its folded §13.2–§13.5 milestone
tables ([`history/PROJECTPLAN-V1-sections.md`](history/PROJECTPLAN-V1-sections.md)) —
both append-only. Each archived file
carries a one-line header stating when it was archived and what supersedes it;
nothing in `history/` is authoritative for current behaviour.
