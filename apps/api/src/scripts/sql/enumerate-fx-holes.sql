-- READ-ONLY operator queries (issue #1729). Nothing here writes; run them against
-- production as-is to size the repair before it is done.
--
-- What they find: persisted snapshot rows that dropped a held asset — the FX-probe
-- hole. Before #1729's fix a failed `EUR{ccy}=X` convertibility probe filtered every
-- asset in that currency out of the whole run, and the run was persisted as clean.
-- The nightly roll rewrites only [run-35, run-1], so the OLDEST day of every degraded
-- night froze for good (the owner's 2026-08-08/09 hole = the degraded runs of
-- 2026-09-12/13).
--
-- Invariant the queries lean on: the engine emits a usable asset's per-asset value
-- on EVERY day from its first transaction's UTC day on (`valueOverTime`, 0 after a
-- full sell), so its key is present in `asset_values` of every row from that day
-- through the last row it appears in. A missing key inside that span is a degraded
-- write. (A key missing on the trailing rows after the asset's last keyed day is not
-- listed — those days are still inside the heal window or still degraded.)
--
-- Repair (a separate step, AFTER the fix is deployed; see the PR that added this
-- file): per Q2 row, `markDirty(portfolio_id, earliest_hole)` then
-- `deleteFrom(portfolio_id, earliest_hole)` — the `scripts/repairTaxedSellSnapshots.ts`
-- pattern, no provider calls. The next read / nightly roll rebuilds the range.

-- Q1: every hole day, per portfolio x asset
WITH first_txn AS (
  SELECT portfolio_id, asset_id::text AS asset_id,
         min((executed_at AT TIME ZONE 'UTC')::date) AS first_d
  FROM transactions GROUP BY 1, 2
), last_seen AS (
  SELECT s.portfolio_id, k.asset_id, max(s.date) AS last_d
  FROM portfolio_daily_snapshots s
  CROSS JOIN LATERAL jsonb_object_keys(s.asset_values) AS k(asset_id)
  GROUP BY 1, 2
)
SELECT p.user_id, s.portfolio_id, a.symbol, a.currency, s.date, s.value_eur, s.computed_at,
       (s.computed_at AT TIME ZONE 'UTC')::date - s.date AS written_days_later  -- 35 = nightly heal boundary
FROM first_txn f
JOIN last_seen l USING (portfolio_id, asset_id)
JOIN portfolio_daily_snapshots s
  ON s.portfolio_id = f.portfolio_id AND s.date BETWEEN f.first_d AND l.last_d
JOIN portfolios p ON p.id = s.portfolio_id
JOIN assets a ON a.id::text = f.asset_id
WHERE NOT (s.asset_values ? f.asset_id)
ORDER BY s.portfolio_id, s.date, a.symbol;

-- Q2: repair worklist — one row per affected portfolio; invalidate from earliest_hole
WITH first_txn AS (
  SELECT portfolio_id, asset_id::text AS asset_id,
         min((executed_at AT TIME ZONE 'UTC')::date) AS first_d
  FROM transactions GROUP BY 1, 2
), last_seen AS (
  SELECT s.portfolio_id, k.asset_id, max(s.date) AS last_d
  FROM portfolio_daily_snapshots s
  CROSS JOIN LATERAL jsonb_object_keys(s.asset_values) AS k(asset_id)
  GROUP BY 1, 2
), holes AS (
  SELECT s.portfolio_id, s.date, a.currency
  FROM first_txn f
  JOIN last_seen l USING (portfolio_id, asset_id)
  JOIN portfolio_daily_snapshots s
    ON s.portfolio_id = f.portfolio_id AND s.date BETWEEN f.first_d AND l.last_d
  JOIN assets a ON a.id::text = f.asset_id
  WHERE NOT (s.asset_values ? f.asset_id)
)
SELECT portfolio_id, min(date) AS earliest_hole, count(DISTINCT date) AS hole_days,
       array_agg(DISTINCT currency) AS currencies
FROM holes
GROUP BY portfolio_id
ORDER BY earliest_hole;

-- Q3: owner forensics — expect 08-08/08-09 computed_at on 2026-09-12/13 ~01:30Z (run-35),
--     08-07 on 09-11 and 08-10 on 09-14. Fill in the portfolio id before running.
-- SELECT date, value_eur, asset_keys, computed_at FROM (
--   SELECT date, value_eur, (SELECT count(*) FROM jsonb_object_keys(asset_values)) AS asset_keys,
--          computed_at
--   FROM portfolio_daily_snapshots WHERE portfolio_id = '<portfolio id>'
--     AND date BETWEEN '2026-08-05' AND '2026-08-12') x ORDER BY date;
