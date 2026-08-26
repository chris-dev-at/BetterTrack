-- Living tax-year markers describe financial edits, not no-op UPDATE
-- statements. Guard every trigger function introduced by 0093 while leaving
-- INSERT and DELETE behavior byte-identical.

CREATE OR REPLACE FUNCTION "bettertrack_touch_dated_tax_row"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
	-- Skip FK-cascade cleanup. The directly deleted transaction/dividend already
	-- records the edit, while account/portfolio deletion is not an amendment.
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		PERFORM "bettertrack_touch_tax_year_at"(OLD."portfolio_id", OLD."executed_at");
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		PERFORM "bettertrack_touch_tax_year_at"(NEW."portfolio_id", NEW."executed_at");
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bettertrack_touch_cash_tax_year"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."kind"::text IN (
		'deposit', 'withdrawal', 'fee', 'transfer_out', 'transfer_in'
	) THEN
		PERFORM "bettertrack_touch_tax_year_at"(OLD."portfolio_id", OLD."executed_at");
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."kind"::text IN (
		'deposit', 'withdrawal', 'fee', 'transfer_out', 'transfer_in'
	) THEN
		PERFORM "bettertrack_touch_tax_year_at"(NEW."portfolio_id", NEW."executed_at");
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bettertrack_touch_portfolio_tax_setting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- Repository upserts refresh updated_at even for an identical setting. That
	-- metadata-only write is not a tax-document edit; compare the functional row.
	IF TG_OP = 'UPDATE'
		AND OLD."portfolio_id" IS NOT DISTINCT FROM NEW."portfolio_id"
		AND OLD."key" IS NOT DISTINCT FROM NEW."key"
		AND OLD."value" IS NOT DISTINCT FROM NEW."value"
	THEN RETURN NEW; END IF;
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."key" = 'tax' THEN
		PERFORM "bettertrack_touch_portfolio_tax_years"(OLD."portfolio_id");
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."key" = 'tax' THEN
		PERFORM "bettertrack_touch_portfolio_tax_years"(NEW."portfolio_id");
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "bettertrack_touch_user_tax_setting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- As above, updated_at alone is metadata. Every tax-relevant column must stay
	-- identical for the no-op guard to fire.
	IF TG_OP = 'UPDATE'
		AND OLD."user_id" IS NOT DISTINCT FROM NEW."user_id"
		AND OLD."mode" IS NOT DISTINCT FROM NEW."mode"
		AND OLD."country" IS NOT DISTINCT FROM NEW."country"
		AND OLD."manual_default_amount_eur" IS NOT DISTINCT FROM NEW."manual_default_amount_eur"
		AND OLD."manual_default_rate_pct" IS NOT DISTINCT FROM NEW."manual_default_rate_pct"
		AND OLD."custom_params" IS NOT DISTINCT FROM NEW."custom_params"
	THEN RETURN NEW; END IF;
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') THEN
		PERFORM "bettertrack_touch_user_tax_years"(OLD."user_id");
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN
		PERFORM "bettertrack_touch_user_tax_years"(NEW."user_id");
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
