# Admin-login two-factor authentication (#400)

Two-factor auth is **mandatory for every admin account** (`role='admin'`). There
is no opt-in, and no "root admin" exemption — every admin must pass 2FA to use the
admin surface (PROJECTPLAN.md §6.12).

## How it works

- **Enrollment is bootstrapped, not blocking on deploy.** A freshly seeded admin
  still signs in with their password, but lands in a `two_factor_setup_required`
  state: every admin API endpoint **except** the 2FA enroll/confirm set answers
  `403 ADMIN_2FA_SETUP_REQUIRED`. The admin SPA detects that code and forces the
  enrollment wizard (authenticator app **and/or** a separate 2FA email), then
  shows the recovery codes exactly once.
- **Login challenge.** Once an admin has a confirmed method, password login no
  longer mints a session — it returns the shared `two_factor_required` challenge
  (the same flow user accounts use: `/auth/login` → `/auth/2fa/verify`). The
  email code goes to the admin's **2FA email**, never their account email.
- **Two methods.** _Authenticator app (TOTP)_ — the encrypted secret is stored at
  rest exactly like the user surface. _Email OTP_ — sent to a separately-set 2FA
  email that may differ from the account email. Either method (or an unused
  recovery code) completes the challenge.
- **Recovery codes.** Issued once, on the first method enabled; single-use;
  regenerable from the admin Security settings.
- **Changing the 2FA email** requires a fresh 2FA proof (a current TOTP code or an
  unused recovery code) once the admin is already enrolled. The first-time set
  during forced enrollment needs none.

Step-up re-auth for destructive admin actions is **out of scope** here (tracked
in #430).

## Break-glass: reset an admin's 2FA (shell only)

If an admin loses **all** of their factors — authenticator, 2FA email, and
recovery codes — there is deliberately **no web or API bypass**. Recovery is a
script that runs only where someone already has shell + database access on the
live box; possession of that access **is** the authorization.

```sh
# On the box, with DATABASE_URL pointing at the live database:
pnpm --filter @bettertrack/api admin:break-glass <admin-email-or-username>
```

This clears the named admin's TOTP secret + flags, the email method, the 2FA
email, and every recovery code, then writes an `admin.two_factor_reset` audit
row. The account drops back into the mandatory-setup state: their password still
works, and the forced enrollment wizard runs on their next admin login.

Notes:

- It **refuses to touch a non-admin account** — it can never be used to strip a
  user's 2FA.
- `DATABASE_URL` must be set; the script exits non-zero (making no changes) when
  the identifier matches no admin account.
- Prefer having a second admin re-enroll the first through the normal wizard;
  reach for break-glass only when every admin is locked out.
