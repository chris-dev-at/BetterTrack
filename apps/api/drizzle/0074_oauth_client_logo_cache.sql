-- Remote OAuth client logos are fetched once through the outbound-URL guard.
-- Consent surfaces serve only these bounded raster bytes from BetterTrack.
ALTER TABLE "oauth_clients"
ADD COLUMN "logo_bytes" bytea;
--> statement-breakpoint
ALTER TABLE "oauth_clients"
ADD COLUMN "logo_content_type" varchar(32);
--> statement-breakpoint
ALTER TABLE "oauth_clients"
ADD CONSTRAINT "oauth_clients_logo_cache_complete"
CHECK (("logo_bytes" IS NULL) = ("logo_content_type" IS NULL));
--> statement-breakpoint
ALTER TABLE "oauth_clients"
ADD CONSTRAINT "oauth_clients_logo_cache_size"
CHECK ("logo_bytes" IS NULL OR octet_length("logo_bytes") <= 524288);
--> statement-breakpoint
ALTER TABLE "oauth_clients"
ADD CONSTRAINT "oauth_clients_logo_cache_type"
CHECK (
	"logo_content_type" IS NULL
	OR "logo_content_type" IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')
);
