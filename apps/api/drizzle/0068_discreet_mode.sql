-- V5-P13 arc (a) — discreet mode (#682). Per-user quick toggle that hides every
-- absolute money amount app-wide (balances, values, cash, tx amounts, tooltips,
-- chart axes) while keeping percentages/relative values live, so the user can
-- show the app to others without exposing amounts. Server-side per-user flag so
-- the toggle persists across sessions/devices; default OFF keeps every existing
-- surface byte-identical.
ALTER TABLE "users" ADD COLUMN "discreet_mode" boolean NOT NULL DEFAULT false;
