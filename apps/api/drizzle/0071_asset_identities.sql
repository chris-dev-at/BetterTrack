-- V5-P13 PD3b prerequisite — split the opaque asset UUID from the
-- content-bearing assets row. The lock keeps the populated backfill and FK
-- replacement one atomic cutover: readers continue, while no writer can enter
-- between the backfill, validation, and old-constraint retirement.
CREATE TABLE "asset_identities" (
	"id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
LOCK TABLE "assets", "workboard_items", "conglomerate_positions", "alerts" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "asset_identities" ("id")
SELECT "id" FROM "assets"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
-- A row-level AFTER trigger runs only for assets that were actually inserted,
-- including INSERT .. ON CONFLICT: a skipped candidate cannot strand an
-- identity. Trigger work is part of the inserting statement, so any later
-- constraint/error rolls both rows back together. Existing identities are the
-- intentional paranoid-detach case and make same-UUID rehydration idempotent.
CREATE FUNCTION "bettertrack_asset_identity_after_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO "asset_identities" ("id") VALUES (NEW."id")
	ON CONFLICT ("id") DO NOTHING;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assets_identity_after_insert"
AFTER INSERT ON "assets"
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_identity_after_insert"();
--> statement-breakpoint
-- Install every replacement FK as NOT VALID first: PostgreSQL enforces it for
-- new writes immediately. Validate all populated rows while the old asset FKs
-- still overlap, and retire the old constraints only after every validation
-- succeeds. No consumer column is ever orphanable.
ALTER TABLE "workboard_items"
ADD CONSTRAINT "workboard_items_asset_id_asset_identities_id_fk"
FOREIGN KEY ("asset_id") REFERENCES "public"."asset_identities"("id")
ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "conglomerate_positions"
ADD CONSTRAINT "conglomerate_positions_asset_id_asset_identities_id_fk"
FOREIGN KEY ("asset_id") REFERENCES "public"."asset_identities"("id")
ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "alerts"
ADD CONSTRAINT "alerts_asset_id_asset_identities_id_fk"
FOREIGN KEY ("asset_id") REFERENCES "public"."asset_identities"("id")
ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "workboard_items"
VALIDATE CONSTRAINT "workboard_items_asset_id_asset_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "conglomerate_positions"
VALIDATE CONSTRAINT "conglomerate_positions_asset_id_asset_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "alerts"
VALIDATE CONSTRAINT "alerts_asset_id_asset_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "workboard_items"
DROP CONSTRAINT "workboard_items_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "conglomerate_positions"
DROP CONSTRAINT "conglomerate_positions_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "alerts"
DROP CONSTRAINT "alerts_asset_id_assets_id_fk";
--> statement-breakpoint
-- Ordinary/global asset deletion and account-deletion cascades keep their
-- historical semantics: deleting the content row deletes its identity, whose
-- database FKs atomically cascade the three server-kept consumers. The one
-- exception is the owner-scoped detach function below.
CREATE FUNCTION "bettertrack_asset_identity_after_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF current_setting('bettertrack.asset_identity_detach_id', true)
		IS DISTINCT FROM OLD."id"::text THEN
		DELETE FROM "asset_identities" WHERE "id" = OLD."id";
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "assets_identity_after_delete"
AFTER DELETE ON "assets"
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_identity_after_delete"();
--> statement-breakpoint
-- The identity cannot be removed out from under a live content row. This is
-- the reverse half of the trigger-enforced one-to-zero-or-one relationship:
-- inserts create the key; ordinary asset deletes remove it; only a detached
-- (content-free) identity is independently deletable.
CREATE FUNCTION "bettertrack_asset_identity_before_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM "assets" WHERE "id" = OLD."id") THEN
		RAISE EXCEPTION 'asset identity % still has a content row', OLD."id"
			USING
				ERRCODE = '23503',
				CONSTRAINT = 'asset_identities_id_assets_id_guard';
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "asset_identities_asset_guard_before_delete"
BEFORE DELETE ON "asset_identities"
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_identity_before_delete"();
--> statement-breakpoint
-- Detached identities have deliberately no owner/content column. Prune one
-- once it has neither an assets row nor any kept reference. The three
-- DEFERRABLE triggers share this function and run at transaction end, so a
-- delete-and-reinsert edit cannot lose its key between statements. This also
-- cleans detached identities when account deletion cascades the last kept row,
-- without teaching the account repository about asset lifecycle.
CREATE FUNCTION "bettertrack_prune_detached_asset_identity"("p_asset_id" uuid)
RETURNS void
LANGUAGE sql
AS $$
	DELETE FROM "asset_identities" identity
	WHERE identity."id" = "p_asset_id"
	  AND NOT EXISTS (
		SELECT 1 FROM "assets" asset
		WHERE asset."id" = "p_asset_id"
	  )
	  AND NOT EXISTS (
		SELECT 1 FROM "workboard_items" item
		WHERE item."asset_id" = "p_asset_id"
	  )
	  AND NOT EXISTS (
		SELECT 1 FROM "conglomerate_positions" position
		WHERE position."asset_id" = "p_asset_id"
	  )
	  AND NOT EXISTS (
		SELECT 1 FROM "alerts" alert
		WHERE alert."asset_id" = "p_asset_id"
	  );
$$;
--> statement-breakpoint
CREATE FUNCTION "bettertrack_asset_reference_after_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."asset_id" IS NOT NULL THEN
		PERFORM "bettertrack_prune_detached_asset_identity"(OLD."asset_id");
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "workboard_items_prune_detached_asset_identity"
AFTER DELETE OR UPDATE ON "workboard_items"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_reference_after_change"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "conglomerate_positions_prune_detached_asset_identity"
AFTER DELETE OR UPDATE ON "conglomerate_positions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_reference_after_change"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "alerts_prune_detached_asset_identity"
AFTER DELETE OR UPDATE ON "alerts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "bettertrack_asset_reference_after_change"();
--> statement-breakpoint
-- Internal paranoid-purge seam. It can detach only a custom/owned asset, locks
-- that row against concurrent mutation, and scopes the trigger bypass to this
-- exact UUID for the duration of the transaction. It stores no marker row or
-- metadata; after the delete only asset_identities(id) and kept references
-- remain. Calling it again or for a global/foreign asset is a no-op.
CREATE FUNCTION "bettertrack_detach_owned_asset_data"(
	"p_asset_id" uuid,
	"p_owner_id" uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
	deleted_count integer := 0;
BEGIN
	PERFORM 1
	FROM "assets"
	WHERE "id" = "p_asset_id"
	  AND "owner_id" = "p_owner_id"
	  AND "provider_id" = 'manual'
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN false;
	END IF;

	PERFORM set_config(
		'bettertrack.asset_identity_detach_id',
		"p_asset_id"::text,
		true
	);
	DELETE FROM "assets"
	WHERE "id" = "p_asset_id"
	  AND "owner_id" = "p_owner_id"
	  AND "provider_id" = 'manual';
	GET DIAGNOSTICS deleted_count = ROW_COUNT;
	PERFORM set_config('bettertrack.asset_identity_detach_id', '', true);
	PERFORM "bettertrack_prune_detached_asset_identity"("p_asset_id");
	RETURN deleted_count = 1;
EXCEPTION
	WHEN OTHERS THEN
		PERFORM set_config('bettertrack.asset_identity_detach_id', '', true);
		RAISE;
END;
$$;
