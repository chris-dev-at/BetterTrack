-- First-run setup completion (§6.12). `null` means the account has never been
-- through the setup wizard; a timestamp means it finished or dismissed it.
--
-- Why a column and not a derived signal: every sign-in path stamps
-- `last_login_at` before the response body is built, so it is already non-null on
-- a user's very first `/auth/me` — there is no "first session" to detect after
-- the fact. Only an explicit bit can reach an account created by an admin or by
-- an approved application, neither of which ever passes through a signup screen.
--
-- Backfill: every account that already exists predates the wizard, so it is
-- marked complete from its own `created_at`. Established users are therefore
-- never sent to setup by this migration; only rows created afterwards start
-- `null`. `users.created_at` is NOT NULL, so this leaves no nulls behind.
ALTER TABLE "users" ADD COLUMN "first_run_completed_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "users" SET "first_run_completed_at" = "created_at";
