-- V5-P13 PD3b — kept watchlist/conglomerate/alert rows retain only their opaque
-- asset UUID while paranoid mode hard-deletes every user-owned asset row. Normal
-- custom-asset deletion preserves the old cascade semantics in its repository;
-- disable restores the same asset UUIDs and reconnects these references.
ALTER TABLE "workboard_items" DROP CONSTRAINT "workboard_items_asset_id_assets_id_fk";--> statement-breakpoint
ALTER TABLE "conglomerate_positions" DROP CONSTRAINT "conglomerate_positions_asset_id_assets_id_fk";--> statement-breakpoint
ALTER TABLE "alerts" DROP CONSTRAINT "alerts_asset_id_assets_id_fk";
