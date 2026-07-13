-- #400 — Mandatory admin-login 2FA (§6.12). One additive nullable column: the
-- separately-set "2FA email" an admin-kind account receives its login email-OTP
-- on (may differ from the account email). Admin-kind only; the user-kind email
-- method codes to the account email and never reads this. All other admin 2FA
-- state reuses the existing user 2FA columns + the `two_factor_recovery_codes`
-- table (admins are `users` rows), so no further schema is needed. Existing
-- rows keep NULL and their exact current behavior.
ALTER TABLE "users" ADD COLUMN "two_factor_email" varchar(320);
