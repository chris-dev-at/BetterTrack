# Stored-record encryption rotation

BetterTrack encrypts TOTP seeds and dormant Discord webhook URLs with a
long-lived data key that is separate from `SESSION_SECRET`. Production requires:

- `BT_DATA_ENCRYPTION_KEY_ID`: a public, unique identifier (letters, digits,
  `_`, and `-`; at most 64 characters).
- `BT_DATA_ENCRYPTION_KEY`: secret key material generated with
  `openssl rand -hex 64`.
- `BT_DATA_ENCRYPTION_DECRYPT_KEYS`: optional ordered transition keys formatted
  as `old-id=old-key,older-id=older-key`.

The supported Compose file passes identical values to the API and worker.
Changing `SESSION_SECRET` does not change the active data key.

## Rotate a data key

Keep a database backup and the old key available throughout the procedure.
Replace `COMPOSE` below with the same `docker compose -f ...` invocation used for
the deployment.

1. Generate a new key and unique id. Put the current id/key in
   `BT_DATA_ENCRYPTION_DECRYPT_KEYS`, then set the new id/key as active. Do not
   remove any older transition key yet.
2. Deploy the reader-capable release to both API and worker. Confirm both
   services are healthy. New writes now use only the new active id; reads accept
   both new and configured previous ids plus legacy `v1` records.
3. Preview the online migration. It authenticates and verifies every candidate
   but writes nothing:

   ```sh
   $COMPOSE run --rm api \
     node dist/scripts/reencryptRecordSecrets.js --dry-run
   ```

   The JSON report contains counts only. `failed` must be zero before applying.

4. Apply the migration:

   ```sh
   $COMPOSE run --rm api \
     node dist/scripts/reencryptRecordSecrets.js --apply
   ```

   The command verifies decrypt → encrypt → decrypt before a compare-and-swap
   update. It is safe to rerun after interruption. A nonzero `conflicts` count
   means a user changed that row concurrently; rerun until it reaches zero.

5. Run `--dry-run` again. Verify `failed`, `conflicts`, and `wouldReencrypt` are
   all zero for both targets. Retain the report with the deployment record.
6. Only after that verification, remove the retired entry from
   `BT_DATA_ENCRYPTION_DECRYPT_KEYS` and redeploy API and worker together.

Retiring a key before verified re-encryption is destructive: records still
encrypted under it become unreadable. Restore the removed key immediately if
post-deploy verification fails.

## Rollback

Before step 6, rollback is configuration-only: restore the former id/key as
active, keep the new id/key in `BT_DATA_ENCRYPTION_DECRYPT_KEYS`, and redeploy
the same reader-capable release. This keeps records written during the attempted
rotation readable. Do not roll back to a release that only understands `v1`
after any `v2` write has occurred.

For the one-time upgrade from legacy `v1`, prepend new cookie-signing secrets to
the existing comma-separated `SESSION_SECRET` without reordering, removing, or
reformatting its retained suffix until step 5 is clean. For example, preserve
`new,old` exactly when moving to `newer,new,old`: the reader tries each ordered
suffix and can therefore recover records encrypted from either historical raw
list. The new active data key is still dedicated; cookie-derived candidates are
read-only legacy compatibility.
