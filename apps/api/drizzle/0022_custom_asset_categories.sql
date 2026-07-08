-- V3-P2 (#325): custom assets adopt the real catalog taxonomy
-- (stock / etf / crypto / commodity / cash_like / other). The old CUSTOM
-- taxonomy (real_estate / vehicle / …) has no clean mapping, so every existing
-- custom asset is re-mapped to `other` and flagged for a one-time re-categorize
-- banner (`meta.recategorize = true`). Cleared when the owner re-categorizes the
-- asset or dismisses the banner.
UPDATE "assets"
SET "meta" = COALESCE("meta", '{}'::jsonb) || jsonb_build_object('category', 'other', 'recategorize', true)
WHERE "provider_id" = 'manual';
