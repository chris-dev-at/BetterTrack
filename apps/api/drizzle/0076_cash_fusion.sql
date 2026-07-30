-- V5 CASH FUSION (phase 1: schema + data migration). The user-scoped expense
-- island (`expense_*`) becomes classification ON the portfolio cash ledger:
-- flat multi-tags instead of one nesting category, budgets inside a portfolio,
-- rules that assign many tags. Owner decisions: everything lives in a
-- portfolio (there is no global user-level cash), tags do not nest, system tags
-- are app-owned, budgets are per portfolio + tag + period.
--
-- The `expense_*` tables are NOT touched and NOT dropped: `/api/v1/expenses`
-- and the web app keep serving them unchanged until a later phase re-points the
-- routes. After this migration they are STALE COPIES of the rows now living in
-- `portfolio_cash_movements`.
--
-- IDEMPOTENT BY CONSTRUCTION. Every inserted row's primary key is either
-- borrowed from the source row (movement = expense transaction id, tag =
-- category id, budget = budget id, rule = rule id) or derived deterministically
-- from the owner (`bt_cash_fusion_uuid`), so a re-run collides on the primary
-- key and inserts nothing. The join rows are guarded by their natural unique
-- keys instead. Re-running changes no row and no balance.
--
-- SELF-VERIFYING. The final DO block re-derives, per user, the signed sum and
-- the row count of the migrated movements from the source expense rows and
-- RAISES on any mismatch. drizzle runs the whole file in one transaction, so a
-- migration that does not reconcile to the cent aborts the deploy instead of
-- committing corrupted money.
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "dedup_hash" text;--> statement-breakpoint
-- Provenance for a row that entered from a NON-EUR feed. `amount_eur` stays the
-- single authoritative signed EUR figure and the ledger never reads this column;
-- NULL means the amount is genuinely EUR. A non-NULL value marks a magnitude
-- carried over 1:1 that still needs an FX pass (see the header of the movement
-- backfill below).
ALTER TABLE "portfolio_cash_movements" ADD COLUMN "original_currency" char(3);--> statement-breakpoint
ALTER TABLE "portfolio_cash_movements" ADD CONSTRAINT "portfolio_cash_movements_original_currency_not_eur" CHECK ("original_currency" IS NULL OR "original_currency" <> 'EUR');--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_cash_movements_dedup_unique" ON "portfolio_cash_movements" USING btree ("portfolio_id","dedup_hash");--> statement-breakpoint
CREATE TYPE "public"."cash_rule_match" AS ENUM('contains', 'equals', 'starts_with', 'regex');--> statement-breakpoint
CREATE TABLE "cash_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"system_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_tags_system_key_iff_system" CHECK ("cash_tags"."system" = ("cash_tags"."system_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "cash_movement_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"movement_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"period_key" varchar(7),
	"amount" numeric(20, 2) NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_budgets_amount_positive" CHECK ("cash_budgets"."amount" > 0),
	CONSTRAINT "cash_budgets_period_key_format" CHECK ("cash_budgets"."period_key" IS NULL OR "cash_budgets"."period_key" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "cash_budget_fires" (
	"id" uuid PRIMARY KEY NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"match_type" "cash_rule_match" DEFAULT 'contains' NOT NULL,
	"pattern" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cash_rule_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cash_tags" ADD CONSTRAINT "cash_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_tags" ADD CONSTRAINT "cash_movement_tags_movement_id_portfolio_cash_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."portfolio_cash_movements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movement_tags" ADD CONSTRAINT "cash_movement_tags_tag_id_cash_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."cash_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_budgets" ADD CONSTRAINT "cash_budgets_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_budgets" ADD CONSTRAINT "cash_budgets_tag_id_cash_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."cash_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_budget_fires" ADD CONSTRAINT "cash_budget_fires_budget_id_cash_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."cash_budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_rules" ADD CONSTRAINT "cash_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_rule_tags" ADD CONSTRAINT "cash_rule_tags_rule_id_cash_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."cash_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_rule_tags" ADD CONSTRAINT "cash_rule_tags_tag_id_cash_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."cash_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_tags_user_idx" ON "cash_tags" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_tags_user_name_lower_unique" ON "cash_tags" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "cash_tags_user_system_key_unique" ON "cash_tags" USING btree ("user_id","system_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movement_tags_movement_tag_unique" ON "cash_movement_tags" USING btree ("movement_id","tag_id");--> statement-breakpoint
CREATE INDEX "cash_movement_tags_tag_idx" ON "cash_movement_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "cash_budgets_portfolio_idx" ON "cash_budgets" USING btree ("portfolio_id");--> statement-breakpoint
CREATE INDEX "cash_budgets_tag_idx" ON "cash_budgets" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_budgets_portfolio_tag_period_unique" ON "cash_budgets" USING btree ("portfolio_id","tag_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_budgets_portfolio_tag_recurring_unique" ON "cash_budgets" USING btree ("portfolio_id","tag_id") WHERE "cash_budgets"."period_key" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_budget_fires_period_unique" ON "cash_budget_fires" USING btree ("budget_id","period_key");--> statement-breakpoint
CREATE INDEX "cash_rules_user_idx" ON "cash_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cash_rules_user_priority_idx" ON "cash_rules" USING btree ("user_id","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_rule_tags_rule_tag_unique" ON "cash_rule_tags" USING btree ("rule_id","tag_id");--> statement-breakpoint
CREATE INDEX "cash_rule_tags_tag_idx" ON "cash_rule_tags" USING btree ("tag_id");--> statement-breakpoint
-- ── Data migration ─────────────────────────────────────────────────────────────
-- Stable id derivation for the rows that have no source row to borrow an id
-- from (the Spending portfolio and its Main cash source). md5 of a namespaced
-- seed, with the version/variant nibbles forced so the result is a well-formed
-- RFC-4122 v5-shaped UUID — `z.string().uuid()` in the contracts rejects a raw
-- md5 digest, which would make every later API response fail validation.
-- Dropped again at the end of this migration; nothing depends on it afterwards.
CREATE FUNCTION "bt_cash_fusion_uuid"(seed text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
	SELECT (
		overlay(
			overlay(md5(seed) placing '5' from 13 for 1)
			placing substr('89ab', (('x' || substr(md5(seed), 17, 1))::bit(4)::int % 4) + 1, 1) from 17 for 1
		)
	)::uuid
$$;--> statement-breakpoint
-- Per-user work list: which users get a Spending portfolio, and the deterministic
-- ids of that portfolio and its Main source. Dropped at the end (and rebuilt
-- identically by a re-run, because every id is a pure function of the user id).
CREATE TABLE "bt_cash_fusion_map" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"source_id" uuid NOT NULL
);
--> statement-breakpoint
-- category id → tag id. Not always the category's own derived tag: two
-- categories whose names differ only in case ("Food"/"food") legally collapse
-- into ONE tag, because `cash_tags_user_name_lower_unique` is case-insensitive.
CREATE TABLE "bt_cash_fusion_tag_map" (
	"category_id" uuid PRIMARY KEY NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
-- 1. System tags, for EVERY user (app-owned; the engine assigns them from a
--    movement's `kind` and the user cannot delete them). Seeded first so their
--    names are guaranteed present and stable; a user category with the same name
--    merges into the system tag in step 3. Bare ON CONFLICT DO NOTHING so the
--    seed is safe against both its own key and a name already in use.
INSERT INTO "cash_tags" ("id", "user_id", "name", "color", "system", "system_key")
SELECT
	"bt_cash_fusion_uuid"('bettertrack:v5-cash-fusion:system-tag:' || s."key" || ':' || u."id"::text),
	u."id",
	s."name",
	s."color",
	true,
	s."key"
FROM "users" u
CROSS JOIN (VALUES
	('investment', 'Investment', '#6366f1'),
	('sale_proceeds', 'Sale proceeds', '#8b5cf6'),
	('dividend', 'Dividend income', '#10b981'),
	('interest', 'Interest', '#14b8a6'),
	('fees', 'Fees', '#f97316'),
	('tax', 'Tax', '#ef4444'),
	('transfer', 'Transfer', '#64748b'),
	('deposit', 'Deposit', '#22c55e'),
	('withdrawal', 'Withdrawal', '#eab308')
) AS s("key", "name", "color")
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. Categories → user-owned tags, keeping the id (so a re-run collides on the
--    primary key), the name and the colour. DISTINCT ON makes the case-collision
--    winner deterministic: oldest category first, smallest id as the tiebreak.
--    Categories whose name is already taken by a system tag get no tag of their
--    own — step 3 maps them onto the existing one.
INSERT INTO "cash_tags" ("id", "user_id", "name", "color", "system", "system_key", "created_at", "updated_at")
SELECT DISTINCT ON (c."user_id", lower(c."name"))
	c."id", c."user_id", c."name", c."color", false, NULL, c."created_at", c."updated_at"
FROM "expense_categories" c
WHERE NOT EXISTS (
	SELECT 1 FROM "cash_tags" t
	WHERE t."user_id" = c."user_id" AND lower(t."name") = lower(c."name")
)
ORDER BY c."user_id", lower(c."name"), c."created_at", c."id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 3. Resolve every category to exactly one tag by case-insensitive name. Step 2
--    guarantees a tag exists for each distinct lower(name), and the unique index
--    guarantees at most one match, so this is total and single-valued.
INSERT INTO "bt_cash_fusion_tag_map" ("category_id", "tag_id")
SELECT c."id", t."id"
FROM "expense_categories" c
JOIN "cash_tags" t ON t."user_id" = c."user_id" AND lower(t."name") = lower(c."name");--> statement-breakpoint
-- 4. Which users need a Spending portfolio: anyone with at least one expense
--    transaction, plus anyone with only a budget (a budget is portfolio-scoped
--    now, so without a portfolio it could not be carried over at all). Rules and
--    tags are user-scoped and need no portfolio.
INSERT INTO "bt_cash_fusion_map" ("user_id", "portfolio_id", "source_id")
SELECT
	u."id",
	"bt_cash_fusion_uuid"('bettertrack:v5-cash-fusion:spending-portfolio:' || u."id"::text),
	"bt_cash_fusion_uuid"('bettertrack:v5-cash-fusion:spending-main-source:' || u."id"::text)
FROM "users" u
WHERE EXISTS (SELECT 1 FROM "expense_transactions" x WHERE x."user_id" = u."id")
	OR EXISTS (SELECT 1 FROM "expense_budgets" b WHERE b."user_id" = u."id");--> statement-breakpoint
-- 5. The cash-only Spending portfolio. A NEW portfolio every time — spending
--    history is never folded into an existing investment portfolio's cash
--    balance. `portfolios_user_name_unique` means the name "Spending" can
--    already be taken by a portfolio the user made themselves, so the first free
--    name of "Spending", "Spending 2", … is used; if all 64 are taken the NOT
--    NULL on `name` aborts the migration rather than guessing. Sorted last so it
--    does not displace the user's existing portfolios.
INSERT INTO "portfolios" ("id", "user_id", "name", "sort_order")
SELECT
	m."portfolio_id",
	m."user_id",
	(
		SELECT c."nm" FROM (
			SELECT CASE WHEN g."i" = 1 THEN 'Spending' ELSE 'Spending ' || g."i"::text END AS "nm", g."i"
			FROM generate_series(1, 64) AS g("i")
		) c
		WHERE NOT EXISTS (
			SELECT 1 FROM "portfolios" p WHERE p."user_id" = m."user_id" AND p."name" = c."nm"
		)
		ORDER BY c."i"
		LIMIT 1
	),
	(SELECT COALESCE(MAX(p."sort_order"), 0) + 1 FROM "portfolios" p WHERE p."user_id" = m."user_id")
FROM "bt_cash_fusion_map" m
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 6. Its Main cash source (name/type/is_main exactly as migration 0019 provisions
--    a Main), so the ledger's one-Main-per-portfolio invariant holds from birth.
INSERT INTO "portfolio_cash_sources" ("id", "portfolio_id", "name", "type", "is_main")
SELECT m."source_id", m."portfolio_id", 'Main', 'cash', true
FROM "bt_cash_fusion_map" m
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 7. Every expense transaction becomes ONE cash movement, id preserved.
--
--    SIGN CONVENTION — the part that would be silent money corruption if wrong.
--    `expense_transactions` stores a POSITIVE magnitude plus a `direction`;
--    `portfolio_cash_movements.amount_eur` stores a SIGNED amount whose sign must
--    match its `kind` (CASH_MOVEMENT_SIGN, mirrored by the
--    `portfolio_cash_movements_sign` CHECK). So:
--      direction 'expense' (money OUT) → kind 'withdrawal', amount_eur = -amount
--      direction 'income'  (money IN)  → kind 'deposit',    amount_eur = +amount
--    `deposit`/`withdrawal` are also the only structurally legal kinds here: the
--    table's other CHECKs require a `transaction_id`-style parent for buy /
--    sell_proceeds, a transfer pair for transfer_*, a dividend row for dividend
--    and a tax year for tax_*. And they are semantically right — in a cash-only
--    portfolio a salary genuinely crosses into the ledger and rent genuinely
--    leaves it. The CHECK is the backstop: a flipped sign aborts the migration.
--
--    booked_on (a date) → executed_at (an instant) at UTC MIDNIGHT. The daily
--    series buckets days in UTC (domain/holdings) while tax buckets them in
--    Europe/Vienna; UTC midnight is the only instant that lands on `booked_on`
--    under BOTH (Vienna midnight would fall on the previous UTC day).
--
--    CURRENCY. Cash is EUR-only by construction (`amount_eur`), and the expense
--    area was currency-naive by design (it summed magnitudes and never converted
--    — see the "currency-naive magnitude sums" contract). A non-EUR row therefore
--    carries its magnitude over 1:1, which reproduces exactly the number the user
--    has always been shown, and records its currency in `original_currency` so a
--    later FX pass can find and correct it. No historical rate is invented here.
INSERT INTO "portfolio_cash_movements"
	("id", "portfolio_id", "source_id", "kind", "amount_eur", "executed_at", "note", "source", "dedup_hash", "original_currency", "created_at")
SELECT
	x."id",
	m."portfolio_id",
	m."source_id",
	(CASE x."direction" WHEN 'income' THEN 'deposit' ELSE 'withdrawal' END)::"public"."cash_movement_kind",
	CASE x."direction" WHEN 'income' THEN x."amount" ELSE -x."amount" END,
	x."booked_on"::timestamp AT TIME ZONE 'UTC',
	x."description",
	x."source",
	x."dedup_hash",
	CASE WHEN x."currency" = 'EUR' THEN NULL ELSE x."currency" END,
	x."created_at"
FROM "expense_transactions" x
JOIN "bt_cash_fusion_map" m ON m."user_id" = x."user_id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 8. Each migrated movement gets its category's tag. A row with a NULL category
--    stays untagged — exactly the "uncategorized" state it already had; the old
--    dashboards had an explicit uncategorized bucket and nothing is invented for
--    it here.
INSERT INTO "cash_movement_tags" ("id", "movement_id", "tag_id")
SELECT gen_random_uuid(), x."id", tm."tag_id"
FROM "expense_transactions" x
JOIN "bt_cash_fusion_tag_map" tm ON tm."category_id" = x."category_id"
JOIN "portfolio_cash_movements" pm ON pm."id" = x."id"
ON CONFLICT ("movement_id", "tag_id") DO NOTHING;--> statement-breakpoint
-- 9. Budgets move into the Spending portfolio with `period_key` NULL = the
--    RECURRING monthly target, which is precisely what `expense_budgets` was (it
--    had no period column; one row per category, re-evaluated every month). When
--    two case-colliding categories merged into one tag, their two budgets collapse
--    to one: the LARGEST amount wins, because a budget is a ceiling and merging
--    two labels must not silently tighten what the user set.
INSERT INTO "cash_budgets" ("id", "portfolio_id", "tag_id", "period_key", "amount", "currency", "created_at", "updated_at")
SELECT DISTINCT ON (m."portfolio_id", tm."tag_id")
	b."id", m."portfolio_id", tm."tag_id", NULL, b."amount", b."currency", b."created_at", b."updated_at"
FROM "expense_budgets" b
JOIN "bt_cash_fusion_map" m ON m."user_id" = b."user_id"
JOIN "bt_cash_fusion_tag_map" tm ON tm."category_id" = b."category_id"
ORDER BY m."portfolio_id", tm."tag_id", b."amount" DESC, b."created_at", b."id"
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 10. The per-(budget, period) fired markers come along, ids preserved. Without
--     them, re-pointing the notification path at `cash_budget_fires` later would
--     re-fire every month that has already alerted.
INSERT INTO "cash_budget_fires" ("id", "budget_id", "period_key", "fired_at")
SELECT f."id", f."budget_id", f."period_key", f."fired_at"
FROM "expense_budget_fires" f
JOIN "cash_budgets" b ON b."id" = f."budget_id"
ON CONFLICT ("budget_id", "period_key") DO NOTHING;--> statement-breakpoint
-- 11. Rules keep their id, pattern, priority and enabled flag. They are
--     user-scoped, so they migrate for every user — including one with no
--     Spending portfolio. First-match-by-priority semantics are unchanged.
INSERT INTO "cash_rules" ("id", "user_id", "match_type", "pattern", "priority", "enabled", "created_at", "updated_at")
SELECT r."id", r."user_id", r."match_type"::text::"public"."cash_rule_match", r."pattern", r."priority", r."enabled", r."created_at", r."updated_at"
FROM "expense_rules" r
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 12. …assigning the single tag their category became. The join table is what
--     lets a rule assign several tags from here on.
INSERT INTO "cash_rule_tags" ("id", "rule_id", "tag_id")
SELECT gen_random_uuid(), r."id", tm."tag_id"
FROM "expense_rules" r
JOIN "bt_cash_fusion_tag_map" tm ON tm."category_id" = r."category_id"
JOIN "cash_rules" cr ON cr."id" = r."id"
ON CONFLICT ("rule_id", "tag_id") DO NOTHING;--> statement-breakpoint
-- 13. VERIFICATION — the migration proves itself or aborts the deploy. Per user:
--     the signed sum of the migrated movements must equal the signed sum of the
--     source expense rows to the cent, every source row must have landed, and
--     every landed movement must sit in a portfolio owned by that same user (so a
--     mis-scoped write can never pass as a match).
DO $$
DECLARE
	"bad" int;
	"first_bad" text;
BEGIN
	SELECT count(*), min(v."user_id"::text) INTO "bad", "first_bad" FROM (
		SELECT
			x."user_id",
			count(*) AS "expense_rows",
			count(p."id") AS "migrated_rows",
			sum(CASE x."direction" WHEN 'income' THEN x."amount" ELSE -x."amount" END) AS "expected_net",
			coalesce(sum(pm."amount_eur"), 0) AS "migrated_net"
		FROM "expense_transactions" x
		LEFT JOIN "portfolio_cash_movements" pm ON pm."id" = x."id"
		LEFT JOIN "portfolios" p ON p."id" = pm."portfolio_id" AND p."user_id" = x."user_id"
		GROUP BY x."user_id"
		HAVING count(*) <> count(p."id")
			OR sum(CASE x."direction" WHEN 'income' THEN x."amount" ELSE -x."amount" END)
				<> coalesce(sum(pm."amount_eur"), 0)
	) v;
	IF "bad" > 0 THEN
		RAISE EXCEPTION
			'0075_cash_fusion: expense → cash movement migration does not reconcile for % user(s) (first: %). Aborting; no rows committed.',
			"bad", "first_bad";
	END IF;
END $$;--> statement-breakpoint
DROP TABLE "bt_cash_fusion_tag_map";--> statement-breakpoint
DROP TABLE "bt_cash_fusion_map";--> statement-breakpoint
DROP FUNCTION "bt_cash_fusion_uuid"(text);
