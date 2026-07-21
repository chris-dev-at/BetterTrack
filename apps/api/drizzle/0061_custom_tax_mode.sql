-- V5-P4c tax v2 (#584): the `custom` tax mode (user-parameterized rule-built
-- engine) + the manual mode's configurable default. Fully additive for
-- existing rows: new enum value, new nullable columns, no data rewritten.
--
-- Extend tax_mode with 'custom' by RECREATING the type (the 0019/0021 dance).
-- ALTER TYPE ... ADD VALUE would be rejected here: the migration runs in a
-- transaction, and the user_tax_settings_custom_params CHECK added below
-- references the new value, which Postgres forbids for values added (not
-- created) in the same transaction (55P04 "unsafe use of new value"). The
-- mode-referencing CHECK must drop before the column type dance (its
-- expression pins the old enum's OIDs); it is re-added verbatim at the end.
ALTER TABLE "user_tax_settings" DROP CONSTRAINT "user_tax_settings_country";--> statement-breakpoint
ALTER TABLE "user_tax_settings" ALTER COLUMN "mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "tax_mode" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "dividends" ALTER COLUMN "tax_mode" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "user_tax_settings" ALTER COLUMN "mode" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."tax_mode";--> statement-breakpoint
CREATE TYPE "public"."tax_mode" AS ENUM('none', 'manual_per_trade', 'country_specific', 'custom');--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "tax_mode" SET DATA TYPE "public"."tax_mode" USING "tax_mode"::"public"."tax_mode";--> statement-breakpoint
ALTER TABLE "dividends" ALTER COLUMN "tax_mode" SET DATA TYPE "public"."tax_mode" USING "tax_mode"::"public"."tax_mode";--> statement-breakpoint
ALTER TABLE "user_tax_settings" ALTER COLUMN "mode" SET DATA TYPE "public"."tax_mode" USING "mode"::"public"."tax_mode";--> statement-breakpoint
ALTER TABLE "user_tax_settings" ALTER COLUMN "mode" SET DEFAULT 'none';--> statement-breakpoint
-- Manual mode's configurable default (amount OR rate; both NULL = no default).
ALTER TABLE "user_tax_settings" ADD COLUMN "manual_default_amount_eur" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "user_tax_settings" ADD COLUMN "manual_default_rate_pct" numeric(9, 6);--> statement-breakpoint
-- The custom engine's parameter set (present exactly in 'custom' mode).
ALTER TABLE "user_tax_settings" ADD COLUMN "custom_params" jsonb;--> statement-breakpoint
-- Per-row parameter snapshot, frozen at recording time (§16 cutover: parameter
-- changes are a mode switch and apply forward only). NULL on non-custom rows.
ALTER TABLE "transactions" ADD COLUMN "tax_params" jsonb;--> statement-breakpoint
ALTER TABLE "dividends" ADD COLUMN "tax_params" jsonb;--> statement-breakpoint
ALTER TABLE "user_tax_settings" ADD CONSTRAINT "user_tax_settings_country" CHECK (("user_tax_settings"."mode" = 'country_specific') = ("user_tax_settings"."country" is not null));--> statement-breakpoint
ALTER TABLE "user_tax_settings" ADD CONSTRAINT "user_tax_settings_custom_params" CHECK (("user_tax_settings"."mode" = 'custom') = ("user_tax_settings"."custom_params" is not null));--> statement-breakpoint
ALTER TABLE "user_tax_settings" ADD CONSTRAINT "user_tax_settings_manual_default" CHECK (("user_tax_settings"."mode" = 'manual_per_trade') or ("user_tax_settings"."manual_default_amount_eur" is null and "user_tax_settings"."manual_default_rate_pct" is null));--> statement-breakpoint
ALTER TABLE "user_tax_settings" ADD CONSTRAINT "user_tax_settings_manual_default_single" CHECK ("user_tax_settings"."manual_default_amount_eur" is null or "user_tax_settings"."manual_default_rate_pct" is null);
