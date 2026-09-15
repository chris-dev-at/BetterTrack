-- Living tax-year markers must describe every year whose DOCUMENTATION moved,
-- not only the year whose source row was edited (#1591). That is the aim; the
-- SCOPE paragraph below states exactly how much of it this migration delivers.
--
-- A backdated edit re-settles later years: DE loss pots carry forward and AT's
-- moving-average basis propagates, so amending 2023 changes the 2024 and 2025
-- reports too. Those later years are re-settled by an UNATTACHED tax correction
-- (`tax_withholding` / `tax_refund` carrying no transaction or dividend link),
-- written exactly when a year's settlement TARGET moved. 0093 excluded every
-- tax-kind row from the cash trigger, so a re-settled later year silently kept
-- a stale marker; including the unattached corrections closes that.
--
-- SCOPE — read this as the exact guarantee, not as total coverage. The vehicle
-- is the correction row, so this marks every year whose settlement TARGET
-- moved, which is NARROWER than every year whose reported figures moved. A
-- year whose derived numbers change while its target stays put is deliberately
-- NOT marked here:
--   * a DE year whose whole gain stays inside the Sparer-Pauschbetrag — a
--     backdated buy lifting the year's realized gain 400 → 900 leaves the tax
--     at 0 both times while `realizedPnlEur` and `de.allowanceUsedEur` move;
--   * any year that is a loss before and after the edit — the carried pot
--     balance moves, the target is 0 either way.
-- Detecting those needs the year's PREVIOUS derived output, which nothing
-- persists: it is a settlement-boundary comparison across all four write paths
-- (record/delete transaction, record/delete dividend), not a trigger
-- predicate, so it is left as an owner decision rather than smuggled in here.
-- `tax.test.ts` pins the DE case as a known boundary so the gap stays a
-- decision on record. This is therefore also narrower than
-- `bettertrack_touch_portfolio_tax_years`, which touches every year of a
-- portfolio unconditionally on a settings change.
--
-- Corrections are also posted by the report read's self-heal
-- (`reconcileLiveYears`), which has two consequences worth stating: a plain
-- report GET can now move `last_changed_at` — for FX drift, for the
-- settings-change heal, or for a withholding correction that was deferred for
-- insufficient cash and posts on a later read — and such a bump carries the
-- READ's timestamp, not the edit's. 0093's "report self-healing can never
-- masquerade as a user edit" therefore holds from here on for row-ATTACHED tax
-- legs only.
--
-- Attached tax legs (a sell's or a dividend's own withholding) stay excluded:
-- their parent row's trigger already marks that year.
--
-- A correction is posted with `executed_at = now()` but BELONGS to its
-- `tax_year` — January's correction for the prior year is prior-year
-- documentation. Attribute every cash row by `COALESCE(tax_year, executed_at)`,
-- the rule both read paths already use (`listTaxYearDocumentation` and
-- `bettertrack_touch_portfolio_tax_years`). Non-tax kinds carry a NULL
-- `tax_year` (CHECK-enforced), so their attribution is byte-identical.
CREATE FUNCTION "bettertrack_touch_attributed_tax_year"(
	"p_portfolio_id" uuid,
	"p_tax_year" integer,
	"p_executed_at" timestamp with time zone
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "bettertrack_touch_tax_year"(
		p_portfolio_id,
		COALESCE(
			p_tax_year,
			EXTRACT(YEAR FROM p_executed_at AT TIME ZONE 'Europe/Vienna')::integer
		)
	);
END;
$$;
--> statement-breakpoint

-- Which cash rows are tax documentation in their own right: the user-editable
-- operations, plus the engine's unattached year corrections. Everything else
-- (buy/sell/dividend legs and the tax legs hanging off them) is covered by the
-- parent mutation's own trigger.
CREATE FUNCTION "bettertrack_cash_row_marks_tax_year"(
	"p_kind" text,
	"p_transaction_id" uuid,
	"p_dividend_id" uuid
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN p_kind IN ('deposit', 'withdrawal', 'fee', 'transfer_out', 'transfer_in') THEN true
		WHEN p_kind IN ('tax_withholding', 'tax_refund')
			THEN p_transaction_id IS NULL AND p_dividend_id IS NULL
		ELSE false
	END;
$$;
--> statement-breakpoint

-- The no-op guard from 0099 and the FK-cascade skip from 0093 are unchanged:
-- a year whose report did not change is still never bumped.
CREATE OR REPLACE FUNCTION "bettertrack_touch_cash_tax_year"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
	END IF;
	IF TG_OP IN ('UPDATE', 'DELETE') AND "bettertrack_cash_row_marks_tax_year"(
		OLD."kind"::text, OLD."transaction_id", OLD."dividend_id"
	) THEN
		PERFORM "bettertrack_touch_attributed_tax_year"(
			OLD."portfolio_id", OLD."tax_year", OLD."executed_at"
		);
	END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') AND "bettertrack_cash_row_marks_tax_year"(
		NEW."kind"::text, NEW."transaction_id", NEW."dividend_id"
	) THEN
		PERFORM "bettertrack_touch_attributed_tax_year"(
			NEW."portfolio_id", NEW."tax_year", NEW."executed_at"
		);
	END IF;
	IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
