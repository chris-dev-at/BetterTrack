# BetterTrack — Follow-up TODOs

Tracked technical debt and deferred work. Items here are deliberate, reviewed
deviations — not blockers. Convert to GitHub issues when convenient.

## P0 auth/admin — owner review follow-ups (2026-06-14)

From the review of the P0 auth/admin foundation. The flagged deviations were
accepted for the bootstrap; these are the agreed follow-ups before production.

- [ ] **Add one real Docker Postgres CI integration test before production.**
      Tests currently run against in-process PGlite + `ioredis-mock` (fast, no
      Docker). Acceptable for the bootstrap, but add at least one CI job that
      runs the suite (or a focused integration slice) against a real
      `postgres:17` + `redis:7` service container to catch driver/dialect
      differences PGlite can't surface. (PROJECTPLAN.md §12 calls for
      testcontainers.)

- [ ] **Replace the curated common-password seed with the full top-10k list.**
      `apps/api/src/services/password/commonPasswords.ts` currently holds a
      ~140-entry curated seed. The policy mechanism is complete; drop in the
      full SecLists top-10k (lowercased) — no code change required beyond the
      list contents. (PROJECTPLAN.md §6.1.)

## Accepted as-is (no action needed, recorded for context)

- **Invite email is not sent** — the admin copies the one-time invite URL.
  Intentional: SMTP/email delivery is explicitly deferred (PROJECTPLAN.md §11,
  §15) and lands in P5.
- **`@node-rs/argon2`** chosen over `argon2` for prebuilt-binary reliability
  (no native toolchain needed). Tests assert the `$argon2id$` output format and
  the §10 parameters (64 MiB / t=3 / p=1).
- **Per-account login throttling counts failed attempts only** (10/h), so
  successful logins are never throttled. Sensible interpretation of §6.1.
