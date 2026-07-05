ALTER TABLE "conglomerates" ADD COLUMN "visibility" "portfolio_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "default_portfolio_visibility" "portfolio_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "watchlist_visibility" "portfolio_visibility" DEFAULT 'private' NOT NULL;