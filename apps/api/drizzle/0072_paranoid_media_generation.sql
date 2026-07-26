-- V5-P13 PD6 review follow-up — proof freshness and replay safety. The
-- generation is internal account metadata: every committed media mutation
-- increments it, and signed transition proofs bind to the value observed while
-- they were minted. A visible state cycle can therefore never revive an older
-- destructive proof.
ALTER TABLE "users" ADD COLUMN "paranoid_media_generation" integer DEFAULT 0 NOT NULL;
