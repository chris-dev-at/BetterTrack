-- V5-P10 — API-key rate tiers: enforce "exactly one default" at the DB layer.
-- The repo's transactional clear-then-set is not race-safe under READ COMMITTED
-- (two concurrent create/update({isDefault:true}) can both leave is_default=true
-- on their own row). A partial unique index closes the race: at most one row
-- can satisfy the predicate `is_default = true`.
CREATE UNIQUE INDEX "api_key_tiers_one_default" ON "api_key_tiers" USING btree ("is_default") WHERE "is_default";
