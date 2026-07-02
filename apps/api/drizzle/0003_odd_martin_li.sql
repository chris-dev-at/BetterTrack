CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "search_text" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "assets"."symbol" || ' ' || "assets"."name")) STORED;--> statement-breakpoint
CREATE INDEX "assets_search_text_gin" ON "assets" USING gin ("search_text");--> statement-breakpoint
CREATE INDEX "assets_symbol_name_trgm_gin" ON "assets" USING gin ("symbol" gin_trgm_ops,"name" gin_trgm_ops);
