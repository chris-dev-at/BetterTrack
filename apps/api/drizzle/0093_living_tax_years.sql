-- Owner order 2026-08-19: tax years are living documentation. Remove the
-- unlock ceremony state outright and replace it with one durable edit marker
-- per account/year. The dropped rows are policy ceremony only; they contain no
-- financial data and deliberately receive no backup table.
DROP TABLE "tax_year_unlocks";
--> statement-breakpoint
CREATE TABLE "tax_year_changes" (
	"user_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_year_changes_user_id_year_pk" PRIMARY KEY("user_id","year")
);
--> statement-breakpoint
ALTER TABLE "tax_year_changes" ADD CONSTRAINT "tax_year_changes_user_id_users_id_fk"
FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- One account-wide touch primitive. `statement_timestamp()` gives every row
-- produced by one logical statement the same edit time while separate writes
-- advance independently. A missing portfolio is a safe no-op (for example a
-- defensive caller racing a hard delete).
CREATE FUNCTION "bettertrack_touch_tax_year"(
	"p_portfolio_id" uuid,
	"p_year" integer
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "tax_year_changes" ("user_id", "year", "last_changed_at")
	SELECT p."user_id", p_year, statement_timestamp()
	FROM "portfolios" p
	WHERE p."id" = p_portfolio_id
	ON CONFLICT ("user_id", "year") DO UPDATE
	SET "last_changed_at" = GREATEST(
		"tax_year_changes"."last_changed_at",
		EXCLUDED."last_changed_at"
	);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "bettertrack_touch_tax_year_at"(
	"p_portfolio_id" uuid,
	"p_executed_at" timestamp with time zone
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "bettertrack_touch_tax_year"(
		p_portfolio_id,
		EXTRACT(YEAR FROM p_executed_at AT TIME ZONE 'Europe/Vienna')::integer
	);
END;
$$;
--> statement-breakpoint

-- Transactions and dividends are the tax document's dated source rows. UPDATE
-- touches both sides so moving an entry across New Year marks both documents;
-- DELETE touches OLD, which a computed maximum over surviving rows cannot do.
CREATE FUNCTION "bettertrack_touch_dated_tax_row"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "transactions_tax_year_change"
AFTER INSERT OR UPDATE OR DELETE ON "transactions"
FOR EACH ROW EXECUTE FUNCTION "bettertrack_touch_dated_tax_row"();
--> statement-breakpoint
CREATE TRIGGER "dividends_tax_year_change"
AFTER INSERT OR UPDATE OR DELETE ON "dividends"
FOR EACH ROW EXECUTE FUNCTION "bettertrack_touch_dated_tax_row"();
--> statement-breakpoint

-- User-editable cash operations are documents too. Linked buy/sell/dividend
-- and derived tax rows are covered by their parent mutation and are excluded
-- here so report self-healing can never masquerade as a user edit.
CREATE FUNCTION "bettertrack_touch_cash_tax_year"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "portfolio_cash_movements_tax_year_change"
AFTER INSERT OR UPDATE OR DELETE ON "portfolio_cash_movements"
FOR EACH ROW EXECUTE FUNCTION "bettertrack_touch_cash_tax_year"();
--> statement-breakpoint

-- A tax-setting change can alter every living report year even though the
-- setting itself has no effective timestamp. Touch exactly the years whose
-- source rows belong to the affected portfolio/account.
CREATE FUNCTION "bettertrack_touch_portfolio_tax_years"(
	"p_portfolio_id" uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO "tax_year_changes" ("user_id", "year", "last_changed_at")
	SELECT p."user_id", years."year", statement_timestamp()
	FROM "portfolios" p
	CROSS JOIN LATERAL (
		SELECT EXTRACT(YEAR FROM t."executed_at" AT TIME ZONE 'Europe/Vienna')::integer AS year
		FROM "transactions" t WHERE t."portfolio_id" = p_portfolio_id
		UNION
		SELECT EXTRACT(YEAR FROM d."executed_at" AT TIME ZONE 'Europe/Vienna')::integer AS year
		FROM "dividends" d WHERE d."portfolio_id" = p_portfolio_id
		UNION
		SELECT COALESCE(
			m."tax_year",
			EXTRACT(YEAR FROM m."executed_at" AT TIME ZONE 'Europe/Vienna')::integer
		) AS year
		FROM "portfolio_cash_movements" m WHERE m."portfolio_id" = p_portfolio_id
	) years
	WHERE p."id" = p_portfolio_id
	ON CONFLICT ("user_id", "year") DO UPDATE
	SET "last_changed_at" = GREATEST(
		"tax_year_changes"."last_changed_at",
		EXCLUDED."last_changed_at"
	);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "bettertrack_touch_user_tax_years"(
	"p_user_id" uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "bettertrack_touch_portfolio_tax_years"(p."id")
	FROM "portfolios" p
	WHERE p."user_id" = p_user_id;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "bettertrack_touch_portfolio_tax_setting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER "portfolio_settings_tax_year_change"
AFTER INSERT OR UPDATE OR DELETE ON "portfolio_settings"
FOR EACH ROW EXECUTE FUNCTION "bettertrack_touch_portfolio_tax_setting"();
--> statement-breakpoint
CREATE FUNCTION "bettertrack_touch_user_tax_setting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
--> statement-breakpoint
CREATE TRIGGER "user_tax_settings_tax_year_change"
AFTER INSERT OR UPDATE OR DELETE ON "user_tax_settings"
FOR EACH ROW EXECUTE FUNCTION "bettertrack_touch_user_tax_setting"();
