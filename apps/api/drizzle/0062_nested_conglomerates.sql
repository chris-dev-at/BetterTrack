-- Nested conglomerates (issue #592, §13.5 V5-P6b arc): a constituent row may
-- now reference one of the owner's OWN conglomerates instead of an asset.
-- `asset_id` becomes nullable and gains a sibling `child_conglomerate_id`;
-- exactly one of the two is set (CHECK). The child FK has NO delete action:
-- deleting a conglomerate still in use as a constituent is blocked — the
-- service rejects it with the parent names, and Postgres backstops (NO ACTION
-- validates at end of statement, so an account deletion's single cascading
-- DELETE, which removes parents and children together, still succeeds).
-- Cycle detection and the depth cap (3) are write-time service rules.
ALTER TABLE "conglomerate_positions" ALTER COLUMN "asset_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "conglomerate_positions" ADD COLUMN "child_conglomerate_id" uuid;
--> statement-breakpoint
ALTER TABLE "conglomerate_positions" ADD CONSTRAINT "conglomerate_positions_child_conglomerate_id_conglomerates_id_fk" FOREIGN KEY ("child_conglomerate_id") REFERENCES "public"."conglomerates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conglomerate_positions" ADD CONSTRAINT "conglomerate_positions_exactly_one_ref" CHECK (("asset_id" is null) <> ("child_conglomerate_id" is null));
--> statement-breakpoint
CREATE UNIQUE INDEX "conglomerate_positions_cong_child_unique" ON "conglomerate_positions" USING btree ("conglomerate_id","child_conglomerate_id");
--> statement-breakpoint
CREATE INDEX "conglomerate_positions_child_idx" ON "conglomerate_positions" USING btree ("child_conglomerate_id");
