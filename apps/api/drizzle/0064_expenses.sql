-- V5-P9 — Expense tracking foundation (issue 1/3). Strictly additive: a NEW
-- top-level product area whose tables reference NOTHING portfolio-side (no
-- TWR/tax interaction). This ONE migration owns the ENTIRE P9 schema —
-- categories, transactions, rules, budgets and a per-(budget, period) fired
-- marker — so issues 2/3 (import + rule engine) and 3/3 (dashboards + budgets)
-- add no further migration.
CREATE TYPE "public"."expense_direction" AS ENUM('expense', 'income');--> statement-breakpoint
CREATE TYPE "public"."expense_rule_match" AS ENUM('contains', 'equals', 'starts_with', 'regex');--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"direction" "expense_direction" DEFAULT 'expense' NOT NULL,
	"color" text DEFAULT '#64748b' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid,
	"direction" "expense_direction" DEFAULT 'expense' NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"booked_on" date NOT NULL,
	"description" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"dedup_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_transactions_amount_positive" CHECK ("expense_transactions"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"match_type" "expense_rule_match" DEFAULT 'contains' NOT NULL,
	"pattern" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"currency" char(3) DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_budgets_amount_positive" CHECK ("expense_budgets"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_budget_fires" (
	"id" uuid PRIMARY KEY NOT NULL,
	"budget_id" uuid NOT NULL,
	"period_key" varchar(7) NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_transactions" ADD CONSTRAINT "expense_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_transactions" ADD CONSTRAINT "expense_transactions_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rules" ADD CONSTRAINT "expense_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rules" ADD CONSTRAINT "expense_rules_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_budgets" ADD CONSTRAINT "expense_budgets_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_budget_fires" ADD CONSTRAINT "expense_budget_fires_budget_id_expense_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."expense_budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_categories_user_idx" ON "expense_categories" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_user_name_unique" ON "expense_categories" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "expense_transactions_user_idx" ON "expense_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "expense_transactions_category_idx" ON "expense_transactions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "expense_transactions_user_booked_idx" ON "expense_transactions" USING btree ("user_id","booked_on");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_transactions_user_dedup_unique" ON "expense_transactions" USING btree ("user_id","dedup_hash");--> statement-breakpoint
CREATE INDEX "expense_rules_user_idx" ON "expense_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "expense_rules_category_idx" ON "expense_rules" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "expense_rules_user_priority_idx" ON "expense_rules" USING btree ("user_id","priority");--> statement-breakpoint
CREATE INDEX "expense_budgets_user_idx" ON "expense_budgets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_budgets_category_unique" ON "expense_budgets" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_budget_fires_period_unique" ON "expense_budget_fires" USING btree ("budget_id","period_key");
