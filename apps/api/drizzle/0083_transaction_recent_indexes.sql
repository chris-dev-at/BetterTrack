-- #1147 — the overview asks for only the newest rendered rows by execution
-- time, optionally within one source, and separately derives a distinct-source
-- facet. Both indexes are reversible scan keys: ASC serves replay while DESC
-- serves the recent card, with id as the deterministic equal-time tiebreak.
CREATE INDEX "transactions_portfolio_executed_id_idx" ON "transactions" USING btree ("portfolio_id","executed_at","id");--> statement-breakpoint
CREATE INDEX "transactions_portfolio_source_executed_id_idx" ON "transactions" USING btree ("portfolio_id","source","executed_at","id");
