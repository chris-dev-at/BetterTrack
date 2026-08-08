-- Tax year locking (owner directive 2026-08-07, PROJECTPLAN.md §16): a tax
-- year auto-locks once the Vienna calendar year has ended — backdated
-- mutations into it are refused (409 TAX_YEAR_LOCKED) until the user runs the
-- explicit, password-re-authenticated unlock ritual for that ONE year.
--
-- The table stores only the EXCEPTIONS: one row per (user, year) the user
-- explicitly unlocked for amendments. LOCKED is the absence of a row for any
-- year before the current Vienna year, so:
--   * "on migration, all fully-elapsed years start locked" holds with zero
--     backfill (the table starts empty), and
--   * every future Jan-1 rollover locks the ending year with no job — the
--     lock predicate re-evaluates against the clock on every check.
-- The current (open) year is never lockable; an unlocked year stays amendable
-- until the user explicitly re-locks it (row deleted). Unlock/relock actions
-- are audit-logged (audit_log, no schema change needed there).
CREATE TABLE "tax_year_unlocks" (
	"user_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_year_unlocks_user_id_year_pk" PRIMARY KEY("user_id","year")
);
--> statement-breakpoint
ALTER TABLE "tax_year_unlocks" ADD CONSTRAINT "tax_year_unlocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
